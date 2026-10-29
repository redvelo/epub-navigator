import type { DeferredLayoutInteraction } from "./layout/deferred-interaction.js";
import { createAnnotationAuthoredProvenanceTracker } from "./targets/annotation-range-candidate.js";
import type {
  DocumentAdapter,
  FixedSettlement,
  LayoutInvalidationCause,
  ReflowablePresentation,
  ReflowableSettlement,
  RequiredAssetSettlement,
  LayoutRepairReport,
} from "../../generated/kernel.js";
import type { AgentRole } from "../agent-protocol/index.js";
import { defaultAgentConfiguration } from "../agent-protocol/index.js";
import { createOperationQueue } from "./operation-queue.js";
import type { DocumentTextSnapshot } from "./targets/resolver/types.js";
import { createLayoutSettlementTracker } from "./layout-settlement.js";
import type { AgentFixedViewportAppliedMessage } from "../agent-protocol/index.js";
import type { PointEvidence } from "../../generated/kernel.js";

export interface PaginationGeometryDiagnostics {
  enabled: boolean;
  cooperativeYieldCount?: number;
  scanCount?: number;
  rectangleCount?: number;
  assessment?:
    | {
        paragraphCount: number;
        displayCandidateCount: number;
        rectangleCount: number;
        textRangeScanCount: number;
        durationMs: number;
      }
    | undefined;
  phases?: {
    phase: "capture" | "content-end-scan" | "text-assessment" | "settlement";
    durationMs: number;
  }[];
}

export type AgentSettledLayout = {
  presentation: ReflowablePresentation;
  settlement: ReflowableSettlement;
};

export interface DocumentGeometry {
  readonly rootWidth: number;
  readonly rootHeight: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
}

/** What the reader stylesheet does to one marked element so that it paginates. */
export type FragmentationRemedy =
  | { readonly kind: "block-flow" }
  | {
      readonly kind: "inline-margins";
      readonly start: number;
      readonly end: number;
      readonly measure: number;
    }
  | { readonly kind: "inline-fit"; readonly zoom: number; readonly inlineSize: number }
  | { readonly kind: "wrap"; readonly inlineSize: number };

export interface FragmentationRepair {
  readonly element: HTMLElement;
  readonly marker: string;
  readonly remedy: FragmentationRemedy;
}

export interface BodyInsets {
  readonly inlineBorderAndPadding: number;
  readonly blockBorderAndPadding: number;
}

