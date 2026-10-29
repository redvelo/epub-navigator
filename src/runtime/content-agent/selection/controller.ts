import type { ContentAgentState } from "../state.js";
import type { DocumentWritingMode } from "../layout/document-scroll.js";
import { CONTENT_AGENT_NAMESPACE } from "../../agent-protocol/index.js";
import { advanceSelectionGeometryBasis, scheduleObservation } from "../observation/controller.js";
import { captureSelectionOutcome } from "./capture.js";
import { hasSelection } from "../interaction/controller.js";
import {
  holdPaginatedPosition,
  paginatedMetrics,
  paginatedRectangleOffsetFromContext,
  releasePaginatedPosition,
  scrollToPaginatedPosition,
} from "../layout/document-scroll.js";
import { post } from "../transport.js";
import { observeDocumentWithRanges } from "../targets/resolver/observation.js";
import { currentObservationViewport } from "../layout/pagination-geometry.js";

export const selectionEdgeInset = 36;

export const selectionEdgeDwellMs = 600;

export const selectionEdgeRepeatMs = 900;

/** A held finger turns pages more slowly than a held pointer: e-ink needs the time to show them. */
export const selectionEdgeTouchRepeatMs = 1500;

/** How far a long-pressing finger must travel before the drag it began follows it. */
export const selectionTouchDragSlop = 10;

/**
 * How long a dragging finger must pause before the reader is told to draw against the selection
 * again. The press itself is told at once: a drag hides what was drawn, so waiting would only
 * hand the toolbar frame to the lift.
 */
export const selectionTouchDwellMs = 150;

export function resetPendingG(state: ContentAgentState): void {
  void state;
  state.interaction.pendingG = null;
  if (state.interaction.pendingGTimer !== null) clearTimeout(state.interaction.pendingGTimer);
  state.interaction.pendingGTimer = null;
}

export function cancelReaderGesturesForSelection(state: ContentAgentState): void {
  void state;
  state.interaction.touchCandidate = null;
  state.interaction.fixedGesturePointers.clear();
  state.interaction.fixedPinch = null;
  resetPendingG(state);
}

export function prepareReaderGesturesForSelectionStart(state: ContentAgentState): void {
  void state;
  state.interaction.fixedGesturePointers.clear();
  state.interaction.fixedPinch = null;
  resetPendingG(state);
}

export function paginatedSelectionEdgeLayout(state: ContentAgentState, settling = false) {
  void state;
  if (
    !state.lifecycle.initialized ||
    state.lifecycle.documentAdapter !== "reflowable-xhtml" ||
    state.layout.settledLayout === null ||
    state.layout.settledLayout.presentation.mode !== "paginated" ||
    state.layout.settledLayout.settlement.mode !== "paginated" ||
    (!settling &&
      (state.lifecycle.agentRole !== "foreground" ||
        state.layout.applyingLayout ||
        state.layout.layoutInvalidationPending))
  ) {
    return null;
  }
  const settlement = state.layout.settledLayout.settlement;
  const writingMode = settlement.measurement.observation.writingMode;
  const direction = settlement.measurement.observation.direction;
  const scroll = paginatedMetrics(document, writingMode, direction);
  if (scroll === null) return null;
  return { settlement, writingMode, direction, scroll };
}

export function clearSelectionEdgeTimer(
  state: ContentAgentState,
  gesture = state.selection.selectionEdgeGesture,
): void {
  void state;
  if (gesture?.timer !== null && gesture?.timer !== undefined) clearTimeout(gesture.timer);
  if (gesture !== null) gesture.timer = null;
}

type TouchDrag = NonNullable<
  NonNullable<ContentAgentState["selection"]["selectionEdgeGesture"]>["touchDrag"]
>;

function clearTouchDwell(drag: TouchDrag): void {
  if (drag.dwellTimer !== null) clearTimeout(drag.dwellTimer);
  drag.dwellTimer = null;
}

/**
 * A finger that has rested on its selection for the dwell is told to the reader while it is
 * still down, so the reader draws against the selection before the lift rather than after it:
 * on e-ink a frame drawn after the lift is what the display pays a full refresh for.
 */
function armTouchDwell(
  state: ContentAgentState,
  gesture: NonNullable<ContentAgentState["selection"]["selectionEdgeGesture"]>,
  drag: TouchDrag,
): void {
  clearTouchDwell(drag);
  drag.dwellTimer = setTimeout(() => {
    drag.dwellTimer = null;
    if (state.selection.selectionEdgeGesture !== gesture || gesture.touchDrag !== drag) return;
    if (!hasSelection(state)) return;
    drag.settled = true;
    state.selection.selectionEdgeSignalDeferred = false;
    scheduleSelectionSignal(state);
  }, selectionTouchDwellMs);
}

/** The drag follows the finger again: whatever the reader drew against the rest is stale. */
function touchDragResumed(
  state: ContentAgentState,
  gesture: NonNullable<ContentAgentState["selection"]["selectionEdgeGesture"]>,
  drag: TouchDrag,
): void {
  armTouchDwell(state, gesture, drag);
  if (!drag.settled) return;
  drag.settled = false;
  queueSelectionSignal(state);
}

