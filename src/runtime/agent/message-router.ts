import { AgentResultRuntime } from "./result-router.js";
import {
  type FixedViewPoint,
  type NavigatorInteraction,
  type NavigatorDecorationActivation,
} from "../navigator/api.js";
import { participantsEqual } from "../navigator/runtime-support.js";
import type { AgentOperationKind } from "../../generated/kernel.js";
import { isExpectedFrameMessage } from "./transport.js";
import { adapterInput } from "../kernel.js";
import {
  normalizeAgentActivity,
  normalizeAgentActivation,
  normalizeAgentFormSubmission,
  normalizeAgentDecorationActivation,
  normalizeAgentAdvancePresentationResult,
  normalizeAgentFixedViewInteraction,
  normalizeAgentInteraction,
  normalizeAgentFixedViewport,
  normalizeAgentFontEvidence,
  normalizeAgentFootnoteReturned,
  normalizeAgentLayoutInvalidated,
  normalizeAgentLayoutResult,
  normalizeAgentObservation,
  normalizeAgentPaginationDiagnostic,
  normalizeAgentReady,
  normalizeAgentResult,
  normalizeAgentReleased,
  normalizeAgentRoleChanged,
  normalizeAgentSelectionChanged,
  normalizeAgentDocumentObservationResult,
  normalizeAgentTocTargetsResult,
} from "../agent-protocol/index.js";

