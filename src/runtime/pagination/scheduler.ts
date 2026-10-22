import { OccurrencePriorityQueue } from "./priority-queue.js";
import type { ScheduledPaginationWork } from "./work.js";

export function browserInputPending(view: Window): boolean {
  const scheduling = (
    view.navigator as Navigator & {
      readonly scheduling?: { readonly isInputPending?: () => boolean } | undefined;
    }
  ).scheduling;
  try {
    return scheduling?.isInputPending?.() === true;
  } catch {
    return false;
  }
}

import type { NavigatorDiagnosticEvent, PaginationCancellationReason } from "./types.js";
import { hasPendingTargets } from "./occurrence-state.js";
import {
  auxiliaryMaximumDeferralMs,
  auxiliaryFlipMaximumDeferralMs,
  auxiliaryFlipQuietPeriodMs,
  auxiliaryQuietPeriodMs,
  idleCallbackTimeoutMs,
  idleCallbackWatchdogMs,
  inputPendingRetryMs,
  maximumPageMeasurementAttempts,
  pacingProfiles,
  rapidTurnIntervalMs,
  pageMeasurementDeadlineMs,
} from "./constants.js";
import { TocPaginationController } from "./toc-enrichment.js";

export abstract class ScheduledPaginationController extends TocPaginationController {
  _pause(): void {
    this._targetMeasurementController?.abort();
    this._targetMeasurementController = null;
    this._cancelScheduledStart();
    this._workDeferralStartedAt = null;
    this._taskToken += 1;
    this._cancelMeasurementDeadline();
    if (this._scheduledWork !== null) {
      const scheduled = this._scheduledWork;
      this._taskEvent(
        "pause",
        scheduled,
        this._container.ownerDocument.hidden ? "hidden" : "foreground-work",
      );
      if (scheduled.task === "page-count") {
        this._pageQueue.push(scheduled.occurrence, this._foregroundOccurrence);
      } else {
        this._tocQueue.push(scheduled.occurrence, this._foregroundOccurrence);
      }
      this._scheduledWork = null;
    }
    if (this._activeOccurrence !== null) {
      const entry = this._entries.get(this._activeOccurrence);
      if (this._activeTask !== null) {
        this._taskEvent(
          "pause",
          this._activeOccurrence,
          this._activeTask,
          this._container.ownerDocument.hidden ? "hidden" : "foreground-work",
        );
      }
      if (entry?.state === "measuring") {
        this._replaceEntry(this._activeOccurrence, { ...entry, state: "pending" });
        this._pageQueue.push(this._activeOccurrence, this._foregroundOccurrence);
      } else if (this._activeTask === "toc" && hasPendingTargets(entry)) {
        this._tocQueue.push(this._activeOccurrence, this._foregroundOccurrence);
      }
      this._activeOccurrence = null;
      this._activeTask = null;
    }
    this._teardownMeasurementRuntime();
    this._burstCount = 0;
    this._restUntil = null;
    if (this._debounceTimer === null && this._state !== "complete") this._state = "paused";
    this._activity = "paused";
    this._publish();
  }