export function selectionEdgeViewport(writingMode: DocumentWritingMode): {
  readonly vertical: boolean;
  readonly start: number;
  readonly size: number;
} {
  const viewport = window.visualViewport;
  const vertical = writingMode !== "horizontal-tb";
  return {
    vertical,
    start: vertical ? (viewport?.offsetTop ?? 0) : (viewport?.offsetLeft ?? 0),
    size: vertical
      ? (viewport?.height ?? window.innerHeight)
      : (viewport?.width ?? window.innerWidth),
  };
}

export function selectionEdgeDirection(
  state: ContentAgentState,
  gesture: NonNullable<typeof state.selection.selectionEdgeGesture>,
  writingMode: DocumentWritingMode,
  direction: "ltr" | "rtl",
): "forward" | "backward" | null {
  void state;
  const { vertical, start, size } = selectionEdgeViewport(writingMode);
  const coordinate = vertical ? gesture.clientY : gesture.clientX;
  const inset = Math.min(selectionEdgeInset, size / 4);
  if (coordinate <= start + inset) return direction === "rtl" ? "forward" : "backward";
  if (coordinate >= start + size - inset) return direction === "rtl" ? "backward" : "forward";
  return null;
}

function caretBoundaryAtPoint(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(x, y);
    return position === null ? null : { node: position.offsetNode, offset: position.offset };
  }
  const legacy = document as Document & {
    caretRangeFromPoint?: ((x: number, y: number) => Range | null) | undefined;
  };
  const hit = legacy.caretRangeFromPoint?.(x, y) ?? null;
  return hit === null ? null : { node: hit.startContainer, offset: hit.startOffset };
}

function physicalPoint(
  layout: NonNullable<ReturnType<typeof paginatedSelectionEdgeLayout>>,
  logicalInline: number,
  logicalBlock: number,
): { x: number; y: number } {
  const horizontal = layout.writingMode === "horizontal-tb";
  const blockViewport = horizontal ? window.innerHeight : window.innerWidth;
  const inline =
    layout.direction === "rtl" ? layout.scroll.viewport - logicalInline : logicalInline;
  const block = layout.writingMode === "vertical-rl" ? blockViewport - logicalBlock : logicalBlock;
  return horizontal ? { x: inline, y: block } : { x: block, y: inline };
}

function columnBlockRange(layout: NonNullable<ReturnType<typeof paginatedSelectionEdgeLayout>>) {
  const blockViewport =
    layout.writingMode === "horizontal-tb" ? window.innerHeight : window.innerWidth;
  return { start: 1, end: blockViewport - 1 };
}

function visibleColumnBand(layout: NonNullable<ReturnType<typeof paginatedSelectionEdgeLayout>>) {
  const pages = layout.settlement.pages;
  const firstColumn =
    Math.round(layout.scroll.position / pages.spreadStride) * pages.columnsPerView;
  const origin = pages.columnOrigin + firstColumn * pages.columnPitch - layout.scroll.position;
  return {
    origin,
    contentEnd: origin + (pages.columnsPerView - 1) * pages.columnPitch + pages.columnWidth,
    context: {
      flow: { writingMode: layout.writingMode, direction: layout.direction },
      metrics: layout.scroll,
    },
  };
}

/**
 * Whether a caret rectangle lies on a column other than the visible ones. Neighbouring
 * columns begin a gap away, so half of it keeps this page's own edge carets inside.
 */
export function beyondVisibleColumns(
  state: ContentAgentState,
  rectangle: DOMRect,
  layout: NonNullable<ReturnType<typeof paginatedSelectionEdgeLayout>>,
): boolean {
  void state;
  const { origin, contentEnd, context } = visibleColumnBand(layout);
  const slack = layout.settlement.pages.columnGap / 2;
  return (
    paginatedRectangleOffsetFromContext(rectangle, "end", context) < origin - slack ||
    paginatedRectangleOffsetFromContext(rectangle, "start", context) > contentEnd + slack
  );
}

function onSameLine(
  layout: NonNullable<ReturnType<typeof paginatedSelectionEdgeLayout>>,
  a: DOMRect,
  b: DOMRect,
): boolean {
  return layout.writingMode === "horizontal-tb"
    ? a.top < b.bottom && a.bottom > b.top
    : a.left < b.right && a.right > b.left;
}

/**
 * The first (or last) position on the visible page: the caret nearest the page's near (or
 * far) corner, probing inward along the block axis until the hit lands on the page, since a
 * corner may lie above a first line pushed down by a margin or below a short final line.
 */
function visiblePagePosition(
  state: ContentAgentState,
  layout: NonNullable<ReturnType<typeof paginatedSelectionEdgeLayout>>,
  edge: "start" | "end",
): { node: Node; offset: number; rectangle: DOMRect } | null {
  const { origin, contentEnd } = visibleColumnBand(layout);
  const block = columnBlockRange(layout);
  const inline = edge === "start" ? origin + 1 : contentEnd - 1;
  for (let probe = 0; ; probe += 1) {
    const logicalBlock = edge === "start" ? block.start + probe * 16 : block.end - probe * 16;
    if (logicalBlock < block.start || logicalBlock > block.end) break;
    const point = physicalPoint(layout, inline, logicalBlock);
    const boundary = caretBoundaryAtPoint(point.x, point.y);
    if (boundary === null) continue;
    const range = document.createRange();
    try {
      range.setStart(boundary.node, boundary.offset);
      range.collapse(true);
    } catch {
      continue;
    }
    const rectangle = [...range.getClientRects()].find((r) => r.width > 0 || r.height > 0);
    if (rectangle === undefined || beyondVisibleColumns(state, rectangle, layout)) continue;
    return { ...boundary, rectangle };
  }
  return null;
}

