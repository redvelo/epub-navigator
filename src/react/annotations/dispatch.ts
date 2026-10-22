import { atom } from "jotai";
import { currentDocument, currentFrame } from "../../runtime/kernel-view.js";
import { requestPublicationFocus } from "../input/focus.js";
import { normalizeError, operationError } from "../status/errors.js";
import { sameDurablePoint } from "../../runtime/selection/location-equivalence.js";
import { abortOperation, beginOperation, releaseOperation } from "../lib/operations.js";
import { setCompactSurfaceAtom } from "../compact/state.js";
import { closeWorkspaceOverlayAtom } from "../workspace/state.js";
import { readerStoreAtom } from "../navigation/navigate-atom.js";
import {
  activeRuntimeAtom,
  frameHostElementAtom,
  runtimeViewAtom,
} from "../runtime/projection-state.js";
import { navigationIntentAtom, type NavigationIntent } from "../navigation/state.js";
import {
  annotationRangeAdjustmentFailureMessage,
  bookmarkGenerationFailureMessage,
  bookmarkOccurrenceHint,
} from "./helpers.js";
import {
  annotationActivationAtom,
  annotationActivationSequenceAtom,
  annotationDeleteAtom,
  annotationMutationHandlerAtom,
  annotationProjectionAtom,
  annotationSectionLabelAtom,
  bookmarkActivationOperationAtom,
  bookmarkCreateAtom,
  bookmarkMutationOperationAtom,
  bookmarkedLocationRevisionAtom,
  annotationRetargetAtom,
  contextualAnnotationAtom,
  contextualAnnotationIdAtom,
  contextualAnnotationSourceRevisionAtom,
  decorationRevisionAtom,
  deleteMutationOperationAtom,
  retargetMutationOperationAtom,
  editReturnFocusAtom,
  noteDraftAtom,
  publicationFactsAtom,
  selectedAnnotationIdAtom,
  type BookmarkCreateState,
} from "./state.js";
import type {
  NavigatorAnnotationMutationRequest,
  NavigatorAnnotationRecord,
  NavigatorNoteAnnotationRecord,
} from "../../annotations.js";
import type { AnnotationRangeAdjustment, NavigatorRuntime } from "../../runtime/navigator/api.js";

