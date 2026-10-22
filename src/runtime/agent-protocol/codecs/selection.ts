import type {
  NativeSelectionCaptureReason,
  NativeSelectionDirection,
  PointEvidence,
  RangeEvidence,
  SelectionGesture,
} from "../../../generated/kernel.js";
import type {
  AgentSelectionCaptureBasis,
  AgentVisualViewportRect,
  AgentVisualViewportAnchor,
  AgentDocumentSelectionCaptureOutcome,
  AgentDocumentLocationCaptureOutcome,
} from "../types.js";
import { MAX_EVIDENCE_ITEMS, MAX_CAPTURE_AGGREGATE_STRING_BYTES } from "../limits.js";
import { normalizeLocatorObservation } from "./observation.js";
import {
  isBoundedUtf8String,
  isCanonicalBrowserTextOffset,
  utf8ByteLength,
  isRecord,
  isOperationId,
  isFiniteNumber,
  isNonnegativeFinite,
} from "./primitives.js";
import { normalizePointEvidenceList } from "./evidence.js";

export function normalizeDocumentSelectionCaptureOutcome(
  value: unknown,
): AgentDocumentSelectionCaptureOutcome | null {
  if (!isRecord(value)) return null;
  const basis = normalizeSelectionCaptureBasis(value.basis);
  if (basis === null) return null;
  if (
    value.status === "collapsed" ||
    value.status === "unsupported" ||
    value.status === "ambiguous" ||
    value.status === "conflict" ||
    value.status === "stale"
  ) {
    return { status: value.status, basis };
  }
  if (value.status === "unavailable") {
    return isNativeSelectionCaptureReason(value.reason)
      ? { status: "unavailable", reason: value.reason, basis }
      : null;
  }
  if (value.status === "failed") {
    return value.message === null || isBoundedUtf8String(value.message)
      ? { status: "failed", message: value.message, basis }
      : null;
  }
  if (value.status !== "captured") return null;
  const counter = { items: 0, stringBytes: 0 };
  const evidence = normalizeCaptureRangeEvidence(value.evidence, counter);
  const observation = normalizeLocatorObservation(value.observation);
  const anchor = normalizeVisualViewportAnchor(value.anchor);
  if (
    evidence === null ||
    observation === null ||
    anchor === null ||
    !isNativeSelectionDirection(value.direction) ||
    (value.language !== null && (value.language === "" || !isBoundedUtf8String(value.language))) ||
    (value.gesture !== null && !isSelectionGesture(value.gesture))
  ) {
    return null;
  }
  return {
    status: "captured",
    evidence,
    observation,
    direction: value.direction,
    language: value.language,
    anchor,
    gesture: value.gesture,
    basis,
  };
}

export function normalizeDocumentLocationCaptureOutcome(
  value: unknown,
): AgentDocumentLocationCaptureOutcome | null {
  if (!isRecord(value)) return null;
  const basis = normalizeSelectionCaptureBasis(value.basis);
  if (basis === null) return null;
  if (value.status === "unavailable" || value.status === "stale") {
    return { status: value.status, basis };
  }
  if (value.status === "failed") {
    return value.message === null || isBoundedUtf8String(value.message)
      ? { status: "failed", message: value.message, basis }
      : null;
  }
  if (value.status !== "captured") return null;
  const evidence = normalizePointEvidenceList(value.evidence);
  const observation = normalizeLocatorObservation(value.observation);
  return evidence === null || evidence.length === 0 || observation === null
    ? null
    : { status: "captured", evidence, observation, basis };
}

export function normalizeSelectionCaptureBasis(value: unknown): AgentSelectionCaptureBasis | null {
  return isRecord(value) &&
    isOperationId(value.localContentBasis) &&
    isOperationId(value.localGeometryBasis)
    ? {
        localContentBasis: value.localContentBasis,
        localGeometryBasis: value.localGeometryBasis,
      }
    : null;
}

export function normalizeVisualViewportAnchor(value: unknown): AgentVisualViewportAnchor | null {
  if (!isRecord(value)) return null;
  const rect = normalizeVisualViewportRect(value.rect);
  const clippingRect = normalizeVisualViewportRect(value.clippingRect);
  const offset = value.visualViewportOffset;
  return rect !== null &&
    clippingRect !== null &&
    isRecord(offset) &&
    isFiniteNumber(offset.x) &&
    isFiniteNumber(offset.y)
    ? {
        rect,
        clippingRect,
        visualViewportOffset: { x: offset.x, y: offset.y },
      }
    : null;
}