  _schedule(continueBurst = false): void {
    if (
      this._closed ||
      this._foregroundBusy ||
      this._debounceTimer !== null ||
      this._scheduleTimer !== null ||
      this._idleHandle !== null ||
      this._scheduledWork !== null ||
      this._activeOccurrence !== null
    ) {
      return;
    }
    if (this._container.ownerDocument.hidden) {
      if (this._state !== "complete" && this._state !== "paused") {
        this._state = "paused";
        this._publish();
      }
      return;
    }
    if (this._createMeasurementRuntime === null) {
      this._state = this._measuredOccurrences === this._entries.length ? "complete" : "idle";
      this._activity = "idle";
      if (this._state === "complete") this._flushCacheWrites();
      this._publish();
      return;
    }
    let work = this._nextWork();
    if (
      work === null &&
      !this._entries.every((entry) => entry.state !== "pending" && !hasPendingTargets(entry))
    ) {
      // Pending entries are authoritative. Recover if an interrupting cache or foreground
      // callback invalidated queue ownership without changing the entry itself.
      this._rebuildWorkQueue();
      work = this._nextWork();
    }
    if (work === null) {
      this._state = this._measuredOccurrences === this._entries.length ? "complete" : "idle";
      this._activity = "idle";
      if (this._state === "complete") this._flushCacheWrites();
      this._teardownMeasurementRuntime();
      this._publish();
      return;
    }
    if (continueBurst) {
      const profile = pacingProfiles[this._pacing];
      this._burstCount += 1;
      if (this._burstCount >= profile.burstLength) {
        this._burstCount = 0;
        this._restUntil = this._now() + profile.restMs;
        continueBurst = false;
      } else if (
        this._lastForegroundActivityAt !== null &&
        this._now() - this._lastForegroundActivityAt < this._quietPeriodMs()
      ) {
        continueBurst = false;
      }
    }
    this._state = "measuring";
    const scheduled: ScheduledPaginationWork = {
      ...work,
      runRevision: this._runRevision,
      taskGeneration: ++this._taskToken,
    };
    this._scheduledWork = scheduled;
    this._workDeferralStartedAt = this._now();
    this._taskEvent("schedule", scheduled);
    this._activity = work.task === "page-count" ? "measuring-pages" : "enriching-toc";
    this._publish();
    this._armScheduledStart(scheduled, continueBurst);
  }

  foregroundFlipping(): boolean {
    const last = this._lastTurnAt;
    const previous = this._previousTurnAt;
    return (
      last !== null &&
      previous !== null &&
      last - previous < rapidTurnIntervalMs &&
      this._now() - last < auxiliaryFlipQuietPeriodMs
    );
  }

  protected _quietPeriodMs(): number {
    return this.foregroundFlipping() ? auxiliaryFlipQuietPeriodMs : auxiliaryQuietPeriodMs;
  }

  protected _maximumDeferralMs(): number {
    return this.foregroundFlipping() ? auxiliaryFlipMaximumDeferralMs : auxiliaryMaximumDeferralMs;
  }

  _armScheduledStart(scheduled: ScheduledPaginationWork, continueBurst = false): void {
    if (this._scheduledWork !== scheduled || this._closed || this._foregroundBusy) return;
    const now = this._now();
    const quietUntil =
      (this._lastForegroundActivityAt ?? Number.NEGATIVE_INFINITY) + this._quietPeriodMs();
    const maximumUntil = (this._workDeferralStartedAt ?? now) + this._maximumDeferralMs();
    const startAt = Math.max(
      Math.min(quietUntil, maximumUntil),
      this._restUntil ?? Number.NEGATIVE_INFINITY,
    );
    if (startAt > now) {
      this._quietTimer = setTimeout(() => {
        this._quietTimer = null;
        if (this._scheduledWork === scheduled) this._armScheduledStart(scheduled, continueBurst);
      }, startAt - now);
      return;
    }
    const view = this._container.ownerDocument.defaultView as
      | (Window & {
          requestIdleCallback?:
            | ((
                callback: (deadline: IdleDeadline) => void,
                options?: { timeout: number },
              ) => number)
            | undefined;
        })
      | null;
    if (continueBurst) {
      const runWhenResponsive = (): void => {
        this._scheduleTimer = null;
        if (this._scheduledWork !== scheduled) return;
        if (view !== null && browserInputPending(view)) {
          this._scheduleTimer = setTimeout(runWhenResponsive, inputPendingRetryMs);
          return;
        }
        void this._measure(scheduled);
      };
      this._scheduleTimer = setTimeout(runWhenResponsive, 0);
      return;
    }
    if (view?.requestIdleCallback !== undefined) {
      this._idleHandle = view.requestIdleCallback(
        () => {
          if (this._scheduleTimer !== null) clearTimeout(this._scheduleTimer);
          this._scheduleTimer = null;
          this._idleHandle = null;
          if (this._scheduledWork === scheduled) void this._measure(scheduled);
        },
        { timeout: idleCallbackTimeoutMs },
      );
      const runWatchdog = (): void => {
        this._scheduleTimer = null;
        if (this._scheduledWork !== scheduled) return;
        if (browserInputPending(view)) {
          this._scheduleTimer = setTimeout(runWatchdog, inputPendingRetryMs);
          return;
        }
        if (this._idleHandle !== null) view.cancelIdleCallback?.(this._idleHandle);
        this._idleHandle = null;
        void this._measure(scheduled);
      };
      this._scheduleTimer = setTimeout(runWatchdog, idleCallbackWatchdogMs);
    } else {
      this._scheduleTimer = setTimeout(() => {
        this._scheduleTimer = null;
        if (this._scheduledWork === scheduled) void this._measure(scheduled);
      }, 50);
    }
  }

