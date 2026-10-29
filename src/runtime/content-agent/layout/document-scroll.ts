export type DocumentWritingMode = "horizontal-tb" | "vertical-rl" | "vertical-lr";
export type DocumentDirection = "ltr" | "rtl";

export interface DocumentFlow {
  readonly writingMode: DocumentWritingMode;
  readonly direction: DocumentDirection;
}

export interface LogicalScrollMetrics {
  readonly position: number;
  readonly maximum: number;
  readonly viewport: number;
}

export interface PaginatedGeometryContext {
  readonly flow: DocumentFlow;
  readonly metrics: LogicalScrollMetrics;
}

export type PaginatedRectangleBoundary = "start" | "end";

export function documentFlow(document: Document): DocumentFlow {
  const flowRoot = document.body ?? document.documentElement;
  const style = document.defaultView?.getComputedStyle(flowRoot);
  return {
    writingMode: normalizeWritingMode(style?.writingMode),
    direction: style?.direction === "rtl" ? "rtl" : "ltr",
  };
}

/**
 * Where a scrolled document sits between its start and its end, as the unit ratio the layout
 * protocol accepts.
 *
 * `scrollHeight` is rounded to whole pixels while the offset is not, so a document scrolled to
 * its end can sit a fraction past the maximum it is measured against. Past the end is the end: a
 * ratio outside the unit range is refused as malformed, and the layout carrying it is then never
 * answered at all, which strands the section for the length of the operation timeout.
 */
export function normalizedScrollPosition(position: number, maximum: number): number {
  if (maximum <= 0) return 0;
  return Math.min(1, Math.max(0, position / maximum));
}

/**
 * How far a fixed page travels for one arrow press, in viewport pixels.
 *
 * An arrow moves the view, the way it does in every other viewer, so the page travels the other
 * way. A drag is the opposite gesture: there the page follows the finger.
 */
export function fixedPanStep(key: string, step = 48): { x: number; y: number } | null {
  if (key === "ArrowRight") return { x: -step, y: 0 };
  if (key === "ArrowLeft") return { x: step, y: 0 };
  if (key === "ArrowDown") return { x: 0, y: -step };
  if (key === "ArrowUp") return { x: 0, y: step };
  return null;
}

export function documentWritingMode(document: Document): DocumentWritingMode {
  return documentFlow(document).writingMode;
}

export function documentScrollDirection(document: Document): DocumentDirection {
  const scrollingElement = document.scrollingElement ?? document.documentElement;
  const style = document.defaultView?.getComputedStyle(scrollingElement);
  return style?.direction === "rtl" ? "rtl" : "ltr";
}

export function arrowPageDirection(
  writingMode: DocumentWritingMode,
  key: string,
  progressionDirection: DocumentDirection,
): "forward" | "backward" | null {
  const forwardKey =
    writingMode === "horizontal-tb"
      ? progressionDirection === "rtl"
        ? "ArrowLeft"
        : "ArrowRight"
      : progressionDirection === "rtl"
        ? "ArrowUp"
        : "ArrowDown";
  const backwardKey =
    writingMode === "horizontal-tb"
      ? progressionDirection === "rtl"
        ? "ArrowRight"
        : "ArrowLeft"
      : progressionDirection === "rtl"
        ? "ArrowDown"
        : "ArrowUp";
  if (key === forwardKey) return "forward";
  if (key === backwardKey) return "backward";
  return null;
}

export function logicalBlockMetrics(
  document: Document,
  writingMode = documentWritingMode(document),
): LogicalScrollMetrics | null {
  const view = document.defaultView;
  const scrollingElement = document.scrollingElement;
  if (view === null || scrollingElement === null) return null;
  const vertical = writingMode !== "horizontal-tb";
  const viewport = vertical ? view.innerWidth : view.innerHeight;
  const extent = vertical ? scrollingElement.scrollWidth : scrollingElement.scrollHeight;
  const rawPosition = vertical ? view.scrollX : view.scrollY;
  return {
    position: writingMode === "vertical-rl" ? -rawPosition : rawPosition,
    maximum: Math.max(0, extent - viewport),
    viewport,
  };
}

