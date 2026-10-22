import { useStore } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { NavigatorAnnotationProjection } from "../../annotations.js";
import type { KernelTransition, NavigatorLocationSnapshot } from "../../generated/kernel.js";
import type {
  NavigatorReaderSession,
  PublicationFrameSandboxCapabilities,
} from "../../publication.js";
import { createNavigatorRuntime } from "../../runtime/navigator/browser-runtime.js";
import type {
  NavigatorRuntime,
  RestoreAnnotationTargetResult,
  NavigatorExternalFormAttempt,
} from "../../runtime/navigator/api.js";
import type {
  NavigatorDiagnostics,
  PublicationPaginationCapabilities,
} from "../../runtime/pagination/index.js";
import { abortOperation } from "../lib/operations.js";
import { abandonRuntimeWorkAtom, adoptRuntimeAtom } from "./lifecycle.js";
import {
  applyLocationSnapshotAtom,
  applySelectionSnapshotAtom,
  reportRuntimeFailureAtom,
} from "./dispatch.js";
import {
  abortAnnotationOperationsAtom,
  activateContextualAnnotationAtom,
  annotationActivationAtom,
  clearContextualAnnotationAtom,
  bookmarkMutationOperationAtom,
  selectionActionOperationAtom,
  contextualAnnotationSourceRevisionAtom,
  decorationRevisionAtom,
  bookmarkCreateAtom,
  contextualAnnotationAtom,
  contextualAnnotationIdAtom,
  footnoteReturnAtom,
  selectedAnnotationIdAtom,
  selectionSnapshotAtom,
} from "../annotations/state.js";
import { requestPublicationFocus, sameVisibleOccurrenceRange } from "../input/focus.js";
import { fixedViewAtom } from "../fixed-layout/state.js";
import {
  navigationIntentAtom,
  readerInteractionHandlerAtom,
  type NavigationIntent,
} from "../navigation/state.js";
import { locationSnapshotAtom, paginationSnapshotAtom } from "../progress/state.js";
import {
  searchActivationAtom,
  searchCoordinatorAtom,
  searchDecorationResultsAtom,
} from "../search/state.js";
import { normalizeError, operationError } from "../status/errors.js";
import { frameFailureMessage } from "../status/messages.js";
import { presentationPreferencesAtom } from "./preferences-state.js";
import {
  activeRuntimeAtom,
  documentErrorAtom,
  readerErrorAtom,
  runtimeViewAtom,
  sessionOwnerAtom,
} from "./projection-state.js";
import type { NavigatorReadingPosition } from "../../runtime/navigator/api.js";

export type { RuntimeView } from "./projection-state.js";

interface RuntimeSessionPort {
  readonly session: NavigatorReaderSession;
  readonly frameSandbox: PublicationFrameSandboxCapabilities;
  readonly frameHost: RefObject<HTMLDivElement | null>;
  readonly runtime: RefObject<NavigatorRuntime | null>;
  readonly paginationRef: RefObject<PublicationPaginationCapabilities | undefined>;
  readonly initialReadingPositionRef: RefObject<NavigatorReadingPosition | null>;
  readonly locationChangeHandler: RefObject<
    ((snapshot: NavigatorLocationSnapshot) => void) | undefined
  >;
  readonly initialRestorationHandler: RefObject<
    ((result: RestoreAnnotationTargetResult) => void) | undefined
  >;
  readonly initialRestorationReady: () => void;
  readonly linkActivationHandler: RefObject<
    | ((activation: {
        href: string;
        resolvedUrl: string;
        target: string | null;
        download: string | null;
        internal: boolean;
        note: {
          referenceRect: { x: number; y: number; width: number; height: number } | null;
          referenceLabel: string | null;
        } | null;
      }) => void)
    | undefined
  >;
  readonly externalFormAttemptHandler: RefObject<
    ((attempt: NavigatorExternalFormAttempt) => void) | undefined
  >;
  readonly annotationProjectionRef: RefObject<NavigatorAnnotationProjection | undefined>;
  readonly title: string;
  readonly diagnostics: NavigatorDiagnostics | undefined;
}

