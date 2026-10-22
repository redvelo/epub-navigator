import type { KernelSnapshot, ReflowableSettlement } from "../../generated/kernel.js";
import { viewColumns } from "../agent-protocol/index.js";
import {
  currentDocument,
  currentFixedSettlement,
  currentFrame,
  currentReflowSettlement,
  foregroundLayoutPending,
} from "../kernel-view.js";
import type { BookPaginationSnapshot } from "./types.js";

export type ForegroundReconciliation =
  | { readonly state: "busy" }
  | { readonly state: "unavailable"; readonly occurrence?: number; readonly reason?: string }
  | { readonly state: "inapplicable"; readonly occurrence: number; readonly reason: string }
  | {
      readonly state: "candidate";
      readonly foreground: Extract<BookPaginationSnapshot["foreground"], { state: "current" }>;
      readonly durable: boolean;
      readonly timedOut: boolean;
      readonly identity: string;
    };

/** Purely classifies a browser-authoritative snapshot; it cannot commit controller state. */
export function reconcileForeground(
  snapshot: KernelSnapshot,
  runRevision: number,
): ForegroundReconciliation {
  if (snapshot.document.pending !== null || foregroundLayoutPending(snapshot))
    return { state: "busy" };
  const committed = currentDocument(snapshot);
  const frame = currentFrame(snapshot);
  const layout = committed?.layout.layout;
  if (
    committed === null ||
    frame === null ||
    layout === undefined ||
    layout.documentGeneration !== committed.generation
  ) {
    return { state: "unavailable" };
  }
  const fixed = currentFixedSettlement(snapshot);
  const reflow = currentReflowSettlement(snapshot);
  if (fixed === null && reflow === null) {
    return {
      state: "unavailable",
      occurrence: frame.occurrence,
      reason: fixedAdapterUnavailableReason(frame.adapter),
    };
  }
  if (reflow?.mode !== undefined && reflow.mode !== "paginated") {
    return {
      state: "inapplicable",
      occurrence: frame.occurrence,
      reason: "effective-presentation-not-paginated",
    };
  }
  if (reflow?.pages.layoutRepairs.status === "unresolved") {
    return {
      state: "unavailable",
      occurrence: frame.occurrence,
      reason: "unresolved-text-pagination",
    };
  }
  const pageCount = fixed === null ? reflow?.pages.pageCount : 1;
  if (pageCount === undefined) return { state: "unavailable" };
  return {
    state: "candidate",
    identity: `${runRevision}:${committed.generation}:${layout.layoutGeneration}`,
    foreground: {
      state: "current",
      occurrence: frame.occurrence,
      resource: frame.resource,
      documentGeneration: committed.generation,
      layoutGeneration: layout.layoutGeneration,
      pageCount,
    },
    durable: fixed !== null || durable(reflow),
    timedOut: timedOut(reflow),
  };
}

function timedOut(layout: ReflowableSettlement | null): boolean {
  return (
    layout?.measurement.requiredFonts === "timed-out" ||
    layout?.measurement.requiredResources === "timed-out"
  );
}

function durable(layout: ReflowableSettlement | null): boolean {
  return (
    layout?.measurement.requiredFonts === "loaded" &&
    layout.measurement.requiredResources === "loaded"
  );
}

import type { CommittedLayout } from "../../generated/kernel.js";
import { currentPaginatedLayout, pendingDocumentFrame } from "../kernel-view.js";
import { fixedAdapterUnavailableReason, layoutSettlementIsDurable } from "./classification.js";
import {
  auxiliaryMaximumDeferralMs,
  tocEnrichmentDeadlineMs,
  tocEnrichmentSliceMs,
} from "./constants.js";
import { PreparedPaginationController } from "./prepared-measurement.js";
import { enrichTocTargets } from "./toc-enrichment.js";

interface ForegroundTargetOwner {
  readonly channel: "foreground";
  readonly occurrence: number;
  readonly operationKey: string;
  readonly token: number;
  readonly documentGeneration: number;
  readonly layoutGeneration: number;
}

