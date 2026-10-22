import type { Boundary, DocumentLocatorObservation, VisibleTextMap } from "./types.js";
import type { DocumentObservationViewport } from "./observation.js";
import type { PointEvidence } from "../../../../generated/kernel.js";
import { codePointOffsetForUtf16 } from "./annotation.js";
import { initialContextLength, maximumContextLength } from "./types.js";
import { isElement } from "../../dom.js";

export function viewportPoints(
  writingMode: DocumentLocatorObservation["writingMode"],
  direction: DocumentLocatorObservation["direction"],
  width: number,
  height: number,
  viewport: DocumentObservationViewport | undefined,
): [
  {
    x: number;
    y: number;
  },
  {
    x: number;
    y: number;
  },
] {
  const right = Math.max(0, width - 1);
  const bottom = Math.max(0, height - 1);
  const physicalInline = (logical: number, extent: number) =>
    Math.min(
      Math.max(0, extent - 1),
      Math.max(0, direction === "rtl" ? extent - logical : logical),
    );
  if (writingMode === "vertical-rl") {
    return [
      {
        x: right,
        y:
          viewport === undefined ? height / 2 : physicalInline(viewport.logicalInlineStart, height),
      },
      {
        x: 0,
        y: viewport === undefined ? height / 2 : physicalInline(viewport.logicalInlineEnd, height),
      },
    ];
  }
  if (writingMode === "vertical-lr") {
    return [
      {
        x: 0,
        y:
          viewport === undefined ? height / 2 : physicalInline(viewport.logicalInlineStart, height),
      },
      {
        x: right,
        y: viewport === undefined ? height / 2 : physicalInline(viewport.logicalInlineEnd, height),
      },
    ];
  }
  return [
    {
      x: viewport === undefined ? width / 2 : physicalInline(viewport.logicalInlineStart, width),
      y: 0,
    },
    {
      x: viewport === undefined ? width / 2 : physicalInline(viewport.logicalInlineEnd, width),
      y: bottom,
    },
  ];
}

export function boundaryAtViewportPoint(document: Document, x: number, y: number): Boundary | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(x, y);
    if (position !== null) {
      const boundary = { node: position.offsetNode, offset: position.offset };
      if (boundaryIsNearViewportPoint(document, boundary, x, y)) return boundary;
    }
  }
  const legacy = document as Document & {
    caretRangeFromPoint?: ((x: number, y: number) => Range | null) | undefined;
  };
  const range = legacy.caretRangeFromPoint?.(x, y) ?? null;
  if (range === null) return null;
  const boundary = { node: range.startContainer, offset: range.startOffset };
  return boundaryIsNearViewportPoint(document, boundary, x, y) ? boundary : null;
}

export function boundaryIsNearViewportPoint(
  document: Document,
  boundary: Boundary,
  x: number,
  y: number,
): boolean {
  const range = document.createRange();
  if (typeof range.getBoundingClientRect !== "function") return true;
  try {
    range.setStart(boundary.node, boundary.offset);
    range.collapse(true);
    const rectangle = range.getBoundingClientRect();
    if (
      !Number.isFinite(rectangle.left) ||
      !Number.isFinite(rectangle.right) ||
      !Number.isFinite(rectangle.top) ||
      !Number.isFinite(rectangle.bottom)
    ) {
      return false;
    }
    const inlineTolerance = 16;
    const blockTolerance = 4;
    return (
      x >= rectangle.left - inlineTolerance &&
      x <= rectangle.right + inlineTolerance &&
      y >= rectangle.top - blockTolerance &&
      y <= rectangle.bottom + blockTolerance
    );
  } catch {
    return false;
  }
}

export function observedBoundaryNearViewportPoint(
  document: Document,
  textMap: VisibleTextMap,
  x: number,
  y: number,
  inlineStep: number,
  blockStep: number,
  maximumDistance: number,
  includeRenderedTextContext: boolean,
): {
  readonly observation: DocumentLocatorObservation["visibleStart"];
  readonly textOffset: number | null;
  readonly range: Range | null;
} {
  for (let distance = 0; distance <= maximumDistance; distance += 4) {
    const boundary = boundaryAtViewportPoint(
      document,
      x + inlineStep * distance,
      y + blockStep * distance,
    );
    if (boundary === null) continue;
    const textOffset = textOffsetForBoundary(textMap, boundary);
    const observation = evidenceForBoundary(
      document,
      textMap,
      boundary,
      textOffset,
      includeRenderedTextContext,
    );
    if (observation.state === "located") {
      const range = document.createRange();
      range.setStart(boundary.node, boundary.offset);
      range.collapse(true);
      return { observation, textOffset, range };
    }
  }
  return { observation: { state: "unavailable" }, textOffset: null, range: null };
}

export function viewportInwardDirections(writingMode: DocumentLocatorObservation["writingMode"]): [
  {
    x: number;
    y: number;
  },
  {
    x: number;
    y: number;
  },
] {
  if (writingMode === "vertical-rl")
    return [
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ];
  if (writingMode === "vertical-lr")
    return [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
    ];
  return [
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];
}

