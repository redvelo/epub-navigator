import type { ContentAgentState } from "../state.js";
import type { ReflowablePresentation } from "../../../generated/kernel.js";
import {
  captureBodyInsets,
  centredBlockGeometry,
  closeCssPixels,
  effectiveColumns,
  paginationGeometry,
} from "./pagination-geometry.js";
import { documentFlow } from "./document-scroll.js";

export function requiredPresentationIsEffective(
  state: ContentAgentState,
  presentation: ReflowablePresentation,
  minimumExtent = 0,
): boolean {
  void state;
  if (presentation.mode !== "paginated") return true;
  const rootElement = document.documentElement;
  const root = getComputedStyle(rootElement);
  const flow = documentFlow(document);
  const flowRoot = document.body ?? rootElement;
  const columns = getComputedStyle(flowRoot);
  const geometry = paginationGeometry(
    state,
    flow.writingMode,
    state.layout.authoredBodyInsets ?? captureBodyInsets(state),
    presentation.paginationColumns,
  );
  const horizontal = flow.writingMode === "horizontal-tb";
  const block = centredBlockGeometry(state, geometry);
  const expectedWidth = horizontal ? geometry.flowInlineSize : geometry.flowBlockSize;
  const expectedHeight = horizontal ? geometry.flowBlockSize : geometry.flowInlineSize;
  const scrollingElement = document.scrollingElement;
  if (scrollingElement === null) return false;
  const extent = horizontal ? scrollingElement.scrollWidth : scrollingElement.scrollHeight;
  const viewportExtent = horizontal ? window.innerWidth : window.innerHeight;
  const expectedColumns = effectiveColumns(
    state,
    presentation.paginationColumns,
    horizontal ? window.innerWidth : window.innerHeight,
    geometry.gap,
  );
  const fallbackColumnSizing = state.layout.singleColumnPaginationFallback && expectedColumns === 1;
  const rootEffective =
    root.position === "relative" &&
    root.boxSizing === "border-box" &&
    root.overflow === "hidden" &&
    closeCssPixels(state, root.width, window.innerWidth) &&
    closeCssPixels(state, root.height, window.innerHeight) &&
    closeCssPixels(state, root.marginTop, 0) &&
    closeCssPixels(state, root.marginRight, 0) &&
    closeCssPixels(state, root.marginBottom, 0) &&
    closeCssPixels(state, root.marginLeft, 0) &&
    closeCssPixels(state, root.paddingTop, 0) &&
    closeCssPixels(state, root.paddingRight, 0) &&
    closeCssPixels(state, root.paddingBottom, 0) &&
    closeCssPixels(state, root.paddingLeft, 0) &&
    closeCssPixels(state, root.borderTopWidth, 0) &&
    closeCssPixels(state, root.borderRightWidth, 0) &&
    closeCssPixels(state, root.borderBottomWidth, 0) &&
    closeCssPixels(state, root.borderLeftWidth, 0);
  const columnEffective =
    columns.columnFill === "auto" &&
    (fallbackColumnSizing
      ? (columns.columnCount === "auto" || columns.columnCount === "1") &&
        closeCssPixels(state, columns.columnWidth, expectedWidth)
      : columns.columnCount === String(expectedColumns) && columns.columnWidth === "auto") &&
    closeCssPixels(state, columns.columnGap, geometry.gap);
  const flowRootEffective =
    flowRoot === rootElement ||
    (columns.display === "block" &&
      columns.boxSizing === "border-box" &&
      columns.overflow === "visible" &&
      closeCssPixels(state, columns.width, horizontal ? expectedWidth : block.blockSize) &&
      closeCssPixels(state, columns.height, horizontal ? block.blockSize : expectedHeight) &&
      closeCssPixels(state, columns.marginInlineStart, geometry.inset) &&
      closeCssPixels(state, columns.marginInlineEnd, geometry.inset) &&
      closeCssPixels(state, columns.marginBlockStart, block.blockStart) &&
      closeCssPixels(state, columns.marginBlockEnd, block.blockEnd) &&
      closeCssPixels(state, columns.minWidth, 0) &&
      closeCssPixels(state, columns.minHeight, 0) &&
      columns.maxWidth === "none" &&
      columns.maxHeight === "none");
  return (
    rootEffective &&
    columnEffective &&
    flowRootEffective &&
    extent + 1 >= Math.max(viewportExtent, minimumExtent)
  );
}