/** Forwards to whichever diagnostics the host most recently supplied. A class keeps the live
 *  `level` property out of an object literal, which the React compiler declines to process. */
class DiagnosticsForwarder implements NavigatorDiagnostics {
  readonly #latest: RefObject<NavigatorDiagnostics | undefined>;
  constructor(latest: RefObject<NavigatorDiagnostics | undefined>) {
    this.#latest = latest;
  }
  get level(): NavigatorDiagnostics["level"] {
    return this.#latest.current?.level ?? "summary";
  }
  readonly record: NavigatorDiagnostics["record"] = (event) => this.#latest.current?.record(event);
  readonly now = (): number => this.#latest.current?.now?.() ?? performance.now();
}

export function useRuntimeSession({
  session,
  frameSandbox,
  frameHost,
  runtime,
  paginationRef,
  initialReadingPositionRef,
  locationChangeHandler,
  initialRestorationHandler,
  initialRestorationReady,
  linkActivationHandler,
  externalFormAttemptHandler,
  annotationProjectionRef,
  title,
  diagnostics,
}: RuntimeSessionPort): void {
  const store = useStore();
  const diagnosticsRef = useRef(diagnostics);
  const [diagnosticsPresence] = useState(diagnostics !== undefined);
  if (diagnosticsPresence !== (diagnostics !== undefined)) {
    throw new Error("NavigatorReader diagnostics presence must remain stable within a session.");
  }
  const sessionRef = useRef(session);
  const frameSandboxRef = useRef(frameSandbox);
  const titleRef = useRef(title);
  const restorationReadyRef = useRef(initialRestorationReady);
  useLayoutEffect(() => {
    diagnosticsRef.current = diagnostics;
    sessionRef.current = session;
    frameSandboxRef.current = frameSandbox;
    titleRef.current = title;
    restorationReadyRef.current = initialRestorationReady;
  });
  const diagnosticsForwarder = useRef<NavigatorDiagnostics | undefined>(
    diagnostics === undefined ? undefined : new DiagnosticsForwarder(diagnosticsRef),
  );
  // Runtime identity is host-session-keyed. The ports it reads are refs so that changing one
  // cannot re-key the effect and rebuild the runtime.
  useEffect(() => {
    const container = frameHost.current;
    if (container === null) return;
    let active = true;
    let disposeListeners = () => {};
    let createdRuntime: NavigatorRuntime | null = null;
    let initialFallbackGeneration: number | null = null;
    const sessionId = session.id;
    const ownsSession = () => active && store.get(sessionOwnerAtom) === sessionId;
    const initialPresentation = store.get(presentationPreferencesAtom);
    const initialPagination = paginationRef.current;
    const initialPosition = initialReadingPositionRef.current;
    if (!ownsSession()) return;
    store.set(abortAnnotationOperationsAtom);
    void createNavigatorRuntime({
      session: sessionRef.current,
      container,
      frameSandbox: frameSandboxRef.current,
      frameTitle: `${titleRef.current} publication content`,
      presentationPreferences: initialPresentation,
      pagination: initialPagination,
      diagnostics: diagnosticsForwarder.current,
    })
      .then((created) => {
        if (!ownsSession()) {
          created.close();
          return;
        }
        createdRuntime = created;
        runtime.current = created;
        store.set(adoptRuntimeAtom, {
          runtime: created,
          constructedWith: { presentation: initialPresentation, pagination: initialPagination },
          pagination: paginationRef.current,
          annotations: annotationProjectionRef.current,
        });
        const isCurrentAnnotationIntent = (intent: NavigationIntent) => {
          const current = store.get(navigationIntentAtom);
          return (
            intent.annotationActivationToken !== null &&
            current?.runtime === intent.runtime &&
            current.annotationActivationToken === intent.annotationActivationToken
          );
        };
        const completeAnnotationActivation = (intent: NavigationIntent) => {
          if (!isCurrentAnnotationIntent(intent)) return;
          const current = store.get(navigationIntentAtom)!;
          const active = container.ownerDocument.activeElement;
          const focusIntent = {
            ...current,
            annotationTargetJson: null,
            focusCancelled:
              current.focusCancelled &&
              active !== null &&
              active.isConnected &&
              active !== container.ownerDocument.body &&
              active !== container.ownerDocument.documentElement &&
              active.closest('[data-slot="dialog-content"]') === null,
          };
          store.set(navigationIntentAtom, focusIntent);
          store.set(selectedAnnotationIdAtom, intent.annotationRecordId);
          store.set(annotationActivationAtom, null);
          if (focusIntent.focusAfterCompletion)
            requestAnimationFrame(() => requestPublicationFocus(container, store, focusIntent));
          else store.set(navigationIntentAtom, null);
        };
        const relocateAfterCommit = (transition: KernelTransition) => {
          const committed = transition.events.find((event) => event.type === "document-committed");
          const intent = store.get(navigationIntentAtom);
          const locator = intent?.locator ?? null;
          const annotationTargetJson = intent?.annotationTargetJson ?? null;
          if (
            committed === undefined ||
            intent?.runtime !== created ||
            intent.occurrence !== committed.occurrence ||
            (locator === null && annotationTargetJson === null) ||
            (locator !== null && locator.resource !== committed.resource)
          ) {
            return;
          }
          if (locator !== null) {
            void created.relocate(locator).then((result) => {
              if (
                !ownsSession() ||
                runtime.current !== created ||
                store.get(navigationIntentAtom) !== intent
              )
                return;
              if (result.outcome === "failed") {
                if (result.failure.code !== "operation-cancelled") {
                  store.set(documentErrorAtom, operationError(result.failure));
                }
                store.set(navigationIntentAtom, null);
                return;
              }
              if (intent.focusAfterCompletion) requestPublicationFocus(container, store, intent);
              else store.set(navigationIntentAtom, null);
            }, reportUnexpectedFailure);
            return;
          }
          void created
            .restoreAnnotationTarget({
              targetJson: annotationTargetJson!,
              occurrenceHint: { occurrence: committed.occurrence, resource: committed.resource },
            })
            .then(
              (result) => {
                if (
                  !ownsSession() ||
                  runtime.current !== created ||
                  !isCurrentAnnotationIntent(intent)
                )
                  return;
                if (result.status === "cancelled") {
                  store.set(navigationIntentAtom, null);
                  store.set(annotationActivationAtom, null);
                  return;
                }
                if (result.status === "failed") {
                  failAnnotationActivation(intent, result.message);
                  return;
                }
                completeAnnotationActivation(intent);
              },
              (cause) => {
                if (
                  !ownsSession() ||
                  runtime.current !== created ||
                  !isCurrentAnnotationIntent(intent)
                )
                  return;
                failAnnotationActivation(intent, normalizeError(cause, false).message);
              },
            );
        };
        const failAnnotationActivation = (intent: NavigationIntent, message: string) => {
          if (!isCurrentAnnotationIntent(intent)) return;
          store.set(navigationIntentAtom, null);
          store.set(selectedAnnotationIdAtom, (current) =>
            current === intent.annotationRecordId ? null : current,
          );
          store.set(annotationActivationAtom, {
            recordId: intent.annotationRecordId ?? "",
            type: "failed",
            message,
          });
        };
        const retryPublicationFocus = () => {
          const intent = store.get(navigationIntentAtom);
          if (
            intent?.runtime !== created ||
            !intent.focusAfterCompletion ||
            intent.annotationTargetJson !== null
          )
            return;
          requestPublicationFocus(container, store, intent);
        };
        const update = (transition: KernelTransition) => {
          if (!ownsSession()) return;
          for (const event of transition.events) {
            if (
              (event.type === "document-cancelled" || event.type === "document-load-failed") &&
              event.generation === initialFallbackGeneration
            ) {
              initialFallbackGeneration = null;
              restorationReadyRef.current();
            }
            if (event.type === "document-pending") {
              abortOperation(store, bookmarkMutationOperationAtom);
              store.set(bookmarkCreateAtom, null);
              store.set(documentErrorAtom, null);
              const intent = store.get(navigationIntentAtom);
              if (
                intent?.runtime !== created ||
                intent.occurrence !== event.occurrence ||
                intent.generation !== null
              ) {
                if (
                  intent?.annotationRecordId !== null &&
                  intent?.annotationRecordId !== undefined
                ) {
                  store.set(annotationActivationAtom, null);
                }
                store.set(navigationIntentAtom, {
                  runtime: created,
                  occurrence: event.occurrence,
                  locator: null,
                  annotationTargetJson: null,
                  annotationRecordId: null,
                  annotationActivationToken: null,
                  focusAfterCompletion: false,
                  generation: event.generation,
                  focusCancelled: false,
                });
              } else {
                store.set(navigationIntentAtom, { ...intent, generation: event.generation });
              }
            }
            if (event.type === "document-load-failed") {
              const intent = store.get(navigationIntentAtom);
              store.set(navigationIntentAtom, null);
              if (intent?.annotationRecordId !== null && intent?.annotationRecordId !== undefined) {
                store.set(selectedAnnotationIdAtom, (current) =>
                  current === intent.annotationRecordId ? null : current,
                );
                store.set(annotationActivationAtom, {
                  recordId: intent.annotationRecordId,
                  type: "failed",
                  message: frameFailureMessage(event.reason),
                });
              }
              store.set(documentErrorAtom, {
                code: event.reason.reason,
                message: frameFailureMessage(event.reason),
                terminal: false,
                recoveryOccurrence: intent?.runtime === created ? intent.occurrence : undefined,
              });
            }
            if (event.type === "document-invalidated") {
              const intent = store.get(navigationIntentAtom);
              store.set(navigationIntentAtom, null);
              if (intent?.annotationRecordId !== null && intent?.annotationRecordId !== undefined) {
                store.set(selectedAnnotationIdAtom, (current) =>
                  current === intent.annotationRecordId ? null : current,
                );
                store.set(annotationActivationAtom, {
                  recordId: intent.annotationRecordId,
                  type: "failed",
                  message: "The publication document navigated outside reader control.",
                });
              }
              store.set(documentErrorAtom, {
                code: event.reason,
                message: "The publication document navigated outside reader control.",
                terminal: false,
                recoveryOccurrence:
                  store.get(runtimeViewAtom)?.snapshot.document.committed?.frame.occurrence,
              });
            }
            if (event.type === "document-committed") {
              if (event.generation === initialFallbackGeneration) {
                initialFallbackGeneration = null;
                restorationReadyRef.current();
              }
              store.set(documentErrorAtom, null);
              const intent = store.get(navigationIntentAtom);
              if (
                intent?.runtime === created &&
                intent.occurrence === event.occurrence &&
                intent.locator === null &&
                intent.annotationTargetJson === null
              ) {
                if (intent.generation !== null && intent.generation !== event.generation) continue;
                if (intent.focusAfterCompletion) {
                  store.set(navigationIntentAtom, { ...intent, generation: event.generation });
                } else {
                  store.set(navigationIntentAtom, null);
                }
              }
            }
          }
          relocateAfterCommit(transition);
          store.set(runtimeViewAtom, (current) => {
            const next = {
              snapshot: created.snapshot(),
              visibleOccurrenceRange: created.visibleOccurrenceRange(),
              finalSpreadLeadingOccurrence: created.finalSpreadLeadingOccurrence(),
            };
            return current?.snapshot === next.snapshot &&
              current.finalSpreadLeadingOccurrence === next.finalSpreadLeadingOccurrence &&
              sameVisibleOccurrenceRange(
                current.visibleOccurrenceRange,
                next.visibleOccurrenceRange,
              )
              ? current
              : next;
          });
          store.set(fixedViewAtom, created.fixedViewState());
          retryPublicationFocus();
        };
        const reportUnexpectedFailure = (cause: unknown) => {
          if (!ownsSession()) return;
          store.set(navigationIntentAtom, null);
          store.set(annotationActivationAtom, null);
          store.set(documentErrorAtom, normalizeError(cause, false));
        };
        const listeners = [
          created.subscribe(update),
          created.subscribeErrors((cause) => {
            if (!ownsSession()) return;
            if (runtime.current === created) {
              runtime.current = null;
              store.set(activeRuntimeAtom, null);
            }
            store.set(reportRuntimeFailureAtom, normalizeError(cause, true));
            restorationReadyRef.current();
          }),
          created.subscribeInteractions((interaction) => {
            if (ownsSession()) store.get(readerInteractionHandlerAtom).handle(interaction);
          }),
          created.subscribeSelections((next) => {
            if (ownsSession()) store.set(applySelectionSnapshotAtom, next);
          }),
          created.subscribeLocations((next) => {
            if (!ownsSession()) return;
            if (store.set(applyLocationSnapshotAtom, next)) locationChangeHandler.current?.(next);
          }),
          created.subscribeActivations((activation) => {
            if (!ownsSession()) return;
            linkActivationHandler.current?.({
              href: activation.href,
              resolvedUrl: activation.resolvedUrl,
              target: activation.target,
              download: activation.download,
              internal: activation.internal,
              note: activation.noteReference,
            });
          }),
          created.subscribeExternalFormAttempts((attempt) => {
            if (!ownsSession()) return;
            externalFormAttemptHandler.current?.({
              action: attempt.action,
              resolvedUrl: attempt.resolvedUrl,
              method: attempt.method,
              target: attempt.target,
            });
          }),
          created.subscribeFootnotes((navigation) => {
            if (!ownsSession()) return;
            store.set(
              footnoteReturnAtom,
              navigation === null
                ? null
                : { activationId: navigation.activationId, status: "available" },
            );
          }),
          created.subscribePagination((next) => {
            if (ownsSession()) store.set(paginationSnapshotAtom, next);
          }),
          created.subscribeDecorations(() => {
            if (!ownsSession()) return;
            store.set(runtimeViewAtom, (current) =>
              current === null ? current : { ...current, snapshot: created.snapshot() },
            );
          }),
          created.subscribeDecorationActivations((activation) => {
            if (!ownsSession()) return;
            const projection = annotationProjectionRef.current;
            if (store.get(decorationRevisionAtom) !== activation.projectionRevision) return;
            const searchResult = activation.ids
              .map((id) => store.get(searchDecorationResultsAtom).get(id))
              .find((result) => result !== undefined);
            if (searchResult !== undefined) {
              store.get(searchCoordinatorAtom)?.select(searchResult.id);
              const decorationId = activation.ids.find(
                (id) => store.get(searchDecorationResultsAtom).get(id)?.id === searchResult.id,
              );
              if (decorationId !== undefined) {
                created.setActiveDecoration(activation.projectionRevision, decorationId);
              }
              store.set(searchActivationAtom, null);
              store.set(contextualAnnotationAtom, null);
              store.set(contextualAnnotationIdAtom, null);
              store.set(contextualAnnotationSourceRevisionAtom, null);
              return;
            }
            if (projection === undefined) return;
            if (activation.ids.length === 0) {
              store.set(clearContextualAnnotationAtom);
              return;
            }
            const known = activation.ids.filter((id) =>
              projection.records.some((record) => record.type !== "bookmark" && record.id === id),
            );
            if (known.length === 0) return;
            const selected = known.length === 1 ? known[0]! : null;
            abortOperation(store, selectionActionOperationAtom);
            store.set(activateContextualAnnotationAtom, {
              activation: { ...activation, ids: known },
              sourceRevision: projection.revision,
              selectionRevision: created.currentSelection().revision,
              selectedId: selected,
            });
            if (selected !== null)
              created.setActiveDecoration(activation.projectionRevision, selected);
          }),
        ];
        disposeListeners = () => {
          for (const dispose of listeners) dispose();
        };
        store.set(runtimeViewAtom, {
          snapshot: created.snapshot(),
          visibleOccurrenceRange: created.visibleOccurrenceRange(),
          finalSpreadLeadingOccurrence: created.finalSpreadLeadingOccurrence(),
        });
        store.set(paginationSnapshotAtom, created.paginationSnapshot());
        store.set(selectionSnapshotAtom, created.currentSelection());
        store.set(locationSnapshotAtom, created.currentLocation());
        store.set(fixedViewAtom, created.fixedViewState());
        const openInitialOccurrence = () => {
          if (!ownsSession() || runtime.current !== created) return;
          try {
            store.set(navigationIntentAtom, {
              runtime: created,
              occurrence: 0,
              locator: null,
              annotationTargetJson: null,
              annotationRecordId: null,
              annotationActivationToken: null,
              focusAfterCompletion: true,
              generation: null,
              focusCancelled: false,
            });
            const transition = created.open(0);
            initialFallbackGeneration =
              transition.events.find((event) => event.type === "document-pending")?.generation ??
              null;
            if (initialFallbackGeneration === null) restorationReadyRef.current();
          } catch (cause) {
            reportUnexpectedFailure(cause);
            restorationReadyRef.current();
          }
        };
        if (initialPosition === null) {
          openInitialOccurrence();
          return;
        }
        void created.restoreAnnotationTarget(initialPosition).then(
          (result) => {
            if (!ownsSession() || runtime.current !== created) return;
            let raised: { readonly cause: unknown } | null = null;
            try {
              initialRestorationHandler.current?.(result);
            } catch (cause) {
              raised = { cause };
            }
            if (result.status === "restored") restorationReadyRef.current();
            else openInitialOccurrence();
            if (raised !== null) throw raised.cause;
          },
          (cause: unknown) => {
            if (!ownsSession() || runtime.current !== created) return;
            const result: RestoreAnnotationTargetResult = {
              status: "failed",
              reason: "unavailable",
              message: normalizeError(cause, false).message,
            };
            let raised: { readonly cause: unknown } | null = null;
            try {
              initialRestorationHandler.current?.(result);
            } catch (cause) {
              raised = { cause };
            }
            openInitialOccurrence();
            if (raised !== null) throw raised.cause;
          },
        );
      })
      .catch((cause: unknown) => {
        if (ownsSession()) {
          store.set(readerErrorAtom, normalizeError(cause, true));
          restorationReadyRef.current();
        }
      });

    return () => {
      active = false;
      disposeListeners();
      store.set(abandonRuntimeWorkAtom);
      const current = createdRuntime;
      if (runtime.current === current) {
        runtime.current = null;
        store.set(activeRuntimeAtom, null);
      }
      if (current !== null) {
        try {
          current.close();
        } catch {
          // Cleanup cannot replace the reader's already observed terminal error.
        }
      }
    };
  }, [
    session.id,
    store,
    frameHost,
    runtime,
    paginationRef,
    initialReadingPositionRef,
    locationChangeHandler,
    initialRestorationHandler,
    linkActivationHandler,
    externalFormAttemptHandler,
    annotationProjectionRef,
    sessionRef,
    frameSandboxRef,
    titleRef,
    restorationReadyRef,
    diagnosticsForwarder,
  ]);
}