/**
 * Whether a caret on the page has reached the last (or first) position a drag travelling this
 * way can get to on it: on the same line as, and within a few characters of, the caret nearest
 * the visible columns' far corner, found with one hit test so a short final line still counts.
 */
export function atVisibleColumnsExtreme(
  state: ContentAgentState,
  rectangle: DOMRect,
  travel: "forward" | "backward",
  layout: NonNullable<ReturnType<typeof paginatedSelectionEdgeLayout>>,
): boolean {
  void state;
  const { context } = visibleColumnBand(layout);
  const extreme = visiblePagePosition(
    state,
    layout,
    travel === "forward" ? "end" : "start",
  )?.rectangle;
  if (extreme === undefined || !onSameLine(layout, rectangle, extreme)) return false;
  // Touch sampling is coarse, so the last few characters before the corner count as reaching
  // it; the finger's next reading past them is off the page and read as nothing at all.
  const tolerance = Math.min(selectionEdgeInset, layout.settlement.pages.columnWidth / 4);
  return travel === "forward"
    ? paginatedRectangleOffsetFromContext(rectangle, "end", context) >=
        paginatedRectangleOffsetFromContext(extreme, "start", context) - tolerance
    : paginatedRectangleOffsetFromContext(rectangle, "start", context) <=
        paginatedRectangleOffsetFromContext(extreme, "end", context) + tolerance;
}

export function revealSelectionEdge(
  state: ContentAgentState,
  gesture: NonNullable<typeof state.selection.selectionEdgeGesture>,
): void {
  void state;
  if (
    state.selection.selectionEdgeGesture !== gesture ||
    !gesture.selectionActive ||
    !hasSelection(state)
  )
    return;
  const layout = paginatedSelectionEdgeLayout(state);
  if (layout === null) {
    clearSelectionEdgeTimer(state, gesture);
    return;
  }
  const direction = selectionEdgeDirection(state, gesture, layout.writingMode, layout.direction);
  if (direction === null || direction !== gesture.direction) {
    clearSelectionEdgeTimer(state, gesture);
    return;
  }
  const delta = layout.settlement.pages.spreadStride;
  const target = Math.min(
    layout.scroll.maximum,
    Math.max(0, gesture.lockedPosition + (direction === "forward" ? delta : -delta)),
  );
  if (Math.abs(target - gesture.lockedPosition) <= 1) {
    clearSelectionEdgeTimer(state, gesture);
    return;
  }
  gesture.lockedPosition = target;
  gesture.revealed = direction;
  state.selection.touchPage = target;
  gesture.nextRevealAt =
    performance.now() +
    (gesture.pointerId === null || gesture.touchDrag !== null
      ? selectionEdgeTouchRepeatMs
      : selectionEdgeRepeatMs);
  state.selection.selectionEdgeViewportTransient = true;
  scrollToPaginatedPosition(document, target, layout.writingMode, layout.direction);
  const selection = window.getSelection();
  if (selection !== null && selection.anchorNode !== null && selection.focusNode !== null) {
    // A pointer holds still while pages advance under it, so the selection is walked onto
    // each revealed page. A dragged handle is left alone: the finger is already over the
    // revealed page, and the browser extends the selection to wherever it rests there. Its
    // anchor, though, is re-based on the revealed page's near corner for the rest of the drag:
    // the browser ends a touch drag once neither end of the selection is on screen, which a
    // finger straying into a margin would otherwise do at once. The true anchor returns
    // when the drag ends, and until then the two selections look the same on screen.
    if (gesture.touchDrag !== null) {
      gesture.touchDrag.press = null;
      extendTouchSelection(state, gesture.clientX, gesture.clientY);
    } else if (gesture.pointerId === null) {
      const revealed = paginatedSelectionEdgeLayout(state);
      if (revealed !== null) {
        const near = visiblePagePosition(
          state,
          revealed,
          direction === "forward" ? "start" : "end",
        );
        if (near !== null) {
          gesture.heldAnchor ??= { node: selection.anchorNode, offset: selection.anchorOffset };
          try {
            selection.setBaseAndExtent(
              near.node,
              near.offset,
              selection.focusNode,
              selection.focusOffset,
            );
          } catch {
            gesture.heldAnchor = null;
          }
        }
      }
    }
    const boundary =
      gesture.pointerId === null || gesture.touchDrag !== null
        ? null
        : direction === "forward"
          ? selectionViewportRanges(state).visibleStartRange
          : selectionViewportRanges(state).visibleEndRange;
    if (boundary !== null) {
      if (gesture.endpoint === "anchor") {
        selection.setBaseAndExtent(
          boundary.startContainer,
          boundary.startOffset,
          selection.focusNode,
          selection.focusOffset,
        );
      } else {
        selection.extend(boundary.startContainer, boundary.startOffset);
      }
    }
    state.selection.previousSelectionFocus = {
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      node: selection.focusNode,
      offset: selection.focusOffset,
      position: target,
    };
  }
  if (gesture.pointerId === null) {
    gesture.endpointMoved = false;
    gesture.timer = null;
    scheduleInferredSelectionEnd(state, gesture);
  } else {
    gesture.timer = setTimeout(() => revealSelectionEdge(state, gesture), selectionEdgeRepeatMs);
  }
}

