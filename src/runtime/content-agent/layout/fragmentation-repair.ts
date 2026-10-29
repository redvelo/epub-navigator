import type { AgentWork } from "../operation-queue.js";
import type { ContentAgentState } from "../state.js";
import type { DocumentWritingMode } from "./document-scroll.js";
import type { ReflowablePresentation } from "../../../generated/kernel.js";
import type { FragmentationRepair } from "../state.js";
import {
  captureBodyInsets,
  columnInlineSize,
  cssPixels,
  lineOutsideBlockViewport,
  paginationGeometry,
  recordTextAssessmentDiagnostics,
} from "./pagination-geometry.js";
import {
  captureSettlementVersion,
  layoutSnapshotIsCurrent,
  yieldLayoutWork,
} from "./reflow-transaction.js";
import {
  cooperativeLayoutMinimumWorkUnits,
  cooperativeLayoutSliceMs,
  fragmentationMarkerAttribute,
} from "./constants.js";
import { documentFlow } from "./document-scroll.js";
import { navigatorReaderPreferenceValues } from "../../preference-values.js";

type PaginationGeometry = ReturnType<typeof paginationGeometry>;

/**
 * The least a block of prose may be left with: the greater of a share of its column and a count
 * of characters. Below it, an authored indent is no longer an indent but a sliver that sets a
 * word to a line, so the indent is scaled to the column instead, as a compositor would re-set
 * an epigraph for a narrower page. The share keeps a wide column's indents in proportion; the
 * count keeps a narrow column's prose readable, which on a phone means taking the indent away
 * almost entirely.
 */
const MINIMUM_PROSE_MEASURE = 0.6;
const MINIMUM_PROSE_CHARACTERS = 18;
/** A fair advance for one character of running text, in ems, across the reader's faces. */
const CHARACTER_ADVANCE_EM = 0.5;

const FONT_SCALE_STEPS = navigatorReaderPreferenceValues.fontScale.map(Number);

/**
 * How small a scaled table may go. Two limits, and the more generous one holds: the smallest
 * text size the reader offers, which is the reader's own judgement of the least a person may be
 * asked to read, and one reader step below the size being read at, so that the smallest size
 * still has a step to give. Below the smallest step the steps' own ratio is taken once more.
 */
export function tableScaleFloor(state: ContentAgentState, fontScale: number): number {
  void state;
  const smallest = FONT_SCALE_STEPS[0] ?? fontScale;
  const next = FONT_SCALE_STEPS[1] ?? smallest;
  const index = FONT_SCALE_STEPS.indexOf(fontScale);
  const stepBelow =
    (index > 0 ? FONT_SCALE_STEPS[index - 1] : undefined) ?? (smallest * smallest) / next;
  return Math.min(smallest, stepBelow) / fontScale;
}

/** A table is scaled a little past exact, because the browser re-rounds its columns under zoom. */
const FIT_TOLERANCE = 0.97;
/**
 * How far past its column a box may reach before scaling is worth it. A collapsed border or a
 * rounding step puts a full-width table a pixel or two over, and losing that sliver at the
 * edge is nothing next to resetting the whole table smaller.
 */
const FIT_ALLOWANCE = 0.01;

