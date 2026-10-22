import type {
  KernelSnapshot,
  OccurrenceDocumentTarget,
  PresentationPreferences,
} from "../../generated/kernel.js";
import type { PublicationFacts } from "../../generated/publication.js";
import type { TocTargetMeasurementOptions } from "../navigator/api.js";
import type {
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
} from "../agent-protocol/index.js";
import type {
  BookPaginationSnapshot,
  NavigatorDiagnostics,
  PaginationSnapshotListener,
} from "./types.js";
import type { PaginationCacheIdentity, PaginationMeasurementCache } from "./cache/contract.js";
import type { MeasurementRuntimeFactory, PreparedTocMeasurement } from "./capabilities.js";
import { OccurrenceStore } from "./occurrence-store.js";
import { layoutPreferences, paginationBasis, samePreferences } from "./basis.js";
import {
  indexTocTargetRequests,
  initialEntries,
  occurrenceWeights,
  publicationDocuments,
} from "./catalog.js";
import { calibratedPageEstimate } from "./estimate.js";
import type { PaginationPacing } from "./constants.js";
import { isTerminalEntry } from "./classification.js";
import { turnEchoMs } from "./constants.js";
import { ForegroundPaginationController } from "./foreground-reconciler.js";
import { DiagnosticsClock } from "../diagnostics-clock.js";

