import type {
  Boundary,
  CapturedDocumentSelection,
  DocumentSelectionCapture,
  DocumentSelectionCaptureBasis,
  DocumentSelectionGeometryBasis,
  DocumentTextRangeMapping,
  DocumentTextSnapshot,
  ResolverWorkMeter,
  SelectionCaptureRect,
  VisibleTextMap,
} from "./types.js";
import type { RangeEvidence } from "../../../../generated/kernel.js";
import {
  chargeResolverWork,
  createsRenderedBoundary,
  elementBoundary,
  elementIsPruned,
  sameRange,
  textNodeIsVisible,
} from "./evidence.js";
import { codePointOffsetForUtf16 } from "./annotation.js";
import {
  documentTextIndexes,
  htmlWhitespace,
  maximumGeneratedStringBytes,
  maximumQuoteBytes,
  selectionQuoteContextLength,
} from "./types.js";
import { evidenceForBoundary, textOffsetForBoundary } from "./viewport.js";
import { isElement } from "../../dom.js";

/** Invalidates rendered-text facts after any potentially relevant DOM or style change. */
export function invalidateDocumentTextIndex(document: Document): void {
  const state = documentTextIndexes.get(document);
  if (state !== undefined) {
    state.index = null;
    state.generation += 1;
  }
}

/** Monotonic local content basis used to reject annotation work spanning mutations. */
export function documentTextGeneration(document: Document): number {
  let state = documentTextIndexes.get(document);
  if (state === undefined) {
    state = { index: null, builds: 0, generation: 0 };
    documentTextIndexes.set(document, state);
  }
  return state.generation;
}

/** Captures rendered text after current DOM and CSSOM state has been applied by the browser. */
export function createDocumentTextSnapshot(document: Document): DocumentTextSnapshot {
  const index = createVisibleTextMap(document);
  return storeDocumentTextSnapshot(document, index);
}

export function documentTextSnapshotIsCurrent(snapshot: DocumentTextSnapshot): boolean {
  return documentTextIndexes.get(snapshot.document)?.generation === snapshot.generation;
}

/** Maps a live range onto one rendered-text snapshot without changing its DOM boundaries. */
export function mapRangeToDocumentText(
  document: Document,
  range: Range,
  snapshot: DocumentTextSnapshot,
): DocumentTextRangeMapping | null {
  const map = textMapFromSnapshot(document, snapshot);
  const start = textOffsetForBoundary(map, {
    node: range.startContainer,
    offset: range.startOffset,
  });
  const end = textOffsetForBoundary(map, { node: range.endContainer, offset: range.endOffset });
  if (start === null || end === null || start > end) return null;
  return {
    start,
    end,
    codePointStart: codePointOffsetForUtf16(map.text, start),
    codePointEnd: codePointOffsetForUtf16(map.text, end),
    exact: map.text.slice(start, end),
  };
}

/** Returns the rendered-text span contributed by an element on one snapshot basis. */
export function mapElementToDocumentText(
  document: Document,
  element: Element,
  snapshot: DocumentTextSnapshot,
): DocumentTextRangeMapping | null {
  const map = textMapFromSnapshot(document, snapshot);
  const span = map.spans.get(element);
  if (span === undefined) return null;
  return {
    start: span.start,
    end: span.end,
    codePointStart: codePointOffsetForUtf16(map.text, span.start),
    codePointEnd: codePointOffsetForUtf16(map.text, span.end),
    exact: map.text.slice(span.start, span.end),
  };
}

