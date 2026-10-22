import { isPreferenceValue, isReflowableLayoutMode } from "../../preference-values.js";
import type {
  FixedIntrinsicViewport,
  FixedLayoutIssue,
  FixedLayoutOutcome,
  FixedPageGeometry,
  FixedSettlement,
  LayoutIssue,
  LayoutMeasurement,
  LayoutRequest,
  LayoutResult,
  PaginatedLayout,
  PresentationAdvanceStatus,
  ReflowPositionRequest,
  ReflowablePresentation,
  ReflowableSettlement,
  RequiredAssetSettlement,
  LayoutRepairReport,
} from "../../../generated/kernel.js";
import type { AgentLayoutInvalidatedMessage, AgentFixedViewportMessage } from "../types.js";
import { normalizeDocumentObservation, isInvalidationCause } from "./observation.js";
import { normalizePointEvidenceList } from "./evidence.js";
import { hasEnvelope, envelope } from "./envelope.js";
import {
  isRecord,
  isBoundedString,
  isOperationId,
  isFiniteNumber,
  isNonnegativeFinite,
  isPositiveFinite,
  isNonnegativeInteger,
  isPositiveInteger,
  isProgression,
} from "./primitives.js";

export function normalizeLayoutInvalidated(value: unknown): AgentLayoutInvalidatedMessage | null {
  if (!hasEnvelope(value, "layout-invalidated") || !isInvalidationCause(value.cause)) return null;
  return envelope(value.session, { type: "layout-invalidated", cause: value.cause });
}

export function normalizeLayoutResult(value: unknown): LayoutResult | null {
  if (!isRecord(value)) return null;
  if (value.adapter === "reflowable-xhtml") {
    const outcome = normalizeReflowableOutcome(value.outcome);
    return outcome === null ? null : { adapter: "reflowable-xhtml", outcome };
  }
  if (value.adapter === "fixed-xhtml") {
    const outcome = normalizeFixedOutcome(value.outcome);
    return outcome === null ? null : { adapter: "fixed-xhtml", outcome };
  }
  if (value.adapter === "fixed-svg" || value.adapter === "fixed-image") {
    const outcome = normalizeFixedOutcome(value.outcome);
    if (
      value.adapter === "fixed-image" &&
      outcome?.status === "settled" &&
      outcome.settlement.geometry.intrinsicViewport.source !== "image-natural"
    )
      return null;
    return outcome === null ? null : { adapter: value.adapter, outcome };
  }
  return null;
}

export function normalizeReflowableOutcome(
  value: unknown,
): Extract<LayoutResult, { adapter: "reflowable-xhtml" }>["outcome"] | null {
  if (!isRecord(value)) return null;
  if (value.status === "settled") {
    const settlement = normalizeReflowableSettlement(value.settlement);
    return settlement === null ? null : { status: "settled", settlement };
  }
  if (value.status !== "conflict" && value.status !== "unavailable") return null;
  return isLayoutIssue(value.issue) ? { status: value.status, issue: value.issue } : null;
}

export function normalizeFixedOutcome(value: unknown): FixedLayoutOutcome | null {
  if (!isRecord(value)) return null;
  if (value.status === "settled") {
    const settlement = normalizeFixedSettlement(value.settlement);
    return settlement === null ? null : { status: "settled", settlement };
  }
  if (value.status !== "conflict" && value.status !== "unavailable") return null;
  return isFixedLayoutIssue(value.issue) ? { status: value.status, issue: value.issue } : null;
}

export function normalizeReflowableSettlement(value: unknown): ReflowableSettlement | null {
  if (!isRecord(value)) return null;
  const measurement = normalizeLayoutMeasurement(value.measurement);
  if (measurement === null) return null;
  if (value.mode === "document-scroll") return { mode: "document-scroll", measurement };
  if (value.mode !== "paginated") return null;
  const pages = normalizePaginatedLayout(value.pages);
  return pages === null ? null : { mode: "paginated", measurement, pages };
}