  _cancelScheduledStart(): void {
    if (this._quietTimer !== null) clearTimeout(this._quietTimer);
    if (this._scheduleTimer !== null) clearTimeout(this._scheduleTimer);
    if (this._idleHandle !== null) {
      const view = this._container.ownerDocument.defaultView as
        | (Window & { cancelIdleCallback?: (handle: number) => void })
        | null;
      view?.cancelIdleCallback?.(this._idleHandle);
    }
    this._quietTimer = null;
    this._scheduleTimer = null;
    this._idleHandle = null;
  }

  async _measure(work: ScheduledPaginationWork): Promise<void> {
    if (this._scheduledWork === work) this._workDeferralStartedAt = null;
    const { occurrence, task, runRevision: revision, taskGeneration: taskToken } = work;
    const scheduled = this._entries.get(occurrence);
    if (
      (task === "page-count" && scheduled?.state !== "pending") ||
      (task === "toc" && !hasPendingTargets(scheduled))
    ) {
      if (this._scheduledWork === work) this._scheduledWork = null;
      this._schedule();
      return;
    }
    this._taskEvent("start", work);
    if (task === "page-count") this._armMeasurementDeadline(work);
    try {
      const runtime = await this._measurementRuntime();
      if (
        this._closed ||
        revision !== this._runRevision ||
        taskToken !== this._taskToken ||
        this._foregroundBusy
      ) {
        this._taskEvent("discard", occurrence, task, "owner-superseded");
        if (this._scheduledWork === work) this._scheduledWork = null;
        if (!this._closed && revision === this._runRevision && !this._foregroundBusy) {
          this._schedule();
        }
        return;
      }
      const entry = this._entries.get(occurrence);
      if (
        entry === undefined ||
        (task === "page-count" && entry.state !== "pending") ||
        (task === "toc" && !hasPendingTargets(entry))
      ) {
        if (this._scheduledWork === work) this._scheduledWork = null;
        this._schedule();
        return;
      }
      if (task === "page-count") {
        this._replaceEntry(occurrence, { ...entry, state: "measuring" });
      }
      this._activeOccurrence = occurrence;
      this._activeTask = task;
      this._scheduledWork = null;
      this._activeDocumentGeneration = null;
      this._publish();
      runtime.open(occurrence);
    } catch (cause) {
      if (this._scheduledWork === work) this._scheduledWork = null;
      if (
        !this._closed &&
        revision === this._runRevision &&
        taskToken === this._taskToken &&
        !this._foregroundBusy &&
        ((task === "page-count" &&
          (this._entries.get(occurrence)?.state === "pending" ||
            this._entries.get(occurrence)?.state === "measuring")) ||
          (task === "toc" && hasPendingTargets(this._entries.get(occurrence))))
      ) {
        this._teardownMeasurementRuntime();
        if (task === "page-count") this._retryPageCount(occurrence, cause);
        else this._setTargetFailure(occurrence, cause);
      }
    }
  }

