import type {
  BookPaginationSnapshot,
  TocTargetPagination,
} from "../../runtime/pagination/index.js";
import type { VisibleOccurrenceRange } from "../../runtime/navigator/api.js";
import { lastViewFirstPage } from "../../runtime/agent-protocol/index.js";
import type { ReaderSessionId } from "../../publication.js";
import { isAddressedTarget, type JoinedTocPoint } from "../navigation/model.js";

export interface ProgressInterval {
  readonly start: number;
  readonly end: number;
}

export interface ReaderProgressMarker {
  readonly identity: string;
  readonly coordinate: number;
  readonly depth: 1 | 2 | 3 | 4;
  readonly authoredOrdinal: number;
}

export interface ReaderMarkerProjection {
  readonly state: "exact" | "estimated" | "pending" | "ambiguous";
  readonly freshness: "current" | "retained";
  readonly markers: readonly ReaderProgressMarker[];
}

export type ReaderPageMetadata =
  | {
      readonly kind: "physical-pages";
      readonly visible: ProgressInterval;
      readonly visibleSpread: ProgressInterval | null;
      readonly total: number;
    }
  | {
      readonly kind: "calibrated-pages";
      readonly visible: ProgressInterval;
      readonly total: number;
      /** Estimated start of the committed occurrence, held until the occurrence changes. */
      readonly occurrenceStart: number;
      readonly runRevision: number;
    }
  | { readonly kind: "percentage"; readonly value: number };

export interface ReaderProgressProjection {
  readonly accuracy: "exact" | "calibrated" | "estimated";
  readonly freshness: "current" | "retained";
  readonly occurrence: number | null;
  readonly coordinate: number;
  readonly pages: ReaderPageMetadata;
  readonly markers: ReaderMarkerProjection;
  readonly label: string;
  readonly accessibleLabel: string;
}

export interface RetainedBookProgress {
  readonly sessionId: ReaderSessionId;
  readonly progress: ReaderProgressProjection;
}

export function sectionPageLabel(pagination: {
  readonly firstVisiblePage: number;
  readonly visiblePageCount: number;
  readonly pageCount: number;
}): string {
  const first = pagination.firstVisiblePage + 1;
  const last = first + pagination.visiblePageCount - 1;
  return `${first}${last === first ? "" : `-${last}`} / ${pagination.pageCount}`;
}

export interface ReaderProgressInput {
  readonly toc: readonly JoinedTocPoint[];
  readonly committed: {
    readonly occurrence: number;
    readonly resource: string;
    readonly generation: number;
  } | null;
  readonly committedLayout: {
    readonly documentGeneration: number;
    readonly layoutGeneration: number;
  } | null;
  readonly foregroundPaginated: boolean;
  readonly pendingForegroundLayout: boolean;
  readonly readingOrderLength: number;
  readonly renderedProgress: number;
  readonly localPagination: {
    readonly firstVisiblePage: number;
    readonly visiblePageCount: number;
    readonly pageCount: number;
  } | null;
  readonly visibleOccurrenceRange?: (VisibleOccurrenceRange | null) | undefined;
  /** Live page position of a reflowable spread companion that turns its own pages. */
  readonly companionPagination?:
    | {
        readonly firstVisiblePage: number;
        readonly visiblePageCount: number;
        readonly pageCount: number;
      }
    | null
    | undefined;
  /** Leading occurrence of the book's final view when that view is a spread. */
  readonly finalSpreadLeadingOccurrence?: (number | null) | undefined;
  /** The current page follows a continuous scroll, so no single page is the visible one. */
  readonly scrollFollowing?: boolean | undefined;
  readonly pagination: BookPaginationSnapshot | null;
  readonly railPixelWidth: number | null;
  readonly retained?: (ReaderProgressProjection | null) | undefined;
}

const exactMarkerCache = new WeakMap<
  BookPaginationSnapshot,
  WeakMap<readonly JoinedTocPoint[], Map<string, ReaderMarkerProjection | null>>
