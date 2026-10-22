import { useSetAtom, useStore } from "jotai";
import { useLayoutEffect, type RefObject } from "react";
import type {
  CommittedDocument,
  NavigatorLocation,
  PhysicalFrame,
} from "../../generated/kernel.js";
import type { NavigatorInteraction, NavigatorRuntime } from "../../runtime/navigator/api.js";
import { readerCommands, type ReaderCommand } from "../../runtime/reader-commands.js";
import { occurrenceLoadableTarget } from "../../runtime/kernel-view.js";
import { normalizeError, operationError, type ReaderError } from "../status/errors.js";
import { requestPublicationFocus } from "../input/focus.js";
import { annotationActivationAtom } from "../annotations/state.js";
import { fixedViewAtom } from "../fixed-layout/state.js";
import { readerCompactAtom, setCompactSurfaceAtom } from "../compact/state.js";
import { documentErrorAtom } from "../runtime/projection-state.js";
import { isAddressedTarget, tocPointOccurrence, type JoinedTocPoint } from "./model.js";
import {
  navigationIntentAtom,
  presentationAdvanceAtom,
  readerInteractionHandlerAtom,
  type NavigationIntent,
} from "./state.js";

export const emptyObservation = { layoutProgression: null, renderedTextProgression: null };

interface NavigationControllerOptions {
  readonly onReaderCommand: (command: ReaderCommand) => void;
  readonly runtime: RefObject<NavigatorRuntime | null>;
  readonly frameHost: RefObject<HTMLElement | null>;
  readonly committed: PhysicalFrame | null;
  readonly committedDocument: CommittedDocument | null;
  readonly pending: unknown;
  readonly closeNavigationSurfaces: () => void;
  readonly closeNavigationOverlay: () => void;
  readonly error: ReaderError | null;
}

export interface NavigationController {
  readonly moveBoundary: (boundary: "start" | "end") => void;
  readonly command: (action: "previous" | "next" | "reload", occurrence: number) => void;
  readonly advancePresentation: (direction: "forward" | "backward") => void;
  readonly retry: () => void;
  readonly navigateToc: (point: JoinedTocPoint) => void;
}

function spreadCompanionTurnsPages(runtime: NavigatorRuntime): boolean {
  const companion = runtime.visibleOccurrenceRange()?.companion ?? null;
  if (companion === null) return false;
  const target = occurrenceLoadableTarget(runtime.snapshot().readingOrder[companion.occurrence]);
  return target?.adapter === "reflowable-xhtml";
}

