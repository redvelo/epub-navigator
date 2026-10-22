import { FrameSurfaceRuntime } from "./frame-surface.js";
import {
  type OwnedFrame,
  type QueuedTransition,
  type PendingPromotion,
  type PendingCompanionActivation,
} from "../navigator/runtime-types.js";
import { AGENT_ROLE_CHANGE_TIMEOUT_MS } from "../agent/configuration.js";
import type { KernelEffect, KernelEvent, LayoutInvalidationCause } from "../../generated/kernel.js";
import { postFrameMessage } from "../agent/transport.js";
import { adapterInput, frameInput } from "../kernel.js";
import {
  fixedCompanionDocument,
  fixedCompanionSettlement,
  pendingDocumentFrame,
} from "../kernel-view.js";
import { buildAgentSetRole } from "../agent-protocol/index.js";
import type { AgentRole } from "../agent-protocol/index.js";

export abstract class FramePromotionRuntime extends FrameSurfaceRuntime {
  protected _promoteFrame(effect: Extract<KernelEffect, { type: "promote-frame" }>): void {
    const target = this._frames.get(effect.frameGeneration);
    const outgoing = this._committed;
    const pending = this._kernel.snapshot().document.pending;
    const pendingFrame = pending === null ? null : pendingDocumentFrame(pending);
    if (
      this._role === "auxiliary" ||
      target === undefined ||
      target.role !== "prepared" ||
      target.phase !== "prepared" ||
      target.window === null ||
      target.iframe.contentWindow !== target.window ||
      pendingFrame?.generation !== effect.frameGeneration ||
      pending?.generation !== effect.documentGeneration ||
      this._pendingPromotion !== null
    ) {
      this._reportFrameFailure(effect.frameGeneration, {
        reason: "effect-execution-failed",
        message: "frame promotion does not identify the prepared physical frame",
      });
      return;
    }

    try {
      this._cancelTocOperationsForFrame(target);
      const roleChange = this._nextRoleChange;
      this._nextRoleChange = roleChange === 0xffff_ffff ? 0 : roleChange + 1;
      let promotion!: PendingPromotion;
      const timer = setTimeout(() => {
        if (this._pendingPromotion !== promotion) return;
        this._pendingPromotion = null;
        this._reportFrameFailure(effect.frameGeneration, {
          reason: "effect-execution-failed",
          message: "prepared frame role change acknowledgment timed out",
        });
        this._settlePromotionPublication(promotion);
      }, AGENT_ROLE_CHANGE_TIMEOUT_MS);
      promotion = {
        target,
        outgoing,
        effect,
        roleChange,
        timer,
        queued: null,
      };
      this._pendingPromotion = promotion;
      target.phase = "promotion-acknowledging";
      postFrameMessage(
        target.window,
        this._frameProfile,
        buildAgentSetRole(target.session, "foreground", roleChange, this._agentConfiguration()),
      );
    } catch (cause) {
      const promotion = this._pendingPromotion;
      if (promotion !== null && promotion.target === target) {
        clearTimeout(promotion.timer);
        this._pendingPromotion = null;
      }
      this._reportFrameFailure(effect.frameGeneration, {
        reason: "effect-execution-failed",
        message: cause instanceof Error ? cause.message : "prepared frame promotion failed",
      });
      if (promotion !== null) this._settlePromotionPublication(promotion);
    }
  }