>();
const calibratedMarkerCache = new WeakMap<
  BookPaginationSnapshot,
  WeakMap<readonly JoinedTocPoint[], Map<string, ReaderMarkerProjection | null>>
>();
const estimatedMarkerCache = new WeakMap<
  readonly JoinedTocPoint[],
  Map<string, ReaderMarkerProjection>
>();

/**
 * Maps a zero-based physical page start onto the shared cursor/marker rail coordinate. The rail
 * spans the page starts a cursor can occupy, so `railEnd` is the first page of the final view
 * rather than the final page: a two-column layout reaches the end on a page start two pages
 * short of the total.
 */
export function pageStartCoordinate(pageStart: number, railEnd: number): number {
  return clamp(pageStart / Math.max(1, railEnd));
}

/**
 * First page of the book's final view. Views align to the measured column count, so a trailing
 * partial view still begins on an aligned page. When that view is a spread whose trailing member
 * holds a single view, the reader finishes on the leading member's pages, which is where the
 * cursor stops. Null when a member carries no measured count, which an exact catalog never
 * reports: the exact projections then decline rather than approximate the rail from the page
 * total.
 */
function bookRailEnd(
  pagination: BookPaginationSnapshot,
  finalSpreadLeadingOccurrence: number | null,
): number | null {
  const trailing = memberRailEnd(pagination, pagination.occurrences.length - 1);
  if (trailing === null) return null;
  if (finalSpreadLeadingOccurrence === null) return trailing.start + trailing.lastViewStart;
  // Mirrors the spread position rule: the trailing member owns the position once it can turn a
  // page of its own, and until then the leading member does.
  if (trailing.lastViewStart > 0) return trailing.start + trailing.lastViewStart;
  const leading = memberRailEnd(pagination, finalSpreadLeadingOccurrence);
  return leading === null ? null : leading.start + leading.lastViewStart;
}

function memberRailEnd(
  pagination: BookPaginationSnapshot,
  occurrence: number,
): { readonly start: number; readonly lastViewStart: number } | null {
  const entry = pagination.occurrences[occurrence];
  if (entry?.state !== "measured" || entry.occurrence !== occurrence) return null;
  const start = pagination.pageStart(occurrence);
  return typeof start === "number"
    ? { start, lastViewStart: lastViewFirstPage(entry.pageCount, entry.columnsPerView) }
    : null;
}

export function projectReaderProgress(input: ReaderProgressInput): ReaderProgressProjection {
  // A scroll-following layout shows several pages at once and moves between them continuously,
  // so a page-exact coordinate would snap back and forth against the scroll fraction.
  const exact = input.scrollFollowing === true ? null : exactProjection(input);
  if (exact !== null) return exact;
  const retained = input.retained;
  if (
    retained?.accuracy === "exact" &&
    retained.occurrence !== null &&
    input.committed !== null &&
    (retained.occurrence === input.committed.occurrence || sectionTransitionIsApplicable(input)) &&
    retentionIsApplicable(input)
  ) {
    return {
      ...retained,
      freshness: "retained",
      markers: { ...retained.markers, freshness: "retained" },
      accessibleLabel: accessibleProgressLabel(retained.pages, "exact", "retained"),
    };
  }
  return (
    calibratedProjection(input) ?? retainedCalibratedProjection(input) ?? estimatedProjection(input)
  );
}

function retainedCalibratedProjection(input: ReaderProgressInput): ReaderProgressProjection | null {
  const retained = input.retained;
  const pagination = input.pagination;
  if (
    retained?.accuracy !== "calibrated" ||
    retained.occurrence === null ||
    input.committed === null ||
    pagination === null ||
    pagination.estimatedTotalPageCount === null ||
    !(
      input.pendingForegroundLayout ||
      pagination.freshness !== "current" ||
      sectionTransitionIsApplicable(input)
    )
  ) {
    return null;
  }
  return {
    ...retained,
    freshness: "retained",
    markers: { ...retained.markers, freshness: "retained" },
    accessibleLabel: accessibleProgressLabel(retained.pages, "calibrated", "retained"),
  };
}