export function normalizeVisualViewportRect(value: unknown): AgentVisualViewportRect | null {
  return isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isNonnegativeFinite(value.width) &&
    isNonnegativeFinite(value.height)
    ? { x: value.x, y: value.y, width: value.width, height: value.height }
    : null;
}

export function normalizeCaptureRangeEvidence(
  value: unknown,
  counter: { items: number; stringBytes: number },
): RangeEvidence[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const evidence: RangeEvidence[] = [];
  for (const item of value) {
    if (!addCaptureEvidenceItem(counter) || !isRecord(item)) return null;
    if (
      item.kind === "rendered-text-quote" &&
      addCaptureString(counter, item.exact) &&
      item.exact.length > 0 &&
      addCaptureString(counter, item.prefix) &&
      addCaptureString(counter, item.suffix)
    ) {
      evidence.push({
        kind: "rendered-text-quote",
        exact: item.exact,
        prefix: item.prefix,
        suffix: item.suffix,
      });
      continue;
    }
    if (
      item.kind === "browser-text-position" &&
      addCaptureString(counter, item.start) &&
      addCaptureString(counter, item.end) &&
      isCanonicalBrowserTextOffset(item.start) &&
      isCanonicalBrowserTextOffset(item.end) &&
      BigInt(item.start) < BigInt(item.end)
    ) {
      evidence.push({ kind: "browser-text-position", start: item.start, end: item.end });
      continue;
    }
    if (item.kind !== "boundaries") return null;
    const start = normalizeCapturePointEvidence(item.start, counter);
    const end = normalizeCapturePointEvidence(item.end, counter);
    if (start === null || end === null) return null;
    evidence.push({ kind: "boundaries", start, end });
  }
  return evidence;
}

export function normalizeCapturePointEvidence(
  value: unknown,
  counter: { items: number; stringBytes: number },
): PointEvidence[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const evidence: PointEvidence[] = [];
  for (const item of value) {
    if (!addCaptureEvidenceItem(counter) || !isRecord(item)) return null;
    if (
      item.kind === "html-fragment" &&
      addCaptureString(counter, item.value) &&
      item.value.length > 0
    )
      evidence.push({ kind: "html-fragment", value: item.value });
    else if (
      item.kind === "rendered-text-context" &&
      addCaptureString(counter, item.before) &&
      addCaptureString(counter, item.after) &&
      (item.before.length > 0 || item.after.length > 0)
    )
      evidence.push({ kind: "rendered-text-context", before: item.before, after: item.after });
    else if (
      item.kind === "browser-text-position" &&
      addCaptureString(counter, item.offset) &&
      isCanonicalBrowserTextOffset(item.offset)
    )
      evidence.push({ kind: "browser-text-position", offset: item.offset });
    else if (
      item.kind === "document-boundary" &&
      (item.boundary === "start" || item.boundary === "end")
    )
      evidence.push({ kind: "document-boundary", boundary: item.boundary });
    else return null;
  }
  return evidence;
}

export function addCaptureEvidenceItem(counter: { items: number }): boolean {
  counter.items += 1;
  return counter.items <= MAX_EVIDENCE_ITEMS;
}

export function addCaptureString(
  counter: { stringBytes: number },
  value: unknown,
): value is string {
  if (!isBoundedUtf8String(value)) return false;
  counter.stringBytes += utf8ByteLength(value);
  return counter.stringBytes <= MAX_CAPTURE_AGGREGATE_STRING_BYTES;
}

export function isNativeSelectionDirection(value: unknown): value is NativeSelectionDirection {
  return value === "forward" || value === "backward" || value === "directionless";
}

export function isSelectionGesture(value: unknown): value is SelectionGesture {
  return value === "settled" || value === "dragging";
}

export function isNativeSelectionCaptureReason(
  value: unknown,
): value is NativeSelectionCaptureReason {
  return (
    value === "no-selection" ||
    value === "document-inactive" ||
    value === "layout-unavailable" ||
    value === "geometry-unavailable"
  );
}