export function updateSelectionEdgeGesture(state: ContentAgentState): void {
  void state;
  const gesture = state.selection.selectionEdgeGesture;
  if (gesture === null || !gesture.selectionActive || !gesture.endpointMoved) return;
  const layout = paginatedSelectionEdgeLayout(state);
  if (layout === null) {
    clearSelectionEdgeTimer(state, gesture);
    return;
  }
  const direction = selectionEdgeDirection(state, gesture, layout.writingMode, layout.direction);
  if (direction === gesture.direction && gesture.timer !== null) return;
  clearSelectionEdgeTimer(state, gesture);
  gesture.direction = direction;
  if (direction !== null) {
    gesture.timer = setTimeout(
      () => revealSelectionEdge(state, gesture),
      Math.max(selectionEdgeDwellMs, gesture.nextRevealAt - performance.now()),
    );
  }
}

export function selectionFocusRectangle(
  state: ContentAgentState,
  selection: Selection,
  endpoint: "anchor" | "focus" = "focus",
): {
  readonly rectangle: DOMRect;
  readonly boundary: "start" | "end";
} | null {
  void state;
  if (selection.rangeCount !== 1 || selection.anchorNode === null || selection.focusNode === null) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const focus = document.createRange();
  try {
    focus.setStart(
      endpoint === "anchor" ? selection.anchorNode : selection.focusNode,
      endpoint === "anchor" ? selection.anchorOffset : selection.focusOffset,
    );
    focus.collapse(true);
  } catch {
    return null;
  }
  const focusAtStart = range.compareBoundaryPoints(Range.START_TO_START, focus) === 0;
  const caret = [...focus.getClientRects()].find(
    (rectangle) => rectangle.width > 0 || rectangle.height > 0,
  );
  if (caret !== undefined) return { rectangle: caret, boundary: focusAtStart ? "start" : "end" };
  const rectangles = [...range.getClientRects()].filter(
    (rectangle) => rectangle.width > 0 && rectangle.height > 0,
  );
  const rectangle = focusAtStart ? rectangles[0] : rectangles[rectangles.length - 1];
  return rectangle === undefined ? null : { rectangle, boundary: focusAtStart ? "start" : "end" };
}

export function clearInferredSelectionEdgeTimer(state: ContentAgentState): void {
  void state;
  if (state.selection.inferredSelectionEdgeTimer !== null)
    clearTimeout(state.selection.inferredSelectionEdgeTimer);
  state.selection.inferredSelectionEdgeTimer = null;
}

/**
 * A dragged handle's release reaches the page as the selection menu it raises, so a touch
 * drag is only timed out as a last resort; a finger holding still sends nothing at all.
 */
function scheduleInferredSelectionEnd(
  state: ContentAgentState,
  gesture: NonNullable<typeof state.selection.selectionEdgeGesture>,
): void {
  clearInferredSelectionEdgeTimer(state);
  state.selection.inferredSelectionEdgeTimer = setTimeout(
    () => {
      if (state.selection.selectionEdgeGesture === gesture) finishSelectionEdgeGesture(state);
    },
    state.selection.touchPage === null ? 750 : 15_000,
  );
}

function endpointTravel(
  previous: { readonly node: Node | null; readonly offset: number },
  node: Node,
  offset: number,
): "forward" | "backward" | null {
  if (previous.node === null) return null;
  const before = document.createRange();
  const after = document.createRange();
  try {
    before.setStart(previous.node, previous.offset);
    after.setStart(node, offset);
    const order = after.compareBoundaryPoints(Range.START_TO_START, before);
    return order > 0 ? "forward" : order < 0 ? "backward" : null;
  } catch {
    return null;
  }
}

/**
 * A dragged selection handle reports no pointer, so the focus stands in for the finger. It is
 * placed on the edge the drag is travelling towards once the focus has reached the last
 * position that way, and otherwise at the viewport's centre, so a caret that merely sits near
 * a page margin — as every line's first and last do — is never read as a drag off the page.
 * A focus off the visible columns is not a position the finger chose: the browser resolves a
 * touch in a page margin to a stray column and scrolls to it. Changing the selection under a
 * live drag can end it, so the stray reading is only ignored and the scroll undone; the browser
 * places the focus again as soon as the finger is back over text.
 */
function inferredSelectionEdgePoint(
  state: ContentAgentState,
  selection: Selection,
  previous: { readonly node: Node | null; readonly offset: number },
  layout: NonNullable<ReturnType<typeof paginatedSelectionEdgeLayout>>,
): { point: { x: number; y: number }; stray: boolean } | null {
  restoreNativeSelectionEdgeScroll(state);
  const settled = paginatedSelectionEdgeLayout(state) ?? layout;
  const focus = selectionFocusRectangle(state, selection, "focus");
  if (focus === null) {
    return null;
  }
  const stray = beyondVisibleColumns(state, focus.rectangle, settled);
  const travel = stray
    ? null
    : endpointTravel(previous, selection.focusNode!, selection.focusOffset);
  // A finger past the page's inline edge, or past its last line, hit-tests to a stray column
  // at the same height: a stray level with the page's last (or first) line is the drag
  // pushing past that corner even though it never touched the line itself.
  const edge = stray
    ? strayEdge(state, focus.rectangle, settled)
    : travel !== null && atVisibleColumnsExtreme(state, focus.rectangle, travel, settled)
      ? travel
      : null;
  if (stray && edge === null) {
    return null;
  }
  const { vertical, start, size } = selectionEdgeViewport(settled.writingMode);
  const coordinate =
    edge === null
      ? start + size / 2
      : (edge === "forward") === (settled.direction === "ltr")
        ? start + size
        : start;
  return { point: vertical ? { x: 0, y: coordinate } : { x: coordinate, y: 0 }, stray };
}

