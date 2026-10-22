import type {
  BookPaginationSnapshot,
  NavigatorDiagnosticEvent,
  NavigatorDiagnostics,
} from "../types.js";
import { cacheRecordMaxBytes, decodeCacheRecord } from "./codec.js";
import type { PaginationCacheMutation, PaginationMeasurementCache } from "./contract.js";
import { DiagnosticsClock } from "../../diagnostics-clock.js";

export interface CacheReadResult<Owner, T> {
  readonly owner: Owner;
  readonly value: T | null;
}

/** Serializes writes/removals while leaving result acceptance to the controller. */
export class PaginationCacheRepository {
  readonly #cache: PaginationMeasurementCache;
  readonly #diagnostics: NavigatorDiagnostics | null;
  readonly #diagnosticsClock: DiagnosticsClock;
  #writes: Promise<void> = Promise.resolve();

  constructor(cache: PaginationMeasurementCache, diagnostics: NavigatorDiagnostics | null) {
    this.#cache = cache;
    this.#diagnostics = diagnostics;
    this.#diagnosticsClock = new DiagnosticsClock(diagnostics?.now);
  }

  async read<Owner, T>(
    owner: Owner,
    occurrence: number,
    basis: string,
    record: string,
    validate: (value: unknown) => value is T,
    signal: AbortSignal,
  ): Promise<CacheReadResult<Owner, T>> {
    const started = this.#now();
    let bytes: Uint8Array | null = null;
    try {
      bytes = await this.#cache.read(basis, record, { signal, maxBytes: cacheRecordMaxBytes });
      if (bytes === null) {
        this.#record(occurrence, "read", 0, started, "miss");
        return { owner, value: null };
      }
      const value = decodeCacheRecord(bytes, validate);
      if (value !== null) {
        this.#record(occurrence, "read", bytes.byteLength, started, "hit");
        return { owner, value };
      }
      this.#record(occurrence, "read", bytes.byteLength, started, "invalid");
      await this.#cache.remove?.(basis, record, { signal });
      return { owner, value: null };
    } catch (cause) {
      this.#record(
        occurrence,
        "read",
        bytes?.byteLength ?? 0,
        started,
        signal.aborted ? "cancelled" : "failed",
      );
      throw cause;
    }
  }

  write(
    occurrence: number,
    basis: string,
    record: string,
    value: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    return (this.#writes = this.#writes.then(async () => {
      const started = this.#now();
      await this.#cache.write(basis, record, value, { signal });
      this.#record(occurrence, "write", value.byteLength, started, "complete");
    }));
  }

  remove(occurrence: number, basis: string, record: string, signal: AbortSignal): Promise<void> {
    return (this.#writes = this.#writes.then(async () => {
      if (this.#cache.remove === undefined) return;
      const started = this.#now();
      await this.#cache.remove(basis, record, { signal });
      this.#record(occurrence, "remove", 0, started, "complete");
    }));
  }

  #now(): number {
    return this.#diagnosticsClock.now();
  }

  #record(
    occurrence: number,
    action: "read" | "write" | "remove",
    bytes: number,
    started: number,
    outcome: Extract<NavigatorDiagnosticEvent, { type: "cache" }>["outcome"],
  ): void {
    try {
      this.#diagnostics?.record({
        type: "cache",
        action,
        occurrence,
        bytes,
        durationMs: this.#now() - started,
        outcome,
      });
    } catch {
      // Diagnostics are outside cache ordering and ownership.
    }
  }
}

import type { TocTargetPagination } from "../types.js";
import { hasPendingTargets, pendingTargets, targetIdentity } from "../occurrence-state.js";
import { isAbortError } from "../abort.js";
import { cacheRestoreStallDeadlineMs } from "../constants.js";
import {
  encodeCacheRecord,
  isCacheableInapplicableReason,
  isCachedPageRecord,
  isCachedTargetRecord,
} from "../cache/codec.js";
import type { CachedTargetRecord } from "../cache/codec.js";
import { canonicalJson, isCacheIdentity, sha256 } from "../cache/identity.js";
import { OccurrencePaginationController } from "../occurrence-state.js";
import type { CacheRecordResult, CacheRestoreOwner } from "./ownership.js";
import type { CacheWriteDiagnosticOperation } from "../state.js";

interface CacheWriteDrainState {
  readonly startedAt: number;
  active: number;
  terminal: boolean;
  hadWork: boolean;
  failed: boolean;
  cancelled: boolean;
}

type CacheRecordType = "page" | "toc-target";

type CacheRecordReader = <T>(
  owner: CacheRestoreOwner,
  record: string,
  recordType: CacheRecordType,
  validate: (value: unknown) => value is T,
) => Promise<CacheRecordResult<T>>;

interface PendingBulkCacheRead {
  readonly record: string;
  readonly complete: (read: () => Promise<Uint8Array | null>) => void;
}

interface PendingCacheWrite {
  readonly occurrence: number;
  readonly runRevision: number;
  readonly recordRevision: number;
}

interface PreparedCacheMutation {
  readonly occurrence: number;
  readonly runRevision: number;
  readonly recordRevision: number;
  readonly recordType: CacheRecordType;
  readonly mutation: PaginationCacheMutation;
}

export abstract class CachePaginationController extends OccurrencePaginationController {
  readonly #cacheWriteOperations = new Set<CacheWriteDiagnosticOperation>();
  #publishedCachePersistence: BookPaginationSnapshot["cachePersistence"] | null = null;
  readonly #cacheWriteDrains = new Map<number, CacheWriteDrainState>();
  readonly #finishedCacheWriteRuns = new Set<number>();
  #nextCacheWriteOperationId = 1;

