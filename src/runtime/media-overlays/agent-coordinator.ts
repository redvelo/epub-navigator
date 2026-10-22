import { DecorationCoordinatorRuntime } from "../decorations/decoration-coordinator.js";
import { AGENT_OPERATION_TIMEOUT_MS } from "../agent/configuration.js";
import { postFrameMessage } from "../agent/transport.js";
import {
  buildAgentSetMediaOverlayActive,
  normalizeAgentMediaOverlayActiveApplied,
} from "../agent-protocol/index.js";
import type { KernelEffect } from "../../generated/kernel.js";
import { commandInput } from "../kernel.js";
import { currentDocument } from "../kernel-view.js";
import type {
  MediaOverlayActiveResult,
  MediaOverlayActiveTarget,
  MediaOverlayEntryResult,
} from "../navigator/api.js";

interface PendingMediaOverlayActive {
  readonly frameGeneration: number;
  readonly occurrence: number;
  readonly resolve: (result: MediaOverlayActiveResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export abstract class MediaOverlayAgentRuntime extends DecorationCoordinatorRuntime {
  protected readonly _pendingMediaOverlayCommands = new Map<number, PendingMediaOverlayActive>();
  protected _mediaOverlayCommandSequence = 0;

  setMediaOverlayActive(
    target: MediaOverlayActiveTarget | null,
  ): Promise<MediaOverlayActiveResult> {
    this._assertOpen();
    const frame = this._committed;
    if (frame === null || frame.window === null || frame.phase !== "committed") {
      return Promise.resolve({ status: "stale" });
    }
    if (target !== null && target.occurrence !== frame.occurrence) {
      return Promise.resolve({ status: "stale" });
    }
    const commandId = this._nextMediaOverlayCommandId();
    const message = buildAgentSetMediaOverlayActive(
      frame.session,
      commandId,
      target?.fragment ?? null,
      target?.activeClasses ?? [],
      target?.playbackActiveClasses ?? [],
    );
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pendingMediaOverlayCommands.delete(commandId)) resolve({ status: "failed" });
      }, AGENT_OPERATION_TIMEOUT_MS);
      this._pendingMediaOverlayCommands.set(commandId, {
        frameGeneration: frame.frameGeneration,
        occurrence: frame.occurrence,
        resolve,
        timer,
      });
      postFrameMessage(frame.window!, this._frameProfile, message);
    });
  }

  async findMediaOverlayEntry(
    occurrence: number,
    fragments: readonly string[],
  ): Promise<MediaOverlayEntryResult> {
    this._assertOpen();
    const snapshot = this._kernel.snapshot();
    const document = currentDocument(snapshot);
    if (
      this._role !== "foreground" ||
      snapshot.document.pending !== null ||
      document?.layout.state !== "settled" ||
      document.frame.occurrence !== occurrence
    ) {
      return { status: "stale" };
    }
    if (!document.supportedOperations.includes("find-media-overlay-entry")) {
      return { status: "unsupported" };
    }
    const transition = this._accepted(
      this._dispatchAndApply(
        commandInput({ type: "find-media-overlay-entry", occurrence, fragments: [...fragments] }),
      ),
    );
    const effect = transition.effects.find(
      (candidate): candidate is Extract<KernelEffect, { type: "agent-request" }> =>
        candidate.type === "agent-request" &&
        candidate.request.type === "find-media-overlay-entry" &&
        candidate.participant.kind === "primary",
    );
    const operation =
      effect === undefined ? undefined : this._locatorOperations.get(effect.operation);
    if (effect === undefined || operation?.type !== "find-media-overlay-entry") {
      return { status: "failed" };
    }
    const outcome = await operation.promise;
    if (this._locatorOperations.get(effect.operation) === operation) {
      this._locatorOperations.delete(effect.operation);
    }
    if (outcome.outcome === "failed") {
      return { status: outcome.failure.code === "operation-cancelled" ? "stale" : "failed" };
    }
    if (!("mediaOverlayEntry" in outcome)) return { status: "failed" };
    const entry = outcome.mediaOverlayEntry;
    switch (entry.state) {
      case "found":
        return { status: "found", index: entry.index };
      case "unavailable":
        return { status: "stale" };
      case "unsupported":
        return { status: "unsupported" };
      case "none":
        return { status: "none" };
    }
  }

  protected _routeMediaOverlayMessage(
    event: MessageEvent<unknown>,
    source: Window,
    frame: { readonly session: string; readonly frameGeneration: number },
  ): boolean {
    const applied = normalizeAgentMediaOverlayActiveApplied(event, source, frame.session);
    if (applied === null) return false;
    const pending = this._pendingMediaOverlayCommands.get(applied.commandId);
    if (pending !== undefined && pending.frameGeneration === frame.frameGeneration) {
      clearTimeout(pending.timer);
      this._pendingMediaOverlayCommands.delete(applied.commandId);
      pending.resolve(
        applied.status === "applied"
          ? { status: "applied", visible: applied.visible, occurrence: pending.occurrence }
          : { status: applied.status },
      );
    }
    return true;
  }

  protected _cancelMediaOverlayCommands(): void {
    for (const pending of this._pendingMediaOverlayCommands.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ status: "stale" });
    }
    this._pendingMediaOverlayCommands.clear();
  }

  private _nextMediaOverlayCommandId(): number {
    this._mediaOverlayCommandSequence =
      this._mediaOverlayCommandSequence >= 0xffff_ffff ? 1 : this._mediaOverlayCommandSequence + 1;
    return this._mediaOverlayCommandSequence;
  }
}