/**
 * A page held in place is shown by translating the flow rather than scrolling to it, so the
 * document has no scrollable overflow behind it: a browser that scrolls a selection into
 * view during a touch drag, where the page must not move, then has nowhere to take it.
 */
const heldPaginatedPositions = new WeakMap<
  Document,
  { position: number; style: HTMLStyleElement }
>();

function holdRule(
  position: number,
  writingMode: DocumentWritingMode,
  direction: DocumentDirection,
) {
  const physical = direction === "rtl" ? position : -position;
  const axis = writingMode === "horizontal-tb" ? "X" : "Y";
  return `body { transform: translate${axis}(${physical}px) !important; }`;
}

export function paginatedHoldMutationIsRuntimeOwned(
  document: Document,
  record: MutationRecord,
): boolean {
  const held = heldPaginatedPositions.get(document);
  if (held === undefined) {
    return (
      record.type === "childList" &&
      record.addedNodes.length === 0 &&
      [...record.removedNodes].every(
        (node) => node instanceof HTMLStyleElement && "epubNavigatorHold" in node.dataset,
      ) &&
      record.removedNodes.length > 0
    );
  }
  if (record.target === held.style) return true;
  return (
    record.type === "childList" &&
    [...record.addedNodes, ...record.removedNodes].length > 0 &&
    [...record.addedNodes, ...record.removedNodes].every((node) => node === held.style)
  );
}

export function holdPaginatedPosition(
  document: Document,
  position: number,
  writingMode = documentWritingMode(document),
  direction: DocumentDirection = documentFlow(document).direction,
): void {
  const scrollingElement = document.scrollingElement;
  if (scrollingElement === null || document.head === null) return;
  const held = heldPaginatedPositions.get(document);
  if (held !== undefined) {
    held.position = position;
    held.style.textContent = holdRule(position, writingMode, direction);
    return;
  }
  const style = document.createElement("style");
  style.dataset["epubNavigatorHold"] = "";
  style.textContent = holdRule(position, writingMode, direction);
  heldPaginatedPositions.set(document, { position, style });
  document.head.append(style);
  if (writingMode !== "horizontal-tb") scrollingElement.scrollTop = 0;
  else scrollingElement.scrollLeft = 0;
}

export function releasePaginatedPosition(
  document: Document,
  writingMode = documentWritingMode(document),
  direction: DocumentDirection = documentFlow(document).direction,
): void {
  const held = heldPaginatedPositions.get(document);
  if (held === undefined) return;
  heldPaginatedPositions.delete(document);
  held.style.remove();
  scrollToPaginatedPosition(document, held.position, writingMode, direction);
}

/** Pagination advances on the physical axis produced by CSS multicolumn layout. */
export function paginatedMetrics(
  document: Document,
  writingMode = documentWritingMode(document),
  direction: DocumentDirection = documentFlow(document).direction,
): LogicalScrollMetrics | null {
  const view = document.defaultView;
  const scrollingElement = document.scrollingElement;
  if (view === null || scrollingElement === null) return null;
  const horizontal = writingMode === "horizontal-tb";
  const held = heldPaginatedPositions.get(document)?.position ?? 0;
  const viewport = horizontal ? view.innerWidth : view.innerHeight;
  const extent = held + (horizontal ? scrollingElement.scrollWidth : scrollingElement.scrollHeight);
  const raw = horizontal ? scrollingElement.scrollLeft : scrollingElement.scrollTop;
  const position = held + (direction === "rtl" ? Math.abs(raw) : raw);
  return { position: Math.max(0, position), maximum: Math.max(0, extent - viewport), viewport };
}

export function capturePaginatedGeometryContext(
  document: Document,
  flow = documentFlow(document),
): PaginatedGeometryContext | null {
  const metrics = paginatedMetrics(document, flow.writingMode, flow.direction);
  return metrics === null ? null : { flow, metrics };
}

