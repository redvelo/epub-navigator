import type {
  AnnotationRangeAdjustmentCandidate,
  AnnotationRangeEdge,
  AnnotationRangeMovement,
  AnnotationTargetGenerationCandidate,
  AnnotationTargetReconciliationResult,
  AnnotationTargetResolutionPlan,
  AnnotationTextFragmentPolicy,
  DocumentAdapter,
  DocumentObservation,
  DecorationRecordResult,
  FixedIntrinsicViewport,
  FixedPageGeometry,
  LayoutInvalidationCause,
  LayoutRequest,
  LayoutResult,
  LocatorObservation,
  LocatorResolutionStatus,
  MediaOverlayEntryOutcome,
  NativeSelectionCaptureReason,
  NativeSelectionDirection,
  SelectionGesture,
  PointEvidence,
  ProjectedDecorationRecord,
  PresentationAdvanceStatus,
  RangeEvidence,
} from "../../generated/kernel.js";
import type { AnnotationPointTargetGenerationCandidate } from "../../generated/kernel.js";

import type { DOCUMENT_OBSERVATION_STYLE_PROPERTIES } from "./limits.js";

export const CONTENT_AGENT_PROTOCOL_VERSION = 3 as const;

export type ContentAgentOperation =
  | "resolve-locator"
  | "relocate"
  | "resolve-annotation-target"
  | "relocate-annotation-target"
  | "capture-selection"
  | "capture-current-location"
  | "find-media-overlay-entry"
  | "generate-annotation-target"
  | "generate-current-location-annotation-target"
  | "reconcile-decorations"
  | "adjust-annotation-range"
  | "advance-presentation"
  | "layout"
  | "measure-toc-targets"
  | "observe-document";
export type AgentKeyboardMode = "off" | "standard" | "vim";
export interface AgentInputPolicy {
  readonly keyboardMode: AgentKeyboardMode;
  readonly touchZones: boolean;
  readonly clickZones?: boolean;
  readonly progressionDirection: "ltr" | "rtl";
  readonly selectionMenu: "native" | "reader";
  /**
   * What a note reference does. `navigate` takes the reading position to the note, which is the
   * only thing a reader without somewhere to show it can do. `show` leaves the page where it is
   * and reports the reference, because the reader is about to show the note itself.
   */
  readonly notes?: "navigate" | "show";
}
export type AgentInteractionCommand =
  | "previous"
  | "next"
  | "reveal-top"
  | "reveal-bottom"
  | import("../reader-commands.js").ReaderCommand;
/**
 * Which decoration palette the display can carry. `monochrome` is for a display that keeps
 * lightness and discards hue, such as e-ink, where a second tone is a shade apart rather than a
 * colour apart and ink of its own ghosts.
 */
export type AgentDecorationPalette = "standard" | "monochrome";
export interface AgentAppearancePolicy {
  readonly rootScrollbar: "publisher" | "hidden";
  readonly decorations?: AgentDecorationPalette;
}
export interface AgentConfiguration {
  readonly appearance: AgentAppearancePolicy;
  readonly input: AgentInputPolicy;
}

export interface AgentEnvelope {
  readonly namespace: "epub-navigator";
  readonly session: string;
}

export interface AgentInitializeMessage extends AgentEnvelope {
  readonly type: "initialize";
  readonly protocolVersion: typeof CONTENT_AGENT_PROTOCOL_VERSION;
  readonly adapter: DocumentAdapter;
  readonly role: AgentRole;
  readonly configuration: AgentConfiguration;
  readonly diagnostics: boolean;
  /** Whether the reader may ask for bounded document observations. Off in a product reader. */
  readonly observation: boolean;
}

export type AgentRole = "foreground" | "auxiliary" | "prepared";

export interface AgentSetRoleMessage extends AgentEnvelope {
  readonly type: "set-role";
  readonly role: AgentRole;
  readonly roleChange: number;
  readonly configuration: AgentConfiguration;
}

export interface AgentRoleChangedMessage extends AgentEnvelope {
  readonly type: "role-changed";
  readonly role: AgentRole;
  readonly roleChange: number;
}

