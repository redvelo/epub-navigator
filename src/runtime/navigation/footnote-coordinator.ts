import { ActivationCoordinatorRuntime } from "./activation-coordinator.js";
import { type ActiveFootnoteNavigation } from "../navigator/runtime-types.js";
import { AGENT_OPERATION_TIMEOUT_MS } from "../agent/configuration.js";
import type { KernelEvent } from "../../generated/kernel.js";
import type { NavigatorFootnoteReturnResult } from "../../footnotes.js";
import { postFrameMessage } from "../agent/transport.js";
import { buildAgentReturnFromFootnote } from "../agent-protocol/index.js";

export abstract class FootnoteCoordinatorRuntime extends ActivationCoordinatorRuntime {
  returnFromFootnote(activationId: number): Promise<NavigatorFootnoteReturnResult> {
    this._assertOpen();
    if (!Number.isInteger(activationId) || activationId < 0 || activationId > 0xffff_ffff) {
      return Promise.reject(new TypeError("footnote activation ID must be uint32"));
    }
    const active = this._activeFootnote;
    if (active === null || active.activationId !== activationId) {
      return Promise.resolve({ status: "stale" });
    }
    if (active.participant === null) return Promise.resolve({ status: "stale" });
    const frame = this._frameForParticipant(active.participant);
    if (frame === null || frame.window === null || frame.phase !== "committed") {
      this._setActiveFootnote(null);
      return Promise.resolve({ status: "stale" });
    }
    if (this._pendingFootnoteReturn !== null) {
      clearTimeout(this._pendingFootnoteReturn.timer);
      this._pendingFootnoteReturn.resolve({ status: "stale" });
      this._pendingFootnoteReturn = null;
    }
    if (active.source.resource !== active.destinationResource) {
      const transition = this._command({
        type: "open-occurrence-at",
        occurrence: active.source.occurrence,
        evidence: active.source.evidence,
      });
      const generation = transition.events.find(
        (event) => event.type === "document-pending",
      )?.generation;
      if (generation === undefined) return Promise.resolve({ status: "failed" });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const pending = this._pendingFootnoteReturn;
          if (pending?.activationId !== activationId) return;
          this._pendingFootnoteReturn = null;
          resolve({ status: "failed" });
        }, AGENT_OPERATION_TIMEOUT_MS);
        this._pendingFootnoteReturn = {
          participant: null,
          generation,
          activationId,
          resolve,
          timer,
        };
      });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this._pendingFootnoteReturn;
        if (pending?.activationId !== activationId) return;
        this._pendingFootnoteReturn = null;
        resolve({ status: "failed" });
      }, AGENT_OPERATION_TIMEOUT_MS);
      this._pendingFootnoteReturn = {
        participant: active.participant,
        generation: null,
        activationId,
        resolve,
        timer,
      };
      postFrameMessage(
        frame.window!,
        this._frameProfile,
        buildAgentReturnFromFootnote(frame.session, activationId),
      );
    });
  }

  protected _setActiveFootnote(active: ActiveFootnoteNavigation | null): void {
    this._activeFootnote = active;
    const navigation =
      active === null || active.participant === null || active.pendingGeneration !== null
        ? null
        : {
            activationId: active.activationId,
            occurrence: active.destinationOccurrence,
            resource: active.destinationResource,
          };
    for (const listener of this._footnoteListeners) {
      try {
        listener(navigation);
      } catch {
        // Footnote observers do not participate in runtime state transitions.
      }
    }
  }

  protected _advanceFootnoteNavigation(events: readonly KernelEvent[]): void {
    for (const event of events) {
      const pendingReturn = this._pendingFootnoteReturn;
      if (
        pendingReturn?.generation !== null &&
        event.type === "document-committed" &&
        event.generation === pendingReturn?.generation
      ) {
        clearTimeout(pendingReturn.timer);
        this._pendingFootnoteReturn = null;
        this._setActiveFootnote(null);
        this._committed?.iframe.focus({ preventScroll: true });
        pendingReturn.resolve({ status: "returned" });
        continue;
      }
      const active = this._activeFootnote;
      if (
        active?.pendingGeneration !== null &&
        active?.pendingGeneration !== undefined &&
        event.type === "document-committed" &&
        event.generation === active.pendingGeneration &&
        event.resource === active.destinationResource
      ) {
        const frame = this._committed;
        if (frame !== null && frame.occurrence === active.destinationOccurrence) {
          this._setActiveFootnote({
            ...active,
            participant: this._participantForFrame(frame),
            pendingGeneration: null,
          });
        }
        continue;
      }
      if (event.type === "document-pending") {
        const owned =
          event.generation === active?.pendingGeneration ||
          event.generation === pendingReturn?.generation;
        if (!owned) {
          if (pendingReturn !== null) {
            clearTimeout(pendingReturn.timer);
            this._pendingFootnoteReturn = null;
            pendingReturn.resolve({ status: "stale" });
          }
          this._setActiveFootnote(null);
        }
      }
      if (
        (event.type === "document-cancelled" ||
          event.type === "document-load-failed" ||
          event.type === "document-invalidated") &&
        (event.generation === active?.pendingGeneration ||
          event.generation === pendingReturn?.generation)
      ) {
        if (pendingReturn !== null) {
          clearTimeout(pendingReturn.timer);
          this._pendingFootnoteReturn = null;
          pendingReturn.resolve({ status: "failed" });
        }
        this._setActiveFootnote(null);
      }
    }
  }
}