  async _restoreCache(): Promise<void> {
    if (this._cache === null || this._cacheIdentity === null || this._closed) return;
    this._cancelCacheRestore();
    const revision = this._runRevision;
    const controller = new AbortController();
    const signal = controller.signal;
    const started = this._now();
    const claims = new Set(
      [...this._entries]
        .filter(
          (entry) => entry.state === "pending" && this._resourceIsCacheEligible(entry.occurrence),
        )
        .map((entry) => entry.occurrence),
    );
    this._cacheRestoreController = controller;
    this._cacheRestoreStartedAt = started;
    this._cacheRestoreRunRevision = revision;
    this._cacheRestoreInitialClaims = claims.size;
    this._cacheRestoreInProgress = true;
    this._cacheRestoreClaims = claims;
    if (claims.size === 0) {
      this._cacheRestoreController = null;
      this._cacheRestoreStartedAt = null;
      this._cacheRestoreRunRevision = null;
      this._cacheRestoreInProgress = false;
      return;
    }
    this._cacheRestoreEvent("start", revision, started, claims.size, claims.size);
    const clearWatchdog = (): void => {
      if (this._cacheRestoreTimer !== null) clearTimeout(this._cacheRestoreTimer);
      this._cacheRestoreTimer = null;
    };
    const armWatchdog = (): void => {
      if (!this._ownsCacheRestore(revision, controller, claims)) return;
      clearWatchdog();
      const timer = setTimeout(() => {
        if (
          this._cacheRestoreTimer !== timer ||
          !this._ownsCacheRestore(revision, controller, claims)
        )
          return;
        this._cacheRestoreTimer = null;
        this._cacheRestoreController = null;
        this._cacheRestoreStartedAt = null;
        this._cacheRestoreRunRevision = null;
        this._cacheRestoreInProgress = false;
        const remaining = claims.size;
        claims.clear();
        this._cacheRestoreEvent(
          "stalled",
          revision,
          started,
          this._cacheRestoreInitialClaims,
          remaining,
        );
        controller.abort(new DOMException("pagination cache restoration stalled", "AbortError"));
        this._rebuildWorkQueue();
        this._schedule();
      }, cacheRestoreStallDeadlineMs);
      this._cacheRestoreTimer = timer;
    };
    armWatchdog();
    let flushPendingBulkWork = (): void => {};
    try {
      const basis = await this._cacheBasis();
      if (basis === null || !this._ownsCacheRestore(revision, controller, claims)) return;
      armWatchdog();
      const entries = [...this._entries];
      const pageKeys = new Map(
        await Promise.all(
          entries
            .filter((entry) => claims.has(entry.occurrence))
            .map(
              async (entry) =>
                [
                  entry.occurrence,
                  await this._occurrenceRecordKey(entry.occurrence, "page"),
                ] as const,
            ),
        ),
      );
      if (!this._ownsCacheRestore(revision, controller, claims)) return;
      const bulkRestore = this._cache.readMany !== undefined;
      let bulkWorkScheduled = false;
      let bulkPublishRequested = false;
      let bulkQueueRebuildRequested = false;
      let bulkScheduleRequested = false;
      flushPendingBulkWork = (): void => {
        if (!bulkWorkScheduled) return;
        bulkWorkScheduled = false;
        const publish = bulkPublishRequested;
        const rebuildQueue = bulkQueueRebuildRequested;
        const schedule = bulkScheduleRequested;
        bulkPublishRequested = false;
        bulkQueueRebuildRequested = false;
        bulkScheduleRequested = false;
        if (!this._ownsCacheRestore(revision, controller, claims)) return;
        if (publish) this._publish();
        if (rebuildQueue) this._rebuildWorkQueue();
        if (schedule) this._schedule();
      };
      const requestBulkWork = (
        publish: boolean,
        rebuildQueue: boolean,
        schedule: boolean,
      ): void => {
        bulkPublishRequested ||= publish;
        bulkQueueRebuildRequested ||= rebuildQueue;
        bulkScheduleRequested ||= schedule;
        if (bulkWorkScheduled) return;
        bulkWorkScheduled = true;
        queueMicrotask(flushPendingBulkWork);
      };
      const readCacheRecord: CacheRecordReader = !bulkRestore
        ? (owner, record, recordType, validate) =>
            this._readCacheRecord(owner, basis, record, recordType, validate, signal)
        : this._bulkCacheRecordReader(basis, signal);
      let nextEntry = 0;
      const restoreEntries = async (): Promise<void> => {
        while (nextEntry < entries.length) {
          const current = entries[nextEntry++];
          if (current === undefined) return;
          if (!this._ownsCacheRestore(revision, controller, claims)) return;
          try {
            if (current.state !== "pending" || !this._resourceIsCacheEligible(current.occurrence)) {
              continue;
            }
            const entryRevision = this._cacheRecordRevisions.get(current.occurrence) ?? 0;
            const owner: CacheRestoreOwner = Object.freeze({
              channel: "cache",
              occurrence: current.occurrence,
              runRevision: revision,
              entryRevision,
            });
            const pageKey = pageKeys.get(current.occurrence);
            if (pageKey === undefined) continue;
            if (!this._ownsPendingRestore(current.occurrence, revision, entryRevision, signal))
              continue;
            const pageResult = await readCacheRecord(owner, pageKey, "page", isCachedPageRecord);
            armWatchdog();
            if (pageResult.owner !== owner) continue;
            const pageRecord = pageResult.value;
            if (!this._ownsPendingRestore(current.occurrence, revision, entryRevision, signal))
              continue;
            if (pageRecord === null) continue;
            if (pageRecord.type === "inapplicable") {
              this._replaceEntry(current.occurrence, {
                occurrence: current.occurrence,
                resource: current.resource,
                state: "inapplicable",
                reason: pageRecord.reason,
              });
              if (bulkRestore) requestBulkWork(true, false, false);
              else this._publish();
              continue;
            }
            const targets: TocTargetPagination[] = [];
            for (const pending of pendingTargets(
              this._tocRequestsByOccurrence[current.occurrence] ?? [],
            )) {
              const targetKey = await this._occurrenceRecordKey(
                current.occurrence,
                `target:${targetIdentity(pending)}`,
              );
              if (!this._ownsPendingRestore(current.occurrence, revision, entryRevision, signal))
                break;
              const targetResult = await readCacheRecord(
                owner,
                targetKey,
                "toc-target",
                (value): value is CachedTargetRecord =>
                  isCachedTargetRecord(value, pageRecord.pageCount, pageRecord.revision),
              );
              armWatchdog();
              if (targetResult.owner !== owner) break;
              const record = targetResult.value;
              if (!this._ownsPendingRestore(current.occurrence, revision, entryRevision, signal))
                break;
              targets.push(record === null ? pending : { ...pending, result: record.result });
            }
            if (
              targets.length !== (this._tocRequestsByOccurrence[current.occurrence]?.length ?? 0) ||
              !this._ownsPendingRestore(current.occurrence, revision, entryRevision, signal)
            ) {
              continue;
            }
            this._commitMeasured(
              current.occurrence,
              {
                occurrence: current.occurrence,
                resource: current.resource,
                state: "measured",
                pageCount: pageRecord.pageCount,
                columnsPerView: pageRecord.columnsPerView,
                tocTargets: targets,
                source: "background",
              },
              pageRecord.settled,
            );
            if (hasPendingTargets(this._entries.get(current.occurrence))) {
              this._tocQueue.push(current.occurrence, this._foregroundOccurrence);
            }
            if (bulkRestore) requestBulkWork(true, false, false);
            else this._publish();
          } finally {
            if (
              this._ownsCacheRestore(revision, controller, claims) &&
              claims.delete(current.occurrence)
            ) {
              if (claims.size === 0) clearWatchdog();
              else armWatchdog();
              if (bulkRestore) requestBulkWork(false, true, true);
              else {
                this._rebuildWorkQueue();
                this._schedule();
              }
            }
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(this._cache.readMany === undefined ? 8 : 32, entries.length) },
          () => restoreEntries(),
        ),
      );
    } catch (cause) {
      if (!isAbortError(cause)) return;
    } finally {
      flushPendingBulkWork();
      if (this._ownsCacheRestore(revision, controller, claims)) {
        clearWatchdog();
        this._cacheRestoreController = null;
        this._cacheRestoreStartedAt = null;
        this._cacheRestoreRunRevision = null;
        this._cacheRestoreInProgress = false;
        const remaining = claims.size;
        claims.clear();
        this._cacheRestoreEvent(
          "complete",
          revision,
          started,
          this._cacheRestoreInitialClaims,
          remaining,
        );
        if (this._cache.readMany === undefined || remaining > 0) this._rebuildWorkQueue();
      }
    }
  }