export interface AgentConfigureMessage extends AgentEnvelope {
  readonly type: "configure";
  readonly configuration: AgentConfiguration;
}

export interface AgentClearSelectionMessage extends AgentEnvelope {
  readonly type: "clear-selection";
}

export interface AgentReleaseMessage extends AgentEnvelope {
  readonly type: "release";
}

export interface AgentReleasedMessage extends AgentEnvelope {
  readonly type: "released";
}

export interface AgentReturnFromFootnoteMessage extends AgentEnvelope {
  readonly type: "return-from-footnote";
  readonly activationId: number;
}

export interface AgentSetActiveDecorationMessage extends AgentEnvelope {
  readonly type: "set-active-decoration";
  readonly projectionRevision: number;
  readonly id: string | null;
}

/** Replaces the one active narration target; `fragment: null` clears all narration state. */
export interface AgentSetMediaOverlayActiveMessage extends AgentEnvelope {
  readonly type: "set-media-overlay-active";
  readonly commandId: number;
  readonly fragment: string | null;
  readonly activeClasses: readonly string[];
  readonly playbackActiveClasses: readonly string[];
}

export interface AgentCancelOperationMessage extends AgentEnvelope {
  readonly type: "cancel-operation";
  readonly operation: number;
  readonly operationType: ContentAgentOperation;
}

export type AgentFixedViewportAppliedMessage = AgentEnvelope &
  (
    | {
        readonly type: "fixed-viewport-applied";
        readonly operation: number;
        readonly status: "applied";
        readonly geometry: FixedPageGeometry;
      }
    | {
        readonly type: "fixed-viewport-applied";
        readonly operation: number;
        readonly status: "unavailable";
        readonly issue: "final-viewport-unavailable";
      }
  );

export interface AgentReadyMessage extends AgentEnvelope {
  readonly type: "ready";
  readonly protocolVersion: typeof CONTENT_AGENT_PROTOCOL_VERSION;
  readonly adapter: DocumentAdapter;
  readonly supportedOperations: readonly ContentAgentOperation[];
}

export type DocumentLocatorTarget =
  | { readonly kind: "point"; readonly evidence: PointEvidence[] }
  | { readonly kind: "range"; readonly evidence: RangeEvidence[] };

export type AgentWireRequest =
  | {
      readonly type: "capture-selection";
    }
  | {
      readonly type: "capture-current-location";
    }
  | {
      readonly type: "find-media-overlay-entry";
      readonly fragments: readonly string[];
    }
  | {
      readonly type: "resolve-locator" | "relocate";
      readonly target: DocumentLocatorTarget;
    }
  | {
      readonly type: "resolve-annotation-target" | "relocate-annotation-target";
      readonly plan: AnnotationTargetResolutionPlan;
    }
  | {
      readonly type: "generate-annotation-target";
      readonly target: Extract<DocumentLocatorTarget, { readonly kind: "range" }>;
      readonly localContentBasis: number;
      readonly textFragmentPolicy: AnnotationTextFragmentPolicy;
    }
  | {
      readonly type: "generate-current-location-annotation-target";
      readonly target: Extract<DocumentLocatorTarget, { readonly kind: "point" }>;
      readonly localContentBasis: number;
    }
  | ({
      readonly type: "layout";
    } & LayoutRequest)
  | {
      readonly type: "advance-presentation";
      readonly direction: "forward" | "backward";
    }
  | {
      readonly type: "measure-toc-targets";
      readonly targets: readonly TocTargetMeasurementRequest[];
    }
  | {
      readonly type: "observe-document";
      readonly observation: DocumentObservationRequest;
    }
  | {
      readonly type: "reconcile-decorations";
      readonly projectionRevision: number;
      readonly records: readonly ProjectedDecorationRecord[];
    }
  | {
      readonly type: "adjust-annotation-range";
      readonly projectionRevision: number;
      readonly recordId: string;
      readonly edge: AnnotationRangeEdge;
      readonly movement: AnnotationRangeMovement;
    };

export interface TocTargetIdentity {
  readonly listIndex: number;
  readonly pointPath: readonly number[];
}

export interface TocTargetMeasurementRequest extends TocTargetIdentity {
  readonly evidence: readonly PointEvidence[];
}

