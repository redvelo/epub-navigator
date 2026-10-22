import { useEffect, useRef } from "react";
import type { VisibleOccurrenceRange } from "../../generated/kernel.js";
import type { BookPaginationSnapshot } from "../../runtime/pagination/index.js";
import type { ReaderSessionId } from "../../publication.js";
import {
  authoredPageRangeAtPages,
  currentAuthoredPageRange,
  type AuthoredNavigationProjection,
  type AuthoredPageContextTarget,
  type AuthoredPageRange,
} from "../navigation/model.js";
import {
  projectReaderProgress,
  sectionPageLabel,
  type ReaderProgressProjection,
  type RetainedBookProgress,
  type ReaderProgressInput,
} from "./projection.js";
import type { MeasuredAuthoredPages } from "./authored-pages.js";

export interface ReaderProgressPort {
  readonly sessionId: ReaderSessionId;
  readonly authoredNavigation: AuthoredNavigationProjection;
  readonly tocPoints: Parameters<typeof projectReaderProgress>[0]["toc"];
  readonly committed: Parameters<typeof projectReaderProgress>[0]["committed"] extends infer _
    ? { readonly occurrence: number; readonly resource: string; readonly generation: number } | null
    : never;
  readonly committedLayout: Parameters<typeof projectReaderProgress>[0]["committedLayout"];
  readonly localPagination: Parameters<typeof projectReaderProgress>[0]["localPagination"];
  readonly pendingForegroundLayout: boolean;
  readonly readingOrderLength: number;
  readonly renderedProgress: number;
  readonly visibleOccurrenceRange: VisibleOccurrenceRange | null;
  readonly finalSpreadLeadingOccurrence: number | null;
  readonly companionPagination: ReaderProgressInput["companionPagination"];
  readonly scrollFollowing: boolean;
  readonly paginationSnapshot: BookPaginationSnapshot | null;
  readonly railPixelWidth: number | null;
  readonly measuredAuthoredPages: MeasuredAuthoredPages | null;
  readonly pageContextTargets: readonly AuthoredPageContextTarget[];
  readonly pageContextPredecessorLabel: string | null;
  readonly pageContextLayoutGeneration: number | undefined;
  readonly committedOccurrence: number | undefined;
  readonly committedFrameGeneration: number | undefined;
  readonly committedDocumentGeneration: number | undefined;
}

export interface ReaderProgress {
  readonly book: ReaderProgressProjection;
  readonly authoredPageRange: AuthoredPageRange | null;
  readonly topProgressLabel: string;
  readonly topProgressAccessibleLabel: string | undefined;
  readonly pageProgress: ReturnType<typeof sectionPageLabel> | null;
}

/** Projects the reader's position into the labels and rail geometry the chrome renders. */
export function useReaderProgress(port: ReaderProgressPort): ReaderProgress {
  const retained = useRef<RetainedBookProgress | null>(null);
  const exactDocumentPageRange = currentAuthoredPageRange(
    port.authoredNavigation,
    port.committedOccurrence ?? null,
    port.visibleOccurrenceRange,
  );
  const authoredPagePositions =
    port.measuredAuthoredPages?.sessionId === port.sessionId &&
    port.measuredAuthoredPages.occurrence === port.committedOccurrence &&
    port.measuredAuthoredPages.documentGeneration === port.committedDocumentGeneration &&
    port.measuredAuthoredPages.frameGeneration === port.committedFrameGeneration &&
    port.measuredAuthoredPages.layoutGeneration === port.pageContextLayoutGeneration
      ? port.measuredAuthoredPages.positions
      : undefined;
  const predecessorAuthoredPageRange =
    port.pageContextTargets.length > 0 && port.pageContextPredecessorLabel !== null
      ? { first: port.pageContextPredecessorLabel, last: port.pageContextPredecessorLabel }
      : null;
  const authoredPageRange =
    authoredPagePositions === undefined ||
    authoredPagePositions === null ||
    port.localPagination === null
      ? (exactDocumentPageRange ?? predecessorAuthoredPageRange)
      : authoredPageRangeAtPages(
          port.pageContextTargets,
          authoredPagePositions,
          {
            first: port.localPagination.firstVisiblePage,
            last: port.localPagination.firstVisiblePage + port.localPagination.visiblePageCount - 1,
          },
          port.pageContextPredecessorLabel,
        );
  const book = projectReaderProgress({
    toc: port.tocPoints,
    committed: port.committed,
    committedLayout: port.committedLayout,
    foregroundPaginated: port.localPagination !== null,
    pendingForegroundLayout: port.pendingForegroundLayout,
    readingOrderLength: port.readingOrderLength,
    renderedProgress: port.renderedProgress,
    localPagination: port.localPagination,
    visibleOccurrenceRange: port.visibleOccurrenceRange,
    finalSpreadLeadingOccurrence: port.finalSpreadLeadingOccurrence,
    companionPagination: port.companionPagination,
    scrollFollowing: port.scrollFollowing,
    pagination: port.paginationSnapshot,
    railPixelWidth: port.railPixelWidth,
    retained: useRetainedProgress(retained, port.sessionId),
  });
  useEffect(() => {
    if (book.accuracy === "estimated" || book.freshness !== "current") return;
    retained.current = { sessionId: port.sessionId, progress: book };
  }, [book, port.sessionId]);
  return {
    book,
    authoredPageRange,
    topProgressLabel:
      authoredPageRange === null
        ? book.label
        : authoredPageRange.first === authoredPageRange.last
          ? `p. ${authoredPageRange.first}`
          : `p. ${authoredPageRange.first}-${authoredPageRange.last}`,
    topProgressAccessibleLabel:
      authoredPageRange === null
        ? undefined
        : authoredPageRange.first === authoredPageRange.last
          ? `Publication page ${authoredPageRange.first}`
          : `Publication pages ${authoredPageRange.first} to ${authoredPageRange.last}`,
    pageProgress: port.localPagination === null ? null : sectionPageLabel(port.localPagination),
  };
}

/**
 * Reads the retained projection through a hook so the compiler treats each result as a fresh
 * input instead of caching the containing hook against a ref it cannot track.
 */
function useRetainedProgress(
  retained: { current: RetainedBookProgress | null },
  sessionId: ReaderSessionId,
): ReaderProgressProjection | null {
  const current = retained.current;
  return current?.sessionId === sessionId ? current.progress : null;
}