export abstract class ForegroundPaginationController extends PreparedPaginationController {
  updateForeground(snapshot: KernelSnapshot): void {
    if (this._closed) return;
    this._record({
      type: "controller-update",
      sequence: ++this._updateSequence,
      stateRevision: snapshot.stateRevision,
      documentPending: snapshot.document.pending !== null,
      layoutOwner: snapshot.layout.pending?.owner.kind ?? null,
    });
    const pendingFrame =
      snapshot.document.pending === null ? null : pendingDocumentFrame(snapshot.document.pending);
    const foregroundOccurrence =
      pendingFrame?.occurrence ?? currentFrame(snapshot)?.occurrence ?? null;
    if (foregroundOccurrence !== this._foregroundOccurrence) {
      this._foregroundOccurrence = foregroundOccurrence;
      this._rebuildWorkQueue();
    }
    const busy = snapshot.document.pending !== null || foregroundLayoutPending(snapshot);
    if (busy !== this._foregroundBusy) {
      this._foregroundBusy = busy;
      if (busy) {
        const activityAt = this._lastForegroundActivityAt;
        this._quietAfterForegroundWork =
          activityAt !== null && this._now() - activityAt <= auxiliaryMaximumDeferralMs;
        this._pause();
      } else {
        if (this._quietAfterForegroundWork) this._lastForegroundActivityAt = this._now();
        this._quietAfterForegroundWork = false;
        this._schedule();
      }
    }
    if (busy) {
      this._foreground = { state: "pending" };
      this._cancelForegroundSettlement();
      if (
        snapshot.document.committed !== null &&
        snapshot.layout.pending?.owner.kind === "document" &&
        snapshot.layout.pending.owner.documentGeneration === snapshot.document.committed.generation
      ) {
        this._freshness = "candidate-pending";
      }
      this._publish();
      return;
    }
    if (this._freshness === "candidate-pending") {
      this._freshness = "current";
      this._foreground = this._currentForeground ?? { state: "unavailable" };
      this._publish();
    }
    if (this._debounceTimer !== null) {
      this._cancelForegroundSettlement();
      return;
    }
    const committed = currentDocument(snapshot);
    const frame = currentFrame(snapshot);
    const layout = committed?.layout.layout ?? null;
    if (
      committed === null ||
      layout === null ||
      frame === null ||
      layout.documentGeneration !== committed.generation
    ) {
      this._foreground = { state: "unavailable" };
      this._currentForeground = null;
      this._cancelForegroundSettlement();
      this._publish();
      return;
    }
    const fixedSettlement = currentFixedSettlement(snapshot);
    if (fixedSettlement !== null) {
      this._cancelForegroundSettlement();
      const key = `${this._runRevision}:${committed.generation}:${layout.layoutGeneration}`;
      if (
        this._currentForeground?.occurrence === frame.occurrence &&
        this._currentForeground.resource === frame.resource &&
        this._currentForeground.documentGeneration === committed.generation &&
        this._currentForeground.layoutGeneration === layout.layoutGeneration &&
        this._currentForeground.pageCount === 1
      ) {
        this._foreground = this._currentForeground;
        return;
      }
      this._foregroundCandidateKey = key;
      this._currentForeground = {
        state: "current",
        occurrence: frame.occurrence,
        resource: frame.resource,
        documentGeneration: committed.generation,
        layoutGeneration: layout.layoutGeneration,
        pageCount: 1,
      };
      this._foreground = this._currentForeground;
      this._setMeasured(frame.occurrence, frame.resource, 1, 1, "foreground", true);
      void this._measureForegroundTargets(snapshot, key);
      return;
    }
    const settlement = currentReflowSettlement(snapshot);
    if (settlement === null) {
      this._foreground = { state: "unavailable" };
      this._currentForeground = null;
      this._cancelForegroundSettlement();
      const current = this._entries.get(frame.occurrence);
      const reason = fixedAdapterUnavailableReason(frame.adapter);
      if (current?.state !== "unavailable" || current.reason !== reason) {
        this._setUnavailable(frame.occurrence, reason);
      } else {
        this._publish();
      }
      return;
    }
    if (settlement.mode !== "paginated") {
      this._foreground = { state: "unavailable" };
      this._currentForeground = null;
      this._cancelForegroundSettlement();
      const current = this._entries.get(frame.occurrence);
      if (
        current?.state !== "inapplicable" ||
        current.reason !== "effective-presentation-not-paginated"
      ) {
        this._setInapplicable(frame.occurrence, "effective-presentation-not-paginated");
      } else {
        this._publish();
      }
      return;
    }
    if (settlement.pages.layoutRepairs.status === "unresolved") {
      this._foreground = { state: "unavailable" };
      this._currentForeground = null;
      this._cancelForegroundSettlement();
      const current = this._entries.get(frame.occurrence);
      if (current?.state !== "unavailable" || current.reason !== "unresolved-text-pagination") {
        this._setUnavailable(frame.occurrence, "unresolved-text-pagination");
      } else {
        this._publish();
      }
      return;
    }
    const key = `${this._runRevision}:${committed.generation}:${layout.layoutGeneration}`;
    if (
      this._currentForeground?.occurrence === frame.occurrence &&
      this._currentForeground.resource === frame.resource &&
      this._currentForeground.documentGeneration === committed.generation &&
      this._currentForeground.layoutGeneration === layout.layoutGeneration &&
      this._currentForeground.pageCount === settlement.pages.pageCount
    ) {
      this._foreground = this._currentForeground;
      return;
    }
    if (this._foregroundCandidateKey === key) return;
    this._foreground = { state: "pending" };
    this._publish();
    this._cancelForegroundSettlement();
    this._foregroundCandidateKey = key;
    const current = this._foregroundSnapshot?.() ?? snapshot;
    const currentCommitted = currentDocument(current);
    const currentCommittedFrame = currentFrame(current);
    const currentLayout = currentCommitted?.layout.layout;
    const currentSettlement = currentReflowSettlement(current);
    const currentPages = currentPaginatedLayout(current);
    if (
      current.document.pending !== null ||
      foregroundLayoutPending(current) ||
      currentCommitted?.generation !== committed.generation ||
      currentCommittedFrame?.generation !== frame.generation ||
      currentLayout?.documentGeneration !== committed.generation ||
      currentLayout.layoutGeneration !== layout.layoutGeneration ||
      currentSettlement?.mode !== "paginated" ||
      currentPages === null ||
      currentPages.layoutRepairs.status === "unresolved"
    ) {
      this._cancelForegroundSettlement();
      return;
    }
    this._currentForeground = {
      state: "current",
      occurrence: frame.occurrence,
      resource: frame.resource,
      documentGeneration: committed.generation,
      layoutGeneration: currentLayout.layoutGeneration,
      pageCount: currentPages.pageCount,
    };
    this._foreground = this._currentForeground;
    this._setMeasured(
      frame.occurrence,
      frame.resource,
      currentPages.pageCount,
      viewColumns(currentPages.columnsPerView),
      "foreground",
      layoutSettlementIsDurable(currentSettlement),
    );
    void this._measureForegroundTargets(current, key);
  }

