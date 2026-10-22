import { DocumentObservationRuntime } from "../measurements/document-observation.js";
import { type FixedViewState, type FixedViewPoint } from "../navigator/api.js";
import { type OwnedFrame } from "../navigator/runtime-types.js";
import { isFixedAdapter, participantsEqual } from "../navigator/runtime-support.js";
import type {
  FixedIntrinsicViewport,
  FixedPageGeometry,
  FixedSpreadPlacement,
} from "../../generated/kernel.js";
import { postFrameMessage } from "../agent/transport.js";
import { adapterInput } from "../kernel.js";
import { currentDocument, fixedCompanionDocument, fixedSpreadPlan } from "../kernel-view.js";
import {
  buildAgentFixedViewportApplied,
  buildAgentFixedViewportUnavailable,
} from "../agent-protocol/index.js";
import { fixedPageGeometry } from "./geometry.js";

export abstract class FixedViewRuntime extends DocumentObservationRuntime {
  fixedViewState(): FixedViewState | null {
    const frame = this._committed;
    return frame !== null && isFixedAdapter(frame.adapter) && frame.fixedGeometry !== null
      ? this._fixedViewState(frame.fixedGeometry)
      : null;
  }

  protected _fixedViewState(geometry: FixedPageGeometry): FixedViewState {
    const frame = this._committed;
    if (frame === null) throw new Error("fixed view state requires the primary frame");
    const transform = this._fixedTransform(frame, geometry, this._fixedZoom, this._fixedPan);
    return {
      zoom: this._fixedZoom,
      minimumZoom: 1,
      maximumZoom: 4,
      panX: transform.panX,
      panY: transform.panY,
    };
  }

  setFixedZoom(zoom: number, focalPoint?: FixedViewPoint): FixedViewState | null {
    this._assertOpen();
    const frame = this._committed;
    const geometry = frame !== null && isFixedAdapter(frame.adapter) ? frame.fixedGeometry : null;
    if (frame === null || frame === undefined || geometry === null || !Number.isFinite(zoom)) {
      return null;
    }
    const previousZoom = this._fixedZoom;
    const nextZoom = Math.min(4, Math.max(1, zoom));
    if (nextZoom === previousZoom) return this._fixedViewState(geometry);

    const previous = this._fixedTransform(frame, geometry, previousZoom, this._fixedPan);
    const defaultFocal = this._fixedCompositionCenter(previousZoom, {
      x: previous.panX,
      y: previous.panY,
    });
    const focal =
      focalPoint === undefined || !Number.isFinite(focalPoint.x) || !Number.isFinite(focalPoint.y)
        ? defaultFocal
        : {
            x: previous.offsetX + focalPoint.x * previous.scale,
            y: previous.offsetY + focalPoint.y * previous.scale,
          };
    const intrinsic = {
      x: (focal.x - previous.offsetX) / previous.scale,
      y: (focal.y - previous.offsetY) / previous.scale,
    };
    const centered = this._fixedTransform(frame, geometry, nextZoom, { x: 0, y: 0 });
    this._fixedZoom = nextZoom;
    this._fixedPan = {
      x: focal.x - intrinsic.x * centered.scale - centered.offsetX,
      y: focal.y - intrinsic.y * centered.scale - centered.offsetY,
    };
    this._applyActiveFixedViewTransforms();
    this._refreshCapturedSelectionGeometry();
    return this._fixedViewState(geometry);
  }

  panFixedBy(delta: FixedViewPoint, intrinsic = false): FixedViewState | null {
    this._assertOpen();
    const frame = this._committed;
    const geometry = frame !== null && isFixedAdapter(frame.adapter) ? frame.fixedGeometry : null;
    if (
      frame === null ||
      frame === undefined ||
      geometry === null ||
      !Number.isFinite(delta.x) ||
      !Number.isFinite(delta.y)
    ) {
      return null;
    }
    const multiplier = intrinsic ? geometry.scale * this._fixedZoom : 1;
    this._fixedPan = {
      x: this._fixedPan.x + delta.x * multiplier,
      y: this._fixedPan.y + delta.y * multiplier,
    };
    this._applyActiveFixedViewTransforms();
    this._refreshCapturedSelectionGeometry();
    return this._fixedViewState(geometry);
  }

