import type { DocumentLocatorObservation, DocumentTextSnapshot } from "./types.js";
import type { DocumentAdapter } from "../../../../generated/kernel.js";
import {
  createDocumentTextSnapshot,
  documentTextSnapshotIsCurrent,
  textMapFromSnapshot,
} from "./text-index.js";
import { documentFlow } from "../../layout/document-scroll.js";
import {
  observedBoundaryNearViewportPoint,
  viewportInwardDirections,
  viewportPoints,
} from "./viewport.js";

export interface DocumentObservationViewport {
  /** Logical inline centers of the first and last visible pagination columns. */
  readonly logicalInlineStart: number;
  readonly logicalInlineEnd: number;
}

export interface DocumentObservationCapture {
  readonly observation: DocumentLocatorObservation;
  readonly visibleStartRange: Range | null;
  readonly visibleEndRange: Range | null;
  readonly textSnapshot: DocumentTextSnapshot;
}

export interface DocumentObservationOptions {
  readonly textSnapshot?: DocumentTextSnapshot | undefined;
  readonly includeRenderedTextContext?: boolean;
}

/** Captures one serializable snapshot of browser-authoritative document state. */
export function observeDocument(
  document: Document,
  viewport?: DocumentObservationViewport,
): DocumentLocatorObservation {
  return observeDocumentWithRanges(document, viewport).observation;
}

export function observeFixedDocument(
  document: Document,
  adapter: Extract<DocumentAdapter, "fixed-xhtml" | "fixed-svg" | "fixed-image">,
): DocumentLocatorObservation {
  const root = document.documentElement;
  const view = document.defaultView;
  if (root === null || view === null) throw new Error("the content document has no active view");
  const base =
    adapter === "fixed-xhtml"
      ? observeDocument(document)
      : {
          writingMode: "horizontal-tb" as const,
          direction: root.getAttribute("direction") === "rtl" ? ("rtl" as const) : ("ltr" as const),
          language: root.getAttribute("lang") ?? root.getAttribute("xml:lang"),
          viewport: { width: view.innerWidth, height: view.innerHeight },
          canvas: { state: "unavailable" as const },
          pagination: null,
        };
  return {
    ...base,
    visibleStart: {
      state: "located",
      evidence: [{ kind: "document-boundary", boundary: "start" }],
    },
    visibleEnd: {
      state: "located",
      evidence: [{ kind: "document-boundary", boundary: "end" }],
    },
    renderedTextProgression: null,
    layoutProgression: null,
    pagination: null,
  };
}

export function hasVisibleReplacedContentWithoutRenderedText(document: Document): boolean {
  const view = document.defaultView;
  if (view === null) return false;
  const snapshot = createDocumentTextSnapshot(document);
  return (
    textMapFromSnapshot(document, snapshot).text.trim().length === 0 &&
    hasVisibleReplacedContent(document, view.innerWidth, view.innerHeight)
  );
}

/** Captures an observation and its ephemeral live DOM boundaries. */
export function observeDocumentWithRanges(
  document: Document,
  viewport?: DocumentObservationViewport,
  options: DocumentObservationOptions = {},
): DocumentObservationCapture {
  const view = document.defaultView;
  const root = document.documentElement;
  if (view === null || root === null) throw new Error("the content document has no active view");
  const { writingMode, direction } = documentFlow(document);
  const width = Math.max(0, view.innerWidth);
  const height = Math.max(0, view.innerHeight);
  const textSnapshot =
    options.textSnapshot?.document === document &&
    documentTextSnapshotIsCurrent(options.textSnapshot)
      ? options.textSnapshot
      : createDocumentTextSnapshot(document);
  const textMap = textMapFromSnapshot(document, textSnapshot);
  const [startPoint, endPoint] = viewportPoints(writingMode, direction, width, height, viewport);
  const [startDirection, endDirection] = viewportInwardDirections(writingMode);
  const scanDistance = Math.max(width, height);
  const visibleStart = observedBoundaryNearViewportPoint(
    document,
    textMap,
    startPoint.x,
    startPoint.y,
    startDirection.x,
    startDirection.y,
    scanDistance,
    options.includeRenderedTextContext ?? true,
  );
  const visibleEnd = observedBoundaryNearViewportPoint(
    document,
    textMap,
    endPoint.x,
    endPoint.y,
    endDirection.x,
    endDirection.y,
    scanDistance,
    options.includeRenderedTextContext ?? true,
  );
  const hasRenderedText = textMap.text.trim().length > 0;
  const visibleReplacedContent =
    !hasRenderedText && hasVisibleReplacedContent(document, width, height);
  return {
    observation: {
      writingMode,
      direction,
      language: root.getAttribute("lang") ?? root.getAttribute("xml:lang"),
      viewport: { width, height },
      canvas: observeDocumentCanvas(document),
      visibleStart: visibleReplacedContent
        ? {
            state: "located",
            evidence: [{ kind: "document-boundary", boundary: "start" }],
          }
        : visibleStart.observation,
      visibleEnd: visibleReplacedContent
        ? {
            state: "located",
            evidence: [{ kind: "document-boundary", boundary: "end" }],
          }
        : visibleEnd.observation,
      renderedTextProgression:
        !hasRenderedText || visibleStart.textOffset === null
          ? null
          : Math.min(1, Math.max(0, visibleStart.textOffset / textMap.text.length)),
      layoutProgression: null,
      pagination: null,
    },
    visibleStartRange: visibleStart.range,
    visibleEndRange: visibleEnd.range,
    textSnapshot,
  };
}

function hasVisibleReplacedContent(document: Document, width: number, height: number): boolean {
  const view = document.defaultView;
  if (view === null) return false;
  return [...document.querySelectorAll("img, svg, video, canvas, object, embed")].some(
    (element) => {
      const style = view.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const bounds = element.getBoundingClientRect();
      return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.right > 0 &&
        bounds.bottom > 0 &&
        bounds.left < width &&
        bounds.top < height
      );
    },
  );
}

export function observeDocumentCanvas(document: Document): DocumentLocatorObservation["canvas"] {
  const view = document.defaultView;
  const root = document.documentElement;
  if (view === null || root === null) return { state: "unavailable" };
  const rootStyle = view.getComputedStyle(root);
  if (rootStyle.backgroundImage !== "none") return { state: "unavailable" };
  const rootAlpha = computedColorAlpha(rootStyle.backgroundColor);
  if (rootAlpha === 1) {
    return { state: "solid-color", cssColor: rootStyle.backgroundColor };
  }
  if (rootAlpha !== 0) return { state: "unavailable" };
  const body = document.body;
  if (body === null) return { state: "unavailable" };
  const bodyStyle = view.getComputedStyle(body);
  if (bodyStyle.backgroundImage !== "none" || computedColorAlpha(bodyStyle.backgroundColor) !== 1) {
    return { state: "unavailable" };
  }
  return { state: "solid-color", cssColor: bodyStyle.backgroundColor };
}

export function computedColorAlpha(value: string): number | null {
  if (value === "transparent") return 0;
  const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/u.exec(value);
  if (rgba !== null) return Number(rgba[1]);
  const alpha = /\/\s*([\d.]+%?)\s*\)$/u.exec(value);
  if (alpha === null) return value.startsWith("rgb(") || value.startsWith("color(") ? 1 : null;
  return alpha[1]?.endsWith("%") ? Number.parseFloat(alpha[1]) / 100 : Number(alpha[1]);
}
