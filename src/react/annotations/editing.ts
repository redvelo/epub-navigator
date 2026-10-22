import { atom } from "jotai";
import { activePublicationFrame } from "../input/focus.js";
import { operationError } from "../status/errors.js";
import { abortOperation, beginOperation, releaseOperation } from "../lib/operations.js";
import {
  openCompactAnnotationsAtom,
  readerCompactAtom,
  setCompactSurfaceAtom,
} from "../compact/state.js";
import { readerStoreAtom } from "../navigation/navigate-atom.js";
import {
  activeRuntimeAtom,
  frameHostElementAtom,
  readerRootElementAtom,
} from "../runtime/projection-state.js";
import {
  highlightGenerationFailureMessage,
  noteTextError,
  selectionExactText,
  selectionExcerpt,
  writeClipboardText,
} from "./helpers.js";
import {
  annotationMutationHandlerAtom,
  annotationProjectionAtom,
  annotationSectionLabelAtom,
  contextualAnnotationAtom,
  contextualAnnotationIdAtom,
  dismissedSelectionRevisionAtom,
  editReturnFocusAtom,
  noteDraftAtom,
  noteMutationOperationAtom,
  selectedAnnotationIdAtom,
  selectionActionAtom,
  selectionActionOperationAtom,
  selectionSnapshotAtom,
} from "./state.js";
import type {
  NavigatorAnnotationMutationRequest,
  NavigatorAnnotationRecord,
} from "../../annotations.js";

export const returnFocusToPublicationAtom = atom(null, (get) => {
  activePublicationFrame(get(frameHostElementAtom))?.focus({ preventScroll: true });
});

export const dismissAnnotationToolbarAtom = atom(null, (get, set) => {
  const current = get(contextualAnnotationAtom);
  if (current !== null)
    get(activeRuntimeAtom)?.setActiveDecoration(current.projectionRevision, null);
  set(contextualAnnotationAtom, null);
  set(contextualAnnotationIdAtom, null);
  set(returnFocusToPublicationAtom);
});

export const selectContextualAnnotationAtom = atom(null, (get, set, id: string) => {
  const current = get(contextualAnnotationAtom);
  if (current === null || !current.ids.includes(id)) return;
  set(contextualAnnotationIdAtom, id);
  set(selectedAnnotationIdAtom, id);
  get(activeRuntimeAtom)?.setActiveDecoration(current.projectionRevision, id);
});

export const dismissSelectionToolbarAtom = atom(null, (get, set) => {
  const store = get(readerStoreAtom);
  if (store === null) return;
  if (abortOperation(store, selectionActionOperationAtom)) {
    get(activeRuntimeAtom)?.cancelSelectionAnnotationTargetGeneration();
  }
  const snapshot = get(selectionSnapshotAtom);
  if (snapshot !== null) set(dismissedSelectionRevisionAtom, snapshot.revision);
  set(selectionActionAtom, null);
  set(returnFocusToPublicationAtom);
});

export const beginSelectionAnnotationAtom = atom(
  null,
  async (
    _get,
    set,
    action: "highlight" | "note",
    event: MouseEvent | KeyboardEvent,
  ): Promise<void> => {
    if (!event.isTrusted) return;
    await set(annotateSelectionAtom, action);
  },
);

