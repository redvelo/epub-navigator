import { atom } from "jotai";
import {
  currentDocument,
  currentFrame,
  occurrenceAliasesResource,
  occurrenceLoadableTarget,
} from "../../runtime/kernel-view.js";
import { requestPublicationFocus } from "../input/focus.js";
import { normalizeError, operationError } from "../status/errors.js";
import { annotationActivationAtom, publicationFactsAtom } from "../annotations/state.js";
import { setCompactSurfaceAtom } from "../compact/state.js";
import {
  activeRuntimeAtom,
  documentErrorAtom,
  frameHostElementAtom,
  runtimeViewAtom,
} from "../runtime/projection-state.js";
import { closeWorkspaceOverlayAtom, setWorkspaceSurfaceAtom } from "../workspace/state.js";
import { emptyObservation } from "./controller.js";
import { isAddressedTarget, tocPointOccurrence, type JoinedTocPoint } from "./model.js";
import { navigationIntentAtom, type NavigationIntent } from "./state.js";
import type { ReaderStore } from "../lib/store.js";
import type { NavigatorLocation } from "../../generated/kernel.js";

/** A place in the publication a reader surface asks for, already resolved to its occurrence. */
export interface PublicationDestination {
  readonly occurrence: number;
  readonly resource: string;
  readonly fragment: string | null;
}

/**
 * Takes the reading position to a destination entirely from store state, so the surface that
 * dispatches it never has to hold the reader's closure.
 */
export const navigateToDestinationAtom = atom(
  null,
  (get, set, destination: PublicationDestination) => {
    const runtime = get(activeRuntimeAtom);
    const { occurrence, resource, fragment } = destination;
    if (runtime === null) return;
    const snapshot = get(runtimeViewAtom)?.snapshot ?? null;
    const committed = snapshot === null ? null : currentFrame(snapshot);
    const committedDocument = snapshot === null ? null : currentDocument(snapshot);
    const sameSection =
      committed !== null && committed.occurrence === occurrence && committed.resource === resource;
    const locator: NavigatorLocation = {
      kind: "point",
      occurrence,
      resource,
      evidence:
        fragment === null
          ? [{ kind: "document-boundary", boundary: "start" }]
          : [{ kind: "html-fragment", value: fragment }],
      observation: emptyObservation,
    };
    const intent: NavigationIntent = {
      runtime,
      occurrence,
      locator,
      annotationTargetJson: null,
      annotationRecordId: null,
      annotationActivationToken: null,
      focusAfterCompletion: true,
      generation: sameSection ? (committedDocument?.generation ?? null) : null,
      focusCancelled: false,
    };
    set(annotationActivationAtom, null);
    set(navigationIntentAtom, intent);
    set(documentErrorAtom, null);
    set(setCompactSurfaceAtom, null);
    set(setWorkspaceSurfaceAtom, null);
    set(closeWorkspaceOverlayAtom, "navigation");
    if (!sameSection) {
      try {
        runtime.open(occurrence);
      } catch (cause) {
        set(documentErrorAtom, normalizeError(cause, false));
      }
      return;
    }
    const store = get(readerStoreAtom);
    void runtime.relocate(locator).then(
      (result) => {
        if (get(activeRuntimeAtom) !== runtime || get(navigationIntentAtom) !== intent) return;
        if (result.outcome === "failed") {
          if (result.failure.code !== "operation-cancelled") {
            set(documentErrorAtom, operationError(result.failure));
          }
          set(navigationIntentAtom, null);
          return;
        }
        const container = get(frameHostElementAtom);
        if (container !== null && store !== null) requestPublicationFocus(container, store, intent);
      },
      (cause: unknown) => {
        if (get(activeRuntimeAtom) === runtime && get(navigationIntentAtom) === intent) {
          set(navigationIntentAtom, null);
          set(documentErrorAtom, normalizeError(cause, false));
        }
      },
    );
  },
);

/** Activates a table-of-contents destination. */
export const navigateToTocPointAtom = atom(null, (_get, set, point: JoinedTocPoint) => {
  const occurrence = tocPointOccurrence(point);
  if (occurrence === null || point.resource === null) return;
  set(navigateToDestinationAtom, {
    occurrence,
    resource: point.resource,
    fragment: isAddressedTarget(point.target) ? point.target.fragment : null,
  });
});

/**
 * Takes the reading position to a note the reader could not show in place.
 *
 * A reference classified as a note stops the page moving, so a note that turns out to be
 * unreadable would otherwise leave the reader no way to it at all. Going there is what a reader
 * without somewhere to show it would have done, and is the honest answer when showing fails.
 */
export const navigateToNoteAtom = atom(
  null,
  (get, set, target: { readonly resource: string; readonly fragment: string }): boolean => {
    const facts = get(publicationFactsAtom);
    const snapshot = get(runtimeViewAtom)?.snapshot ?? null;
    if (facts === null || snapshot === null || get(activeRuntimeAtom) === null) return false;
    const occurrence = snapshot.readingOrder.find((candidate) =>
      occurrenceAliasesResource(facts, candidate, target.resource),
    );
    if (occurrence === undefined || occurrenceLoadableTarget(occurrence) === null) return false;
    set(navigateToDestinationAtom, {
      occurrence: occurrence.ordinal,
      resource: target.resource,
      fragment: target.fragment,
    });
    return true;
  },
);

/** The focus helper needs the store itself; the reader publishes it once per session. */
export const readerStoreAtom = atom<ReaderStore | null>(null);