  _ownsCacheRestore(revision: number, controller: AbortController, claims: Set<number>): boolean {
    return (
      !this._closed &&
      this._cacheRestoreInProgress &&
      this._cacheRestoreController === controller &&
      this._cacheRestoreClaims === claims &&
      !controller.signal.aborted &&
      revision === this._runRevision
    );
  }

  _ownsPendingRestore(
    occurrence: number,
    revision: number,
    entryRevision: number,
    signal: AbortSignal,
  ): boolean {
    return (
      this._cacheRestoreController?.signal === signal &&
      !signal.aborted &&
      revision === this._runRevision &&
      this._cacheRestoreClaims.has(occurrence) &&
      this._entries.get(occurrence)?.state === "pending" &&
      (this._cacheRecordRevisions.get(occurrence) ?? 0) === entryRevision
    );
  }

  async _readCacheRecord<T>(
    owner: CacheRestoreOwner,
    basis: string,
    record: string,
    recordType: "page" | "toc-target",
    validate: (value: unknown) => value is T,
    signal: AbortSignal,
  ): Promise<CacheRecordResult<T>> {
    const cache = this._cache;
    if (cache === null) return { owner, value: null };
    return this._decodeCacheRecord(
      owner,
      basis,
      record,
      recordType,
      validate,
      signal,
      this._now(),
      () => cache.read(basis, record, { signal, maxBytes: cacheRecordMaxBytes }),
    );
  }