export const annotateSelectionAtom = atom(
  null,
  async (get, set, action: "highlight" | "note"): Promise<void> => {
    const store = get(readerStoreAtom);
    if (store === null) return;
    const requestedRuntime = get(activeRuntimeAtom);
    const selection = get(selectionSnapshotAtom);
    const currentProjection = get(annotationProjectionAtom);
    const handler = get(annotationMutationHandlerAtom)?.handle;
    if (
      requestedRuntime === null ||
      selection?.selection?.status !== "captured" ||
      currentProjection === undefined ||
      handler === undefined
    )
      return;
    const controller = beginOperation(store, selectionActionOperationAtom);
    const requestId = crypto.randomUUID();
    const clearPendingAction = () =>
      set(selectionActionAtom, (current) => (current?.requestId === requestId ? null : current));
    const selectionRevision = selection.revision;
    set(selectionActionAtom, {
      action,
      selectionRevision,
      requestId,
      status: "generating",
      error: null,
      acknowledgedRecordId: null,
    });
    try {
      const generation = await requestedRuntime.generateSelectionAnnotationTarget(
        selectionRevision,
        {
          textFragment: "include",
        },
      );
      if (
        controller.signal.aborted ||
        get(activeRuntimeAtom) !== requestedRuntime ||
        requestedRuntime.currentSelection().revision !== selectionRevision
      ) {
        clearPendingAction();
        return;
      }
      if (generation.outcome === "failed") {
        if (generation.failure.code === "operation-cancelled") {
          clearPendingAction();
          return;
        }
        throw new Error(operationError(generation.failure).message);
      }
      if (generation.result.status !== "generated")
        throw new Error(highlightGenerationFailureMessage(generation.result.status));
      const latestProjection = get(annotationProjectionAtom);
      if (latestProjection === undefined) {
        clearPendingAction();
        return;
      }
      const excerpt = selectionExcerpt(selection.selection.location);
      if (action === "note") {
        requestedRuntime.clearSelection();
        set(dismissedSelectionRevisionAtom, selectionRevision);
        set(selectionActionAtom, null);
        set(noteDraftAtom, {
          mode: "create",
          recordId: null,
          targetJson: generation.result.targetJson,
          occurrence: generation.occurrence,
          basedOnRevision: latestProjection.revision,
          selectionRevision,
          excerpt,
          sectionLabel: get(annotationSectionLabelAtom),
          text: "",
          status: "idle",
          error: null,
          requestId: null,
          projectionRevision: null,
        });
        if (get(readerCompactAtom)) set(openCompactAnnotationsAtom);
        return;
      }
      const request: NavigatorAnnotationMutationRequest = {
        type: "create-highlight",
        requestId,
        basedOnRevision: latestProjection.revision,
        selectionRevision,
        occurrence: generation.occurrence,
        targetJson: generation.result.targetJson,
        excerpt,
        sectionLabel: get(annotationSectionLabelAtom),
      };
      set(selectionActionAtom, {
        action: "highlight",
        selectionRevision,
        requestId,
        status: "persisting",
        error: null,
        acknowledgedRecordId: null,
      });
      const acknowledgment = await handler(request, { signal: controller.signal });
      if (
        controller.signal.aborted ||
        get(activeRuntimeAtom) !== requestedRuntime ||
        requestedRuntime.currentSelection().revision !== selectionRevision
      ) {
        clearPendingAction();
        return;
      }
      if (acknowledgment.requestId !== requestId)
        throw new Error("The host returned an acknowledgment for a different annotation request.");
      if (acknowledgment.status === "rejected") throw new Error(acknowledgment.reason);
      const controlled = get(annotationProjectionAtom);
      if (
        controlled !== undefined &&
        controlled.revision >= acknowledgment.projectionRevision &&
        controlled.records.some(
          (record) =>
            record.id === acknowledgment.recordId &&
            record.type === "highlight" &&
            record.targetJson === request.targetJson &&
            record.occurrence === request.occurrence &&
            record.excerpt === request.excerpt &&
            record.sectionLabel === request.sectionLabel,
        )
      ) {
        requestedRuntime.clearSelection();
        set(dismissedSelectionRevisionAtom, selectionRevision);
        set(selectionActionAtom, null);
        set(returnFocusToPublicationAtom);
        return;
      }
      set(selectionActionAtom, {
        action: "highlight",
        selectionRevision,
        requestId,
        status: "awaiting-projection",
        error: null,
        acknowledgedRecordId: acknowledgment.recordId,
        projectionRevision: acknowledgment.projectionRevision,
        targetJson: request.targetJson,
        occurrence: request.occurrence,
        excerpt: request.excerpt,
        sectionLabel: request.sectionLabel,
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        clearPendingAction();
        return;
      }
      set(selectionActionAtom, {
        action,
        selectionRevision,
        requestId,
        status: "failed",
        error:
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : action === "highlight"
              ? "The highlight could not be created."
              : "The note editor could not be opened.",
        acknowledgedRecordId: null,
      });
    } finally {
      releaseOperation(store, selectionActionOperationAtom, controller);
    }
  },
);

export const copySelectionAtom = atom(null, async (get, set, event: MouseEvent): Promise<void> => {
  if (!event.isTrusted) return;
  const requestedRuntime = get(activeRuntimeAtom);
  const selection = get(selectionSnapshotAtom);
  const text =
    selection?.selection?.status === "captured"
      ? selectionExactText(selection.selection.location)
      : null;
  if (requestedRuntime === null || selection === null || text === null) return;
  const requestId = crypto.randomUUID();
  const selectionRevision = selection.revision;
  set(selectionActionAtom, {
    action: "copy",
    selectionRevision,
    requestId,
    status: "copying",
    error: null,
    acknowledgedRecordId: null,
  });
  try {
    await writeClipboardText(text);
    if (
      get(activeRuntimeAtom) !== requestedRuntime ||
      requestedRuntime.currentSelection().revision !== selectionRevision
    ) {
      if (get(activeRuntimeAtom) === requestedRuntime) {
        set(selectionActionAtom, (current) => (current?.requestId === requestId ? null : current));
      }
      return;
    }
    requestedRuntime.clearSelection();
    set(dismissedSelectionRevisionAtom, selectionRevision);
    set(selectionActionAtom, (current) => (current?.requestId === requestId ? null : current));
    set(returnFocusToPublicationAtom);
  } catch (cause) {
    if (get(activeRuntimeAtom) !== requestedRuntime) return;
    set(selectionActionAtom, (current) =>
      current?.requestId === requestId
        ? {
            action: "copy",
            selectionRevision,
            requestId,
            status: "failed",
            error:
              cause instanceof Error && cause.message.length > 0
                ? cause.message
                : "The selection could not be copied.",
            acknowledgedRecordId: null,
          }
        : current,
    );
  }
});

export const convertHighlightToNoteAtom = atom(
  null,
  (get, set, record: NavigatorAnnotationRecord, event: MouseEvent) => {
    if (!event.isTrusted || record.type !== "highlight") return;
    const currentProjection = get(annotationProjectionAtom);
    if (currentProjection === undefined) return;
    set(noteDraftAtom, {
      mode: "convert",
      recordId: record.id,
      targetJson: record.targetJson,
      occurrence: record.occurrence,
      basedOnRevision: currentProjection.revision,
      selectionRevision: null,
      excerpt: record.excerpt,
      sectionLabel: record.sectionLabel,
      text: "",
      status: "idle",
      error: null,
      requestId: null,
      projectionRevision: null,
    });
    set(dismissAnnotationToolbarAtom);
    if (get(readerCompactAtom)) set(openCompactAnnotationsAtom);
  },
);

export const restoreEditFocusAtom = atom(null, (get, set) => {
  const returnTarget = get(editReturnFocusAtom);
  const target =
    returnTarget?.element.isConnected === true
      ? returnTarget.element
      : [
          ...(get(readerRootElementAtom)?.querySelectorAll<HTMLElement>("[data-annotation-id]") ??
            []),
        ].find((candidate) => candidate.dataset.annotationId === returnTarget?.recordId);
  if (target !== undefined && target !== null) target.focus();
  else set(returnFocusToPublicationAtom);
});

export const cancelNoteEditorAtom = atom(null, (get, set) => {
  const store = get(readerStoreAtom);
  if (store === null) return;
  const draft = get(noteDraftAtom);
  abortOperation(store, noteMutationOperationAtom);
  set(noteDraftAtom, null);
  if (draft?.mode === "edit")
    requestAnimationFrame(() => requestAnimationFrame(() => set(restoreEditFocusAtom)));
  else {
    set(setCompactSurfaceAtom, null);
    requestAnimationFrame(() => set(returnFocusToPublicationAtom));
  }
});

export const saveNoteAtom = atom(null, async (get, set, event: Event): Promise<void> => {
  const store = get(readerStoreAtom);
  if (store === null) return;
  if (!event.isTrusted) return;
  const draft = get(noteDraftAtom);
  const currentProjection = get(annotationProjectionAtom);
  const handler = get(annotationMutationHandlerAtom)?.handle;
  if (draft === null || currentProjection === undefined || handler === undefined) return;
  const validation = noteTextError(draft.text);
  if (validation !== null) {
    set(noteDraftAtom, { ...draft, status: "failed", error: validation });
    return;
  }
  const controller = beginOperation(store, noteMutationOperationAtom);
  const requestId = crypto.randomUUID();
  const request: NavigatorAnnotationMutationRequest =
    draft.mode === "create"
      ? {
          type: "create-note",
          requestId,
          basedOnRevision: draft.basedOnRevision,
          selectionRevision: draft.selectionRevision!,
          occurrence: draft.occurrence,
          targetJson: draft.targetJson,
          excerpt: draft.excerpt,
          sectionLabel: draft.sectionLabel,
          text: draft.text,
        }
      : draft.mode === "convert"
        ? {
            type: "convert-highlight-to-note",
            requestId,
            basedOnRevision: draft.basedOnRevision,
            recordId: draft.recordId!,
            text: draft.text,
          }
        : {
            type: "update-note",
            requestId,
            basedOnRevision: draft.basedOnRevision,
            recordId: draft.recordId!,
            text: draft.text,
          };
  set(noteDraftAtom, {
    ...draft,
    status: "submitting",
    error: null,
    requestId,
    projectionRevision: null,
  });
  try {
    const acknowledgment = await handler(request, { signal: controller.signal });
    const currentDraft = get(noteDraftAtom);
    if (controller.signal.aborted || currentDraft === null || currentDraft.requestId !== requestId)
      return;
    if (acknowledgment.requestId !== requestId)
      throw new Error("The host returned an acknowledgment for a different annotation request.");
    if (acknowledgment.status === "rejected") throw new Error(acknowledgment.reason);
    if (currentDraft.mode !== "create" && acknowledgment.recordId !== currentDraft.recordId)
      throw new Error("The host acknowledged a different note record.");
    set(noteDraftAtom, {
      ...currentDraft,
      recordId: currentDraft.mode === "create" ? acknowledgment.recordId : currentDraft.recordId,
      status: "awaiting-projection",
      error: null,
      projectionRevision: acknowledgment.projectionRevision,
    });
  } catch (cause) {
    if (controller.signal.aborted) return;
    const currentDraft = get(noteDraftAtom);
    if (currentDraft === null || currentDraft.requestId !== requestId) return;
    set(noteDraftAtom, {
      ...currentDraft,
      status: "failed",
      error:
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "The note could not be saved.",
      requestId: null,
      projectionRevision: null,
      basedOnRevision: get(annotationProjectionAtom)?.revision ?? currentDraft.basedOnRevision,
    });
  } finally {
    releaseOperation(store, noteMutationOperationAtom, controller);
  }
});