function strayEdge(
  state: ContentAgentState,
  rectangle: DOMRect,
  layout: NonNullable<ReturnType<typeof paginatedSelectionEdgeLayout>>,
): "forward" | "backward" | null {
  const last = visiblePagePosition(state, layout, "end")?.rectangle;
  if (last !== undefined && onSameLine(layout, rectangle, last)) return "forward";
  const first = visiblePagePosition(state, layout, "start")?.rectangle;
  if (first !== undefined && onSameLine(layout, rectangle, first)) return "backward";
  return null;
}

/**
 * A long press with the finger still down is the browser's own drag selection: it hit-tests
 * the finger through the page margins to stray columns, scrolls to reveal them, and gives up
 * once both ends of the selection leave the screen. Re-selecting the word from script ends
 * that drag before it begins and leaves the touch stream with the page, so the drag is driven
 * here instead, from finger positions clamped inside the visible columns.
 */
function takeOverTouchSelection(state: ContentAgentState): void {
  const gesture = state.selection.selectionEdgeGesture;
  const selection = window.getSelection();
  if (
    gesture === null ||
    gesture.pointerId === null ||
    gesture.touchDrag !== null ||
    state.selection.touchPage === null ||
    selection === null ||
    selection.isCollapsed ||
    selection.anchorNode === null ||
    selection.focusNode === null
  )
    return;
  try {
    selection.setBaseAndExtent(
      selection.anchorNode,
      selection.anchorOffset,
      selection.focusNode,
      selection.focusOffset,
    );
  } catch {
    return;
  }
  gesture.touchDrag = {
    press: { x: gesture.clientX, y: gesture.clientY },
    pressed: selection.getRangeAt(0).cloneRange(),
    settled: true,
    dwellTimer: null,
  };
  gesture.selectionActive = true;
  state.selection.selectionEdgeSignalDeferred = false;
  scheduleSelectionSignal(state);
}

const wordSegmenters = new Map<string, Intl.Segmenter | null>();

function wordSegmenter(node: Node): Intl.Segmenter | null {
  if (typeof Intl.Segmenter !== "function") return null;
  const element = node instanceof Element ? node : node.parentElement;
  const language = element?.closest("[lang]")?.getAttribute("lang") ?? "";
  let segmenter = wordSegmenters.get(language);
  if (segmenter === undefined) {
    segmenter = createWordSegmenter(language) ?? createWordSegmenter("");
    wordSegmenters.set(language, segmenter);
  }
  return segmenter;
}

function createWordSegmenter(language: string): Intl.Segmenter | null {
  try {
    return new Intl.Segmenter(language === "" ? undefined : language, { granularity: "word" });
  } catch {
    return null;
  }
}

/**
 * The word boundary a dragging finger's caret stands for, as the browser's own drag after a
 * long press would choose: the end of the word (or space run) the caret is in when the drag
 * leads, its start when the drag trails. A caret at a node's end, or outside text, is kept.
 */
function wordBoundary(
  node: Node,
  offset: number,
  edge: "start" | "end",
): { node: Node; offset: number } {
  if (!(node instanceof Text)) return { node, offset };
  const segment = wordSegmenter(node)?.segment(node.data).containing(offset);
  if (segment === undefined) return { node, offset };
  return { node, offset: edge === "end" ? segment.index + segment.segment.length : segment.index };
}

/**
 * The long press leaves the finger resting on the word it selected, and lifting it off shifts
 * the touch a pixel or two. The drag follows the finger only once it has clearly left the
 * press, so a press and release keeps the word the browser chose rather than cutting it at the
 * caret under the finger.
 */
export function touchDragFollowsFinger(
  drag: NonNullable<
    NonNullable<ContentAgentState["selection"]["selectionEdgeGesture"]>["touchDrag"]
  >,
  clientX: number,
  clientY: number,
): boolean {
  if (drag.press === null) return true;
  if (Math.hypot(clientX - drag.press.x, clientY - drag.press.y) <= selectionTouchDragSlop)
    return false;
  drag.press = null;
  return true;
}