export function createContentAgentState() {
  return {
    targets: {
      annotationAuthoredProvenance: createAnnotationAuthoredProvenanceTracker(document),
      tocTextSnapshot: undefined as DocumentTextSnapshot | undefined,
      tocTextSnapshotLayout: null as AgentSettledLayout | null,
    },
    transport: {
      reader: null as Window | null,
      readerOrigin: null as string | null,
      protocolSession: null as string | null,
    },
    lifecycle: {
      initialized: false,
      documentAdapter: null as DocumentAdapter | null,
      agentRole: "foreground" as AgentRole,
      diagnosticsEnabled: false,
      observationEnabled: false,
      configuration: defaultAgentConfiguration,
    },
    observation: {
      invalidation: 0,
      observationScheduled: false,
      observationDeferred: false,
      scrollActivityScheduled: false,
      observationTextSnapshot: undefined as DocumentTextSnapshot | undefined,
      committedGeometry: null as DocumentGeometry | null,
      geometryObservationScheduled: false,
    },
    operations: {
      operationQueue: createOperationQueue(),
    },
    layout: {
      layoutToken: 0,
      applyingLayout: false,
      activePresentation: null as ReflowablePresentation | null,
      layoutInvalidationPending: false,
      layoutReapplyRequested: false,
      layoutInvalidationVersion: 0,
      activeLayoutInvalidationCause: null as LayoutInvalidationCause | null,
      expectedReaderCss: "",
      settledLayout: null as AgentSettledLayout | null,
      fixedSettlement: null as FixedSettlement | null,
      staticSvgRequiredResources: "loaded" as RequiredAssetSettlement,
      pendingFixedViewportApplication: null as {
        readonly operation: number;
        readonly resolve: (application: AgentFixedViewportAppliedMessage) => void;
        readonly reject: (cause: Error) => void;
      } | null,
      authoredBodyInsets: null as BodyInsets | null,
      /** The colour the browser would paint the canvas with before the reader styles the root. */
      authoredCanvasBackground: null as string | null,
      paginationEndExtent: 0,
      alignXCenterBlockExtent: null as number | null,
      singleColumnPaginationFallback: false,
      /** One column for a section whose wide content two columns cannot hold. */
      wideContentSingleColumn: false,
      invalidationCause: null as LayoutInvalidationCause | null,
      invalidationScheduled: false,
      fragmentationMarkerSequence: 0,
      fragmentationRepairs: [] as FragmentationRepair[],
      activeFragmentationMarkers: new WeakMap<Element, string>(),
      removedFragmentationMarkers: new WeakMap<Element, string>(),
      layoutRepairReport: { status: "no-issues-detected" } as LayoutRepairReport,
      deferredLayoutInteraction: null as DeferredLayoutInteraction | null,
      styleBasisElementIds: new WeakMap<Element, number>(),
      styleBasisElementSequence: 0,
      layoutSettlement: createLayoutSettlementTracker(document),
      readerStyle: null as HTMLStyleElement | null,
    },
    selection: {
      selectionGeometryBasis: 0,
      selectionSignalScheduled: false,
      selectionSignalledContent: false,
      selectionCompositionActive: false,
      selectionEdgeGesture: null as {
        readonly pointerId: number | null;
        endpoint: "anchor" | "focus";
        clientX: number;
        clientY: number;
        selectionActive: boolean;
        endpointMoved: boolean;
        lockedPosition: number;
        nextRevealAt: number;
        direction: "forward" | "backward" | null;
        revealed: "forward" | "backward" | null;
        heldAnchor: { readonly node: Node; readonly offset: number } | null;
        touchDrag: {
          press: { readonly x: number; readonly y: number } | null;
          readonly pressed: Range;
          settled: boolean;
          dwellTimer: ReturnType<typeof setTimeout> | null;
        } | null;
        timer: ReturnType<typeof setTimeout> | null;
      } | null,
      inferredSelectionEdgeTimer: null as ReturnType<typeof setTimeout> | null,
      touchPage: null as number | null,
      touchTakenOver: false,
      selectionEdgeViewportTransient: false,
      selectionEdgeObservationDeferred: false,
      selectionEdgeSignalDeferred: false,
      suppressDecorationActivationUntil: 0,
      previousSelectionFocus: null as {
        readonly anchorNode: Node | null;
        readonly anchorOffset: number;
        readonly node: Node;
        readonly offset: number;
        readonly position: number;
      } | null,
    },
    activation: {
      footnoteFocusAids: new WeakSet<Node>(),
      nextFootnoteActivationId: 1,
      activeFootnoteNavigation: null as {
        readonly activationId: number;
        readonly origin: WeakRef<HTMLAnchorElement>;
        readonly originEvidence: PointEvidence[];
        readonly destinationAid: HTMLElement | null;
      } | null,
    },
    interaction: {
      touchActive: false,
      releaseRequested: false,
      swipeCandidate: null as {
        pointerId: number;
        startedAt: number;
        startX: number;
        startY: number;
        horizontal: boolean;
      } | null,
      edgeCandidate: null as {
        pointerId: number;
        startedAt: number;
        startX: number;
        startY: number;
        edge: "top" | "bottom";
        inward: number;
        drift: number;
      } | null,
      pendingG: null as number | null,
      pendingGTimer: null as ReturnType<typeof setTimeout> | null,
      touchCandidate: null as {
        pointerId: number;
        startedAt: number;
        startX: number;
        startY: number;
        endX: number;
        endY: number;
        completed: boolean;
        clearsSelection: boolean;
      } | null,
      fixedGesturePointers: new Map<
        number,
        { readonly pointerType: string; x: number; y: number; startX: number; startY: number }
      >(),
      fixedPinch: null as {
        readonly distance: number;
        readonly x: number;
        readonly y: number;
      } | null,
    },
  };
}

export type ContentAgentState = ReturnType<typeof createContentAgentState>;