  _bulkCacheRecordReader(basis: string, signal: AbortSignal): CacheRecordReader {
    const cache = this._cache;
    if (cache?.readMany === undefined) {
      return (owner, record, recordType, validate) =>
        this._readCacheRecord(owner, basis, record, recordType, validate, signal);
    }
    const readMany = cache.readMany.bind(cache);
    const pending: PendingBulkCacheRead[] = [];
    let scheduled = false;
    const flush = (): void => {
      scheduled = false;
      const batch = pending.splice(0, 32);
      if (batch.length === 0) return;
      const values = signal.aborted
        ? Promise.reject(new DOMException("pagination cache restoration cancelled", "AbortError"))
        : Promise.resolve()
            .then(() =>
              readMany(
                basis,
                batch.map(({ record }) => record),
                { signal, maxBytes: cacheRecordMaxBytes },
              ),
            )
            .then((result) => {
              if (result.length !== batch.length) {
                throw new TypeError("pagination cache bulk read result is not aligned");
              }
              return result;
            });
      for (const [index, request] of batch.entries()) {
        request.complete(async () => (await values)[index] ?? null);
      }
      if (pending.length > 0) {
        scheduled = true;
        queueMicrotask(flush);
      }
    };
    return <T>(
      owner: CacheRestoreOwner,
      record: string,
      recordType: CacheRecordType,
      validate: (value: unknown) => value is T,
    ): Promise<CacheRecordResult<T>> =>
      new Promise((resolve, reject) => {
        pending.push({
          record,
          complete: (read) => {
            void this._decodeCacheRecord(
              owner,
              basis,
              record,
              recordType,
              validate,
              signal,
              this._now(),
              read,
            ).then(resolve, reject);
          },
        });
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(flush);
      });
  }

