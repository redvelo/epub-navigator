import { deferLayoutInteraction } from "../layout/deferred-interaction.js";
import { readerKeyCommand } from "../../reader-commands.js";
import type {
  AgentReleasedMessage,
  AgentFixedViewInteractionMessage,
  AgentInteractionMessage,
} from "../../agent-protocol/index.js";
import type { ContentAgentState } from "../state.js";
import type { LayoutMeasurement, PresentationAdvanceStatus } from "../../../generated/kernel.js";
import { CONTENT_AGENT_NAMESPACE } from "../../agent-protocol/index.js";
import type { OutboundMessageInput } from "../transport.js";
import { post } from "../transport.js";
import {
  arrowPageDirection,
  fixedPanStep,
  logicalBlockMetrics,
  paginatedMetrics,
  scrollByLogicalBlock,
  scrollToDocumentBoundary,
  scrollToPaginatedPosition,
} from "../layout/document-scroll.js";
import {
  cancelSelectionEdgeGesture,
  extendTouchSelection,
  finishSelectionEdgeGesture,
  paginatedSelectionEdgeLayout,
  resetPendingG,
  scheduleSelectionSignal,
  touchDragFollowsFinger,
  updateSelectionEdgeGesture,
} from "../selection/controller.js";
const interactiveElementSelector =
  'a, button, input, select, textarea, label, summary, details, audio, video, [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="slider"], [role="textbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="treeitem"], [role="spinbutton"], [role="combobox"], [role="listbox"]';
import { lastSpreadFirstPage } from "../layout/pagination-geometry.js";
import { postForegroundActivity, scheduleObservation } from "../observation/controller.js";

export const endFixedGesturePointer = (state: ContentAgentState, event: PointerEvent): void => {
  state.interaction.fixedGesturePointers.delete(event.pointerId);
  if (state.interaction.fixedGesturePointers.size < 2) state.interaction.fixedPinch = null;
};

export function eligibleInteractionEvent(state: ContentAgentState, event: Event): boolean {
  void state;
  if (document.designMode === "on") return false;
  return !event
    .composedPath()
    .some((item) => item instanceof Element && item.matches(interactiveElementSelector));
}

export function hasSelection(state: ContentAgentState): boolean {
  void state;
  return window.getSelection()?.isCollapsed === false;
}

export function usableInteractionMeasurement(state: ContentAgentState): LayoutMeasurement | null {
  void state;
  if (
    state.layout.settledLayout !== null &&
    state.layout.activePresentation !== null &&
    state.layout.activePresentation.mode !== state.layout.settledLayout.presentation.mode
  ) {
    return null;
  }
  return (
    state.layout.settledLayout?.settlement.measurement ??
    state.layout.fixedSettlement?.measurement ??
    null
  );
}

export function postInteraction(
  state: ContentAgentState,
  command: AgentInteractionMessage["command"],
  source: AgentInteractionMessage["source"],
): void {
  void state;
  if (state.lifecycle.agentRole !== "foreground") return;
  post(state, { namespace: CONTENT_AGENT_NAMESPACE, type: "interaction", command, source });
}

export function postFixedZoom(
  state: ContentAgentState,
  factor: number,
  focalX: number,
  focalY: number,
  source: "keyboard" | "pointer" | "touch",
): void {
  void state;
  post(state, {
    namespace: CONTENT_AGENT_NAMESPACE,
    type: "fixed-view-interaction",
    action: "zoom",
    source,
    factor,
    focalX,
    focalY,
  } satisfies OutboundMessageInput<AgentFixedViewInteractionMessage>);
}

export function postFixedPan(
  state: ContentAgentState,
  deltaX: number,
  deltaY: number,
  source: "keyboard" | "pointer" | "touch",
): void {
  void state;
  post(state, {
    namespace: CONTENT_AGENT_NAMESPACE,
    type: "fixed-view-interaction",
    action: "pan",
    source,
    deltaX,
    deltaY,
  } satisfies OutboundMessageInput<AgentFixedViewInteractionMessage>);
}

export function postFixedReset(state: ContentAgentState): void {
  void state;
  post(state, {
    namespace: CONTENT_AGENT_NAMESPACE,
    type: "fixed-view-interaction",
    action: "reset",
    source: "keyboard",
  } satisfies OutboundMessageInput<AgentFixedViewInteractionMessage>);
}

