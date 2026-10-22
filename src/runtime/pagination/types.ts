import type { PresentationPreferences } from "../../generated/kernel.js";
import type { TocTargetPageResult } from "../agent-protocol/index.js";

export type PaginationCancellationReason =
  | "basis-change"
  | "close"
  | "foreground-work"
  | "hidden"
  | "layout-invalidated"
  | "owner-superseded"
  | "timeout"
  | "delivery-failed"
  | "stale-generation"
  | "unstable";

export interface TocTargetPagination {
  readonly listIndex: number;
  readonly pointPath: readonly number[];
  readonly result: TocTargetPageResult | { readonly state: "pending" };
}

export type OccurrencePagination = {
  readonly occurrence: number;
  readonly resource: string | null;
} & (
  | { readonly state: "pending" }
  | { readonly state: "measuring" }
  | {
      readonly state: "measured";
      readonly pageCount: number;
      /** Pages the measured layout shows at once, so the final view of the book is derivable. */
      readonly columnsPerView: 1 | 2;
      readonly tocTargets: readonly TocTargetPagination[];
      readonly source: "foreground" | "background";
    }
  | { readonly state: "inapplicable"; readonly reason: string }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "failed"; readonly message: string }
);

export interface PaginationBasis {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly preferences: Omit<PresentationPreferences, "theme">;
  readonly userAgent: string;
  readonly devicePixelRatio: number;
}

export interface BookPaginationSnapshot {
  readonly publicationSequence?: number | undefined;
  readonly runRevision: number;
  readonly basis: PaginationBasis;
  readonly freshness: "current" | "candidate-pending" | "stale";
  readonly activity: "idle" | "measuring-pages" | "enriching-toc" | "paused";
  readonly foreground:
    | { readonly state: "pending" | "unavailable" }
    | {
        readonly state: "current";
        readonly occurrence: number;
        readonly resource: string;
        readonly documentGeneration: number;
        readonly layoutGeneration: number;
        readonly pageCount: number;
      };
  readonly pageCountCoverage: {
    readonly state: "incomplete" | "exact" | "unavailable";
    readonly measuredOccurrences: number;
    readonly totalOccurrences: number;
    readonly measuredPageCount: number;
    readonly totalPageCount: number | null;
  };
  readonly tocEnrichment: {
    readonly state: "pending" | "complete";
    readonly measuredTargets: number;
    readonly totalTargets: number;
  };
  readonly state: "idle" | "measuring" | "paused" | "complete" | "stale";
  /**
   * Whether the measured counts this session owns have reached the cache. Counts are held back
   * until the catalog completes and then debounced, so `pending` outlasts `pageCountCoverage`
   * reaching `exact`; a host waits for `idle` before discarding the page.
   */
  readonly cachePersistence: "idle" | "pending" | "unavailable";
  readonly occurrences: readonly OccurrencePagination[];
  readonly pageStart: (occurrence: number) => number | "pending" | null;
  readonly measuredPageCount: number;
  readonly totalPageCount: number | null;
  /** Calibrated whole-book estimate; null until a weighted occurrence has been measured. */
  readonly estimatedTotalPageCount: number | null;
  readonly estimatedPageStart: (occurrence: number) => number | null;
  readonly estimatedPageCount: (occurrence: number) => number | null;
}

export type PaginationSnapshotListener = (snapshot: BookPaginationSnapshot) => void;

export interface ForegroundPreparationClaim {
  readonly occurrence: number;
  readonly token: number;
  readonly runRevision: number;
}