function retentionIsApplicable(input: ReaderProgressInput): boolean {
  if (input.pendingForegroundLayout) return true;
  if (foregroundIdentityIsReconciling(input)) return true;
  const pagination = input.pagination;
  if (pagination === null) return false;
  if (pagination.freshness === "candidate-pending") return true;
  if (pagination.activity === "paused" && pagination.pageCountCoverage.state === "exact")
    return true;
  if (pagination.freshness === "stale" && pagination.activity !== "idle") return true;
  if (pagination.foreground.state === "pending" && pagination.pageCountCoverage.state === "exact")
    return true;
  if (pagination.activity === "idle" || pagination.activity === "paused") return false;
  return (
    pagination.pageCountCoverage.state !== "exact" || pagination.foreground.state === "pending"
  );
}

function sectionTransitionIsApplicable(input: ReaderProgressInput): boolean {
  if (input.pendingForegroundLayout) return true;
  if (foregroundIdentityIsReconciling(input)) return true;
  const pagination = input.pagination;
  return (
    pagination !== null &&
    (pagination.freshness === "candidate-pending" ||
      (pagination.foreground.state === "pending" && pagination.pageCountCoverage.state === "exact"))
  );
}

function foregroundIdentityIsReconciling(input: ReaderProgressInput): boolean {
  const foreground = input.pagination?.foreground;
  const committed = input.committed;
  if (
    foreground?.state !== "current" ||
    committed === null ||
    input.pagination?.freshness !== "current" ||
    input.pagination.pageCountCoverage.state !== "exact"
  ) {
    return false;
  }
  return (
    foreground.occurrence !== committed.occurrence ||
    foreground.resource !== committed.resource ||
    foreground.documentGeneration !== committed.generation ||
    (input.committedLayout !== null &&
      (input.committedLayout.documentGeneration !== committed.generation ||
        foreground.layoutGeneration !== input.committedLayout.layoutGeneration))
  );
}

function exactProjection(input: ReaderProgressInput): ReaderProgressProjection | null {
  const { committed, committedLayout, localPagination, pagination } = input;
  if (
    committed === null ||
    committedLayout === null ||
    !input.foregroundPaginated ||
    input.pendingForegroundLayout ||
    localPagination === null ||
    pagination === null ||
    pagination.freshness !== "current" ||
    pagination.pageCountCoverage.state !== "exact" ||
    pagination.totalPageCount === null ||
    pagination.foreground.state !== "current" ||
    pagination.foreground.occurrence !== committed.occurrence ||
    pagination.foreground.resource !== committed.resource ||
    pagination.foreground.documentGeneration !== committed.generation ||
    pagination.foreground.layoutGeneration !== committedLayout.layoutGeneration ||
    committedLayout.documentGeneration !== committed.generation ||
    pagination.foreground.pageCount !== localPagination.pageCount
  ) {
    return null;
  }
  const entry = pagination.occurrences[committed.occurrence];
  const pageStart = pagination.pageStart(committed.occurrence);
  const railEnd = bookRailEnd(pagination, input.finalSpreadLeadingOccurrence ?? null);
  if (
    entry?.state !== "measured" ||
    entry.pageCount !== localPagination.pageCount ||
    typeof pageStart !== "number" ||
    railEnd === null
  ) {
    return null;
  }
  const localStart = Math.min(
    Math.max(0, Math.trunc(localPagination.firstVisiblePage)),
    Math.max(0, localPagination.pageCount - 1),
  );
  let visible = {
    start: pageStart + localStart,
    end: Math.min(
      pagination.totalPageCount,
      pageStart + localStart + Math.max(1, Math.trunc(localPagination.visiblePageCount)),
    ),
  };
  let visibleSpread = localPagination.visiblePageCount > 1 ? visible : null;
  const occurrenceRange = input.visibleOccurrenceRange;
  if (occurrenceRange !== undefined && occurrenceRange !== null) {
    if (
      occurrenceRange.primaryOccurrence !== committed.occurrence ||
      occurrenceRange.firstOccurrence > committed.occurrence ||
      occurrenceRange.lastOccurrence < committed.occurrence
    ) {
      return null;
    }
    if (occurrenceRange.companion === null) {
      if (
        occurrenceRange.firstOccurrence !== committed.occurrence ||
        occurrenceRange.lastOccurrence !== committed.occurrence
      ) {
        return null;
      }
      if (localPagination.pageCount === 1) visibleSpread = null;
    } else {
      const spread = exactFixedSpread(
        pagination,
        occurrenceRange,
        localPagination,
        input.companionPagination ?? null,
      );
      if (spread === null) return null;
      visible = spread;
      visibleSpread = spread;
    }
  }
  const pages: ReaderPageMetadata = {
    kind: "physical-pages",
    visible,
    visibleSpread,
    total: pagination.totalPageCount,
  };
  return {
    accuracy: "exact",
    freshness: "current",
    occurrence: committed.occurrence,
    coordinate: pageStartCoordinate(visible.start, railEnd),
    pages,
    markers: projectedMarkers(input),
    label: physicalPageLabel(pages),
    accessibleLabel: accessibleProgressLabel(pages, "exact", "current"),
  };
}

