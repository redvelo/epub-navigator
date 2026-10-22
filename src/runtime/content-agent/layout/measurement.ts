import type { ContentAgentState } from "../state.js";
import type {
  ReflowPositionRequest,
  ReflowablePresentation,
  ReflowableSettlement,
  RequiredAssetSettlement,
} from "../../../generated/kernel.js";
import type { AgentSettledLayout } from "../state.js";
import type { PhysicalPaginationMeasurement } from "./pagination-geometry.js";
import {
  currentObservationViewport,
  firstVisiblePhysicalPage,
  lastSpreadFirstPage,
  observeContentDocument,
  paginationGeometryDiagnosticsEnabled,
  paginationObservationViewport,
  postPaginationDiagnostic,
} from "./pagination-geometry.js";
import {
  logicalBlockMetrics,
  normalizedScrollPosition,
  paginatedMetrics,
} from "./document-scroll.js";

export function measureReflowableSettlement(
  state: ContentAgentState,
  presentation: ReflowablePresentation,
  measuredPagination: PhysicalPaginationMeasurement | null,
  requiredFonts: RequiredAssetSettlement,
  requiredResources: RequiredAssetSettlement,
): ReflowableSettlement {
  void state;
  const observationStarted = paginationGeometryDiagnosticsEnabled(state) ? performance.now() : 0;
  const baseObservation = observeContentDocument(
    state,
    measuredPagination === null
      ? undefined
      : paginationObservationViewport(
          state,
          measuredPagination,
          Math.min(measuredPagination.columnsPerView, measuredPagination.pageCount),
        ),
  );
  if (state.lifecycle.diagnosticsEnabled)
    postPaginationDiagnostic(state, "observation", performance.now() - observationStarted, 0, 0);
  const { writingMode } = baseObservation;
  const horizontal = writingMode === "horizontal-tb";
  const scrollingElement = document.scrollingElement;
  if (scrollingElement === null) throw new Error("the content document has no scrolling element");
  const logicalViewport = horizontal
    ? { inline: window.innerWidth, block: window.innerHeight }
    : { inline: window.innerHeight, block: window.innerWidth };
  const logicalContentExtent = horizontal
    ? { inline: scrollingElement.scrollWidth, block: scrollingElement.scrollHeight }
    : { inline: scrollingElement.scrollHeight, block: scrollingElement.scrollWidth };
  if (presentation.mode === "paginated") {
    if (measuredPagination === null) throw new Error("pagination geometry is unavailable");
    const metrics = paginatedMetrics(
      document,
      measuredPagination.flow.writingMode,
      measuredPagination.flow.direction,
    );
    if (metrics === null) throw new Error("paginated metrics are unavailable");
    const measured = measuredPagination;
    const firstVisiblePage = firstVisiblePhysicalPage(state, metrics.position, measured);
    const visiblePageCount = Math.min(
      measured.columnsPerView,
      measured.pageCount - firstVisiblePage,
    );
    const observation = {
      ...baseObservation,
      pagination: {
        firstVisiblePage,
        pageCount: measured.pageCount,
        visiblePageCount,
      },
    };
    const physicalSign = baseObservation.direction === "rtl" ? -1 : 1;
    const lastFirstVisiblePage = lastSpreadFirstPage(state, measured);
    return {
      mode: "paginated",
      measurement: {
        observation,
        logicalViewport,
        logicalContentExtent,
        normalizedPosition:
          lastFirstVisiblePage === 0 ? 0 : firstVisiblePage / lastFirstVisiblePage,
        physicalMovement: horizontal
          ? { x: physicalSign * measured.spreadStride, y: 0 }
          : { x: 0, y: physicalSign * measured.spreadStride },
        requiredFonts,
        requiredResources,
      },
      pages: {
        spreadStride: measured.spreadStride,
        columnOrigin: measured.columnOrigin,
        columnWidth: measured.columnWidth,
        columnGap: measured.columnGap,
        columnPitch: measured.columnPitch,
        firstVisiblePage,
        pageCount: measured.pageCount,
        visiblePageCount,
        columnsPerView: measured.columnsPerView,
        layoutRepairs: state.layout.layoutRepairReport,
      },
    };
  }
  const metrics = logicalBlockMetrics(document, writingMode);
  if (metrics === null) throw new Error("document scroll metrics are unavailable");
  return {
    mode: "document-scroll",
    measurement: {
      observation: baseObservation,
      logicalViewport,
      logicalContentExtent,
      normalizedPosition: normalizedScrollPosition(metrics.position, metrics.maximum),
      physicalMovement: horizontal
        ? { x: 0, y: metrics.viewport }
        : { x: writingMode === "vertical-rl" ? -metrics.viewport : metrics.viewport, y: 0 },
      requiredFonts,
      requiredResources,
    },
  };
}

export function currentReflowPosition(
  state: ContentAgentState,
  layout: AgentSettledLayout,
): ReflowPositionRequest {
  void state;
  const observation = observeContentDocument(state, currentObservationViewport(state));
  let normalizedProgression = layout.settlement.measurement.normalizedPosition;
  if (layout.presentation.mode === "paginated") {
    const metrics = paginatedMetrics(document, observation.writingMode, observation.direction);
    if (metrics !== null) {
      normalizedProgression = normalizedScrollPosition(metrics.position, metrics.maximum);
    }
    return { kind: "progression", normalizedProgression };
  }
  const metrics = logicalBlockMetrics(document, observation.writingMode);
  if (metrics !== null) {
    normalizedProgression = normalizedScrollPosition(metrics.position, metrics.maximum);
  }
  const explicitStart =
    normalizedProgression > 0 &&
    observation.visibleStart.state === "located" &&
    observation.visibleStart.evidence.some(
      (evidence) => evidence.kind === "document-boundary" && evidence.boundary === "start",
    );
  return observation.visibleStart.state === "located" && !explicitStart
    ? {
        kind: "exact",
        evidence: observation.visibleStart.evidence,
        fallbackProgression: normalizedProgression,
      }
    : { kind: "progression", normalizedProgression };
}