  protected _acknowledgeRoleChange(frame: OwnedFrame, role: AgentRole, roleChange: number): void {
    const companion = this._pendingCompanionActivation;
    if (
      companion !== null &&
      companion.target === frame &&
      companion.roleChange === roleChange &&
      role === "foreground"
    ) {
      this._acknowledgeCompanionActivation(companion);
      return;
    }
    const promotion = this._pendingPromotion;
    if (
      promotion === null ||
      promotion.target !== frame ||
      promotion.roleChange !== roleChange ||
      role !== "foreground" ||
      frame.phase !== "promotion-acknowledging" ||
      frame.role !== "prepared" ||
      frame.iframe.contentWindow !== frame.window
    ) {
      return;
    }
    const pending = this._kernel.snapshot().document.pending;
    const pendingFrame = pending === null ? null : pendingDocumentFrame(pending);
    if (
      pendingFrame?.generation !== promotion.effect.frameGeneration ||
      pending?.generation !== promotion.effect.documentGeneration
    ) {
      return;
    }
    clearTimeout(promotion.timer);
    this._pendingPromotion = null;
    try {
      if (promotion.outgoing !== null) this._hideFrame(promotion.outgoing);
      frame.documentGeneration = promotion.effect.documentGeneration;
      frame.role = "foreground";
      frame.iframe.dataset.epubNavigatorParticipant = "primary";
      this._hideFrame(frame);
      this._committed = frame;
      this._fixedPan = { x: 0, y: 0 };
      this._applyFixedViewTransform(frame);
      const transition = this._kernel.dispatch(
        frameInput({ type: "promoted", frameGeneration: promotion.effect.frameGeneration }),
      );
      this._accepted(
        this._applyTransition(transition, undefined, () => {
          frame.phase = "committed";
          this._activateCommittedPrimary(frame, promotion.outgoing);
        }),
      );
    } catch (cause) {
      this._committed = promotion.outgoing;
      frame.documentGeneration = null;
      frame.role = "prepared";
      frame.iframe.dataset.epubNavigatorParticipant = "prepared";
      this._hideFrame(frame);
      if (promotion.outgoing !== null) this._showFrame(promotion.outgoing);
      this._reportFrameFailure(promotion.effect.frameGeneration, {
        reason: "effect-execution-failed",
        message: cause instanceof Error ? cause.message : "prepared frame promotion failed",
      });
    } finally {
      this._settlePromotionPublication(promotion);
    }
  }

  protected _acknowledgeCompanionActivation(activation: PendingCompanionActivation): void {
    const { target: frame, participant } = activation;
    const snapshot = this._kernel.snapshot();
    const companion = fixedCompanionDocument(snapshot);
    const companionSettlement = fixedCompanionSettlement(snapshot);
    const stage = this._fixedSpreadStage;
    if (
      this._pendingCompanionActivation !== activation ||
      stage === null ||
      stage.documentGeneration !== participant.ownerDocumentGeneration ||
      stage.primary !== this._committed ||
      stage.companionOccurrence !== frame.occurrence ||
      this._companion !== frame ||
      frame.phase !== "promotion-acknowledging" ||
      frame.role !== "prepared" ||
      frame.window === null ||
      frame.iframe.contentWindow !== frame.window ||
      companion?.ownerDocumentGeneration !== participant.ownerDocumentGeneration ||
      companion.frame.generation !== participant.frameGeneration ||
      companion.frame.adapter !== frame.adapter ||
      companionSettlement?.adapter !== frame.adapter
    ) {
      return;
    }
    this._pendingCompanionActivation = null;
    frame.documentGeneration = participant.ownerDocumentGeneration;
    frame.role = "foreground";
    frame.phase = "committed";
    frame.iframe.dataset.epubNavigatorParticipant = "fixed-companion";
    this._recomputeActiveFixedGeometry();
    this._clearFixedSpreadStage();
    this._showFrame(stage.primary);
    this._showFrame(frame);
    this._invalidateActiveFixedViewports();
    if (activation.queued !== null) activation.queued.complete = true;
    if (activation.deferredInvalidation !== null) {
      try {
        this._accepted(
          this._dispatchAndApply(
            adapterInput({
              type: "layout-invalidated",
              participant,
              generation: frame.frameGeneration,
              cause: activation.deferredInvalidation,
            }),
          ),
        );
      } catch (cause) {
        this._handlePublicationMessageFailure(cause);
      }
    }
    if (this._applicationDepth === 0) this._publishQueuedTransitions();
  }

  protected _settlePromotionPublication(promotion: PendingPromotion): void {
    if (promotion.queued !== null) promotion.queued.complete = true;
    if (this._applicationDepth === 0) this._publishQueuedTransitions();
  }