export type TocTargetPageResult =
  | { readonly state: "located"; readonly physicalPage: number }
  | { readonly state: "ambiguous"; readonly reason: string }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "failed"; readonly message: string };

export interface TocTargetMeasurementResult extends TocTargetIdentity {
  readonly result: TocTargetPageResult;
}

export type DocumentObservationStyleProperty =
  (typeof DOCUMENT_OBSERVATION_STYLE_PROPERTIES)[number];

/** One selector's worth of questions about the document. */
export interface DocumentObservationQuery {
  readonly id: string;
  readonly selector: string;
  /** Same-origin nested frames to descend through before selecting. */
  readonly within?: readonly string[];
  readonly text?: boolean;
  readonly styles?: readonly DocumentObservationStyleProperty[];
  readonly rect?: boolean;
  readonly attributes?: readonly string[];
}

export interface DocumentObservationRequest {
  readonly queries: readonly DocumentObservationQuery[];
  readonly resources: boolean;
  readonly fonts: boolean;
}

export interface DocumentObservationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type DocumentObservationQueryResult = { readonly id: string } & (
  | {
      readonly matches: number;
      readonly first: {
        readonly text?: string;
        readonly styles?: Readonly<Record<string, string>>;
        readonly rect?: DocumentObservationRect;
        readonly attributes?: Readonly<Record<string, string | null>>;
      } | null;
    }
  | { readonly inaccessible: "cross-origin" | "no-frame" }
);

export interface DocumentObservationResource {
  readonly kind: "image" | "media";
  readonly source: string;
  readonly state: "loaded" | "failed" | "pending";
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
  readonly readyState?: number;
}

export interface DocumentObservationFonts {
  readonly status: "loading" | "loaded";
  readonly loaded: readonly string[];
}

/**
 * What the agent saw. It is informative: the agent shares the publication's realm,
 * so a publication can shape what is observed. A host decides what to conclude.
 */
export interface DocumentObservationResult {
  readonly document: {
    readonly title: string;
    readonly lang: string;
    readonly dir: string;
    readonly readyState: DocumentReadyState;
    readonly contentType: string;
    readonly svgRoot: boolean;
  };
  readonly queries: readonly DocumentObservationQueryResult[];
  readonly resources?: readonly DocumentObservationResource[];
  readonly fonts?: DocumentObservationFonts;
}

export interface AgentRequestMessage extends AgentEnvelope {
  readonly type: "request";
  readonly operation: number;
  readonly request: AgentWireRequest;
}

export interface AgentLocatorResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "resolve-locator" | "relocate";
  readonly status: LocatorResolutionStatus;
}

export interface AgentAnnotationTargetResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "resolve-annotation-target" | "relocate-annotation-target";
  readonly result: AnnotationTargetReconciliationResult;
}

export interface AgentAnnotationTargetGenerationResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "generate-annotation-target";
  readonly candidate: AnnotationTargetGenerationCandidate;
}

export interface AgentAnnotationPointTargetGenerationResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "generate-current-location-annotation-target";
  readonly candidate: AnnotationPointTargetGenerationCandidate;
}

export interface AgentDecorationResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "reconcile-decorations";
  readonly projectionRevision: number;
  readonly outcomes: readonly DecorationRecordResult[];
}

export interface AgentAnnotationRangeAdjustmentResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "adjust-annotation-range";
  readonly candidate: AnnotationRangeAdjustmentCandidate;
}

export type AgentLayoutResultMessage = AgentEnvelope & {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "layout";
  readonly result: LayoutResult;
};

export interface AgentAdvancePresentationResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "advance-presentation";
  readonly status: PresentationAdvanceStatus;
}

export interface AgentSelectionCaptureBasis {
  readonly localContentBasis: number;
  readonly localGeometryBasis: number;
}

export interface AgentVisualViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AgentVisualViewportOffset {
  readonly x: number;
  readonly y: number;
}

export interface AgentVisualViewportAnchor {
  readonly rect: AgentVisualViewportRect;
  readonly clippingRect: AgentVisualViewportRect;
  readonly visualViewportOffset: AgentVisualViewportOffset;
}