export function paginatedRectangleOffsetFromContext(
  rectangle: Pick<DOMRect, "top" | "right" | "bottom" | "left">,
  boundary: PaginatedRectangleBoundary,
  context: PaginatedGeometryContext,
): number {
  const { flow, metrics } = context;
  const horizontal = flow.writingMode === "horizontal-tb";
  if (horizontal) {
    if (flow.direction === "rtl")
      return metrics.viewport - (boundary === "start" ? rectangle.right : rectangle.left);
    return boundary === "start" ? rectangle.left : rectangle.right;
  }
  if (flow.direction === "rtl")
    return metrics.viewport - (boundary === "start" ? rectangle.bottom : rectangle.top);
  return boundary === "start" ? rectangle.top : rectangle.bottom;
}

/** Maps a physical rectangle edge into the positive pagination progression axis. */
export function paginatedRectangleOffset(
  document: Document,
  rectangle: Pick<DOMRect, "top" | "right" | "bottom" | "left">,
  boundary: PaginatedRectangleBoundary,
  writingMode = documentWritingMode(document),
  direction: DocumentDirection = documentFlow(document).direction,
): number | null {
  const view = document.defaultView;
  if (view === null) return null;
  const horizontal = writingMode === "horizontal-tb";
  return paginatedRectangleOffsetFromContext(rectangle, boundary, {
    flow: { writingMode, direction },
    metrics: { position: 0, maximum: 0, viewport: horizontal ? view.innerWidth : view.innerHeight },
  });
}

export function scrollPaginatedBy(
  document: Document,
  delta: number,
  writingMode = documentWritingMode(document),
): void {
  const view = document.defaultView;
  const scrollingElement = document.scrollingElement;
  if (view === null || scrollingElement === null) return;
  const physicalDelta = documentFlow(document).direction === "rtl" ? -delta : delta;
  if (writingMode !== "horizontal-tb") scrollingElement.scrollTop += physicalDelta;
  else scrollingElement.scrollLeft += physicalDelta;
}

export function scrollToPaginatedPosition(
  document: Document,
  position: number,
  writingMode = documentWritingMode(document),
  direction: DocumentDirection = documentFlow(document).direction,
): void {
  const view = document.defaultView;
  const scrollingElement = document.scrollingElement;
  if (view === null || scrollingElement === null) return;
  if (heldPaginatedPositions.has(document)) {
    holdPaginatedPosition(document, position, writingMode, direction);
    if (writingMode !== "horizontal-tb") scrollingElement.scrollTop = 0;
    else scrollingElement.scrollLeft = 0;
    return;
  }
  const physicalPosition = direction === "rtl" ? -position : position;
  if (writingMode !== "horizontal-tb") scrollingElement.scrollTop = physicalPosition;
  else scrollingElement.scrollLeft = physicalPosition;
}

export function scrollByLogicalBlock(
  document: Document,
  delta: number,
  writingMode = documentWritingMode(document),
): void {
  const view = document.defaultView;
  if (view === null) return;
  if (writingMode === "horizontal-tb") view.scrollBy({ top: delta, behavior: "auto" });
  else view.scrollBy({ left: writingMode === "vertical-rl" ? -delta : delta, behavior: "auto" });
}

export function scrollToLogicalBlockPosition(
  document: Document,
  position: number,
  writingMode = documentWritingMode(document),
): void {
  const view = document.defaultView;
  if (view === null) return;
  if (writingMode === "horizontal-tb") view.scrollTo({ top: position });
  else view.scrollTo({ left: writingMode === "vertical-rl" ? -position : position });
}

export function scrollToDocumentBoundary(
  document: Document,
  boundary: "start" | "end",
  writingMode = documentWritingMode(document),
): void {
  const view = document.defaultView;
  const scrollingElement = document.scrollingElement;
  if (view === null || scrollingElement === null) return;
  if (writingMode === "horizontal-tb") {
    view.scrollTo({ top: boundary === "start" ? 0 : scrollingElement.scrollHeight });
  } else if (writingMode === "vertical-lr") {
    view.scrollTo({ left: boundary === "start" ? 0 : scrollingElement.scrollWidth });
  } else {
    view.scrollTo({ left: boundary === "start" ? 0 : -scrollingElement.scrollWidth });
  }
}

function normalizeWritingMode(value: string | undefined): DocumentWritingMode {
  if (value === "vertical-rl" || value === "sideways-rl") return "vertical-rl";
  if (value === "vertical-lr" || value === "sideways-lr") return "vertical-lr";
  return "horizontal-tb";
}