  protected _reconcileCompanionEvents(
    events: readonly KernelEvent[],
    queued: QueuedTransition,
  ): void {
    for (const event of events) {
      if (event.type === "fixed-companion-detached") {
        const stage = this._fixedSpreadStage;
        this._detachCompanion(event.ownerDocumentGeneration, event.frameGeneration);
        if (stage?.documentGeneration === event.ownerDocumentGeneration) {
          this._fallbackFixedSpread(stage);
        }
      } else if (event.type === "fixed-companion-attached") {
        this._beginCompanionActivation(event, queued);
      }
    }
  }

  protected _beginCompanionActivation(
    event: Extract<KernelEvent, { type: "fixed-companion-attached" }>,
    queued: QueuedTransition,
  ): void {
    const snapshot = this._kernel.snapshot();
    const companion = fixedCompanionDocument(snapshot);
    const companionSettlement = fixedCompanionSettlement(snapshot);
    const target = this._frames.get(event.frameGeneration);
    if (
      this._role === "auxiliary" ||
      this._companion !== null ||
      this._pendingCompanionActivation !== null ||
      companion?.ownerDocumentGeneration !== event.ownerDocumentGeneration ||
      companion.frame.generation !== event.frameGeneration ||
      target === undefined ||
      companion.frame.adapter !== target.adapter ||
      companionSettlement?.adapter !== target.adapter ||
      target.role !== "prepared" ||
      target.phase !== "prepared" ||
      target.window === null ||
      target.iframe.contentWindow !== target.window
    ) {
      throw new Error("fixed companion attachment does not identify a prepared physical frame");
    }
    this._releasePreparationClaim(target.occurrence, true);
    this._cancelTocOperationsForFrame(target);
    this._companion = target;
    target.phase = "promotion-acknowledging";
    target.iframe.dataset.epubNavigatorParticipant = "fixed-companion-pending";
    const participant = {
      kind: "fixed-companion",
      ownerDocumentGeneration: event.ownerDocumentGeneration,
      frameGeneration: event.frameGeneration,
    } as const;
    const activation: PendingCompanionActivation = {
      target,
      participant,
      roleChange: 0,
      deferredInvalidation: null,
      queued,
    };
    this._pendingCompanionActivation = activation;
    this._requestCompanionRole(activation);
  }

  // The agent answers a role change with its pending layout invalidation instead of an
  // acknowledgment. The companion is activated first and relaid out once committed.
  protected _deferCompanionInvalidation(
    activation: PendingCompanionActivation,
    cause: LayoutInvalidationCause,
  ): void {
    activation.deferredInvalidation ??= cause;
    this._requestCompanionRole(activation);
  }

  private _requestCompanionRole(activation: PendingCompanionActivation): void {
    const roleChange = this._nextRoleChange;
    this._nextRoleChange = roleChange === 0xffff_ffff ? 0 : roleChange + 1;
    activation.roleChange = roleChange;
    const { window } = activation.target;
    if (window === null) {
      this._failCompanionActivation(activation);
      return;
    }
    try {
      postFrameMessage(
        window,
        this._frameProfile,
        buildAgentSetRole(
          activation.target.session,
          "foreground",
          roleChange,
          this._agentConfiguration(),
        ),
      );
    } catch {
      this._failCompanionActivation(activation);
    }
  }

  protected _failCompanionActivation(activation: PendingCompanionActivation): void {
    if (this._pendingCompanionActivation !== activation) return;
    this._pendingCompanionActivation = null;
    if (activation.queued !== null) activation.queued.complete = true;
    try {
      this._accepted(
        this._dispatchAndApply(
          adapterInput({
            type: "document-invalidated",
            participant: activation.participant,
            generation: activation.target.frameGeneration,
            reason: "content-document-unavailable",
          }),
        ),
      );
    } catch (cause) {
      this._handleBoundaryFailure(cause);
    }
    const stage = this._fixedSpreadStage;
    if (stage !== null) this._fallbackFixedSpread(stage);
    if (this._applicationDepth === 0) this._publishQueuedTransitions();
  }
}