export function extendTouchSelection(
  state: ContentAgentState,
  clientX: number,
  clientY: number,
): void {
  const gesture = state.selection.selectionEdgeGesture;
  if (gesture?.touchDrag != null) touchDragResumed(state, gesture, gesture.touchDrag);
  const layout = paginatedSelectionEdgeLayout(state);
  const selection = window.getSelection();
  if (layout === null || selection === null || selection.anchorNode === null) return;
  const { origin, contentEnd } = visibleColumnBand(layout);
  const block = columnBlockRange(layout);
  const horizontal = layout.writingMode === "horizontal-tb";
  const blockViewport = horizontal ? window.innerHeight : window.innerWidth;
  const physicalInline = horizontal ? clientX : clientY;
  const physicalBlock = horizontal ? clientY : clientX;
  const logicalInline =
    layout.direction === "rtl" ? layout.scroll.viewport - physicalInline : physicalInline;
  const logicalBlock =
    layout.writingMode === "vertical-rl" ? blockViewport - physicalBlock : physicalBlock;
  const point = physicalPoint(
    layout,
    Math.min(contentEnd - 1, Math.max(origin + 1, logicalInline)),
    Math.min(block.end, Math.max(block.start, logicalBlock)),
  );
  const boundary = caretBoundaryAtPoint(point.x, point.y);
  if (boundary === null) return;
  const range = document.createRange();
  try {
    range.setStart(boundary.node, boundary.offset);
    range.collapse(true);
  } catch {
    return;
  }
  // Empty space above a column's first line still hit-tests to a stray column; such a
  // reading is skipped and the selection keeps its last focus until the finger moves on.
  const rectangle = [...range.getClientRects()].find((r) => r.width > 0 || r.height > 0);
  if (rectangle !== undefined && beyondVisibleColumns(state, rectangle, layout)) return;
  const drag = state.selection.selectionEdgeGesture?.touchDrag ?? null;
  try {
    if (drag === null) {
      selection.extend(boundary.node, boundary.offset);
      return;
    }
    // The drag advances by word and never gives up the pressed word: dragged behind it, the
    // selection is re-based on that word's end, as the browser's own drag would.
    const pressed = drag.pressed;
    const side = pressed.comparePoint(boundary.node, boundary.offset);
    const anchor =
      side < 0
        ? { node: pressed.endContainer, offset: pressed.endOffset }
        : { node: pressed.startContainer, offset: pressed.startOffset };
    const focus =
      side === 0
        ? { node: pressed.endContainer, offset: pressed.endOffset }
        : wordBoundary(boundary.node, boundary.offset, side < 0 ? "start" : "end");
    if (
      selection.anchorNode === anchor.node &&
      selection.anchorOffset === anchor.offset &&
      selection.focusNode === focus.node &&
      selection.focusOffset === focus.offset
    )
      return;
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  } catch {
    return;
  }
}

function selectionViewportRanges(state: ContentAgentState) {
  const capture = observeDocumentWithRanges(document, currentObservationViewport(state), {
    textSnapshot: state.observation.observationTextSnapshot,
    includeRenderedTextContext: false,
  });
  state.observation.observationTextSnapshot = capture.textSnapshot;
  return capture;
}

export function observeSelectionEndpointChange(state: ContentAgentState): void {
  void state;
  const selection = window.getSelection();
  const layout = paginatedSelectionEdgeLayout(state);
  if (
    selection === null ||
    selection.isCollapsed ||
    selection.focusNode === null ||
    layout === null
  ) {
    const gesture = state.selection.selectionEdgeGesture;
    if (
      selection !== null &&
      selection.rangeCount > 0 &&
      selection.focusNode !== null &&
      layout !== null &&
      gesture?.pointerId === null &&
      gesture.heldAnchor !== null
    ) {
      // The finger has met the anchor standing in for the revealed page's start, so the true
      // anchor returns and the selection still reaches from it to the finger.
      restoreHeldAnchor(gesture);
      state.selection.previousSelectionFocus = {
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        node: selection.focusNode,
        offset: selection.focusOffset,
        position: gesture.lockedPosition,
      };
      return;
    }
    state.selection.previousSelectionFocus = null;
    if (gesture?.pointerId === null) cancelSelectionEdgeGesture(state);
    return;
  }
  const previous = state.selection.previousSelectionFocus;
  const focusChanged =
    previous !== null &&
    (previous.node !== selection.focusNode || previous.offset !== selection.focusOffset);
  const anchorChanged =
    previous !== null &&
    (previous.anchorNode !== selection.anchorNode ||
      previous.anchorOffset !== selection.anchorOffset);
  const endpointChanged = focusChanged || anchorChanged;
  state.selection.previousSelectionFocus = {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    node: selection.focusNode,
    offset: selection.focusOffset,
    position: state.selection.selectionEdgeGesture?.lockedPosition ?? layout.scroll.position,
  };
  // A handle drag begins with a touch on the page, which recorded the page it was on before
  // the browser could scroll it away; that page is held for as long as the selection lives.
  // A selection that first appears after a touch is such a drag only when the browser took
  // the touch over; after a lift it is the long press's own word arriving late.
  if (
    state.selection.selectionEdgeGesture === null &&
    (endpointChanged ||
      (previous === null && state.selection.touchPage !== null && state.selection.touchTakenOver))
  ) {
    // Until a focus move places it, the stand-in finger rests mid-viewport, on no edge.
    const { vertical, start, size } = selectionEdgeViewport(layout.writingMode);
    const stride = layout.settlement.pages.spreadStride;
    const position = state.selection.touchPage ?? previous?.position ?? layout.scroll.position;
    state.selection.selectionEdgeGesture = {
      pointerId: null,
      endpoint: "focus",
      clientX: vertical ? 0 : start + size / 2,
      clientY: vertical ? start + size / 2 : 0,
      selectionActive: true,
      endpointMoved: true,
      lockedPosition: Math.min(layout.scroll.maximum, Math.round(position / stride) * stride),
      nextRevealAt: 0,
      direction: null,
      revealed: null,
      heldAnchor: null,
      touchDrag: null,
      timer: null,
    };
    holdPaginatedPosition(
      document,
      state.selection.selectionEdgeGesture.lockedPosition,
      layout.writingMode,
      layout.direction,
    );
    scheduleInferredSelectionEnd(state, state.selection.selectionEdgeGesture);
  }
  const gesture = state.selection.selectionEdgeGesture;
  if (gesture?.pointerId !== null || previous === null) return;
  // A dragged handle always moves the focus: the browser re-bases the selection on the handle
  // that stays put, so a change to the anchor, alone or together with the focus, is that
  // re-basing rather than travel and only resets the point the next focus move is read from.
  if (!focusChanged || anchorChanged) return;
  const reading = inferredSelectionEdgePoint(state, selection, previous, layout);
  // A stray reading never becomes the baseline the next on-page reading is measured from.
  if (reading === null || reading.stray) state.selection.previousSelectionFocus = previous;
  if (reading === null) return;
  gesture.endpointMoved = true;
  gesture.clientX = reading.point.x;
  gesture.clientY = reading.point.y;
  updateSelectionEdgeGesture(state);
  scheduleInferredSelectionEnd(state, gesture);
}

