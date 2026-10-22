import type {
  AnnotationSelectorExecutionOutcome as KernelAnnotationSelectorExecutionOutcome,
  AnnotationSelectorNode as KernelAnnotationSelectorNode,
  AnnotationTargetResolutionPlan as KernelAnnotationTargetResolutionPlan,
  DocumentObservation,
  LocatorObservation,
  LocatorResolutionStatus,
  PaginatedLayout,
  RangeEvidence,
} from "../../../../generated/kernel.js";
import type { PaginatedGeometryContext } from "../../layout/document-scroll.js";
import {
  capturePaginatedGeometryContext,
  paginatedRectangleOffsetFromContext,
} from "../../layout/document-scroll.js";
import { rangeRectangle, renderedElementRectangle } from "./viewport.js";
import { isElement } from "../../dom.js";

export type Boundary = {
  node: Node;
  offset: number;
};

export type CandidateResult =
  | {
      kind: "candidates";
      ranges: Range[];
    }
  | {
      kind: "unsupported";
    }
  | {
      kind: "status";
      status: Extract<
        LocatorResolutionStatus,
        {
          status: "not-found" | "ambiguous" | "conflicting-evidence";
        }
      >;
    };

export interface DomLocatorResolution {
  readonly range: Range | null;
  readonly status: LocatorResolutionStatus;
}

export type RelocationPresentation =
  | {
      readonly mode: "document-scroll";
    }
  | {
      readonly mode: "paginated";
      readonly spreadStride: PaginatedLayout["spreadStride"] | undefined;
    };

export interface TextMatch {
  readonly start: number;
  readonly end: number;
}

export type DocumentLocatorObservation = DocumentObservation;

/** Maps one live range to a zero-based physical page without scrolling. */
export function physicalPageForRange(
  document: Document,
  range: Range,
  pagination: PaginatedLayout,
  geometry: PaginatedGeometryContext | null = capturePaginatedGeometryContext(document),
): number | null {
  if (geometry === null) return null;
  let rectangle = rangeRectangle(range);
  if (rectangle === null) {
    const boundary = range.startContainer;
    const element = isElement(boundary) ? boundary : boundary.parentElement;
    rectangle = element === null ? null : renderedElementRectangle(element);
  }
  if (rectangle === null) return null;
  const offset = paginatedRectangleOffsetFromContext(rectangle, "start", geometry);
  const logicalStart = geometry.metrics.position + offset;
  const page = Math.floor((logicalStart - pagination.columnOrigin + 0.5) / pagination.columnPitch);
  return Math.max(0, Math.min(pagination.pageCount - 1, page));
}

export interface VisibleTextMap {
  text: string;
  boundaries: Boundary[];
  reverseBoundaries: WeakMap<Node, Map<number, number>>;
  spans: WeakMap<
    Node,
    {
      start: number;
      end: number;
    }
  >;
}

/** One caller-owned rendered-text snapshot. Reuse it only while the DOM and CSSOM are unchanged. */
export interface DocumentTextSnapshot {
  readonly document: Document;
  readonly index: VisibleTextMap;
  readonly generation: number;
}

export interface DocumentTextRangeMapping {
  /** UTF-16 offsets on the snapshot's rendered-text basis. */
  readonly start: number;
  readonly end: number;
  /** Unicode code-point offsets serialized without a JavaScript integer limit. */
  readonly codePointStart: string;
  readonly codePointEnd: string;
  readonly exact: string;
}

export interface SelectionCaptureRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Caller-owned geometry state used to keep capture coherent with layout settlement. */
export interface DocumentSelectionGeometryBasis {
  readonly generation: number;
  readonly isCurrent: () => boolean;
  /** Optional clipping rectangle in layout-viewport coordinates. */
  readonly clippingRect?: SelectionCaptureRect;
}

export interface DocumentSelectionCaptureBasis {
  readonly documentTextGeneration: number;
  readonly geometryGeneration: number | null;
  readonly visualViewportOffset: {
    readonly x: number;
    readonly y: number;
  };
}

export interface CapturedDocumentSelection {
  readonly evidence: readonly RangeEvidence[];
  readonly observation: LocatorObservation;
  readonly direction: "forward" | "backward" | "directionless";
  /** Authored language of the selection start, from the nearest `xml:lang` or `lang`. */
  readonly language: string | null;
  readonly anchor: {
    readonly rect: SelectionCaptureRect;
    readonly clippingRect: SelectionCaptureRect;
  };
}

