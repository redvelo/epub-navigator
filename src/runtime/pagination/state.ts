import type {
  AdapterLayoutSettlement,
  CommittedLayout,
  KernelSnapshot,
  KernelTransition,
  OccurrenceDocumentTarget,
  PresentationPreferences,
} from "../../generated/kernel.js";
import type { PublicationFacts } from "../../generated/publication.js";
import type { TocTargetMeasurementOptions } from "../navigator/api.js";
import type { PaginationMeasurementRuntime } from "./contracts.js";
import type {
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
} from "../agent-protocol/index.js";
import type {
  BookPaginationSnapshot,
  ForegroundPreparationClaim,
  OccurrencePagination,
  PaginationBasis,
  PaginationCancellationReason,
  NavigatorDiagnosticEvent,
  NavigatorDiagnostics,
  PaginationSnapshotListener,
  TocTargetPagination,
} from "./types.js";
import { recordNavigatorDiagnostic } from "./types.js";
import type { PaginationPacing } from "./constants.js";
import type { PaginationCacheIdentity, PaginationMeasurementCache } from "./cache/contract.js";
import type { MeasurementRuntimeFactory, PreparedTocMeasurement } from "./capabilities.js";
import type { BackgroundTargetOwner, BackgroundTargetResult } from "./background-measurement.js";
import type { CacheRecordResult, CacheRestoreOwner } from "./cache/ownership.js";
import { OccurrenceStore } from "./occurrence-store.js";
import { PagePrefixIndex } from "./page-prefix-index.js";
import { OccurrencePriorityQueue } from "./priority-queue.js";
import type { ScheduledPaginationWork } from "./work.js";
import { DiagnosticsClock } from "../diagnostics-clock.js";

export interface PaginationStateInitialization {
  readonly facts: PublicationFacts;
  readonly documents: readonly OccurrenceDocumentTarget[];
  readonly weights: readonly number[];
  readonly pacing: PaginationPacing;
  readonly container: HTMLElement;
  readonly preferences: PresentationPreferences;
  readonly createMeasurementRuntime: MeasurementRuntimeFactory | null;
  readonly eligibleResourcePaths: ReadonlySet<string> | null;
  readonly cache: PaginationMeasurementCache | null;
  readonly cacheIdentity: PaginationCacheIdentity | null;
  readonly foregroundSnapshot: (() => KernelSnapshot) | null;
  readonly measureForegroundTocTargets:
    | ((
        targets: readonly TocTargetMeasurementRequest[],
        options?: TocTargetMeasurementOptions,
      ) => Promise<readonly TocTargetMeasurementResult[]>)
    | null;
  readonly measurePreparedTocTargets: PreparedTocMeasurement | null;
  readonly diagnostics: NavigatorDiagnostics | null;
  readonly entries: OccurrenceStore;
  readonly tocRequestsByOccurrence: readonly (readonly TocTargetMeasurementRequest[])[];
  readonly totalTargets: number;
  readonly basis: PaginationBasis;
  readonly preparationClaimsInvalidated: (() => void) | null;
  readonly basisRestarted: (() => void) | null;
}

export interface CacheWriteDiagnosticOperation {
  readonly runRevision: number;
  operationId: number | null;
  startedAt: number | null;
  occurrenceCount: number;
  operationCount: number;
  completedOperationCount: number;
  settled: boolean;
}