export function releaseWhenTouchIdle(state: ContentAgentState): void {
  void state;
  if (state.interaction.touchActive) {
    state.interaction.releaseRequested = true;
    return;
  }
  state.interaction.releaseRequested = false;
  post(state, {
    namespace: CONTENT_AGENT_NAMESPACE,
    type: "released",
  } satisfies OutboundMessageInput<AgentReleasedMessage>);
}

/**
 * Which axis the reader moved along: the inline axis carries the reading order, the block axis
 * carries the text. A horizontal swipe and the inline arrows are inline; a page key, `j`/`k`
 * and the reader's own page zones are block.
 */
export type PresentationAxis = "inline" | "block";

export function advancePresentation(
  state: ContentAgentState,
  direction: "forward" | "backward",
  source: AgentInteractionMessage["source"],
  axis: PresentationAxis,
): void {
  void state;
  postForegroundActivity(state, "presentation");
  const status = advancePresentationWithinDocument(state, direction, axis);
  if (status.status === "boundary") {
    postInteraction(state, direction === "forward" ? "next" : "previous", source);
  } else if (
    status.status === "unavailable" &&
    (state.layout.applyingLayout || state.layout.layoutInvalidationPending)
  ) {
    deferLayoutInteraction(state, () => advancePresentation(state, direction, source, axis));
  }
}

export function advancePresentationWithinDocument(
  state: ContentAgentState,
  direction: "forward" | "backward",
  axis: PresentationAxis,
): PresentationAdvanceStatus {
  void state;
  if (state.layout.applyingLayout || state.layout.layoutInvalidationPending) {
    return { status: "unavailable", reason: "layout-unavailable" };
  }
  if (document.designMode === "on" || hasSelection(state) || hasActiveInteractiveElement(state)) {
    return { status: "unavailable", reason: "presentation-unavailable" };
  }
  if (state.layout.settledLayout === null) {
    return state.layout.fixedSettlement === null
      ? { status: "unavailable", reason: "layout-unavailable" }
      : { status: "boundary" };
  }
  if (
    state.layout.activePresentation !== null &&
    state.layout.activePresentation.mode !== state.layout.settledLayout.presentation.mode
  ) {
    return { status: "unavailable", reason: "layout-unavailable" };
  }
  if (state.layout.settledLayout.presentation.mode === "paginated") {
    const settlement = state.layout.settledLayout.settlement;
    if (settlement.mode !== "paginated") {
      return { status: "unavailable", reason: "layout-unavailable" };
    }
    const storedMetrics = settlement.pages;
    const { writingMode, direction: flowDirection } = settlement.measurement.observation;
    const metrics = paginatedMetrics(document, writingMode, flowDirection);
    if (metrics === null) return { status: "unavailable", reason: "layout-unavailable" };
    const spreadStride = storedMetrics.spreadStride;
    const currentSpread = Math.max(0, Math.round(metrics.position / spreadStride));
    const lastSpread = Math.max(
      0,
      Math.floor((storedMetrics.pageCount - 1) / storedMetrics.columnsPerView),
    );
    const liveLastSpread = Math.max(0, Math.round(metrics.maximum / spreadStride));
    if (liveLastSpread < lastSpread) {
      return { status: "unavailable", reason: "layout-unavailable" };
    }
    const forward = direction === "forward";
    const atBoundary = forward ? currentSpread >= lastSpread : currentSpread === 0;
    if (atBoundary) return { status: "boundary" };
    const targetSpread = currentSpread + (forward ? 1 : -1);
    scrollToPaginatedPosition(document, targetSpread * spreadStride, writingMode, flowDirection);
    refreshPositionAfterInput(state);
    return { status: "advanced" };
  }
  // A scrolled document has no pages on the inline axis, so the inline gesture is always at its
  // boundary and moves to the next section, the way `h` and `l` already do. The block axis is
  // the one the text runs down, and that is what scrolls.
  if (axis === "inline") return { status: "boundary" };
  const scrollingElement = document.scrollingElement;
  if (scrollingElement === null) {
    return { status: "unavailable", reason: "layout-unavailable" };
  }
  const writingMode = state.layout.settledLayout.settlement.measurement.observation.writingMode;
  const metrics = logicalBlockMetrics(document, writingMode);
  if (metrics === null) return { status: "unavailable", reason: "layout-unavailable" };
  const forward = direction === "forward";
  const atBoundary = forward ? metrics.position >= metrics.maximum - 2 : metrics.position <= 2;
  if (atBoundary) return { status: "boundary" };
  const distance = metrics.viewport * 0.9;
  const delta = (forward ? 1 : -1) * distance;
  scrollByLogicalBlock(document, delta, writingMode);
  scheduleObservation(state);
  return { status: "advanced" };
}