function exactFixedSpread(
  pagination: BookPaginationSnapshot,
  range: VisibleOccurrenceRange,
  localPagination: NonNullable<ReaderProgressInput["localPagination"]>,
  companionPagination: ReaderProgressInput["companionPagination"],
): ProgressInterval | null {
  const { firstOccurrence, lastOccurrence, primaryOccurrence, companion } = range;
  if (
    companion === null ||
    lastOccurrence !== firstOccurrence + 1 ||
    companion.occurrence === primaryOccurrence ||
    (companion.occurrence !== firstOccurrence && companion.occurrence !== lastOccurrence) ||
    (primaryOccurrence !== firstOccurrence && primaryOccurrence !== lastOccurrence)
  ) {
    return null;
  }
  const member = (
    occurrence: number,
    live: ReaderProgressInput["companionPagination"],
  ): { start: number; count: number; current: number; shown: number } | null => {
    const entry = pagination.occurrences[occurrence];
    const start = pagination.pageStart(occurrence);
    if (
      entry?.state !== "measured" ||
      entry.occurrence !== occurrence ||
      typeof start !== "number"
    ) {
      return null;
    }
    const position = live != null && live.pageCount === entry.pageCount ? live : null;
    const current = Math.min(
      Math.max(0, Math.trunc(position?.firstVisiblePage ?? 0)),
      Math.max(0, entry.pageCount - 1),
    );
    const shown = Math.min(
      entry.pageCount - current,
      Math.max(1, Math.trunc(position?.visiblePageCount ?? 1)),
    );
    return { start, count: entry.pageCount, current, shown };
  };
  const primary = member(primaryOccurrence, localPagination);
  const partner = member(companion.occurrence, companionPagination);
  if (primary === null || partner === null) return null;
  const [first, last] =
    primaryOccurrence === firstOccurrence ? [primary, partner] : [partner, primary];
  if (last.start !== first.start + first.count) return null;
  // A spread is read leading member first, and a reflowable member turns its own pages while
  // the other stays. Once the trailing member has turned past its first page, the leading one
  // is behind the reader and the trailing pages are the position. Until then the position is
  // the leading member's pages, joined by the trailing member's first pages when those follow
  // directly in the page sequence.
  if (last.current > 0) {
    return { start: last.start + last.current, end: last.start + last.current + last.shown };
  }
  const end = first.start + first.current + first.shown;
  return { start: first.start + first.current, end: end === last.start ? end + last.shown : end };
}