export async function assessLayoutRepairs(
  state: ContentAgentState,
  presentation: ReflowablePresentation,
  work: AgentWork,
  invalidationVersion: number,
  settlementVersion: ReturnType<typeof captureSettlementVersion>,
): Promise<{
  repairs: FragmentationRepair[];
  unresolvedElements: number;
  /** Whether something too wide for its column would fit the whole flow as one column. */
  wideContentFitsOneColumn: boolean;
} | null> {
  void state;
  if (!layoutRepairAssessmentRequired(state, presentation) || document.body === null) {
    return { repairs: [], unresolvedElements: 0, wideContentFitsOneColumn: false };
  }
  const writingMode = documentFlow(document).writingMode;
  const geometry = paginationGeometry(
    state,
    writingMode,
    state.layout.authoredBodyInsets ?? captureBodyInsets(state),
    presentation.paginationColumns,
  );
  const repairs: FragmentationRepair[] = [];
  let unresolvedElements = 0;
  const started = performance.now();
  const counters = {
    paragraphCount: 0,
    displayCandidateCount: 0,
    rectangleCount: 0,
    textRangeScanCount: 0,
  };
  let sliceStarted = started;
  let sliceWorkUnits = 0;
  const column = columnInlineSize(state, geometry);
  const yieldIfDue = async (): Promise<boolean> => {
    if (
      sliceWorkUnits >= cooperativeLayoutMinimumWorkUnits &&
      performance.now() - sliceStarted >= cooperativeLayoutSliceMs
    ) {
      await yieldLayoutWork(state, work);
      if (!layoutSnapshotIsCurrent(state, invalidationVersion, settlementVersion)) return false;
      sliceStarted = performance.now();
      sliceWorkUnits = 0;
    }
    return true;
  };
  for (const element of document.body.querySelectorAll<HTMLElement>("p, blockquote, div")) {
    sliceWorkUnits += 1;
    counters.paragraphCount += 1;
    const measurement =
      element.localName === "p"
        ? measureFragmentationCandidate(
            state,
            element,
            writingMode,
            geometry.columnBlockSize,
            counters,
          )
        : null;
    if (measurement !== null) {
      if (fragmentationCandidateIsSafe(state, element, measurement, geometry.columnBlockSize)) {
        repairs.push({
          element,
          marker: allocateFragmentationMarker(state),
          remedy: { kind: "block-flow" },
        });
      } else {
        unresolvedElements += 1;
      }
    } else {
      const remedy = starvedMeasureRemedy(state, element, writingMode, column);
      if (remedy !== null) {
        repairs.push({ element, marker: allocateFragmentationMarker(state), remedy });
      }
    }
    if (!(await yieldIfDue())) return null;
  }
  let wideContentFitsOneColumn = false;
  for (const element of document.body.querySelectorAll<HTMLElement>("table, pre")) {
    sliceWorkUnits += 1;
    const fit = inlineFitRemedy(state, element, writingMode, geometry, presentation);
    if (fit === null) continue;
    if (fit.kind === "unresolved") {
      unresolvedElements += 1;
      wideContentFitsOneColumn ||= fit.fitsOneColumn;
    } else {
      repairs.push({ element, marker: allocateFragmentationMarker(state), remedy: fit });
    }
    if (!(await yieldIfDue())) return null;
  }
  recordTextAssessmentDiagnostics(state, counters, started);
  return { repairs, unresolvedElements, wideContentFitsOneColumn };
}

/**
 * How far along the inline axis an element's content reaches: its box in the column it starts
 * in, or further where content overflows a box that does not grow with it, as a line of code
 * overflows its `pre`.
 */
export function contentInlineExtent(
  state: ContentAgentState,
  element: Element,
  writingMode: DocumentWritingMode,
): number {
  // Scroll extents are measured inside the element's own zoom; client rects are not.
  const zoom = Number(getComputedStyle(element).zoom) || 1;
  const overflow = writingMode === "horizontal-tb" ? element.scrollWidth : element.scrollHeight;
  return Math.max(firstFragmentInlineSize(state, element, writingMode), overflow * zoom);
}

/** The inline size of the element's first fragment: its box in the column it starts in. */
export function firstFragmentInlineSize(
  state: ContentAgentState,
  element: Element,
  writingMode: DocumentWritingMode,
): number {
  void state;
  const fragment = element.getClientRects()[0];
  if (fragment === undefined) return 0;
  return writingMode === "horizontal-tb" ? fragment.width : fragment.height;
}

/**
 * Scales the inline margins of a block the column has starved of its measure.
 *
 * Only an ordinary block that fills its column, or overflows it, is a candidate. A box set to
 * its own width short of the column keeps its author's geometry, and a box in a table, flex or
 * grid parent is laid out by rules the margins do not own. The scaling keeps the
 * margins in their authored proportion, so a hanging indent still hangs and a centred box stays
 * centred; only how far the prose is pushed changes.
 */
export function starvedMeasureRemedy(
  state: ContentAgentState,
  element: HTMLElement,
  writingMode: DocumentWritingMode,
  column: number,
): Extract<FragmentationRepair["remedy"], { kind: "inline-margins" }> | null {
  void state;
  if (element.hasAttribute(fragmentationMarkerAttribute) || element.parentElement === null)
    return null;
  const style = getComputedStyle(element);
  if (
    style.display !== "block" ||
    style.position !== "static" ||
    style.cssFloat !== "none" ||
    layoutModelIsIndependent(state, getComputedStyle(element.parentElement).display) ||
    (element.textContent?.trim().length ?? 0) === 0
  ) {
    return null;
  }
  const start = cssPixels(state, style.marginInlineStart);
  const end = cssPixels(state, style.marginInlineEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0 || start + end <= 0)
    return null;
  // A block that fills its column, or that its margins have pushed past the column's edge,
  // which leaves it no box at all.
  const borderBox = firstFragmentInlineSize(state, element, writingMode);
  if (borderBox + start + end < column - 1) return null;
  const edgeSize = inlineEdgeSize(state, style, writingMode);
  const characters =
    MINIMUM_PROSE_CHARACTERS * CHARACTER_ADVANCE_EM * (cssPixels(state, style.fontSize) || 0);
  const measure = Math.round(
    Math.min(column - edgeSize, Math.max(column * MINIMUM_PROSE_MEASURE, characters)),
  );
  if (borderBox - edgeSize >= measure) return null;
  const scale = Math.max(0, column - measure - edgeSize) / (start + end);
  return {
    kind: "inline-margins",
    start: Math.round(start * scale * 100) / 100,
    end: Math.round(end * scale * 100) / 100,
    measure,
  };
}