export type AgentDocumentSelectionCaptureOutcome =
  | {
      readonly status: "captured";
      readonly evidence: readonly RangeEvidence[];
      readonly observation: LocatorObservation;
      readonly direction: NativeSelectionDirection;
      readonly language: string | null;
      readonly anchor: AgentVisualViewportAnchor;
      readonly gesture: SelectionGesture | null;
      readonly basis: AgentSelectionCaptureBasis;
    }
  | { readonly status: "collapsed"; readonly basis: AgentSelectionCaptureBasis }
  | {
      readonly status: "unavailable";
      readonly reason: NativeSelectionCaptureReason;
      readonly basis: AgentSelectionCaptureBasis;
    }
  | { readonly status: "unsupported"; readonly basis: AgentSelectionCaptureBasis }
  | { readonly status: "ambiguous"; readonly basis: AgentSelectionCaptureBasis }
  | { readonly status: "conflict"; readonly basis: AgentSelectionCaptureBasis }
  | { readonly status: "stale"; readonly basis: AgentSelectionCaptureBasis }
  | {
      readonly status: "failed";
      readonly message: string | null;
      readonly basis: AgentSelectionCaptureBasis;
    };

export interface AgentSelectionResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "capture-selection";
  readonly outcome: AgentDocumentSelectionCaptureOutcome;
}

export type AgentDocumentLocationCaptureOutcome =
  | {
      readonly status: "captured";
      readonly evidence: readonly PointEvidence[];
      readonly observation: LocatorObservation;
      readonly basis: AgentSelectionCaptureBasis;
    }
  | { readonly status: "unavailable" | "stale"; readonly basis: AgentSelectionCaptureBasis }
  | {
      readonly status: "failed";
      readonly message: string | null;
      readonly basis: AgentSelectionCaptureBasis;
    };

export interface AgentCurrentLocationResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "capture-current-location";
  readonly outcome: AgentDocumentLocationCaptureOutcome;
}

export type AgentResultMessage =
  | AgentLocatorResultMessage
  | AgentAnnotationTargetResultMessage
  | AgentAnnotationTargetGenerationResultMessage
  | AgentAnnotationPointTargetGenerationResultMessage
  | AgentDecorationResultMessage
  | AgentAnnotationRangeAdjustmentResultMessage
  | AgentAdvancePresentationResultMessage
  | AgentSelectionResultMessage
  | AgentCurrentLocationResultMessage
  | AgentMediaOverlayEntryResultMessage
  | AgentLayoutResultMessage;

export interface AgentTocTargetsResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "measure-toc-targets";
  readonly results: readonly TocTargetMeasurementResult[];
}

export interface AgentDocumentObservationResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "observe-document";
  readonly observation: DocumentObservationResult;
}

export type ContentAgentResultMessage =
  | AgentResultMessage
  | AgentTocTargetsResultMessage
  | AgentDocumentObservationResultMessage;

export type AgentObservationMessage = AgentEnvelope &
  DocumentObservation & { readonly type: "observation" };

export interface AgentLayoutInvalidatedMessage extends AgentEnvelope {
  readonly type: "layout-invalidated";
  readonly cause: LayoutInvalidationCause;
}

export interface AgentSelectionChangedMessage extends AgentEnvelope {
  readonly type: "selection-changed";
}

export interface AgentActivityMessage extends AgentEnvelope {
  readonly type: "activity";
  readonly activity: "pointer" | "scroll" | "presentation";
}

export interface AgentActivationMessage extends AgentEnvelope {
  readonly type: "activation";
  readonly href: string;
  readonly resolvedUrl: string;
  readonly target: string | null;
  readonly download: string | null;
  readonly footnote: {
    readonly activationId: number;
    readonly originEvidence: PointEvidence[];
    /**
     * What the agent did with the reference. `navigated` took the page to the note and left a
     * way back; `reported` left the page alone because the reader shows the note itself.
     */
    readonly disposition: "navigated" | "reported";
    /** The reference's own box in the document's viewport, for a reader anchoring to it. */
    readonly referenceRect: { x: number; y: number; width: number; height: number } | null;
    /** What the publication printed as the reference, such as a number or a dagger. */
    readonly referenceLabel: string | null;
  } | null;
}

