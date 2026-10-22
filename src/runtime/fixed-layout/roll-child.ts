import { KernelDriverRuntime } from "../navigator/kernel-driver.js";
import type {
  FixedIntrinsicViewport,
  FixedPageGeometry,
  KernelSnapshot,
} from "../../generated/kernel.js";
import type { OwnedFrame, ActivationRequest } from "../navigator/runtime-types.js";
import type {
  NavigatorLocation,
  AnnotationTargetResolutionPlan,
  ActiveDocumentParticipant,
  KernelTransition,
  AnnotationTargetReconciliationResult,
} from "../../generated/kernel.js";
import { isExpectedFrameMessage, postFrameMessage } from "../agent/transport.js";
import { adapterInput } from "../kernel.js";
import { intersectRectangles } from "../navigator/runtime-support.js";
import {
  ROLL_NAMESPACE,
  ROLL_MAX_DELTA,
  rollIdentity,
  rollRecord,
  boundedRollTarget,
} from "./roll-protocol.js";
import { parseRollTarget } from "./roll-target.js";
import { normalizeAnnotationTargetResult } from "../agent-protocol/codecs/annotation.js";

export interface RollTargetPoint {
  readonly x: number;
  readonly y: number;
  readonly annotation?: AnnotationTargetReconciliationResult | undefined;
}

/** A roll item is a complete trusted runtime, never an extra frame in another kernel. */
export class RollChildRuntime extends KernelDriverRuntime {
  override setPaginationCapabilities(
    capabilities: Parameters<KernelDriverRuntime["setPaginationCapabilities"]>[0],
  ): void {
    // Fixed-page counts need no auxiliary measurement kernels outside the roll budget.
    super.setPaginationCapabilities(
      capabilities === undefined
        ? undefined
        : { ...capabilities, responses: undefined, foregroundPreparation: undefined },
    );
  }
  annotationPlan(targetJson: string) {
    const { target } = parseRollTarget(targetJson);
    // Stack projects selector/refinement arrays. A single W3C object has the same meaning;
    // normalize only the execution input, never the stored/generated target JSON.
    const selectorArray = (value: unknown): unknown[] =>
      (Array.isArray(value) ? value : [value]).map((node) =>
        rollRecord(node) && Object.hasOwn(node, "refinedBy")
          ? { ...node, refinedBy: selectorArray(node.refinedBy) }
          : node,
      );
    return this._kernel.projectAnnotationTarget(
      JSON.stringify(
        Object.hasOwn(target, "selector")
          ? { ...target, selector: selectorArray(target.selector) }
          : target,
      ),
    );
  }
  rollGeometryReady(): boolean {
    if (
      this._closed ||
      this._frameStack.clientWidth <= 0 ||
      this._frameStack.clientHeight <= 0 ||
      this._frameStackSize.width !== this._frameStack.clientWidth ||
      this._frameStackSize.height !== this._frameStack.clientHeight
    )
      return false;
    const document = this._kernel.snapshot().document;
    return document.pending === null && document.committed?.layout.state === "settled";
  }
  onViewport: ((viewport: FixedIntrinsicViewport) => void) | undefined;
  onActivation: ((activation: ActivationRequest) => Promise<void>) | undefined;
  onScroll: ((point: { x: number; y: number }) => void) | undefined;
  onGesture: ((engaged: boolean) => void) | undefined;
  private rollLayoutGeneration: number | undefined;
  private rollFrameGeneration: number | undefined;
  private rollOperation = 0;
  // Cache accepted agent-local coordinates, never a stale reader-space rectangle.
  private rollSelectionAnchor: {
    frame: OwnedFrame;
    anchor: Parameters<KernelDriverRuntime["_selectionAnchorInReader"]>[1];
  } | null = null;

  refreshRollSelectionGeometry(): void {
    const local = this.rollSelectionAnchor;
    const selection = this._selectionSnapshot.selection;
    if (
      this._closed ||
      local === null ||
      local.frame !== this._committed ||
      selection?.status !== "captured" ||
      selection.basis.frameGeneration !== local.frame.frameGeneration
    )
      return;
    const anchor = this._selectionAnchorInReader(local.frame, local.anchor);
    if (anchor !== null) this._publishSelection({ ...selection, anchor });
  }

  override clearSelection(): void {
    this.rollSelectionAnchor = null;
    super.clearSelection();
  }

  protected override _enrichSelectionOutcome(
    frame: OwnedFrame,
    operation: Parameters<KernelDriverRuntime["_enrichSelectionOutcome"]>[1],
    outcome: Parameters<KernelDriverRuntime["_enrichSelectionOutcome"]>[2],
  ) {
    const selection = super._enrichSelectionOutcome(frame, operation, outcome);
    if (selection?.status === "captured" && outcome.status === "captured")
      this.rollSelectionAnchor = { frame, anchor: outcome.anchor };
    return selection;
  }
  private readonly rollRequests = new Map<
    number,
    {
      frame: OwnedFrame;
      layoutGeneration: number | undefined;
      annotationExpected: boolean;
      finish: (point: RollTargetPoint | null) => void;
    }
  >();