function calibratedProjection(input: ReaderProgressInput): ReaderProgressProjection | null {
  const { committed, localPagination, pagination } = input;
  if (
    committed === null ||
    localPagination === null ||
    !input.foregroundPaginated ||
    input.pendingForegroundLayout ||
    input.scrollFollowing === true ||
    pagination === null ||
    pagination.freshness !== "current" ||
    pagination.estimatedTotalPageCount === null
  ) {
    return null;
  }
  const occurrence = committed.occurrence;
  const estimatedStart = pagination.estimatedPageStart(occurrence);
  const estimatedCount = pagination.estimatedPageCount(occurrence);
  if (estimatedStart === null || estimatedCount === null) return null;
  // The whole-book estimate moves with every measured chapter; hold the numbers the reader is
  // looking at until they leave the chapter or the basis changes. Leaving to a neighbouring
  // chapter continues the held numbering, and the total only moves for a material change, so
  // page turns never count backwards and the total does not flicker by a few pages.
  const retained = input.retained;
  const previous =
    retained?.accuracy === "calibrated" &&
    retained.occurrence !== null &&
    retained.pages.kind === "calibrated-pages" &&
    retained.pages.runRevision === pagination.runRevision
      ? { occurrence: retained.occurrence, pages: retained.pages }
      : null;
  const held = previous?.occurrence === occurrence ? previous.pages : null;
  const occurrenceStart =
    held?.occurrenceStart ??
    continuedOccurrenceStart(pagination, previous, occurrence) ??
    estimatedStart;
  const localStart = Math.min(
    Math.max(0, Math.trunc(localPagination.firstVisiblePage)),
    Math.max(0, localPagination.pageCount - 1),
  );
  const first = occurrenceStart + localStart;
  const last = first + Math.max(1, Math.trunc(localPagination.visiblePageCount));
  const estimatedTotal =
    pagination.estimatedTotalPageCount - estimatedCount + localPagination.pageCount;
  const total = Math.max(
    last,
    held?.total ?? dampedTotal(previous?.pages.total ?? null, estimatedTotal),
  );
  const pages: ReaderPageMetadata = {
    kind: "calibrated-pages",
    visible: { start: first, end: Math.min(total, last) },
    total,
    occurrenceStart,
    runRevision: pagination.runRevision,
  };
  return {
    accuracy: "calibrated",
    freshness: "current",
    occurrence,
    coordinate: pageStartCoordinate(pages.visible.start, total - 1),
    pages,
    markers: projectedMarkers(input),
    label: `${pageRangeText(pages.visible)} / ~${total}`,
    accessibleLabel: accessibleProgressLabel(pages, "calibrated", "current"),
  };
}

const calibratedTotalTolerance = 0.05;

function dampedTotal(previous: number | null, estimated: number): number {
  return previous !== null && Math.abs(estimated - previous) <= previous * calibratedTotalTolerance
    ? previous
    : estimated;
}

function continuedOccurrenceStart(
  pagination: BookPaginationSnapshot,
  previous: {
    readonly occurrence: number;
    readonly pages: { readonly occurrenceStart: number };
  } | null,
  occurrence: number,
): number | null {
  if (previous === null) return null;
  if (occurrence === previous.occurrence + 1) {
    const count = occurrencePageCount(pagination, previous.occurrence);
    return count === null ? null : previous.pages.occurrenceStart + count;
  }
  if (occurrence === previous.occurrence - 1) {
    const count = occurrencePageCount(pagination, occurrence);
    return count === null ? null : Math.max(0, previous.pages.occurrenceStart - count);
  }
  return null;
}

function occurrencePageCount(
  pagination: BookPaginationSnapshot,
  occurrence: number,
): number | null {
  const entry = pagination.occurrences[occurrence];
  return entry?.state === "measured" ? entry.pageCount : pagination.estimatedPageCount(occurrence);
}

function estimatedProjection(input: ReaderProgressInput): ReaderProgressProjection {
  const coordinate =
    input.committed === null || input.readingOrderLength === 0
      ? 0
      : clamp(
          (input.committed.occurrence + clamp(input.renderedProgress)) / input.readingOrderLength,
        );
  const pages: ReaderPageMetadata = { kind: "percentage", value: Math.round(coordinate * 100) };
  return {
    accuracy: "estimated",
    freshness: "current",
    occurrence: input.committed?.occurrence ?? null,
    coordinate,
    pages,
    markers: projectedMarkers(input),
    label: `${pages.value}%`,
    accessibleLabel: accessibleProgressLabel(pages, "estimated", "current"),
  };
}