export class BookPaginationController extends ForegroundPaginationController {
  constructor(options: {
    readonly pacing?: PaginationPacing | undefined;
    readonly facts: PublicationFacts;
    readonly documents?: readonly OccurrenceDocumentTarget[] | undefined;
    readonly container: HTMLElement;
    readonly preferences: PresentationPreferences;
    readonly createMeasurementRuntime: MeasurementRuntimeFactory | null;
    readonly eligibleResourcePaths?: readonly string[] | undefined;
    readonly cache?: PaginationMeasurementCache | undefined;
    readonly cacheIdentity?: PaginationCacheIdentity | undefined;
    readonly foregroundSnapshot?: (() => KernelSnapshot) | undefined;
    readonly measureForegroundTocTargets?:
      | ((
          targets: readonly TocTargetMeasurementRequest[],
          options?: TocTargetMeasurementOptions,
        ) => Promise<readonly TocTargetMeasurementResult[]>)
      | undefined;
    readonly measurePreparedTocTargets?: PreparedTocMeasurement | undefined;
    readonly diagnostics?: NavigatorDiagnostics | undefined;
    readonly preparationClaimsInvalidated?: (() => void) | undefined;
    readonly basisRestarted?: (() => void) | undefined;
  }) {
    if (
      options.documents !== undefined &&
      options.documents.length !== options.facts.resources.readingOrder.length
    ) {
      throw new Error("pagination documents must align with the reading order");
    }
    const snapshotReadingOrder = options.foregroundSnapshot?.().readingOrder;
    const documents =
      options.documents !== undefined
        ? [...options.documents]
        : snapshotReadingOrder?.length === options.facts.resources.readingOrder.length
          ? snapshotReadingOrder.map((occurrence) => occurrence.document)
          : publicationDocuments(options.facts);
    const eligibleResourcePaths =
      options.eligibleResourcePaths === undefined ? null : new Set(options.eligibleResourcePaths);
    const tocIndexClock =
      options.diagnostics === undefined ? null : new DiagnosticsClock(options.diagnostics.now);
    const tocIndexStarted = tocIndexClock?.now() ?? 0;
    const tocRequestsByOccurrence = indexTocTargetRequests(options.facts, documents);
    const tocIndexDuration =
      tocIndexClock === null ? undefined : tocIndexClock.now() - tocIndexStarted;
    const totalTargets = tocRequestsByOccurrence.reduce(
      (total, requests) => total + requests.length,
      0,
    );
    const entries = OccurrenceStore.from(
      initialEntries(options.facts, documents, eligibleResourcePaths),
    );
    super({
      facts: options.facts,
      documents,
      weights: occurrenceWeights(options.facts, documents),
      pacing: options.pacing ?? "normal",
      container: options.container,
      preferences: options.preferences,
      createMeasurementRuntime: options.createMeasurementRuntime,
      eligibleResourcePaths,
      cache: options.cache ?? null,
      cacheIdentity: options.cacheIdentity ?? null,
      foregroundSnapshot: options.foregroundSnapshot ?? null,
      measureForegroundTocTargets: options.measureForegroundTocTargets ?? null,
      measurePreparedTocTargets: options.measurePreparedTocTargets ?? null,
      diagnostics: options.diagnostics ?? null,
      entries,
      tocRequestsByOccurrence,
      totalTargets,
      basis: paginationBasis(options.container, options.preferences),
      preparationClaimsInvalidated: options.preparationClaimsInvalidated ?? null,
      basisRestarted: options.basisRestarted ?? null,
    });
    this._startPaginationRun();
    this._resetAggregates();
    if (tocIndexDuration !== undefined)
      this._record({
        type: "derived-build",
        build: "toc-index",
        durationMs: tocIndexDuration,
        itemCount: totalTargets,
      });
    this._rebuildWorkQueue();
    const view = options.container.ownerDocument.defaultView;
    let awaitingInitialResize = true;
    this._resizeObserver =
      view !== null && typeof view.ResizeObserver !== "undefined"
        ? new view.ResizeObserver((entries) => {
            const entry = entries.find((candidate) => candidate.target === this._container);
            if (entry === undefined || this._closed) return;
            const viewport = {
              width: entry.contentRect.width,
              height: entry.contentRect.height,
            };
            if (awaitingInitialResize) {
              awaitingInitialResize = false;
              this._basis = paginationBasis(this._container, this._preferences, viewport);
              this._snapshot = null;
              void this._restoreCache().finally(() => this._schedule());
              return;
            }
            this._invalidateBasis(viewport);
          })
        : null;
    this._resizeObserver?.observe(options.container);
    if (view?.matchMedia !== undefined) {
      let resolution: MediaQueryList | null = null;
      const resolutionChanged = (): void => {
        resolution?.removeEventListener("change", resolutionChanged);
        resolution = view.matchMedia(`(resolution: ${String(view.devicePixelRatio)}dppx)`);
        resolution.addEventListener("change", resolutionChanged);
        this._invalidateBasis();
      };
      resolution = view.matchMedia(`(resolution: ${String(view.devicePixelRatio)}dppx)`);
      resolution.addEventListener("change", resolutionChanged);
      this._lifecycleController.signal.addEventListener(
        "abort",
        () => resolution?.removeEventListener("change", resolutionChanged),
        { once: true },
      );
    }
    options.container.ownerDocument.addEventListener(
      "visibilitychange",
      () => {
        if (options.container.ownerDocument.hidden) this._pause();
        else this._schedule();
      },
      { signal: this._lifecycleController.signal },
    );
    if (this._resizeObserver === null) {
      awaitingInitialResize = false;
      void this._restoreCache().finally(() => this._schedule());
    }
    queueMicrotask(() => {
      if (this._closed) return;
      const foreground = this._foregroundSnapshot?.();
      if (foreground !== undefined) this.updateForeground(foreground);
    });
  }