export function normalizeFixedSettlement(value: unknown): FixedSettlement | null {
  if (!isRecord(value) || value.mode !== "contain") return null;
  const measurement = normalizeLayoutMeasurement(value.measurement);
  const geometry = normalizeFixedPageGeometry(value.geometry);
  return measurement === null ||
    geometry === null ||
    measurement.observation.pagination !== null ||
    Math.abs(measurement.observation.viewport.width - geometry.intrinsicViewport.width) > 1 ||
    Math.abs(measurement.observation.viewport.height - geometry.intrinsicViewport.height) > 1
    ? null
    : { mode: "contain", measurement, geometry };
}

export function normalizeFixedViewport(value: unknown): AgentFixedViewportMessage | null {
  if (!hasEnvelope(value, "fixed-viewport") || !isOperationId(value.operation)) return null;
  const intrinsicViewport = normalizeFixedIntrinsicViewport(value.intrinsicViewport);
  return intrinsicViewport === null
    ? null
    : envelope(value.session, {
        type: "fixed-viewport",
        operation: value.operation,
        intrinsicViewport,
      });
}

export function normalizeFixedIntrinsicViewport(value: unknown): FixedIntrinsicViewport | null {
  if (!isRecord(value) || !isPositiveFinite(value.width) || !isPositiveFinite(value.height)) {
    return null;
  }
  if (value.source !== undefined && value.source !== null && value.source !== "image-natural")
    return null;
  return {
    width: value.width,
    height: value.height,
    ...(value.source === "image-natural" ? { source: "image-natural" as const } : {}),
  };
}

export function normalizeFixedPageGeometry(value: unknown): FixedPageGeometry | null {
  if (!isRecord(value)) return null;
  const intrinsicViewport = normalizeFixedIntrinsicViewport(value.intrinsicViewport);
  const containingViewport = normalizeFixedIntrinsicViewport(value.containingViewport);
  if (
    intrinsicViewport === null ||
    containingViewport === null ||
    !isPositiveFinite(value.scale) ||
    !isPositiveFinite(value.renderedWidth) ||
    !isPositiveFinite(value.renderedHeight) ||
    !isNonnegativeFinite(value.offsetX) ||
    !isNonnegativeFinite(value.offsetY)
  ) {
    return null;
  }
  const expectedScale = Math.min(
    containingViewport.width / intrinsicViewport.width,
    containingViewport.height / intrinsicViewport.height,
  );
  const expectedWidth = intrinsicViewport.width * value.scale;
  const expectedHeight = intrinsicViewport.height * value.scale;
  const expectedX = (containingViewport.width - value.renderedWidth) / 2;
  const expectedY = (containingViewport.height - value.renderedHeight) / 2;
  if (
    Math.abs(value.scale - expectedScale) > Math.max(1, expectedScale) * 1e-6 ||
    Math.abs(value.renderedWidth - expectedWidth) > 1 ||
    Math.abs(value.renderedHeight - expectedHeight) > 1 ||
    Math.abs(value.offsetX - expectedX) > 1 ||
    Math.abs(value.offsetY - expectedY) > 1 ||
    value.offsetX + value.renderedWidth > containingViewport.width + 1 ||
    value.offsetY + value.renderedHeight > containingViewport.height + 1
  ) {
    return null;
  }
  return {
    intrinsicViewport,
    containingViewport,
    scale: value.scale,
    renderedWidth: value.renderedWidth,
    renderedHeight: value.renderedHeight,
    offsetX: value.offsetX,
    offsetY: value.offsetY,
  };
}

export function normalizeLayoutMeasurement(value: unknown): LayoutMeasurement | null {
  if (!isRecord(value)) return null;
  const observation = normalizeDocumentObservation(value.observation);
  const logicalViewport = normalizeLogicalSize(value.logicalViewport);
  const logicalContentExtent = normalizeLogicalSize(value.logicalContentExtent);
  const physicalMovement = value.physicalMovement;
  if (
    observation === null ||
    logicalViewport === null ||
    logicalContentExtent === null ||
    !isProgression(value.normalizedPosition) ||
    !isRecord(physicalMovement) ||
    !isRequiredAssetSettlement(value.requiredFonts) ||
    !isRequiredAssetSettlement(value.requiredResources) ||
    !isFiniteNumber(physicalMovement.x) ||
    !isFiniteNumber(physicalMovement.y)
  )
    return null;
  return {
    observation,
    logicalViewport,
    logicalContentExtent,
    normalizedPosition: value.normalizedPosition,
    physicalMovement: { x: physicalMovement.x, y: physicalMovement.y },
    requiredFonts: value.requiredFonts,
    requiredResources: value.requiredResources,
  };
}

