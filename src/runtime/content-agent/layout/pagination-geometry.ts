import type { AgentWork } from "../operation-queue.js";
import type { ContentAgentState } from "../state.js";
import type { DocumentFlow, DocumentWritingMode } from "./document-scroll.js";
import type { DocumentObservationViewport } from "../targets/resolver/observation.js";
import type { ReflowPositionRequest, ReflowablePresentation } from "../../../generated/kernel.js";
import type { BodyInsets } from "../state.js";
import { CONTENT_AGENT_NAMESPACE, lastViewFirstPage } from "../../agent-protocol/index.js";
import {
  captureSettlementVersion,
  layoutSnapshotIsCurrent,
  yieldLayoutWork,
} from "./reflow-transaction.js";
import { cooperativeLayoutMinimumWorkUnits, cooperativeLayoutSliceMs } from "./constants.js";
import {
  documentFlow,
  logicalBlockMetrics,
  paginatedMetrics,
  paginatedRectangleOffset,
  scrollByLogicalBlock,
  scrollToDocumentBoundary,
  scrollToPaginatedPosition,
} from "./document-scroll.js";
import {
  relocateLocatorInDocument,
  resolvePointEvidenceInDocument,
} from "../targets/resolver/locator.js";
import { observeDocumentWithRanges } from "../targets/resolver/observation.js";
import { documentTextSnapshotIsCurrent } from "../targets/resolver/text-index.js";
import { post } from "../transport.js";
import type { DocumentLocatorObservation } from "../targets/resolver/types.js";

export function paginationGeometry(
  state: ContentAgentState,
  writingMode: DocumentWritingMode,
  insets: BodyInsets,
  preference: ReflowablePresentation["paginationColumns"],
): {
  gap: number;
  flowInlineSize: number;
  flowBlockSize: number;
  inlineStart: number;
  inlineEnd: number;
  blockStart: number;
  blockEnd: number;
  columnBlockSize: number;
  columnsPerView: 1 | 2;
} {
  void state;
  const horizontal = writingMode === "horizontal-tb";
  const inlineViewport = horizontal ? window.innerWidth : window.innerHeight;
  const blockViewport = horizontal ? window.innerHeight : window.innerWidth;
  if (document.body === null) {
    const gap = Math.min(32, Math.max(16, inlineViewport * 0.04));
    const columnsPerView = effectiveColumns(state, preference, inlineViewport, gap);
    return {
      gap,
      flowInlineSize: inlineViewport,
      flowBlockSize: blockViewport,
      inlineStart: 0,
      inlineEnd: 0,
      blockStart: 0,
      blockEnd: 0,
      columnBlockSize: blockViewport,
      columnsPerView,
    };
  }
  const authoredGap = insets.inlineStart + insets.inlineEnd + insets.inlineBorderAndPadding;
  const minimumGap = Math.min(32, Math.max(16, inlineViewport * 0.04));
  const gap = Math.max(minimumGap, authoredGap);
  const columnsPerView = effectiveColumns(state, preference, inlineViewport, gap);
  const extraInset = Math.max(0, gap - authoredGap) / 2;
  const inlineStart = insets.inlineStart + extraInset;
  const inlineEnd = insets.inlineEnd + extraInset;
  const flowInlineSize = Math.max(1, inlineViewport - inlineStart - inlineEnd);
  const flowBlockSize = Math.max(1, blockViewport - insets.blockStart - insets.blockEnd);
  return {
    gap,
    flowInlineSize,
    flowBlockSize,
    inlineStart,
    inlineEnd,
    blockStart: insets.blockStart,
    blockEnd: insets.blockEnd,
    columnBlockSize: Math.max(1, flowBlockSize - insets.blockBorderAndPadding),
    columnsPerView,
  };
}

export const minimumAutoColumnInlineSize = 360;

