import type {
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
} from "../agent-protocol/index.js";
import type { OccurrencePagination, TocTargetPagination } from "./types.js";

export function pendingTargets(
  requests: readonly TocTargetMeasurementRequest[],
): readonly TocTargetPagination[] {
  return Object.freeze(
    requests.map((request) =>
      freezeTarget({
        listIndex: request.listIndex,
        pointPath: request.pointPath,
        result: { state: "pending" },
      }),
    ),
  );
}

export function failedTocTargets(
  requests: readonly TocTargetMeasurementRequest[],
  message: string,
): TocTargetMeasurementResult[] {
  return requests.map((target) => ({
    listIndex: target.listIndex,
    pointPath: target.pointPath,
    result: { state: "failed", message },
  }));
}

export function freezeOccurrence(entry: OccurrencePagination): OccurrencePagination {
  if (entry.state !== "measured") return Object.freeze(entry);
  return Object.freeze({
    ...entry,
    tocTargets: Object.freeze(entry.tocTargets.map(freezeTarget)),
  });
}

export function freezeTarget(target: TocTargetPagination): TocTargetPagination {
  if (
    Object.isFrozen(target) &&
    Object.isFrozen(target.pointPath) &&
    Object.isFrozen(target.result)
  ) {
    return target;
  }
  return Object.freeze({
    ...target,
    pointPath: Object.freeze(target.pointPath.slice()),
    result: Object.freeze({ ...target.result }),
  });
}

export function targetIdentity(
  target: Pick<TocTargetPagination, "listIndex" | "pointPath">,
): string {
  return `${target.listIndex}:${target.pointPath.join("/")}`;
}

export function sameTargetIdentities(
  requests: readonly TocTargetMeasurementRequest[],
  results: readonly TocTargetMeasurementResult[],
): boolean {
  if (requests.length !== results.length) return false;
  const expected = new Set(requests.map(targetIdentity));
  const observed = new Set(results.map(targetIdentity));
  return (
    expected.size === requests.length &&
    observed.size === results.length &&
    [...observed].every((identity) => expected.has(identity))
  );
}

export function hasPendingTargets(
  entry: OccurrencePagination | undefined,
): entry is Extract<OccurrencePagination, { state: "measured" }> {
  return (
    entry?.state === "measured" &&
    entry.tocTargets.some((target) => target.result.state === "pending")
  );
}

export function settledTargetCount(targets: readonly TocTargetPagination[]): number {
  let count = 0;
  for (const target of targets) if (target.result.state !== "pending") count += 1;
  return count;
}

export function isTerminalEntry(entry: OccurrencePagination): boolean {
  return entry.state !== "pending" && entry.state !== "measuring";
}

export function entryTerminalizesTargets(entry: OccurrencePagination): boolean {
  return (
    entry.state === "inapplicable" || entry.state === "unavailable" || entry.state === "failed"
  );
}

import type { PaginationMeasurementRuntime } from "./contracts.js";
import {
  currentDocument,
  currentFixedSettlement,
  currentPaginatedLayout,
  foregroundLayoutPending,
} from "../kernel-view.js";
import type { BackgroundTargetOwner } from "./background-measurement.js";
import { PagePrefixIndex } from "./page-prefix-index.js";
import { isCacheableInapplicableReason } from "./cache/codec.js";
import { PaginationControllerState } from "./state.js";
import type { ScheduledPaginationWork } from "./work.js";

function isPositiveUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
}