  protected _applyFixedViewport(
    frame: OwnedFrame,
    operation: number,
    intrinsicViewport: FixedIntrinsicViewport,
  ): void {
    const layout = this._layoutOperations.get(operation);
    const ownsFrame =
      layout?.frameGeneration === frame.frameGeneration &&
      isFixedAdapter(frame.adapter) &&
      layout.adapter === frame.adapter &&
      ((layout.phase === "initial" &&
        frame === this._pending &&
        frame.phase === "presentation-initializing") ||
        (layout.phase === "update" && frame === this._committed && frame.phase === "committed") ||
        (layout.participant?.kind === "fixed-companion" &&
          frame === this._companion &&
          frame.phase === "committed" &&
          participantsEqual(layout.participant, this._participantForFrame(frame))) ||
        (layout.phase === "prepared" &&
          frame.role === "prepared" &&
          frame.phase === "presentation-initializing"));
    if (!ownsFrame || frame.window === null || frame.iframe.contentWindow !== frame.window) return;

    const geometry = this._setFixedViewportGeometry(frame, intrinsicViewport);
    if (geometry === null) {
      postFrameMessage(
        frame.window,
        this._frameProfile,
        buildAgentFixedViewportUnavailable(frame.session, operation),
      );
      return;
    }
    frame.fixedViewport = intrinsicViewport;
    postFrameMessage(
      frame.window,
      this._frameProfile,
      buildAgentFixedViewportApplied(frame.session, operation, geometry),
    );
  }

  protected _setFixedViewportGeometry(
    frame: OwnedFrame,
    intrinsicViewport: FixedIntrinsicViewport,
  ): FixedPageGeometry | null {
    const slot = this._fixedSlot(frame);
    const containingWidth = slot.width;
    const containingHeight = this._fixedContainingHeight();
    const geometry = fixedPageGeometry(intrinsicViewport, containingWidth, containingHeight);
    if (geometry === null) return null;
    frame.fixedGeometry = geometry;
    frame.iframe.style.inset = "auto";
    frame.iframe.style.left = "0";
    frame.iframe.style.top = "0";
    frame.iframe.style.width = `${intrinsicViewport.width}px`;
    frame.iframe.style.height = `${intrinsicViewport.height}px`;
    frame.iframe.style.touchAction = "none";
    frame.iframe.style.transformOrigin = "0 0";
    this._applyFixedViewTransform(frame);
    return geometry;
  }

  protected _fixedContainingHeight(): number {
    return this._frameStack.clientHeight;
  }

  protected _applyFixedViewTransform(frame: OwnedFrame): void {
    const geometry = frame.fixedGeometry;
    if (geometry === null) return;
    const transform = this._fixedTransform(frame, geometry, this._fixedZoom, this._fixedPan);
    this._fixedPan = { x: transform.panX, y: transform.panY };
    frame.iframe.style.cursor = this._fixedZoom > 1 ? "grab" : "auto";
    frame.iframe.style.transform = `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`;
  }

  protected _fixedTransform(
    frame: OwnedFrame,
    geometry: FixedPageGeometry,
    zoom: number,
    pan: FixedViewPoint,
  ): {
    readonly scale: number;
    readonly offsetX: number;
    readonly offsetY: number;
    readonly panX: number;
    readonly panY: number;
  } {
    const scale = geometry.scale * zoom;
    const width = geometry.intrinsicViewport.width * scale;
    const height = geometry.intrinsicViewport.height * scale;
    const base = this._fixedBaseOffset(frame, geometry, width, height);
    const clamped = this._clampFixedPan(zoom, pan);
    return {
      scale,
      offsetX: base.x + clamped.x,
      offsetY: base.y + clamped.y,
      panX: clamped.x,
      panY: clamped.y,
    };
  }