export interface AgentFormSubmissionMessage extends AgentEnvelope {
  readonly type: "form-submission";
  readonly action: string | null;
  readonly resolvedUrl: string;
  readonly method: string;
  readonly target: string | null;
}

export interface AgentLinkActivation {
  readonly href: string;
  readonly resolvedUrl: string;
  readonly target: string | null;
  readonly download: string | null;
}

export interface AgentFootnoteReturnedMessage extends AgentEnvelope {
  readonly type: "footnote-returned";
  readonly activationId: number;
  readonly status: "returned" | "unavailable" | "stale" | "failed";
}

export interface AgentMediaOverlayActiveAppliedMessage extends AgentEnvelope {
  readonly type: "media-overlay-active-applied";
  readonly commandId: number;
  readonly status: "applied" | "cleared" | "missing" | "unsupported";
  readonly visible: boolean;
}

export interface AgentMediaOverlayEntryResultMessage extends AgentEnvelope {
  readonly type: "result";
  readonly operation: number;
  readonly resultType: "find-media-overlay-entry";
  readonly outcome: MediaOverlayEntryOutcome;
}

export interface AgentDecorationActivationMessage extends AgentEnvelope {
  readonly type: "decoration-activation";
  readonly projectionRevision: number;
  readonly ids: readonly string[];
  readonly anchor: AgentVisualViewportAnchor;
  readonly link: AgentLinkActivation | null;
}

export interface AgentInteractionMessage extends AgentEnvelope {
  readonly type: "interaction";
  readonly command: AgentInteractionCommand;
  readonly source: "keyboard" | "pointer" | "touch";
}

export type AgentFixedViewInteractionMessage = AgentEnvelope &
  (
    | {
        readonly type: "fixed-view-interaction";
        readonly action: "zoom";
        readonly source: "keyboard" | "pointer" | "touch";
        readonly factor: number;
        readonly focalX: number;
        readonly focalY: number;
      }
    | {
        readonly type: "fixed-view-interaction";
        readonly action: "pan";
        readonly source: "keyboard" | "pointer" | "touch";
        readonly deltaX: number;
        readonly deltaY: number;
      }
    | {
        readonly type: "fixed-view-interaction";
        readonly action: "reset";
        readonly source: "keyboard";
      }
  );

export interface AgentPaginationDiagnosticMessage extends AgentEnvelope {
  readonly type: "pagination-diagnostic";
  readonly phase:
    | "capture"
    | "content-end-scan"
    | "text-assessment"
    | "settlement"
    | "observation"
    | "live-observation";
  readonly durationMs: number;
  readonly scanCount: number;
  readonly rectangleCount: number;
}

export interface AgentFontEvidenceMessage extends AgentEnvelope {
  readonly type: "font-evidence";
  readonly target: "publication";
  readonly family: "navigator-reader-serif";
  readonly configured: boolean;
  readonly declared: boolean;
  readonly loaded: boolean;
  readonly check: boolean;
}

export interface AgentFixedViewportMessage extends AgentEnvelope {
  readonly type: "fixed-viewport";
  readonly operation: number;
  readonly intrinsicViewport: FixedIntrinsicViewport;
}

export type ContentAgentOutboundMessage =
  | AgentReadyMessage
  | AgentRoleChangedMessage
  | AgentReleasedMessage
  | AgentResultMessage
  | AgentTocTargetsResultMessage
  | AgentDocumentObservationResultMessage
  | AgentObservationMessage
  | AgentLayoutInvalidatedMessage
  | AgentSelectionChangedMessage
  | AgentActivityMessage
  | AgentDecorationActivationMessage
  | AgentActivationMessage
  | AgentFormSubmissionMessage
  | AgentFootnoteReturnedMessage
  | AgentMediaOverlayActiveAppliedMessage
  | AgentInteractionMessage
  | AgentFixedViewInteractionMessage
  | AgentFixedViewportMessage
  | AgentPaginationDiagnosticMessage
  | AgentFontEvidenceMessage;
