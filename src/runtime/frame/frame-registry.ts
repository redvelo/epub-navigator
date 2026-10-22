import { FootnoteCoordinatorRuntime } from "../navigation/footnote-coordinator.js";
import { type OwnedFrame } from "../navigator/runtime-types.js";
import { layoutOwnerParticipant, participantsEqual } from "../navigator/runtime-support.js";
import { createProtocolSession, postFrameMessage } from "../agent/transport.js";
import { AGENT_READINESS_TIMEOUT_MS, FRAME_RELEASE_TIMEOUT_MS } from "../agent/configuration.js";
import { buildAgentRelease } from "../agent-protocol/index.js";
import type {
  ActiveDocumentParticipant,
  FrameFailureReason,
  KernelEffect,
  LayoutOwner,
} from "../../generated/kernel.js";
import { publicationResourceUrl } from "../../mount.js";
import { imageDocumentUrl } from "../../image-document.js";
import { adapterInput, frameInput } from "../kernel.js";
import {
  currentFrame,
  fixedCompanionParticipant,
  occurrenceLoadableTarget,
  primaryParticipant,
} from "../kernel-view.js";
import { buildAgentInitialize } from "../agent-protocol/index.js";
import type { AgentRole } from "../agent-protocol/index.js";
import type { NavigatorDiagnosticEvent } from "../pagination/index.js";

export abstract class FrameRegistryRuntime extends FootnoteCoordinatorRuntime {
  protected readonly _retiringFrames = new Map<
    Window,
    { readonly iframe: HTMLIFrameElement; readonly timer: ReturnType<typeof setTimeout> }
  >();

  protected abstract override _hideFrame(frame: OwnedFrame): void;

  protected _replaceFrame(effect: Extract<KernelEffect, { type: "replace-frame" }>): void {
    if (this._pending !== null) throw new Error("the previous pending frame was not cancelled");
    this._pending = this._createFrame(effect, this._role);
  }

  protected _createFrame(
    effect: Extract<KernelEffect, { type: "replace-frame" | "create-prepared-frame" }>,
    role: AgentRole,
  ): OwnedFrame {
    if (this._frames.has(effect.frameGeneration)) {
      throw new Error("the physical frame generation is already owned");
    }
    if (this._frames.size >= 3) throw new Error("the foreground frame limit was exceeded");
    const iframe = this._container.ownerDocument.createElement("iframe");
    iframe.setAttribute("sandbox", this._frameProfile.sandbox);
    iframe.setAttribute("allow", "");
    iframe.referrerPolicy = "no-referrer";
    iframe.title = `Loading ${this._frameTitle}`;
    iframe.dataset.epubNavigatorParticipant = role === "prepared" ? "prepared" : "pending-primary";
    iframe.dataset.epubNavigatorOccurrence = String(effect.occurrence);
    // Establish the child browsing context's media-query environment before navigation starts.
    iframe.style.colorScheme = this._kernel.snapshot().layout.preferences.colorScheme;
    iframe.inert = true;
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
    // WebKit can collapse the first absolutely positioned iframe before its first layout.
    const initialFrame = this._committed === null && role !== "prepared";
    iframe.style.position = initialFrame ? "relative" : "absolute";
    if (!initialFrame) iframe.style.inset = "0";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    const target = occurrenceLoadableTarget(
      this._kernel.snapshot().readingOrder[effect.occurrence],
    );
    if (target === null || target.resource !== effect.resource) {
      throw new Error("frame replacement does not identify a loadable occurrence target");
    }
    const frame: OwnedFrame = {
      iframe,
      frameGeneration: effect.frameGeneration,
      occurrence: effect.occurrence,
      resource: effect.resource,
      adapter: target.adapter,
      controller: new AbortController(),
      session: createProtocolSession(),
      fixedViewport: null,
      fixedGeometry: null,
      documentGeneration:
        effect.type === "replace-frame"
          ? (this._kernel.snapshot().document.pending?.generation ?? null)
          : null,
      role,
      phase: "loading",
      invalidated: false,
      readinessTimer: null,
      window: null,
      diagnosticsCreatedAt: this._now(),
      diagnosticsLoadedAt: null,
      diagnosticsAgentReadyAt: null,
      diagnosticsTerminal: false,
    };
    this._frames.set(frame.frameGeneration, frame);
    if (frame.adapter === "reflowable-xhtml") this._applyReflowableSlotGeometry(frame);
    iframe.addEventListener("load", () => this._frameLoaded(frame), {
      signal: frame.controller.signal,
    });
    iframe.addEventListener("error", () => this._frameFailed(frame, { reason: "load-error" }), {
      signal: frame.controller.signal,
    });
    const resourceUrl = publicationResourceUrl(this._publication.mount, effect.resource);
    iframe.src = target.adapter === "fixed-image" ? imageDocumentUrl(resourceUrl) : resourceUrl;
    this._frameStack.append(iframe);
    frame.window = iframe.contentWindow;
    return frame;
  }