  snapshot(): BookPaginationSnapshot {
    if (this._snapshot !== null) return this._snapshot;
    const prefix = this._prefix;
    const exact = this._measuredOccurrences === this._entries.length;
    const countWorkExhausted = !exact && this._entries.every(isTerminalEntry);
    const totalPageCount = exact ? this._measuredPageCount : null;
    const entries = this._entries;
    const weights = this._weights;
    let estimate: ReturnType<typeof calibratedPageEstimate> | undefined;
    const estimated = () => (estimate ??= calibratedPageEstimate(entries, weights));
    this._snapshot = Object.freeze({
      publicationSequence: this._publicationSequence,
      runRevision: this._runRevision,
      basis: this._basis,
      freshness: this._freshness,
      activity: this._activity,
      foreground: this._foreground,
      pageCountCoverage: Object.freeze({
        state: exact ? "exact" : countWorkExhausted ? "unavailable" : "incomplete",
        measuredOccurrences: this._measuredOccurrences,
        totalOccurrences: this._entries.length,
        measuredPageCount: this._measuredPageCount,
        totalPageCount,
      }),
      tocEnrichment: Object.freeze({
        state:
          this._measuredTargets + this._terminalTargets === this._totalTargets
            ? "complete"
            : "pending",
        measuredTargets: this._measuredTargets,
        totalTargets: this._totalTargets,
      }),
      state: this._state,
      cachePersistence: this._cachePersistence(),
      occurrences: this._entries.view(),
      pageStart: (occurrence: number) => prefix.pageStart(occurrence),
      measuredPageCount: this._measuredPageCount,
      totalPageCount,
      get estimatedTotalPageCount() {
        return exact ? totalPageCount : (estimated()?.total ?? null);
      },
      estimatedPageStart: (occurrence: number) => estimated()?.starts[occurrence] ?? null,
      estimatedPageCount: (occurrence: number) => estimated()?.counts[occurrence] ?? null,
    });
    return this._snapshot;
  }

  subscribe(listener: PaginationSnapshotListener): () => void {
    if (this._closed) throw new Error("the pagination controller is closed");
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  // A page turn reaches the runtime as the agent's presentation activity, or as a host command
  // that echoes it within `turnEchoMs`; only distinct turns count toward a flip-through.
  noteForegroundActivity(turn?: "presentation" | "command"): void {
    if (this._closed) return;
    const now = this._now();
    this._lastForegroundActivityAt = now;
    if (
      turn === "presentation" ||
      (turn === "command" && (this._lastTurnAt === null || now - this._lastTurnAt > turnEchoMs))
    ) {
      this._previousTurnAt = this._lastTurnAt;
      this._lastTurnAt = now;
    }
    if (
      this._scheduledWork === null ||
      (this._quietTimer === null && this._scheduleTimer === null && this._idleHandle === null)
    ) {
      return;
    }
    if (
      this._workDeferralStartedAt !== null &&
      now - this._workDeferralStartedAt >= this._maximumDeferralMs()
    ) {
      return;
    }
    const scheduled = this._scheduledWork;
    this._cancelScheduledStart();
    this._armScheduledStart(scheduled);
  }

  setPreferences(preferences: PresentationPreferences): void {
    if (this._closed || samePreferences(this._preferences, preferences)) return;
    const layoutChanged = !samePreferences(
      layoutPreferences(this._preferences),
      layoutPreferences(preferences),
    );
    this._preferences = preferences;
    if (layoutChanged) this._invalidateBasis();
  }

  close(): void {
    if (this._closed) return;
    this._finishPaginationRun("cancelled");
    this._closed = true;
    const ownedWork =
      this._scheduledWork ??
      (this._activeOccurrence !== null && this._activeTask !== null
        ? { occurrence: this._activeOccurrence, task: this._activeTask }
        : null);
    if (ownedWork !== null)
      this._taskEvent("discard", ownedWork.occurrence, ownedWork.task, "close");
    this._clearTimers();
    this._resizeObserver?.disconnect();
    this._lifecycleController.abort();
    this._cancelForegroundSettlement();
    this._teardownMeasurementRuntime();
    this._listeners.clear();
    this._cancelCacheRestore();
    this._cacheController.abort();
    this._cancelCacheWrites(this._runRevision);
    this._pendingCacheWrites.clear();
    this._cacheRecordKeyPromises.clear();
    this._preparationClaims.clear();
    this._preparedProvenance.clear();
    for (const operation of this._preparedTargetOperations.values()) {
      operation.controller.abort("close");
    }
    this._preparedTargetOperations.clear();
  }
}
