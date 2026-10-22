import type { PresentationPreferences } from "../../generated/kernel.js";
import type { PaginationBasis } from "./types.js";

export function paginationBasis(
  container: HTMLElement,
  preferences: PresentationPreferences,
  viewport?: PaginationBasis["viewport"],
): PaginationBasis {
  const measuredViewport = viewport ?? container.getBoundingClientRect();
  const view = container.ownerDocument.defaultView;
  return Object.freeze({
    viewport: Object.freeze({
      width: measuredViewport.width,
      height: measuredViewport.height,
    }),
    preferences: layoutPreferences(preferences),
    userAgent: view?.navigator.userAgent ?? "",
    devicePixelRatio: view?.devicePixelRatio ?? 1,
  });
}

export function layoutPreferences(
  preferences: PresentationPreferences,
): Omit<PresentationPreferences, "theme"> {
  const { theme: _theme, ...layout } = preferences;
  return Object.freeze(layout);
}

export function samePreferences(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameBasis(left: PaginationBasis, right: PaginationBasis): boolean {
  return (
    left.viewport.width === right.viewport.width &&
    left.viewport.height === right.viewport.height &&
    left.userAgent === right.userAgent &&
    left.devicePixelRatio === right.devicePixelRatio &&
    samePreferences(left.preferences, right.preferences)
  );
}

import { OccurrenceStore } from "./occurrence-store.js";
import { initialEntries } from "./catalog.js";
import { ScheduledPaginationController } from "./scheduler.js";

export abstract class BasisPaginationController extends ScheduledPaginationController {
  _invalidateBasis(viewport?: PaginationBasis["viewport"]): void {
    if (this._closed) return;
    const nextBasis = paginationBasis(this._container, this._preferences, viewport);
    if (sameBasis(this._pendingBasis ?? this._basis, nextBasis)) return;
    this._revokePreparationClaims();
    this._pendingBasis = nextBasis;
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._armBasisRestart();
      return;
    }
    this._finishPaginationRun("superseded");
    this._cancelCacheWrites(this._runRevision);
    this._runRevision += 1;
    this._startPaginationRun();
    const ownedWork =
      this._scheduledWork ??
      (this._activeOccurrence !== null && this._activeTask !== null
        ? { occurrence: this._activeOccurrence, task: this._activeTask }
        : null);
    if (ownedWork !== null)
      this._taskEvent("discard", ownedWork.occurrence, ownedWork.task, "basis-change");
    this._scheduledWork = null;
    this._taskToken += 1;
    this._sessionToken += 1;
    this._cancelCacheRestore();
    this._cacheController.abort();
    this._cacheController = new AbortController();
    this._cacheWritable = true;
    this._cacheBasisPromise = null;
    this._cacheRecordRevisions.clear();
    this._cacheRecordKeyPromises.clear();
    this._dirtyCacheOccurrences.clear();
    this._pendingCacheWrites.clear();
    this._clearTimers();
    this._cancelForegroundSettlement();
    this._activeOccurrence = null;
    this._activeTask = null;
    this._teardownMeasurementRuntime();
    this._state = "stale";
    this._freshness = "stale";
    this._activity = "paused";
    this._foreground = { state: "pending" };
    this._currentForeground = null;
    this._publish();
    this._armBasisRestart();
  }

  _armBasisRestart(): void {
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._revokePreparationClaims();
      this._basis = this._pendingBasis ?? paginationBasis(this._container, this._preferences);
      this._pendingBasis = null;
      this._entries = OccurrenceStore.from(
        initialEntries(this._facts, this._documents, this._eligibleResourcePaths),
      );
      this._durableMeasuredOccurrences.clear();
      this._resetAggregates();
      this._attempts.clear();
      this._state = "idle";
      this._freshness = "current";
      this._activity = "idle";
      this._foreground = { state: "pending" };
      this._currentForeground = null;
      this._rebuildWorkQueue();
      this._publish();
      void this._restoreCache().finally(() => this._schedule());
      const foreground = this._foregroundSnapshot?.();
      if (foreground !== undefined) this.updateForeground(foreground);
      this._schedule();
      try {
        this._basisRestarted?.();
      } catch {
        // Runtime preparation scheduling cannot interrupt the pagination restart.
      }
    }, 400);
  }

  _resetOwnedEpoch(): void {
    this._finishPaginationRun("superseded");
    this._cancelCacheWrites(this._runRevision);
    this._runRevision += 1;
    this._startPaginationRun();
    this._taskToken += 1;
    this._cancelCacheRestore();
    this._cacheController.abort();
    this._cacheController = new AbortController();
    this._cacheBasisPromise = null;
    this._cacheRecordRevisions.clear();
    this._cacheRecordKeyPromises.clear();
    this._dirtyCacheOccurrences.clear();
    this._pendingCacheWrites.clear();
    this._clearTimers();
    this._cancelForegroundSettlement();
    this._activeOccurrence = null;
    this._activeTask = null;
    this._teardownMeasurementRuntime();
    this._attempts.clear();
    this._entries = OccurrenceStore.from(
      initialEntries(this._facts, this._documents, this._eligibleResourcePaths),
    );
    this._durableMeasuredOccurrences.clear();
    this._resetAggregates();
    this._rebuildWorkQueue();
    this._state = "idle";
    this._activity = "idle";
    this._freshness = "current";
  }
}