export function effectiveColumns(
  state: ContentAgentState,
  preference: ReflowablePresentation["paginationColumns"],
  inlineViewport: number,
  gap: number,
): 1 | 2 {
  void state;
  if (preference === "single" || state.layout.wideContentSingleColumn) return 1;
  if (preference === "double") return 2;
  return (inlineViewport - gap * 2) / 2 >= minimumAutoColumnInlineSize ? 2 : 1;
}

export interface PhysicalPaginationGeometry {
  readonly flow: DocumentFlow;
  readonly insets: BodyInsets;
  readonly spreadStride: number;
  readonly columnOrigin: number;
  readonly columnWidth: number;
  readonly columnGap: number;
  readonly columnPitch: number;
  readonly columnsPerView: 1 | 2;
}

export interface PhysicalPaginationMeasurement extends PhysicalPaginationGeometry {
  readonly pageCount: number;
  readonly hasUnpaginatedTextBlockOverflow: boolean;
}

export function singleColumnPaginationFallbackRequired(
  measurement: Pick<
    PhysicalPaginationMeasurement,
    "flow" | "columnsPerView" | "pageCount" | "hasUnpaginatedTextBlockOverflow"
  >,
): boolean {
  return (
    measurement.flow.writingMode === "horizontal-tb" &&
    measurement.columnsPerView === 1 &&
    measurement.pageCount === 1 &&
    measurement.hasUnpaginatedTextBlockOverflow
  );
}

export function paginationObservationViewport(
  state: ContentAgentState,
  geometry: {
    readonly columnOrigin: number;
    readonly columnWidth: number;
    readonly columnPitch: number;
    readonly columnsPerView: number;
  },
  visiblePageCount = geometry.columnsPerView,
): DocumentObservationViewport {
  void state;
  const count = Math.max(1, Math.min(geometry.columnsPerView, visiblePageCount));
  return {
    logicalInlineStart: geometry.columnOrigin + geometry.columnWidth / 2,
    logicalInlineEnd:
      geometry.columnOrigin + (count - 1) * geometry.columnPitch + geometry.columnWidth / 2,
  };
}

export function currentObservationViewport(
  state: ContentAgentState,
): DocumentObservationViewport | undefined {
  void state;
  const settlement = state.layout.settledLayout?.settlement;
  return settlement?.mode === "paginated"
    ? paginationObservationViewport(state, settlement.pages, settlement.pages.visiblePageCount)
    : undefined;
}

export function observeContentDocument(
  state: ContentAgentState,
  viewport?: DocumentObservationViewport,
  includeRenderedTextContext = false,
): DocumentLocatorObservation {
  void state;
  if (
    state.observation.observationTextSnapshot !== undefined &&
    !documentTextSnapshotIsCurrent(state.observation.observationTextSnapshot)
  ) {
    state.observation.observationTextSnapshot = undefined;
  }
  const capture = observeDocumentWithRanges(document, viewport, {
    textSnapshot: state.observation.observationTextSnapshot,
    includeRenderedTextContext,
  });
  state.observation.observationTextSnapshot = capture.textSnapshot;
  return capture.observation;
}

export function capturePhysicalPaginationGeometry(
  state: ContentAgentState,
  presentation: ReflowablePresentation,
): PhysicalPaginationGeometry {
  void state;
  const started = paginationGeometryDiagnosticsEnabled(state) ? performance.now() : 0;
  const flow = documentFlow(document);
  const insets = state.layout.authoredBodyInsets ?? captureBodyInsets(state);
  const layout = paginationGeometry(
    state,
    flow.writingMode,
    insets,
    presentation.paginationColumns,
  );
  const columnGap = layout.gap;
  const columnWidth = Math.max(
    1,
    (layout.flowInlineSize - columnGap * (layout.columnsPerView - 1)) / layout.columnsPerView,
  );
  const columnPitch = columnWidth + columnGap;
  const spreadStride = columnPitch * layout.columnsPerView;
  const columnOrigin = layout.inlineStart;
  recordPaginationGeometryPhase(state, "capture", started);
  return {
    flow,
    insets,
    spreadStride,
    columnOrigin,
    columnWidth,
    columnGap,
    columnPitch,
    columnsPerView: layout.columnsPerView,
  };
}

