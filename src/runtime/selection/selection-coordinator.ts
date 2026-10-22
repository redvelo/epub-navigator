import { ReadingPositionRestorerRuntime } from "../navigation/reading-position-restorer.js";
import {
  type SelectionCaptureOperationResult,
  type NavigatorSelectionSnapshot,
} from "../navigator/api.js";
import { type OwnedFrame, type OwnedAgentOperation } from "../navigator/runtime-types.js";
import { participantsEqual, deepFreeze } from "../navigator/runtime-support.js";
import type {
  ActiveDocumentParticipant,
  KernelEffect,
  KernelEvent,
  NativeSelectionCaptureOutcome,
} from "../../generated/kernel.js";
import { NavigatorError } from "../../runtime.js";
import { postFrameMessage } from "../agent/transport.js";
import { commandInput } from "../kernel.js";
import { currentDocument, fixedCompanionDocument, primaryParticipant } from "../kernel-view.js";
import { buildAgentClearSelection } from "../agent-protocol/index.js";
import type { AgentDocumentSelectionCaptureOutcome } from "../agent-protocol/index.js";

export abstract class SelectionCoordinatorRuntime extends ReadingPositionRestorerRuntime {
  currentSelection(): NavigatorSelectionSnapshot {
    this._assertOpen();
    return this._selectionSnapshot;
  }

  captureSelection(): Promise<SelectionCaptureOperationResult> {
    this._assertOpen();
    const participant = this._defaultSelectionParticipant();
    if (participant === null) {
      return Promise.reject(new Error("selection capture requires an active content document"));
    }
    return this._runSelectionOperation(participant, "explicit");
  }

  clearSelection(): void {
    this._assertOpen();
    const frame = this._committed;
    const frameWindow = frame?.window ?? null;
    if (frame === null || frameWindow === null || frame.phase !== "committed") return;
    postFrameMessage(frameWindow, this._frameProfile, buildAgentClearSelection(frame.session));
  }

  protected async _runSelectionOperation(
    participant: ActiveDocumentParticipant,
    source: "explicit" | "ambient",
  ): Promise<SelectionCaptureOperationResult> {
    this._assertOpen();
    const transition = this._accepted(
      this._dispatchAndApply(commandInput({ type: "capture-selection", participant })),
    );
    const effect = transition.effects.find(
      (candidate): candidate is Extract<KernelEffect, { type: "agent-request" }> =>
        candidate.type === "agent-request" &&
        candidate.request.type === "capture-selection" &&
        participantsEqual(candidate.participant, participant),
    );
    if (effect === undefined) {
      throw new Error("the selection command emitted no agent request effect");
    }
    const operation = this._locatorOperations.get(effect.operation);
    if (
      operation === undefined ||
      operation.type !== "capture-selection" ||
      operation.frameGeneration !== effect.frameGeneration
    ) {
      throw new Error("the selection command did not register its capture operation");
    }
    this._latestSelectionOperation = effect.operation;
    const outcome = await operation.promise;
    if (this._locatorOperations.get(effect.operation) === operation) {
      this._locatorOperations.delete(effect.operation);
    }
    const result = Object.assign(
      {
        operation: effect.operation,
        generation: operation.generation,
        occurrence: operation.occurrence,
        resource: operation.resource,
      },
      outcome,
    ) as SelectionCaptureOperationResult;
    if (this._latestSelectionOperation === effect.operation) {
      this._latestSelectionOperation = null;
      if (
        source === "explicit" ||
        this._ambientSelectionCanReplace(
          participant,
          result.outcome === "completed" ? result.selection : null,
        )
      ) {
        this._publishSelection(result.outcome === "completed" ? result.selection : null);
      }
    }
    return result;
  }

  protected _publishSelection(selection: NativeSelectionCaptureOutcome | null): void {
    const key = JSON.stringify(selection);
    if (key === this._selectionKey) return;
    if (
      !this._closed &&
      this._kernel
        .snapshot()
        .pendingAgentOperations.some(
          (operation) => operation.operationKind === "generate-annotation-target",
        )
    ) {
      this._accepted(
        this._dispatchAndApply(
          commandInput({ type: "cancel-selection-annotation-target-generation" }),
        ),
      );
    }
    this._selectionKey = key;
    this._selectionSnapshot = deepFreeze({
      revision: this._selectionSnapshot.revision + 1,
      selection,
    });
    for (const listener of [...this._selectionListeners]) {
      try {
        listener(this._selectionSnapshot);
      } catch {
        // Selection observers cannot alter capture ownership or other observers.
      }
    }
  }