function projectedMarkers(input: ReaderProgressInput): ReaderMarkerProjection {
  return (
    currentCatalogMarkers(input) ??
    retainedMarkers(input) ??
    calibratedMarkers(input) ??
    estimatedMarkers(input)
  );
}

function calibratedMarkers(input: ReaderProgressInput): ReaderMarkerProjection | null {
  const pagination = input.pagination;
  if (
    pagination === null ||
    pagination.freshness !== "current" ||
    pagination.estimatedTotalPageCount === null
  ) {
    return null;
  }
  let byToc = calibratedMarkerCache.get(pagination);
  if (byToc === undefined) {
    byToc = new WeakMap();
    calibratedMarkerCache.set(pagination, byToc);
  }
  let byWidth = byToc.get(input.toc);
  if (byWidth === undefined) {
    byWidth = new Map();
    byToc.set(input.toc, byWidth);
  }
  const key = `${String(input.railPixelWidth)}:${input.committed?.occurrence ?? "none"}:${input.committed?.resource ?? "none"}`;
  if (byWidth.has(key)) return byWidth.get(key) ?? null;
  // Chapter starts only: located TOC targets arrive one at a time, and the exact marker set
  // replaces this one atomically once every target has settled.
  const total = pagination.estimatedTotalPageCount;
  const candidates: ReaderProgressMarker[] = [];
  let authoredOrdinal = 0;
  let coherent = true;
  visitPoints(input.toc, 1, (point, depth) => {
    const ordinal = authoredOrdinal++;
    for (const occurrence of selectedMarkerOccurrences(point, input.committed)) {
      const start = pagination.estimatedPageStart(occurrence);
      if (start === null) {
        coherent = false;
        return;
      }
      candidates.push({
        identity: `${ordinal}:${occurrence}`,
        coordinate: pageStartCoordinate(start, total - 1),
        depth,
        authoredOrdinal: ordinal,
      });
    }
  });
  const projection: ReaderMarkerProjection | null = coherent
    ? {
        state: "estimated",
        freshness: "current",
        markers: collideMarkers(candidates, input.railPixelWidth),
      }
    : null;
  byWidth.set(key, projection);
  return projection;
}

function currentCatalogMarkers(input: ReaderProgressInput): ReaderMarkerProjection | null {
  const pagination = input.pagination;
  if (
    pagination === null ||
    pagination.freshness !== "current" ||
    pagination.pageCountCoverage.state !== "exact" ||
    pagination.totalPageCount === null
  ) {
    return null;
  }
  let byToc = exactMarkerCache.get(pagination);
  if (byToc === undefined) {
    byToc = new WeakMap();
    exactMarkerCache.set(pagination, byToc);
  }
  let byWidth = byToc.get(input.toc);
  if (byWidth === undefined) {
    byWidth = new Map();
    byToc.set(input.toc, byWidth);
  }
  const railEnd = bookRailEnd(pagination, input.finalSpreadLeadingOccurrence ?? null);
  const key = `${String(input.railPixelWidth)}:${String(railEnd)}:${input.committed?.occurrence ?? "none"}:${input.committed?.resource ?? "none"}`;
  if (byWidth.has(key)) return byWidth.get(key) ?? null;
  const markers = exactMarkers(
    input.toc,
    input.committed,
    pagination,
    input.railPixelWidth,
    railEnd,
  );
  const coherent = markers.state === "exact" ? markers : null;
  byWidth.set(key, coherent);
  return coherent;
}

function retainedMarkers(input: ReaderProgressInput): ReaderMarkerProjection | null {
  if (input.retained?.accuracy !== "exact" || !markerRetentionIsApplicable(input)) return null;
  return { ...input.retained.markers, freshness: "retained" };
}