export async function scanPhysicalPaginationContentEnd(
  state: ContentAgentState,
  geometry: PhysicalPaginationGeometry,
  work: AgentWork,
  invalidationVersion: number,
  settlementVersion: ReturnType<typeof captureSettlementVersion>,
): Promise<PhysicalPaginationMeasurement | null> {
  void state;
  const started = performance.now();
  const scrolling = paginatedMetrics(document, geometry.flow.writingMode, geometry.flow.direction);
  const position = scrolling?.position ?? 0;
  const root = document.body ?? document.documentElement;
  const range = document.createRange();
  range.selectNodeContents(root);
  let finalPage = 0;
  let hasUnpaginatedTextBlockOverflow = false;
  let rectangleCount = 0;
  let sliceStarted = started;
  let sliceWorkUnits = 0;
  const includeRectangle = (rectangle: DOMRect): void => {
    rectangleCount += 1;
    if (rectangle.width <= 0 && rectangle.height <= 0) return;
    const rectangleOffset = paginatedRectangleOffset(
      document,
      rectangle,
      "end",
      geometry.flow.writingMode,
      geometry.flow.direction,
    );
    if (rectangleOffset === null) return;
    const logicalEnd = position + rectangleOffset;
    const page = Math.max(
      0,
      Math.floor((logicalEnd - geometry.columnOrigin - 0.5) / geometry.columnPitch),
    );
    finalPage = Math.max(finalPage, page);
  };
  for (const rectangle of range.getClientRects()) {
    sliceWorkUnits += 1;
    includeRectangle(rectangle);
    if (geometry.flow.writingMode === "horizontal-tb") {
      if (rectangle.top < -1 || rectangle.bottom > window.innerHeight + 1)
        hasUnpaginatedTextBlockOverflow = true;
    } else if (rectangle.left < -1 || rectangle.right > window.innerWidth + 1) {
      hasUnpaginatedTextBlockOverflow = true;
    }
    if (
      sliceWorkUnits >= cooperativeLayoutMinimumWorkUnits &&
      performance.now() - sliceStarted >= cooperativeLayoutSliceMs
    ) {
      await yieldLayoutWork(state, work);
      if (!layoutSnapshotIsCurrent(state, invalidationVersion, settlementVersion)) return null;
      sliceStarted = performance.now();
      sliceWorkUnits = 0;
    }
  }
  // Element fragments include replaced, out-of-flow, and generated boxes that a Range can omit.
  const clippingAncestors = new Map<Element, ClippingAncestorGeometry>();
  for (const element of root.querySelectorAll("*")) {
    sliceWorkUnits += 1;
    for (const rectangle of element.getClientRects()) {
      const visible = clipRectangleToAncestors(state, rectangle, element, root, clippingAncestors);
      if (visible !== null) includeRectangle(visible);
    }
    if (
      sliceWorkUnits >= cooperativeLayoutMinimumWorkUnits &&
      performance.now() - sliceStarted >= cooperativeLayoutSliceMs
    ) {
      await yieldLayoutWork(state, work);
      if (!layoutSnapshotIsCurrent(state, invalidationVersion, settlementVersion)) return null;
      sliceStarted = performance.now();
      sliceWorkUnits = 0;
    }
  }
  recordPaginationGeometryScan(state, rectangleCount, started);
  return {
    ...geometry,
    pageCount: finalPage + 1,
    hasUnpaginatedTextBlockOverflow,
  };
}

export interface ClippingAncestorGeometry {
  readonly clipsX: boolean;
  readonly clipsY: boolean;
  readonly bounds: DOMRect;
}

