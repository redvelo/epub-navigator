import type {
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
} from "../agent-protocol/index.js";
import type { PreparedTocMeasurement } from "./capabilities.js";
import type { ForegroundPreparationClaim } from "./types.js";
import { enrichTocTargets } from "./toc-enrichment.js";

export interface PreparedMeasurementOwner {
  readonly claim: ForegroundPreparationClaim;
  readonly frameGeneration: number;
  readonly layoutGeneration: number;
  readonly pageCount: number;
  readonly provenance: string;
}

export interface PreparedMeasurementResult {
  readonly owner: PreparedMeasurementOwner;
  readonly results: readonly TocTargetMeasurementResult[];
}

export async function measurePreparedTargets(options: {
  readonly owner: PreparedMeasurementOwner;
  readonly requests: readonly TocTargetMeasurementRequest[];
  readonly measure: PreparedTocMeasurement;
  readonly signal: AbortSignal;
  readonly now: () => number;
}): Promise<PreparedMeasurementResult> {
  const { owner } = options;
  const result = await enrichTocTargets({
    owner,
    requests: options.requests,
    signal: options.signal,
    now: options.now,
    measure: (targets, signal) =>
      options.measure(
        owner.claim.occurrence,
        owner.frameGeneration,
        owner.layoutGeneration,
        owner.pageCount,
        targets,
        { signal },
      ),
  });
  return result;
}

async function measurePreparedTargetChunk(options: {
  readonly owner: PreparedMeasurementOwner;
  readonly requests: readonly TocTargetMeasurementRequest[];
  readonly measure: PreparedTocMeasurement;
  readonly signal: AbortSignal;
}): Promise<PreparedMeasurementResult> {
  const { owner } = options;
  const results = await options.measure(
    owner.claim.occurrence,
    owner.frameGeneration,
    owner.layoutGeneration,
    owner.pageCount,
    options.requests,
    { signal: options.signal },
  );
  return { owner, results };
}

import type { AdapterLayoutSettlement } from "../../generated/kernel.js";
import { MAX_TOC_TARGETS_PER_OPERATION, viewColumns } from "../agent-protocol/index.js";
import { initialEntries } from "./catalog.js";
import { failedTocTargets, sameTargetIdentities, targetIdentity } from "./occurrence-state.js";
import {
  fixedAdapterUnavailableReason,
  fixedSettlement,
  layoutSettlementIsDurable,
  reflowableSettlement,
} from "./classification.js";
import { isAbortError } from "./abort.js";
import { tocEnrichmentDeadlineMs, tocEnrichmentSliceMs } from "./constants.js";
import { BasisPaginationController } from "./basis.js";

interface PreparedTargetOperation {
  readonly claim: ForegroundPreparationClaim;
  readonly frameGeneration: number;
  readonly layoutGeneration: number;
  readonly pageCount: number;
  readonly provenance: string;
  readonly controller: AbortController;
}

export abstract class PreparedPaginationController extends BasisPaginationController {
  protected readonly _preparedTargetOperations = new Map<number, PreparedTargetOperation>();
  claimForegroundPreparation(occurrence: number): ForegroundPreparationClaim | null {
    if (
      this._closed ||
      this._pendingBasis !== null ||
      this._debounceTimer !== null ||
      this._entries.get(occurrence) === undefined
    ) {
      return null;
    }
    const existing = this._preparationClaims.get(occurrence);
    if (existing !== undefined) return existing;
    const claim = Object.freeze({
      occurrence,
      token: this._nextPreparationClaimToken++,
      runRevision: this._runRevision,
    });
    this._preparationClaims.set(occurrence, claim);
    this._preemptClaimedOccurrence(occurrence);
    this._rebuildWorkQueue();
    this._schedule();
    return claim;
  }

  releaseForegroundPreparation(claim: ForegroundPreparationClaim, preserveAccepted = false): void {
    if (this._preparationClaims.get(claim.occurrence) !== claim) return;
    this._cancelPreparedTargets(claim.occurrence);
    this._preparationClaims.delete(claim.occurrence);
    const accepted = this._preparedProvenance.delete(claim.occurrence);
    if (accepted && !preserveAccepted) {
      const baseline = initialEntries(this._facts, this._documents, this._eligibleResourcePaths)[
        claim.occurrence
      ];
      if (baseline !== undefined) this._replaceEntry(claim.occurrence, baseline);
      this._durableMeasuredOccurrences.delete(claim.occurrence);
      this._queueCacheRemoval(claim.occurrence);
      this._publish();
    }
    this._rebuildWorkQueue();
    this._schedule();
  }

