import { SelectionCoordinatorRuntime } from "./selection-coordinator.js";
import { type OwnedFrame, type OwnedAgentOperation } from "../navigator/runtime-types.js";
import { deepFreeze } from "../navigator/runtime-support.js";
import type {
  KernelEffect,
  NavigatorLocationCapture,
  NavigatorLocationSnapshot,
  VisibleOccurrenceRange,
} from "../../generated/kernel.js";
import { commandInput } from "../kernel.js";
import {
  currentDocument,
  committedCurrentLocation,
  fixedCompanionDocument,
} from "../kernel-view.js";
import type { AgentDocumentLocationCaptureOutcome } from "../agent-protocol/index.js";
import type { CurrentLocationCaptureOutcome } from "../../generated/kernel.js";

export abstract class LocationCoordinatorRuntime extends SelectionCoordinatorRuntime {
  visibleOccurrenceRange(): VisibleOccurrenceRange | null {
    this._assertOpen();
    return this._visibleOccurrenceRange();
  }

  currentLocation(): NavigatorLocationSnapshot {
    return this._locationSnapshot;
  }

  async captureCurrentLocation(): Promise<NavigatorLocationCapture> {
    this._assertOpen();
    const snapshot = this._kernel.snapshot();
    const document = currentDocument(snapshot);
    if (
      this._role !== "foreground" ||
      snapshot.document.pending !== null ||
      document?.layout.state !== "settled" ||
      !document.supportedOperations.includes("capture-current-location")
    ) {
      return { status: "unavailable", basis: null };
    }
    const transition = this._accepted(
      this._dispatchAndApply(commandInput({ type: "capture-current-location" })),
    );
    const effect = transition.effects.find(
      (candidate): candidate is Extract<KernelEffect, { type: "agent-request" }> =>
        candidate.type === "agent-request" &&
        candidate.request.type === "capture-current-location" &&
        candidate.participant.kind === "primary",
    );
    if (effect === undefined)
      throw new Error("the location command emitted no agent request effect");
    const operation = this._locatorOperations.get(effect.operation);
    if (operation === undefined || operation.type !== "capture-current-location") {
      throw new Error("the location command did not register its capture operation");
    }
    const outcome = await operation.promise;
    if (this._locatorOperations.get(effect.operation) === operation) {
      this._locatorOperations.delete(effect.operation);
    }
    if (outcome.outcome === "failed") {
      return outcome.failure.code === "operation-cancelled"
        ? { status: "cancelled", reason: outcome.failure.reason }
        : {
            status: "failed",
            message:
              outcome.failure.code === "operation-timeout" ||
              outcome.failure.code === "operation-delivery-failed"
                ? outcome.failure.message
                : "current location capture failed",
            basis: null,
          };
    }
    if (!("locationCapture" in outcome)) {
      return {
        status: "failed",
        message: "current location capture returned no result",
        basis: null,
      };
    }
    const capture = outcome.locationCapture;
    if (capture.status === "captured") {
      const visibleOccurrences = this._visibleOccurrenceRange();
      if (visibleOccurrences === null) return { status: "stale", basis: capture.basis };
      this._publishLocationValue({
        location: capture.location,
        basis: {
          documentGeneration: capture.basis.documentGeneration,
          frameGeneration: capture.basis.frameGeneration,
          layoutGeneration: capture.basis.layoutGeneration,
        },
        visibleOccurrences,
      });
      return { ...capture, visibleOccurrences };
    }
    return capture.status === "failed"
      ? { ...capture, message: capture.message ?? "content agent failed to capture location" }
      : capture;
  }

  protected _publishCurrentLocation(force = false): void {
    if (this._closed && !force) return;
    const committed =
      this._role === "foreground" ? committedCurrentLocation(this._kernel.snapshot()) : null;
    const visibleOccurrences = committed === null ? null : this._visibleOccurrenceRange();
    const value =
      committed === null || visibleOccurrences === null
        ? { location: null, basis: null, visibleOccurrences: null }
        : { ...committed, visibleOccurrences };
    this._publishLocationValue(value, force);
  }

  protected _publishLocationValue(
    value: Omit<NavigatorLocationSnapshot, "revision">,
    force = false,
  ): void {
    const key = JSON.stringify(value);
    if (key !== this._locationKey) {
      this._locationKey = key;
      this._locationSnapshot = deepFreeze({
        revision: this._locationSnapshot.revision + 1,
        ...value,
      });
    } else if (!force) {
      return;
    }
    for (const listener of [...this._locationListeners]) {
      try {
        listener(this._locationSnapshot);
      } catch {
        // Location observers cannot alter reducer state or other observers.
      }
    }
  }

  protected _enrichCurrentLocationOutcome(
    frame: OwnedFrame,
    operation: OwnedAgentOperation,
    outcome: AgentDocumentLocationCaptureOutcome,
  ): CurrentLocationCaptureOutcome | null {
    const snapshot = this._kernel.snapshot();
    const document = currentDocument(snapshot);
    if (
      document === null ||
      document.layout.state !== "settled" ||
      operation.participant.kind !== "primary" ||
      operation.participant.documentGeneration !== document.generation ||
      frame.frameGeneration !== document.frame.generation
    ) {
      return null;
    }
    const basis = {
      documentGeneration: document.generation,
      frameGeneration: document.frame.generation,
      layoutGeneration: document.layout.layout.layoutGeneration,
      localContentBasis: outcome.basis.localContentBasis,
      localGeometryBasis: outcome.basis.localGeometryBasis,
    };
    if (outcome.status !== "captured") return { ...outcome, basis };
    return {
      status: "captured",
      location: {
        kind: "point",
        occurrence: document.frame.occurrence,
        resource: document.frame.resource,
        evidence: [...outcome.evidence],
        observation: outcome.observation,
      },
      basis,
    };
  }

  protected _visibleOccurrenceRange(): VisibleOccurrenceRange | null {
    const primary = this._committed;
    if (primary === null || primary.phase !== "committed") return null;
    const companionDocument = fixedCompanionDocument(this._kernel.snapshot());
    const companion = this._companion;
    if (
      companion === null ||
      companion.phase !== "committed" ||
      companionDocument?.frame.generation !== companion.frameGeneration
    ) {
      return {
        primaryOccurrence: primary.occurrence,
        firstOccurrence: primary.occurrence,
        lastOccurrence: primary.occurrence,
        companion: null,
      };
    }
    return {
      primaryOccurrence: primary.occurrence,
      firstOccurrence: Math.min(primary.occurrence, companion.occurrence),
      lastOccurrence: Math.max(primary.occurrence, companion.occurrence),
      companion: {
        occurrence: companion.occurrence,
        placement: companionDocument.placement,
      },
    };
  }
}