export function clipRectangleToAncestors(
  state: ContentAgentState,
  rectangle: DOMRect,
  element: Element,
  flowRoot: Element,
  cache: Map<Element, ClippingAncestorGeometry>,
): DOMRect | null {
  void state;
  let left = rectangle.left;
  let right = rectangle.right;
  let top = rectangle.top;
  let bottom = rectangle.bottom;
  for (let ancestor = element.parentElement; ancestor !== null && ancestor !== flowRoot;) {
    let geometry = cache.get(ancestor);
    if (geometry === undefined) {
      const style = getComputedStyle(ancestor);
      geometry = {
        clipsX: clipsOverflow(state, style.overflowX),
        clipsY: clipsOverflow(state, style.overflowY),
        bounds: ancestor.getBoundingClientRect(),
      };
      cache.set(ancestor, geometry);
    }
    if (geometry.clipsX) {
      left = Math.max(left, geometry.bounds.left);
      right = Math.min(right, geometry.bounds.right);
    }
    if (geometry.clipsY) {
      top = Math.max(top, geometry.bounds.top);
      bottom = Math.min(bottom, geometry.bounds.bottom);
    }
    if (right <= left || bottom <= top) return null;
    ancestor = ancestor.parentElement;
  }
  return new DOMRect(left, top, right - left, bottom - top);
}

export function clipsOverflow(state: ContentAgentState, value: string): boolean {
  void state;
  return value === "hidden" || value === "clip" || value === "auto" || value === "scroll";
}

export function resetPaginationGeometryDiagnostics(state: ContentAgentState): void {
  void state;
  const diagnostics = window.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__;
  if (diagnostics?.enabled !== true) return;
  diagnostics.scanCount = 0;
  diagnostics.rectangleCount = 0;
  diagnostics.cooperativeYieldCount = 0;
  diagnostics.assessment = undefined;
  diagnostics.phases = [];
}

export function paginationGeometryDiagnosticsEnabled(state: ContentAgentState): boolean {
  return (
    state.lifecycle.diagnosticsEnabled ||
    window.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__?.enabled === true
  );
}

export function recordTextAssessmentDiagnostics(
  state: ContentAgentState,
  counters: {
    paragraphCount: number;
    displayCandidateCount: number;
    rectangleCount: number;
    textRangeScanCount: number;
  },
  started: number,
): void {
  const diagnostics = window.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__;
  if (diagnostics?.enabled !== true && !state.lifecycle.diagnosticsEnabled) return;
  const durationMs = Math.max(0, performance.now() - started);
  if (diagnostics?.enabled === true) {
    diagnostics.assessment = { ...counters, durationMs };
    (diagnostics.phases ??= []).push({ phase: "text-assessment", durationMs });
  }
  postPaginationDiagnostic(
    state,
    "text-assessment",
    durationMs,
    counters.textRangeScanCount,
    counters.rectangleCount,
  );
}

export function recordPaginationGeometryPhase(
  state: ContentAgentState,
  phase: "capture" | "content-end-scan",
  started: number,
): void {
  void state;
  const diagnostics = window.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__;
  if (diagnostics?.enabled !== true && !state.lifecycle.diagnosticsEnabled) return;
  const durationMs = Math.max(0, performance.now() - started);
  if (diagnostics?.enabled === true) (diagnostics.phases ??= []).push({ phase, durationMs });
  postPaginationDiagnostic(state, phase, durationMs, 0, 0);
}

export function recordPaginationGeometryScan(
  state: ContentAgentState,
  rectangleCount: number,
  started: number,
): void {
  void state;
  const diagnostics = window.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__;
  if (diagnostics?.enabled !== true && !state.lifecycle.diagnosticsEnabled) return;
  if (diagnostics?.enabled === true) {
    diagnostics.scanCount = (diagnostics.scanCount ?? 0) + 1;
    diagnostics.rectangleCount = (diagnostics.rectangleCount ?? 0) + rectangleCount;
  }
  const durationMs = Math.max(0, performance.now() - started);
  if (diagnostics?.enabled === true)
    (diagnostics.phases ??= []).push({ phase: "content-end-scan", durationMs });
  postPaginationDiagnostic(state, "content-end-scan", durationMs, 1, rectangleCount);
}

