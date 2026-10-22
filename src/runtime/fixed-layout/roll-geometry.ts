export interface RollPage {
  readonly occurrence: number;
  readonly ratio: number;
}

export const ROLL_MAX_LIVE_CHILDREN = 12;
// Leave one slot for an explicit navigation or primary-frame replacement.
export const ROLL_WINDOW_BUDGET = ROLL_MAX_LIVE_CHILDREN - 1;
export const ROLL_MAX_LOADING_CHILDREN = 2;

export interface RollBox {
  readonly occurrence: number;
  readonly top: number;
  readonly height: number;
}

/** Unknown pages reserve a square until their trusted agent reports authored dimensions. */
export function rollBoxes(pages: readonly RollPage[], width: number): RollBox[] {
  let top = 0;
  return pages.map(({ occurrence, ratio }) => {
    const height = width * ratio;
    const box = { occurrence, top, height };
    top += height;
    return box;
  });
}

export function rollWindow(boxes: readonly RollBox[], top: number, height: number): RollBox[] {
  const visible: RollBox[] = [];
  const nearby: RollBox[] = [];
  for (const box of boxes) {
    if (box.top + box.height <= top - height) continue;
    if (box.top >= top + height * 2) break;
    if (box.top + box.height > top && box.top < top + height) {
      if (visible.length < ROLL_WINDOW_BUDGET) visible.push(box);
    } else if (nearby.length < ROLL_WINDOW_BUDGET) nearby.push(box);
  }
  return [...visible, ...nearby.slice(0, ROLL_WINDOW_BUDGET - visible.length)].sort(
    (a, b) => a.top - b.top,
  );
}

export const ROLL_PREVIEW_BUDGET = 8;

/**
 * Stand-in page images are cheap next to a mounted child, so they lead the mounted window:
 * an entering frame is not composited until it is exposed, and the image must already be there.
 */
export function rollPreviewWindow(
  boxes: readonly RollBox[],
  top: number,
  height: number,
): RollBox[] {
  const candidates: RollBox[] = [];
  for (const box of boxes) {
    if (box.top + box.height <= top - height * 2) continue;
    if (box.top >= top + height * 3) break;
    candidates.push(box);
  }
  if (candidates.length <= ROLL_PREVIEW_BUDGET) return candidates;
  const gap = (box: RollBox) => Math.max(0, top - (box.top + box.height), box.top - (top + height));
  return [...candidates]
    .sort((a, b) => gap(a) - gap(b))
    .slice(0, ROLL_PREVIEW_BUDGET)
    .sort((a, b) => a.top - b.top);
}

/**
 * The scroll offsets a page can actually occupy. The scroller stops when the stack's end meets
 * the viewport's end, so the offsets past that are unreachable and cannot express a position.
 */
export function rollReachableSpan(
  boxes: readonly RollBox[],
  box: RollBox,
  viewport: number,
): { start: number; end: number } {
  const last = boxes.at(-1);
  const total = last === undefined ? 0 : last.top + last.height;
  const maximum = Math.max(0, total - viewport);
  return { start: Math.min(box.top, maximum), end: Math.min(box.top + box.height, maximum) };
}

export function rollAnchor(
  boxes: readonly RollBox[],
  top: number,
  viewport = 0,
): {
  occurrence: number;
  fraction: number;
} | null {
  const last = boxes.at(-1);
  if (last === undefined) return null;
  // Bottoming out is the end of the book, even when its last page is shorter than the viewport
  // and so never reaches the top edge.
  if (viewport > 0 && top >= Math.max(0, last.top + last.height - viewport)) {
    return { occurrence: last.occurrence, fraction: 1 };
  }
  // Native scroll offsets may round while authored aspect-ratio boundaries remain fractional.
  const box =
    boxes.find(
      (candidate) => candidate.top + candidate.height > top + Math.min(1, candidate.height / 100),
    ) ?? last;
  return {
    occurrence: box.occurrence,
    fraction: Math.max(0, Math.min(1, (top - box.top) / box.height)),
  };
}