export function textOffsetForBoundary(
  textMap: VisibleTextMap,
  boundary: Boundary | null,
): number | null {
  if (boundary === null) return null;
  const exact = textMap.reverseBoundaries.get(boundary.node)?.get(boundary.offset);
  if (exact !== undefined) return exact;
  if (isElement(boundary.node)) {
    const element = boundary.node;
    const following = element.childNodes[boundary.offset];
    if (following !== undefined) {
      const span = textMap.spans.get(following);
      if (span !== undefined) return span.start;
    }
    const preceding = element.childNodes[boundary.offset - 1];
    if (preceding !== undefined) {
      const span = textMap.spans.get(preceding);
      if (span !== undefined) return span.end;
    }
  }
  return null;
}

export function evidenceForBoundary(
  document: Document,
  textMap: VisibleTextMap,
  boundary: Boundary | null,
  textOffset: number | null,
  includeRenderedTextContext = true,
): DocumentLocatorObservation["visibleStart"] {
  const textPosition: PointEvidence | null =
    textOffset === null
      ? null
      : {
          kind: "browser-text-position",
          offset: codePointOffsetForUtf16(textMap.text, textOffset),
        };
  const located = (evidence: PointEvidence): DocumentLocatorObservation["visibleStart"] => ({
    state: "located",
    evidence: textPosition === null ? [evidence] : [evidence, textPosition],
  });
  const root = document.body ?? document.documentElement;
  if (boundary !== null && root !== null) {
    if (boundaryIsAtElementStart(boundary, root)) {
      return located({ kind: "document-boundary", boundary: "start" });
    }
    if (boundaryIsAtElementEnd(boundary, root)) {
      return located({ kind: "document-boundary", boundary: "end" });
    }
  }
  if (textOffset !== null && includeRenderedTextContext) {
    const context = createUniqueTextContext(textMap.text, textOffset);
    if (context !== null) return located(context);
  }
  if (textPosition !== null) return { state: "located", evidence: [textPosition] };
  const identified = boundary === null ? null : identifiedElementStartingAt(boundary);
  if (identified !== null) {
    return located({ kind: "html-fragment", value: identified.id });
  }
  return { state: "unavailable" };
}

export function createUniqueTextContext(
  text: string,
  offset: number,
): Extract<
  PointEvidence,
  {
    kind: "rendered-text-context";
  }
> | null {
  for (
    let length = initialContextLength;
    length <= maximumContextLength;
    length = Math.min(maximumContextLength, length * 2)
  ) {
    const before = text.slice(Math.max(0, offset - length), offset);
    const after = text.slice(offset, offset + length);
    if (before.length > 0 || after.length > 0) {
      const context = before + after;
      const expected = offset - before.length;
      const first = text.indexOf(context);
      if (first === expected && text.indexOf(context, first + 1) === -1) {
        return { kind: "rendered-text-context", before, after };
      }
    }
    if (length === maximumContextLength) break;
  }
  return null;
}

export function identifiedElementStartingAt(boundary: Boundary): Element | null {
  let element = isElement(boundary.node) ? boundary.node : boundary.node.parentElement;
  while (element !== null) {
    if (element.id.length > 0 && boundaryIsAtElementStart(boundary, element)) return element;
    element = element.parentElement;
  }
  return null;
}

export function boundaryIsAtElementStart(boundary: Boundary, element: Element): boolean {
  if (boundary.offset !== 0) return false;
  let node: Node = boundary.node;
  while (node !== element) {
    const parent = node.parentNode;
    if (parent === null || parent.firstChild !== node) return false;
    node = parent;
  }
  return true;
}

export function boundaryIsAtElementEnd(boundary: Boundary, element: Element): boolean {
  let node: Node = boundary.node;
  if (boundary.offset !== boundaryLength(node)) return false;
  while (node !== element) {
    const parent = node.parentNode;
    if (parent === null || parent.lastChild !== node) return false;
    node = parent;
  }
  return true;
}

export function boundaryLength(node: Node): number {
  return node.nodeType === Node.TEXT_NODE ? (node.nodeValue?.length ?? 0) : node.childNodes.length;
}

export function rangeRectangle(range: Range): DOMRect | null {
  for (const rectangle of range.getClientRects()) {
    if (rectangleIsRendered(rectangle)) return rectangle;
  }
  const rectangle = range.getBoundingClientRect();
  return rectangleIsRendered(rectangle) ? rectangle : null;
}

export function renderedElementRectangle(element: Element): DOMRect | null {
  const rectangle = element.getBoundingClientRect();
  return rectangleIsRendered(rectangle) ? rectangle : null;
}

export function rectangleIsRendered(rectangle: DOMRect): boolean {
  return (
    Number.isFinite(rectangle.top) &&
    Number.isFinite(rectangle.right) &&
    Number.isFinite(rectangle.bottom) &&
    Number.isFinite(rectangle.left) &&
    (rectangle.width > 0 || rectangle.height > 0)
  );
}