export function postPaginationDiagnostic(
  state: ContentAgentState,
  phase:
    | "capture"
    | "content-end-scan"
    | "text-assessment"
    | "settlement"
    | "observation"
    | "live-observation",
  durationMs: number,
  scanCount: number,
  rectangleCount: number,
): void {
  void state;
  if (!state.lifecycle.diagnosticsEnabled) return;
  post(state, {
    namespace: CONTENT_AGENT_NAMESPACE,
    type: "pagination-diagnostic",
    phase,
    durationMs,
    scanCount,
    rectangleCount,
  });
}

export function lastSpreadFirstPage(
  state: ContentAgentState,
  metrics: {
    readonly pageCount: number;
    readonly columnsPerView: number;
  },
): number {
  void state;
  return lastViewFirstPage(metrics.pageCount, metrics.columnsPerView);
}

export function firstVisiblePhysicalPage(
  state: ContentAgentState,
  position: number,
  metrics: {
    readonly spreadStride: number;
    readonly pageCount: number;
    readonly columnsPerView: number;
  },
): number {
  void state;
  const spread = Math.max(0, Math.round(position / metrics.spreadStride));
  return Math.min(lastSpreadFirstPage(state, metrics), spread * metrics.columnsPerView);
}

export function requiredPaginationExtent(
  state: ContentAgentState,
  measured: PhysicalPaginationMeasurement,
): number {
  void state;
  return Math.ceil(measured.pageCount / measured.columnsPerView) * measured.spreadStride;
}

/**
 * The rendered extent of the body's content along the block axis, when it falls short of the
 * page. `rendition:align-x-center` is a physical-x request, and the inline axis is the one
 * pagination always fills, so only a vertical writing mode can leave room to centre.
 */
/**
 * The body's block-axis box, after any `rendition:align-x-center` centring. The page keeps its
 * full block extent; the content the author filled is what moves, so the style and the check
 * that the style took effect read the same numbers.
 */
export function centredBlockGeometry(
  state: ContentAgentState,
  geometry: { flowBlockSize: number; blockStart: number; blockEnd: number },
): { blockSize: number; blockStart: number; blockEnd: number } {
  const centred = state.layout.alignXCenterBlockExtent;
  if (centred === null) {
    return {
      blockSize: geometry.flowBlockSize,
      blockStart: geometry.blockStart,
      blockEnd: geometry.blockEnd,
    };
  }
  const inset = (geometry.flowBlockSize - centred) / 2;
  return {
    blockSize: centred,
    blockStart: geometry.blockStart + inset,
    blockEnd: geometry.blockEnd + inset,
  };
}

export function alignXCenterBlockExtent(
  state: ContentAgentState,
  presentation: ReflowablePresentation,
): number | null {
  const writingMode = documentFlow(document).writingMode;
  if (writingMode === "horizontal-tb" || document.body === null) return null;
  const geometry = paginationGeometry(
    state,
    writingMode,
    state.layout.authoredBodyInsets ?? captureBodyInsets(state),
    presentation.paginationColumns,
  );
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const child of document.body.children) {
    const rect = child.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    // The flow is as wide as the margin boxes, not the border boxes a rect reports.
    const style = getComputedStyle(child);
    start = Math.min(start, rect.left - (Number.parseFloat(style.marginLeft) || 0));
    end = Math.max(end, rect.right + (Number.parseFloat(style.marginRight) || 0));
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const extent = Math.ceil(end - start);
  return extent > 0 && extent < geometry.flowBlockSize ? extent : null;
}

/** How far the paginated flow reaches along the axis pages advance on. */
export function inlinePaginationExtent(): number {
  const scrolling = document.scrollingElement;
  if (scrolling === null) return 0;
  return documentFlow(document).writingMode === "horizontal-tb"
    ? scrolling.scrollWidth
    : scrolling.scrollHeight;
}

