import { AgentOperationRuntime } from "./operation-registry.js";
import { type OwnedFrame, type OwnedLayoutOperation } from "../navigator/runtime-types.js";
import { layoutOwnerParticipant, participantsEqual } from "../navigator/runtime-support.js";
import { AGENT_LAYOUT_OPERATION_TIMEOUT_MS } from "./configuration.js";
import type { KernelEffect, LayoutPhase } from "../../generated/kernel.js";
import type { PaginationCancellationReason } from "../pagination/index.js";
import { postFrameMessage } from "./transport.js";
import { adapterInput } from "../kernel.js";
import { buildAgentRequest, normalizeAgentLayoutResult } from "../agent-protocol/index.js";

export abstract class LayoutOperationRuntime extends AgentOperationRuntime {
  protected _requestLayout(effect: Extract<KernelEffect, { type: "layout-request" }>): void {
    if (this._layoutOperations.has(effect.operation)) {
      throw new Error(`layout operation ${effect.operation} is already registered`);
    }
    const candidate = this._frames.get(effect.frameGeneration);
    const frame = this._frameForLayoutOwner(candidate, effect.owner);
    if (frame === null || frame.window === null || frame.iframe.contentWindow !== frame.window) {
      throw new Error("layout request does not identify an active presentation frame");
    }
    if (effect.request.adapter !== frame.adapter) {
      throw new Error("layout request does not match the owned frame adapter");
    }
    if (effect.owner.kind === "document" && frame.documentGeneration !== null) {
      this._clearTocOperationsForSupersededLayout(
        frame.documentGeneration,
        effect.layoutGeneration,
      );
    }
    const participant = layoutOwnerParticipant(effect.owner);
    const phase: LayoutPhase | "prepared" =
      effect.owner.kind === "prepared-frame"
        ? "prepared"
        : effect.owner.kind === "document"
          ? effect.owner.phase
          : "update";
    const timer = setTimeout(
      () => this._layoutTimedOut(effect.operation, effect.frameGeneration, effect.layoutGeneration),
      AGENT_LAYOUT_OPERATION_TIMEOUT_MS,
    );
    this._layoutOperations.set(effect.operation, {
      operation: effect.operation,
      frameGeneration: effect.frameGeneration,
      participant,
      documentGeneration: frame.documentGeneration,
      layoutGeneration: effect.layoutGeneration,
      phase,
      adapter: effect.request.adapter,
      timer,
      startedAt: this._now(),
      cancellationSent: false,
    });
    if (phase !== "prepared" && frame.documentGeneration !== null) {
      this._record({
        type: "layout",
        action: "start",
        role: this._role,
        documentGeneration: frame.documentGeneration,
        layoutGeneration: effect.layoutGeneration,
        operation: effect.operation,
        phase,
      });
      this._record({
        type: "operation-owner",
        action: "register",
        operationKind: "layout",
        operation: effect.operation,
        documentGeneration: frame.documentGeneration,
        layoutGeneration: effect.layoutGeneration,
      });
    }
    try {
      postFrameMessage(
        frame.window,
        this._frameProfile,
        buildAgentRequest(frame.session, effect.operation, effect.request),
      );
    } catch (cause) {
      this._reportLayoutDeliveryFailure(
        effect.operation,
        effect.frameGeneration,
        effect.layoutGeneration,
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "the content-agent layout request could not be delivered",
      );
    }
  }

  protected _acceptLayoutResult(
    frame: OwnedFrame,
    message: ReturnType<typeof normalizeAgentLayoutResult>,
  ): void {
    if (message === null) return;
    const layout = this._layoutOperations.get(message.operation);
    if (
      layout === undefined ||
      layout.frameGeneration !== frame.frameGeneration ||
      layout.adapter !== frame.adapter ||
      message.result.adapter !== layout.adapter
    ) {
      return;
    }
    const ownsFrame =
      (layout.phase === "initial" &&
        frame === this._pending &&
        frame.phase === "presentation-initializing") ||
      (layout.phase === "update" && frame === this._committed && frame.phase === "committed") ||
      (layout.participant?.kind === "fixed-companion" &&
        frame === this._companion &&
        frame.phase === "committed" &&
        participantsEqual(layout.participant, this._participantForFrame(frame))) ||
      (layout.phase === "prepared" &&
        frame.role === "prepared" &&
        frame.phase === "presentation-initializing");
    if (!ownsFrame) return;
    try {
      const transition = this._kernel.dispatch(
        adapterInput({
          type: "layout-result",
          participant: layout.participant,
          operation: layout.operation,
          generation: layout.frameGeneration,
          layoutGeneration: layout.layoutGeneration,
          result: message.result,
        }),
      );
      this._accepted(
        this._applyTransition(
          transition,
          () => {
            // An adopted frame is promoted by this same transition, which requires the phase.
            if (
              layout.phase === "prepared" &&
              transition.accepted &&
              !transition.effects.some(
                (effect) =>
                  effect.type === "cancel-frame" &&
                  effect.frameGeneration === frame.frameGeneration,
              )
            ) {
              frame.phase = "prepared";
              this._recordFrameTerminal(frame, "prepared", "complete");
            }
          },
          () => {
            if (
              layout.phase === "initial" &&
              transition.events.some(
                (event) =>
                  event.type === "document-committed" &&
                  event.generation === frame.documentGeneration,
              )
            )
              this._commitFrame(frame);
          },
        ),
      );
      if (layout.phase === "prepared") {
        clearTimeout(layout.timer);
        this._layoutOperations.delete(layout.operation);
      }
      if (layout.phase !== "prepared" && layout.documentGeneration !== null) {
        this._record({
          type: "layout",
          action: "settle",
          role: this._role,
          documentGeneration: layout.documentGeneration,
          layoutGeneration: layout.layoutGeneration,
          operation: layout.operation,
          phase: layout.phase,
          durationMs: this._now() - layout.startedAt,
        });
      }
    } catch (cause) {
      this._handlePublicationMessageFailure(cause);
    }
  }