  protected _frameLoaded(frame: OwnedFrame): void {
    if (frame.iframe.style.position === "relative") {
      frame.iframe.style.position = "absolute";
      frame.iframe.style.inset = "0";
    }
    if (this._committed === frame || this._companion === frame || frame.phase === "prepared") {
      this._invalidateUnexpectedNavigation(frame);
      return;
    }
    if (!this._isActiveLoadingFrame(frame)) return;
    if (frame.phase === "agent-initializing" || frame.phase === "presentation-initializing") {
      this._frameFailed(frame, { reason: "unexpected-navigation" });
      return;
    }
    frame.diagnosticsLoadedAt ??= this._now();
    try {
      this._accepted(
        this._dispatchAndApply(frameInput({ type: "loaded", generation: frame.frameGeneration })),
      );
    } catch (cause) {
      this._handleBoundaryFailure(cause);
    }
  }

  protected _initializeAgent(effect: Extract<KernelEffect, { type: "initialize-agent" }>): void {
    const frame = this._frames.get(effect.frameGeneration);
    if (!this._isActiveLoadingFrame(frame) || frame.phase !== "loading" || frame.window === null) {
      throw new Error("agent initialization does not identify an owned loading frame");
    }
    if (effect.adapter !== frame.adapter) {
      throw new Error("agent initialization does not match the owned frame adapter");
    }
    frame.phase = "agent-initializing";
    frame.readinessTimer = setTimeout(
      () => this._readinessTimedOut(frame),
      AGENT_READINESS_TIMEOUT_MS,
    );
    postFrameMessage(
      frame.window,
      this._frameProfile,
      buildAgentInitialize(
        frame.session,
        frame.adapter,
        this._agentConfiguration(),
        this._diagnostics !== null,
        frame.role,
        this._documentObservation,
      ),
    );
  }

  protected _readinessTimedOut(frame: OwnedFrame): void {
    if (!this._isActiveLoadingFrame(frame) || frame.phase !== "agent-initializing") return;
    try {
      this._accepted(
        this._dispatchAndApply(
          adapterInput({ type: "readiness-timeout", generation: frame.frameGeneration }),
        ),
      );
    } catch (cause) {
      this._handleBoundaryFailure(cause);
    }
  }

  protected _participantForFrame(frame: OwnedFrame): ActiveDocumentParticipant | null {
    const snapshot = this._kernel.snapshot();
    const primary = primaryParticipant(snapshot);
    if (
      frame === this._committed &&
      primary !== null &&
      currentFrame(snapshot)?.generation === frame.frameGeneration &&
      frame.documentGeneration === primary.documentGeneration
    ) {
      return primary;
    }
    const companion = fixedCompanionParticipant(snapshot);
    return frame === this._companion &&
      companion !== null &&
      companion.frameGeneration === frame.frameGeneration
      ? companion
      : null;
  }

  protected _frameForParticipant(participant: ActiveDocumentParticipant): OwnedFrame | null {
    const frame = participant.kind === "primary" ? this._committed : this._companion;
    return frame !== null && participantsEqual(this._participantForFrame(frame), participant)
      ? frame
      : null;
  }

  protected _frameForLayoutOwner(
    frame: OwnedFrame | undefined,
    owner: LayoutOwner,
  ): OwnedFrame | null {
    if (frame === undefined) return null;
    if (owner.kind === "prepared-frame") {
      return frame.role === "prepared" && frame.phase === "presentation-initializing"
        ? frame
        : null;
    }
    if (owner.kind === "fixed-companion") {
      const participant = layoutOwnerParticipant(owner);
      return frame === this._companion &&
        frame.phase === "committed" &&
        participant !== null &&
        participantsEqual(participant, this._participantForFrame(frame))
        ? frame
        : null;
    }
    return owner.phase === "initial"
      ? frame === this._pending &&
        frame.phase === "presentation-initializing" &&
        frame.documentGeneration === owner.documentGeneration
        ? frame
        : null
      : frame === this._committed &&
          frame.phase === "committed" &&
          frame.documentGeneration === owner.documentGeneration
        ? frame
        : null;
  }

  protected _clearReadinessTimer(frame: OwnedFrame): void {
    if (frame.readinessTimer !== null) clearTimeout(frame.readinessTimer);
    frame.readinessTimer = null;
  }

