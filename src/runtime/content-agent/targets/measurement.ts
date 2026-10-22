import type { AgentWork } from "../operation-queue.js";
import type { ContentAgentState } from "../state.js";
import { resolvePointEvidenceBatchCooperativelyInDocument } from "./resolver/locator.js";
import { documentTextSnapshotIsCurrent } from "./resolver/text-index.js";
import {
  MAX_TOC_RESOLUTION_WORK_UNITS,
  TOC_RESOLUTION_YIELD_WORK_UNITS,
  physicalPageForRange,
} from "./resolver/types.js";
import { capturePaginatedGeometryContext } from "../layout/document-scroll.js";
import { cooperativeLayoutSliceMs } from "../layout/constants.js";
import { resolveStaticSvgLocator } from "./locator.js";
import { ensureActive } from "../operation-queue.js";
import type {
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
  TocTargetPageResult,
} from "../../agent-protocol/index.js";

export async function measureTocTargets(
  state: ContentAgentState,
  targets: readonly TocTargetMeasurementRequest[],
  work: AgentWork,
): Promise<TocTargetMeasurementResult[]> {
  void state;
  if (state.lifecycle.documentAdapter === "fixed-image")
    return targets.map((target) => ({
      listIndex: target.listIndex,
      pointPath: target.pointPath,
      result: { state: "unavailable", reason: "raster-measurement-unavailable" },
    }));
  const metrics = state.layout.settledLayout?.settlement;
  const paginated = metrics?.mode === "paginated" ? metrics : null;
  const fixed = state.layout.fixedSettlement !== null;
  if (paginated === null && !fixed) {
    return targets.map((target) => ({
      listIndex: target.listIndex,
      pointPath: target.pointPath,
      result: { state: "unavailable", reason: "paginated-layout-unavailable" },
    }));
  }
  if (state.lifecycle.documentAdapter === "fixed-svg") {
    return targets.map((target) => {
      ensureActive(work);
      const status = resolveStaticSvgLocator(state, {
        kind: "point",
        evidence: [...target.evidence],
      });
      const result: TocTargetPageResult =
        status.status === "resolved"
          ? { state: "located", physicalPage: 0 }
          : status.status === "ambiguous" || status.status === "conflicting-evidence"
            ? { state: "ambiguous", reason: status.status }
            : status.status === "failed"
              ? { state: "failed", message: status.message }
              : { state: "unavailable", reason: status.status };
      return { listIndex: target.listIndex, pointPath: target.pointPath, result };
    });
  }
  const evidence = targets.map((target) => target.evidence);
  const needsRenderedText = evidence.some((items) =>
    items.some((item) => item.kind !== "document-boundary" && item.kind !== "html-fragment"),
  );
  if (state.targets.tocTextSnapshotLayout !== state.layout.settledLayout) {
    state.targets.tocTextSnapshot = undefined;
    state.targets.tocTextSnapshotLayout = state.layout.settledLayout;
  }
  if (
    state.targets.tocTextSnapshot !== undefined &&
    !documentTextSnapshotIsCurrent(state.targets.tocTextSnapshot)
  ) {
    state.targets.tocTextSnapshot = undefined;
  }
  const batch = await resolvePointEvidenceBatchCooperativelyInDocument(
    document,
    evidence,
    state.targets.tocTextSnapshot,
    {
      signal: work.controller.signal,
      maximumWorkUnits: MAX_TOC_RESOLUTION_WORK_UNITS,
      yieldEveryWorkUnits: TOC_RESOLUTION_YIELD_WORK_UNITS,
    },
  );
  if (needsRenderedText) state.targets.tocTextSnapshot = batch.snapshot;
  let geometry =
    paginated === null
      ? null
      : capturePaginatedGeometryContext(document, {
          writingMode: paginated.measurement.observation.writingMode,
          direction: paginated.measurement.observation.direction,
        });
  const results: TocTargetMeasurementResult[] = [];
  let sliceStarted = performance.now();
  for (let index = 0; index < targets.length; index += 1) {
    ensureActive(work);
    const target = targets[index]!;
    const resolution = batch.resolutions[index]!;
    let result: TocTargetPageResult;
    if (resolution.status.status === "resolved" && resolution.range !== null) {
      const physicalPage = fixed
        ? 0
        : paginated === null
          ? null
          : physicalPageForRange(document, resolution.range, paginated.pages, geometry);
      result =
        physicalPage === null
          ? { state: "unavailable", reason: "target-geometry-unavailable" }
          : { state: "located", physicalPage };
    } else if (
      resolution.status.status === "ambiguous" ||
      resolution.status.status === "conflicting-evidence"
    ) {
      result = { state: "ambiguous", reason: resolution.status.status };
    } else if (resolution.status.status === "failed") {
      result = { state: "failed", message: resolution.status.message };
    } else {
      result = { state: "unavailable", reason: resolution.status.status };
    }
    results.push({ listIndex: target.listIndex, pointPath: target.pointPath, result });
    if (
      index + 1 < targets.length &&
      performance.now() - sliceStarted >= cooperativeLayoutSliceMs
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      ensureActive(work);
      if (paginated !== null) {
        geometry = capturePaginatedGeometryContext(document, {
          writingMode: paginated.measurement.observation.writingMode,
          direction: paginated.measurement.observation.direction,
        });
      }
      sliceStarted = performance.now();
    }
  }
  return results;
}