export function isRequiredAssetSettlement(value: unknown): value is RequiredAssetSettlement {
  return value === "loaded" || value === "failed" || value === "timed-out";
}

export function normalizeLayoutRepairReport(value: unknown): LayoutRepairReport | null {
  if (!isRecord(value)) return null;
  if (value.status === "no-issues-detected") return { status: "no-issues-detected" };
  if (value.status === "repaired") {
    return isPositiveInteger(value.repairedElements)
      ? { status: "repaired", repairedElements: value.repairedElements }
      : null;
  }
  if (value.status !== "unresolved" || !isPositiveInteger(value.unresolvedElements)) return null;
  return isNonnegativeInteger(value.repairedElements)
    ? {
        status: "unresolved",
        repairedElements: value.repairedElements,
        unresolvedElements: value.unresolvedElements,
      }
    : null;
}

/** Narrows a validated layout's column count, which the kernel schema carries as a `u32`. */
export function viewColumns(columnsPerView: number): 1 | 2 {
  return columnsPerView === 2 ? 2 : 1;
}

/**
 * The last `firstVisiblePage` a view-aligned paginated layout can reach. Views start on a
 * multiple of `columnsPerView`, so a trailing partial view still begins on the aligned page.
 */
export function lastViewFirstPage(pageCount: number, columnsPerView: number): number {
  return Math.floor((pageCount - 1) / columnsPerView) * columnsPerView;
}

export function normalizePaginatedLayout(value: unknown): PaginatedLayout | null {
  if (!isRecord(value)) return null;
  const layoutRepairs = normalizeLayoutRepairReport(value.layoutRepairs);
  if (
    !isPositiveFinite(value.spreadStride) ||
    !isNonnegativeFinite(value.columnOrigin) ||
    !isPositiveFinite(value.columnWidth) ||
    !isNonnegativeFinite(value.columnGap) ||
    !isPositiveFinite(value.columnPitch) ||
    Math.abs(value.columnPitch - (value.columnWidth + value.columnGap)) > 1 ||
    !isNonnegativeInteger(value.firstVisiblePage) ||
    !isPositiveInteger(value.pageCount) ||
    !isPositiveInteger(value.visiblePageCount) ||
    (value.columnsPerView !== 1 && value.columnsPerView !== 2) ||
    Math.abs(value.spreadStride - value.columnPitch * value.columnsPerView) > 1 ||
    value.firstVisiblePage >= value.pageCount ||
    value.firstVisiblePage % value.columnsPerView !== 0 ||
    value.visiblePageCount !==
      Math.min(value.columnsPerView, value.pageCount - value.firstVisiblePage) ||
    layoutRepairs === null
  ) {
    return null;
  }
  return {
    spreadStride: value.spreadStride,
    columnOrigin: value.columnOrigin,
    columnWidth: value.columnWidth,
    columnGap: value.columnGap,
    columnPitch: value.columnPitch,
    firstVisiblePage: value.firstVisiblePage,
    pageCount: value.pageCount,
    visiblePageCount: value.visiblePageCount,
    columnsPerView: value.columnsPerView,
    layoutRepairs,
  };
}

export function normalizeLogicalSize(value: unknown): { inline: number; block: number } | null {
  return isRecord(value) && isNonnegativeFinite(value.inline) && isNonnegativeFinite(value.block)
    ? { inline: value.inline, block: value.block }
    : null;
}

export function normalizePresentationAdvanceStatus(
  value: unknown,
): PresentationAdvanceStatus | null {
  if (!isRecord(value)) return null;
  if (value.status === "advanced" || value.status === "boundary") {
    return { status: value.status };
  }
  if (
    value.status === "unavailable" &&
    (value.reason === "presentation-unavailable" || value.reason === "layout-unavailable")
  ) {
    return { status: "unavailable", reason: value.reason };
  }
  if (value.status === "failed" && isBoundedString(value.message)) {
    return { status: "failed", message: value.message };
  }
  return null;
}