/** Captures one coherent, document-local native text selection without protocol dependencies. */
export function captureNativeSelectionInDocument(
  document: Document,
  nativeSelection: Selection,
  geometryBasis?: DocumentSelectionGeometryBasis,
  textSnapshot?: DocumentTextSnapshot,
): DocumentSelectionCapture {
  const generation = documentTextGeneration(document);
  const view = document.defaultView;
  const visualViewport = view?.visualViewport;
  const visualOffset = {
    x: visualViewport?.offsetLeft ?? 0,
    y: visualViewport?.offsetTop ?? 0,
  };
  const basis: DocumentSelectionCaptureBasis = {
    documentTextGeneration: generation,
    geometryGeneration: geometryBasis?.generation ?? null,
    visualViewportOffset: visualOffset,
  };
  const stale = () =>
    documentTextGeneration(document) !== generation || geometryBasis?.isCurrent() === false;
  if (stale()) return { status: "stale", basis };
  if (view === null) return { status: "unavailable", reason: "document-inactive", basis };
  if (nativeSelection.rangeCount === 0) {
    return { status: "unavailable", reason: "no-selection", basis };
  }
  if (nativeSelection.rangeCount !== 1) return { status: "ambiguous", basis };
  try {
    const range = nativeSelection.getRangeAt(0).cloneRange();
    const anchorNode = nativeSelection.anchorNode;
    const focusNode = nativeSelection.focusNode;
    if (anchorNode === null || focusNode === null) return { status: "conflict", basis };
    if (
      range.startContainer.ownerDocument !== document ||
      range.endContainer.ownerDocument !== document ||
      anchorNode.ownerDocument !== document ||
      focusNode.ownerDocument !== document ||
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected ||
      !anchorNode.isConnected ||
      !focusNode.isConnected
    ) {
      return { status: "conflict", basis };
    }
    if (range.collapsed) return { status: "collapsed", basis };
    const snapshot =
      textSnapshot?.document === document && documentTextSnapshotIsCurrent(textSnapshot)
        ? textSnapshot
        : createDocumentTextSnapshot(document);
    const map = snapshot.index;
    const start = textOffsetForBoundary(map, {
      node: range.startContainer,
      offset: range.startOffset,
    });
    const end = textOffsetForBoundary(map, { node: range.endContainer, offset: range.endOffset });
    if (start === null || end === null || start >= end) {
      return stale() || !documentTextSnapshotIsCurrent(snapshot)
        ? { status: "stale", basis }
        : { status: "unsupported", basis };
    }
    const startPosition = codePointOffsetForUtf16(map.text, start);
    const endPosition = codePointOffsetForUtf16(map.text, end);
    const evidence: RangeEvidence[] = [
      { kind: "browser-text-position", start: startPosition, end: endPosition },
    ];
    let payloadBytes = utf8Length(startPosition) + utf8Length(endPosition);
    const exact = map.text.slice(start, end);
    const quote: RangeEvidence = {
      kind: "rendered-text-quote",
      exact,
      prefix: map.text.slice(Math.max(0, start - selectionQuoteContextLength), start),
      suffix: map.text.slice(end, end + selectionQuoteContextLength),
    };
    const quoteBytes = stringPayloadBytes(quote);
    if (
      quoteBytes <= maximumQuoteBytes &&
      payloadBytes + quoteBytes <= maximumGeneratedStringBytes
    ) {
      evidence.push(quote);
      payloadBytes += quoteBytes;
    }
    const startEvidence = evidenceForBoundary(
      document,
      map,
      { node: range.startContainer, offset: range.startOffset },
      start,
    );
    const endEvidence = evidenceForBoundary(
      document,
      map,
      { node: range.endContainer, offset: range.endOffset },
      end,
    );
    if (startEvidence.state === "located" && endEvidence.state === "located") {
      const boundaries: RangeEvidence = {
        kind: "boundaries",
        start: startEvidence.evidence,
        end: endEvidence.evidence,
      };
      const boundaryBytes = stringPayloadBytes(boundaries);
      if (payloadBytes + boundaryBytes <= maximumGeneratedStringBytes) evidence.push(boundaries);
    }
    const clippingRect = geometryBasis?.clippingRect ?? {
      x: visualOffset.x,
      y: visualOffset.y,
      width: visualViewport?.width ?? view.innerWidth,
      height: visualViewport?.height ?? view.innerHeight,
    };
    if (!rectangleValueIsRendered(clippingRect)) {
      return stale() || !documentTextSnapshotIsCurrent(snapshot)
        ? { status: "stale", basis }
        : { status: "unavailable", reason: "layout-unavailable", basis };
    }
    const direction = selectionDirection(
      document,
      anchorNode,
      nativeSelection.anchorOffset,
      focusNode,
      nativeSelection.focusOffset,
    );
    const anchorRect = selectionAnchorRectangle(range, clippingRect, direction);
    if (anchorRect === null) {
      return stale() || !documentTextSnapshotIsCurrent(snapshot)
        ? { status: "stale", basis }
        : { status: "unavailable", reason: "geometry-unavailable", basis };
    }
    if (
      stale() ||
      !documentTextSnapshotIsCurrent(snapshot) ||
      nativeSelection.rangeCount !== 1 ||
      !sameRange(range, nativeSelection.getRangeAt(0))
    ) {
      return { status: "stale", basis };
    }
    return {
      status: "captured",
      selection: {
        evidence,
        observation: {
          layoutProgression: null,
          renderedTextProgression:
            map.text.length === 0 ? null : Math.min(1, Math.max(0, start / map.text.length)),
        },
        direction,
        language: authoredLanguage(range.startContainer),
        anchor: {
          rect: toVisualViewportRect(anchorRect, visualOffset),
          clippingRect: toVisualViewportRect(clippingRect, visualOffset),
        },
      },
      textSnapshot: snapshot,
      basis,
    };
  } catch (cause) {
    if (stale()) return { status: "stale", basis };
    return {
      status: "failed",
      message: cause instanceof Error ? cause.message : null,
      basis,
    };
  }
}

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