  async _decodeCacheRecord<T>(
    owner: CacheRestoreOwner,
    basis: string,
    record: string,
    recordType: CacheRecordType,
    validate: (value: unknown) => value is T,
    signal: AbortSignal,
    started: number,
    read: () => Promise<Uint8Array | null>,
  ): Promise<CacheRecordResult<T>> {
    const cache = this._cache;
    if (cache === null) return { owner, value: null };
    let byteLength = 0;
    let bytes: Uint8Array | null;
    try {
      bytes = await read();
      if (signal.aborted)
        throw new DOMException("pagination cache restoration cancelled", "AbortError");
    } catch (cause) {
      if (isAbortError(cause)) {
        this._cacheEvent("read", owner.occurrence, byteLength, started, "cancelled", recordType);
        throw cause;
      }
      this._cacheEvent("read", owner.occurrence, byteLength, started, "failed", recordType);
      return { owner, value: null };
    }
    if (bytes === null) {
      this._cacheEvent("read", owner.occurrence, 0, started, "miss", recordType);
      return { owner, value: null };
    }
    byteLength = bytes.byteLength;
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (validate(value)) {
        this._cacheEvent("read", owner.occurrence, byteLength, started, "hit", recordType);
        return { owner, value };
      }
    } catch {
      // Invalid records are removed below without affecting valid siblings.
    }
    this._cacheEvent("read", owner.occurrence, byteLength, started, "invalid", recordType);
    const removeStarted = this._now();
    try {
      if (cache.remove !== undefined) await cache.remove(basis, record, { signal });
      else await cache.writeMany?.(basis, [{ type: "remove", record }], { signal });
      this._cacheEvent("remove", owner.occurrence, byteLength, removeStarted, "complete");
    } catch (cause) {
      this._cacheEvent(
        "remove",
        owner.occurrence,
        byteLength,
        removeStarted,
        signal.aborted || isAbortError(cause) ? "cancelled" : "failed",
      );
    }
    return { owner, value: null };
  }

  _cancelCacheRestore(): void {
    const controller = this._cacheRestoreController;
    if (controller === null) return;
    if (this._cacheRestoreTimer !== null) clearTimeout(this._cacheRestoreTimer);
    this._cacheRestoreTimer = null;
    this._cacheRestoreController = null;
    this._cacheRestoreInProgress = false;
    const remaining = this._cacheRestoreClaims.size;
    this._cacheRestoreClaims.clear();
    const started = this._cacheRestoreStartedAt ?? this._now();
    const revision = this._cacheRestoreRunRevision ?? this._runRevision;
    this._cacheRestoreStartedAt = null;
    this._cacheRestoreRunRevision = null;
    this._cacheRestoreEvent(
      "cancelled",
      revision,
      started,
      this._cacheRestoreInitialClaims,
      remaining,
    );
    controller.abort(new DOMException("pagination cache restoration cancelled", "AbortError"));
  }

  _cacheRestoreEvent(
    action: Extract<NavigatorDiagnosticEvent, { type: "cache-restore" }>["action"],
    runRevision: number,
    started: number,
    claimedOccurrences: number,
    remainingOccurrences: number,
  ): void {
    this._record({
      type: "cache-restore",
      action,
      runRevision,
      claimedOccurrences,
      remainingOccurrences,
      durationMs: this._now() - started,
    });
  }

  _queueCacheWrite(occurrence: number): void {
    if (
      this._cache === null ||
      this._cacheIdentity === null ||
      !this._cacheWritable ||
      this._closed
    )
      return;
    this._dirtyCacheOccurrences.add(occurrence);
    if (
      this._createMeasurementRuntime !== null &&
      this._measuredOccurrences < this._entries.length
    ) {
      this._publishCachePersistence();
      return;
    }
    if (this._cacheWriteTimer !== null) clearTimeout(this._cacheWriteTimer);
    this._cacheWriteTimer = setTimeout(() => {
      this._cacheWriteTimer = null;
      this._flushCacheWrites();
    }, 500);
    this._publishCachePersistence();
  }

  _flushCacheWrites(): void {
    if (this._cacheWriteTimer !== null) clearTimeout(this._cacheWriteTimer);
    this._cacheWriteTimer = null;
    const occurrences = [...this._dirtyCacheOccurrences];
    this._dirtyCacheOccurrences.clear();
    if (this._cache?.writeMany !== undefined) {
      for (const dirty of occurrences) {
        const recordRevision = (this._cacheRecordRevisions.get(dirty) ?? 0) + 1;
        this._cacheRecordRevisions.set(dirty, recordRevision);
        this._pendingCacheWrites.set(dirty, {
          occurrence: dirty,
          runRevision: this._runRevision,
          recordRevision,
        });
      }
      if (this._pendingCacheWrites.size === 0 || this._cacheWriteDrainScheduled) {
        this._publishCachePersistence();
        return;
      }
      this._cacheWriteDrainScheduled = true;
      this._cacheWriteChain = this._cacheWriteChain.then(() => this._drainBulkCacheWrites());
      this._publishCachePersistence();
      return;
    }
    for (const dirty of occurrences) {
      const recordRevision = (this._cacheRecordRevisions.get(dirty) ?? 0) + 1;
      this._cacheRecordRevisions.set(dirty, recordRevision);
      const runRevision = this._runRevision;
      const diagnostic = this._reserveCacheWrite(runRevision);
      this._cacheWriteChain = this._cacheWriteChain.then(() =>
        this._writeCache(dirty, runRevision, recordRevision, diagnostic),
      );
    }
    this._publishCachePersistence();
  }

  async _drainBulkCacheWrites(): Promise<void> {
    try {
      while (this._pendingCacheWrites.size > 0 && !this._closed) {
        const pending = [...this._pendingCacheWrites.values()];
        this._pendingCacheWrites.clear();
        for (const runRevision of new Set(pending.map((write) => write.runRevision))) {
          await this._writeCacheWave(
            pending.filter((write) => write.runRevision === runRevision),
          ).catch(() => undefined);
        }
      }
    } finally {
      this._cacheWriteDrainScheduled = false;
      this._publishCachePersistence();
    }
  }

  async _writeCacheWave(pending: readonly PendingCacheWrite[]): Promise<void> {
    const runRevision = pending[0]?.runRevision;
    if (runRevision === undefined) return;
    const diagnostic = this._reserveCacheWrite(runRevision);
    const cache = this._cache;
    if (cache?.writeMany === undefined || !this._cacheWritable || this._closed) {
      this._settleCacheWrite(diagnostic, "cancelled");
      return;
    }
    const signal = this._cacheController.signal;
    try {
      const basis = await this._cacheBasis();
      if (basis === null || signal.aborted) {
        this._settleCacheWrite(diagnostic, "cancelled");
        return;
      }
      const operations = (
        await Promise.all(pending.map((write) => this._prepareCacheWrite(write)))
      ).flat();
      if (operations.length === 0) {
        this._settleCacheWrite(diagnostic, "cancelled");
        return;
      }
      this._startCacheWrite(
        diagnostic,
        new Set(operations.map(({ occurrence }) => occurrence)).size,
        operations.length,
      );
      let failed = false;
      let cancelled = false;
      const failedOccurrences = new Set<number>();
      for (let offset = 0; offset < operations.length; offset += 32) {
        const candidateBatch = operations.slice(offset, offset + 32);
        const batch = candidateBatch.filter((operation) => {
          return (
            !failedOccurrences.has(operation.occurrence) && this._ownsPreparedCacheWrite(operation)
          );
        });
        cancelled ||= batch.length !== candidateBatch.length && !failed;
        if (batch.length === 0) {
          cancelled = true;
          continue;
        }
        const batchStarted = this._now();
        try {
          await cache.writeMany(
            basis,
            batch.map(({ mutation }) => mutation),
            { signal },
          );
          diagnostic.completedOperationCount += batch.length;
          for (const operation of batch) {
            this._cacheEvent(
              operation.mutation.type,
              operation.occurrence,
              operation.mutation.type === "write" ? operation.mutation.value.byteLength : 0,
              batchStarted,
              "complete",
              operation.recordType,
            );
          }
        } catch (cause) {
          const outcome = signal.aborted || isAbortError(cause) ? "cancelled" : "failed";
          for (const operation of batch) {
            failedOccurrences.add(operation.occurrence);
            this._cacheEvent(
              operation.mutation.type,
              operation.occurrence,
              operation.mutation.type === "write" ? operation.mutation.value.byteLength : 0,
              batchStarted,
              outcome,
              operation.recordType,
            );
          }
          if (outcome === "cancelled") throw cause;
          failed = true;
        }
      }
      this._settleCacheWrite(diagnostic, failed ? "failed" : cancelled ? "cancelled" : "complete");
    } catch (cause) {
      this._settleCacheWrite(
        diagnostic,
        signal.aborted || isAbortError(cause) ? "cancelled" : "failed",
      );
    }
  }

  async _prepareCacheWrite(write: PendingCacheWrite): Promise<readonly PreparedCacheMutation[]> {
    if (!this._ownsPreparedCacheWrite(write)) return [];
    const entry = this._entries.get(write.occurrence);
    if (
      (entry?.state !== "measured" &&
        !(entry?.state === "inapplicable" && isCacheableInapplicableReason(entry.reason))) ||
      !this._resourceIsCacheEligible(write.occurrence)
    )
      return [];
    const operation = (
      recordType: CacheRecordType,
      mutation: PaginationCacheMutation,
    ): PreparedCacheMutation => ({ ...write, recordType, mutation });
    if (entry.state === "inapplicable") {
      const targetKeys = await Promise.all(
        (this._tocRequestsByOccurrence[write.occurrence] ?? []).map((target) =>
          this._occurrenceRecordKey(write.occurrence, `target:${targetIdentity(target)}`),
        ),
      );
      const pageKey = await this._occurrenceRecordKey(write.occurrence, "page");
      if (!this._ownsPreparedCacheWrite(write)) return [];
      return [
        ...targetKeys.map((record) => operation("toc-target", { type: "remove", record })),
        operation("page", {
          type: "write",
          record: pageKey,
          value: encodeCacheRecord({
            type: "inapplicable",
            revision: write.recordRevision,
            reason: entry.reason,
          }),
        }),
      ];
    }
    const targets = await Promise.all(
      entry.tocTargets.map(async (target): Promise<PreparedCacheMutation> => {
        const record = await this._occurrenceRecordKey(
          write.occurrence,
          `target:${targetIdentity(target)}`,
        );
        if (target.result.state === "pending" || target.result.state === "failed") {
          return operation("toc-target", { type: "remove", record });
        }
        return operation("toc-target", {
          type: "write",
          record,
          value: encodeCacheRecord({
            type: "toc-target",
            revision: write.recordRevision,
            result: target.result,
          }),
        });
      }),
    );
    const pageKey = await this._occurrenceRecordKey(write.occurrence, "page");
    if (!this._ownsPreparedCacheWrite(write)) return [];
    return [
      ...targets,
      operation("page", {
        type: "write",
        record: pageKey,
        value: encodeCacheRecord({
          type: "page-count",
          revision: write.recordRevision,
          pageCount: entry.pageCount,
          columnsPerView: entry.columnsPerView,
          settled: this._durableMeasuredOccurrences.has(write.occurrence),
        }),
      }),
    ];
  }

  _ownsPreparedCacheWrite(write: PendingCacheWrite): boolean {
    return (
      !this._closed &&
      this._cacheWritable &&
      write.runRevision === this._runRevision &&
      write.recordRevision === this._cacheRecordRevisions.get(write.occurrence) &&
      !this._cacheController.signal.aborted
    );
  }

  _cacheWriteEvent(
    diagnostic: CacheWriteDiagnosticOperation,
    action: Extract<NavigatorDiagnosticEvent, { type: "cache-write" }>["action"],
  ): void {
    if (diagnostic.operationId === null || diagnostic.startedAt === null) return;
    this._record({
      type: "cache-write",
      action,
      operationId: diagnostic.operationId,
      runRevision: diagnostic.runRevision,
      occurrenceCount: diagnostic.occurrenceCount,
      operationCount: diagnostic.operationCount,
      completedOperationCount: diagnostic.completedOperationCount,
      durationMs: this._now() - diagnostic.startedAt,
    });
  }

  _cachePersistence(): BookPaginationSnapshot["cachePersistence"] {
    if (
      this._cache === null ||
      this._cacheIdentity === null ||
      !this._cacheWritable ||
      this._closed
    ) {
      return "unavailable";
    }
    return this._dirtyCacheOccurrences.size > 0 ||
      this._cacheWriteTimer !== null ||
      this._pendingCacheWrites.size > 0 ||
      this.#cacheWriteOperations.size > 0
      ? "pending"
      : "idle";
  }

  /**
   * Publishes only the transitions, so a drained catalog does not emit once per record. Without a
   * cache the state never leaves `unavailable`, so there is nothing to report at all.
   */
  _publishCachePersistence(): void {
    if (this._cache === null) return;
    const state = this._cachePersistence();
    if (state === this.#publishedCachePersistence) return;
    this.#publishedCachePersistence = state;
    this._publish();
  }

  _reserveCacheWrite(runRevision: number): CacheWriteDiagnosticOperation {
    const drain = this.#cacheWriteDrains.get(runRevision) ?? {
      startedAt: this._now(),
      active: 0,
      terminal: this.#finishedCacheWriteRuns.has(runRevision),
      hadWork: false,
      failed: false,
      cancelled: false,
    };
    drain.active += 1;
    drain.hadWork = true;
    this.#cacheWriteDrains.set(runRevision, drain);
    const operation: CacheWriteDiagnosticOperation = {
      runRevision,
      operationId: null,
      startedAt: null,
      occurrenceCount: 0,
      operationCount: 0,
      completedOperationCount: 0,
      settled: false,
    };
    this.#cacheWriteOperations.add(operation);
    return operation;
  }

  _startCacheWrite(
    operation: CacheWriteDiagnosticOperation,
    occurrenceCount: number,
    operationCount: number,
  ): void {
    if (operation.settled) return;
    operation.operationId = this.#nextCacheWriteOperationId++;
    operation.startedAt = this._now();
    operation.occurrenceCount = occurrenceCount;
    operation.operationCount = operationCount;
    this._cacheWriteEvent(operation, "start");
  }

  _settleCacheWrite(
    operation: CacheWriteDiagnosticOperation,
    outcome: "complete" | "failed" | "cancelled",
  ): void {
    if (operation.settled) return;
    operation.settled = true;
    this._cacheWriteEvent(operation, outcome);
    this.#cacheWriteOperations.delete(operation);
    const drain = this.#cacheWriteDrains.get(operation.runRevision);
    if (drain === undefined) return;
    drain.active -= 1;
    drain.failed ||= outcome === "failed";
    drain.cancelled ||= outcome === "cancelled";
    this._emitCacheDrain(operation.runRevision, drain);
    this._publishCachePersistence();
  }

  _finishCacheWriteRun(runRevision: number): void {
    this.#finishedCacheWriteRuns.add(runRevision);
    const drain = this.#cacheWriteDrains.get(runRevision);
    if (drain === undefined) return;
    drain.terminal = true;
    this._emitCacheDrain(runRevision, drain);
  }

  _cancelCacheWrites(runRevision: number): void {
    for (const operation of [...this.#cacheWriteOperations]) {
      if (operation.runRevision === runRevision) this._settleCacheWrite(operation, "cancelled");
    }
  }

  _emitCacheDrain(runRevision: number, drain: CacheWriteDrainState): void {
    if (!drain.terminal || !drain.hadWork || drain.active !== 0) return;
    this.#cacheWriteDrains.delete(runRevision);
    this._record({
      type: "cache-drain",
      runRevision,
      outcome: drain.failed ? "failed" : drain.cancelled ? "cancelled" : "durable",
      durationMs: this._now() - drain.startedAt,
    });
  }

  _queueCacheRemoval(occurrence: number): void {
    if ((this._cache?.remove === undefined && this._cache?.writeMany === undefined) || this._closed)
      return;
    this._dirtyCacheOccurrences.delete(occurrence);
    this._publishCachePersistence();
    const basis = this._cacheBasis();
    const signal = this._cacheController.signal;
    const keys = Promise.all(
      [
        "page",
        ...(this._tocRequestsByOccurrence[occurrence] ?? []).map(
          (target) => `target:${targetIdentity(target)}`,
        ),
      ].map((part) => this._occurrenceRecordKey(occurrence, part)),
    );
    this._cacheWriteChain = this._cacheWriteChain.then(() =>
      this._removeCachedOccurrence(occurrence, basis, keys, signal),
    );
  }

  _queueCurrentCacheReset(occurrence: number): void {
    this._dirtyCacheOccurrences.delete(occurrence);
    this._cacheWriteChain = this._cacheWriteChain.then(async () => {
      if (await this._removeCurrentCacheEntry()) {
        this._queueCacheWrite(occurrence);
      } else {
        this._cacheWritable = false;
        this._dirtyCacheOccurrences.clear();
        this._publishCachePersistence();
      }
    });
  }

  async _writeCache(
    occurrence: number,
    runRevision: number,
    recordRevision: number,
    diagnostic: CacheWriteDiagnosticOperation,
  ): Promise<void> {
    const cache = this._cache;
    if (
      cache === null ||
      !this._cacheWritable ||
      runRevision !== this._runRevision ||
      recordRevision !== this._cacheRecordRevisions.get(occurrence) ||
      this._closed
    ) {
      this._settleCacheWrite(diagnostic, "cancelled");
      return;
    }
    const signal = this._cacheController.signal;
    try {
      const basis = await this._cacheBasis();
      const entry = this._entries.get(occurrence);
      if (
        basis === null ||
        (entry?.state !== "measured" &&
          !(entry?.state === "inapplicable" && isCacheableInapplicableReason(entry.reason))) ||
        !this._resourceIsCacheEligible(occurrence) ||
        runRevision !== this._runRevision ||
        recordRevision !== this._cacheRecordRevisions.get(occurrence)
      ) {
        this._settleCacheWrite(diagnostic, "cancelled");
        return;
      }
      const persistedRevision = recordRevision;
      const operationCount =
        1 +
        (entry.state === "inapplicable"
          ? cache.remove === undefined
            ? 0
            : (this._tocRequestsByOccurrence[occurrence]?.length ?? 0)
          : entry.tocTargets.reduce(
              (count, target) =>
                count +
                (target.result.state !== "pending" && target.result.state !== "failed"
                  ? 1
                  : cache.remove === undefined
                    ? 0
                    : 1),
              0,
            ));
      this._startCacheWrite(diagnostic, 1, operationCount);
      if (entry.state === "inapplicable") {
        for (const target of this._tocRequestsByOccurrence[occurrence] ?? []) {
          if (cache.remove !== undefined) {
            await cache.remove(
              basis,
              await this._occurrenceRecordKey(occurrence, `target:${targetIdentity(target)}`),
              { signal },
            );
            diagnostic.completedOperationCount += 1;
          }
        }
        const pageBytes = encodeCacheRecord({
          type: "inapplicable",
          revision: persistedRevision,
          reason: entry.reason,
        });
        const pageStarted = this._now();
        await cache.write(basis, await this._occurrenceRecordKey(occurrence, "page"), pageBytes, {
          signal,
        });
        diagnostic.completedOperationCount += 1;
        this._cacheEvent("write", occurrence, pageBytes.byteLength, pageStarted, "complete");
        this._settleCacheWrite(diagnostic, "complete");
        return;
      }
      for (const target of entry.tocTargets) {
        if (recordRevision !== this._cacheRecordRevisions.get(occurrence)) {
          this._settleCacheWrite(diagnostic, "cancelled");
          return;
        }
        const targetKey = await this._occurrenceRecordKey(
          occurrence,
          `target:${targetIdentity(target)}`,
        );
        const targetStarted = this._now();
        if (target.result.state === "pending" || target.result.state === "failed") {
          if (cache.remove !== undefined) {
            await cache.remove(basis, targetKey, { signal });
            diagnostic.completedOperationCount += 1;
            this._cacheEvent("remove", occurrence, 0, targetStarted, "complete");
          }
        } else {
          const targetBytes = encodeCacheRecord({
            type: "toc-target",
            revision: persistedRevision,
            result: target.result,
          });
          await cache.write(basis, targetKey, targetBytes, { signal });
          diagnostic.completedOperationCount += 1;
          this._cacheEvent("write", occurrence, targetBytes.byteLength, targetStarted, "complete");
        }
      }
      if (recordRevision !== this._cacheRecordRevisions.get(occurrence)) {
        this._settleCacheWrite(diagnostic, "cancelled");
        return;
      }
      const pageBytes = encodeCacheRecord({
        type: "page-count",
        revision: persistedRevision,
        pageCount: entry.pageCount,
        columnsPerView: entry.columnsPerView,
        settled: this._durableMeasuredOccurrences.has(occurrence),
      });
      const pageStarted = this._now();
      await cache.write(basis, await this._occurrenceRecordKey(occurrence, "page"), pageBytes, {
        signal,
      });
      diagnostic.completedOperationCount += 1;
      this._cacheEvent("write", occurrence, pageBytes.byteLength, pageStarted, "complete");
      this._settleCacheWrite(diagnostic, "complete");
    } catch (cause) {
      this._settleCacheWrite(
        diagnostic,
        signal.aborted || isAbortError(cause) ? "cancelled" : "failed",
      );
    }
  }

  _cacheBasis(): Promise<string | null> {
    if (this._cacheBasisPromise !== null) return this._cacheBasisPromise;
    const view = this._container.ownerDocument.defaultView;
    const subtle = view?.crypto.subtle;
    const identity = this._cacheIdentity;
    if (subtle === undefined || identity === null || !isCacheIdentity(identity)) {
      this._cacheBasisPromise = Promise.resolve(null);
      return this._cacheBasisPromise;
    }
    this._cacheBasisPromise = sha256(
      subtle,
      canonicalJson({
        basis: this._basis,
        measurementArtifactDigest: identity.measurementArtifactDigest,
      }),
    );
    return this._cacheBasisPromise;
  }

  async _occurrenceRecordKey(occurrence: number, part: string): Promise<string> {
    const identity = canonicalJson([occurrence, part]);
    const existing = this._cacheRecordKeyPromises.get(identity);
    if (existing !== undefined) return existing;
    const subtle = this._container.ownerDocument.defaultView?.crypto.subtle;
    if (subtle === undefined)
      throw new DOMException("cryptographic hashing unavailable", "AbortError");
    const item = this._facts.resources.readingOrder[occurrence];
    const resource = this._entries.get(occurrence)?.resource;
    const key = sha256(
      subtle,
      canonicalJson({
        occurrence,
        resource,
        presentation: item ?? null,
        part,
      }),
    );
    this._cacheRecordKeyPromises.set(identity, key);
    void key.catch(() => {
      if (this._cacheRecordKeyPromises.get(identity) === key)
        this._cacheRecordKeyPromises.delete(identity);
    });
    return key;
  }

  _resourceIsCacheEligible(occurrence: number): boolean {
    const resourcePath = this._entries.get(occurrence)?.resource;
    const resource = this._facts.resources.resources.find(
      (candidate) => candidate.address.kind === "local" && candidate.address.value === resourcePath,
    );
    return (
      resource?.address.kind === "local" &&
      !resource.scripted &&
      this._eligibleResourcePaths?.has(resource.address.value) === true
    );
  }

  async _removeCurrentCacheEntry(): Promise<boolean> {
    if (this._cache === null || this._cacheIdentity === null) return false;
    try {
      const basis = await this._cacheBasis();
      if (basis === null) return false;
      await this._cache.removeBasis(basis, { signal: this._cacheController.signal });
      return true;
    } catch (cause) {
      if (!isAbortError(cause)) return false;
      return false;
    }
  }

  async _removeCachedOccurrence(
    occurrence: number,
    basisPromise: Promise<string | null>,
    keysPromise: Promise<readonly string[]>,
    signal: AbortSignal,
  ): Promise<void> {
    const cache = this._cache;
    if (cache === null || (cache.remove === undefined && cache.writeMany === undefined)) return;
    try {
      const basis = await basisPromise;
      if (basis === null) return;
      const keys = await keysPromise;
      if (cache.writeMany !== undefined) {
        for (let offset = 0; offset < keys.length; offset += 32) {
          const batch = keys.slice(offset, offset + 32);
          const started = this._now();
          try {
            await cache.writeMany(
              basis,
              batch.map((record) => ({ type: "remove", record })),
              { signal },
            );
            for (const _key of batch)
              this._cacheEvent("remove", occurrence, 0, started, "complete");
          } catch (cause) {
            const outcome = signal.aborted || isAbortError(cause) ? "cancelled" : "failed";
            for (const _key of batch) this._cacheEvent("remove", occurrence, 0, started, outcome);
            if (outcome === "cancelled") throw cause;
          }
        }
        return;
      }
      for (const key of keys) {
        const started = this._now();
        try {
          await cache.remove!(basis, key, { signal });
          this._cacheEvent("remove", occurrence, 0, started, "complete");
        } catch (cause) {
          this._cacheEvent(
            "remove",
            occurrence,
            0,
            started,
            signal.aborted || isAbortError(cause) ? "cancelled" : "failed",
          );
          throw cause;
        }
      }
    } catch (cause) {
      if (!isAbortError(cause)) return;
    }
  }

  _cacheEvent(
    action: "read" | "write" | "remove",
    occurrence: number,
    bytes: number,
    started: number,
    outcome: Extract<NavigatorDiagnosticEvent, { type: "cache" }>["outcome"],
    recordType?: "page" | "toc-target",
  ): void {
    this._record({
      type: "cache",
      action,
      ...(recordType === undefined ? {} : { recordType }),
      occurrence,
      bytes,
      durationMs: this._now() - started,
      outcome,
    });
  }
}
