import { LayoutOperationRuntime } from "./layout-operation-registry.js";
import { type OwnedFrame } from "../navigator/runtime-types.js";
import { annotationReportsMatch, participantsEqual } from "../navigator/runtime-support.js";
import type { AgentResult } from "../../generated/kernel.js";
import { adapterInput } from "../kernel.js";
import {
  normalizeAgentAdvancePresentationResult,
  normalizeAgentResult,
} from "../agent-protocol/index.js";

export abstract class AgentResultRuntime extends LayoutOperationRuntime {
  protected _acceptLocatorResult(
    frame: OwnedFrame,
    message:
      | ReturnType<typeof normalizeAgentResult>
      | ReturnType<typeof normalizeAgentAdvancePresentationResult>,
  ): void {
    if (message === null) return;
    const operation = this._locatorOperations.get(message.operation);
    if (
      operation !== undefined &&
      operation.frameGeneration === frame.frameGeneration &&
      participantsEqual(operation.participant, this._participantForFrame(frame)) &&
      frame.phase === "committed"
    ) {
      try {
        let result: AgentResult;
        if (message.resultType === "advance-presentation") {
          if (operation.type !== "advance-presentation") {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the agent result type does not match its requested operation",
            );
            return;
          }
          result = { type: "advance-presentation", status: message.status };
        } else if (
          message.resultType === "resolve-annotation-target" ||
          message.resultType === "relocate-annotation-target"
        ) {
          if (message.resultType !== operation.type) {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the agent result type does not match its requested operation",
            );
            return;
          }
          if (!annotationReportsMatch(operation.annotationSelectors, message.result.reports)) {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the annotation result does not match its requested selector plan",
            );
            return;
          }
          result = { type: message.resultType, result: message.result };
        } else if (message.resultType === "resolve-locator" || message.resultType === "relocate") {
          if (operation.type === "advance-presentation" || message.resultType !== operation.type) {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the agent result type does not match its requested operation",
            );
            return;
          }
          result = { type: operation.type, status: message.status };
        } else if (message.resultType === "capture-selection") {
          if (operation.type !== "capture-selection") {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the agent result type does not match its requested operation",
            );
            return;
          }
          const outcome = this._enrichSelectionOutcome(frame, operation, message.outcome);
          if (outcome === null) {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the selection result does not match the active participant layout",
            );
            return;
          }
          result = { type: "capture-selection", outcome };
        } else if (message.resultType === "capture-current-location") {
          if (operation.type !== "capture-current-location") {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the agent result type does not match its requested operation",
            );
            return;
          }
          const outcome = this._enrichCurrentLocationOutcome(frame, operation, message.outcome);
          if (outcome === null) {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the location result does not match the settled primary layout",
            );
            return;
          }
          result = { type: "capture-current-location", outcome };
        } else if (message.resultType === "find-media-overlay-entry") {
          if (operation.type !== "find-media-overlay-entry") {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the agent result type does not match its requested operation",
            );
            return;
          }
          result = { type: "find-media-overlay-entry", outcome: message.outcome };
        } else if (message.resultType === "generate-annotation-target") {
          if (operation.type !== "generate-annotation-target") {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the agent result type does not match its requested operation",
            );
            return;
          }
          result = { type: "generate-annotation-target", candidate: message.candidate };
        } else if (message.resultType === "generate-current-location-annotation-target") {
          if (operation.type !== "generate-current-location-annotation-target") {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the agent result type does not match its requested operation",
            );
            return;
          }
          result = {
            type: "generate-current-location-annotation-target",
            candidate: message.candidate,
          };
        } else if (message.resultType === "reconcile-decorations") {
          if (operation.type !== "reconcile-decorations") {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the agent result type does not match its requested operation",
            );
            return;
          }
          result = {
            type: "reconcile-decorations",
            projectionRevision: message.projectionRevision,
            outcomes: [...message.outcomes],
          };
        } else if (message.resultType === "adjust-annotation-range") {
          if (operation.type !== "adjust-annotation-range") {
            this._reportOperationDeliveryFailure(
              message.operation,
              frame.frameGeneration,
              "the agent result type does not match its requested operation",
            );
            return;
          }
          result = { type: "adjust-annotation-range", candidate: message.candidate };
        } else {
          return;
        }
        this._accepted(
          this._dispatchAndApply(
            adapterInput({
              type: "agent-result",
              participant: operation.participant,
              operation: message.operation,
              generation: frame.frameGeneration,
              result,
            }),
          ),
        );
      } catch (cause) {
        this._handlePublicationMessageFailure(cause);
      }
    }
  }
}
