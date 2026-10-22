import type { MountedPublication } from "../../publication.js";
import type { NavigatorReaderProps } from "../public-types.js";
import { atom, useAtomValue } from "jotai";
import { hostHandlerAtoms } from "../lib/publish.js";
import { operationAtom } from "../lib/operations.js";
import type { NavigatorAnnotationProjection } from "../../annotations.js";
import type {
  AnnotationRangeAdjustment,
  NavigatorDecorationActivation,
  NavigatorRuntime,
} from "../../runtime/navigator/api.js";
import type { AnnotationRowOperation, NoteEditorDraft } from "../annotations-panel.js";

export type FootnoteReturnState =
  | { readonly activationId: number; readonly status: "available" | "returning" }
  | { readonly activationId: number; readonly status: "failed"; readonly message: string };

export type SelectionActionState =
  | {
      readonly action: "copy" | "highlight" | "note";
      readonly selectionRevision: number;
      readonly requestId: string;
      readonly status: "copying" | "generating" | "persisting";
      readonly error: null;
      readonly acknowledgedRecordId: null;
    }
  | {
      readonly action: "highlight";
      readonly selectionRevision: number;
      readonly requestId: string;
      readonly status: "awaiting-projection";
      readonly error: null;
      readonly acknowledgedRecordId: string;
      readonly projectionRevision: number;
      readonly targetJson: string;
      readonly occurrence: number;
      readonly excerpt: string | null;
      readonly sectionLabel: string | null;
    }
  | {
      readonly action: "copy" | "highlight" | "note";
      readonly selectionRevision: number;
      readonly requestId: string;
      readonly status: "failed";
      readonly error: string;
      readonly acknowledgedRecordId: null;
    };

export interface NoteDraftState extends NoteEditorDraft {
  readonly targetJson: string;
  readonly occurrence: number;
  readonly basedOnRevision: number;
  readonly selectionRevision: number | null;
  readonly requestId: string | null;
  readonly projectionRevision: number | null;
}

export type AnnotationDeleteState =
  | {
      readonly recordId: string;
      readonly requestId: string;
      readonly status: "submitting";
      readonly error: null;
      readonly projectionRevision: null;
    }
  | {
      readonly recordId: string;
      readonly requestId: string;
      readonly status: "awaiting-projection";
      readonly error: null;
      readonly projectionRevision: number;
    }
  | {
      readonly recordId: string;
      readonly requestId: string;
      readonly status: "failed";
      readonly error: string;
      readonly projectionRevision: null;
    };

export interface BookmarkCreateState {
  readonly locationRevision: number;
  readonly requestId: string;
  readonly status: "generating" | "persisting" | "awaiting-projection" | "failed";
  readonly occurrence: number | null;
  readonly targetJson: string | null;
  readonly sectionLabel: string | null;
  readonly label: string | null;
  readonly acknowledgedRecordId: string | null;
  readonly projectionRevision: number | null;
  readonly error: string | null;
}

export interface AnnotationRetargetState {
  readonly recordId: string;
  readonly adjustment: AnnotationRangeAdjustment;
  readonly status: "adjusting" | "submitting" | "awaiting-projection" | "failed";
  readonly requestId: string | null;
  readonly projectionRevision: number | null;
  readonly targetJson: string | null;
  readonly excerpt: string | null;
  readonly error: string | null;
}

export interface AnnotationState {
  readonly selectionSnapshot: ReturnType<NavigatorRuntime["currentSelection"]> | null;
  readonly selectionAction: SelectionActionState | null;
  readonly noteDraft: NoteDraftState | null;
  readonly annotationDelete: AnnotationDeleteState | null;
  readonly bookmarkCreate: BookmarkCreateState | null;
  readonly bookmarkedLocationRevision: number | null;
  readonly annotationRetarget: AnnotationRetargetState | null;
  readonly annotationActivation: AnnotationRowOperation | null;
  readonly selectedAnnotationId: string | null;
  readonly contextualAnnotation: NavigatorDecorationActivation | null;
  readonly contextualAnnotationId: string | null;
  readonly footnoteReturn: FootnoteReturnState | null;
  readonly dismissedSelectionRevision: number | null;
}

export const selectionSnapshotAtom = atom<ReturnType<NavigatorRuntime["currentSelection"]> | null>(
  null,
);
export const selectionActionAtom = atom<SelectionActionState | null>(null);
export const noteDraftAtom = atom<NoteDraftState | null>(null);
export const annotationDeleteAtom = atom<AnnotationDeleteState | null>(null);
export const bookmarkCreateAtom = atom<BookmarkCreateState | null>(null);
export const bookmarkedLocationRevisionAtom = atom<number | null>(null);
export const annotationRetargetAtom = atom<AnnotationRetargetState | null>(null);
export const annotationActivationAtom = atom<AnnotationRowOperation | null>(null);
export const selectedAnnotationIdAtom = atom<string | null>(null);
export const contextualAnnotationAtom = atom<NavigatorDecorationActivation | null>(null);
export const contextualAnnotationIdAtom = atom<string | null>(null);
export const annotationQueryAtom = atom("");
export const footnoteReturnAtom = atom<FootnoteReturnState | null>(null);
export const dismissedSelectionRevisionAtom = atom<number | null>(null);
/** Host-owned annotation projection, published so reactions can read it outside render. */
export const annotationProjectionAtom = atom<NavigatorAnnotationProjection | undefined>(undefined);
export const selectionActionOperationAtom = operationAtom();
export const noteMutationOperationAtom = operationAtom();
export const deleteMutationOperationAtom = operationAtom();
export const retargetMutationOperationAtom = operationAtom();
export const bookmarkMutationOperationAtom = operationAtom();
export const bookmarkActivationOperationAtom = operationAtom();
export const decorationRevisionAtom = atom(0);
export const contextualAnnotationSourceRevisionAtom = atom<number | null>(null);
export const annotationActivationSequenceAtom = atom(0);
export const editReturnFocusAtom = atom<{
  readonly recordId: string;
  readonly element: HTMLElement;
} | null>(null);

