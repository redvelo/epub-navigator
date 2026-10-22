import { NavigationCommandsRuntime } from "./commands.js";
import {
  type LocatorResolution,
  type RelocationResult,
  type AnnotationTargetOperationResult,
  type PresentationAdvanceResult,
} from "../navigator/api.js";
import {
  type OwnedAgentOperation,
  type LocatorAgentRequest,
  type AnnotationAgentRequest,
  type PresentationAdvanceCommand,
} from "../navigator/runtime-types.js";
import type { KernelEffect, NavigatorLocation } from "../../generated/kernel.js";
import { commandInput } from "../kernel.js";

export abstract class LocatorOperationsRuntime extends NavigationCommandsRuntime {
  async resolve(locator: NavigatorLocation): Promise<LocatorResolution> {
    return this._runLocatorOperation({ type: "resolve-locator", locator });
  }

  async relocate(locator: NavigatorLocation): Promise<RelocationResult> {
    this._cancelRestore("superseded");
    return this._runLocatorOperation({ type: "relocate", locator });
  }

  async resolveAnnotationTarget(targetJson: string): Promise<AnnotationTargetOperationResult> {
    return this._runAnnotationTargetOperation("resolve-annotation-target", targetJson);
  }

  async relocateAnnotationTarget(targetJson: string): Promise<AnnotationTargetOperationResult> {
    this._cancelRestore("superseded");
    return this._runAnnotationTargetOperation("relocate-annotation-target", targetJson);
  }

  protected async _runLocatorOperation(request: LocatorAgentRequest): Promise<LocatorResolution> {
    this._assertOpen();
    const transition = this._accepted(this._dispatchAndApply(commandInput(request)));
    let effect: Extract<KernelEffect, { type: "agent-request" }> | undefined;
    let operation: OwnedAgentOperation | undefined;
    for (const candidate of transition.effects) {
      if (candidate.type !== "agent-request") continue;
      if (effect !== undefined)
        throw new Error("the locator command emitted multiple agent request effects");
      effect = candidate;
      operation = this._locatorOperations.get(candidate.operation);
      if (operation === undefined || operation.frameGeneration !== candidate.frameGeneration) {
        throw new Error("the locator command did not register its resolver operation");
      }
    }
    if (effect === undefined || operation === undefined) {
      throw new Error("the accepted locator command emitted no agent request effect");
    }
    const outcome = await operation.promise;
    if (this._locatorOperations.get(effect.operation) === operation) {
      this._locatorOperations.delete(effect.operation);
    }
    const result = Object.assign(
      {
        operation: effect.operation,
        generation: operation.generation,
        occurrence: request.locator.occurrence,
        resource: request.locator.resource,
      },
      outcome,
    );
    return result as LocatorResolution;
  }

  protected async _runAnnotationTargetOperation(
    type: AnnotationAgentRequest["type"],
    targetJson: string,
  ): Promise<AnnotationTargetOperationResult> {
    this._assertOpen();
    const plan = this._kernel.projectAnnotationTarget(targetJson);
    const request = { type, plan };
    const transition = this._accepted(this._dispatchAndApply(commandInput(request)));
    const effect = transition.effects.find(
      (candidate): candidate is Extract<KernelEffect, { type: "agent-request" }> =>
        candidate.type === "agent-request" && candidate.request.type === type,
    );
    if (effect === undefined) {
      throw new Error("the annotation target command emitted no agent request effect");
    }
    const operation = this._locatorOperations.get(effect.operation);
    if (operation === undefined || operation.frameGeneration !== effect.frameGeneration) {
      throw new Error("the annotation target command did not register its resolver operation");
    }
    const outcome = await operation.promise;
    if (this._locatorOperations.get(effect.operation) === operation) {
      this._locatorOperations.delete(effect.operation);
    }
    return Object.assign(
      {
        operation: effect.operation,
        generation: operation.generation,
        occurrence: operation.occurrence,
        resource: plan.resource,
      },
      outcome,
    ) as AnnotationTargetOperationResult;
  }

  protected async _runPresentationOperation(
    request: PresentationAdvanceCommand,
  ): Promise<PresentationAdvanceResult> {
    this._assertOpen();
    const transition = this._accepted(this._dispatchAndApply(commandInput(request)));
    const effect = transition.effects.find(
      (candidate): candidate is Extract<KernelEffect, { type: "agent-request" }> =>
        candidate.type === "agent-request" && candidate.request.type === "advance-presentation",
    );
    if (effect === undefined) {
      throw new Error("the accepted presentation command emitted no agent request effect");
    }
    const operation = this._locatorOperations.get(effect.operation);
    if (
      operation === undefined ||
      operation.type !== "advance-presentation" ||
      operation.frameGeneration !== effect.frameGeneration
    ) {
      throw new Error("the presentation command did not register its agent operation");
    }
    const outcome = await operation.promise;
    if (this._locatorOperations.get(effect.operation) === operation) {
      this._locatorOperations.delete(effect.operation);
    }
    return Object.assign(
      {
        operation: effect.operation,
        generation: operation.generation,
        occurrence: operation.occurrence,
        resource: operation.resource,
      },
      outcome,
    ) as PresentationAdvanceResult;
  }
}