function markerRetentionIsApplicable(input: ReaderProgressInput): boolean {
  if (input.pendingForegroundLayout) return true;
  const pagination = input.pagination;
  if (pagination === null) return false;
  if (pagination.freshness === "candidate-pending") return true;
  if (
    pagination.tocEnrichment.state === "pending" &&
    (pagination.activity === "enriching-toc" || pagination.activity === "paused")
  )
    return true;
  if (pagination.activity === "idle" || pagination.activity === "paused") return false;
  return (
    pagination.freshness === "stale" ||
    pagination.pageCountCoverage.state !== "exact" ||
    pagination.foreground.state === "pending"
  );
}

function estimatedMarkers(input: ReaderProgressInput): ReaderMarkerProjection {
  let byBasis = estimatedMarkerCache.get(input.toc);
  if (byBasis === undefined) {
    byBasis = new Map();
    estimatedMarkerCache.set(input.toc, byBasis);
  }
  const key = `${input.readingOrderLength}:${String(input.railPixelWidth)}:${input.committed?.occurrence ?? "none"}:${input.committed?.resource ?? "none"}`;
  const cached = byBasis.get(key);
  if (cached !== undefined) return cached;
  const projection: ReaderMarkerProjection = {
    state: "estimated",
    freshness: "current",
    markers: collideMarkers(
      estimatedMarkerCandidates(input.toc, input.committed, input.readingOrderLength),
      input.railPixelWidth,
    ),
  };
  byBasis.set(key, projection);
  return projection;
}

function exactMarkers(
  points: readonly JoinedTocPoint[],
  committed: ReaderProgressInput["committed"],
  pagination: BookPaginationSnapshot,
  railPixelWidth: number | null,
  railEnd: number | null,
): ReaderMarkerProjection {
  const total = pagination.totalPageCount;
  if (total === null || railEnd === null)
    return { state: "pending", freshness: "current", markers: [] };
  const candidates: ReaderProgressMarker[] = [];
  const targetIndexes = new Map<number, ReadonlyMap<string, TocTargetPagination>>();
  let authoredOrdinal = 0;
  let state: ReaderMarkerProjection["state"] = "exact";
  visitPoints(points, 1, (point, depth) => {
    const ordinal = authoredOrdinal++;
    const occurrences = selectedMarkerOccurrences(point, committed);
    if (occurrences.length === 0) {
      state = "ambiguous";
      return;
    }
    let projected = 0;
    for (const occurrence of occurrences) {
      const pageStart = pagination.pageStart(occurrence);
      if (
        typeof pageStart === "number" &&
        isAddressedTarget(point.target) &&
        point.target.fragment === null
      ) {
        candidates.push({
          identity: `${ordinal}:${occurrence}`,
          coordinate: pageStartCoordinate(pageStart, railEnd),
          depth,
          authoredOrdinal: ordinal,
        });
        projected += 1;
        continue;
      }
      const entry = pagination.occurrences[occurrence];
      let targetIndex = targetIndexes.get(occurrence);
      if (targetIndex === undefined && entry?.state === "measured") {
        targetIndex = new Map(
          entry.tocTargets.map((target) => [
            `${target.listIndex}:${target.pointPath.join("/")}`,
            target,
          ]),
        );
        targetIndexes.set(occurrence, targetIndex);
      }
      const target = targetIndex?.get(`${point.listIndex}:${point.pointPath.join("/")}`);
      if (typeof pageStart === "number" && target?.result.state === "located") {
        candidates.push({
          identity: `${ordinal}:${occurrence}`,
          coordinate: pageStartCoordinate(pageStart + target.result.physicalPage, railEnd),
          depth,
          authoredOrdinal: ordinal,
        });
        projected += 1;
      } else if (target?.result.state === "pending" || pageStart === "pending") {
        if (state === "exact") state = "pending";
      } else {
        state = "ambiguous";
      }
    }
    if (projected !== occurrences.length) state = "ambiguous";
  });
  return { state, freshness: "current", markers: collideMarkers(candidates, railPixelWidth) };
}