/** The padding and borders along the inline axis, which a box's measure does not include. */
function inlineEdgeSize(
  state: ContentAgentState,
  style: CSSStyleDeclaration,
  writingMode: DocumentWritingMode,
): number {
  const edges =
    writingMode === "horizontal-tb"
      ? [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth]
      : [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth];
  return edges.reduce((total, edge) => total + (cssPixels(state, edge) || 0), 0);
}

/**
 * Scales a table or a block of preformatted text wider than its column down to fit, or says
 * that it cannot.
 *
 * Neither can be narrower than its longest unbreakable run, so one set for a wide page overflows
 * a narrow column and is clipped at the page edge. Scaling it whole keeps every column in
 * proportion and every word unbroken. It stops at the reader's smallest text size, or one step
 * below the size being read at, whichever is smaller. Past that a block of code may still wrap,
 * since a wrapped line of code reads where a wrapped table does not; a table is reported, with
 * whether one column of the whole flow would have held it, and the reader decides what to do
 * with a page it cannot set.
 */
export function inlineFitRemedy(
  state: ContentAgentState,
  element: HTMLElement,
  writingMode: DocumentWritingMode,
  geometry: PaginationGeometry,
  presentation: ReflowablePresentation,
):
  | Extract<FragmentationRepair["remedy"], { kind: "inline-fit" | "wrap" }>
  | { kind: "unresolved"; fitsOneColumn: boolean }
  | null {
  void state;
  if (
    element.hasAttribute(fragmentationMarkerAttribute) ||
    element.parentElement?.closest("table, pre") !== null
  ) {
    return null;
  }
  const style = getComputedStyle(element);
  const preformatted = element.localName === "pre";
  if ((preformatted ? style.display !== "block" : style.display !== "table") || style.zoom !== "1")
    return null;
  const column = columnInlineSize(state, geometry);
  const inlineSize = contentInlineExtent(state, element, writingMode);
  if (inlineSize <= column * (1 + FIT_ALLOWANCE) + 1) return null;
  // The floor is judged on the fit itself; the rounding allowance is not a shrink anyone reads.
  const fit = column / inlineSize;
  const floor = tableScaleFloor(state, Number(presentation.fontScale));
  if (fit >= floor) {
    const zoom = Math.floor(fit * FIT_TOLERANCE * 1000) / 1000;
    return { kind: "inline-fit", zoom, inlineSize: column };
  }
  if (preformatted) return { kind: "wrap", inlineSize: column };
  const oneColumn = geometry.flowInlineSize - geometry.inlineBorderAndPadding;
  return { kind: "unresolved", fitsOneColumn: oneColumn / inlineSize >= floor };
}

export function layoutRepairAssessmentRequired(
  state: ContentAgentState,
  presentation: ReflowablePresentation,
): boolean {
  void state;
  // Future complete-negative source facts may add a conservative bypass here.
  return presentation.mode === "paginated";
}

export function allocateFragmentationMarker(state: ContentAgentState): string {
  void state;
  let marker: string;
  do {
    marker = `m3-${++state.layout.fragmentationMarkerSequence}`;
  } while (document.querySelector(`[${fragmentationMarkerAttribute}="${marker}"]`) !== null);
  return marker;
}

export interface FragmentationCandidateMeasurement {
  readonly style: CSSStyleDeclaration;
  readonly blockSize: number;
  readonly hasText: boolean;
  readonly textBlockExtent: number;
}

