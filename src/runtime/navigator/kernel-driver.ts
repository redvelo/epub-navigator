import { PublicRuntime } from "./public-runtime.js";
import { type QueuedTransition } from "./runtime-types.js";
import { participantsEqual, isExpectedBoundaryFailure } from "./runtime-support.js";
import type {
  KernelEffect,
  KernelEvent,
  KernelInput,
  KernelTransition,
} from "../../generated/kernel.js";
import { recordNavigatorDiagnostic, type NavigatorDiagnosticEvent } from "../pagination/index.js";
import { NavigatorError } from "../../runtime.js";
import { commandInput } from "../kernel.js";

const maximumDecorationRetries = 4;
const decorationRetryDelayMs = 150;

export abstract class KernelDriverRuntime extends PublicRuntime {
  protected _executeEffects(effects: readonly KernelEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "replace-frame") {
        try {
          this._replaceFrame(effect);
        } catch (cause) {
          this._cancelFrame(effect.frameGeneration);
          this._reportFrameFailure(effect.frameGeneration, {
            reason: "effect-execution-failed",
            message: cause instanceof Error ? cause.message : "publication frame setup failed",
          });
        }
      } else if (effect.type === "cancel-frame") {
        const cancelled = this._frames.get(effect.frameGeneration);
        const stage = this._fixedSpreadStage;
        const snapshot = !this._closed && this._pending !== null ? this._kernel.snapshot() : null;
        const frameGeneration =
          this._pending !== null &&
          snapshot?.document.pending === null &&
          snapshot.document.committed?.frame.generation === this._committed?.frameGeneration
            ? this._pending.frameGeneration
            : effect.frameGeneration;
        this._cancelFrame(frameGeneration);
        if (
          stage !== null &&
          cancelled !== undefined &&
          cancelled !== stage.primary &&
          cancelled.occurrence === stage.companionOccurrence &&
          !this._primaryRelayoutPending(stage.documentGeneration)
        ) {
          this._fallbackFixedSpread(stage);
        }
      } else if (effect.type === "initialize-agent") {
        this._initializeAgent(effect);
      } else if (effect.type === "agent-request") {
        this._requestAgent(effect);
      } else if (effect.type === "layout-request") {
        this._requestLayout(effect);
      } else if (effect.type === "create-prepared-frame") {
        try {
          this._createFrame(effect, "prepared");
        } catch (cause) {
          this._cancelFrame(effect.frameGeneration);
          this._reportFrameFailure(effect.frameGeneration, {
            reason: "effect-execution-failed",
            message: cause instanceof Error ? cause.message : "prepared frame setup failed",
          });
        }
      } else if (effect.type === "promote-frame") {
        this._promoteFrame(effect);
      }
      if (this._terminalError !== undefined) return;
    }
  }

  private _primaryRelayoutPending(documentGeneration: number): boolean {
    const owner = this._kernel.snapshot().layout.pending?.owner;
    return owner?.kind === "document" && owner.documentGeneration === documentGeneration;
  }

  protected _dispatchAndApply(input: KernelInput): KernelTransition {
    return this._applyTransition(this._kernel.dispatch(input));
  }

  protected _applyTransition(
    transition: KernelTransition,
    beforeEffects?: () => void,
    afterEffects?: () => void,
  ): KernelTransition {
    const queued = { transition, complete: false };
    this._transitionQueue.push(queued);
    this._applicationDepth += 1;
    try {
      beforeEffects?.();
      if (transition.accepted) {
        if (
          transition.events.some(
            (event) =>
              event.type === "document-pending" &&
              event.generation !== this._fixedSpreadStage?.documentGeneration,
          )
        ) {
          this._clearFixedSpreadStage();
          this._fixedSpreadSuppression = null;
        }
        this._reconcileCompanionEvents(transition.events, queued);
        this._invalidateSelectionForEvents(transition.events);
        if (!this._closed) this._syncReaderSurface();
        this._executeEffects(transition.effects);
      }
      if (transition.accepted && this._terminalError === undefined) {
        afterEffects?.();
        this._settleOperations(transition.events);
        this._advanceFootnoteNavigation(transition.events);
        this._publishDecorations();
        if (
          !this._closed &&
          transition.events.some(
            (event) => event.type === "document-committed" || event.type === "layout-reported",
          )
        ) {
          this._accepted(this._dispatchAndApply(commandInput({ type: "reconcile-decorations" })));
        }
        this._retryStrandedDecorations(transition.events);
        this._gateAdjacentPreparation(transition.events);
        this._scheduleAdjacentPreparation();
      }
      queued.complete = this._terminalError === undefined;
      const promotion = this._pendingPromotion;
      if (
        promotion !== null &&
        promotion.effect === transition.effects.find((effect) => effect.type === "promote-frame")
      ) {
        queued.complete = false;
        promotion.queued = queued;
      }
      const companionActivation = this._pendingCompanionActivation;
      if (companionActivation?.queued === queued) queued.complete = false;
    } finally {
      this._applicationDepth -= 1;
      if (this._applicationDepth === 0) this._publishQueuedTransitions();
    }
    if (this._terminalError !== undefined) throw this._terminalError;
    return transition;
  }

  // A reconciliation the agent abandons reports every unresolved record as stale, and one that
  // times out, fails delivery, or is superseded without its replacement surviving reports no
  // outcomes at all; nothing else re-requests either until the next commit, layout report, or
  // projection. Retry with backoff so decorations survive the style and text churn of a document
  // that is still settling, and so a lost reconciliation is re-requested on an otherwise idle
  // document. A fired retry first checks for a reconciliation already in flight: a healthy
  // supersession carries its own replacement, and restarting it would only lose its progress.
  protected _retryStrandedDecorations(events: readonly KernelEvent[]): void {
    if (this._closed) return;
    for (const event of events) {
      let projectionRevision: number;
      let generation: number;
      if (
        event.type === "agent-operation-reported" &&
        event.result.type === "reconcile-decorations" &&
        event.result.outcomes.some((record) => record.outcome.status === "stale")
      ) {
        projectionRevision = event.result.projectionRevision;
        generation = event.generation;
      } else if (
        event.type === "agent-operation-failed" &&
        event.operationKind === "reconcile-decorations"
      ) {
        projectionRevision = this._kernel.snapshot().decorations.projection.revision;
        generation = event.generation;
      } else {
        continue;
      }
      const pending = this._decorationRetry;
      const attempts =
        pending?.generation === generation && pending.projectionRevision === projectionRevision
          ? pending.attempts
          : 0;
      if (attempts >= maximumDecorationRetries) return;
      if (pending !== null) clearTimeout(pending.timer);
      const scheduled = {
        generation,
        projectionRevision,
        attempts,
        timer: setTimeout(
          () => {
            if (
              this._decorationRetry !== scheduled ||
              this._closed ||
              this._terminalError !== undefined
            ) {
              return;
            }
            if (
              this._kernel
                .snapshot()
                .pendingAgentOperations.some(
                  (operation) => operation.operationKind === "reconcile-decorations",
                )
            ) {
              return;
            }
            this._decorationRetry = { ...scheduled, attempts: scheduled.attempts + 1 };
            this._accepted(this._dispatchAndApply(commandInput({ type: "reconcile-decorations" })));
          },
          decorationRetryDelayMs * 2 ** attempts,
        ),
      };
      this._decorationRetry = scheduled;
      return;
    }
  }

  // Preparing the next adjacent frames right after a promotion competes with the promoted
  // page's own paint and observation on one main thread. Hold preparation until that document
  // has been observed once (or a short fallback elapses).
  protected _gateAdjacentPreparation(events: readonly KernelEvent[]): void {
    for (const event of events) {
      if (event.type === "document-committed") {
        if (this._preparationGate !== null) clearTimeout(this._preparationGate.timer);
        const generation = event.generation;
        this._preparationGate = {
          generation,
          timer: setTimeout(() => {
            if (this._preparationGate?.generation !== generation) return;
            this._preparationGate = null;
            if (!this._closed) this._scheduleAdjacentPreparation();
          }, 400),
        };
      } else if (
        event.type === "document-observed" &&
        this._preparationGate !== null &&
        event.generation === this._preparationGate.generation
      ) {
        clearTimeout(this._preparationGate.timer);
        this._preparationGate = null;
      }
    }
  }

  protected _settleOperations(events: readonly KernelEvent[]): void {
    for (const event of events) {
      if (event.type === "agent-operation-reported") {
        const operation = this._locatorOperations.get(event.operation);
        if (
          operation?.generation === event.generation &&
          participantsEqual(operation.participant, event.participant) &&
          operation.type === event.result.type
        ) {
          if (
            event.result.type === "generate-annotation-target" ||
            event.result.type === "generate-current-location-annotation-target" ||
            event.result.type === "adjust-annotation-range"
          ) {
            continue;
          }
          this._finishOperation(
            event.operation,
            event.result.type === "resolve-annotation-target" ||
              event.result.type === "relocate-annotation-target"
              ? { outcome: "completed", result: event.result.result }
              : event.result.type === "capture-selection"
                ? { outcome: "completed", selection: event.result.outcome }
                : event.result.type === "capture-current-location"
                  ? { outcome: "completed", locationCapture: event.result.outcome }
                  : event.result.type === "find-media-overlay-entry"
                    ? { outcome: "completed", mediaOverlayEntry: event.result.outcome }
                    : event.result.type === "reconcile-decorations"
                      ? {
                          outcome: "completed",
                          projectionRevision: event.result.projectionRevision,
                          decorations: event.result.outcomes,
                        }
                      : { outcome: "completed", status: event.result.status },
          );
        }
      } else if (event.type === "annotation-target-generation-reported") {
        const operation = this._locatorOperations.get(event.operation);
        if (
          operation?.generation === event.generation &&
          participantsEqual(operation.participant, event.participant) &&
          (operation.type === "generate-annotation-target" ||
            operation.type === "generate-current-location-annotation-target")
        ) {
          this._finishOperation(event.operation, { outcome: "completed", result: event.outcome });
        }
      } else if (event.type === "annotation-range-adjustment-reported") {
        const operation = this._locatorOperations.get(event.operation);
        if (
          operation?.generation === event.generation &&
          participantsEqual(operation.participant, event.participant) &&
          operation.type === "adjust-annotation-range"
        ) {
          this._finishOperation(event.operation, { outcome: "completed", result: event.outcome });
        }
      } else if (event.type === "agent-operation-failed") {
        const operation = this._locatorOperations.get(event.operation);
        if (
          operation?.generation === event.generation &&
          participantsEqual(operation.participant, event.participant) &&
          operation.type === event.operationKind
        ) {
          const frame = this._frames.get(operation.frameGeneration);
          if (frame !== undefined) this._cancelLocatorOperation(frame, event.operation, operation);
          this._finishOperation(event.operation, { outcome: "failed", failure: event.failure });
        }
      } else if (event.type === "layout-operation-failed") {
        const operation = this._layoutOperations.get(event.operation);
        if (
          operation === undefined ||
          operation.documentGeneration !== event.generation ||
          !participantsEqual(operation.participant, event.participant)
        ) {
          continue;
        }
        const frame = this._frames.get(operation.frameGeneration);
        if (frame !== undefined) this._cancelLayoutOperation(frame, operation);
        this._clearLayoutOperation(event.operation, event.generation);
      } else if (event.type === "layout-reported") {
        const operation = this._layoutOperations.get(event.operation);
        if (
          operation?.documentGeneration === event.generation &&
          participantsEqual(operation.participant, event.participant) &&
          operation.layoutGeneration === event.layoutGeneration
        ) {
          clearTimeout(operation.timer);
          this._layoutOperations.delete(event.operation);
        }
      }
    }
  }

  protected _publishQueuedTransitions(): void {
    if (this._publishing) return;
    this._publishing = true;
    try {
      let queued: QueuedTransition | undefined;
      while ((queued = this._transitionQueue[0]) !== undefined) {
        if (!queued.complete) break;
        this._transitionQueue.shift();
        const observationOnly =
          queued.transition.events.length > 0 &&
          queued.transition.events.every((event) => event.type === "document-observed");
        if (!observationOnly) {
          this._paginationController?.updateForeground(this._kernel.snapshot());
        }
        this._publishCurrentLocation();
        for (const listener of [...this._listeners]) {
          try {
            listener(queued.transition);
          } catch {
            // Observers cannot alter reducer or browser-effect execution.
          }
        }
      }
    } finally {
      this._publishing = false;
    }
  }

  protected _handleBoundaryFailure(cause: unknown): void {
    if (isExpectedBoundaryFailure(cause, this._closed)) return;
    this._enterTerminalFailure(cause);
  }

  protected _handlePublicationMessageFailure(cause: unknown): void {
    // Publisher code shares the agent realm and may forge protocol-shaped messages. Such
    // input can be rejected by the trusted kernel, but must not close the host runtime.
    if (cause instanceof NavigatorError) return;
    this._handleBoundaryFailure(cause);
  }

  protected _enterTerminalFailure(cause: unknown): void {
    if (this._terminalError !== undefined) return;
    const error =
      cause instanceof NavigatorError
        ? cause
        : new NavigatorError(
            {
              code: "kernel-command-failed",
              message:
                cause instanceof Error && cause.message.length > 0
                  ? cause.message
                  : "the browser boundary could not update the Navigator kernel",
            },
            { cause },
          );
    this._terminalError = error;
    this._closed = true;
    this._disposePagination();
    this._removeAllFrames();
    try {
      this._kernel.close((transition) => this._applyTransition(transition));
    } catch {
      // The first terminal failure remains authoritative.
    }
    for (const listener of [...this._errorListeners]) {
      try {
        listener(error);
      } catch {
        // Error observers cannot alter terminal cleanup.
      }
    }
  }

  protected _accepted(transition: KernelTransition): KernelTransition {
    if (!transition.accepted) {
      if (transition.failure === null)
        throw new Error("the kernel rejected a transition without a failure");
      throw new NavigatorError(transition.failure);
    }
    return transition;
  }

  protected _now(): number {
    return this._diagnosticsClock.now();
  }

  protected _record(event: NavigatorDiagnosticEvent): void {
    recordNavigatorDiagnostic(this._diagnostics, event);
  }
}