export abstract class AgentMessageRouterRuntime extends AgentResultRuntime {
  protected _agentMessage(event: MessageEvent<unknown>): void {
    const source = event.source;
    if (source === null || !("window" in source)) return;
    if (this._retiringFrames.has(source)) {
      if (
        isExpectedFrameMessage(event, source, this._frameProfile) &&
        normalizeAgentReleased(event, source) !== null
      ) {
        this._releaseRetiringFrame(source);
      }
      return;
    }
    const pending = this._pending;
    const committed = this._committed;
    const frame = [...this._frames.values()].find((candidate) => candidate.window === source);
    if (frame === undefined || frame.iframe.contentWindow !== source) return;
    if (!isExpectedFrameMessage(event, source, this._frameProfile)) return;

    const roleChanged = normalizeAgentRoleChanged(event, source, frame.session);
    if (roleChanged !== null) {
      this._acknowledgeRoleChange(frame, roleChanged.role, roleChanged.roleChange);
      return;
    }

    const paginationDiagnostic = normalizeAgentPaginationDiagnostic(event, source, frame.session);
    if (paginationDiagnostic !== null) {
      const layout = [...this._layoutOperations.values()].find(
        (candidate) => candidate.frameGeneration === frame.frameGeneration,
      );
      this._record({
        type: "layout-phase",
        role: frame.role,
        frameGeneration: frame.frameGeneration,
        operation: layout?.operation ?? null,
        phase: paginationDiagnostic.phase,
        durationMs: paginationDiagnostic.durationMs,
        scanCount: paginationDiagnostic.scanCount,
        rectangleCount: paginationDiagnostic.rectangleCount,
      });
      return;
    }

    const fontEvidence = normalizeAgentFontEvidence(event, source, frame.session);
    if (fontEvidence !== null) {
      this._record({
        type: "font-evidence",
        target: fontEvidence.target,
        family: fontEvidence.family,
        frameGeneration: frame.frameGeneration,
        configured: fontEvidence.configured,
        declared: fontEvidence.declared,
        loaded: fontEvidence.loaded,
        check: fontEvidence.check,
      });
      return;
    }

    const fixedViewport = normalizeAgentFixedViewport(event, source, frame.session);
    if (fixedViewport !== null) {
      try {
        this._applyFixedViewport(frame, fixedViewport.operation, fixedViewport.intrinsicViewport);
      } catch (cause) {
        const layout = this._layoutOperations.get(fixedViewport.operation);
        if (layout !== undefined) {
          this._reportLayoutDeliveryFailure(
            layout.operation,
            layout.frameGeneration,
            layout.layoutGeneration,
            cause instanceof Error ? cause.message : "fixed viewport application failed",
          );
        }
      }
      return;
    }

    if (frame.phase === "agent-initializing") {
      const ready = normalizeAgentReady(event, source, frame.session);
      if (ready === null) return;
      if (ready.adapter !== frame.adapter) {
        this._frameFailed(frame, {
          reason: "effect-execution-failed",
          message: "the content agent initialized an unexpected document adapter",
        });
        return;
      }
      const supportedOperations = ready.supportedOperations.filter(
        (operation): operation is AgentOperationKind =>
          operation === "resolve-locator" ||
          operation === "relocate" ||
          operation === "resolve-annotation-target" ||
          operation === "relocate-annotation-target" ||
          operation === "capture-selection" ||
          operation === "capture-current-location" ||
          operation === "generate-annotation-target" ||
          operation === "generate-current-location-annotation-target" ||
          operation === "reconcile-decorations" ||
          operation === "adjust-annotation-range" ||
          operation === "advance-presentation" ||
          operation === "find-media-overlay-entry",
      );
      try {
        const transition = this._kernel.dispatch(
          adapterInput({
            type: "ready",
            generation: frame.frameGeneration,
            supportedOperations,
          }),
        );
        this._accepted(transition);
        frame.diagnosticsAgentReadyAt ??= this._now();
        this._clearReadinessTimer(frame);
        this._applyTransition(transition, () => {
          frame.phase = "presentation-initializing";
        });
      } catch (cause) {
        this._handlePublicationMessageFailure(cause);
      }
      return;
    }

    const observationResult = normalizeAgentDocumentObservationResult(event, source, frame.session);
    if (observationResult !== null) {
      const operation = this._observationOperations.get(observationResult.operation);
      if (operation?.frameGeneration === frame.frameGeneration) {
        this._releaseObservationOperation(observationResult.operation, operation);
        operation.finish(observationResult.observation);
      }
      return;
    }

    const tocResult = normalizeAgentTocTargetsResult(event, source, frame.session);
    if (tocResult !== null) {
      const operation = this._tocOperations.get(tocResult.operation);
      const identities = new Set(
        tocResult.results.map((result) => `${result.listIndex}:${result.pointPath.join("/")}`),
      );
      if (
        operation?.frameGeneration === frame.frameGeneration &&
        identities.size === operation.identities.size &&
        [...identities].every((identity) => operation.identities.has(identity))
      ) {
        const layoutSuperseded = !this._tocOperationIsCurrent(frame, operation);
        if (layoutSuperseded) this._cancelTocOperation(frame, tocResult.operation, operation);
        this._releaseTocOperation(tocResult.operation, operation);
        if (layoutSuperseded) {
          operation.fail(new Error("the TOC target layout was superseded"));
        } else if (
          tocResult.results.some(
            (result) =>
              result.result.state === "located" &&
              result.result.physicalPage >= operation.pageCount,
          )
        ) {
          operation.fail(new Error("a TOC target page is outside the committed layout"));
        } else {
          if (operation.generation !== null) {
            this._record({
              type: "operation-owner",
              action: "complete",
              operationKind: "toc",
              operation: tocResult.operation,
              documentGeneration: operation.generation,
              layoutGeneration: operation.layoutGeneration,
            });
          }
          operation.finish(tocResult.results);
        }
      }
      return;
    }

    const result = normalizeAgentResult(event, source, frame.session);
    if (result !== null) {
      this._acceptLocatorResult(frame, result);
      return;
    }

    const advanceResult = normalizeAgentAdvancePresentationResult(event, source, frame.session);
    if (advanceResult !== null) {
      this._acceptLocatorResult(frame, advanceResult);
      return;
    }

    const layoutResult = normalizeAgentLayoutResult(event, source, frame.session);
    if (layoutResult !== null) {
      this._acceptLayoutResult(frame, layoutResult);
      return;
    }

    const invalidated = normalizeAgentLayoutInvalidated(event, source, frame.session);
    if (invalidated !== null) {
      const activation = this._pendingCompanionActivation;
      if (activation?.target === frame) {
        this._deferCompanionInvalidation(activation, invalidated.cause);
        return;
      }
      const participant = this._participantForFrame(frame);
      if (
        (frame === pending && frame.phase === "presentation-initializing") ||
        (frame === committed && frame.phase === "committed") ||
        (frame === this._companion && frame.phase === "committed") ||
        (frame !== this._companion &&
          frame.role === "prepared" &&
          (frame.phase === "presentation-initializing" ||
            frame.phase === "prepared" ||
            frame.phase === "promotion-acknowledging"))
      ) {
        try {
          if (frame.role === "prepared") this._releasePreparationClaim(frame.occurrence, false);
          this._accepted(
            this._dispatchAndApply(
              adapterInput({
                type: "layout-invalidated",
                participant,
                generation: frame.frameGeneration,
                cause: invalidated.cause,
              }),
            ),
          );
        } catch (cause) {
          this._handlePublicationMessageFailure(cause);
        }
      }
      return;
    }

    const participant = this._participantForFrame(frame);
    if (participant === null || frame.phase !== "committed" || frame.role !== "foreground") return;

    const activity = normalizeAgentActivity(event, source, frame.session);
    if (activity !== null) {
      this._noteForegroundActivity(
        activity.activity === "presentation" ? "presentation" : undefined,
      );
      if (
        activity.activity === "presentation" &&
        this._role === "foreground" &&
        this._pendingPromotion === null
      ) {
        for (const listener of this._presentationActivityListeners) {
          try {
            listener({ participant });
          } catch {
            // One application observer cannot interrupt other activity observers.
          }
        }
      }
      return;
    }

    const selectionChanged = normalizeAgentSelectionChanged(event, source, frame.session);
    if (selectionChanged !== null) {
      this._noteForegroundActivity();
      if (
        this._role !== "auxiliary" &&
        this._pendingPromotion === null &&
        this._kernel.snapshot().document.pending === null
      ) {
        this._queueSelectionRefresh(participant);
      }
      return;
    }

    const observation = normalizeAgentObservation(event, source, frame.session);
    if (observation !== null) {
      try {
        this._accepted(
          this._dispatchAndApply(
            adapterInput({
              type: "document-observed",
              participant,
              generation: frame.frameGeneration,
              observation: {
                writingMode: observation.writingMode,
                direction: observation.direction,
                language: observation.language,
                viewport: observation.viewport,
                canvas: observation.canvas,
                visibleStart: observation.visibleStart,
                visibleEnd: observation.visibleEnd,
                renderedTextProgression: observation.renderedTextProgression,
                layoutProgression: observation.layoutProgression,
                pagination: observation.pagination,
              },
            }),
          ),
        );
      } catch (cause) {
        this._handlePublicationMessageFailure(cause);
      }
      return;
    }

    const interaction = normalizeAgentInteraction(event, source, frame.session);
    if (interaction !== null) {
      if (this._role === "auxiliary" || this._pendingPromotion !== null) return;
      this._noteForegroundActivity();
      // A touch page-turn while the fixed view is zoomed is a pan that ran out of room, not a
      // request to leave the page. The agent's swipe and page-zone recognisers see the same
      // pointer stream as its pan recogniser and cannot tell the cases apart, because only the
      // reader knows the zoom; a zoomed page is being inspected, and leaving it takes a reset.
      if (
        interaction.source === "touch" &&
        (interaction.command === "next" || interaction.command === "previous") &&
        this._fixedZoom > 1 &&
        this._committed?.fixedGeometry != null
      ) {
        return;
      }
      for (const listener of this._interactionListeners) {
        try {
          listener({
            participant,
            command: interaction.command,
            source: interaction.source,
          });
        } catch {
          // One application observer cannot interrupt other interaction observers.
        }
      }
      return;
    }

    const fixedViewInteraction = normalizeAgentFixedViewInteraction(event, source, frame.session);
    if (fixedViewInteraction !== null) {
      if (this._role === "auxiliary" || this._pendingPromotion !== null) return;
      this._noteForegroundActivity();
      const primary = this._committed;
      const primaryGeometry = primary?.fixedGeometry ?? null;
      const sourceGeometry = frame.fixedGeometry;
      const primaryTransform =
        primary === null || primaryGeometry === null
          ? null
          : this._fixedTransform(primary, primaryGeometry, this._fixedZoom, this._fixedPan);
      const sourceTransform =
        sourceGeometry === null
          ? null
          : this._fixedTransform(frame, sourceGeometry, this._fixedZoom, this._fixedPan);
      const projectFocal = (x: number, y: number): FixedViewPoint =>
        primaryTransform === null || sourceTransform === null
          ? { x, y }
          : {
              x:
                (sourceTransform.offsetX + x * sourceTransform.scale - primaryTransform.offsetX) /
                primaryTransform.scale,
              y:
                (sourceTransform.offsetY + y * sourceTransform.scale - primaryTransform.offsetY) /
                primaryTransform.scale,
            };
      const intrinsicScaleRatio =
        primaryGeometry === null || sourceGeometry === null
          ? 1
          : sourceGeometry.scale / primaryGeometry.scale;
      const projected: NavigatorInteraction =
        fixedViewInteraction.action === "zoom"
          ? {
              participant,
              command: "fixed-zoom",
              source: fixedViewInteraction.source,
              factor: fixedViewInteraction.factor,
              focal: projectFocal(fixedViewInteraction.focalX, fixedViewInteraction.focalY),
            }
          : fixedViewInteraction.action === "pan"
            ? {
                participant,
                command: "fixed-pan",
                source: fixedViewInteraction.source,
                delta: {
                  x: fixedViewInteraction.deltaX * intrinsicScaleRatio,
                  y: fixedViewInteraction.deltaY * intrinsicScaleRatio,
                },
              }
            : { participant, command: "fixed-reset", source: "keyboard" };
      for (const listener of this._interactionListeners) {
        try {
          listener(projected);
        } catch {
          // One application observer cannot interrupt other interaction observers.
        }
      }
      return;
    }

    const decorationActivation = normalizeAgentDecorationActivation(event, source, frame.session);
    if (decorationActivation !== null) {
      if (this._role === "auxiliary" || this._pendingPromotion !== null) return;
      const anchor = this._selectionAnchorInReader(frame, decorationActivation.anchor);
      if (anchor === null) return;
      const projected: NavigatorDecorationActivation = {
        participant,
        projectionRevision: decorationActivation.projectionRevision,
        ids: decorationActivation.ids,
        anchor,
        link: decorationActivation.link,
      };
      if (projected.ids.length === 0) {
        if (this._decorationSnapshot.projection.revision !== projected.projectionRevision) return;
        for (const listener of this._decorationActivationListeners) {
          try {
            listener(projected);
          } catch {
            // Decoration dismissal observers cannot interrupt other observers.
          }
        }
        return;
      }
      if (!this._decorationActivationIsCurrent(projected)) return;
      for (const listener of this._decorationActivationListeners) {
        try {
          listener(projected);
        } catch {
          // Decoration activation observers cannot interrupt other observers.
        }
      }
      return;
    }

    if (this._routeMediaOverlayMessage(event, source, frame)) return;

    const footnoteReturned = normalizeAgentFootnoteReturned(event, source, frame.session);
    if (footnoteReturned !== null) {
      const pending = this._pendingFootnoteReturn;
      if (
        pending === null ||
        pending.participant === null ||
        pending.activationId !== footnoteReturned.activationId ||
        !participantsEqual(pending.participant, participant)
      ) {
        return;
      }
      clearTimeout(pending.timer);
      this._pendingFootnoteReturn = null;
      if (footnoteReturned.status === "returned") this._setActiveFootnote(null);
      pending.resolve({ status: footnoteReturned.status });
      return;
    }

    const formSubmission = normalizeAgentFormSubmission(event, source, frame.session);
    if (formSubmission !== null) {
      if (this._role === "auxiliary" || this._pendingPromotion !== null) {
        return;
      }
      let internal = false;
      try {
        const target = new URL(formSubmission.resolvedUrl);
        const mount = new URL(this._publication.mount.baseUrl);
        internal =
          [null, "", "_self"].includes(formSubmission.target) &&
          target.username.length === 0 &&
          target.password.length === 0 &&
          target.origin === mount.origin &&
          target.pathname.startsWith(mount.pathname);
      } catch {
        // Malformed submissions are external to the mounted publication contract.
      }
      if (internal) return;
      for (const listener of this._externalFormAttemptListeners) {
        try {
          listener({
            participant,
            action: formSubmission.action,
            resolvedUrl: formSubmission.resolvedUrl,
            method: formSubmission.method,
            target: formSubmission.target,
          });
        } catch {
          // Form observers cannot alter publication containment or other observers.
        }
      }
      return;
    }

    const activation = normalizeAgentActivation(event, source, frame.session);
    if (activation === null) return;
    if (this._role === "auxiliary" || this._pendingPromotion !== null) return;
    this._acceptActivationRequest(frame, participant, activation);
  }
}