  protected _commitFrame(frame: OwnedFrame): void {
    if (!this._isCurrentPending(frame) || frame.phase !== "presentation-initializing") {
      throw new Error("document commit does not identify the pending presentation frame");
    }
    const outgoing = this._committed;
    this._pending = null;
    this._committed = frame;
    this._fixedPan = { x: 0, y: 0 };
    frame.documentGeneration = this._kernel.snapshot().document.committed?.generation ?? null;
    frame.role = this._role;
    frame.phase = "committed";
    this._recordFrameTerminal(frame, "committed", "complete");
    frame.iframe.dataset.epubNavigatorParticipant = "primary";
    this._applyFixedViewTransform(frame);
    this._activateCommittedPrimary(frame, outgoing);
  }

  protected _frameFailed(frame: OwnedFrame, reason: FrameFailureReason): void {
    if (!this._isActiveLoadingFrame(frame)) return;
    const stage =
      this._fixedSpreadStage?.companionOccurrence === frame.occurrence
        ? this._fixedSpreadStage
        : null;
    if (frame.role === "prepared") this._releasePreparationClaim(frame.occurrence, false);
    this._recordFrameTerminal(frame, "failed", normalizeFrameFailureReason(reason));
    this._cancelFrame(frame.frameGeneration);
    this._reportFrameFailure(frame.frameGeneration, reason);
    if (stage !== null) this._fallbackFixedSpread(stage);
  }

  protected _reportFrameFailure(frameGeneration: number, reason: FrameFailureReason): void {
    try {
      this._accepted(
        this._dispatchAndApply(frameInput({ type: "failed", generation: frameGeneration, reason })),
      );
    } catch (cause) {
      this._handleBoundaryFailure(cause);
    }
  }

  protected _cancelFrame(frameGeneration: number): void {
    const frame = this._frames.get(frameGeneration);
    const companionActivation = this._pendingCompanionActivation;
    if (companionActivation?.target.frameGeneration === frameGeneration) {
      if (companionActivation.queued !== null) companionActivation.queued.complete = true;
      this._pendingCompanionActivation = null;
    }
    if (this._companion === frame) this._companion = null;
    const promotion = this._pendingPromotion;
    if (promotion?.target.frameGeneration === frameGeneration) {
      clearTimeout(promotion.timer);
      this._pendingPromotion = null;
      this._settlePromotionPublication(promotion);
    }
    if (frame !== undefined) {
      for (const [operationId, operation] of this._locatorOperations) {
        if (operation.frameGeneration === frameGeneration) {
          this._cancelLocatorOperation(frame, operationId, operation);
        }
      }
      for (const operation of this._layoutOperations.values()) {
        if (operation.frameGeneration === frameGeneration)
          this._cancelLayoutOperation(frame, operation);
      }
      this._cancelTocOperationsForFrame(frame);
    }
    for (const operation of this._layoutOperations.values()) {
      if (operation.frameGeneration !== frameGeneration) continue;
      clearTimeout(operation.timer);
      this._layoutOperations.delete(operation.operation);
    }
    if (frame?.documentGeneration !== null && frame?.documentGeneration !== undefined) {
      this._clearTocOperationsForGeneration(frame.documentGeneration);
      this._clearObservationOperationsForGeneration(frame.documentGeneration);
    }
    if (frame === undefined) return;
    this._recordFrameTerminal(frame, "cancelled", this._closed ? "closed" : "superseded");
    if (this._pending === frame) this._pending = null;
    if (this._committed === frame) {
      this._releasedCommitted = { occurrence: frame.occurrence, adapter: frame.adapter };
      this._committed = null;
    }
    this._removeFrame(frame);
  }

  protected _isCurrentPending(frame: OwnedFrame | undefined): frame is OwnedFrame {
    return (
      frame !== undefined &&
      !this._closed &&
      this._pending === frame &&
      frame.iframe.contentWindow === frame.window &&
      frame.window !== null
    );
  }

  protected _isActiveLoadingFrame(frame: OwnedFrame | undefined): frame is OwnedFrame {
    return (
      frame !== undefined &&
      !this._closed &&
      (this._pending === frame || frame.role === "prepared") &&
      frame.iframe.contentWindow === frame.window &&
      frame.window !== null
    );
  }

  protected _removeFrame(frame: OwnedFrame | null): void {
    if (frame === null) return;
    this._clearReadinessTimer(frame);
    frame.controller.abort();
    this._frames.delete(frame.frameGeneration);
    const window = frame.window;
    if (
      this._closed ||
      frame.invalidated ||
      frame.phase !== "committed" ||
      window === null ||
      frame.iframe.contentWindow !== window
    ) {
      this._discardFrameElement(frame.iframe);
      return;
    }
    // A touch that started in this frame must end inside it, or the browser keeps that pointer
    // active for the rest of the page; the agent answers `released` once no touch is active.
    this._hideFrame(frame);
    frame.iframe.dataset.epubNavigatorParticipant = "retired";
    this._retiringFrames.set(window, {
      iframe: frame.iframe,
      timer: setTimeout(() => this._releaseRetiringFrame(window), FRAME_RELEASE_TIMEOUT_MS),
    });
    postFrameMessage(window, this._frameProfile, buildAgentRelease(frame.session));
  }

