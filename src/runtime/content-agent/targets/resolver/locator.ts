import type {
  AnnotationTargetResolutionPlan,
  AnnotationTargetResolutionResult,
  CandidateResult,
  CooperativePointEvidenceBatchResult,
  CooperativeResolverWork,
  DocumentTextSnapshot,
  DomLocatorResolution,
  RelocationPresentation,
  ResolverWorkMeter,
  VisibleTextMap,
} from "./types.js";
import type { DocumentLocatorTarget } from "../../../agent-protocol/index.js";
import type { LocatorResolutionStatus, PointEvidence } from "../../../../generated/kernel.js";
import {
  assertResolverActive,
  chargeResolverWork,
  rangeFromOffsets,
  reconcile,
  resolveBoundaries,
  resolvePointEvidence,
  resolvePointEvidenceCooperatively,
  resolveTextPositionRange,
  validateCooperativeWork,
} from "./evidence.js";
import {
  createDocumentTextSnapshot,
  createDocumentTextSnapshotCooperatively,
  createVisibleTextMap,
  textMapFromSnapshot,
} from "./text-index.js";
import {
  documentFlow,
  paginatedMetrics,
  paginatedRectangleOffset,
  scrollToDocumentBoundary,
  scrollToPaginatedPosition,
} from "../../layout/document-scroll.js";
import {
  evidenceForBoundary,
  rangeRectangle,
  renderedElementRectangle,
  textOffsetForBoundary,
} from "./viewport.js";
import { findTextQuoteMatches, resolveAnnotationTargetInDocument } from "./annotation.js";
import { isElement } from "../../dom.js";

/** Resolves supported locator evidence directly against one same-origin content document. */
export function resolveLocatorInDocument(
  document: Document,
  locator: DocumentLocatorTarget,
  snapshot?: DocumentTextSnapshot,
): DomLocatorResolution {
  try {
    let textMap: VisibleTextMap | null = null;
    const getTextMap = () => (textMap ??= textMapFromSnapshot(document, snapshot));
    const results =
      locator.kind === "point"
        ? locator.evidence.map((evidence) => resolvePointEvidence(document, getTextMap, evidence))
        : locator.evidence.map((evidence) => {
            if (evidence.kind === "rendered-text-quote") {
              const map = getTextMap();
              return {
                kind: "candidates" as const,
                ranges: findTextQuoteMatches(
                  map.text,
                  evidence.exact,
                  evidence.prefix,
                  evidence.suffix,
                ).map((match) => rangeFromOffsets(document, map, match.start, match.end)),
              };
            }
            if (evidence.kind === "browser-text-position") {
              return resolveTextPositionRange(document, getTextMap(), evidence.start, evidence.end);
            }
            return resolveBoundaries(document, getTextMap, evidence.start, evidence.end);
          });
    return reconcile(results);
  } catch (cause) {
    return {
      range: null,
      status: {
        status: "failed",
        message: cause instanceof Error ? cause.message : "DOM locator resolution failed",
      },
    };
  }
}

/** Resolves exact reflow anchors through the locator evidence reconciler. */
export function resolvePointEvidenceInDocument(
  document: Document,
  evidence: PointEvidence[],
  snapshot?: DocumentTextSnapshot,
): DomLocatorResolution {
  return resolveLocatorInDocument(document, { kind: "point", evidence }, snapshot);
}

/** Captures exact point evidence at the live start of one connected authored element. */
export function capturePointAtElementStartInDocument(
  document: Document,
  element: Element,
): PointEvidence[] | null {
  if (element.ownerDocument !== document || !element.isConnected) return null;
  const textMap = createVisibleTextMap(document);
  const boundary = { node: element as Node, offset: 0 };
  const observation = evidenceForBoundary(
    document,
    textMap,
    boundary,
    textOffsetForBoundary(textMap, boundary),
  );
  return observation.state === "located" ? observation.evidence : null;
}

/** Resolves a batch against one shared, lazily-created rendered-text snapshot. */
export function resolvePointEvidenceBatchInDocument(
  document: Document,
  batch: readonly (readonly PointEvidence[])[],
  reusableSnapshot?: DocumentTextSnapshot,
): DomLocatorResolution[] {
  const needsRenderedText = batch.some((evidence) =>
    evidence.some((item) => item.kind !== "document-boundary" && item.kind !== "html-fragment"),
  );
  const snapshot = needsRenderedText
    ? (reusableSnapshot ?? createDocumentTextSnapshot(document))
    : undefined;
  return batch.map((evidence) =>
    resolveLocatorInDocument(document, { kind: "point", evidence: [...evidence] }, snapshot),
  );
}

/** Resolves TOC points with bounded work and task yields so cancellation can be delivered. */
export async function resolvePointEvidenceBatchCooperativelyInDocument(
  document: Document,
  batch: readonly (readonly PointEvidence[])[],
  reusableSnapshot: DocumentTextSnapshot | undefined,
  work: CooperativeResolverWork,
): Promise<CooperativePointEvidenceBatchResult> {
  validateCooperativeWork(work);
  const meter: ResolverWorkMeter = { ...work, used: 0, sinceYield: 0 };
  assertResolverActive(meter);
  const needsRenderedText = batch.some((evidence) =>
    evidence.some((item) => item.kind !== "document-boundary" && item.kind !== "html-fragment"),
  );
  const snapshot = needsRenderedText
    ? (reusableSnapshot ?? (await createDocumentTextSnapshotCooperatively(document, meter)))
    : undefined;
  const resolutions: DomLocatorResolution[] = [];
  for (const evidence of batch) {
    assertResolverActive(meter);
    let textMap: VisibleTextMap | null = null;
    const getTextMap = () => (textMap ??= textMapFromSnapshot(document, snapshot));
    const candidates: CandidateResult[] = [];
    for (const item of evidence) {
      candidates.push(await resolvePointEvidenceCooperatively(document, getTextMap, item, meter));
    }
    resolutions.push(reconcile(candidates));
    await chargeResolverWork(meter, 1);
  }
  return { resolutions, snapshot };
}

