import { ViewportAnchorRuntime } from "../selection/viewport-anchor.js";
import {
  type AnnotationTargetGenerationOptions,
  type AnnotationRangeAdjustment,
  type AnnotationTargetGenerationOperationResult,
} from "../navigator/api.js";
import { participantsEqual } from "../navigator/runtime-support.js";
import type {
  ActiveDocumentParticipant,
  AnnotationRangeAdjustmentOutcome,
  AnnotationTextFragmentPolicy,
  KernelEffect,
  KernelTransition,
} from "../../generated/kernel.js";
import { commandInput } from "../kernel.js";
import { currentDocument, primaryParticipant } from "../kernel-view.js";
import { sameDurablePoint } from "../selection/location-equivalence.js";

export abstract class AnnotationCoordinatorRuntime extends ViewportAnchorRuntime {
  async generateSelectionAnnotationTarget(
    selectionRevision: number,
    options: AnnotationTargetGenerationOptions = {},
  ): Promise<AnnotationTargetGenerationOperationResult> {
    this._assertOpen();
    if (!Number.isSafeInteger(selectionRevision) || selectionRevision < 0) {
      throw new TypeError("selection revision must be a non-negative safe integer");
    }
    if (
      options.textFragment !== undefined &&
      options.textFragment !== "omit" &&
      options.textFragment !== "include"
    ) {
      throw new TypeError('textFragment must be either "omit" or "include"');
    }
    const snapshot = this._selectionSnapshot;
    if (snapshot.revision !== selectionRevision || snapshot.selection?.status !== "captured") {
      throw new Error("annotation target generation requires the exact current captured selection");
    }
    const selection = snapshot.selection;
    const textFragmentPolicy: AnnotationTextFragmentPolicy =
      options.textFragment === "include" ? "include" : "exclude";
    const transition = this._accepted(
      this._dispatchAndApply(
        commandInput({
          type: "generate-annotation-target",
          participant: selection.basis.participant,
          location: selection.location,
          localContentBasis: selection.basis.localContentBasis,
          textFragmentPolicy,
        }),
      ),
    );
    const effect = transition.effects.find(
      (candidate): candidate is Extract<KernelEffect, { type: "agent-request" }> =>
        candidate.type === "agent-request" &&
        candidate.request.type === "generate-annotation-target",
    );
    if (effect === undefined) {
      throw new Error("the annotation target generation command emitted no agent request effect");
    }
    const operation = this._locatorOperations.get(effect.operation);
    if (
      operation === undefined ||
      operation.type !== "generate-annotation-target" ||
      operation.frameGeneration !== effect.frameGeneration
    ) {
      throw new Error("the annotation target generation command did not register its operation");
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
    ) as AnnotationTargetGenerationOperationResult;
  }

  async generateCurrentLocationAnnotationTarget(
    locationRevision: number,
  ): Promise<AnnotationTargetGenerationOperationResult> {
    this._assertOpen();
    if (!Number.isSafeInteger(locationRevision) || locationRevision < 0) {
      throw new TypeError("location revision must be a non-negative safe integer");
    }
    const expected = this._locationSnapshot;
    if (
      expected.revision !== locationRevision ||
      expected.location?.kind !== "point" ||
      expected.basis === null
    ) {
      throw new Error("point target generation requires the exact current location revision");
    }
    // A replacement in flight makes this revision stale; the kernel would reject the command.
    if (this._kernel.snapshot().document.pending !== null) {
      return {
        operation: 0,
        generation: expected.basis.documentGeneration,
        occurrence: expected.location.occurrence,
        resource: expected.location.resource,
        outcome: "completed",
        result: { status: "stale" },
      };
    }
    const capture = await this.captureCurrentLocation();
    if (capture.status === "cancelled") {
      return {
        operation: 0,
        generation: expected.basis.documentGeneration,
        occurrence: expected.location.occurrence,
        resource: expected.location.resource,
        outcome: "failed",
        failure: { code: "operation-cancelled", reason: capture.reason },
      };
    }
    if (capture.status !== "captured") {
      // The location moved on (a page turn landed between the two captures): the caller's
      // revision is simply stale, not a failure.
      return {
        operation: 0,
        generation: expected.basis.documentGeneration,
        occurrence: expected.location.occurrence,
        resource: expected.location.resource,
        outcome: "completed",
        result: { status: "stale" },
      };
    }
    if (!sameDurablePoint(expected.location, expected.basis, capture.location, capture.basis)) {
      return {
        operation: 0,
        generation: capture.basis.documentGeneration,
        occurrence: capture.location.occurrence,
        resource: capture.location.resource,
        outcome: "completed",
        result: { status: "stale" },
      };
    }
    const participant: ActiveDocumentParticipant = {
      kind: "primary",
      documentGeneration: capture.basis.documentGeneration,
    };
    const transition = this._accepted(
      this._dispatchAndApply(
        commandInput({
          type: "generate-current-location-annotation-target",
          participant,
          location: capture.location,
          localContentBasis: capture.basis.localContentBasis,
        }),
      ),
    );
    const effect = transition.effects.find(
      (candidate): candidate is Extract<KernelEffect, { type: "agent-request" }> =>
        candidate.type === "agent-request" &&
        candidate.request.type === "generate-current-location-annotation-target",
    );
    if (effect === undefined) throw new Error("point target generation emitted no agent request");
    const operation = this._locatorOperations.get(effect.operation);
    if (operation === undefined || operation.type !== effect.request.type) {
      throw new Error("point target generation did not register its operation");
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
    ) as AnnotationTargetGenerationOperationResult;
  }