  protected _invalidateSelectionForEvents(events: readonly KernelEvent[]): void {
    const selectionParticipant = this._selectionSnapshot.selection?.basis.participant ?? null;
    const invalid = events.some((event) => {
      if (
        event.type === "closed" ||
        event.type === "document-pending" ||
        event.type === "document-committed" ||
        event.type === "fixed-companion-attached"
      ) {
        return true;
      }
      if (event.type === "fixed-companion-detached") {
        return (
          selectionParticipant?.kind === "fixed-companion" &&
          selectionParticipant.ownerDocumentGeneration === event.ownerDocumentGeneration &&
          selectionParticipant.frameGeneration === event.frameGeneration
        );
      }
      if (event.type === "document-invalidated") {
        return (
          selectionParticipant === null ||
          participantsEqual(selectionParticipant, event.participant)
        );
      }
      if (event.type === "layout-pending") {
        return (
          event.participant === null ||
          selectionParticipant === null ||
          participantsEqual(selectionParticipant, event.participant)
        );
      }
      return false;
    });
    if (!invalid) return;
    this._selectionSignalParticipant = null;
    this._selectionSignalRevision += 1;
    this._latestSelectionOperation = null;
    this._publishSelection(null);
  }

  protected _defaultSelectionParticipant(): ActiveDocumentParticipant | null {
    const activeElement = this._container.ownerDocument.activeElement;
    for (const frame of [this._committed, this._companion]) {
      if (frame !== null && activeElement === frame.iframe) {
        const participant = this._participantForFrame(frame);
        if (participant !== null) return participant;
      }
    }
    const capturedParticipant = this._selectionSnapshot.selection?.basis.participant;
    if (
      capturedParticipant !== undefined &&
      this._frameForParticipant(capturedParticipant) !== null
    ) {
      return capturedParticipant;
    }
    if (
      this._selectionSignalParticipant !== null &&
      this._frameForParticipant(this._selectionSignalParticipant) !== null
    ) {
      return this._selectionSignalParticipant;
    }
    return primaryParticipant(this._kernel.snapshot());
  }

  protected _ambientSelectionCanReplace(
    participant: ActiveDocumentParticipant,
    selection: NativeSelectionCaptureOutcome | null,
  ): boolean {
    if (selection?.status === "captured") return true;
    const currentParticipant = this._selectionSnapshot.selection?.basis.participant;
    if (currentParticipant === undefined || participantsEqual(currentParticipant, participant)) {
      return true;
    }
    return (
      this._frameForParticipant(participant)?.iframe === this._container.ownerDocument.activeElement
    );
  }

  protected _refreshCapturedSelectionGeometry(): void {
    if (this._closed) return;
    const participant = this._selectionSnapshot.selection?.basis.participant;
    if (participant !== undefined && this._frameForParticipant(participant) !== null) {
      this._queueSelectionRefresh(participant);
    }
  }

  protected _queueSelectionRefresh(participant: ActiveDocumentParticipant): void {
    this._selectionSignalParticipant = participant;
    this._selectionSignalRevision += 1;
    if (this._selectionRefreshRunning) return;
    this._selectionRefreshRunning = true;
    void (async () => {
      try {
        while (!this._closed) {
          const revision = this._selectionSignalRevision;
          const target = this._selectionSignalParticipant;
          if (target === null || this._frameForParticipant(target) === null) {
            this._publishSelection(null);
            break;
          }
          try {
            await this._runSelectionOperation(target, "ambient");
          } catch (cause) {
            if (!(cause instanceof NavigatorError)) this._handleBoundaryFailure(cause);
          }
          if (revision === this._selectionSignalRevision) break;
        }
      } finally {
        this._selectionRefreshRunning = false;
      }
    })();
  }

  protected _enrichSelectionOutcome(
    frame: OwnedFrame,
    operation: OwnedAgentOperation,
    outcome: AgentDocumentSelectionCaptureOutcome,
  ): NativeSelectionCaptureOutcome | null {
    const snapshot = this._kernel.snapshot();
    const participant = this._participantForFrame(frame);
    if (participant === null || !participantsEqual(participant, operation.participant)) return null;
    const layoutGeneration =
      participant.kind === "primary"
        ? currentDocument(snapshot)?.layout.layout.layoutGeneration
        : fixedCompanionDocument(snapshot)?.layout.layout.layoutGeneration;
    if (layoutGeneration === undefined) return null;
    const basis = {
      participant,
      frameGeneration: frame.frameGeneration,
      layoutGeneration,
      localContentBasis: outcome.basis.localContentBasis,
      localGeometryBasis: outcome.basis.localGeometryBasis,
    };
    if (outcome.status !== "captured") return { ...outcome, basis };
    const anchor = this._selectionAnchorInReader(frame, outcome.anchor);
    if (anchor === null) return { status: "unavailable", reason: "geometry-unavailable", basis };
    return {
      status: "captured",
      location: {
        kind: "range",
        occurrence: operation.occurrence,
        resource: operation.resource,
        evidence: [...outcome.evidence],
        startObservation: outcome.observation,
        endObservation: outcome.observation,
      },
      direction: outcome.direction,
      language: outcome.language,
      anchor,
      gesture: outcome.gesture,
      basis,
    };
  }
}