function authoredLanguage(node: Node): string | null {
  for (
    let element: Element | null = node instanceof Element ? node : node.parentElement;
    element !== null;
    element = element.parentElement
  ) {
    const language = element.getAttributeNS(XML_NAMESPACE, "lang") ?? element.getAttribute("lang");
    if (language !== null) return language.trim() || null;
  }
  return null;
}

export function selectionDirection(
  document: Document,
  anchorNode: Node,
  anchorOffset: number,
  focusNode: Node,
  focusOffset: number,
): CapturedDocumentSelection["direction"] {
  if (anchorNode === focusNode && anchorOffset === focusOffset) return "directionless";
  const anchor = document.createRange();
  const focus = document.createRange();
  anchor.setStart(anchorNode, anchorOffset);
  anchor.collapse(true);
  focus.setStart(focusNode, focusOffset);
  focus.collapse(true);
  return anchor.compareBoundaryPoints(Range.START_TO_START, focus) <= 0 ? "forward" : "backward";
}

export function selectionAnchorRectangle(
  range: Range,
  clippingRect: SelectionCaptureRect,
  direction: CapturedDocumentSelection["direction"],
): SelectionCaptureRect | null {
  if (typeof range.getClientRects !== "function") return null;
  let selected: SelectionCaptureRect | null = null;
  for (const rectangle of range.getClientRects()) {
    const candidate = {
      x: rectangle.left,
      y: rectangle.top,
      width: rectangle.width,
      height: rectangle.height,
    };
    if (!rectangleValueIsRendered(candidate) || !rectanglesIntersect(candidate, clippingRect)) {
      continue;
    }
    selected = candidate;
    if (direction === "backward") break;
  }
  return selected;
}

export function rectanglesIntersect(
  left: SelectionCaptureRect,
  right: SelectionCaptureRect,
): boolean {
  return (
    left.x + left.width > right.x &&
    right.x + right.width > left.x &&
    left.y + left.height > right.y &&
    right.y + right.height > left.y
  );
}

export function rectangleValueIsRendered(rectangle: SelectionCaptureRect): boolean {
  return (
    Number.isFinite(rectangle.x) &&
    Number.isFinite(rectangle.y) &&
    Number.isFinite(rectangle.width) &&
    Number.isFinite(rectangle.height) &&
    rectangle.width >= 0 &&
    rectangle.height >= 0 &&
    (rectangle.width > 0 || rectangle.height > 0)
  );
}

