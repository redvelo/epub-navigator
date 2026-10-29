import type {
  DocumentObservation,
  LayoutInvalidationCause,
  LocatorObservation,
  ObservedBoundary,
} from "../../../generated/kernel.js";
import type { AgentObservationMessage } from "../types.js";
import { MAX_LANGUAGE_STRING } from "../limits.js";
import { normalizePointEvidenceList } from "./evidence.js";
import { hasEnvelope, envelope } from "./envelope.js";
import {
  isRecord,
  isNonnegativeFinite,
  isNonnegativeInteger,
  isPositiveInteger,
  isProgression,
} from "./primitives.js";

export function normalizeObservation(value: unknown): AgentObservationMessage | null {
  if (!hasEnvelope(value, "observation")) return null;
  const observation = normalizeDocumentObservation(value);
  return observation === null
    ? null
    : envelope(value.session, { type: "observation", ...observation });
}

export function normalizeDocumentObservation(value: unknown): DocumentObservation | null {
  if (!isRecord(value)) return null;
  const { writingMode, direction, language, viewport } = value;
  const canvas = normalizeDocumentCanvas(value.canvas);
  const visibleStart = normalizeObservedBoundary(value.visibleStart);
  const visibleEnd = normalizeObservedBoundary(value.visibleEnd);
  const progression = value.renderedTextProgression;
  const layoutProgression = value.layoutProgression;
  const pagination = normalizePaginationObservation(value.pagination);
  if (
    (writingMode !== "horizontal-tb" &&
      writingMode !== "vertical-rl" &&
      writingMode !== "vertical-lr") ||
    (direction !== "ltr" && direction !== "rtl") ||
    (language !== null &&
      (typeof language !== "string" || language.length > MAX_LANGUAGE_STRING)) ||
    !isRecord(viewport) ||
    !isNonnegativeFinite(viewport.width) ||
    !isNonnegativeFinite(viewport.height) ||
    canvas === null ||
    visibleStart === null ||
    visibleEnd === null ||
    pagination === undefined ||
    (progression !== null && !isProgression(progression)) ||
    (layoutProgression !== null && !isProgression(layoutProgression))
  )
    return null;
  return {
    writingMode,
    direction,
    language,
    viewport: { width: viewport.width, height: viewport.height },
    canvas,
    visibleStart,
    visibleEnd,
    renderedTextProgression: progression,
    layoutProgression,
    pagination,
  };
}

export function normalizePaginationObservation(
  value: unknown,
): DocumentObservation["pagination"] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isNonnegativeInteger(value.firstVisiblePage) ||
    !isPositiveInteger(value.pageCount) ||
    !isPositiveInteger(value.visiblePageCount) ||
    value.firstVisiblePage >= value.pageCount ||
    value.firstVisiblePage + value.visiblePageCount > value.pageCount
  ) {
    return undefined;
  }
  return {
    firstVisiblePage: value.firstVisiblePage,
    pageCount: value.pageCount,
    visiblePageCount: value.visiblePageCount,
  };
}

export function normalizeDocumentCanvas(value: unknown): DocumentObservation["canvas"] | null {
  if (!isRecord(value)) return null;
  if (value.state === "unavailable") return { state: "unavailable" };
  if (
    value.state !== "solid-color" ||
    typeof value.cssColor !== "string" ||
    value.cssColor.length === 0 ||
    value.cssColor.length > 256
  ) {
    return null;
  }
  return { state: "solid-color", cssColor: value.cssColor };
}

export function normalizeObservedBoundary(value: unknown): ObservedBoundary | null {
  if (!isRecord(value)) return null;
  if (value.state === "unavailable") return { state: "unavailable" };
  if (value.state !== "located") return null;
  const evidence = normalizePointEvidenceList(value.evidence);
  return evidence === null ? null : { state: "located", evidence };
}

export function normalizeLocatorObservation(value: unknown): LocatorObservation | null {
  if (!isRecord(value)) return null;
  const { layoutProgression, renderedTextProgression } = value;
  return (layoutProgression === null || isProgression(layoutProgression)) &&
    (renderedTextProgression === null || isProgression(renderedTextProgression))
    ? { layoutProgression, renderedTextProgression }
    : null;
}

export function isInvalidationCause(value: unknown): value is LayoutInvalidationCause {
  return (
    value === "viewport" ||
    value === "fonts" ||
    value === "dom" ||
    value === "attributes" ||
    value === "style-element" ||
    value === "stylesheet-link" ||
    value === "writing-mode" ||
    value === "preferences" ||
    value === "agent-style"
  );
}