/** Constructor-initialized state owner shared through protected controller APIs only. */
export abstract class PaginationControllerState {
  protected readonly _facts: PublicationFacts;
  protected readonly _documents: readonly OccurrenceDocumentTarget[];
  protected readonly _weights: readonly number[];
  protected readonly _pacing: PaginationPacing;
  protected readonly _container: HTMLElement;
  protected readonly _createMeasurementRuntime: MeasurementRuntimeFactory | null;
  protected readonly _eligibleResourcePaths: ReadonlySet<string> | null;
  protected readonly _cache: PaginationMeasurementCache | null;
  protected readonly _cacheIdentity: PaginationCacheIdentity | null;
  protected readonly _foregroundSnapshot: (() => KernelSnapshot) | null;
  protected readonly _measureForegroundTocTargets: PaginationStateInitialization["measureForegroundTocTargets"];
  protected readonly _measurePreparedTocTargets: PreparedTocMeasurement | null;
  protected readonly _listeners = new Set<PaginationSnapshotListener>();
  protected _resizeObserver: ResizeObserver | null = null;
  protected readonly _diagnostics: NavigatorDiagnostics | null;
  protected readonly _diagnosticsClock: DiagnosticsClock;
  protected _entries: OccurrenceStore;
  protected readonly _tocRequestsByOccurrence: readonly (readonly TocTargetMeasurementRequest[])[];
  protected _prefix: PagePrefixIndex;
  protected _measuredOccurrences = 0;
  protected _measuredPageCount = 0;
  protected _measuredTargets = 0;
  protected _terminalTargets = 0;
  protected readonly _totalTargets: number;
  protected _snapshot: BookPaginationSnapshot | null = null;
  protected _freshness: BookPaginationSnapshot["freshness"] = "current";
  protected _activity: BookPaginationSnapshot["activity"] = "idle";
  protected _foregroundOccurrence: number | null = null;
  protected _pageQueue = new OccurrencePriorityQueue();
  protected _tocQueue = new OccurrencePriorityQueue();
  protected _runRevision = 1;
  protected _diagnosticRunStartedAt: number;
  protected _diagnosticRunTerminal = false;
  protected _runPageCountAttempts = 0;
  protected _runTimedOutOccurrences = new Set<number>();
  protected _runMeasurementMs = 0;
  protected _activePageCountStartedAt: number | null = null;
  protected _state: BookPaginationSnapshot["state"] = "idle";
  protected _preferences: PresentationPreferences;
  protected _runtime: PaginationMeasurementRuntime | null = null;
  protected _runtimePromise: Promise<PaginationMeasurementRuntime> | null = null;
  protected _runtimeUnsubscribe: (() => void) | null = null;
  protected _runtimeErrorUnsubscribe: (() => void) | null = null;
  protected _activeOccurrence: number | null = null;
  protected _activeTask: "page-count" | "toc" | null = null;
  protected _scheduledWork: ScheduledPaginationWork | null = null;
  protected _scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  protected _quietTimer: ReturnType<typeof setTimeout> | null = null;
  protected _lastForegroundActivityAt: number | null = null;
  protected _lastTurnAt: number | null = null;
  protected _previousTurnAt: number | null = null;
  protected _workDeferralStartedAt: number | null = null;
  protected _burstCount = 0;
  protected _restUntil: number | null = null;
  protected _quietAfterForegroundWork = false;
  protected _measurementTimer: ReturnType<typeof setTimeout> | null = null;
  protected _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  protected _foregroundCandidateKey: string | null = null;
  protected _foregroundTargetKey: string | null = null;
  protected _foregroundTargetToken = 0;
  protected _targetMeasurementTaskToken: number | null = null;
  protected _targetMeasurementController: AbortController | null = null;
  protected _foregroundTargetController: AbortController | null = null;
  protected _activeDocumentGeneration: number | null = null;
  protected _foregroundBusy = false;
  protected _foreground: BookPaginationSnapshot["foreground"] = { state: "unavailable" };
  protected _currentForeground: Extract<
    BookPaginationSnapshot["foreground"],
    { state: "current" }
  > | null = null;
  protected _closed = false;
  protected _cacheController = new AbortController();
  protected _cacheBasisPromise: Promise<string | null> | null = null;
  protected _cacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
  protected _cacheRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  protected _cacheRestoreController: AbortController | null = null;
  protected _cacheRestoreStartedAt: number | null = null;
  protected _cacheRestoreRunRevision: number | null = null;
  protected _cacheRestoreInitialClaims = 0;
  protected _cacheWriteChain: Promise<void> = Promise.resolve();
  protected _cacheWriteDrainScheduled = false;
  protected _pendingCacheWrites = new Map<
    number,
    { readonly occurrence: number; readonly runRevision: number; readonly recordRevision: number }
  >();
  protected _cacheWritable = true;
  protected _cacheRecordRevisions = new Map<number, number>();
  protected _cacheRecordKeyPromises = new Map<string, Promise<string>>();
  protected _cacheRestoreClaims = new Set<number>();
  protected _cacheRestoreInProgress = false;
  protected _dirtyCacheOccurrences = new Set<number>();
  protected _durableMeasuredOccurrences = new Set<number>();
  protected _preparationClaims = new Map<number, ForegroundPreparationClaim>();
  protected _preparedProvenance = new Map<number, string>();
  protected readonly _preparationClaimsInvalidated: (() => void) | null;
  protected readonly _basisRestarted: (() => void) | null;
  protected _nextPreparationClaimToken = 1;
  protected _idleHandle: number | null = null;
  protected _lifecycleController = new AbortController();
  protected _sessionToken = 0;
  protected _taskToken = 0;
  protected _updateSequence = 0;
  protected _publicationSequence = 0;
  protected _pageTasksSinceToc = 0;
  protected _attempts = new Map<number, number>();
  protected _basis: PaginationBasis;
  protected _pendingBasis: PaginationBasis | null = null;

