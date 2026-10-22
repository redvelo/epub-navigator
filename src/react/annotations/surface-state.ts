import { useAnnotationState } from "./state.js";
import { selectionExactText, selectionToolbarRects } from "./helpers.js";
import type {
  NavigatorAnnotationProjection,
  NavigatorAnnotationRecord,
} from "../../annotations.js";
import type { NavigatorLocationSnapshot } from "../../generated/kernel.js";
import type { NavigatorReaderProps } from "../public-types.js";

export interface AnnotationBookmarkState {
  readonly bookmarkAvailable: boolean;
  readonly bookmarkBusy: boolean;
}

export function useAnnotationSurfaceState({
  annotations,
  onAnnotationMutation,
  locationSnapshot,
}: {
  readonly annotations: NavigatorAnnotationProjection | undefined;
  readonly onAnnotationMutation: NavigatorReaderProps["onAnnotationMutation"];
  readonly locationSnapshot: NavigatorLocationSnapshot | null;
}): AnnotationBookmarkState {
  const { bookmarkCreate } = useAnnotationState();
  return {
    bookmarkAvailable:
      annotations !== undefined &&
      onAnnotationMutation !== undefined &&
      locationSnapshot?.location?.kind === "point" &&
      locationSnapshot.basis !== null,
    bookmarkBusy: bookmarkCreate !== null && bookmarkCreate.status !== "failed",
  };
}

const NO_RECORDS: readonly DecoratedAnnotationRecord[] = [];

type DecoratedAnnotationRecord = Exclude<NavigatorAnnotationRecord, { readonly type: "bookmark" }>;

export interface AnnotationOverlayAnchors {
  readonly selectionCopyAvailable: boolean;
  readonly selectionAnchor: ReturnType<typeof selectionToolbarRects>;
  readonly selectionPlacement: "above" | "below" | undefined;
  readonly selectionVisible: boolean;
  readonly contextualRecords: readonly DecoratedAnnotationRecord[];
  readonly contextualAnchor: ReturnType<typeof selectionToolbarRects>;
  readonly contextualOperation: ReturnType<typeof useAnnotationState>["annotationDelete"];
  readonly contextualRetargetOperation: ReturnType<typeof useAnnotationState>["annotationRetarget"];
}

export function useAnnotationOverlayAnchors({
  frameHostElement,
  annotations,
  selectionMenuEnabled,
  selectionMenuAvailable,
}: {
  readonly frameHostElement: HTMLElement | null;
  readonly annotations: NavigatorAnnotationProjection | undefined;
  readonly selectionMenuEnabled: boolean;
  readonly selectionMenuAvailable: boolean;
}): AnnotationOverlayAnchors {
  const {
    selectionSnapshot,
    dismissedSelectionRevision,
    annotationDelete,
    annotationRetarget,
    contextualAnnotation,
    contextualAnnotationId,
  } = useAnnotationState();
  const capturedSelection =
    selectionSnapshot?.selection?.status === "captured" ? selectionSnapshot.selection : null;
  const selectionCopyAvailable =
    capturedSelection !== null && selectionExactText(capturedSelection.location) !== null;
  const selectionAnchor =
    capturedSelection === null
      ? null
      : selectionToolbarRects(capturedSelection.anchor, frameHostElement);
  return {
    selectionCopyAvailable,
    selectionAnchor,
    // A finger resting on the selection covers everything below it; a finger still dragging
    // would outrun anything drawn against the selection.
    selectionPlacement:
      capturedSelection?.gesture != null
        ? "above"
        : capturedSelection?.direction === "forward"
          ? "below"
          : capturedSelection?.direction === "backward"
            ? "above"
            : undefined,
    selectionVisible:
      selectionAnchor !== null &&
      capturedSelection?.gesture !== "dragging" &&
      selectionSnapshot !== null &&
      selectionSnapshot.revision !== dismissedSelectionRevision &&
      selectionMenuEnabled &&
      (selectionCopyAvailable || selectionMenuAvailable),
    contextualRecords:
      contextualAnnotation === null || annotations === undefined
        ? NO_RECORDS
        : contextualAnnotation.ids.flatMap((id) => {
            const record = annotations.records.find((candidate) => candidate.id === id);
            return record === undefined || record.type === "bookmark" ? [] : [record];
          }),
    contextualAnchor:
      contextualAnnotation === null
        ? null
        : selectionToolbarRects(contextualAnnotation.anchor, frameHostElement),
    contextualOperation:
      contextualAnnotationId === null || annotationDelete?.recordId !== contextualAnnotationId
        ? null
        : annotationDelete,
    contextualRetargetOperation:
      contextualAnnotationId === null || annotationRetarget?.recordId !== contextualAnnotationId
        ? null
        : annotationRetarget,
  };
}
