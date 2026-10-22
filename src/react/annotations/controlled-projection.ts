import { atom, useAtomValue } from "jotai";
import { atomEffect } from "jotai-effect";
import { activePublicationFrame } from "../input/focus.js";
import { effectiveCompactSurfaceAtom, setCompactSurfaceAtom } from "../compact/state.js";
import { fixedViewAtom } from "../fixed-layout/state.js";
import { effectiveWorkspaceSurfaceAtom, setWorkspaceSurfaceAtom } from "../workspace/state.js";
import {
  activeRuntimeAtom,
  frameHostElementAtom,
  readerRootElementAtom,
} from "../runtime/projection-state.js";
import {
  annotationDeleteAtom,
  annotationProjectionAtom,
  annotationRetargetAtom,
  bookmarkCreateAtom,
  bookmarkedLocationRevisionAtom,
  contextualAnnotationAtom,
  contextualAnnotationIdAtom,
  contextualAnnotationSourceRevisionAtom,
  dismissedSelectionRevisionAtom,
  editReturnFocusAtom,
  noteDraftAtom,
  selectedAnnotationIdAtom,
  selectionActionAtom,
} from "./state.js";

/**
 * Reconciles optimistic annotation state against the host's controlled projection.
 *
 * These run as store effects rather than component effects: the invariants they maintain
 * belong to the reader session, not to any mounted component.
 */

const contextualActivationEffect = atomEffect((get, set) => {
  const annotations = get(annotationProjectionAtom);
  const contextualAnnotation = get(contextualAnnotationAtom);
  const contextualAnnotationId = get(contextualAnnotationIdAtom);
  const annotationRetarget = get(annotationRetargetAtom);
  if (
    contextualAnnotation === null ||
    annotations?.revision === get.peek(contextualAnnotationSourceRevisionAtom) ||
    (annotationRetarget !== null &&
      annotationRetarget.status !== "failed" &&
      annotationRetarget.recordId === contextualAnnotationId)
  ) {
    return;
  }
  set(contextualAnnotationAtom, null);
  set(contextualAnnotationIdAtom, null);
  set(contextualAnnotationSourceRevisionAtom, null);
});

const selectionActionEffect = atomEffect((get, set) => {
  const annotations = get(annotationProjectionAtom);
  const selectionAction = get(selectionActionAtom);
  if (
    selectionAction?.status !== "awaiting-projection" ||
    annotations === undefined ||
    annotations.revision < selectionAction.projectionRevision
  ) {
    return;
  }
  const recordPresent = annotations.records.some(
    (record) =>
      record.id === selectionAction.acknowledgedRecordId &&
      record.type === "highlight" &&
      record.targetJson === selectionAction.targetJson &&
      record.occurrence === selectionAction.occurrence &&
      record.excerpt === selectionAction.excerpt &&
      record.sectionLabel === selectionAction.sectionLabel,
  );
  if (!recordPresent) {
    set(selectionActionAtom, {
      action: "highlight",
      selectionRevision: selectionAction.selectionRevision,
      requestId: selectionAction.requestId,
      status: "failed",
      error: "The host accepted the highlight but did not return its controlled record.",
      acknowledgedRecordId: null,
    });
    return;
  }
  set(dismissedSelectionRevisionAtom, selectionAction.selectionRevision);
  set(selectionActionAtom, null);
  get.peek(activeRuntimeAtom)?.clearSelection();
  activePublicationFrame(get.peek(frameHostElementAtom))?.focus({ preventScroll: true });
});

const bookmarkCreateEffect = atomEffect((get, set) => {
  const annotations = get(annotationProjectionAtom);
  const bookmarkCreate = get(bookmarkCreateAtom);
  if (
    bookmarkCreate?.status !== "awaiting-projection" ||
    bookmarkCreate.projectionRevision === null ||
    bookmarkCreate.acknowledgedRecordId === null ||
    bookmarkCreate.occurrence === null ||
    bookmarkCreate.targetJson === null ||
    annotations === undefined ||
    annotations.revision < bookmarkCreate.projectionRevision
  ) {
    return;
  }
  const present = annotations.records.some(
    (record) =>
      record.type === "bookmark" &&
      record.id === bookmarkCreate.acknowledgedRecordId &&
      record.targetJson === bookmarkCreate.targetJson &&
      record.occurrence === bookmarkCreate.occurrence &&
      record.sectionLabel === bookmarkCreate.sectionLabel &&
      record.label === bookmarkCreate.label,
  );
  if (!present) {
    set(bookmarkCreateAtom, {
      ...bookmarkCreate,
      status: "failed",
      projectionRevision: null,
      acknowledgedRecordId: null,
      error: "The host accepted the bookmark but did not return its controlled record.",
    });
    return;
  }
  set(bookmarkedLocationRevisionAtom, bookmarkCreate.locationRevision);
  set(bookmarkCreateAtom, null);
});

function restoreEditFocus(
  root: HTMLElement | null,
  frameHost: HTMLElement | null,
  recordId: string | undefined,
): void {
  const annotated = [...(root?.querySelectorAll<HTMLElement>("[data-annotation-id]") ?? [])];
  const target = annotated.find((candidate) => candidate.dataset.annotationId === recordId);
  if (target !== undefined) target.focus();
  else activePublicationFrame(frameHost)?.focus({ preventScroll: true });
}