  protected _fixedSlot(frame: OwnedFrame): {
    readonly x: number;
    readonly width: number;
    readonly placement: FixedSpreadPlacement;
  } {
    const width = this._frameStack.clientWidth;
    const snapshot = this._kernel.snapshot();
    const companion = fixedCompanionDocument(snapshot);
    let placement: FixedSpreadPlacement | null = null;
    if (frame === this._companion && companion?.frame.generation === frame.frameGeneration) {
      placement = companion.placement;
    } else {
      placement =
        fixedSpreadPlan(
          snapshot,
          frame.occurrence,
          this._frameStackSize.width,
          this._frameStackSize.height,
        )?.primaryPlacement ?? null;
    }
    if (placement === null || placement === "center") {
      frame.iframe.dataset.epubNavigatorPlacement = "center";
      return { x: 0, width, placement: "center" };
    }
    const half = width / 2;
    frame.iframe.dataset.epubNavigatorPlacement = placement;
    return { x: placement === "left" ? 0 : half, width: half, placement };
  }

  protected _applyReflowableSlotGeometry(frame: OwnedFrame): boolean {
    const previous = frame.iframe.dataset.epubNavigatorPlacement ?? "center";
    const slot = this._fixedSlot(frame);
    if (slot.placement === "center") {
      if (previous === "center") return false;
      frame.iframe.style.inset = "0";
      frame.iframe.style.width = "100%";
      frame.iframe.style.height = "100%";
      return true;
    }
    const changed =
      previous !== slot.placement ||
      frame.iframe.style.left !== `${slot.x}px` ||
      frame.iframe.style.width !== `${slot.width}px`;
    frame.iframe.style.position = "absolute";
    frame.iframe.style.inset = "auto";
    frame.iframe.style.left = `${slot.x}px`;
    frame.iframe.style.top = "0";
    frame.iframe.style.width = `${slot.width}px`;
    frame.iframe.style.height = "100%";
    return changed;
  }

  protected _spreadPaired(): boolean {
    return this._committed?.phase === "committed" && this._companion?.phase === "committed";
  }

  protected _activeFixedFrames(): OwnedFrame[] {
    return [this._committed, this._companion].filter(
      (frame): frame is OwnedFrame =>
        frame !== null && frame.phase === "committed" && frame.fixedGeometry !== null,
    );
  }

  protected _fixedBaseOffset(
    frame: OwnedFrame,
    geometry: FixedPageGeometry,
    width: number,
    height: number,
  ): FixedViewPoint {
    const slot = this._fixedSlot(frame);
    const paired = this._spreadPaired();
    const x =
      paired && slot.placement === "left"
        ? slot.x + slot.width - width
        : paired && slot.placement === "right"
          ? slot.x
          : slot.x + (slot.width - width) / 2;
    return {
      x,
      y: (geometry.containingViewport.height - height) / 2,
    };
  }

  protected _clampFixedPan(zoom: number, pan: FixedViewPoint): FixedViewPoint {
    const boxes = this._fixedBaseBoxes(zoom);
    if (boxes.length === 0) return { x: 0, y: 0 };
    const viewportWidth = this._frameStack.clientWidth;
    const viewportHeight = this._frameStack.clientHeight;
    const left = Math.min(...boxes.map((box) => box.left));
    const right = Math.max(...boxes.map((box) => box.right));
    const top = Math.min(...boxes.map((box) => box.top));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    return {
      x:
        right - left <= viewportWidth ? 0 : Math.min(-left, Math.max(viewportWidth - right, pan.x)),
      y:
        bottom - top <= viewportHeight
          ? 0
          : Math.min(-top, Math.max(viewportHeight - bottom, pan.y)),
    };
  }

  protected _fixedBaseBoxes(zoom: number): readonly {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  }[] {
    return this._activeFixedFrames().map((frame) => {
      const geometry = frame.fixedGeometry!;
      const width = geometry.intrinsicViewport.width * geometry.scale * zoom;
      const height = geometry.intrinsicViewport.height * geometry.scale * zoom;
      const base = this._fixedBaseOffset(frame, geometry, width, height);
      return {
        left: base.x,
        right: base.x + width,
        top: base.y,
        bottom: base.y + height,
      };
    });
  }

  protected _fixedCompositionCenter(zoom: number, pan: FixedViewPoint): FixedViewPoint {
    const boxes = this._fixedBaseBoxes(zoom);
    if (boxes.length === 0) {
      return { x: this._frameStack.clientWidth / 2, y: this._frameStack.clientHeight / 2 };
    }
    const left = Math.min(...boxes.map((box) => box.left));
    const right = Math.max(...boxes.map((box) => box.right));
    const top = Math.min(...boxes.map((box) => box.top));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    return {
      x: (left + right) / 2 + pan.x,
      y: (top + bottom) / 2 + pan.y,
    };
  }