export function toVisualViewportRect(
  rectangle: SelectionCaptureRect,
  offset: {
    readonly x: number;
    readonly y: number;
  },
): SelectionCaptureRect {
  return { ...rectangle, x: rectangle.x - offset.x, y: rectangle.y - offset.y };
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function stringPayloadBytes(value: unknown): number {
  let bytes = 0;
  const visit = (item: unknown): void => {
    if (typeof item === "string") bytes += utf8Length(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item !== null && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
  return bytes;
}

/** Ephemeral diagnostics for focused resolver tests; not exported by the runtime package. */
export function documentTextIndexBuildCount(document: Document): number {
  return documentTextIndexes.get(document)?.builds ?? 0;
}

export function textMapFromSnapshot(
  document: Document,
  snapshot: DocumentTextSnapshot | undefined,
): VisibleTextMap {
  if (snapshot === undefined) return createDocumentTextSnapshot(document).index;
  if (snapshot.document !== document)
    throw new Error("the rendered-text snapshot belongs to another document");
  return snapshot.index;
}

export function createVisibleTextMap(document: Document): VisibleTextMap {
  const root = document.body ?? document.documentElement;
  const empty = (): VisibleTextMap => ({
    text: "",
    boundaries: [],
    reverseBoundaries: new WeakMap(),
    spans: new WeakMap(),
  });
  if (root === null) return empty();
  const view = document.defaultView;
  if (view === null) return empty();
  let text = "";
  const boundaries: Boundary[] = [];
  const reverseBoundaries = new WeakMap<Node, Map<number, number>>();
  const spans = new WeakMap<
    Node,
    {
      start: number;
      end: number;
    }
  >();
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  let inWhitespace = false;
  const styleFor = (element: Element) => {
    let style = styles.get(element);
    if (style === undefined) {
      style = view.getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const setBoundary = (offset: number, boundary: Boundary) => {
    boundaries[offset] = boundary;
    const span = spans.get(boundary.node);
    spans.set(boundary.node, {
      start: span === undefined ? offset : Math.min(span.start, offset),
      end: span === undefined ? offset : Math.max(span.end, offset),
    });
    let offsets = reverseBoundaries.get(boundary.node);
    if (offsets === undefined) {
      offsets = new Map();
      reverseBoundaries.set(boundary.node, offsets);
    }
    if (!offsets.has(boundary.offset)) offsets.set(boundary.offset, offset);
  };
  const appendSeparator = (element: Element, after: boolean) => {
    if (text.length === 0 || inWhitespace) return;
    const boundary = elementBoundary(element, after);
    setBoundary(text.length, boundary);
    text += " ";
    setBoundary(text.length, boundary);
    inWhitespace = true;
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue === null || !textNodeIsVisible(node, styleFor)) return;
      const parent = node.parentElement;
      const whiteSpace = parent === null ? "normal" : styleFor(parent).whiteSpace;
      const preservesWhitespace =
        whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces";
      for (let offset = 0; offset < node.nodeValue.length; offset += 1) {
        const character = node.nodeValue[offset]!;
        if (!preservesWhitespace && htmlWhitespace.test(character)) {
          if (!inWhitespace) {
            setBoundary(text.length, { node, offset });
            text += " ";
          }
          setBoundary(text.length, { node, offset: offset + 1 });
          inWhitespace = true;
        } else {
          setBoundary(text.length, { node, offset });
          text += character;
          setBoundary(text.length, { node, offset: offset + 1 });
          inWhitespace = htmlWhitespace.test(character);
        }
      }
      return;
    }
    if (!isElement(node)) return;
    const element = node;
    if (elementIsPruned(element, styleFor)) return;
    if (element.tagName === "BR") {
      appendSeparator(element, false);
      return;
    }
    const block = element !== root && createsRenderedBoundary(element, styleFor);
    if (block) appendSeparator(element, false);
    for (const child of element.childNodes) visit(child);
    if (block) appendSeparator(element, true);
  };
  visit(root);
  for (let offset = 0; offset < boundaries.length; offset += 1) {
    const boundary = boundaries[offset];
    if (boundary === undefined) continue;
    let offsets = reverseBoundaries.get(boundary.node);
    if (offsets === undefined) {
      offsets = new Map();
      reverseBoundaries.set(boundary.node, offsets);
    }
    if (!offsets.has(boundary.offset)) offsets.set(boundary.offset, offset);
  }
  const collectDescendantSpans = (
    node: Node,
  ):
    | {
        start: number;
        end: number;
      }
    | undefined => {
    let span = spans.get(node);
    for (const child of node.childNodes) {
      const childSpan = collectDescendantSpans(child);
      if (childSpan === undefined) continue;
      span =
        span === undefined
          ? childSpan
          : {
              start: Math.min(span.start, childSpan.start),
              end: Math.max(span.end, childSpan.end),
            };
    }
    if (span !== undefined) spans.set(node, span);
    return span;
  };
  collectDescendantSpans(root);
  return { text, boundaries, reverseBoundaries, spans };
}

export async function createDocumentTextSnapshotCooperatively(
  document: Document,
  meter: ResolverWorkMeter,
): Promise<DocumentTextSnapshot> {
  const index = await createVisibleTextMapCooperatively(document, meter);
  return storeDocumentTextSnapshot(document, index);
}

export function storeDocumentTextSnapshot(
  document: Document,
  index: VisibleTextMap,
): DocumentTextSnapshot {
  let state = documentTextIndexes.get(document);
  if (state === undefined) {
    state = { index: null, builds: 0, generation: 0 };
    documentTextIndexes.set(document, state);
  }
  state.index = index;
  state.builds += 1;
  return { document, index, generation: state.generation };
}

export async function createVisibleTextMapCooperatively(
  document: Document,
  meter: ResolverWorkMeter,
): Promise<VisibleTextMap> {
  const root = document.body ?? document.documentElement;
  const empty = (): VisibleTextMap => ({
    text: "",
    boundaries: [],
    reverseBoundaries: new WeakMap(),
    spans: new WeakMap(),
  });
  if (root === null) return empty();
  const view = document.defaultView;
  if (view === null) return empty();
  let text = "";
  const boundaries: Boundary[] = [];
  const reverseBoundaries = new WeakMap<Node, Map<number, number>>();
  const spans = new WeakMap<
    Node,
    {
      start: number;
      end: number;
    }
  >();
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  let inWhitespace = false;
  const styleFor = (element: Element) => {
    let style = styles.get(element);
    if (style === undefined) {
      style = view.getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const setBoundary = (offset: number, boundary: Boundary) => {
    boundaries[offset] = boundary;
    const span = spans.get(boundary.node);
    spans.set(boundary.node, {
      start: span === undefined ? offset : Math.min(span.start, offset),
      end: span === undefined ? offset : Math.max(span.end, offset),
    });
    let offsets = reverseBoundaries.get(boundary.node);
    if (offsets === undefined) {
      offsets = new Map();
      reverseBoundaries.set(boundary.node, offsets);
    }
    if (!offsets.has(boundary.offset)) offsets.set(boundary.offset, offset);
  };
  const appendSeparator = (element: Element, after: boolean) => {
    if (text.length === 0 || inWhitespace) return;
    const boundary = elementBoundary(element, after);
    setBoundary(text.length, boundary);
    text += " ";
    setBoundary(text.length, boundary);
    inWhitespace = true;
  };
  const visit = async (node: Node): Promise<void> => {
    await chargeResolverWork(meter, 1);
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue === null || !textNodeIsVisible(node, styleFor)) return;
      const parent = node.parentElement;
      const whiteSpace = parent === null ? "normal" : styleFor(parent).whiteSpace;
      const preservesWhitespace =
        whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces";
      for (let offset = 0; offset < node.nodeValue.length; offset += 1) {
        const character = node.nodeValue[offset]!;
        if (!preservesWhitespace && htmlWhitespace.test(character)) {
          if (!inWhitespace) {
            setBoundary(text.length, { node, offset });
            text += " ";
          }
          setBoundary(text.length, { node, offset: offset + 1 });
          inWhitespace = true;
        } else {
          setBoundary(text.length, { node, offset });
          text += character;
          setBoundary(text.length, { node, offset: offset + 1 });
          inWhitespace = htmlWhitespace.test(character);
        }
        if ((offset & 255) === 255) await chargeResolverWork(meter, 256);
      }
      await chargeResolverWork(meter, node.nodeValue.length & 255);
      return;
    }
    if (!isElement(node)) return;
    const element = node;
    if (elementIsPruned(element, styleFor)) return;
    if (element.tagName === "BR") {
      appendSeparator(element, false);
      return;
    }
    const block = element !== root && createsRenderedBoundary(element, styleFor);
    if (block) appendSeparator(element, false);
    for (const child of element.childNodes) await visit(child);
    if (block) appendSeparator(element, true);
  };
  await visit(root);
  for (let offset = 0; offset < boundaries.length; offset += 1) {
    const boundary = boundaries[offset];
    if (boundary !== undefined) {
      let offsets = reverseBoundaries.get(boundary.node);
      if (offsets === undefined) {
        offsets = new Map();
        reverseBoundaries.set(boundary.node, offsets);
      }
      if (!offsets.has(boundary.offset)) offsets.set(boundary.offset, offset);
    }
    if ((offset & 255) === 255) await chargeResolverWork(meter, 256);
  }
  await chargeResolverWork(meter, boundaries.length & 255);
  const collectDescendantSpans = async (
    node: Node,
  ): Promise<
    | {
        start: number;
        end: number;
      }
    | undefined
  > => {
    await chargeResolverWork(meter, 1);
    let span = spans.get(node);
    for (const child of node.childNodes) {
      const childSpan = await collectDescendantSpans(child);
      if (childSpan === undefined) continue;
      span =
        span === undefined
          ? childSpan
          : {
              start: Math.min(span.start, childSpan.start),
              end: Math.max(span.end, childSpan.end),
            };
    }
    if (span !== undefined) spans.set(node, span);
    return span;
  };
  await collectDescendantSpans(root);
  return { text, boundaries, reverseBoundaries, spans };
}