const noteDraftEffect = atomEffect((get, set) => {
  const annotations = get(annotationProjectionAtom);
  const noteDraft = get(noteDraftAtom);
  if (
    noteDraft?.status !== "awaiting-projection" ||
    noteDraft.requestId === null ||
    noteDraft.projectionRevision === null ||
    annotations === undefined ||
    annotations.revision < noteDraft.projectionRevision
  ) {
    return;
  }
  const record = annotations.records.find(
    (candidate) =>
      candidate.id === noteDraft.recordId &&
      candidate.type === "note" &&
      candidate.targetJson === noteDraft.targetJson &&
      candidate.occurrence === noteDraft.occurrence &&
      candidate.text === noteDraft.text &&
      (noteDraft.mode === "edit" ||
        (candidate.excerpt === noteDraft.excerpt &&
          candidate.sectionLabel === noteDraft.sectionLabel)),
  );
  if (record === undefined) {
    set(noteDraftAtom, {
      ...noteDraft,
      status: "failed",
      error:
        "The host accepted the note mutation but did not return the expected controlled record.",
      requestId: null,
      projectionRevision: null,
    });
    return;
  }
  const mode = noteDraft.mode;
  const frameHost = get.peek(frameHostElementAtom);
  set(noteDraftAtom, null);
  set(selectedAnnotationIdAtom, record.id);
  if (mode === "create" || mode === "convert") {
    set(setCompactSurfaceAtom, null);
    requestAnimationFrame(() => activePublicationFrame(frameHost)?.focus({ preventScroll: true }));
    return;
  }
  const root = get.peek(readerRootElementAtom);
  const returnTarget = get.peek(editReturnFocusAtom);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const element = returnTarget?.element;
      if (element?.isConnected === true) element.focus();
      else restoreEditFocus(root, frameHost, returnTarget?.recordId);
    }),
  );
});

const annotationDeleteEffect = atomEffect((get, set) => {
  const annotations = get(annotationProjectionAtom);
  const annotationDelete = get(annotationDeleteAtom);
  if (
    annotationDelete?.status !== "awaiting-projection" ||
    annotations === undefined ||
    annotations.revision < annotationDelete.projectionRevision
  ) {
    return;
  }
  if (annotations.records.some((record) => record.id === annotationDelete.recordId)) {
    set(annotationDeleteAtom, {
      recordId: annotationDelete.recordId,
      requestId: annotationDelete.requestId,
      status: "failed",
      error: "The host accepted deletion but retained the controlled annotation.",
      projectionRevision: null,
    });
    return;
  }
  if (get.peek(selectedAnnotationIdAtom) === annotationDelete.recordId) {
    set(selectedAnnotationIdAtom, null);
  }
  set(annotationDeleteAtom, null);
});

const annotationRetargetEffect = atomEffect((get, set) => {
  const annotations = get(annotationProjectionAtom);
  const annotationRetarget = get(annotationRetargetAtom);
  if (
    annotationRetarget?.status !== "awaiting-projection" ||
    annotationRetarget.projectionRevision === null ||
    annotationRetarget.targetJson === null ||
    annotationRetarget.excerpt === null ||
    annotations === undefined ||
    annotations.revision < annotationRetarget.projectionRevision
  ) {
    return;
  }
  const record = annotations.records.find(({ id }) => id === annotationRetarget.recordId);
  if (
    record?.type === "bookmark" ||
    record?.targetJson !== annotationRetarget.targetJson ||
    record.excerpt !== annotationRetarget.excerpt
  ) {
    set(annotationRetargetAtom, {
      ...annotationRetarget,
      status: "failed",
      requestId: null,
      projectionRevision: null,
      error: "The host accepted the range adjustment but did not return the expected target.",
    });
    return;
  }
  set(annotationRetargetAtom, null);
  set(contextualAnnotationSourceRevisionAtom, annotations.revision);
  set(contextualAnnotationIdAtom, record.id);
  set(selectedAnnotationIdAtom, record.id);
});

const failedNoteRebaseEffect = atomEffect((get, set) => {
  const annotations = get(annotationProjectionAtom);
  const noteDraft = get(noteDraftAtom);
  if (
    noteDraft?.status !== "failed" ||
    annotations === undefined ||
    annotations.revision <= noteDraft.basedOnRevision
  ) {
    return;
  }
  set(noteDraftAtom, { ...noteDraft, basedOnRevision: annotations.revision });
});

const zoomSurfaceEffect = atomEffect((get, set) => {
  if (get(fixedViewAtom) !== null) return;
  if (get(effectiveCompactSurfaceAtom) === "zoom") set(setCompactSurfaceAtom, null);
  if (get(effectiveWorkspaceSurfaceAtom) === "zoom") set(setWorkspaceSurfaceAtom, null);
});

const controlledAnnotationProjectionEffects = atom((get) => {
  get(contextualActivationEffect);
  get(selectionActionEffect);
  get(bookmarkCreateEffect);
  get(noteDraftEffect);
  get(annotationDeleteEffect);
  get(annotationRetargetEffect);
  get(failedNoteRebaseEffect);
  get(zoomSurfaceEffect);
});

export function useControlledAnnotationProjection(): void {
  useAtomValue(controlledAnnotationProjectionEffects);
}