export type DocumentSelectionCapture =
  | ({
      readonly status: "captured";
      readonly selection: CapturedDocumentSelection;
      /** The rendered-text snapshot the capture was read against, for the next capture to reuse. */
      readonly textSnapshot: DocumentTextSnapshot;
    } & {
      readonly basis: DocumentSelectionCaptureBasis;
    })
  | ({
      readonly status: "collapsed";
    } & {
      readonly basis: DocumentSelectionCaptureBasis;
    })
  | ({
      readonly status: "unavailable";
      readonly reason:
        | "no-selection"
        | "document-inactive"
        | "layout-unavailable"
        | "geometry-unavailable";
    } & {
      readonly basis: DocumentSelectionCaptureBasis;
    })
  | ({
      readonly status: "unsupported";
    } & {
      readonly basis: DocumentSelectionCaptureBasis;
    })
  | ({
      readonly status: "ambiguous";
    } & {
      readonly basis: DocumentSelectionCaptureBasis;
    })
  | ({
      readonly status: "conflict";
    } & {
      readonly basis: DocumentSelectionCaptureBasis;
    })
  | ({
      readonly status: "stale";
    } & {
      readonly basis: DocumentSelectionCaptureBasis;
    })
  | ({
      readonly status: "failed";
      readonly message: string | null;
    } & {
      readonly basis: DocumentSelectionCaptureBasis;
    });

export type AnnotationSelectorSegmentKind = "resource" | "element" | "point" | "range";

export type AnnotationSelectorNode = KernelAnnotationSelectorNode;

export type AnnotationTargetResolutionPlan = Omit<
  KernelAnnotationTargetResolutionPlan,
  "resource"
> & {
  readonly resource?: string;
};

export type AnnotationSelectorExecutionOutcome = KernelAnnotationSelectorExecutionOutcome;

export interface AnnotationSelectorExecutionReport {
  readonly path: readonly number[];
  readonly kind: AnnotationSelectorNode["kind"];
  readonly outcome: Exclude<AnnotationSelectorExecutionOutcome, "conflict">;
  readonly matchCount: number;
  readonly segmentKind: AnnotationSelectorSegmentKind | null;
  readonly message?: string;
}

export interface AnnotationTargetResolutionResult {
  readonly outcome: AnnotationSelectorExecutionOutcome;
  readonly reports: readonly AnnotationSelectorExecutionReport[];
  readonly segmentKind: AnnotationSelectorSegmentKind | null;
  /** Internal live DOM result. It is not suitable for protocol serialization. */
  readonly range: Range | null;
}

export interface CooperativeResolverWork {
  readonly signal: AbortSignal;
  readonly maximumWorkUnits: number;
  readonly yieldEveryWorkUnits: number;
  readonly isCurrent?: (() => boolean) | undefined;
}

export interface CooperativePointEvidenceBatchResult {
  readonly resolutions: readonly DomLocatorResolution[];
  readonly snapshot: DocumentTextSnapshot | undefined;
}

export class ResolverWorkLimitExceeded extends Error {
  constructor() {
    super("browser resolution exceeded its work limit");
    this.name = "ResolverWorkLimitExceeded";
  }
}

export const MAX_TOC_RESOLUTION_WORK_UNITS = 8000000;

export const TOC_RESOLUTION_YIELD_WORK_UNITS = 4096;

export const ANNOTATION_RESOLUTION_YIELD_WORK_UNITS = 65536;

export interface ResolverWorkMeter extends CooperativeResolverWork {
  used: number;
  sinceYield: number;
}

export interface DocumentTextIndexState {
  index: VisibleTextMap | null;
  builds: number;
  generation: number;
}

export const documentTextIndexes = new WeakMap<Document, DocumentTextIndexState>();

export const htmlWhitespace = /[\t\n\f\r ]/u;

export const nonRenderedElements = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

export const initialContextLength = 32;

export const maximumContextLength = 256;

export const maximumAnnotationCandidates = 4096;

export const maximumUnsignedU64 = 18446744073709551615n;

export const maximumQuoteBytes = 16 * 1024;

export const maximumGeneratedStringBytes = 64 * 1024;

export const selectionQuoteContextLength = 256;

export const runtimeOwnedElementSelector =
  "[data-epub-navigator-configuration], [data-epub-navigator-reader-font]";