/** Saves a bookmark at the reader's current location. */
export const createAnnotationBookmarkAtom = atom(
  null,
  async (get, set, event: MouseEvent): Promise<void> => {
    const store = get(readerStoreAtom);
    if (store === null) return;
    if (!event.isTrusted) return;
    const requestedRuntime = get(activeRuntimeAtom);
    const currentProjection = get(annotationProjectionAtom);
    const handler = get(annotationMutationHandlerAtom)?.handle;
    const location = requestedRuntime?.currentLocation();
    if (
      requestedRuntime === null ||
      currentProjection === undefined ||
      handler === undefined ||
      location === undefined ||
      location.location?.kind !== "point" ||
      location.basis === null ||
      get(bookmarkedLocationRevisionAtom) === location.revision
    )
      return;
    const controller = beginOperation(store, bookmarkMutationOperationAtom);
    const requestId = crypto.randomUUID();
    const locationRevision = location.revision;
    const initial: BookmarkCreateState = {
      locationRevision,
      requestId,
      status: "generating",
      occurrence: null,
      targetJson: null,
      sectionLabel: get(annotationSectionLabelAtom),
      label: null,
      acknowledgedRecordId: null,
      projectionRevision: null,
      error: null,
    };
    set(bookmarkCreateAtom, initial);
    const clearIfCurrent = () =>
      set(bookmarkCreateAtom, (current) => (current?.requestId === requestId ? null : current));
    try {
      const generation =
        await requestedRuntime.generateCurrentLocationAnnotationTarget(locationRevision);
      const generatedLocation = requestedRuntime.currentLocation();
      if (
        controller.signal.aborted ||
        get(activeRuntimeAtom) !== requestedRuntime ||
        !sameDurablePoint(
          location.location,
          location.basis,
          generatedLocation.location,
          generatedLocation.basis,
        )
      ) {
        clearIfCurrent();
        return;
      }
      if (generation.outcome === "failed") {
        if (generation.failure.code === "operation-cancelled") {
          clearIfCurrent();
          return;
        }
        throw new Error(operationError(generation.failure).message);
      }
      if (generation.result.status !== "generated")
        throw new Error(bookmarkGenerationFailureMessage(generation.result));
      const controlled = get(annotationProjectionAtom);
      if (controlled === undefined) {
        clearIfCurrent();
        return;
      }
      const request: NavigatorAnnotationMutationRequest = {
        type: "create-bookmark",
        requestId,
        basedOnRevision: controlled.revision,
        locationRevision,
        occurrence: generation.occurrence,
        targetJson: generation.result.targetJson,
        sectionLabel: get(annotationSectionLabelAtom),
        label: null,
      };
      set(bookmarkCreateAtom, {
        ...initial,
        locationRevision: generatedLocation.revision,
        status: "persisting",
        occurrence: request.occurrence,
        targetJson: request.targetJson,
      });
      const acknowledgment = await handler(request, { signal: controller.signal });
      const persistedLocation = requestedRuntime.currentLocation();
      if (
        controller.signal.aborted ||
        get(activeRuntimeAtom) !== requestedRuntime ||
        !sameDurablePoint(
          location.location,
          location.basis,
          persistedLocation.location,
          persistedLocation.basis,
        )
      ) {
        clearIfCurrent();
        return;
      }
      if (acknowledgment.requestId !== requestId)
        throw new Error("The host returned an acknowledgment for a different bookmark request.");
      if (acknowledgment.status === "rejected") throw new Error(acknowledgment.reason);
      const latest = get(annotationProjectionAtom);
      const present =
        latest !== undefined &&
        latest.revision >= acknowledgment.projectionRevision &&
        latest.records.some(
          (record) =>
            record.type === "bookmark" &&
            record.id === acknowledgment.recordId &&
            record.targetJson === request.targetJson &&
            record.occurrence === request.occurrence &&
            record.sectionLabel === request.sectionLabel &&
            record.label === request.label,
        );
      if (present) {
        set(bookmarkedLocationRevisionAtom, persistedLocation.revision);
        set(bookmarkCreateAtom, null);
        return;
      }
      set(bookmarkCreateAtom, {
        ...initial,
        locationRevision: persistedLocation.revision,
        status: "awaiting-projection",
        occurrence: request.occurrence,
        targetJson: request.targetJson,
        acknowledgedRecordId: acknowledgment.recordId,
        projectionRevision: acknowledgment.projectionRevision,
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      set(bookmarkCreateAtom, (current) =>
        current?.requestId !== requestId
          ? current
          : {
              ...current,
              status: "failed",
              acknowledgedRecordId: null,
              projectionRevision: null,
              error:
                cause instanceof Error && cause.message.length > 0
                  ? cause.message
                  : "The bookmark could not be created.",
            },
      );
    } finally {
      releaseOperation(store, bookmarkMutationOperationAtom, controller);
    }
  },
);

/** Deletes one annotation record through the host. */
export const deleteAnnotationAtom = atom(
  null,
  async (get, set, record: NavigatorAnnotationRecord, event: MouseEvent): Promise<void> => {
    const store = get(readerStoreAtom);
    if (store === null) return;
    if (!event.isTrusted) return;
    const currentProjection = get(annotationProjectionAtom);
    const handler = get(annotationMutationHandlerAtom)?.handle;
    if (currentProjection === undefined || handler === undefined) return;
    const controller = beginOperation(store, deleteMutationOperationAtom);
    const requestId = crypto.randomUUID();
    set(annotationDeleteAtom, {
      recordId: record.id,
      requestId,
      status: "submitting",
      error: null,
      projectionRevision: null,
    });
    try {
      const acknowledgment = await handler(
        {
          type: "delete-annotation",
          requestId,
          basedOnRevision: currentProjection.revision,
          recordId: record.id,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (acknowledgment.requestId !== requestId)
        throw new Error("The host returned an acknowledgment for a different annotation request.");
      if (acknowledgment.status === "rejected") throw new Error(acknowledgment.reason);
      if (acknowledgment.recordId !== record.id)
        throw new Error("The host acknowledged deletion of a different annotation record.");
      set(annotationDeleteAtom, {
        recordId: record.id,
        requestId,
        status: "awaiting-projection",
        error: null,
        projectionRevision: acknowledgment.projectionRevision,
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      set(annotationDeleteAtom, {
        recordId: record.id,
        requestId,
        status: "failed",
        error:
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "The annotation could not be deleted.",
        projectionRevision: null,
      });
    } finally {
      releaseOperation(store, deleteMutationOperationAtom, controller);
    }
  },
);

/** Navigates to an annotation, restoring its target in the committed document. */
export const activateAnnotationAtom = atom(
  null,
  (get, set, record: NavigatorAnnotationRecord, event: MouseEvent): void => {
    const store = get(readerStoreAtom);
    const facts = get(publicationFactsAtom);
    if (store === null || facts === null) return;
    const snapshot = get(runtimeViewAtom)?.snapshot ?? null;
    const committed = snapshot === null ? null : currentFrame(snapshot);
    const committedDocument = snapshot === null ? null : currentDocument(snapshot);
    const pending = snapshot?.document.pending ?? null;
    if (!event.isTrusted) return;
    const currentRuntime = get(activeRuntimeAtom);
    if (currentRuntime === null) return;
    abortOperation(store, bookmarkActivationOperationAtom);
    if (record.type === "bookmark") {
      set(navigationIntentAtom, null);
      const controller = beginOperation(store, bookmarkActivationOperationAtom);
      set(annotationActivationAtom, { recordId: record.id, type: "activating" });
      void currentRuntime
        .restoreAnnotationTarget(
          { targetJson: record.targetJson, occurrenceHint: bookmarkOccurrenceHint(facts, record) },
          { signal: controller.signal },
        )
        .then(
          (result) => {
            if (controller.signal.aborted) return;
            if (result.status === "cancelled") {
              set(annotationActivationAtom, null);
              return;
            }
            if (result.status === "failed") {
              set(annotationActivationAtom, {
                recordId: record.id,
                type: "failed",
                message: result.message,
              });
              return;
            }
            set(selectedAnnotationIdAtom, record.id);
            set(annotationActivationAtom, null);
            set(setCompactSurfaceAtom, null);
          },
          (cause: unknown) => {
            if (controller.signal.aborted) return;
            set(annotationActivationAtom, {
              recordId: record.id,
              type: "failed",
              message: normalizeError(cause, false).message,
            });
          },
        )
        .finally(() => {
          releaseOperation(store, bookmarkActivationOperationAtom, controller);
        });
      return;
    }
    if (pending !== null) {
      try {
        currentRuntime.cancel();
      } catch (cause) {
        set(annotationActivationAtom, {
          recordId: record.id,
          type: "failed",
          message: normalizeError(cause, false).message,
        });
        return;
      }
    }
    const activationToken = get(annotationActivationSequenceAtom) + 1;
    set(annotationActivationSequenceAtom, activationToken);
    const intent: NavigationIntent = {
      runtime: currentRuntime,
      occurrence: record.occurrence,
      locator: null,
      annotationTargetJson: record.targetJson,
      annotationRecordId: record.id,
      annotationActivationToken: activationToken,
      focusAfterCompletion: true,
      generation:
        committed?.occurrence === record.occurrence
          ? (committedDocument?.generation ?? null)
          : null,
      focusCancelled: false,
    };
    set(navigationIntentAtom, intent);
    set(annotationActivationAtom, { recordId: record.id, type: "activating" });
    set(setCompactSurfaceAtom, null);
    set(closeWorkspaceOverlayAtom, "annotations");
    const isCurrentActivation = () =>
      get(activeRuntimeAtom) === currentRuntime &&
      get(navigationIntentAtom)?.annotationActivationToken === intent.annotationActivationToken;
    const settle = (result: Awaited<ReturnType<NavigatorRuntime["restoreAnnotationTarget"]>>) => {
      if (!isCurrentActivation()) return;
      if (result.status === "cancelled") {
        set(navigationIntentAtom, null);
        set(annotationActivationAtom, null);
        return;
      }
      if (result.status === "failed") {
        set(selectedAnnotationIdAtom, (current) => (current === record.id ? null : current));
        set(annotationActivationAtom, {
          recordId: record.id,
          type: "failed",
          message: result.message,
        });
        set(navigationIntentAtom, null);
        return;
      }
      const container = get(frameHostElementAtom);
      const active = container?.ownerDocument.activeElement ?? null;
      const focusIntent = {
        ...get(navigationIntentAtom)!,
        annotationTargetJson: null,
        focusCancelled:
          get(navigationIntentAtom)!.focusCancelled &&
          active !== null &&
          active.isConnected &&
          active !== container?.ownerDocument.body &&
          active !== container?.ownerDocument.documentElement &&
          active.closest('[data-slot="dialog-content"]') === null,
      };
      set(navigationIntentAtom, focusIntent);
      set(selectedAnnotationIdAtom, record.id);
      set(annotationActivationAtom, null);
      if (container !== null)
        requestAnimationFrame(() => requestPublicationFocus(container, store, focusIntent));
    };
    if (committed?.occurrence === record.occurrence) {
      void currentRuntime
        .restoreAnnotationTarget({
          targetJson: record.targetJson,
          occurrenceHint: { occurrence: record.occurrence, resource: committed.resource },
        })
        .then(settle, (cause) => {
          if (isCurrentActivation()) {
            set(navigationIntentAtom, null);
            set(selectedAnnotationIdAtom, (current) => (current === record.id ? null : current));
            set(annotationActivationAtom, {
              recordId: record.id,
              type: "failed",
              message: normalizeError(cause, false).message,
            });
          }
        });
      return;
    }
    try {
      const transition = currentRuntime.open(record.occurrence);
      if (!transition.accepted) {
        set(navigationIntentAtom, null);
        set(annotationActivationAtom, {
          recordId: record.id,
          type: "failed",
          message: transition.failure?.message ?? "The annotation location could not be opened.",
        });
      }
    } catch (cause) {
      set(navigationIntentAtom, null);
      set(selectedAnnotationIdAtom, (current) => (current === record.id ? null : current));
      set(annotationActivationAtom, {
        recordId: record.id,
        type: "failed",
        message: normalizeError(cause, false).message,
      });
    }
  },
);

/** Opens the note editor for an existing note, remembering the trigger for focus return. */
export const editAnnotationNoteAtom = atom(
  null,
  (get, set, record: NavigatorNoteAnnotationRecord, trigger: HTMLElement): void => {
    const currentProjection = get(annotationProjectionAtom);
    if (currentProjection === undefined) return;
    set(editReturnFocusAtom, {
      recordId: record.id,
      element: trigger.closest<HTMLElement>("[data-annotation-id]") ?? trigger,
    });
    set(noteDraftAtom, {
      mode: "edit",
      recordId: record.id,
      targetJson: record.targetJson,
      occurrence: record.occurrence,
      basedOnRevision: currentProjection.revision,
      selectionRevision: null,
      excerpt: record.excerpt,
      sectionLabel: record.sectionLabel,
      text: record.text,
      status: "idle",
      error: null,
      requestId: null,
      projectionRevision: null,
    });
  },
);

/** Adjusts one annotation range endpoint and persists the new target through the host. */
export const adjustAnnotationRangeAtom = atom(
  null,
  async (
    get,
    set,
    record: NavigatorAnnotationRecord,
    adjustment: AnnotationRangeAdjustment,
    event: MouseEvent,
  ): Promise<void> => {
    const store = get(readerStoreAtom);
    if (store === null) return;
    if (!event.isTrusted || record.type === "bookmark") return;
    const requestedRuntime = get(activeRuntimeAtom);
    const activation = get(contextualAnnotationAtom);
    const currentProjection = get(annotationProjectionAtom);
    const handler = get(annotationMutationHandlerAtom)?.handle;
    if (
      requestedRuntime === null ||
      activation === null ||
      currentProjection === undefined ||
      handler === undefined ||
      get(contextualAnnotationSourceRevisionAtom) !== currentProjection.revision ||
      activation.projectionRevision !== get(decorationRevisionAtom) ||
      get(contextualAnnotationIdAtom) !== record.id
    )
      return;
    const controller = beginOperation(store, retargetMutationOperationAtom);
    set(annotationRetargetAtom, {
      recordId: record.id,
      adjustment,
      status: "adjusting",
      requestId: null,
      projectionRevision: null,
      targetJson: null,
      excerpt: null,
      error: null,
    });
    try {
      const outcome = await requestedRuntime.adjustAnnotationRange(
        activation.projectionRevision,
        record.id,
        adjustment,
      );
      if (controller.signal.aborted || get(activeRuntimeAtom) !== requestedRuntime) return;
      if (outcome.status !== "adjusted")
        throw new Error(annotationRangeAdjustmentFailureMessage(outcome));
      const latestProjection = get(annotationProjectionAtom);
      if (latestProjection?.revision !== currentProjection.revision)
        throw new Error("The annotation projection changed during range adjustment.");
      const requestId = crypto.randomUUID();
      set(annotationRetargetAtom, {
        recordId: record.id,
        adjustment,
        status: "submitting",
        requestId,
        projectionRevision: null,
        targetJson: outcome.targetJson,
        excerpt: outcome.excerpt,
        error: null,
      });
      const acknowledgment = await handler(
        {
          type: "retarget-annotation",
          requestId,
          basedOnRevision: latestProjection.revision,
          recordId: record.id,
          targetJson: outcome.targetJson,
          excerpt: outcome.excerpt,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (acknowledgment.requestId !== requestId)
        throw new Error("The host returned an acknowledgment for a different annotation request.");
      if (acknowledgment.status === "rejected") throw new Error(acknowledgment.reason);
      if (acknowledgment.recordId !== record.id)
        throw new Error("The host acknowledged a different annotation record.");
      set(annotationRetargetAtom, {
        recordId: record.id,
        adjustment,
        status: "awaiting-projection",
        requestId,
        projectionRevision: acknowledgment.projectionRevision,
        targetJson: outcome.targetJson,
        excerpt: outcome.excerpt,
        error: null,
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      set(annotationRetargetAtom, {
        recordId: record.id,
        adjustment,
        status: "failed",
        requestId: null,
        projectionRevision: null,
        targetJson: null,
        excerpt: null,
        error:
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "The annotation range could not be adjusted.",
      });
    } finally {
      releaseOperation(store, retargetMutationOperationAtom, controller);
    }
  },
);