  protected _layoutTimedOut(
    operationId: number,
    frameGeneration: number,
    layoutGeneration: number,
  ): void {
    const operation = this._layoutOperations.get(operationId);
    if (
      operation?.frameGeneration !== frameGeneration ||
      operation.layoutGeneration !== layoutGeneration
    ) {
      return;
    }
    try {
      const frame = this._frames.get(frameGeneration);
      if (frame !== undefined) this._cancelLayoutOperation(frame, operation, "timeout");
      this._accepted(
        this._dispatchAndApply(
          adapterInput({
            type: "layout-timeout",
            participant: operation.participant,
            operation: operationId,
            generation: frameGeneration,
            layoutGeneration,
          }),
        ),
      );
    } catch (cause) {
      this._handleBoundaryFailure(cause);
    }
  }

  protected _reportLayoutDeliveryFailure(
    operation: number,
    frameGeneration: number,
    layoutGeneration: number,
    message: string,
  ): void {
    const owned = this._layoutOperations.get(operation);
    const frame = this._frames.get(frameGeneration);
    if (owned === undefined) return;
    if (owned !== undefined && frame !== undefined) {
      this._cancelLayoutOperation(frame, owned, "delivery-failed");
    }
    this._accepted(
      this._dispatchAndApply(
        adapterInput({
          type: "layout-delivery-failed",
          participant: owned.participant,
          operation,
          generation: frameGeneration,
          layoutGeneration,
          message,
        }),
      ),
    );
  }

  protected _clearLayoutOperation(operationId: number, generation: number): void {
    const operation = this._layoutOperations.get(operationId);
    if (operation?.documentGeneration !== generation) return;
    clearTimeout(operation.timer);
    this._layoutOperations.delete(operationId);
    if (operation.documentGeneration !== null) {
      this._record({
        type: "operation-owner",
        action: "complete",
        operationKind: "layout",
        operation: operation.operation,
        documentGeneration: operation.documentGeneration,
        layoutGeneration: operation.layoutGeneration,
      });
    }
  }

  protected _clearAllLayoutOperations(): void {
    for (const operation of this._layoutOperations.values()) clearTimeout(operation.timer);
    this._layoutOperations.clear();
  }

  protected _cancelLayoutOperation(
    frame: OwnedFrame,
    operation: OwnedLayoutOperation,
    reason: PaginationCancellationReason = "owner-superseded",
  ): void {
    if (operation.cancellationSent) return;
    operation.cancellationSent = true;
    this._layoutOwnershipEvent("cancel", operation, reason);
    this._postOperationCancellation(frame, operation.operation, "layout");
  }

  protected _layoutOwnershipEvent(
    action: "cancel" | "discard",
    operation: OwnedLayoutOperation,
    reason: PaginationCancellationReason,
  ): void {
    if (operation.documentGeneration === null || operation.phase === "prepared") return;
    this._record({
      type: "layout",
      action,
      role: this._role,
      documentGeneration: operation.documentGeneration,
      layoutGeneration: operation.layoutGeneration,
      operation: operation.operation,
      phase: operation.phase,
      durationMs: this._now() - operation.startedAt,
      reason,
    });
    this._record({
      type: "operation-owner",
      action,
      operationKind: "layout",
      operation: operation.operation,
      documentGeneration: operation.documentGeneration,
      layoutGeneration: operation.layoutGeneration,
      reason,
    });
  }
}