  targetPoint(
    target: { locator: NavigatorLocation } | { plan: AnnotationTargetResolutionPlan },
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<RollTargetPoint | null> {
    const frame = this._committed;
    const committed = this._kernel.snapshot().document.committed;
    if (
      frame?.window === null ||
      frame === null ||
      committed?.layout.state !== "settled" ||
      !boundedRollTarget(target) ||
      options.signal?.aborted
    )
      return Promise.resolve(null);
    for (const request of this.rollRequests.values()) request.finish(null);
    return new Promise((resolve) => {
      const operation = ++this.rollOperation;
      const timer = setTimeout(() => finish(null), Math.max(0, options.timeoutMs ?? 5000));
      const aborted = () => finish(null);
      const finish = (point: RollTargetPoint | null) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", aborted);
        this.rollRequests.delete(operation);
        if (frame.window !== null) {
          try {
            postFrameMessage(frame.window, this._frameProfile, {
              namespace: ROLL_NAMESPACE,
              type: "cancel",
              session: frame.session,
              operation,
              layoutGeneration: committed.layout.layout.layoutGeneration,
            });
          } catch {
            /* A failed item transport must not prevent local cancellation. */
          }
        }
        resolve(point);
      };
      this.rollRequests.set(operation, {
        frame,
        layoutGeneration:
          this._kernel.snapshot().document.committed?.layout.layout.layoutGeneration,
        annotationExpected: "plan" in target,
        finish,
      });
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) {
        finish(null);
        return;
      }
      try {
        postFrameMessage(frame.window!, this._frameProfile, {
          namespace: ROLL_NAMESPACE,
          type: "target",
          session: frame.session,
          operation,
          layoutGeneration: committed.layout.layout.layoutGeneration,
          ...target,
        });
      } catch {
        finish(null);
      }
    });
  }

  protected override _applyTransition(
    transition: KernelTransition,
    beforeEffects?: () => void,
    afterEffects?: () => void,
  ): KernelTransition {
    const result = super._applyTransition(transition, beforeEffects, afterEffects);
    if (this._closed) return result;
    const committed = this._kernel.snapshot().document.committed;
    const frame = this._committed;
    const generation =
      committed?.layout.state === "settled" ? committed.layout.layout.layoutGeneration : undefined;
    if (
      generation !== this.rollLayoutGeneration ||
      frame?.frameGeneration !== this.rollFrameGeneration
    ) {
      for (const request of this.rollRequests.values()) request.finish(null);
      this.rollLayoutGeneration = generation;
      this.rollFrameGeneration = frame?.frameGeneration;
      if (frame?.window !== null && frame?.window !== undefined)
        postFrameMessage(frame.window, this._frameProfile, {
          namespace: ROLL_NAMESPACE,
          type: generation === undefined ? "disable" : "enable",
          session: frame.session,
          layoutGeneration: generation,
        });
      if (generation !== undefined && frame !== null && this.rollSelectionAnchor?.frame === frame) {
        const participant = this._participantForFrame(frame);
        if (participant !== null) this._queueSelectionRefresh(participant);
      }
    }
    return result;
  }

  protected override _agentMessage(event: MessageEvent<unknown>): void {
    const message = event.data;
    if (!rollRecord(message) || message.namespace !== ROLL_NAMESPACE) {
      super._agentMessage(event);
      return;
    }
    const frame = this._committed;
    if (
      frame === null ||
      frame.window === null ||
      frame.iframe.contentWindow !== frame.window ||
      !isExpectedFrameMessage(event, frame.window, this._frameProfile) ||
      message.session !== frame.session ||
      this._participantForFrame(frame) === null
    )
      return;
    const layout = this._kernel.snapshot().document.committed?.layout;
    if (
      layout?.state !== "settled" ||
      !rollIdentity(message.layoutGeneration) ||
      message.layoutGeneration !== layout.layout.layoutGeneration
    )
      return;
    if (
      message.type === "scroll" &&
      typeof message.x === "number" &&
      typeof message.y === "number" &&
      Number.isFinite(message.x) &&
      Number.isFinite(message.y) &&
      Math.abs(message.x) <= ROLL_MAX_DELTA &&
      Math.abs(message.y) <= ROLL_MAX_DELTA
    )
      this.onScroll?.({ x: message.x, y: message.y });
    if (message.type === "gesture" && typeof message.active === "boolean")
      this.onGesture?.(message.active);
    if (message.type !== "target-result" || !rollIdentity(message.operation)) return;
    const request = this.rollRequests.get(message.operation);
    if (request?.frame !== frame) return;
    if (
      request.layoutGeneration !==
      this._kernel.snapshot().document.committed?.layout.layout.layoutGeneration
    ) {
      request.finish(null);
      return;
    }
    const point = message.point;
    const annotation =
      message.annotation === undefined || !boundedRollTarget(message.annotation)
        ? null
        : normalizeAnnotationTargetResult(message.annotation);
    if (request.annotationExpected && (annotation === null || annotation.outcome !== "resolved")) {
      request.finish(null);
      return;
    }
    if (
      annotation !== null &&
      (annotation.segment?.resource !== frame.resource ||
        annotation.reports.some(
          (report) => report.segment !== null && report.segment.resource !== frame.resource,
        ))
    ) {
      request.finish(null);
      return;
    }
    request.finish(
      rollRecord(point) &&
        typeof point.x === "number" &&
        typeof point.y === "number" &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        Math.abs(point.x) <= 10_000_000 &&
        Math.abs(point.y) <= 10_000_000
        ? { x: point.x, y: point.y, ...(annotation === null ? {} : { annotation }) }
        : null,
    );
  }

  protected override _removeFrame(frame: OwnedFrame | null): void {
    if (this.rollSelectionAnchor?.frame === frame) this.rollSelectionAnchor = null;
    if (frame?.window !== null && frame?.window !== undefined) {
      try {
        postFrameMessage(frame.window, this._frameProfile, {
          namespace: ROLL_NAMESPACE,
          type: "dispose",
          session: frame.session,
        });
      } catch {
        /* Always release the frame even if its transport is unavailable. */
      }
    }
    for (const request of this.rollRequests.values())
      if (request.frame === frame) request.finish(null);
    super._removeFrame(frame);
  }

  protected override _postOperationCancellation(
    frame: OwnedFrame,
    operation: number,
    operationType: Parameters<KernelDriverRuntime["_postOperationCancellation"]>[2],
  ): void {
    try {
      super._postOperationCancellation(frame, operation, operationType);
    } catch {
      /* Cancellation remains locally complete even when the item transport has failed. */
    }
  }

  protected override _selectionAnchorInReader(
    frame: OwnedFrame,
    anchor: Parameters<KernelDriverRuntime["_selectionAnchorInReader"]>[1],
  ) {
    const converted = super._selectionAnchorInReader(frame, anchor);
    const roll = this._container.closest<HTMLElement>("[data-epub-navigator-roll]");
    if (converted === null || roll === null) return converted;
    const rect = roll.getBoundingClientRect();
    const viewport = this._container.ownerDocument.defaultView?.visualViewport;
    const clip = converted.clippingRect;
    if (clip.x === null || clip.y === null || clip.width === null || clip.height === null)
      return null;
    return {
      ...converted,
      clippingRect: intersectRectangles(
        { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
        {
          x: rect.x - (viewport?.offsetLeft ?? 0),
          y: rect.y - (viewport?.offsetTop ?? 0),
          width: roll.clientWidth,
          height: roll.clientHeight,
        },
      ),
    };
  }

  protected override _acceptActivationRequest(
    frame: OwnedFrame,
    participant: ActiveDocumentParticipant,
    activation: ActivationRequest,
  ): void {
    try {
      this._accepted(
        this._dispatchAndApply(
          adapterInput({
            type: "link-activated",
            participant,
            generation: frame.frameGeneration,
            activation: {
              href: activation.href,
              resolvedUrl: activation.resolvedUrl,
              target: activation.target,
              download: activation.download,
            },
          }),
        ),
      );
      for (const listener of this._activationListeners) {
        try {
          listener({
            participant,
            href: activation.href,
            resolvedUrl: activation.resolvedUrl,
            target: activation.target,
            download: activation.download,
            internal: this._isInternalActivation(activation),
            noteReference: null,
            footnote: null,
          });
        } catch {
          /* Observers do not own navigation. */
        }
      }
      void this._applyActivationRequest(frame, activation).catch((cause) =>
        this._handlePublicationMessageFailure(cause),
      );
    } catch (cause) {
      this._handlePublicationMessageFailure(cause);
    }
  }

  protected override _scheduleAdjacentPreparation(): void {}
  protected override _coordinateFixedSpread(): boolean {
    return false;
  }
  protected override _fixedSpreadPlan(_snapshot: KernelSnapshot): null {
    return null;
  }

  protected override _fixedSlot(_frame: OwnedFrame) {
    return {
      x: 0,
      width: this._frameStack.getBoundingClientRect().width,
      placement: "center" as const,
    };
  }

  protected override _fixedContainingHeight(): number {
    return this._frameStack.getBoundingClientRect().height;
  }
  protected override _fixedBaseOffset() {
    return { x: 0, y: 0 };
  }

  protected override _setFixedViewportGeometry(
    frame: OwnedFrame,
    viewport: FixedIntrinsicViewport,
  ): FixedPageGeometry | null {
    this.onViewport?.(viewport);
    return super._setFixedViewportGeometry(frame, viewport);
  }

  protected override _applyActivationRequest(
    _frame: OwnedFrame,
    activation: ActivationRequest,
  ): Promise<void> {
    return this.onActivation?.(activation) ?? Promise.resolve();
  }
}