  _requeuePageCount(occurrence: number, reason: PaginationCancellationReason): void {
    const current = this._entries.get(occurrence);
    if (current === undefined) return;
    if (this._activeTask !== null) {
      this._taskEvent("requeue", occurrence, this._activeTask, reason);
    }
    this._taskToken += 1;
    this._cancelMeasurementDeadline();
    this._replaceEntry(occurrence, {
      occurrence,
      resource: current.resource,
      state: "pending",
    });
    this._pageQueue.push(occurrence, this._foregroundOccurrence);
    this._activeOccurrence = null;
    this._activeTask = null;
    this._activeDocumentGeneration = null;
    this._teardownMeasurementRuntime();
    this._publish();
    this._queueCacheRemoval(occurrence);
    this._schedule();
  }

  _taskEvent(
    action: Extract<NavigatorDiagnosticEvent, { type: "controller-task" }>["action"],
    work: ScheduledPaginationWork,
    reason?: PaginationCancellationReason,
  ): void;

  _taskEvent(
    action: Extract<NavigatorDiagnosticEvent, { type: "controller-task" }>["action"],
    occurrence: number,
    task: "page-count" | "toc",
    reason?: PaginationCancellationReason,
  ): void;

  _taskEvent(
    action: Extract<NavigatorDiagnosticEvent, { type: "controller-task" }>["action"],
    occurrenceOrWork: number | ScheduledPaginationWork,
    taskOrReason?: "page-count" | "toc" | PaginationCancellationReason,
    optionalReason?: PaginationCancellationReason,
  ): void {
    const work = typeof occurrenceOrWork === "number" ? null : occurrenceOrWork;
    const occurrence =
      typeof occurrenceOrWork === "number" ? occurrenceOrWork : occurrenceOrWork.occurrence;
    const task = work?.task ?? (taskOrReason as "page-count" | "toc");
    const reason = work === null ? optionalReason : (taskOrReason as PaginationCancellationReason);
    if (task === "page-count") {
      if (action === "start") {
        this._accumulatePageCountTime();
        this._runPageCountAttempts += 1;
        this._activePageCountStartedAt = this._now();
      } else if (action !== "schedule") {
        this._accumulatePageCountTime();
      }
      if (reason === "timeout") this._runTimedOutOccurrences.add(occurrence);
    }
    this._record({
      type: "controller-task",
      action,
      task,
      occurrence,
      runRevision: work?.runRevision ?? this._runRevision,
      taskGeneration: work?.taskGeneration ?? this._taskToken,
      ...(this._activeDocumentGeneration === null
        ? {}
        : { documentGeneration: this._activeDocumentGeneration }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  _clearTimers(): void {
    this._targetMeasurementController?.abort();
    this._targetMeasurementController = null;
    this._foregroundTargetController?.abort();
    this._foregroundTargetController = null;
    if (this._scheduleTimer !== null) clearTimeout(this._scheduleTimer);
    if (this._quietTimer !== null) clearTimeout(this._quietTimer);
    if (this._debounceTimer !== null) clearTimeout(this._debounceTimer);
    if (this._cacheWriteTimer !== null) clearTimeout(this._cacheWriteTimer);
    if (this._cacheRestoreTimer !== null) clearTimeout(this._cacheRestoreTimer);
    if (this._measurementTimer !== null) clearTimeout(this._measurementTimer);
    if (this._idleHandle !== null) {
      const view = this._container.ownerDocument.defaultView as
        | (Window & { cancelIdleCallback?: (handle: number) => void })
        | null;
      view?.cancelIdleCallback?.(this._idleHandle);
    }
    this._scheduleTimer = null;
    this._quietTimer = null;
    this._debounceTimer = null;
    this._cacheWriteTimer = null;
    this._cacheRestoreTimer = null;
    this._measurementTimer = null;
    this._idleHandle = null;
    this._lastForegroundActivityAt = null;
    this._lastTurnAt = null;
    this._previousTurnAt = null;
    this._workDeferralStartedAt = null;
    this._quietAfterForegroundWork = false;
    this._burstCount = 0;
    this._restUntil = null;
  }

  _armMeasurementDeadline(work: ScheduledPaginationWork): void {
    this._cancelMeasurementDeadline();
    this._measurementTimer = setTimeout(() => {
      this._measurementTimer = null;
      if (
        this._closed ||
        work.runRevision !== this._runRevision ||
        work.taskGeneration !== this._taskToken ||
        (this._scheduledWork !== work && this._activeOccurrence !== work.occurrence)
      ) {
        return;
      }
      if (this._scheduledWork === work) this._scheduledWork = null;
      this._retryPageCount(work.occurrence, new Error("page measurement timed out"));
    }, pageMeasurementDeadlineMs);
  }

  _cancelMeasurementDeadline(): void {
    if (this._measurementTimer !== null) clearTimeout(this._measurementTimer);
    this._measurementTimer = null;
  }

  _cancelMeasurementDeadlineFor(occurrence: number): void {
    if (this._activeOccurrence === occurrence || this._scheduledWork?.occurrence === occurrence) {
      this._cancelMeasurementDeadline();
    }
  }

  _retryPageCount(occurrence: number, cause: unknown): void {
    const current = this._entries.get(occurrence);
    if (current === undefined || (current.state !== "pending" && current.state !== "measuring")) {
      return;
    }
    const attempts = (this._attempts.get(occurrence) ?? 0) + 1;
    if (attempts >= maximumPageMeasurementAttempts) {
      this._setFailed(occurrence, cause);
      return;
    }
    this._attempts.set(occurrence, attempts);
    this._requeuePageCount(
      occurrence,
      cause instanceof Error && cause.message.includes("timed out") ? "timeout" : "delivery-failed",
    );
  }

  _rebuildWorkQueue(): void {
    const pageOccurrences: number[] = [];
    const tocOccurrences: number[] = [];
    for (const entry of this._entries) {
      if (
        this._preparationClaims.has(entry.occurrence) ||
        this._cacheRestoreClaims.has(entry.occurrence)
      )
        continue;
      if (entry.state === "pending") pageOccurrences.push(entry.occurrence);
      if (hasPendingTargets(entry)) tocOccurrences.push(entry.occurrence);
    }
    this._pageQueue = OccurrencePriorityQueue.from(pageOccurrences, this._foregroundOccurrence);
    this._tocQueue = OccurrencePriorityQueue.from(tocOccurrences, this._foregroundOccurrence);
  }

  _nextWork(): { readonly occurrence: number; readonly task: "page-count" | "toc" } | null {
    if (this._pageTasksSinceToc >= 4) {
      const toc = this._nextTocWork();
      if (toc !== null) {
        this._pageTasksSinceToc = 0;
        return toc;
      }
    }
    for (;;) {
      const occurrence = this._pageQueue.pop();
      if (occurrence === null) break;
      if (
        !this._preparationClaims.has(occurrence) &&
        !this._cacheRestoreClaims.has(occurrence) &&
        this._entries.get(occurrence)?.state === "pending"
      ) {
        this._pageTasksSinceToc += 1;
        return { occurrence, task: "page-count" };
      }
    }
    return this._nextTocWork();
  }

  _nextTocWork(): { readonly occurrence: number; readonly task: "toc" } | null {
    if (this._cacheRestoreInProgress) return null;
    for (;;) {
      const occurrence = this._tocQueue.pop();
      if (occurrence === null) return null;
      if (
        !this._preparationClaims.has(occurrence) &&
        !this._cacheRestoreClaims.has(occurrence) &&
        hasPendingTargets(this._entries.get(occurrence))
      ) {
        return { occurrence, task: "toc" };
      }
    }
  }
}