/** One transition, so reactions never observe a half-applied activation. */
export const activateContextualAnnotationAtom = atom(
  null,
  (
    _get,
    set,
    activation: {
      readonly activation: NavigatorDecorationActivation;
      readonly sourceRevision: number;
      readonly selectionRevision: number;
      readonly selectedId: string | null;
    },
  ) => {
    set(selectionActionAtom, null);
    set(dismissedSelectionRevisionAtom, activation.selectionRevision);
    set(contextualAnnotationAtom, activation.activation);
    set(contextualAnnotationSourceRevisionAtom, activation.sourceRevision);
    set(contextualAnnotationIdAtom, activation.selectedId);
    set(selectedAnnotationIdAtom, activation.selectedId);
  },
);

export const clearContextualAnnotationAtom = atom(null, (_get, set) => {
  set(contextualAnnotationAtom, null);
  set(contextualAnnotationIdAtom, null);
  set(contextualAnnotationSourceRevisionAtom, null);
});

/** Abandons every annotation mutation in flight, whoever is tearing the session down. */
export const abortAnnotationOperationsAtom = atom(null, (get, set) => {
  for (const slot of [
    selectionActionOperationAtom,
    noteMutationOperationAtom,
    deleteMutationOperationAtom,
    retargetMutationOperationAtom,
    bookmarkMutationOperationAtom,
    bookmarkActivationOperationAtom,
  ]) {
    get(slot)?.abort();
    set(slot, null);
  }
});

export const resetAnnotationSessionAtom = atom(null, (_get, set) => {
  set(abortAnnotationOperationsAtom);
  set(selectionSnapshotAtom, null);
  set(selectionActionAtom, null);
  set(noteDraftAtom, null);
  set(annotationDeleteAtom, null);
  set(bookmarkCreateAtom, null);
  set(bookmarkedLocationRevisionAtom, null);
  set(annotationRetargetAtom, null);
  set(annotationActivationAtom, null);
  set(footnoteReturnAtom, null);
  set(selectedAnnotationIdAtom, null);
  set(contextualAnnotationAtom, null);
  set(contextualAnnotationIdAtom, null);
  set(editReturnFocusAtom, null);
  set(dismissedSelectionRevisionAtom, null);
  set(annotationQueryAtom, "");
});

export function useAnnotationState(): AnnotationState {
  const selectionSnapshot = useAtomValue(selectionSnapshotAtom);
  const selectionAction = useAtomValue(selectionActionAtom);
  const noteDraft = useAtomValue(noteDraftAtom);
  const annotationDelete = useAtomValue(annotationDeleteAtom);
  const bookmarkCreate = useAtomValue(bookmarkCreateAtom);
  const bookmarkedLocationRevision = useAtomValue(bookmarkedLocationRevisionAtom);
  const annotationRetarget = useAtomValue(annotationRetargetAtom);
  const annotationActivation = useAtomValue(annotationActivationAtom);
  const selectedAnnotationId = useAtomValue(selectedAnnotationIdAtom);
  const contextualAnnotation = useAtomValue(contextualAnnotationAtom);
  const contextualAnnotationId = useAtomValue(contextualAnnotationIdAtom);
  const footnoteReturn = useAtomValue(footnoteReturnAtom);
  const dismissedSelectionRevision = useAtomValue(dismissedSelectionRevisionAtom);
  return {
    selectionSnapshot,
    selectionAction,
    noteDraft,
    annotationDelete,
    bookmarkCreate,
    bookmarkedLocationRevision,
    annotationRetarget,
    annotationActivation,
    selectedAnnotationId,
    contextualAnnotation,
    contextualAnnotationId,
    footnoteReturn,
    dismissedSelectionRevision,
  };
}

/** Session facts and the host's mutation callback, published so dispatch can live in the store. */
export const publicationFactsAtom = atom<MountedPublication["facts"] | null>(null);
export const annotationSectionLabelAtom = atom<string | null>(null);
export const {
  handler: annotationMutationHandlerAtom,
  publish: publishAnnotationMutationHandlerAtom,
} = hostHandlerAtoms<NonNullable<NavigatorReaderProps["onAnnotationMutation"]>>();

/**
 * Compares two projections without assuming a revision bump accompanies every record change,
 * which the host contract does not promise.
 */
export function sameAnnotationProjection(
  left: NavigatorAnnotationProjection | undefined,
  right: NavigatorAnnotationProjection | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.revision !== right.revision || left.records.length !== right.records.length)
    return false;
  return left.records.every((record, index) => record === right.records[index]);
}