export function captureBodyInsets(state: ContentAgentState): BodyInsets {
  void state;
  const body = document.body;
  if (body === null) {
    return {
      inlineStart: 0,
      inlineEnd: 0,
      blockStart: 0,
      blockEnd: 0,
      inlineBorderAndPadding: 0,
      blockBorderAndPadding: 0,
    };
  }
  const style = getComputedStyle(body);
  return {
    inlineStart: cssPixels(state, style.marginInlineStart),
    inlineEnd: cssPixels(state, style.marginInlineEnd),
    blockStart: cssPixels(state, style.marginBlockStart),
    blockEnd: cssPixels(state, style.marginBlockEnd),
    inlineBorderAndPadding:
      cssPixels(state, style.borderInlineStartWidth) +
      cssPixels(state, style.borderInlineEndWidth) +
      cssPixels(state, style.paddingInlineStart) +
      cssPixels(state, style.paddingInlineEnd),
    blockBorderAndPadding:
      cssPixels(state, style.borderBlockStartWidth) +
      cssPixels(state, style.borderBlockEndWidth) +
      cssPixels(state, style.paddingBlockStart) +
      cssPixels(state, style.paddingBlockEnd),
  };
}

export function cssPixels(state: ContentAgentState, value: string): number {
  void state;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function closeCssPixels(state: ContentAgentState, value: string, expected: number): boolean {
  void state;
  return Math.abs(cssPixels(state, value) - expected) <= 1;
}

export function relocatePosition(
  state: ContentAgentState,
  presentation: ReflowablePresentation,
  position: ReflowPositionRequest,
  paginationGeometry: PhysicalPaginationGeometry | null,
): boolean {
  void state;
  if (position.kind === "unavailable") return true;
  if (position.kind === "entry") {
    if (presentation.mode === "paginated") {
      const geometry = paginationGeometry;
      if (geometry === null) return false;
      const metrics = paginatedMetrics(
        document,
        geometry.flow.writingMode,
        geometry.flow.direction,
      );
      if (metrics === null) return false;
      scrollToPaginatedPosition(
        document,
        position.entry === "start" ? 0 : metrics.maximum,
        geometry.flow.writingMode,
        geometry.flow.direction,
      );
    } else {
      scrollToDocumentBoundary(document, position.entry);
    }
    return true;
  }
  let normalizedProgression: number;
  if (position.kind === "exact") {
    const resolution = resolvePointEvidenceInDocument(document, position.evidence);
    if (resolution.range !== null) {
      const status = relocateLocatorInDocument(
        document,
        { kind: "point", evidence: position.evidence },
        presentation.mode === "paginated"
          ? { mode: "paginated", spreadStride: paginationGeometry?.spreadStride }
          : { mode: "document-scroll" },
      );
      if (status.status === "resolved") return true;
    }
    normalizedProgression = position.fallbackProgression;
  } else {
    normalizedProgression = position.normalizedProgression;
  }
  const flow = paginationGeometry?.flow ?? documentFlow(document);
  const { writingMode } = flow;
  if (presentation.mode === "paginated") {
    const metrics = paginatedMetrics(document, writingMode, flow.direction);
    if (metrics === null) return false;
    const spreadStride = paginationGeometry?.spreadStride;
    if (spreadStride === undefined) return false;
    const page = Math.max(
      0,
      Math.min(
        Math.round(metrics.maximum / spreadStride),
        Math.round((metrics.maximum * normalizedProgression) / spreadStride),
      ),
    );
    scrollToPaginatedPosition(document, page * spreadStride, writingMode, flow.direction);
  } else {
    const metrics = logicalBlockMetrics(document, writingMode);
    if (metrics === null) return false;
    const target = metrics.maximum * normalizedProgression;
    scrollByLogicalBlock(document, target - metrics.position, writingMode);
  }
  return true;
}