export function hasActiveInteractiveElement(state: ContentAgentState): boolean {
  void state;
  const active = document.activeElement;
  return (
    active instanceof Element &&
    (active.matches(interactiveElementSelector) ||
      ("isContentEditable" in active && active.isContentEditable === true))
  );
}

export function scrollToBoundary(state: ContentAgentState, boundary: "start" | "end"): void {
  void state;
  if (state.layout.applyingLayout) {
    deferLayoutInteraction(state, () => scrollToBoundary(state, boundary));
    return;
  }
  if (state.layout.settledLayout === null) return;
  if (state.layout.settledLayout.presentation.mode === "paginated") {
    const settlement = state.layout.settledLayout.settlement;
    if (settlement.mode !== "paginated") return;
    const metrics = settlement.pages;
    scrollToPaginatedPosition(
      document,
      boundary === "start"
        ? 0
        : (lastSpreadFirstPage(state, metrics) / metrics.columnsPerView) * metrics.spreadStride,
      settlement.measurement.observation.writingMode,
      settlement.measurement.observation.direction,
    );
    refreshPositionAfterInput(state);
    return;
  }
  scrollToDocumentBoundary(
    document,
    boundary,
    state.layout.settledLayout.settlement.measurement.observation.writingMode,
  );
  scheduleObservation(state);
}

export function refreshPositionAfterInput(state: ContentAgentState): void {
  void state;
  scheduleObservation(state);
}

/** How far a page-turn swipe must travel before it counts, and how long it may take. The clock
 * rejects a drag that was really something else rather than timing a flick: a deliberate drag on
 * a low-refresh display is slow, and direction and distance already say what it is. */
const SWIPE_TRAVEL = 40;
const SWIPE_DURATION = 1500;

/** How far a reveal drag must travel before it counts, and how deep the bands that start one are. */
const REVEAL_TRAVEL = 40;
const REVEAL_DURATION = 1500;
const REVEAL_DRIFT = 32;
const REVEAL_BAND_MINIMUM = 120;
const REVEAL_BAND_FRACTION = 0.3;
const REVEAL_PAGE_MINIMUM = 320;

/**
 * The bands are measured inside the publication frame, which already begins below the reader's
 * rails and the display cutout, so a drag that starts in one is clear of the platform's own
 * edge gestures without needing to know where those begin.
 */
function revealEdge(event: PointerEvent): "top" | "bottom" | null {
  if (window.innerHeight < REVEAL_PAGE_MINIMUM) return null;
  const band = Math.max(REVEAL_BAND_MINIMUM, window.innerHeight * REVEAL_BAND_FRACTION);
  if (event.clientY <= band) return "top";
  if (event.clientY >= window.innerHeight - band) return "bottom";
  return null;
}

function swipeDeltas(
  state: ContentAgentState,
  candidate: { readonly startX: number; readonly startY: number },
  event: PointerEvent,
): { readonly along: number; readonly across: number } {
  const vertical = usableInteractionMeasurement(state)?.observation.writingMode !== "horizontal-tb";
  const dx = event.clientX - candidate.startX;
  const dy = event.clientY - candidate.startY;
  return vertical ? { along: dy, across: dx } : { along: dx, across: dy };
}

