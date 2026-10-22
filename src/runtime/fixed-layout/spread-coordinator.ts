import { PreparationCoordinatorRuntime } from "../pagination/preparation-coordinator.js";
import { type OwnedFrame, type FixedSpreadStage } from "../navigator/runtime-types.js";
import { FIXED_SPREAD_STAGING_TIMEOUT_MS } from "../agent/configuration.js";
import type { KernelSnapshot, NavigatorCommand } from "../../generated/kernel.js";
import type { ForegroundPreparationClaim } from "../pagination/index.js";
import { NavigatorError } from "../../runtime.js";
import { commandInput } from "../kernel.js";
import {
  currentDocument,
  fixedCompanionDocument,
  fixedOrientationsCompatible,
  fixedSpreadPlan,
  occurrenceLoadableTarget,
  preparedSettledLayout,
} from "../kernel-view.js";

export abstract class FixedSpreadRuntime extends PreparationCoordinatorRuntime {
  protected _coordinateFixedSpread(): boolean {
    if (this._closed || this._role !== "foreground") return false;
    const snapshot = this._kernel.snapshot();
    const primary = currentDocument(snapshot);
    const stage = this._fixedSpreadStage;
    const companion = fixedCompanionDocument(snapshot);
    const backwardCompanionOccurrence =
      primary !== null && stage?.documentGeneration === primary.generation
        ? stage.companionOccurrence
        : primary !== null && companion?.ownerDocumentGeneration === primary.generation
          ? companion.frame.occurrence
          : null;
    const plan =
      primary === null
        ? null
        : this._fixedSpreadPlan(
            snapshot,
            primary.frame.occurrence,
            this._frameStackSize.width,
            this._frameStackSize.height,
            backwardCompanionOccurrence,
          );
    if (
      companion !== null &&
      (plan === null ||
        plan.companionOccurrence === null ||
        companion.frame.occurrence !== plan.companionOccurrence ||
        companion.placement !== plan.companionPlacement)
    ) {
      return this._dispatchAutomaticSpreadCommand({
        type: "detach-fixed-companion",
        ownerDocumentGeneration: companion.ownerDocumentGeneration,
        frameGeneration: companion.frame.generation,
      });
    }
    if (
      companion !== null ||
      plan === null ||
      plan.companionOccurrence === null ||
      plan.companionPlacement === null ||
      primary === null ||
      this._fixedSpreadSuppression?.documentGeneration === primary.generation
    )
      return false;
    const companionTarget = occurrenceLoadableTarget(
      snapshot.readingOrder[plan.companionOccurrence],
    );
    if (
      companionTarget?.adapter === "fixed-svg" &&
      !this._fixedSvgPreparationEligible(plan.companionOccurrence, companionTarget.resource)
    ) {
      this._fixedSpreadSuppression = {
        documentGeneration: primary.generation,
        companionOccurrence: plan.companionOccurrence,
        reason: "failure",
      };
      if (this._fixedSpreadStage !== null) this._clearFixedSpreadStage();
      if (this._committed !== null) this._showFrame(this._committed);
      return false;
    }
    if (this._fixedSpreadStage === null) {
      if (
        this._container.ownerDocument.hidden ||
        snapshot.document.pending !== null ||
        snapshot.layout.pending !== null ||
        this._pendingPromotion !== null ||
        this._pendingCompanionActivation !== null
      ) {
        return false;
      }
      const frame = this._committed;
      if (
        frame === null ||
        frame.documentGeneration !== primary.generation ||
        frame.occurrence !== plan.primaryOccurrence
      ) {
        return false;
      }
      this._stageFixedSpread(frame, primary.generation, plan.companionOccurrence);
    }
    if (
      this._container.ownerDocument.hidden ||
      snapshot.document.pending !== null ||
      snapshot.layout.pending !== null ||
      this._pendingPromotion !== null ||
      this._pendingCompanionActivation !== null
    ) {
      return false;
    }
    const prepared = snapshot.preparedFrames.find(
      (candidate) => candidate.frame.occurrence === plan.companionOccurrence,
    );
    if (prepared !== undefined) {
      const settled = preparedSettledLayout(prepared);
      if (settled === null || settled.settlement.adapter !== prepared.frame.adapter) return false;
      if (primary.frame.occurrence !== plan.primaryOccurrence) return false;
      const claim = this._preparationClaims.get(plan.companionOccurrence);
      if (
        claim !== undefined &&
        this._paginationController?.acceptPreparedLayout(
          claim,
          prepared.frame.resource,
          prepared.frame.generation,
          settled.layoutGeneration,
          settled.settlement,
        ) === false
      ) {
        this._releasePreparationClaim(plan.companionOccurrence, true);
      }
      return this._dispatchAutomaticSpreadCommand({
        type: "attach-fixed-companion",
        ownerDocumentGeneration: primary.generation,
        frameGeneration: prepared.frame.generation,
        placement: plan.companionPlacement,
      });
    }
    if (snapshot.preparedFrames.length >= 2) {
      return this._dispatchAutomaticSpreadCommand({ type: "evict-prepared-frames" });
    }
    let claim: ForegroundPreparationClaim | null = null;
    if (!this._preparationClaims.has(plan.companionOccurrence)) {
      claim =
        this._paginationController?.claimForegroundPreparation(plan.companionOccurrence) ?? null;
      if (claim !== null) this._preparationClaims.set(plan.companionOccurrence, claim);
    }
    const accepted = this._dispatchAutomaticSpreadCommand({
      type: "prepare-occurrence",
      occurrence: plan.companionOccurrence,
    });
    if (!accepted && claim !== null) this._releasePreparationClaim(plan.companionOccurrence, false);
    return accepted;
  }