  protected _applyActiveFixedViewTransforms(): void {
    for (const frame of this._activeFixedFrames()) this._applyFixedViewTransform(frame);
  }

  protected _recomputeActiveFixedGeometry(): void {
    for (const frame of [this._committed, this._companion]) {
      if (frame === null) continue;
      if (frame.fixedViewport !== null) this._setFixedViewportGeometry(frame, frame.fixedViewport);
      else if (frame.adapter === "reflowable-xhtml") this._applyReflowableSlotGeometry(frame);
    }
    this._applyActiveFixedViewTransforms();
  }

  protected _invalidateActiveFixedViewports(): void {
    for (const frame of [this._committed, this._companion]) {
      if (frame?.fixedViewport === null || frame?.fixedViewport === undefined) continue;
      const participant = this._participantForFrame(frame);
      if (participant === null) continue;
      try {
        this._accepted(
          this._dispatchAndApply(
            adapterInput({
              type: "layout-invalidated",
              participant,
              generation: frame.frameGeneration,
              cause: "viewport",
            }),
          ),
        );
      } catch (cause) {
        this._handlePublicationMessageFailure(cause);
      }
    }
  }

  protected _scheduleFixedViewportResize(): void {
    if (this._closed || this._frameStackResizeScheduled) return;
    this._frameStackResizeScheduled = true;
    requestAnimationFrame(() => {
      this._frameStackResizeScheduled = false;
      if (this._closed) return;
      const size = {
        width: this._frameStack.clientWidth,
        height: this._frameStack.clientHeight,
      };
      if (
        size.width === this._frameStackSize.width &&
        size.height === this._frameStackSize.height
      ) {
        return;
      }
      this._frameStackSize = size;
      const stage = this._fixedSpreadStage;
      const snapshot = this._kernel.snapshot();
      const primary = currentDocument(snapshot);
      const plan =
        primary === null
          ? null
          : fixedSpreadPlan(snapshot, primary.frame.occurrence, size.width, size.height);
      const suppression = this._fixedSpreadSuppression;
      if (
        suppression?.reason === "resize" &&
        suppression.documentGeneration === primary?.generation &&
        suppression.companionOccurrence !== plan?.companionOccurrence
      ) {
        this._fixedSpreadSuppression = null;
      }
      if (stage !== null) {
        const stagePlan = this._fixedSpreadPlan(
          snapshot,
          stage.primary.occurrence,
          size.width,
          size.height,
          stage.companionOccurrence,
        );
        if (stagePlan === null || stagePlan.companionOccurrence === null) {
          this._clearFixedSpreadStage();
          this._showFrame(stage.primary);
        } else {
          stage.viewportInvalidated = true;
        }
      }
      const frames = [...this._frames.values()].filter(
        (frame) =>
          frame.fixedViewport !== null &&
          ((frame === this._pending && frame.phase === "presentation-initializing") ||
            (frame === this._committed && frame.phase === "committed") ||
            (frame === this._companion && frame.phase === "committed") ||
            (frame.role === "prepared" &&
              (frame.phase === "presentation-initializing" || frame.phase === "prepared"))),
      );
      for (const frame of frames) {
        const viewport = frame.fixedViewport;
        if (viewport === null || this._setFixedViewportGeometry(frame, viewport) === null) continue;
        try {
          if (frame.role === "prepared") this._releasePreparationClaim(frame.occurrence, false);
          this._accepted(
            this._dispatchAndApply(
              adapterInput({
                type: "layout-invalidated",
                participant: this._participantForFrame(frame),
                generation: frame.frameGeneration,
                cause: "viewport",
              }),
            ),
          );
        } catch (cause) {
          this._handlePublicationMessageFailure(cause);
        }
      }
      for (const frame of [this._committed, this._companion]) {
        if (frame?.adapter === "reflowable-xhtml" && frame.phase === "committed") {
          this._applyReflowableSlotGeometry(frame);
        }
      }
      this._coordinateFixedSpread();
      this._scheduleAdjacentPreparation();
    });
  }
}