  protected _releaseRetiringFrame(window: Window): void {
    const retiring = this._retiringFrames.get(window);
    if (retiring === undefined) return;
    clearTimeout(retiring.timer);
    this._retiringFrames.delete(window);
    this._discardFrameElement(retiring.iframe);
  }

  private _discardFrameElement(iframe: HTMLIFrameElement): void {
    iframe.remove();
    iframe.removeAttribute("src");
  }

  protected _recordFrameTerminal(
    frame: OwnedFrame,
    outcome: "committed" | "prepared" | "failed" | "cancelled",
    reason: Extract<NavigatorDiagnosticEvent, { type: "frame-lifecycle" }>["reason"],
  ): void {
    if (frame.diagnosticsTerminal) return;
    frame.diagnosticsTerminal = true;
    const terminal = this._now();
    const duration = (start: number, end: number): number => Math.max(0, end - start);
    this._record({
      type: "frame-lifecycle",
      action: "terminal",
      frameGeneration: frame.frameGeneration,
      occurrence: frame.occurrence,
      role: frame.role,
      outcome,
      reason,
      ...(frame.diagnosticsLoadedAt === null
        ? {}
        : { createToLoadMs: duration(frame.diagnosticsCreatedAt, frame.diagnosticsLoadedAt) }),
      ...(frame.diagnosticsLoadedAt === null || frame.diagnosticsAgentReadyAt === null
        ? {}
        : {
            loadToAgentReadyMs: duration(frame.diagnosticsLoadedAt, frame.diagnosticsAgentReadyAt),
          }),
      ...(frame.diagnosticsAgentReadyAt === null || outcome === "prepared"
        ? {}
        : { agentReadyToCommitMs: duration(frame.diagnosticsAgentReadyAt, terminal) }),
      createToTerminalMs: duration(frame.diagnosticsCreatedAt, terminal),
    });
  }

  protected _removeAllFrames(): void {
    this._frameStackResizeObserver?.disconnect();
    this._clearFixedSpreadStage();
    this._companion = null;
    for (const frame of this._frames.values()) {
      for (const [operationId, operation] of this._locatorOperations) {
        if (operation.frameGeneration === frame.frameGeneration) {
          this._cancelLocatorOperation(frame, operationId, operation);
        }
      }
      for (const operation of this._layoutOperations.values()) {
        if (operation.frameGeneration === frame.frameGeneration) {
          this._cancelLayoutOperation(frame, operation);
        }
      }
      for (const [operationId, operation] of this._tocOperations) {
        if (operation.frameGeneration === frame.frameGeneration) {
          this._cancelTocOperation(frame, operationId, operation);
        }
      }
    }
    this._clearAllLayoutOperations();
    this._clearAllTocOperations();
    for (const frame of this._frames.values()) {
      this._recordFrameTerminal(frame, "cancelled", this._closed ? "closed" : "superseded");
      this._removeFrame(frame);
    }
    for (const window of [...this._retiringFrames.keys()]) this._releaseRetiringFrame(window);
    this._pending = null;
    this._committed = null;
    this._frameStack.remove();
    this._messageController.abort();
    this._selectionListeners.clear();
  }

  protected _invalidateUnexpectedNavigation(frame: OwnedFrame): void {
    if (this._closed) return;
    frame.invalidated = true;
    const participant = this._participantForFrame(frame);
    if (participant !== null) {
      try {
        this._accepted(
          this._dispatchAndApply(
            adapterInput({
              type: "document-invalidated",
              participant,
              generation: frame.frameGeneration,
              reason: "unexpected-navigation",
            }),
          ),
        );
      } catch (cause) {
        this._handleBoundaryFailure(cause);
      }
      return;
    }
    if (frame.role === "prepared") {
      this._frameFailed(frame, { reason: "unexpected-navigation" });
      return;
    }
  }
}

function normalizeFrameFailureReason(
  failure: FrameFailureReason,
): Extract<NavigatorDiagnosticEvent, { type: "frame-lifecycle" }>["reason"] {
  if (failure.reason === "reflowable-layout-conflict" || failure.reason === "fixed-layout-conflict")
    return "layout-conflict";
  if (
    failure.reason === "reflowable-layout-unavailable" ||
    failure.reason === "fixed-layout-unavailable"
  )
    return "layout-unavailable";
  return failure.reason;
}