  acceptPreparedLayout(
    claim: ForegroundPreparationClaim,
    resource: string,
    frameGeneration: number,
    layoutGeneration: number,
    layout: AdapterLayoutSettlement,
  ): boolean {
    if (
      this._closed ||
      this._preparationClaims.get(claim.occurrence) !== claim ||
      claim.runRevision !== this._runRevision
    ) {
      return false;
    }
    const provenance = `${this._runRevision}:${frameGeneration}:${layoutGeneration}`;
    if (fixedSettlement(layout) !== null) {
      if (this._preparedProvenance.get(claim.occurrence) === provenance) {
        this._startPreparedTargets(claim, frameGeneration, layoutGeneration, 1, provenance);
        return true;
      }
      this._cancelPreparedTargets(claim.occurrence);
      this._preparedProvenance.set(claim.occurrence, provenance);
      this._setMeasured(claim.occurrence, resource, 1, 1, "foreground", true);
      this._startPreparedTargets(claim, frameGeneration, layoutGeneration, 1, provenance);
      return true;
    }
    const settlement = reflowableSettlement(layout);
    if (settlement === null) {
      this._cancelPreparedTargets(claim.occurrence);
      this._setUnavailable(claim.occurrence, fixedAdapterUnavailableReason(layout.adapter));
      return false;
    }
    if (settlement.mode !== "paginated") {
      this._cancelPreparedTargets(claim.occurrence);
      this._setInapplicable(claim.occurrence, "effective-presentation-not-paginated");
      return false;
    }
    if (this._preparedProvenance.get(claim.occurrence) === provenance) {
      this._startPreparedTargets(
        claim,
        frameGeneration,
        layoutGeneration,
        settlement.pages.pageCount,
        provenance,
      );
      return true;
    }
    this._cancelPreparedTargets(claim.occurrence);
    if (settlement.pages.layoutRepairs.status === "unresolved") {
      this._setUnavailable(claim.occurrence, "unresolved-text-pagination");
      return false;
    }
    this._preparedProvenance.set(claim.occurrence, provenance);
    this._setMeasured(
      claim.occurrence,
      resource,
      settlement.pages.pageCount,
      viewColumns(settlement.pages.columnsPerView),
      "foreground",
      layoutSettlementIsDurable(settlement),
    );
    this._startPreparedTargets(
      claim,
      frameGeneration,
      layoutGeneration,
      settlement.pages.pageCount,
      provenance,
    );
    return true;
  }

  _startPreparedTargets(
    claim: ForegroundPreparationClaim,
    frameGeneration: number,
    layoutGeneration: number,
    pageCount: number,
    provenance: string,
  ): void {
    const measure = this._measurePreparedTocTargets;
    const requests = this._pendingTargetRequests(claim.occurrence);
    if (measure === null || requests.length === 0) return;
    const current = this._preparedTargetOperations.get(claim.occurrence);
    if (
      current?.claim === claim &&
      current.frameGeneration === frameGeneration &&
      current.layoutGeneration === layoutGeneration &&
      current.pageCount === pageCount
    ) {
      return;
    }
    this._cancelPreparedTargets(claim.occurrence);
    const operation: PreparedTargetOperation = {
      claim,
      frameGeneration,
      layoutGeneration,
      pageCount,
      provenance,
      controller: new AbortController(),
    };
    this._preparedTargetOperations.set(claim.occurrence, operation);
    void this._runPreparedTargets(operation, requests, measure);
  }