export function useNavigationController({
  onReaderCommand,
  runtime,
  frameHost,
  committed,
  committedDocument,
  pending,
  closeNavigationSurfaces,
  closeNavigationOverlay,
  error,
}: NavigationControllerOptions): NavigationController {
  const store = useStore();
  const setAnnotationActivation = useSetAtom(annotationActivationAtom);
  const setFixedView = useSetAtom(fixedViewAtom);
  const setError = useSetAtom(documentErrorAtom);
  const command = (action: "previous" | "next" | "reload", occurrence: number) => {
    const current = runtime.current;
    if (current === null) return;
    setAnnotationActivation(null);
    store.set(navigationIntentAtom, {
      runtime: current,
      occurrence,
      locator: null,
      annotationTargetJson: null,
      annotationRecordId: null,
      annotationActivationToken: null,
      focusAfterCompletion: true,
      generation: null,
      focusCancelled: false,
    });
    closeNavigationSurfaces();
    try {
      current[action]();
    } catch (cause) {
      if (store.get(navigationIntentAtom)?.runtime === current)
        store.set(navigationIntentAtom, null);
      setError(normalizeError(cause, false));
    }
  };

  const advancePresentation = (direction: "forward" | "backward") => {
    const requestedRuntime = runtime.current;
    if (requestedRuntime === null) return;
    store.set(
      presentationAdvanceAtom,
      store.get(presentationAdvanceAtom).then(async () => {
        if (runtime.current !== requestedRuntime) return;
        try {
          const result = await requestedRuntime.advancePresentation(direction);
          if (runtime.current !== requestedRuntime) return;
          if (result.outcome === "failed") {
            if (result.failure.code !== "operation-cancelled")
              setError(operationError(result.failure));
            return;
          }
          if (result.status.status === "failed") {
            setError({
              code: "presentation-advance-failed",
              message: result.status.message,
              terminal: false,
            });
            return;
          }
          if (result.status.status !== "boundary") return;
          const occurrence =
            direction === "forward"
              ? requestedRuntime.nextOccurrence()
              : requestedRuntime.previousOccurrence();
          if (occurrence !== null) {
            command(direction === "forward" ? "next" : "previous", occurrence);
          }
        } catch (cause) {
          if (runtime.current === requestedRuntime) setError(normalizeError(cause, false));
        }
      }),
    );
  };

  const handleInteraction = (interaction: NavigatorInteraction) => {
    if (readerCommands.some((command) => command === interaction.command)) {
      onReaderCommand(interaction.command as ReaderCommand);
      return;
    }
    if (committed === null || pending !== null) return;
    const current = runtime.current;
    if (interaction.command === "fixed-zoom") {
      if (current !== null) {
        setFixedView(
          current.setFixedZoom(
            (current.fixedViewState()?.zoom ?? 1) * interaction.factor,
            interaction.focal,
          ),
        );
      }
    } else if (interaction.command === "fixed-pan") {
      if (current !== null) setFixedView(current.panFixedBy(interaction.delta, true));
    } else if (interaction.command === "fixed-reset") {
      if (current !== null) setFixedView(current.setFixedZoom(1));
    } else if (interaction.command === "previous" || interaction.command === "next") {
      const forward = interaction.command === "next";
      // The agent reports its own boundary. In a spread whose companion turns its own pages,
      // the spread may still have pages to show before the view moves on.
      if (current !== null && spreadCompanionTurnsPages(current)) {
        advancePresentation(forward ? "forward" : "backward");
        return;
      }
      const occurrence =
        (forward ? current?.nextOccurrence() : current?.previousOccurrence()) ?? null;
      if (occurrence !== null) command(forward ? "next" : "previous", occurrence);
    } else if (interaction.command === "reveal-top" || interaction.command === "reveal-bottom") {
      // Workspace keeps its chrome on screen, so there is nothing for the gesture to reveal.
      if (store.get(readerCompactAtom)) {
        store.set(
          setCompactSurfaceAtom,
          interaction.command === "reveal-top" ? "quick-menu" : "navigation",
        );
      }
    }
  };
  useLayoutEffect(() => {
    store.set(readerInteractionHandlerAtom, { handle: handleInteraction });
  });

  const retry = () => {
    const current = runtime.current;
    if (current === null) return;
    const intent = store.get(navigationIntentAtom);
    const recoveryOccurrence = error?.recoveryOccurrence;
    const occurrence =
      recoveryOccurrence ??
      (intent?.runtime === current ? intent.occurrence : (committed?.occurrence ?? 0));
    store.set(navigationIntentAtom, {
      runtime: current,
      occurrence,
      locator: intent?.runtime === current ? intent.locator : null,
      annotationTargetJson: intent?.runtime === current ? intent.annotationTargetJson : null,
      annotationRecordId: intent?.runtime === current ? intent.annotationRecordId : null,
      annotationActivationToken:
        intent?.runtime === current ? intent.annotationActivationToken : null,
      focusAfterCompletion: true,
      generation:
        intent?.runtime === current &&
        intent.locator !== null &&
        committed?.occurrence === occurrence &&
        committed.resource === intent.locator.resource
          ? (committedDocument?.generation ?? null)
          : null,
      focusCancelled: false,
    });
    setError(null);
    try {
      const retryIntent = store.get(navigationIntentAtom);
      if (retryIntent === null) return;
      const retryLocator = retryIntent.locator;
      if (recoveryOccurrence !== undefined) {
        if (committed?.occurrence === occurrence) current.reload();
        else current.open(occurrence);
      } else if (
        retryLocator !== null &&
        committed?.occurrence === occurrence &&
        committed.resource === retryLocator.resource
      ) {
        void current.relocate(retryLocator).then(
          (result) => {
            if (runtime.current !== current || store.get(navigationIntentAtom) !== retryIntent)
              return;
            if (result.outcome === "failed") {
              if (result.failure.code !== "operation-cancelled")
                setError(operationError(result.failure));
              store.set(navigationIntentAtom, null);
              return;
            }
            const container = frameHost.current;
            if (container !== null) requestPublicationFocus(container, store, retryIntent);
          },
          (cause: unknown) => {
            if (runtime.current !== current || store.get(navigationIntentAtom) !== retryIntent)
              return;
            store.set(navigationIntentAtom, null);
            setError({ ...normalizeError(cause, false), recoveryOccurrence: occurrence });
          },
        );
      } else {
        current.open(occurrence);
      }
    } catch (cause) {
      store.set(navigationIntentAtom, null);
      setError({ ...normalizeError(cause, false), recoveryOccurrence: occurrence });
    }
  };

  const navigateToc = (point: JoinedTocPoint) => {
    const currentRuntime = runtime.current;
    const occurrence = tocPointOccurrence(point);
    if (currentRuntime === null || occurrence === null || point.resource === null) return;
    const locator: NavigatorLocation = {
      kind: "point",
      occurrence,
      resource: point.resource,
      evidence:
        isAddressedTarget(point.target) && point.target.fragment !== null
          ? [{ kind: "html-fragment", value: point.target.fragment }]
          : [{ kind: "document-boundary", boundary: "start" }],
      observation: emptyObservation,
    };
    const intent: NavigationIntent = {
      runtime: currentRuntime,
      occurrence,
      locator,
      annotationTargetJson: null,
      annotationRecordId: null,
      annotationActivationToken: null,
      focusAfterCompletion: true,
      generation:
        committed?.occurrence === occurrence && committed.resource === point.resource
          ? (committedDocument?.generation ?? null)
          : null,
      focusCancelled: false,
    };
    setAnnotationActivation(null);
    store.set(navigationIntentAtom, intent);
    setError(null);
    closeNavigationSurfaces();
    closeNavigationOverlay();
    if (committed?.occurrence === occurrence && committed.resource === point.resource) {
      void currentRuntime.relocate(locator).then(
        (result) => {
          if (runtime.current !== currentRuntime || store.get(navigationIntentAtom) !== intent)
            return;
          if (result.outcome === "failed") {
            if (result.failure.code !== "operation-cancelled")
              setError(operationError(result.failure));
            store.set(navigationIntentAtom, null);
            return;
          }
          const container = frameHost.current;
          if (container !== null) requestPublicationFocus(container, store, intent);
        },
        (cause: unknown) => {
          if (runtime.current === currentRuntime && store.get(navigationIntentAtom) === intent) {
            store.set(navigationIntentAtom, null);
            setError(normalizeError(cause, false));
          }
        },
      );
      return;
    }
    try {
      currentRuntime.open(occurrence);
    } catch (cause) {
      setError(normalizeError(cause, false));
    }
  };

  const moveBoundary = (boundary: "start" | "end") => {
    const current = runtime.current;
    if (current === null || committed === null) return;
    void current
      .relocate({
        kind: "point",
        occurrence: committed.occurrence,
        resource: committed.resource,
        evidence: [],
        observation: {
          layoutProgression: boundary === "start" ? 0 : 1,
          renderedTextProgression: null,
        },
      })
      .then((result) => {
        if (runtime.current !== current) return;
        if (result.outcome === "failed" && result.failure.code !== "operation-cancelled")
          setError(operationError(result.failure));
      })
      .catch((cause: unknown) => {
        if (runtime.current === current) setError(normalizeError(cause, false));
      });
  };
  return { command, advancePresentation, retry, navigateToc, moveBoundary };
}