export function finishSelectionEdgeGesture(state: ContentAgentState, pointerId?: number): void {
  void state;
  const gesture = state.selection.selectionEdgeGesture;
  if (gesture === null || (pointerId !== undefined && gesture.pointerId !== pointerId)) return;
  state.selection.selectionEdgeGesture = null;
  clearSelectionEdgeTimer(state, gesture);
  if (gesture.touchDrag !== null) clearTouchDwell(gesture.touchDrag);
  clearInferredSelectionEdgeTimer(state);
  const previous = state.selection.previousSelectionFocus;
  state.selection.previousSelectionFocus = null;
  if (gesture.selectionActive && gesture.endpointMoved) {
    state.selection.suppressDecorationActivationUntil = performance.now() + 350;
  }
  if (gesture.pointerId === null) {
    settleStrayFocus(state, gesture, previous);
    restoreHeldAnchor(gesture);
    releasePaginatedPosition(document);
    // The settled selection is the baseline, so the change it raises does not read as a drag.
    const selection = window.getSelection();
    if (selection !== null && !selection.isCollapsed && selection.focusNode !== null) {
      state.selection.previousSelectionFocus = {
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        node: selection.focusNode,
        offset: selection.focusOffset,
        position: gesture.lockedPosition,
      };
    }
  }
  settleSelectionEdgeViewport(state, gesture);
}

function restoreHeldAnchor(
  gesture: NonNullable<ContentAgentState["selection"]["selectionEdgeGesture"]>,
): void {
  const anchor = gesture.heldAnchor;
  if (anchor === null) return;
  gesture.heldAnchor = null;
  const selection = window.getSelection();
  if (selection === null || selection.focusNode === null) return;
  try {
    selection.setBaseAndExtent(
      anchor.node,
      anchor.offset,
      selection.focusNode,
      selection.focusOffset,
    );
  } catch {
    return;
  }
}

/**
 * A drag that ends with the finger in a page margin leaves the focus at the stray position
 * the browser resolved that margin to. Once the drag is over the selection can be changed
 * safely, so the focus is moved to the end of the page the drag revealed, or back to where
 * the finger last was over text.
 */
function settleStrayFocus(
  state: ContentAgentState,
  gesture: NonNullable<typeof state.selection.selectionEdgeGesture>,
  previous: { readonly node: Node | null; readonly offset: number } | null,
): void {
  const selection = window.getSelection();
  const layout = paginatedSelectionEdgeLayout(state, true);
  if (selection === null || selection.isCollapsed || layout === null) return;
  restoreNativeSelectionEdgeScroll(state);
  const focus = selectionFocusRectangle(state, selection, "focus");
  if (focus === null || !beyondVisibleColumns(state, focus.rectangle, layout)) return;
  let target: { node: Node; offset: number } | null =
    gesture.revealed === null
      ? null
      : visiblePagePosition(state, layout, gesture.revealed === "forward" ? "end" : "start");
  if (target === null && previous?.node) target = { node: previous.node, offset: previous.offset };
  if (target === null) return;
  try {
    selection.extend(target.node, target.offset);
  } catch {
    return;
  }
  restoreNativeSelectionEdgeScroll(state);
}

export function cancelSelectionEdgeGesture(state: ContentAgentState, deferRefresh = false): void {
  void state;
  const gesture = state.selection.selectionEdgeGesture;
  state.selection.selectionEdgeGesture = null;
  clearSelectionEdgeTimer(state, gesture);
  if (gesture?.touchDrag != null) clearTouchDwell(gesture.touchDrag);
  clearInferredSelectionEdgeTimer(state);
  state.selection.previousSelectionFocus = null;
  if (gesture !== null) restoreHeldAnchor(gesture);
  releasePaginatedPosition(document);
  if (gesture !== null) settleSelectionEdgeViewport(state, gesture, deferRefresh);
}

export function settleSelectionEdgeViewport(
  state: ContentAgentState,
  gesture: NonNullable<typeof state.selection.selectionEdgeGesture>,
  deferRefresh = false,
): void {
  void state;
  if (!state.selection.selectionEdgeViewportTransient) {
    // A drag that turned no page still owes the reader the selection it deferred.
    if (state.selection.selectionEdgeSignalDeferred && !deferRefresh) {
      state.selection.selectionEdgeSignalDeferred = false;
      scheduleSelectionSignal(state);
    }
    return;
  }
  const layout = paginatedSelectionEdgeLayout(state, true);
  if (layout !== null) {
    const pages = layout.settlement.pages;
    const target = Math.round(gesture.lockedPosition / pages.spreadStride) * pages.spreadStride;
    scrollToPaginatedPosition(
      document,
      Math.min(layout.scroll.maximum, Math.max(0, target)),
      layout.writingMode,
      layout.direction,
    );
  }
  state.selection.selectionEdgeViewportTransient = false;
  advanceSelectionGeometryBasis(state);
  if (deferRefresh) {
    state.observation.observationDeferred = true;
    state.selection.selectionEdgeSignalDeferred = true;
    return;
  }
  if (state.selection.selectionEdgeObservationDeferred || layout !== null) {
    state.selection.selectionEdgeObservationDeferred = false;
    scheduleObservation(state);
  }
  if (state.selection.selectionEdgeSignalDeferred || hasSelection(state)) {
    state.selection.selectionEdgeSignalDeferred = false;
    scheduleSelectionSignal(state);
  }
}