  async _runPreparedTargets(
    operation: PreparedTargetOperation,
    requests: readonly TocTargetMeasurementRequest[],
    measure: PreparedTocMeasurement,
  ): Promise<void> {
    let deadlineExpired = false;
    let sliceStarted = this._now();
    const deadline = setTimeout(() => {
      deadlineExpired = true;
      operation.controller.abort("timeout");
    }, tocEnrichmentDeadlineMs);
    const owner: PreparedMeasurementOwner = Object.freeze({
      claim: operation.claim,
      frameGeneration: operation.frameGeneration,
      layoutGeneration: operation.layoutGeneration,
      pageCount: operation.pageCount,
      provenance: operation.provenance,
    });
    try {
      for (let offset = 0; offset < requests.length; offset += MAX_TOC_TARGETS_PER_OPERATION) {
        if (!this._ownsPreparedTargets(operation)) return;
        const chunk = requests.slice(offset, offset + MAX_TOC_TARGETS_PER_OPERATION);
        let results: readonly TocTargetMeasurementResult[];
        try {
          const result = await measurePreparedTargetChunk({
            owner,
            requests: chunk,
            measure,
            signal: operation.controller.signal,
          });
          if (result.owner !== owner) return;
          results = result.results;
        } catch (cause) {
          if (!this._ownsPreparedTargets(operation)) return;
          if (isAbortError(cause) && !deadlineExpired) return;
          const message = deadlineExpired
            ? "TOC target enrichment exceeded its occurrence deadline"
            : cause instanceof Error
              ? cause.message
              : "TOC target measurement failed";
          results = failedTocTargets(chunk, message);
        }
        if (!this._ownsPreparedTargets(operation)) return;
        if (!sameTargetIdentities(chunk, results)) {
          results = failedTocTargets(chunk, "prepared TOC target identities did not match");
        }
        this._setTargets(operation.claim.occurrence, results, false);
        if (deadlineExpired) {
          const remaining = requests.slice(offset + chunk.length);
          if (remaining.length > 0) {
            this._setTargets(
              operation.claim.occurrence,
              failedTocTargets(remaining, "TOC target enrichment exceeded its occurrence deadline"),
              false,
            );
          }
          break;
        }
        if (
          offset + chunk.length < requests.length &&
          this._now() - sliceStarted >= tocEnrichmentSliceMs
        ) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          sliceStarted = this._now();
        }
      }
    } finally {
      clearTimeout(deadline);
      if (this._preparedTargetOperations.get(operation.claim.occurrence) === operation) {
        this._preparedTargetOperations.delete(operation.claim.occurrence);
      }
    }
  }

  _ownsPreparedTargets(operation: PreparedTargetOperation): boolean {
    const entry = this._entries.get(operation.claim.occurrence);
    return (
      !this._closed &&
      operation.claim.runRevision === this._runRevision &&
      this._preparationClaims.get(operation.claim.occurrence) === operation.claim &&
      this._preparedProvenance.get(operation.claim.occurrence) === operation.provenance &&
      this._preparedTargetOperations.get(operation.claim.occurrence) === operation &&
      entry?.state === "measured" &&
      entry.pageCount === operation.pageCount
    );
  }

  _pendingTargetRequests(occurrence: number): readonly TocTargetMeasurementRequest[] {
    const requests = this._tocRequestsByOccurrence[occurrence] ?? [];
    const entry = this._entries.get(occurrence);
    if (entry?.state !== "measured") return requests;
    const pending = new Set(
      entry.tocTargets.filter((target) => target.result.state === "pending").map(targetIdentity),
    );
    return requests.filter((request) => pending.has(targetIdentity(request)));
  }

  _cancelPreparedTargets(occurrence: number): void {
    const operation = this._preparedTargetOperations.get(occurrence);
    if (operation === undefined) return;
    this._preparedTargetOperations.delete(occurrence);
    operation.controller.abort("owner-superseded");
  }

  _preemptClaimedOccurrence(occurrence: number): void {
    if (this._scheduledWork?.occurrence === occurrence) {
      this._taskEvent("discard", occurrence, this._scheduledWork.task, "owner-superseded");
      this._scheduledWork = null;
      this._taskToken += 1;
      if (this._scheduleTimer !== null) clearTimeout(this._scheduleTimer);
      this._scheduleTimer = null;
      this._cancelMeasurementDeadline();
    }
    if (this._activeOccurrence !== occurrence) return;
    const entry = this._entries.get(occurrence);
    if (this._activeTask === "page-count" && entry?.state === "measuring") {
      this._replaceEntry(occurrence, { ...entry, state: "pending" });
    }
    if (this._activeTask !== null) {
      this._taskEvent("discard", occurrence, this._activeTask, "owner-superseded");
    }
    this._taskToken += 1;
    this._cancelMeasurementDeadline();
    this._targetMeasurementController?.abort();
    this._targetMeasurementController = null;
    this._activeOccurrence = null;
    this._activeTask = null;
    this._activeDocumentGeneration = null;
    this._teardownMeasurementRuntime();
  }

  _revokePreparationClaims(): void {
    if (this._preparationClaims.size === 0) return;
    for (const occurrence of this._preparationClaims.keys()) {
      this._cancelPreparedTargets(occurrence);
    }
    this._preparationClaims.clear();
    this._preparedProvenance.clear();
    this._rebuildWorkQueue();
    try {
      this._preparationClaimsInvalidated?.();
    } catch {
      // Runtime preparation cleanup cannot interrupt basis invalidation.
    }
  }
}