export abstract class OccurrencePaginationController extends PaginationControllerState {
  _setBackgroundMeasuredAndContinueTargets(
    runtime: PaginationMeasurementRuntime,
    occurrence: number,
    resource: string,
    pageCount: number,
    columnsPerView: 1 | 2,
    revision: number,
    taskToken: number,
    documentGeneration: number,
    layoutGeneration: number,
    durable: boolean,
  ): void {
    const current = this._entries.get(occurrence);
    if (current?.state !== "measuring" || !isPositiveUint32(pageCount)) return;
    const tocTargets = pendingTargets(this._tocRequestsByOccurrence[occurrence] ?? []);
    this._commitMeasured(
      occurrence,
      {
        occurrence,
        resource,
        state: "measured",
        pageCount,
        columnsPerView,
        tocTargets,
        source: "background",
      },
      durable,
    );
    this._cancelMeasurementDeadlineFor(occurrence);
    this._taskEvent("complete", occurrence, "page-count");
    if (this._resourceIsCacheEligible(occurrence)) this._queueCacheWrite(occurrence);

    if (!hasPendingTargets(this._entries.get(occurrence))) {
      this._activeOccurrence = null;
      this._activeTask = null;
      this._activeDocumentGeneration = null;
      this._attempts.delete(occurrence);
      this._schedule(true);
      return;
    }

    if (this._cacheRestoreInProgress) {
      this._activeOccurrence = null;
      this._activeTask = null;
      this._activeDocumentGeneration = null;
      this._tocQueue.push(occurrence, this._foregroundOccurrence);
      this._schedule(true);
      return;
    }

    this._activeTask = "toc";
    this._activity = "enriching-toc";
    const tocWork: ScheduledPaginationWork = {
      occurrence,
      task: "toc",
      runRevision: revision,
      taskGeneration: taskToken,
    };
    this._taskEvent("schedule", tocWork);
    this._taskEvent("start", tocWork);
    this._publish();
    this._targetMeasurementTaskToken = taskToken;
    const owner: BackgroundTargetOwner = Object.freeze({
      channel: "background",
      occurrence,
      runRevision: revision,
      taskGeneration: taskToken,
      documentGeneration,
      layoutGeneration,
      pageCount,
    });
    void this._measureTargets(runtime, owner)
      .then((result) => {
        if (
          result === null ||
          result.owner !== owner ||
          this._closed ||
          revision !== this._runRevision ||
          taskToken !== this._taskToken ||
          this._foregroundBusy ||
          this._activeOccurrence !== occurrence ||
          this._activeTask !== "toc"
        ) {
          return;
        }
        const stable = runtime.snapshot();
        if (
          currentDocument(stable)?.generation !== documentGeneration ||
          currentDocument(stable)?.layout.layout.layoutGeneration !== layoutGeneration ||
          foregroundLayoutPending(stable) ||
          currentPaginatedLayout(stable)?.layoutRepairs.status === "unresolved" ||
          (currentFixedSettlement(stable) === null &&
            currentPaginatedLayout(stable)?.pageCount !== pageCount)
        ) {
          this._requeuePageCount(occurrence, "unstable");
          return;
        }
        this._setTargets(occurrence, result.results);
      })
      .finally(() => {
        if (this._targetMeasurementTaskToken === taskToken) {
          this._targetMeasurementTaskToken = null;
        }
      });
  }

  _setMeasured(
    occurrence: number,
    resource: string,
    pageCount: number,
    columnsPerView: 1 | 2,
    source: "foreground" | "background",
    durable: boolean,
    tocTargets?: readonly TocTargetPagination[],
  ): void {
    let current = this._entries.get(occurrence);
    let resetCache = false;
    if (current === undefined || !isPositiveUint32(pageCount)) return;
    if (current.state === "measured" && this._durableMeasuredOccurrences.has(occurrence)) {
      if (!durable) {
        this._publish();
        return;
      }
      if (
        source === "foreground" &&
        current.source === "background" &&
        current.pageCount !== pageCount
      ) {
        this._resetOwnedEpoch();
        current = this._entries.get(occurrence);
        if (current === undefined) return;
        resetCache = true;
      }
    }
    const retainedTargets =
      tocTargets ??
      (current.state === "measured" && current.pageCount === pageCount
        ? current.tocTargets
        : pendingTargets(this._tocRequestsByOccurrence[occurrence] ?? []));
    this._commitMeasured(
      occurrence,
      {
        occurrence,
        resource,
        state: "measured",
        pageCount,
        columnsPerView,
        tocTargets: retainedTargets,
        source,
      },
      durable,
    );
    this._cancelMeasurementDeadlineFor(occurrence);
    if (source === "background" || this._measureForegroundTocTargets === null) {
      this._tocQueue.push(occurrence, this._foregroundOccurrence);
    }
    this._attempts.delete(occurrence);
    if (this._activeOccurrence === occurrence) {
      this._activeOccurrence = null;
      this._activeTask = null;
      this._activeDocumentGeneration = null;
    }
    this._publish();
    this._taskEvent("complete", occurrence, "page-count");
    if (this._resourceIsCacheEligible(occurrence)) {
      if (resetCache) this._queueCurrentCacheReset(occurrence);
      else this._queueCacheWrite(occurrence);
    }
    this._schedule(source === "background");
  }