export function measureFragmentationCandidate(
  state: ContentAgentState,
  element: HTMLElement,
  writingMode: DocumentWritingMode,
  columnBlockSize: number,
  counters: {
    displayCandidateCount: number;
    rectangleCount: number;
    textRangeScanCount: number;
  },
): FragmentationCandidateMeasurement | null {
  void state;
  const style = getComputedStyle(element);
  if (style.display !== "inline-block") return null;
  counters.displayCandidateCount += 1;
  const rectangle = element.getBoundingClientRect();
  counters.rectangleCount += 1;
  const blockSize = writingMode === "horizontal-tb" ? rectangle.height : rectangle.width;
  if (blockSize <= columnBlockSize + 1) return null;
  const hasText = (element.textContent?.trim().length ?? 0) > 0;
  if (!hasText) return null;
  counters.textRangeScanCount += 1;
  const textBlockExtent = renderedTextBlockExtent(state, element, writingMode);
  if (textBlockExtent <= columnBlockSize + 1) return null;
  return {
    style,
    blockSize,
    hasText,
    textBlockExtent,
  };
}

export function fragmentationCandidateIsSafe(
  state: ContentAgentState,
  element: HTMLElement,
  measurement: FragmentationCandidateMeasurement,
  columnBlockSize: number,
): boolean {
  void state;
  if (element.hasAttribute(fragmentationMarkerAttribute) || element.parentElement === null)
    return false;
  const { style, blockSize, hasText, textBlockExtent } = measurement;
  if (
    style.display !== "inline-block" ||
    blockSize <= columnBlockSize + 1 ||
    !hasText ||
    style.position !== "static" ||
    style.cssFloat !== "none" ||
    style.transform !== "none" ||
    style.contain !== "none" ||
    style.overflowX !== "visible" ||
    style.overflowY !== "visible" ||
    style.columnCount !== "auto" ||
    style.breakInside !== "auto" ||
    style.pageBreakInside === "avoid" ||
    Math.abs(cssPixels(state, style.marginInlineStart)) > 1 ||
    Math.abs(cssPixels(state, style.marginInlineEnd)) > 1 ||
    !Number.isFinite(cssPixels(state, style.inlineSize)) ||
    cssPixels(state, style.inlineSize) <= 0
  ) {
    return false;
  }
  const parentStyle = getComputedStyle(element.parentElement);
  if (
    parentStyle.textAlign !== "center" ||
    layoutModelIsIndependent(state, parentStyle.display) ||
    !isOnlyRenderedChild(state, element)
  ) {
    return false;
  }
  for (
    let ancestor: HTMLElement | null = element.parentElement;
    ancestor !== null && ancestor !== document.body;
    ancestor = ancestor.parentElement
  ) {
    const ancestorStyle = getComputedStyle(ancestor);
    if (
      ancestor.localName === "figure" ||
      layoutModelIsIndependent(state, ancestorStyle.display) ||
      ancestorStyle.display === "inline-block" ||
      ancestorStyle.position !== "static" ||
      ancestorStyle.cssFloat !== "none" ||
      ancestorStyle.transform !== "none" ||
      ancestorStyle.contain !== "none" ||
      ancestorStyle.overflowX !== "visible" ||
      ancestorStyle.overflowY !== "visible" ||
      ancestorStyle.columnCount !== "auto" ||
      ancestorStyle.breakInside === "avoid"
    ) {
      return false;
    }
  }
  if (
    element.querySelector(
      "img, picture, video, audio, canvas, object, embed, iframe, svg, math, table",
    ) !== null
  ) {
    return false;
  }
  for (const descendant of element.querySelectorAll<HTMLElement>("*")) {
    const descendantStyle = getComputedStyle(descendant);
    if (
      layoutModelIsIndependent(state, descendantStyle.display) ||
      descendantStyle.display === "inline-block" ||
      descendantStyle.position !== "static" ||
      descendantStyle.cssFloat !== "none" ||
      descendantStyle.transform !== "none" ||
      descendantStyle.contain !== "none" ||
      descendantStyle.overflowX !== "visible" ||
      descendantStyle.overflowY !== "visible" ||
      descendantStyle.columnCount !== "auto" ||
      descendantStyle.breakInside !== "auto" ||
      descendantStyle.pageBreakInside === "avoid"
    ) {
      return false;
    }
  }
  return textBlockExtent > columnBlockSize + 1;
}

export function layoutModelIsIndependent(state: ContentAgentState, display: string): boolean {
  void state;
  return (
    display.includes("flex") ||
    display.includes("grid") ||
    display === "table" ||
    display.startsWith("table-")
  );
}

export function isOnlyRenderedChild(state: ContentAgentState, element: Element): boolean {
  void state;
  for (const sibling of element.parentNode?.childNodes ?? []) {
    if (sibling === element) continue;
    if (sibling.nodeType === Node.TEXT_NODE && sibling.nodeValue?.trim().length === 0) continue;
    if (sibling instanceof Element) {
      const rectangle = sibling.getBoundingClientRect();
      if (rectangle.width <= 0 && rectangle.height <= 0) continue;
    }
    return false;
  }
  return true;
}

