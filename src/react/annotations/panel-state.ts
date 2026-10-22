import { atom } from "jotai";
import { selectAtom } from "jotai/utils";
import { runtimeViewAtom } from "../runtime/projection-state.js";
import {
  annotationActivationAtom,
  annotationDeleteAtom,
  annotationProjectionAtom,
} from "./state.js";
import type { AnnotationRowOperation } from "../annotations-panel.js";
import type { DecorationRecordPosition } from "../../generated/kernel.js";

const NO_POSITIONS: readonly DecorationRecordPosition[] = [];

function samePositions(
  left: readonly DecorationRecordPosition[],
  right: readonly DecorationRecordPosition[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const next = right[index];
      return (
        next !== undefined &&
        entry.id === next.id &&
        entry.occurrence === next.occurrence &&
        entry.documentTextStart === next.documentTextStart
      );
    })
  );
}

/** The kernel republishes an equal positions array on every snapshot; compare it once here. */
export const annotationPositionsAtom = selectAtom(
  runtimeViewAtom,
  (view) => view?.snapshot.decorations.recordPositions ?? NO_POSITIONS,
  samePositions,
);

export const annotationRowOperationAtom = atom<AnnotationRowOperation | null>((get) => {
  const deletion = get(annotationDeleteAtom);
  if (deletion === null) return get(annotationActivationAtom);
  return deletion.status === "submitting" || deletion.status === "awaiting-projection"
    ? { recordId: deletion.recordId, type: "deleting" }
    : { recordId: deletion.recordId, type: "failed", message: deletion.error };
});

export const failedAnnotationDeleteRecordAtom = atom((get) => {
  const deletion = get(annotationDeleteAtom);
  if (deletion?.status !== "failed") return undefined;
  return get(annotationProjectionAtom)?.records.find((record) => record.id === deletion.recordId);
});