  _setInapplicable(occurrence: number, reason: string): void {
    const current = this._entries.get(occurrence);
    if (current === undefined) return;
    this._replaceEntry(occurrence, { ...current, state: "inapplicable", reason });
    this._cancelMeasurementDeadlineFor(occurrence);
    this._attempts.delete(occurrence);
    if (this._activeOccurrence === occurrence) {
      this._activeOccurrence = null;
      this._activeTask = null;
      this._activeDocumentGeneration = null;
    }
    this._publish();
    if (isCacheableInapplicableReason(reason) && this._resourceIsCacheEligible(occurrence)) {
      this._queueCacheWrite(occurrence);
    } else {
      this._queueCacheRemoval(occurrence);
    }
    this._schedule();
  }

  _setUnavailable(occurrence: number, reason: string): void {
    const current = this._entries.get(occurrence);
    if (current === undefined) return;
    this._replaceEntry(occurrence, { ...current, state: "unavailable", reason });
    this._cancelMeasurementDeadlineFor(occurrence);
    this._attempts.delete(occurrence);
    if (this._activeOccurrence === occurrence) {
      this._activeOccurrence = null;
      this._activeTask = null;
      this._activeDocumentGeneration = null;
    }
    this._publish();
    this._queueCacheRemoval(occurrence);
    this._schedule();
  }

  _requeue(occurrence: number): void {
    const current = this._entries.get(occurrence);
    if (this._activeTask !== null)
      this._taskEvent("requeue", occurrence, this._activeTask, "unstable");
    this._cancelMeasurementDeadline();
    if (this._activeTask === "page-count" && current?.state === "measuring") {
      this._replaceEntry(occurrence, { ...current, state: "pending" });
      this._pageQueue.push(occurrence, this._foregroundOccurrence);
    } else if (this._activeTask === "toc" && hasPendingTargets(current)) {
      this._tocQueue.push(occurrence, this._foregroundOccurrence);
    } else {
      return;
    }
    if (this._activeOccurrence === occurrence) {
      this._activeOccurrence = null;
      this._activeTask = null;
      this._activeDocumentGeneration = null;
    }
    this._publish();
    this._queueCacheRemoval(occurrence);
    this._schedule();
  }

  _setFailed(occurrence: number, cause: unknown): void {
    const current = this._entries.get(occurrence);
    if (current === undefined) return;
    this._replaceEntry(occurrence, {
      ...current,
      state: "failed",
      message: cause instanceof Error ? cause.message : "background pagination failed",
    });
    this._cancelMeasurementDeadline();
    this._activeOccurrence = null;
    this._activeTask = null;
    this._activeDocumentGeneration = null;
    this._publish();
    this._schedule();
  }

  _setTargets(
    occurrence: number,
    results: readonly TocTargetPagination[],
    completeTask = true,
  ): void {
    const current = this._entries.get(occurrence);
    if (current?.state !== "measured") return;
    const byIdentity = new Map(results.map((target) => [targetIdentity(target), target]));
    const tocTargets = current.tocTargets.map((target) => {
      const result = byIdentity.get(targetIdentity(target));
      return result === undefined ? target : freezeTarget(result);
    });
    this._commitMeasured(occurrence, { ...current, tocTargets: Object.freeze(tocTargets) });
    this._publish();
    if (completeTask) {
      if (this._activeOccurrence === occurrence) {
        this._activeOccurrence = null;
        this._activeTask = null;
      }
      this._attempts.delete(occurrence);
      this._taskEvent("complete", occurrence, "toc");
      this._schedule();
    }
    if (this._resourceIsCacheEligible(occurrence)) this._queueCacheWrite(occurrence);
  }

  _setTargetFailure(occurrence: number, cause: unknown): void {
    const current = this._entries.get(occurrence);
    if (current?.state !== "measured") return;
    const message = cause instanceof Error ? cause.message : "TOC target measurement failed";
    this._setTargets(
      occurrence,
      current.tocTargets.map((target) =>
        target.result.state === "pending"
          ? { ...target, result: { state: "failed" as const, message } }
          : target,
      ),
    );
  }

