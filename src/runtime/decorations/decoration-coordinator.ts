import { AnnotationCoordinatorRuntime } from "../annotations/annotation-coordinator.js";
import { type NavigatorDecorationActivation } from "../navigator/api.js";
import { participantsEqual, deepFreeze } from "../navigator/runtime-support.js";
import type { DecorationProjection, DecorationSnapshot } from "../../generated/kernel.js";
import { postFrameMessage } from "../agent/transport.js";
import { commandInput } from "../kernel.js";
import { buildAgentSetActiveDecoration } from "../agent-protocol/index.js";

export abstract class DecorationCoordinatorRuntime extends AnnotationCoordinatorRuntime {
  setDecorationProjection(projection: DecorationProjection): void {
    this._assertOpen();
    const current = this._kernel.snapshot().decorations.projection;
    if (projection.revision === current.revision) {
      if (JSON.stringify(projection) !== JSON.stringify(current)) {
        throw new Error("a decoration projection revision cannot identify different records");
      }
      return;
    }
    this._accepted(
      this._dispatchAndApply(commandInput({ type: "set-decoration-projection", projection })),
    );
  }

  decorationSnapshot(): DecorationSnapshot {
    this._assertOpen();
    return this._decorationSnapshot;
  }

  setActiveDecoration(projectionRevision: number, id: string | null): void {
    this._assertOpen();
    const snapshot = this._decorationSnapshot;
    if (snapshot.projection.revision !== projectionRevision) return;
    if (id !== null && !snapshot.projection.records.some((record) => record.id === id)) return;
    const frame = this._committed;
    const frameWindow = frame?.window ?? null;
    if (frame === null || frameWindow === null || frame.phase !== "committed") return;
    postFrameMessage(
      frameWindow,
      this._frameProfile,
      buildAgentSetActiveDecoration(frame.session, projectionRevision, id),
    );
  }

  activateDecorationLink(activation: NavigatorDecorationActivation): void {
    this._assertOpen();
    if (activation.link === null || !this._decorationActivationIsCurrent(activation)) return;
    const frame = this._frameForParticipant(activation.participant);
    if (frame === null || frame.phase !== "committed") return;
    this._acceptActivationRequest(frame, activation.participant, {
      ...activation.link,
      footnote: null,
    });
  }

  protected _publishDecorations(): void {
    if (this._closed) return;
    const snapshot = this._kernel.snapshot().decorations;
    const key = JSON.stringify(snapshot);
    if (key === this._decorationKey) return;
    this._decorationKey = key;
    this._decorationSnapshot = deepFreeze(snapshot);
    for (const listener of [...this._decorationListeners]) {
      try {
        listener(this._decorationSnapshot);
      } catch {
        // Decoration observers cannot alter kernel ownership or other observers.
      }
    }
  }

  protected _decorationActivationIsCurrent(activation: NavigatorDecorationActivation): boolean {
    const snapshot = this._decorationSnapshot;
    if (snapshot.projection.revision !== activation.projectionRevision) return false;
    const frame = this._frameForParticipant(activation.participant);
    if (
      frame === null ||
      frame.phase !== "committed" ||
      !participantsEqual(this._participantForFrame(frame), activation.participant)
    ) {
      return false;
    }
    const records = new Map(snapshot.projection.records.map((record) => [record.id, record]));
    if (
      activation.ids.length === 0 ||
      activation.ids.some((id) => records.get(id)?.occurrence !== frame.occurrence)
    ) {
      return false;
    }
    const outcomes = snapshot.participantOutcomes.find(
      (candidate) =>
        candidate.projectionRevision === activation.projectionRevision &&
        participantsEqual(candidate.participant, activation.participant),
    );
    return activation.ids.every(
      (id) =>
        outcomes?.outcomes.find((candidate) => candidate.id === id)?.outcome.status === "rendered",
    );
  }
}