function estimatedMarkerCandidates(
  points: readonly JoinedTocPoint[],
  committed: ReaderProgressInput["committed"],
  readingOrderLength: number,
): readonly ReaderProgressMarker[] {
  if (readingOrderLength === 0) return [];
  const candidates: ReaderProgressMarker[] = [];
  let authoredOrdinal = 0;
  visitPoints(points, 1, (point, depth) => {
    const ordinal = authoredOrdinal++;
    for (const occurrence of selectedMarkerOccurrences(point, committed)) {
      candidates.push({
        identity: `${ordinal}:${occurrence}`,
        coordinate: clamp(occurrence / readingOrderLength),
        depth,
        authoredOrdinal: ordinal,
      });
    }
  });
  return candidates;
}

function selectedMarkerOccurrences(
  point: JoinedTocPoint,
  committed: ReaderProgressInput["committed"],
): readonly number[] {
  if (
    committed !== null &&
    point.resource === committed.resource &&
    point.occurrences.includes(committed.occurrence)
  ) {
    return [committed.occurrence];
  }
  const first = point.occurrences[0];
  return first === undefined ? [] : [first];
}

function collideMarkers(
  candidates: readonly ReaderProgressMarker[],
  railPixelWidth: number | null,
): readonly ReaderProgressMarker[] {
  const threshold = railPixelWidth !== null && railPixelWidth > 0 ? 6 / railPixelWidth : 0;
  const selected: ReaderProgressMarker[] = [];
  const exactCoordinates = new Set<number>();
  const coordinateBuckets = new Map<number, number[]>();
  for (const candidate of [...candidates].sort(
    (left, right) => left.depth - right.depth || left.authoredOrdinal - right.authoredOrdinal,
  )) {
    if (threshold === 0) {
      if (exactCoordinates.has(candidate.coordinate)) continue;
      exactCoordinates.add(candidate.coordinate);
    } else {
      const bucket = Math.floor(candidate.coordinate / threshold);
      let collides = false;
      for (let neighbor = bucket - 1; neighbor <= bucket + 1 && !collides; neighbor += 1) {
        collides =
          coordinateBuckets
            .get(neighbor)
            ?.some((coordinate) => Math.abs(coordinate - candidate.coordinate) < threshold) ??
          false;
      }
      if (collides) continue;
      const coordinates = coordinateBuckets.get(bucket) ?? [];
      coordinates.push(candidate.coordinate);
      coordinateBuckets.set(bucket, coordinates);
    }
    selected.push(candidate);
  }
  return selected.sort(
    (left, right) =>
      left.coordinate - right.coordinate ||
      left.depth - right.depth ||
      left.authoredOrdinal - right.authoredOrdinal,
  );
}

function visitPoints(
  points: readonly JoinedTocPoint[],
  depth: number,
  visit: (point: JoinedTocPoint, depth: 1 | 2 | 3 | 4) => void,
): void {
  for (const point of points) {
    if (point.point.hidden) continue;
    visit(point, depth <= 1 ? 1 : depth === 2 ? 2 : depth === 3 ? 3 : 4);
    visitPoints(point.children, depth + 1, visit);
  }
}

function physicalPageLabel(pages: Extract<ReaderPageMetadata, { kind: "physical-pages" }>): string {
  return `${pageRangeText(pages.visible)} / ${pages.total}`;
}

function pageRangeText(visible: ProgressInterval): string {
  const first = visible.start + 1;
  const last = visible.end;
  return `${first}${last === first ? "" : `-${last}`}`;
}

function accessibleProgressLabel(
  pages: ReaderPageMetadata,
  accuracy: ReaderProgressProjection["accuracy"],
  freshness: ReaderProgressProjection["freshness"],
): string {
  const qualifier =
    freshness === "retained"
      ? accuracy === "exact"
        ? "Retained exact progress"
        : "Retained estimated progress"
      : accuracy === "exact"
        ? "Exact progress"
        : "Estimated progress";
  if (pages.kind === "percentage") return `${qualifier}, ${pages.value} percent`;
  const first = pages.visible.start + 1;
  const last = pages.visible.end;
  const total = pages.kind === "calibrated-pages" ? `about ${pages.total}` : String(pages.total);
  return `${qualifier}, ${last === first ? `page ${first}` : `pages ${first} to ${last}`} of ${total}`;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