export function installInteractionController(state: ContentAgentState): void {
  // Chromium keeps a touch pointer active forever when the frame it started in is removed
  // before the touch ends; the runtime waits for `released` before removing this frame.
  for (const type of ["touchstart", "touchend", "touchcancel"] as const) {
    window.addEventListener(
      type,
      (event) => {
        state.interaction.touchActive = event.touches.length > 0;
        if (!state.interaction.touchActive && state.interaction.releaseRequested) {
          releaseWhenTouchIdle(state);
        }
      },
      { capture: true, passive: true },
    );
  }
  window.addEventListener("keydown", (event) => {
    state.selection.touchPage = null;
    if (
      state.lifecycle.initialized &&
      state.lifecycle.agentRole === "foreground" &&
      event.isTrusted &&
      !event.defaultPrevented &&
      !event.isComposing &&
      document.designMode !== "on" &&
      !event
        .composedPath()
        .some(
          (item) =>
            item instanceof Element &&
            item.matches(
              'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
            ),
        )
    ) {
      const command = readerKeyCommand(
        event,
        state.lifecycle.configuration.input.keyboardMode,
        hasSelection(state),
      );
      if (command !== null) {
        event.preventDefault();
        resetPendingG(state);
        postInteraction(state, command, "keyboard");
        return;
      }
    }
    const interactionMeasurement = usableInteractionMeasurement(state);
    if (
      !state.lifecycle.initialized ||
      state.lifecycle.agentRole !== "foreground" ||
      state.lifecycle.configuration.input.keyboardMode === "off" ||
      event.defaultPrevented ||
      event.isComposing ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      !eligibleInteractionEvent(state, event) ||
      hasSelection(state) ||
      interactionMeasurement === null
    ) {
      resetPendingG(state);
      return;
    }
    const key = event.key;
    if (state.layout.fixedSettlement !== null) {
      if (key === "+" || key === "=") {
        event.preventDefault();
        postFixedZoom(state, 1.25, window.innerWidth / 2, window.innerHeight / 2, "keyboard");
        resetPendingG(state);
        return;
      }
      if (key === "-") {
        event.preventDefault();
        postFixedZoom(state, 0.8, window.innerWidth / 2, window.innerHeight / 2, "keyboard");
        resetPendingG(state);
        return;
      }
      if (key === "0") {
        event.preventDefault();
        postFixedReset(state);
        resetPendingG(state);
        return;
      }
      const pan = event.shiftKey ? fixedPanStep(key) : null;
      if (pan !== null) {
        event.preventDefault();
        postFixedPan(state, pan.x, pan.y, "keyboard");
        resetPendingG(state);
        return;
      }
    }
    if (event.shiftKey && key !== " " && key !== "G") {
      resetPendingG(state);
      return;
    }
    const progressionDirection = state.lifecycle.configuration.input.progressionDirection;
    const writingMode = interactionMeasurement.observation.writingMode;
    const arrowDirection = arrowPageDirection(writingMode, key, progressionDirection);
    if (arrowDirection !== null) {
      event.preventDefault();
      advancePresentation(state, arrowDirection, "keyboard", "inline");
      resetPendingG(state);
      return;
    }
    if (key === "PageDown" || (key === " " && !event.shiftKey)) {
      event.preventDefault();
      advancePresentation(state, "forward", "keyboard", "block");
      resetPendingG(state);
      return;
    }
    if (key === "PageUp" || (key === " " && event.shiftKey)) {
      event.preventDefault();
      advancePresentation(state, "backward", "keyboard", "block");
      resetPendingG(state);
      return;
    }
    if (state.lifecycle.configuration.input.keyboardMode !== "vim") {
      resetPendingG(state);
      return;
    }
    if (key === "h" || key === "l") {
      event.preventDefault();
      postInteraction(state, key === "h" ? "previous" : "next", "keyboard");
    } else if (key === "j" || key === "k") {
      event.preventDefault();
      advancePresentation(state, key === "j" ? "forward" : "backward", "keyboard", "block");
    } else if (key === "G") {
      event.preventDefault();
      scrollToBoundary(state, "end");
    } else if (key === "g") {
      event.preventDefault();
      const now = performance.now();
      if (state.interaction.pendingG !== null && now - state.interaction.pendingG <= 750) {
        resetPendingG(state);
        scrollToBoundary(state, "start");
        return;
      }
      resetPendingG(state);
      state.interaction.pendingG = now;
      state.interaction.pendingGTimer = setTimeout(() => resetPendingG(state), 750);
      return;
    }
    resetPendingG(state);
  });

  window.addEventListener("pointerdown", (event) => {
    const layout = paginatedSelectionEdgeLayout(state);
    if (
      layout === null ||
      !event.isPrimary ||
      event.button !== 0 ||
      !eligibleInteractionEvent(state, event) ||
      document.designMode === "on"
    ) {
      finishSelectionEdgeGesture(state);
      return;
    }
    finishSelectionEdgeGesture(state);
    state.selection.touchTakenOver = false;
    if (event.pointerType === "touch") {
      const stride = layout.settlement.pages.spreadStride;
      state.selection.touchPage = Math.min(
        layout.scroll.maximum,
        Math.round(layout.scroll.position / stride) * stride,
      );
    } else {
      state.selection.touchPage = null;
    }
    state.selection.selectionEdgeGesture = {
      pointerId: event.pointerId,
      endpoint: "focus",
      clientX: event.clientX,
      clientY: event.clientY,
      selectionActive: hasSelection(state),
      endpointMoved: false,
      lockedPosition: layout.scroll.position,
      nextRevealAt: 0,
      direction: null,
      revealed: null,
      heldAnchor: null,
      touchDrag: null,
      timer: null,
    };
    updateSelectionEdgeGesture(state);
  });

  window.addEventListener("pointermove", (event) => {
    const gesture = state.selection.selectionEdgeGesture;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons !== 1) {
      finishSelectionEdgeGesture(state, event.pointerId);
      return;
    }
    if (Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) > 2) {
      gesture.endpointMoved = true;
    }
    gesture.clientX = event.clientX;
    gesture.clientY = event.clientY;
    if (
      gesture.touchDrag !== null &&
      touchDragFollowsFinger(gesture.touchDrag, event.clientX, event.clientY)
    )
      extendTouchSelection(state, event.clientX, event.clientY);
    if (hasSelection(state)) gesture.selectionActive = true;
    updateSelectionEdgeGesture(state);
  });

  window.addEventListener("pointerup", (event) => {
    if (state.selection.selectionEdgeGesture?.pointerId === event.pointerId)
      state.selection.touchTakenOver = false;
    finishSelectionEdgeGesture(state, event.pointerId);
  });

  // A cancelled touch is one the browser took for itself, as it does for its own long-press
  // drag: the finger is still down and the selection will move under it with no more pointer
  // events. A lifted touch is over, and a selection that lands after it is only late.
  window.addEventListener("pointercancel", (event) => {
    if (state.selection.selectionEdgeGesture?.pointerId === event.pointerId)
      state.selection.touchTakenOver = event.pointerType === "touch";
    finishSelectionEdgeGesture(state, event.pointerId);
  });

  window.addEventListener("pointerdown", (event) => {
    if (
      !state.lifecycle.initialized ||
      state.lifecycle.agentRole !== "foreground" ||
      !(event.pointerType === "touch"
        ? state.lifecycle.configuration.input.touchZones
        : event.pointerType === "mouse" && state.lifecycle.configuration.input.clickZones) ||
      !event.isPrimary ||
      event.button !== 0 ||
      !eligibleInteractionEvent(state, event) ||
      (hasSelection(state) && event.pointerType !== "touch") ||
      usableInteractionMeasurement(state) === null
    ) {
      state.interaction.touchCandidate = null;
      return;
    }
    state.interaction.touchCandidate = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      startX: event.clientX,
      startY: event.clientY,
      endX: event.clientX,
      endY: event.clientY,
      completed: false,
      clearsSelection: hasSelection(state),
    };
  });

  window.addEventListener("pointermove", (event) => {
    const candidate = state.interaction.touchCandidate;
    if (
      candidate !== null &&
      candidate.pointerId === event.pointerId &&
      Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY) > 10
    ) {
      state.interaction.touchCandidate = null;
    }
  });

  window.addEventListener("pointerup", (event) => {
    const candidate = state.interaction.touchCandidate;
    if (candidate === null || candidate.pointerId !== event.pointerId) return;
    candidate.endX = event.clientX;
    candidate.endY = event.clientY;
    candidate.completed =
      performance.now() - candidate.startedAt <= 500 &&
      Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY) <= 10;
    if (!candidate.completed) state.interaction.touchCandidate = null;
  });

  window.addEventListener("pointercancel", (event) => {
    if (state.interaction.touchCandidate?.pointerId === event.pointerId)
      state.interaction.touchCandidate = null;
  });

  window.addEventListener("pointerdown", (event) => {
    if (
      !state.lifecycle.initialized ||
      state.lifecycle.agentRole !== "foreground" ||
      !state.lifecycle.configuration.input.touchZones ||
      state.layout.fixedSettlement !== null ||
      event.pointerType !== "touch" ||
      !event.isPrimary ||
      event.button !== 0 ||
      !eligibleInteractionEvent(state, event) ||
      hasSelection(state) ||
      usableInteractionMeasurement(state) === null
    ) {
      state.interaction.swipeCandidate = null;
      return;
    }
    state.interaction.swipeCandidate = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      startX: event.clientX,
      startY: event.clientY,
      horizontal: false,
    };
  });

  window.addEventListener("pointermove", (event) => {
    const candidate = state.interaction.swipeCandidate;
    if (candidate === null || candidate.pointerId !== event.pointerId) return;
    const { along, across } = swipeDeltas(state, candidate, event);
    if (!candidate.horizontal && Math.abs(across) > 12 && Math.abs(across) > Math.abs(along)) {
      state.interaction.swipeCandidate = null;
      return;
    }
    if (Math.abs(along) > 12 && Math.abs(along) > Math.abs(across) * 1.25) {
      candidate.horizontal = true;
    }
  });

  window.addEventListener("pointerup", (event) => {
    const candidate = state.interaction.swipeCandidate;
    if (candidate === null || candidate.pointerId !== event.pointerId) return;
    state.interaction.swipeCandidate = null;
    const { along, across } = swipeDeltas(state, candidate, event);
    if (
      !candidate.horizontal ||
      performance.now() - candidate.startedAt > SWIPE_DURATION ||
      Math.abs(along) < SWIPE_TRAVEL ||
      Math.abs(along) <= Math.abs(across) * 1.25 ||
      hasSelection(state)
    ) {
      return;
    }
    const forward =
      along < 0
        ? state.lifecycle.configuration.input.progressionDirection === "ltr"
        : state.lifecycle.configuration.input.progressionDirection === "rtl";
    advancePresentation(state, forward ? "forward" : "backward", "touch", "inline");
  });

  window.addEventListener("pointercancel", (event) => {
    if (state.interaction.swipeCandidate?.pointerId === event.pointerId)
      state.interaction.swipeCandidate = null;
  });

  // A drag from the top or bottom band of the page reveals the reader's own chrome. The bands
  // sit inside the reader's rails, which already hold the surface clear of the platform's own
  // edge gestures, and a drag that starts on a selection or turns sideways is left alone.
  window.addEventListener("pointerdown", (event) => {
    const edge = revealEdge(event);
    if (
      edge === null ||
      !state.lifecycle.initialized ||
      state.lifecycle.agentRole !== "foreground" ||
      state.layout.fixedSettlement !== null ||
      state.layout.settledLayout?.presentation.mode !== "paginated" ||
      usableInteractionMeasurement(state)?.observation.writingMode !== "horizontal-tb" ||
      event.pointerType !== "touch" ||
      !event.isPrimary ||
      event.button !== 0 ||
      !eligibleInteractionEvent(state, event) ||
      hasSelection(state)
    ) {
      state.interaction.edgeCandidate = null;
      return;
    }
    state.interaction.edgeCandidate = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      startX: event.clientX,
      startY: event.clientY,
      edge,
      inward: 0,
      drift: 0,
    };
  });

  window.addEventListener("pointermove", (event) => {
    const candidate = state.interaction.edgeCandidate;
    if (candidate === null || candidate.pointerId !== event.pointerId) return;
    const travel = event.clientY - candidate.startY;
    const drift = Math.abs(event.clientX - candidate.startX);
    const inward = candidate.edge === "top" ? travel : -travel;
    // A thumb arcs, so only a drag that has clearly committed sideways is given up on.
    if (drift > REVEAL_DRIFT && drift > Math.abs(travel) * 1.5)
      state.interaction.edgeCandidate = null;
    else if (inward < -REVEAL_DRIFT) state.interaction.edgeCandidate = null;
    else {
      candidate.inward = inward;
      candidate.drift = drift;
    }
  });

  window.addEventListener("pointerup", (event) => {
    const candidate = state.interaction.edgeCandidate;
    if (candidate === null || candidate.pointerId !== event.pointerId) return;
    state.interaction.edgeCandidate = null;
    const travel = event.clientY - candidate.startY;
    const inward = candidate.edge === "top" ? travel : -travel;
    if (
      performance.now() - candidate.startedAt > REVEAL_DURATION ||
      inward < REVEAL_TRAVEL ||
      inward <= Math.abs(event.clientX - candidate.startX) ||
      hasSelection(state)
    ) {
      return;
    }
    postInteraction(state, candidate.edge === "top" ? "reveal-top" : "reveal-bottom", "touch");
  });

  // The browser cancels the pointer stream once it claims a pan, so a drag that has already
  // earned its reveal is honoured rather than lost to that hand-off.
  window.addEventListener("pointercancel", (event) => {
    const candidate = state.interaction.edgeCandidate;
    if (candidate === null || candidate.pointerId !== event.pointerId) return;
    state.interaction.edgeCandidate = null;
    if (
      performance.now() - candidate.startedAt > REVEAL_DURATION ||
      candidate.inward < REVEAL_TRAVEL ||
      candidate.inward <= candidate.drift ||
      hasSelection(state)
    ) {
      return;
    }
    postInteraction(state, candidate.edge === "top" ? "reveal-top" : "reveal-bottom", "touch");
  });

  window.addEventListener("pointerdown", (event) => {
    if (
      state.layout.fixedSettlement === null ||
      !state.lifecycle.initialized ||
      state.lifecycle.agentRole !== "foreground" ||
      event.button !== 0 ||
      !eligibleInteractionEvent(state, event) ||
      hasSelection(state)
    ) {
      return;
    }
    state.interaction.fixedGesturePointers.set(event.pointerId, {
      pointerType: event.pointerType,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
  });

  window.addEventListener("pointermove", (event) => {
    const pointer = state.interaction.fixedGesturePointers.get(event.pointerId);
    if (pointer === undefined || state.layout.fixedSettlement === null) return;
    const previousX = pointer.x;
    const previousY = pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    const touches = [...state.interaction.fixedGesturePointers.values()].filter(
      (candidate) => candidate.pointerType === "touch",
    );
    if (touches.length >= 2) {
      const first = touches[0]!;
      const second = touches[1]!;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const previous = state.interaction.fixedPinch;
      state.interaction.fixedPinch = { distance, ...center };
      state.interaction.touchCandidate = null;
      event.preventDefault();
      if (previous !== null) {
        postFixedPan(state, center.x - previous.x, center.y - previous.y, "touch");
        postFixedZoom(state, distance / previous.distance, center.x, center.y, "touch");
      }
      return;
    }
    state.interaction.fixedPinch = null;
    if (
      Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) < 6 ||
      (pointer.pointerType === "mouse" && event.buttons !== 1)
    ) {
      return;
    }
    state.interaction.touchCandidate = null;
    event.preventDefault();
    postFixedPan(
      state,
      pointer.x - previousX,
      pointer.y - previousY,
      pointer.pointerType === "touch" ? "touch" : "pointer",
    );
  });

  window.addEventListener("pointerup", (event) => endFixedGesturePointer(state, event));

  window.addEventListener("pointercancel", (event) => endFixedGesturePointer(state, event));

  window.addEventListener("click", (event) => {
    const candidate = state.interaction.touchCandidate;
    state.interaction.touchCandidate = null;
    if (
      candidate === null ||
      !candidate.completed ||
      performance.now() - candidate.startedAt > 500 ||
      Math.hypot(event.clientX - candidate.endX, event.clientY - candidate.endY) > 10 ||
      event.defaultPrevented ||
      !eligibleInteractionEvent(state, event) ||
      (hasSelection(state) && !candidate.clearsSelection)
    ) {
      return;
    }
    const vertical =
      usableInteractionMeasurement(state)?.observation.writingMode !== "horizontal-tb";
    const ratio = vertical
      ? event.clientY / Math.max(1, window.innerHeight)
      : event.clientX / Math.max(1, window.innerWidth);
    if (ratio >= 0.25 && ratio <= 0.75) {
      return;
    }
    // A finger that ends a selection in a page zone turns the page with the same tap. Each
    // finger lift that a frame follows is paid for on e-ink, so the dismissal rides on the turn
    // rather than costing a tap of its own; a mouse click still only clears.
    if (hasSelection(state)) {
      cancelSelectionEdgeGesture(state);
      window.getSelection()?.removeAllRanges();
      scheduleSelectionSignal(state);
    }
    const forward =
      ratio < 0.25
        ? state.lifecycle.configuration.input.progressionDirection === "rtl"
        : state.lifecycle.configuration.input.progressionDirection === "ltr";
    // A tap in a page zone moves the text, as it does in every reader that scrolls: the swipe
    // is the gesture that leaves the section.
    advancePresentation(
      state,
      forward ? "forward" : "backward",
      event.pointerType === "mouse" ? "pointer" : "touch",
      "block",
    );
  });
  for (const type of ["mousedown", "mouseup", "auxclick"] as const) {
    window.addEventListener(
      type,
      (event) => {
        if (event.button !== 3 && event.button !== 4) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (type === "mouseup" && event.isTrusted && state.lifecycle.initialized) {
          postInteraction(state, event.button === 3 ? "page-backward" : "page-forward", "pointer");
        }
      },
      { capture: true },
    );
  }
}