export type NavigatorDiagnosticEvent =
  | {
      readonly type: "font-evidence";
      readonly target: "publication";
      readonly family: "navigator-reader-serif";
      readonly frameGeneration: number;
      readonly configured: boolean;
      readonly declared: boolean;
      readonly loaded: boolean;
      readonly check: boolean;
    }
  | {
      readonly type: "layout";
      readonly action: "start" | "settle" | "cancel" | "discard";
      readonly role: "foreground" | "auxiliary";
      readonly documentGeneration: number;
      readonly layoutGeneration: number;
      readonly operation: number;
      readonly phase: "initial" | "update";
      readonly durationMs?: number | undefined;
      readonly reason?: PaginationCancellationReason | undefined;
    }
  | {
      readonly type: "layout-phase";
      readonly role: "foreground" | "auxiliary" | "prepared";
      readonly frameGeneration: number;
      readonly operation: number | null;
      readonly phase: string;
      readonly durationMs: number;
      readonly scanCount?: number | undefined;
      readonly rectangleCount?: number | undefined;
    }
  | {
      readonly type: "pagination-run";
      readonly action: "start" | "terminal";
      readonly runRevision: number;
      readonly durationMs: number;
      readonly measuredOccurrences: number;
      readonly totalOccurrences: number;
      readonly measuredPageCount: number;
      readonly totalPageCount: number | null;
      readonly measuredTargets: number;
      readonly totalTargets: number;
      readonly outcome: "running" | "complete" | "unavailable" | "superseded" | "cancelled";
      /** Background page-count task starts in this run, including retries. */
      readonly pageCountAttempts: number;
      /** Distinct occurrences whose page-count task timed out at least once. */
      readonly timedOutOccurrences: number;
      /** Wall time spent in background page-count tasks. */
      readonly measurementMs: number;
    }
  | {
      readonly type: "frame-lifecycle";
      readonly action: "terminal";
      readonly frameGeneration: number;
      readonly occurrence: number;
      readonly role: "foreground" | "auxiliary" | "prepared";
      readonly outcome: "committed" | "prepared" | "failed" | "cancelled";
      readonly reason:
        | "complete"
        | "load-error"
        | "unexpected-navigation"
        | "effect-execution-failed"
        | "readiness-timeout"
        | "layout-conflict"
        | "layout-unavailable"
        | "superseded"
        | "closed";
      readonly createToLoadMs?: number | undefined;
      readonly loadToAgentReadyMs?: number | undefined;
      readonly agentReadyToCommitMs?: number | undefined;
      readonly createToTerminalMs: number;
    }
  | {
      readonly type: "derived-build";
      readonly build: "toc-index" | "prefix-index";
      readonly durationMs: number;
      readonly itemCount: number;
      readonly rectangleCount?: number | undefined;
    }
  | {
      readonly type: "controller-task";
      readonly action: "schedule" | "start" | "pause" | "requeue" | "complete" | "discard";
      readonly task: "page-count" | "toc";
      readonly occurrence: number;
      readonly runRevision: number;
      readonly taskGeneration: number;
      readonly documentGeneration?: number | undefined;
      readonly layoutGeneration?: number | undefined;
      readonly reason?: PaginationCancellationReason | undefined;
    }
  | {
      readonly type: "cache";
      readonly action: "read" | "write" | "remove";
      readonly recordType?: ("page" | "toc-target") | undefined;
      readonly occurrence: number;
      readonly bytes: number;
      readonly durationMs: number;
      readonly outcome: "hit" | "miss" | "complete" | "cancelled" | "failed" | "invalid";
    }
  | {
      readonly type: "cache-restore";
      readonly action: "start" | "complete" | "stalled" | "cancelled";
      readonly runRevision: number;
      readonly claimedOccurrences: number;
      readonly remainingOccurrences: number;
      readonly durationMs: number;
    }
  | {
      readonly type: "cache-write";
      readonly action: "start" | "complete" | "cancelled" | "failed";
      /** Monotonically increasing and unique within one pagination controller. */
      readonly operationId: number;
      readonly runRevision: number;
      readonly occurrenceCount: number;
      readonly operationCount: number;
      readonly completedOperationCount: number;
      readonly durationMs: number;
    }
  | {
      /** Drain of page-record persistence jobs, including their TOC-record mutations. */
      readonly type: "cache-drain";
      readonly runRevision: number;
      readonly outcome: "durable" | "failed" | "cancelled";
      readonly durationMs: number;
    }
  | {
      readonly type: "auxiliary";
      readonly action: "create" | "remove";
      readonly sessions: number;
      readonly frames: number;
      readonly sessionGeneration: number;
    }
  | {
      readonly type: "operation-owner";
      readonly action: "register" | "complete" | "cancel" | "discard";
      readonly operationKind: "layout" | "locator" | "presentation" | "toc";
      readonly operation: number;
      readonly documentGeneration: number;
      readonly layoutGeneration?: number | undefined;
      readonly reason?: PaginationCancellationReason | undefined;
    }
  | {
      readonly type: "controller-update";
      readonly sequence: number;
      readonly stateRevision: number;
      readonly documentPending: boolean;
      readonly layoutOwner: "document" | "fixed-companion" | "prepared-frame" | null;
    }
  | {
      readonly type: "controller-publish";
      readonly sequence: number;
      readonly runRevision: number;
      readonly activity: BookPaginationSnapshot["activity"];
      readonly freshness: BookPaginationSnapshot["freshness"];
      readonly foreground: BookPaginationSnapshot["foreground"]["state"];
      readonly coverage: BookPaginationSnapshot["pageCountCoverage"]["state"];
      readonly measuredOccurrences: number;
      readonly totalOccurrences: number;
      readonly totalPageCount: number | null;
      readonly toc: BookPaginationSnapshot["tocEnrichment"]["state"];
      readonly measuredTargets: number;
      readonly totalTargets: number;
    }
  | {
      /** One annotations-surface render. Reported only when diagnostics are enabled. */
      readonly type: "annotations-render";
      readonly sequence: number;
    }
  | {
      readonly type: "reader-render";
      readonly sequence: number;
      readonly publicationSequence: number | null;
      readonly stateRevision: number | null;
      readonly readerStatus: "ready" | "network" | "loading" | "issue";
      readonly publicationVisible: boolean;
      readonly progressAccuracy: "exact" | "calibrated" | "estimated";
      readonly progressFreshness: "current" | "retained";
    };

export interface NavigatorDiagnostics {
  /** `summary` delivers only reader, run, cache persistence, terminal-frame, and font evidence events. */
  readonly level: "summary" | "trace";
  readonly record: (event: NavigatorDiagnosticEvent) => void;
  readonly now?: (() => number) | undefined;
}

const summaryEventTypes: ReadonlySet<NavigatorDiagnosticEvent["type"]> = new Set([
  "reader-render",
  "pagination-run",
  "cache-restore",
  "cache-write",
  "cache-drain",
  "frame-lifecycle",
  "font-evidence",
]);

export function recordNavigatorDiagnostic(
  diagnostics: NavigatorDiagnostics | null | undefined,
  event: NavigatorDiagnosticEvent,
): void {
  if (diagnostics === null || diagnostics === undefined) return;
  if (diagnostics.level === "summary" && !summaryEventTypes.has(event.type)) return;
  try {
    diagnostics.record(event);
  } catch {
    // Diagnostics are passive and cannot affect reader behavior.
  }
}