export function normalizeLayoutRequest(value: unknown): LayoutRequest | null {
  if (!isRecord(value)) return null;
  if (value.adapter === "fixed-xhtml") return { adapter: "fixed-xhtml" };
  if (value.adapter === "fixed-svg") return { adapter: "fixed-svg" };
  if (value.adapter === "fixed-image") return { adapter: "fixed-image" };
  if (value.adapter !== "reflowable-xhtml") return null;
  const presentation = normalizePresentation(value.presentation);
  const position = normalizeReflowPositionRequest(value.position);
  return presentation === null || position === null
    ? null
    : { adapter: "reflowable-xhtml", presentation, position };
}

export function normalizePresentation(value: unknown): ReflowablePresentation | null {
  if (!isRecord(value)) return null;
  const {
    mode,
    paginationColumns,
    theme,
    colorScheme,
    typeface,
    fontScale,
    lineHeight,
    letterSpacing,
    wordSpacing,
    paragraphSpacing,
    textIndent,
    measure,
    alignment,
    hyphenation,
    rootScrollbar,
    alignXCenter,
  } = value;
  // Permitted values come from the shared preference lists, which the compiler checks against
  // the generated kernel unions, so this codec cannot fall behind a new variant.
  if (
    !isReflowableLayoutMode(mode) ||
    !isPreferenceValue("paginationColumns", paginationColumns) ||
    !isPreferenceValue("publicationTheme", theme) ||
    (colorScheme !== "light" && colorScheme !== "dark") ||
    !isPreferenceValue("publicationTypeface", typeface) ||
    !isPreferenceValue("fontScale", fontScale) ||
    !isPreferenceValue("lineHeight", lineHeight) ||
    !isPreferenceValue("letterSpacing", letterSpacing) ||
    !isPreferenceValue("wordSpacing", wordSpacing) ||
    !isPreferenceValue("paragraphSpacing", paragraphSpacing) ||
    !isPreferenceValue("textIndent", textIndent) ||
    !isPreferenceValue("measure", measure) ||
    !isPreferenceValue("alignment", alignment) ||
    !isPreferenceValue("hyphenation", hyphenation) ||
    (rootScrollbar !== "publisher" && rootScrollbar !== "hidden") ||
    typeof alignXCenter !== "boolean"
  )
    return null;
  return {
    mode,
    paginationColumns,
    theme,
    colorScheme,
    typeface,
    fontScale,
    lineHeight,
    letterSpacing,
    wordSpacing,
    paragraphSpacing,
    textIndent,
    measure,
    alignment,
    hyphenation,
    rootScrollbar,
    alignXCenter,
  };
}

export function normalizeReflowPositionRequest(value: unknown): ReflowPositionRequest | null {
  if (!isRecord(value)) return null;
  if (value.kind === "unavailable") return { kind: "unavailable" };
  if (value.kind === "entry") {
    return value.entry === "start" || value.entry === "end"
      ? { kind: "entry", entry: value.entry }
      : null;
  }
  if (value.kind === "progression")
    return isProgression(value.normalizedProgression)
      ? { kind: "progression", normalizedProgression: value.normalizedProgression }
      : null;
  if (value.kind !== "exact") return null;
  const evidence = normalizePointEvidenceList(value.evidence);
  return evidence === null || !isProgression(value.fallbackProgression)
    ? null
    : { kind: "exact", evidence, fallbackProgression: value.fallbackProgression };
}

export function isLayoutIssue(value: unknown): value is LayoutIssue {
  return (
    value === "publication-continuous-unavailable" ||
    value === "authored-presentation-ambiguous" ||
    value === "authored-presentation-unsupported" ||
    value === "incompatible-publisher-css" ||
    value === "agent-style-unavailable" ||
    value === "reader-font-unavailable" ||
    value === "anchor-reconciliation-failed"
  );
}

export function isFixedLayoutIssue(value: unknown): value is FixedLayoutIssue {
  return (
    value === "intrinsic-viewport-missing" ||
    value === "intrinsic-viewport-ambiguous" ||
    value === "intrinsic-viewport-invalid" ||
    value === "intrinsic-viewport-unsupported" ||
    value === "final-viewport-unavailable" ||
    value === "agent-style-unavailable" ||
    value === "image-load-failed"
  );
}