  finalSpreadLeadingOccurrence(): number | null {
    const snapshot = this._kernel.snapshot();
    const last = snapshot.readingOrder.length - 1;
    if (last <= 0) return null;
    const plan = this._fixedSpreadPlan(
      snapshot,
      last,
      this._frameStackSize.width,
      this._frameStackSize.height,
    );
    return plan?.companionOccurrence === last - 1 ? last - 1 : null;
  }

  protected _fixedSpreadPlan(
    snapshot: KernelSnapshot,
    primaryOccurrence: number,
    viewportWidth: number,
    viewportHeight: number,
    backwardCompanionOccurrence: number | null = null,
  ): ReturnType<typeof fixedSpreadPlan> {
    const plan = fixedSpreadPlan(snapshot, primaryOccurrence, viewportWidth, viewportHeight);
    if (
      plan === null ||
      plan.companionOccurrence !== null ||
      plan.centered !== null ||
      backwardCompanionOccurrence !== primaryOccurrence - 1
    ) {
      return plan;
    }
    const companionPlan = fixedSpreadPlan(
      snapshot,
      backwardCompanionOccurrence,
      viewportWidth,
      viewportHeight,
    );
    const companionTarget = occurrenceLoadableTarget(
      snapshot.readingOrder[backwardCompanionOccurrence],
    );
    const primaryEntry = snapshot.readingOrder[primaryOccurrence];
    const companionEntry = snapshot.readingOrder[backwardCompanionOccurrence];
    if (
      companionPlan === null ||
      companionPlan.centered !== null ||
      companionPlan.primaryPlacement === "center" ||
      companionPlan.primaryPlacement === plan.primaryPlacement ||
      companionPlan.direction !== plan.direction ||
      primaryEntry === undefined ||
      companionEntry === undefined ||
      !fixedOrientationsCompatible(primaryEntry, companionEntry) ||
      companionTarget === null ||
      this._foregroundPreparationPaths?.has(companionTarget.resource) !== true
    ) {
      return plan;
    }
    return {
      ...plan,
      companionOccurrence: backwardCompanionOccurrence,
      companionPlacement: companionPlan.primaryPlacement,
    };
  }

  protected _dispatchAutomaticSpreadCommand(command: NavigatorCommand): boolean {
    try {
      this._accepted(this._dispatchAndApply(commandInput(command)));
      return true;
    } catch (cause) {
      if (!(cause instanceof NavigatorError)) this._handleBoundaryFailure(cause);
      return false;
    }
  }