/** Resolves a locator and scrolls its live range into the native document viewport. */
export function relocateLocatorInDocument(
  document: Document,
  locator: DocumentLocatorTarget,
  presentation: RelocationPresentation = { mode: "document-scroll" },
): LocatorResolutionStatus {
  const resolution = resolveLocatorInDocument(document, locator);
  if (resolution.range === null) return resolution.status;
  const failure = relocateRangeInDocument(document, resolution.range, presentation);
  return failure === null ? resolution.status : { status: "failed", message: failure };
}

/** Executes an annotation plan and relocates to the logical start of its resolved segment. */
export async function relocateAnnotationTargetInDocument(
  document: Document,
  plan: AnnotationTargetResolutionPlan,
  work: CooperativeResolverWork,
  presentation: RelocationPresentation = { mode: "document-scroll" },
  beforeRelocate?: (range: Range) => (() => void) | void,
): Promise<AnnotationTargetResolutionResult> {
  const resolution = await resolveAnnotationTargetInDocument(document, plan, work);
  if (resolution.range === null) return resolution;
  const rollback = beforeRelocate?.(resolution.range);
  let failure: string | null;
  try {
    failure = relocateRangeInDocument(document, resolution.range, presentation);
  } catch (cause) {
    rollback?.();
    throw cause;
  }
  if (failure !== null) rollback?.();
  return failure === null
    ? resolution
    : { ...resolution, outcome: "failed", segmentKind: null, range: null };
}

export function relocateRangeInDocument(
  document: Document,
  range: Range,
  presentation: RelocationPresentation,
): string | null {
  const view = document.defaultView;
  const root = document.body ?? document.documentElement;
  const scrollingElement = document.scrollingElement;
  if (view === null || root === null || scrollingElement === null) {
    return "the resolved location has no active viewport";
  }
  const rootRange = document.createRange();
  rootRange.selectNodeContents(root);
  const atStart =
    range.collapsed &&
    range.startContainer === rootRange.startContainer &&
    range.startOffset === rootRange.startOffset;
  const atEnd =
    range.collapsed &&
    range.startContainer === rootRange.endContainer &&
    range.startOffset === rootRange.endOffset;
  const flow = documentFlow(document);
  const { writingMode } = flow;
  if (atStart || atEnd) {
    if (presentation.mode === "paginated") {
      const metrics = paginatedMetrics(document, writingMode);
      const spreadStride = presentation.spreadStride;
      if (
        metrics === null ||
        spreadStride === undefined ||
        !Number.isFinite(spreadStride) ||
        spreadStride <= 0
      ) {
        return "the paginated boundary has no settled stride";
      }
      const lastSpread = Math.max(0, Math.round(metrics.maximum / spreadStride));
      scrollToPaginatedPosition(document, atStart ? 0 : lastSpread * spreadStride, writingMode);
    } else {
      scrollToDocumentBoundary(document, atStart ? "start" : "end", writingMode);
    }
    return null;
  }
  let rectangle = rangeRectangle(range);
  if (
    rectangle === null &&
    presentation.mode === "paginated" &&
    range.collapsed &&
    isElement(range.startContainer) &&
    range.startOffset === 0
  ) {
    rectangle = renderedElementRectangle(range.startContainer);
  }
  if (rectangle !== null) {
    if (presentation.mode === "paginated") {
      const metrics = paginatedMetrics(document, writingMode);
      const spreadStride = presentation.spreadStride;
      if (
        metrics === null ||
        spreadStride === undefined ||
        !Number.isFinite(spreadStride) ||
        spreadStride <= 0
      ) {
        return "the paginated location has no settled stride";
      }
      const rectangleOffset = paginatedRectangleOffset(document, rectangle, "start", writingMode);
      if (rectangleOffset === null) {
        return "the paginated location has no active viewport";
      }
      const offset = metrics.position + rectangleOffset;
      scrollToPaginatedPosition(
        document,
        Math.max(0, Math.floor(offset / spreadStride) * spreadStride),
        writingMode,
      );
      return null;
    }
    if (writingMode === "horizontal-tb") {
      view.scrollBy({ top: rectangle.top, behavior: "auto" });
    } else if (writingMode === "vertical-lr") {
      view.scrollBy({ left: rectangle.left, behavior: "auto" });
    } else {
      view.scrollBy({ left: rectangle.right - view.innerWidth, behavior: "auto" });
    }
    return null;
  }
  if (presentation.mode === "paginated") {
    return "the paginated location has no rendered geometry";
  }
  const boundary = range.startContainer;
  const element = isElement(boundary) ? boundary : boundary.parentElement;
  if (element === null) {
    return "the resolved location has no scrollable element";
  }
  element.scrollIntoView({ block: "start", inline: "nearest" });
  return null;
}