export function renderedTextBlockExtent(
  state: ContentAgentState,
  element: Element,
  writingMode: DocumentWritingMode,
): number {
  void state;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeValue?.trim().length === 0) continue;
    range.selectNodeContents(node);
    for (const rectangle of range.getClientRects()) {
      if (writingMode === "horizontal-tb") {
        start = Math.min(start, rectangle.top);
        end = Math.max(end, rectangle.bottom);
      } else {
        start = Math.min(start, rectangle.left);
        end = Math.max(end, rectangle.right);
      }
    }
  }
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
}

export function setFragmentationRepairs(
  state: ContentAgentState,
  repairs: FragmentationRepair[],
): void {
  void state;
  clearFragmentationRepairMarkers(state);
  state.layout.fragmentationRepairs = repairs.filter(
    (repair) =>
      repair.element.isConnected && !repair.element.hasAttribute(fragmentationMarkerAttribute),
  );
  state.layout.activeFragmentationMarkers = new WeakMap();
  for (const repair of state.layout.fragmentationRepairs) {
    state.layout.activeFragmentationMarkers.set(repair.element, repair.marker);
    repair.element.setAttribute(fragmentationMarkerAttribute, repair.marker);
  }
}

export function clearFragmentationRepairs(state: ContentAgentState): void {
  void state;
  clearFragmentationRepairMarkers(state);
  state.layout.fragmentationRepairs = [];
  state.layout.activeFragmentationMarkers = new WeakMap();
}

export function clearFragmentationRepairMarkers(state: ContentAgentState): void {
  void state;
  for (const repair of state.layout.fragmentationRepairs) {
    if (repair.element.getAttribute(fragmentationMarkerAttribute) === repair.marker) {
      state.layout.removedFragmentationMarkers.set(repair.element, repair.marker);
      state.layout.activeFragmentationMarkers.delete(repair.element);
      repair.element.removeAttribute(fragmentationMarkerAttribute);
    }
  }
}

export function fragmentationRepairsAreEffective(state: ContentAgentState): boolean {
  return ineffectiveFragmentationRepairs(state).length === 0;
}

/**
 * The repairs the browser did not take, or took without the result they were for. Each is
 * judged alone: one box a remedy cannot help says nothing about the others on the page.
 */
export function ineffectiveFragmentationRepairs(state: ContentAgentState): FragmentationRepair[] {
  void state;
  const writingMode = documentFlow(document).writingMode;
  return state.layout.fragmentationRepairs.filter((repair) => {
    if (
      !repair.element.isConnected ||
      repair.element.getAttribute(fragmentationMarkerAttribute) !== repair.marker
    ) {
      return true;
    }
    const remedy = repair.remedy;
    const style = getComputedStyle(repair.element);
    if (remedy.kind === "inline-margins") {
      const measure =
        firstFragmentInlineSize(state, repair.element, writingMode) -
        inlineEdgeSize(state, style, writingMode);
      return !(
        Math.abs(cssPixels(state, style.marginInlineStart) - remedy.start) <= 1 &&
        Math.abs(cssPixels(state, style.marginInlineEnd) - remedy.end) <= 1 &&
        measure >= remedy.measure - 1
      );
    }
    if (remedy.kind === "inline-fit") {
      return !(
        Math.abs(Number(style.zoom) - remedy.zoom) < 0.001 &&
        contentInlineExtent(state, repair.element, writingMode) <= remedy.inlineSize + 1
      );
    }
    if (remedy.kind === "wrap") {
      return !(
        style.whiteSpace === "pre-wrap" &&
        contentInlineExtent(state, repair.element, writingMode) <= remedy.inlineSize + 1
      );
    }
    return !(
      style.display === "block" &&
      fragmentedTextFitsBlockViewport(state, repair.element, writingMode)
    );
  });
}

export function fragmentedTextFitsBlockViewport(
  state: ContentAgentState,
  element: Element,
  writingMode: DocumentWritingMode,
): boolean {
  void state;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeValue?.trim().length === 0) continue;
    range.selectNodeContents(node);
    for (const rectangle of range.getClientRects()) {
      if (lineOutsideBlockViewport(state, rectangle, writingMode)) return false;
    }
  }
  return true;
}

export function lineHeightValue(
  state: ContentAgentState,
  lineHeight: ReflowablePresentation["lineHeight"],
): string {
  void state;
  switch (lineHeight) {
    case "1.25":
      return "1.25";
    case "1.5":
      return "1.5";
    case "1.75":
      return "1.75";
    case "2":
      return "2";
    default:
      return "normal";
  }
}