  protected constructor(initial: PaginationStateInitialization) {
    this._facts = initial.facts;
    this._documents = initial.documents;
    this._weights = initial.weights;
    this._pacing = initial.pacing;
    this._container = initial.container;
    this._preferences = initial.preferences;
    this._createMeasurementRuntime = initial.createMeasurementRuntime;
    this._eligibleResourcePaths = initial.eligibleResourcePaths;
    this._cache = initial.cache;
    this._cacheIdentity = initial.cacheIdentity;
    this._foregroundSnapshot = initial.foregroundSnapshot;
    this._measureForegroundTocTargets = initial.measureForegroundTocTargets;
    this._measurePreparedTocTargets = initial.measurePreparedTocTargets;
    this._diagnostics = initial.diagnostics;
    this._diagnosticsClock = new DiagnosticsClock(initial.diagnostics?.now);
    this._diagnosticRunStartedAt = this._diagnosticsClock.now();
    this._entries = initial.entries;
    this._tocRequestsByOccurrence = initial.tocRequestsByOccurrence;
    this._totalTargets = initial.totalTargets;
    this._prefix = PagePrefixIndex.empty(initial.entries.length);
    this._basis = initial.basis;
    this._preparationClaimsInvalidated = initial.preparationClaimsInvalidated;
    this._basisRestarted = initial.basisRestarted;
  }

  abstract snapshot(): BookPaginationSnapshot;
  abstract subscribe(listener: PaginationSnapshotListener): () => void;
  abstract noteForegroundActivity(turn?: "presentation" | "command"): void;
  abstract claimForegroundPreparation(occurrence: number): ForegroundPreparationClaim | null;
  abstract releaseForegroundPreparation(
    claim: ForegroundPreparationClaim,
    preserveAccepted?: boolean,
  ): void;
  abstract acceptPreparedLayout(
    claim: ForegroundPreparationClaim,
    resource: string,
    frameGeneration: number,
    layoutGeneration: number,
    layout: AdapterLayoutSettlement,
  ): boolean;
  abstract updateForeground(snapshot: KernelSnapshot): void;
  abstract setPreferences(preferences: PresentationPreferences): void;
  abstract close(): void;

