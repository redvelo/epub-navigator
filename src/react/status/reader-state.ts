import { useEffect, useRef, useState } from "react";
import { recordNavigatorDiagnostic } from "../../runtime/pagination/index.js";
import { useRecentNetworkActivity } from "./network-activity.js";
import type { ReaderStatus } from "./ornament.js";
import type { ReaderError } from "./errors.js";
import type {
  BookPaginationSnapshot,
  NavigatorDiagnostics,
} from "../../runtime/pagination/index.js";
import type { KernelSnapshot, PendingDocument, PhysicalFrame } from "../../generated/kernel.js";
import type { NavigatorReaderProps } from "../public-types.js";
import type { ReaderProgress } from "../progress/use-reader-progress.js";

export type ReaderRenderState =
  | "terminal-error"
  | "recoverable-error"
  | "replacement-pending"
  | "reading"
  | "initial-loading";

export interface ReaderRenderStatus {
  readonly status: ReaderStatus;
  readonly state: ReaderRenderState;
  readonly measuringPages: boolean;
  readonly hasCommittedDocument: boolean;
  readonly readingSurfaceRetained: boolean;
}

// Page turns served by prepared frames and short relayouts settle well within this.
const loadingStatusDelayMs = 200;

/** True once `active` has held for `delayMs`, so work that finishes first never shows a state. */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delayMs]);
  return active && elapsed;
}

/** Reports the render sequence whenever a reader-visible fact changes, not on every commit. */
export function useReaderRenderStatus({
  sessionId,
  networkActivity,
  diagnostics,
  readerRoot,
  renderSequence,
  snapshot,
  paginationSnapshot,
  paginationAvailability,
  committed,
  pending,
  pendingForegroundLayout,
  initialRestorationPending,
  layoutRepairsUnresolved,
  error,
  bookProgress,
}: {
  readonly sessionId: NavigatorReaderProps["session"]["id"];
  readonly networkActivity: NavigatorReaderProps["networkActivity"];
  readonly diagnostics: NavigatorDiagnostics | undefined;
  readonly readerRoot: { readonly current: HTMLElement | null };
  readonly renderSequence: { readonly current: number };
  readonly snapshot: KernelSnapshot | null;
  readonly paginationSnapshot: BookPaginationSnapshot | null;
  readonly paginationAvailability: NavigatorReaderProps["paginationAvailability"];
  readonly committed: PhysicalFrame | null;
  readonly pending: PendingDocument | null;
  readonly pendingForegroundLayout: boolean;
  readonly initialRestorationPending: boolean;
  readonly layoutRepairsUnresolved: boolean;
  readonly error: ReaderError | null;
  readonly bookProgress: ReaderProgress["book"];
}): ReaderRenderStatus {
  const recentNetworkActivity = useRecentNetworkActivity(sessionId, networkActivity);
  const loading = useDelayedFlag(
    initialRestorationPending ||
      pending !== null ||
      pendingForegroundLayout ||
      (paginationAvailability === "pending" && committed === null),
    loadingStatusDelayMs,
  );
  const status: ReaderStatus =
    error !== null || layoutRepairsUnresolved || paginationAvailability === "unavailable"
      ? "issue"
      : loading
        ? "loading"
        : recentNetworkActivity
          ? "network"
          : "ready";
  const hasCommittedDocument = committed !== null && !initialRestorationPending;
  // "Opening publication" is a first-open surface. In a roll the current page follows the
  // scroll, so a page that has not committed yet must not blank a book already being read.
  const [readingBegun, setReadingBegun] = useState<string | null>(null);
  if (hasCommittedDocument && readingBegun !== sessionId) setReadingBegun(sessionId);
  const diagnosticKey = JSON.stringify([
    paginationSnapshot?.publicationSequence ?? null,
    snapshot?.stateRevision ?? null,
    status,
    hasCommittedDocument,
    bookProgress.accuracy,
    bookProgress.freshness,
  ]);
  const lastDiagnosticKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastDiagnosticKey.current === diagnosticKey) return;
    lastDiagnosticKey.current = diagnosticKey;
    readerRoot.current?.setAttribute("data-reader-render-sequence", String(renderSequence.current));
    recordNavigatorDiagnostic(diagnostics, {
      type: "reader-render",
      sequence: renderSequence.current,
      publicationSequence: paginationSnapshot?.publicationSequence ?? null,
      stateRevision: snapshot?.stateRevision ?? null,
      readerStatus: status,
      publicationVisible: hasCommittedDocument,
      progressAccuracy: bookProgress.accuracy,
      progressFreshness: bookProgress.freshness,
    });
  });
  return {
    status,
    state:
      error?.terminal === true
        ? "terminal-error"
        : error !== null
          ? "recoverable-error"
          : committed !== null && pending !== null
            ? "replacement-pending"
            : hasCommittedDocument
              ? "reading"
              : "initial-loading",
    measuringPages: paginationSnapshot?.activity === "measuring-pages",
    hasCommittedDocument,
    readingSurfaceRetained: readingBegun === sessionId && snapshot?.publicationLayout === "roll",
  };
}
