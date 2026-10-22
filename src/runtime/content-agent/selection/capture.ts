import type { AgentDocumentSelectionCaptureOutcome } from "../../agent-protocol/index.js";
import type { ContentAgentState } from "../state.js";
import {
  captureNativeSelectionInDocument,
  documentTextGeneration,
} from "../targets/resolver/text-index.js";
import type { AgentSelectionCaptureBasis } from "../../agent-protocol/index.js";
import type { SelectionGesture } from "../../../generated/kernel.js";

export function selectionCaptureBasis(state: ContentAgentState): AgentSelectionCaptureBasis {
  return {
    localContentBasis: documentTextGeneration(document),
    localGeometryBasis: state.selection.selectionGeometryBasis,
  };
}

/** The touch still holding the selection, if a long press has not yet let go of it. */
function touchSelectionGesture(state: ContentAgentState): SelectionGesture | null {
  const drag = state.selection.selectionEdgeGesture?.touchDrag ?? null;
  return drag === null ? null : drag.settled ? "settled" : "dragging";
}

export function captureSelectionOutcome(
  state: ContentAgentState,
): AgentDocumentSelectionCaptureOutcome {
  const basis = selectionCaptureBasis(state);
  if (
    state.lifecycle.documentAdapter === "fixed-svg" ||
    state.lifecycle.documentAdapter === "fixed-image"
  )
    return { status: "unsupported", basis };
  if (
    state.layout.applyingLayout ||
    state.layout.layoutInvalidationPending ||
    (state.layout.settledLayout === null && state.layout.fixedSettlement === null)
  ) {
    return { status: "unavailable", reason: "layout-unavailable", basis };
  }
  const nativeSelection = window.getSelection();
  if (nativeSelection === null) return { status: "unavailable", reason: "no-selection", basis };
  const geometryGeneration = state.selection.selectionGeometryBasis;
  // The rendered-text walk is the expensive part of a capture and the same one serves every
  // capture until the document changes, so the last one is kept and offered back.
  const capture = captureNativeSelectionInDocument(
    document,
    nativeSelection,
    {
      generation: geometryGeneration,
      isCurrent: () => state.selection.selectionGeometryBasis === geometryGeneration,
    },
    state.observation.observationTextSnapshot,
  );
  if (capture.status === "captured")
    state.observation.observationTextSnapshot = capture.textSnapshot;
  const capturedBasis = {
    localContentBasis: capture.basis.documentTextGeneration,
    localGeometryBasis: capture.basis.geometryGeneration ?? geometryGeneration,
  };
  if (capture.status === "captured") {
    return {
      status: "captured",
      evidence: capture.selection.evidence,
      observation: capture.selection.observation,
      direction: capture.selection.direction,
      language: capture.selection.language,
      anchor: {
        ...capture.selection.anchor,
        visualViewportOffset: capture.basis.visualViewportOffset,
      },
      gesture: touchSelectionGesture(state),
      basis: capturedBasis,
    };
  }
  if (capture.status === "unavailable") {
    return { status: "unavailable", reason: capture.reason, basis: capturedBasis };
  }
  if (capture.status === "failed") {
    return { status: "failed", message: capture.message, basis: capturedBasis };
  }
  return { status: capture.status, basis: capturedBasis };
}