  protected abstract _invalidateBasis(viewport?: PaginationBasis["viewport"]): void;
  protected abstract _armBasisRestart(): void;
  protected abstract _pause(): void;
  protected abstract _schedule(continueBurst?: boolean): void;
  protected abstract _armScheduledStart(
    scheduled: ScheduledPaginationWork,
    continueBurst?: boolean,
  ): void;
  protected abstract _cancelScheduledStart(): void;
  protected abstract _measure(work: ScheduledPaginationWork): Promise<void>;
  protected abstract _measurementRuntime(): Promise<PaginationMeasurementRuntime>;
  protected abstract _measurementTransition(
    runtime: PaginationMeasurementRuntime,
    transition: KernelTransition,
  ): void;
  protected abstract _setBackgroundMeasuredAndContinueTargets(
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
  ): void;
  protected abstract _setMeasured(
    occurrence: number,
    resource: string,
    pageCount: number,
    columnsPerView: 1 | 2,
    source: "foreground" | "background",
    durable: boolean,
    tocTargets?: readonly TocTargetPagination[],
  ): void;
  protected abstract _measureForegroundTargets(
    snapshot: KernelSnapshot,
    candidateKey: string,
  ): Promise<void>;
  protected abstract _ownsForegroundTarget(
    token: number,
    operationKey: string,
    documentGeneration: number,
    layout: CommittedLayout,
  ): boolean;
  protected abstract _setInapplicable(occurrence: number, reason: string): void;
  protected abstract _setUnavailable(occurrence: number, reason: string): void;
  protected abstract _requeue(occurrence: number): void;
  protected abstract _requeuePageCount(
    occurrence: number,
    reason: PaginationCancellationReason,
  ): void;
  protected abstract _setFailed(occurrence: number, cause: unknown): void;
  protected abstract _setTargets(
    occurrence: number,
    results: readonly TocTargetPagination[],
    completeTask?: boolean,
  ): void;
  protected abstract _setTargetFailure(occurrence: number, cause: unknown): void;
  protected abstract _replaceEntry(occurrence: number, entry: OccurrencePagination): void;
  protected abstract _commitMeasured(
    occurrence: number,
    entry: Extract<OccurrencePagination, { state: "measured" }>,
    durable?: boolean,
  ): void;
  protected abstract _resetAggregates(): void;
  protected abstract _rebuildWorkQueue(): void;
  protected abstract _nextWork(): {
    readonly occurrence: number;
    readonly task: "page-count" | "toc";
  } | null;
  protected abstract _nextTocWork(): { readonly occurrence: number; readonly task: "toc" } | null;
  protected abstract _preemptClaimedOccurrence(occurrence: number): void;
  protected abstract _revokePreparationClaims(): void;
  protected abstract _publish(): void;
  protected abstract _auxiliaryContainer(): HTMLElement;
  protected abstract _removeAuxiliaryContainer(): void;
  protected abstract _taskEvent(
    action: Extract<NavigatorDiagnosticEvent, { type: "controller-task" }>["action"],
    work: ScheduledPaginationWork,
    reason?: PaginationCancellationReason,
  ): void;
  protected abstract _taskEvent(
    action: Extract<NavigatorDiagnosticEvent, { type: "controller-task" }>["action"],
    occurrence: number,
    task: "page-count" | "toc",
    reason?: PaginationCancellationReason,
  ): void;
  protected abstract _clearTimers(): void;
  protected abstract _armMeasurementDeadline(work: ScheduledPaginationWork): void;
  protected abstract _cancelMeasurementDeadline(): void;
  protected abstract _cancelMeasurementDeadlineFor(occurrence: number): void;
  protected abstract _retryPageCount(occurrence: number, cause: unknown): void;
  protected abstract _cancelForegroundSettlement(): void;
  protected abstract _teardownMeasurementRuntime(): void;
  protected abstract _resetOwnedEpoch(): void;
  protected abstract _restoreCache(): Promise<void>;
  protected abstract _ownsCacheRestore(
    revision: number,
    controller: AbortController,
    claims: Set<number>,
  ): boolean;
  protected abstract _ownsPendingRestore(
    occurrence: number,
    revision: number,
    entryRevision: number,
    signal: AbortSignal,
  ): boolean;
  protected abstract _readCacheRecord<T>(
    owner: CacheRestoreOwner,
    basis: string,
    record: string,
    recordType: "page" | "toc-target",
    validate: (value: unknown) => value is T,
    signal: AbortSignal,
  ): Promise<CacheRecordResult<T>>;
  protected abstract _queueCacheWrite(occurrence: number): void;
  protected abstract _flushCacheWrites(): void;
  protected abstract _queueCacheRemoval(occurrence: number): void;
  protected abstract _queueCurrentCacheReset(occurrence: number): void;
  protected abstract _writeCache(
    occurrence: number,
    runRevision: number,
    recordRevision: number,
    diagnostic: CacheWriteDiagnosticOperation,
  ): Promise<void>;
  protected abstract _drainBulkCacheWrites(): Promise<void>;
  protected abstract _cacheBasis(): Promise<string | null>;
  protected abstract _occurrenceRecordKey(occurrence: number, part: string): Promise<string>;
  protected abstract _resourceIsCacheEligible(occurrence: number): boolean;
  protected abstract _removeCurrentCacheEntry(): Promise<boolean>;
  protected abstract _removeCachedOccurrence(
    occurrence: number,
    basisPromise: Promise<string | null>,
    keysPromise: Promise<readonly string[]>,
    signal: AbortSignal,
  ): Promise<void>;
  protected abstract _finishCacheWriteRun(runRevision: number): void;
  protected abstract _cancelCacheWrites(runRevision: number): void;
  protected abstract _measureTargets(
    runtime: PaginationMeasurementRuntime,
    owner: BackgroundTargetOwner,
  ): Promise<BackgroundTargetResult | null>;
  protected abstract _cacheEvent(
    action: "read" | "write" | "remove",
    occurrence: number,
    bytes: number,
    started: number,
    outcome: Extract<NavigatorDiagnosticEvent, { type: "cache" }>["outcome"],
    recordType?: "page" | "toc-target",
  ): void;