  _replaceEntry(occurrence: number, entry: OccurrencePagination): void {
    const previous = this._entries.get(occurrence);
    if (previous?.state === "measured") {
      this._measuredOccurrences -= 1;
      this._measuredPageCount -= previous.pageCount;
      this._measuredTargets -= settledTargetCount(previous.tocTargets);
    } else if (previous !== undefined && entryTerminalizesTargets(previous)) {
      this._terminalTargets -= this._tocRequestsByOccurrence[occurrence]?.length ?? 0;
    }
    const frozen = freezeOccurrence(entry);
    if (frozen.state === "measured") {
      this._measuredOccurrences += 1;
      this._measuredPageCount += frozen.pageCount;
      this._measuredTargets += settledTargetCount(frozen.tocTargets);
      this._prefix = this._prefix.set(occurrence, frozen.pageCount, true, false);
    } else {
      if (entryTerminalizesTargets(frozen)) {
        this._terminalTargets += this._tocRequestsByOccurrence[occurrence]?.length ?? 0;
      }
      this._durableMeasuredOccurrences.delete(occurrence);
      this._prefix = this._prefix.set(occurrence, 0, false, isTerminalEntry(frozen));
    }
    this._entries = this._entries.set(occurrence, frozen);
    this._cacheRecordRevisions.set(
      occurrence,
      (this._cacheRecordRevisions.get(occurrence) ?? 0) + 1,
    );
    this._snapshot = null;
  }

  _commitMeasured(
    occurrence: number,
    entry: Extract<OccurrencePagination, { state: "measured" }>,
    durable?: boolean,
  ): void {
    const retainedDurability = this._durableMeasuredOccurrences.has(occurrence);
    this._replaceEntry(occurrence, entry);
    if (durable ?? retainedDurability) this._durableMeasuredOccurrences.add(occurrence);
    else this._durableMeasuredOccurrences.delete(occurrence);
  }

  _resetAggregates(): void {
    const started = this._now();
    this._measuredOccurrences = 0;
    this._measuredPageCount = 0;
    this._measuredTargets = 0;
    this._terminalTargets = 0;
    this._prefix = PagePrefixIndex.empty(this._entries.length);
    for (const entry of this._entries) {
      if (entry.state !== "measured") continue;
      this._measuredOccurrences += 1;
      this._measuredPageCount += entry.pageCount;
      this._measuredTargets += settledTargetCount(entry.tocTargets);
      this._prefix = this._prefix.set(entry.occurrence, entry.pageCount, true, false);
    }
    for (const entry of this._entries) {
      if (entry.state !== "measured" && isTerminalEntry(entry)) {
        this._prefix = this._prefix.set(entry.occurrence, 0, false, true);
      }
      if (entryTerminalizesTargets(entry)) {
        this._terminalTargets += this._tocRequestsByOccurrence[entry.occurrence]?.length ?? 0;
      }
    }
    this._snapshot = null;
    this._record({
      type: "derived-build",
      build: "prefix-index",
      durationMs: this._now() - started,
      itemCount: this._entries.length,
    });
  }

  _publish(): void {
    this._publicationSequence += 1;
    this._snapshot = null;
    const snapshot = this.snapshot();
    this._record({
      type: "controller-publish",
      sequence: this._publicationSequence,
      runRevision: snapshot.runRevision,
      activity: snapshot.activity,
      freshness: snapshot.freshness,
      foreground: snapshot.foreground.state,
      coverage: snapshot.pageCountCoverage.state,
      measuredOccurrences: snapshot.pageCountCoverage.measuredOccurrences,
      totalOccurrences: snapshot.pageCountCoverage.totalOccurrences,
      totalPageCount: snapshot.totalPageCount,
      toc: snapshot.tocEnrichment.state,
      measuredTargets: snapshot.tocEnrichment.measuredTargets,
      totalTargets: snapshot.tocEnrichment.totalTargets,
    });
    if (
      snapshot.tocEnrichment.state === "complete" &&
      snapshot.pageCountCoverage.state !== "incomplete"
    ) {
      this._finishPaginationRun(
        snapshot.pageCountCoverage.state === "exact" ? "complete" : "unavailable",
        snapshot,
      );
    }
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch {
        // One observer cannot interrupt controller scheduling or other observers.
      }
    }
  }
}