export function restoreNativeSelectionEdgeScroll(state: ContentAgentState): boolean {
  void state;
  const gesture = state.selection.selectionEdgeGesture;
  if (gesture === null || !gesture.selectionActive) return false;
  const layout = paginatedSelectionEdgeLayout(state);
  if (layout === null || Math.abs(layout.scroll.position - gesture.lockedPosition) <= 1)
    return false;
  scrollToPaginatedPosition(document, gesture.lockedPosition, layout.writingMode, layout.direction);
  return true;
}

export function scheduleSelectionSignal(state: ContentAgentState): void {
  void state;
  const selection = window.getSelection();
  if (selection !== null && selection.rangeCount > 0 && !selection.isCollapsed) {
    cancelReaderGesturesForSelection(state);
    if (state.selection.selectionEdgeGesture !== null) {
      state.selection.selectionEdgeGesture.selectionActive = true;
      restoreNativeSelectionEdgeScroll(state);
      updateSelectionEdgeGesture(state);
    }
  }
  // A moving touch drag redraws nothing in the reader: the reader's capture and its surfaces
  // would otherwise follow every sample of the finger. A finger at rest is told at once.
  const gesture = state.selection.selectionEdgeGesture;
  if (
    state.selection.selectionEdgeViewportTransient ||
    gesture?.pointerId === null ||
    (gesture !== null && gesture.touchDrag !== null && !gesture.touchDrag.settled)
  ) {
    state.selection.selectionEdgeSignalDeferred = true;
    return;
  }
  queueSelectionSignal(state);
}

function queueSelectionSignal(state: ContentAgentState): void {
  if (
    !state.lifecycle.initialized ||
    state.lifecycle.agentRole !== "foreground" ||
    state.selection.selectionCompositionActive ||
    state.selection.selectionSignalScheduled
  ) {
    return;
  }
  state.selection.selectionSignalScheduled = true;
  requestAnimationFrame(() => {
    state.selection.selectionSignalScheduled = false;
    if (state.selection.selectionEdgeViewportTransient) {
      state.selection.selectionEdgeSignalDeferred = true;
      return;
    }
    if (
      !state.lifecycle.initialized ||
      state.lifecycle.agentRole !== "foreground" ||
      state.selection.selectionCompositionActive
    )
      return;
    // Scrolls and relayouts signal too, so the reader can re-capture a live selection's
    // geometry. With nothing selected there is nothing to re-capture: signal the transition
    // to empty once, not every page turn.
    const current = window.getSelection();
    const empty = current === null || current.rangeCount === 0 || current.isCollapsed;
    if (empty && !state.selection.selectionSignalledContent) return;
    state.selection.selectionSignalledContent = !empty;
    post(state, { namespace: CONTENT_AGENT_NAMESPACE, type: "selection-changed" });
  });
}

export function installSelectionController(state: ContentAgentState): void {
  document.addEventListener("selectstart", () => prepareReaderGesturesForSelectionStart(state), {
    capture: true,
  });

  document.addEventListener("selectionchange", () => {
    observeSelectionEndpointChange(state);
    scheduleSelectionSignal(state);
  });

  document.addEventListener(
    "contextmenu",
    (event) => {
      if (state.lifecycle.configuration.input.selectionMenu === "reader") {
        const capture = captureSelectionOutcome(state);
        if (
          capture.status === "captured" &&
          capture.evidence.some(
            (evidence) => evidence.kind === "rendered-text-quote" && evidence.exact.length > 0,
          )
        ) {
          event.preventDefault();
        }
      }
      // Android raises the selection menu when a dragged handle is let go, which is the
      // only word the page gets that the drag has ended.
      if (state.selection.selectionEdgeGesture?.pointerId === null)
        finishSelectionEdgeGesture(state);
      else takeOverTouchSelection(state);
      scheduleSelectionSignal(state);
    },
    { capture: true },
  );

  document.addEventListener("focusin", () => scheduleSelectionSignal(state));

  document.addEventListener("focusout", () => scheduleSelectionSignal(state));

  document.addEventListener("compositionstart", () => {
    state.selection.selectionCompositionActive = true;
    cancelSelectionEdgeGesture(state);
    cancelReaderGesturesForSelection(state);
  });

  document.addEventListener("compositionend", () => {
    state.selection.selectionCompositionActive = false;
    scheduleSelectionSignal(state);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") cancelSelectionEdgeGesture(state, true);
    else {
      state.selection.selectionEdgeSignalDeferred = false;
      if (state.observation.observationDeferred && !state.layout.applyingLayout) {
        state.observation.observationDeferred = false;
        scheduleObservation(state);
      }
    }
    scheduleSelectionSignal(state);
  });
}