  protected _activateCommittedPrimary(frame: OwnedFrame, outgoing: OwnedFrame | null = null): void {
    const generation = frame.documentGeneration;
    const released = this._releasedCommitted;
    this._releasedCommitted = null;
    this._clearFixedSpreadStage();
    this._fixedSpreadSuppression = null;
    if (generation === null) {
      this._showFrame(frame);
      return;
    }
    const snapshot = this._kernel.snapshot();
    const departed = outgoing ?? released;
    const backwardCompanionOccurrence =
      departed?.adapter === "reflowable-xhtml" && departed.occurrence === frame.occurrence + 1
        ? frame.occurrence - 1
        : null;
    const plan = this._fixedSpreadPlan(
      snapshot,
      frame.occurrence,
      this._frameStackSize.width,
      this._frameStackSize.height,
      backwardCompanionOccurrence,
    );
    if (plan === null || plan.companionOccurrence === null || plan.companionPlacement === null) {
      this._showFrame(frame);
      return;
    }
    this._stageFixedSpread(frame, generation, plan.companionOccurrence);
  }

  protected _stageFixedSpread(
    frame: OwnedFrame,
    documentGeneration: number,
    companionOccurrence: number,
  ): void {
    this._hideFrame(frame);
    let stage!: FixedSpreadStage;
    const timer = setTimeout(
      () => this._fallbackFixedSpread(stage),
      FIXED_SPREAD_STAGING_TIMEOUT_MS,
    );
    stage = {
      documentGeneration,
      primary: frame,
      companionOccurrence,
      timer,
      viewportInvalidated: false,
    };
    this._fixedSpreadStage = stage;
  }

  protected _clearFixedSpreadStage(): void {
    if (this._fixedSpreadStage !== null) clearTimeout(this._fixedSpreadStage.timer);
    this._fixedSpreadStage = null;
  }

  protected _fallbackFixedSpread(stage: FixedSpreadStage): void {
    if (
      this._fixedSpreadStage !== stage ||
      this._fixedSpreadFallbackInProgress ||
      this._committed !== stage.primary ||
      stage.primary.documentGeneration !== stage.documentGeneration
    ) {
      return;
    }
    this._fixedSpreadFallbackInProgress = true;
    this._clearFixedSpreadStage();
    this._fixedSpreadSuppression = {
      documentGeneration: stage.documentGeneration,
      companionOccurrence: stage.companionOccurrence,
      reason: stage.viewportInvalidated ? "resize" : "failure",
    };
    try {
      const companion = fixedCompanionDocument(this._kernel.snapshot());
      if (companion?.ownerDocumentGeneration === stage.documentGeneration) {
        this._dispatchAutomaticSpreadCommand({
          type: "detach-fixed-companion",
          ownerDocumentGeneration: companion.ownerDocumentGeneration,
          frameGeneration: companion.frame.generation,
        });
      }
      if (
        this._kernel
          .snapshot()
          .preparedFrames.some(
            (prepared) => prepared.frame.occurrence === stage.companionOccurrence,
          )
      ) {
        this._dispatchAutomaticSpreadCommand({ type: "evict-prepared-frames" });
      }
      this._showFrame(stage.primary);
    } finally {
      this._fixedSpreadFallbackInProgress = false;
    }
  }

  protected _detachCompanion(ownerDocumentGeneration: number, frameGeneration: number): void {
    const frame = this._companion;
    if (
      frame === null ||
      frame.frameGeneration !== frameGeneration ||
      (frame.documentGeneration !== null && frame.documentGeneration !== ownerDocumentGeneration)
    ) {
      return;
    }
    const activation = this._pendingCompanionActivation;
    if (activation?.target === frame) {
      if (activation.queued !== null) activation.queued.complete = true;
      this._pendingCompanionActivation = null;
    }
    this._companion = null;
    this._cancelFrame(frameGeneration);
    if (!this._closed) {
      this._recomputeActiveFixedGeometry();
      this._invalidateActiveFixedViewports();
    }
  }
}
