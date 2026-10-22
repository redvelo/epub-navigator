import type { AgentReadyMessage, AgentResultMessage } from "../types.js";
import { CONTENT_AGENT_PROTOCOL_VERSION } from "../types.js";
import { normalizeLayoutResult, normalizePresentationAdvanceStatus } from "./layout.js";
import {
  normalizeDocumentSelectionCaptureOutcome,
  normalizeDocumentLocationCaptureOutcome,
} from "./selection.js";
import { normalizeResolutionStatus } from "./evidence.js";
import { normalizeDecorationRecordResults } from "./decorations.js";
import {
  normalizeAnnotationTargetGenerationCandidate,
  normalizeAnnotationPointTargetGenerationCandidate,
  normalizeAnnotationRangeAdjustmentCandidate,
  normalizeAnnotationTargetResult,
} from "./annotation.js";
import { isDocumentAdapter } from "./configuration.js";
import { hasEnvelope, envelope } from "./envelope.js";
import {
  hasExactKeys,
  isNonnegativeInteger,
  isArrayOf,
  isOperation,
  isOperationId,
  isRecord,
} from "./primitives.js";
import type { MediaOverlayEntryOutcome } from "../../../generated/kernel.js";

function normalizeMediaOverlayEntryOutcome(value: unknown): MediaOverlayEntryOutcome | null {
  if (!isRecord(value)) return null;
  if (value.state === "found") {
    return hasExactKeys(value, ["state", "index"]) && isNonnegativeInteger(value.index)
      ? { state: "found", index: value.index }
      : null;
  }
  return (value.state === "none" ||
    value.state === "unavailable" ||
    value.state === "unsupported") &&
    hasExactKeys(value, ["state"])
    ? { state: value.state }
    : null;
}

export function normalizeReady(value: unknown): AgentReadyMessage | null {
  if (
    !hasEnvelope(value, "ready") ||
    value.protocolVersion !== CONTENT_AGENT_PROTOCOL_VERSION ||
    !isDocumentAdapter(value.adapter) ||
    !isArrayOf(value.supportedOperations, isOperation)
  )
    return null;
  const operations = [...value.supportedOperations];
  if (new Set(operations).size !== operations.length) return null;
  return envelope(value.session, {
    type: "ready",
    protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION,
    adapter: value.adapter,
    supportedOperations: operations,
  });
}

export function normalizeResult(value: unknown): AgentResultMessage | null {
  if (!hasEnvelope(value, "result") || !isOperationId(value.operation)) return null;
  if (value.resultType === "capture-selection") {
    const outcome = normalizeDocumentSelectionCaptureOutcome(value.outcome);
    return outcome === null
      ? null
      : envelope(value.session, {
          type: "result",
          operation: value.operation,
          resultType: "capture-selection",
          outcome,
        });
  }
  if (value.resultType === "capture-current-location") {
    const outcome = normalizeDocumentLocationCaptureOutcome(value.outcome);
    return outcome === null
      ? null
      : envelope(value.session, {
          type: "result",
          operation: value.operation,
          resultType: "capture-current-location",
          outcome,
        });
  }
  if (value.resultType === "find-media-overlay-entry") {
    const outcome = normalizeMediaOverlayEntryOutcome(value.outcome);
    return outcome === null
      ? null
      : envelope(value.session, {
          type: "result",
          operation: value.operation,
          resultType: "find-media-overlay-entry",
          outcome,
        });
  }
  if (value.resultType === "reconcile-decorations") {
    const outcomes = normalizeDecorationRecordResults(value.outcomes);
    return !isOperationId(value.projectionRevision) || outcomes === null
      ? null
      : envelope(value.session, {
          type: "result",
          operation: value.operation,
          resultType: "reconcile-decorations",
          projectionRevision: value.projectionRevision,
          outcomes,
        });
  }
  if (value.resultType === "adjust-annotation-range") {
    const candidate = normalizeAnnotationRangeAdjustmentCandidate(value.candidate);
    return candidate === null
      ? null
      : envelope(value.session, {
          type: "result",
          operation: value.operation,
          resultType: "adjust-annotation-range",
          candidate,
        });
  }
  if (value.resultType === "layout") {
    const result = normalizeLayoutResult(value.result);
    return result === null
      ? null
      : envelope(value.session, {
          type: "result",
          operation: value.operation,
          resultType: "layout",
          result,
        });
  }
  if (value.resultType === "advance-presentation") {
    const status = normalizePresentationAdvanceStatus(value.status);
    return status === null
      ? null
      : envelope(value.session, {
          type: "result",
          operation: value.operation,
          resultType: "advance-presentation",
          status,
        });
  }
  if (value.resultType === "generate-annotation-target") {
    const candidate = normalizeAnnotationTargetGenerationCandidate(value.candidate);
    return candidate === null
      ? null
      : envelope(value.session, {
          type: "result",
          operation: value.operation,
          resultType: "generate-annotation-target",
          candidate,
        });
  }
  if (value.resultType === "generate-current-location-annotation-target") {
    const candidate = normalizeAnnotationPointTargetGenerationCandidate(value.candidate);
    return candidate === null
      ? null
      : envelope(value.session, {
          type: "result",
          operation: value.operation,
          resultType: "generate-current-location-annotation-target",
          candidate,
        });
  }
  if (
    value.resultType === "resolve-annotation-target" ||
    value.resultType === "relocate-annotation-target"
  ) {
    const result = normalizeAnnotationTargetResult(value.result);
    return result === null
      ? null
      : envelope(value.session, {
          type: "result",
          operation: value.operation,
          resultType: value.resultType,
          result,
        });
  }
  if (value.resultType !== "resolve-locator" && value.resultType !== "relocate") return null;
  const status = normalizeResolutionStatus(value.status);
  return status === null
    ? null
    : envelope(value.session, {
        type: "result",
        operation: value.operation,
        resultType: value.resultType,
        status,
      });
}