  _now(): number {
    return this._diagnosticsClock.now();
  }

  _startPaginationRun(): void {
    this._diagnosticRunStartedAt = this._now();
    this._diagnosticRunTerminal = false;
    this._runPageCountAttempts = 0;
    this._runTimedOutOccurrences.clear();
    this._runMeasurementMs = 0;
    this._activePageCountStartedAt = null;
    this._record({
      type: "pagination-run",
      action: "start",
      runRevision: this._runRevision,
      durationMs: 0,
      measuredOccurrences: 0,
      totalOccurrences: this._entries.length,
      measuredPageCount: 0,
      totalPageCount: null,
      measuredTargets: 0,
      totalTargets: this._totalTargets,
      outcome: "running",
      pageCountAttempts: 0,
      timedOutOccurrences: 0,
      measurementMs: 0,
    });
  }

  _finishPaginationRun(
    outcome: Exclude<
      Extract<NavigatorDiagnosticEvent, { type: "pagination-run" }>["outcome"],
      "running"
    >,
    snapshot = this.snapshot(),
  ): void {
    if (this._diagnosticRunTerminal) return;
    this._diagnosticRunTerminal = true;
    this._accumulatePageCountTime();
    this._record({
      type: "pagination-run",
      action: "terminal",
      runRevision: this._runRevision,
      durationMs: Math.max(0, this._now() - this._diagnosticRunStartedAt),
      measuredOccurrences: snapshot.pageCountCoverage.measuredOccurrences,
      totalOccurrences: snapshot.pageCountCoverage.totalOccurrences,
      measuredPageCount: snapshot.pageCountCoverage.measuredPageCount,
      totalPageCount: snapshot.pageCountCoverage.totalPageCount,
      measuredTargets: snapshot.tocEnrichment.measuredTargets,
      totalTargets: snapshot.tocEnrichment.totalTargets,
      outcome,
      pageCountAttempts: this._runPageCountAttempts,
      timedOutOccurrences: this._runTimedOutOccurrences.size,
      measurementMs: this._runMeasurementMs,
    });
    this._finishCacheWriteRun(this._runRevision);
  }

  _accumulatePageCountTime(): void {
    if (this._activePageCountStartedAt === null) return;
    this._runMeasurementMs += Math.max(0, this._now() - this._activePageCountStartedAt);
    this._activePageCountStartedAt = null;
  }

  _record(event: NavigatorDiagnosticEvent): void {
    recordNavigatorDiagnostic(this._diagnostics, event);
  }
}
