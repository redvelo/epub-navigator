import { FramePromotionRuntime } from "../frame/frame-promotion.js";
import {
  type OwnedFrame,
  type OwnedAgentOperation,
  type AgentOperationOutcome,
} from "../navigator/runtime-types.js";
import { annotationSelectorMap } from "../navigator/runtime-support.js";
import { AGENT_OPERATION_TIMEOUT_MS, RECONCILE_DECORATIONS_TIMEOUT_MS } from "./configuration.js";
import type { KernelEffect } from "../../generated/kernel.js";
import type { PaginationCancellationReason } from "../pagination/index.js";
import { postFrameMessage } from "./transport.js";
import { adapterInput } from "../kernel.js";
import { buildAgentCancelOperation, buildAgentRequest } from "../agent-protocol/index.js";
import type { ContentAgentOperation } from "../agent-protocol/index.js";

export abstract class AgentOperationRuntime extends FramePromotionRuntime {
  protected _requestAgent(effect: Extract<KernelEffect, { type: "agent-request" }>): void {
    if (this._locatorOperations.has(effect.operation)) {
      throw new Error(`agent operation ${effect.operation} is already registered`);
    }
    const frame = this._frameForParticipant(effect.participant);
    if (
      frame === null ||
      frame.frameGeneration !== effect.frameGeneration ||
      frame.documentGeneration === null ||
      frame.phase !== "committed" ||
      frame.window === null ||
      frame.iframe.contentWindow !== frame.window
    ) {
      throw new Error("agent request does not identify an active participant frame");
    }
    if (
      effect.request.type === "advance-presentation" &&
      effect.participant.kind !== "primary" &&
      frame.adapter !== "reflowable-xhtml"
    ) {
      throw new Error("presentation advancement targets the primary or a reflowable companion");
    }
    let finish!: (outcome: AgentOperationOutcome) => void;
    const promise = new Promise<AgentOperationOutcome>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(
      () => this._operationTimedOut(effect.operation, effect.frameGeneration),
      effect.request.type === "reconcile-decorations"
        ? RECONCILE_DECORATIONS_TIMEOUT_MS
        : AGENT_OPERATION_TIMEOUT_MS,
    );
    this._locatorOperations.set(effect.operation, {
      participant: effect.participant,
      generation: frame.documentGeneration,
      occurrence: frame.occurrence,
      resource: frame.resource,
      frameGeneration: effect.frameGeneration,
      type: effect.request.type,
      annotationSelectors:
        effect.request.type === "resolve-annotation-target" ||
        effect.request.type === "relocate-annotation-target"
          ? annotationSelectorMap(effect.request.plan.selectors)
          : null,
      timer,
      promise,
      cancellationSent: false,
      finish,
    });
    this._record({
      type: "operation-owner",
      action: "register",
      operationKind: effect.request.type === "advance-presentation" ? "presentation" : "locator",
      operation: effect.operation,
      documentGeneration: frame.documentGeneration,
    });
    try {
      postFrameMessage(
        frame.window,
        this._frameProfile,
        buildAgentRequest(frame.session, effect.operation, effect.request),
      );
    } catch (cause) {
      this._reportOperationDeliveryFailure(
        effect.operation,
        effect.frameGeneration,
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "the content-agent request could not be delivered",
      );
    }
  }

  protected _operationTimedOut(operationId: number, frameGeneration: number): void {
    const operation = this._locatorOperations.get(operationId);
    if (operation?.frameGeneration !== frameGeneration) return;
    try {
      const frame = this._frames.get(frameGeneration);
      if (frame !== undefined) {
        this._cancelLocatorOperation(frame, operationId, operation, "timeout");
      }
      this._accepted(
        this._dispatchAndApply(
          adapterInput({
            type: "operation-timeout",
            participant: operation.participant,
            operation: operationId,
            generation: frameGeneration,
          }),
        ),
      );
    } catch (cause) {
      this._handleBoundaryFailure(cause);
    }
  }

  protected _reportOperationDeliveryFailure(
    operation: number,
    frameGeneration: number,
    message: string,
  ): void {
    const owned = this._locatorOperations.get(operation);
    const frame = this._frames.get(frameGeneration);
    if (owned === undefined) return;
    if (owned !== undefined && frame !== undefined) {
      this._cancelLocatorOperation(frame, operation, owned, "delivery-failed");
    }
    this._accepted(
      this._dispatchAndApply(
        adapterInput({
          type: "operation-delivery-failed",
          participant: owned.participant,
          operation,
          generation: frameGeneration,
          message,
        }),
      ),
    );
  }

  protected _finishOperation(operationId: number, outcome: AgentOperationOutcome): void {
    const operation = this._locatorOperations.get(operationId);
    if (operation === undefined) return;
    clearTimeout(operation.timer);
    this._locatorOperations.delete(operationId);
    this._record({
      type: "operation-owner",
      action: "complete",
      operationKind: operation.type === "advance-presentation" ? "presentation" : "locator",
      operation: operationId,
      documentGeneration: operation.generation,
    });
    operation.finish(outcome);
  }

  protected _cancelLocatorOperation(
    frame: OwnedFrame,
    operationId: number,
    operation: OwnedAgentOperation,
    reason: PaginationCancellationReason = "owner-superseded",
  ): void {
    if (operation.cancellationSent) return;
    operation.cancellationSent = true;
    this._record({
      type: "operation-owner",
      action: "cancel",
      operationKind: operation.type === "advance-presentation" ? "presentation" : "locator",
      operation: operationId,
      documentGeneration: operation.generation,
      reason,
    });
    this._postOperationCancellation(frame, operationId, operation.type);
  }

  protected _postOperationCancellation(
    frame: OwnedFrame,
    operation: number,
    operationType: ContentAgentOperation,
  ): void {
    if (
      frame.window === null ||
      frame.iframe.contentWindow !== frame.window ||
      !this._frames.has(frame.frameGeneration)
    ) {
      return;
    }
    try {
      postFrameMessage(
        frame.window,
        this._frameProfile,
        buildAgentCancelOperation(frame.session, operation, operationType),
      );
    } catch {
      // Cancellation is best-effort; local ownership is still revoked exactly once.
    }
  }
}