  async _measureForegroundTargets(snapshot: KernelSnapshot, candidateKey: string): Promise<void> {
    const measure = this._measureForegroundTocTargets;
    const committed = currentDocument(snapshot);
    const frame = currentFrame(snapshot);
    const layout = committed?.layout.layout;
    if (measure === null || committed === null || frame === null || layout === undefined) return;
    const requests = this._pendingTargetRequests(frame.occurrence);
    if (requests.length === 0) return;
    const operationKey = `${candidateKey}:${frame.occurrence}`;
    if (this._foregroundTargetKey === operationKey) return;
    this._foregroundTargetKey = operationKey;
    const token = ++this._foregroundTargetToken;
    this._foregroundTargetController?.abort();
    const controller = new AbortController();
    this._foregroundTargetController = controller;
    const owner: ForegroundTargetOwner = Object.freeze({
      channel: "foreground",
      occurrence: frame.occurrence,
      operationKey,
      token,
      documentGeneration: committed.generation,
      layoutGeneration: layout.layoutGeneration,
    });
    let result: Awaited<ReturnType<typeof enrichTocTargets<ForegroundTargetOwner>>>;
    try {
      result = await enrichTocTargets({
        owner,
        requests,
        signal: controller.signal,
        measure: (targets, signal) => measure(targets, { signal }),
        now: () => this._now(),
        deadlineMs: tocEnrichmentDeadlineMs,
        sliceMs: tocEnrichmentSliceMs,
      });
    } finally {
      if (this._foregroundTargetController === controller) {
        this._foregroundTargetController = null;
      }
    }
    if (result.owner !== owner) return;
    if (!this._ownsForegroundTarget(token, operationKey, committed.generation, layout)) return;
    const entry = this._entries.get(frame.occurrence);
    if (entry?.state !== "measured" || entry.source !== "foreground") return;
    this._foregroundTargetKey = null;
    this._setTargets(frame.occurrence, result.results);
  }

  _ownsForegroundTarget(
    token: number,
    operationKey: string,
    documentGeneration: number,
    layout: CommittedLayout,
  ): boolean {
    if (
      this._closed ||
      this._foregroundBusy ||
      token !== this._foregroundTargetToken ||
      operationKey !== this._foregroundTargetKey
    ) {
      return false;
    }
    const current = this._foregroundSnapshot?.();
    return (
      current !== undefined &&
      current.document.pending === null &&
      !foregroundLayoutPending(current) &&
      currentDocument(current)?.generation === documentGeneration &&
      currentDocument(current)?.layout.layout.layoutGeneration === layout.layoutGeneration
    );
  }

  _cancelForegroundSettlement(): void {
    this._foregroundCandidateKey = null;
    this._foregroundTargetKey = null;
    this._foregroundTargetToken += 1;
    this._foregroundTargetController?.abort();
    this._foregroundTargetController = null;
  }
}