  cancelSelectionAnnotationTargetGeneration(): KernelTransition {
    return this._command({ type: "cancel-selection-annotation-target-generation" });
  }

  async adjustAnnotationRange(
    projectionRevision: number,
    recordId: string,
    adjustment: AnnotationRangeAdjustment,
  ): Promise<AnnotationRangeAdjustmentOutcome> {
    this._assertOpen();
    if (
      !Number.isInteger(projectionRevision) ||
      projectionRevision < 0 ||
      projectionRevision > 0xffff_ffff
    ) {
      throw new TypeError("decoration projection revision must be uint32");
    }
    if (recordId.length === 0 || recordId.length > 1_024) {
      throw new TypeError("annotation record ID is invalid");
    }
    if (
      (adjustment.edge !== "start" && adjustment.edge !== "end") ||
      (adjustment.movement !== "backward" && adjustment.movement !== "forward")
    ) {
      throw new TypeError("annotation range adjustment is invalid");
    }
    const snapshot = this._kernel.snapshot();
    if (snapshot.decorations.projection.revision !== projectionRevision) {
      return { status: "stale" };
    }
    const participant = primaryParticipant(snapshot);
    if (participant === null) return { status: "stale" };
    if (!currentDocument(snapshot)?.supportedOperations.includes("adjust-annotation-range")) {
      return { status: "unsupported" };
    }
    const rendered = snapshot.decorations.participantOutcomes.some(
      (entry) =>
        participantsEqual(entry.participant, participant) &&
        entry.projectionRevision === projectionRevision &&
        entry.outcomes.some(
          (outcome) => outcome.id === recordId && outcome.outcome.status === "rendered",
        ),
    );
    if (!rendered) {
      return { status: "unavailable", reason: "decoration-not-rendered" };
    }
    const transition = this._accepted(
      this._dispatchAndApply(
        commandInput({
          type: "adjust-annotation-range",
          participant,
          projectionRevision,
          recordId,
          ...adjustment,
        }),
      ),
    );
    const effect = transition.effects.find(
      (candidate): candidate is Extract<KernelEffect, { type: "agent-request" }> =>
        candidate.type === "agent-request" && candidate.request.type === "adjust-annotation-range",
    );
    if (effect === undefined) return { status: "unsupported" };
    const operation = this._locatorOperations.get(effect.operation);
    if (operation === undefined || operation.type !== "adjust-annotation-range") {
      return { status: "failed", message: "annotation range adjustment was not registered" };
    }
    const outcome = await operation.promise;
    if (this._locatorOperations.get(effect.operation) === operation) {
      this._locatorOperations.delete(effect.operation);
    }
    if (outcome.outcome === "completed" && "result" in outcome) {
      return outcome.result as AnnotationRangeAdjustmentOutcome;
    }
    return {
      status: "failed",
      message:
        outcome.outcome === "failed" && "message" in outcome.failure
          ? outcome.failure.message
          : "annotation range adjustment was cancelled",
    };
  }
}
