import type {
  ActiveDocumentParticipant,
  AgentOperationFailure,
  AnnotationRangeAdjustmentOutcome,
  AnnotationRangeEdge,
  AnnotationRangeMovement,
  AnnotationTargetGenerationOutcome,
  AnnotationTargetReconciliationResult,
  DecorationProjection,
  DecorationSnapshot,
  FixedSpreadPlacement,
  KernelSnapshot,
  KernelTransition,
  LocatorResolutionStatus,
  NativeSelectionCaptureOutcome,
  NavigatorLocationCapture,
  NavigatorLocationSnapshot,
  PresentationAdvanceDirection,
  PresentationAdvanceStatus,
  PresentationPreferences,
  ReaderViewportAnchor,
  NavigatorLocation,
  VisibleOccurrenceRange,
} from "../../generated/kernel.js";
import type {
  BookPaginationSnapshot,
  PaginationSnapshotListener,
  NavigatorDiagnostics,
  PublicationPaginationCapabilities,
} from "../pagination/index.js";
import type {
  NavigatorReaderSession,
  PublicationFrameSandboxCapabilities,
} from "../../publication.js";
import type {
  NavigatorFootnoteNavigation,
  NavigatorFootnoteReturnResult,
} from "../../footnotes.js";
import { NavigatorError } from "../../runtime.js";
import type {
  AgentLinkActivation,
  AgentConfiguration,
  AgentInteractionMessage,
  DocumentObservationRequest,
  DocumentObservationResult,
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
} from "../agent-protocol/index.js";

export interface CreateNavigatorRuntimeOptions {
  readonly session: NavigatorReaderSession;
  readonly container: HTMLElement;
  readonly frameTitle?: string | undefined;
  readonly presentationPreferences?: PresentationPreferences | undefined;
  readonly pagination?: PublicationPaginationCapabilities | undefined;
  readonly diagnostics?: NavigatorDiagnostics | undefined;
  readonly frameSandbox?: PublicationFrameSandboxCapabilities | undefined;
  /**
   * Lets the owner ask the content agent for bounded document observations. A product
   * reader leaves this off; the agent then never advertises the operation.
   */
  readonly documentObservation?: boolean | undefined;
}

export interface AgentOperationContext {
  readonly operation: number;
  readonly generation: number;
  readonly occurrence: number;
  readonly resource: string;
}

export type AgentOperationResult = AgentOperationContext &
  (
    | { readonly outcome: "completed"; readonly status: LocatorResolutionStatus }
    | { readonly outcome: "failed"; readonly failure: AgentOperationFailure }
  );

export type LocatorResolution = AgentOperationResult;

export type RelocationResult = AgentOperationResult;

export type AnnotationTargetOperationResult = AgentOperationContext &
  (
    | {
        readonly outcome: "completed";
        readonly result: AnnotationTargetReconciliationResult;
      }
    | { readonly outcome: "failed"; readonly failure: AgentOperationFailure }
  );

export type PresentationAdvanceResult = AgentOperationContext &
  (
    | { readonly outcome: "completed"; readonly status: PresentationAdvanceStatus }
    | { readonly outcome: "failed"; readonly failure: AgentOperationFailure }
  );

export type SelectionCaptureOperationResult = AgentOperationContext &
  (
    | { readonly outcome: "completed"; readonly selection: NativeSelectionCaptureOutcome }
    | { readonly outcome: "failed"; readonly failure: AgentOperationFailure }
  );

export type NavigatorLocationListener = (snapshot: NavigatorLocationSnapshot) => void;

export interface AnnotationTargetGenerationOptions {
  readonly textFragment?: ("omit" | "include") | undefined;
}

export interface NavigatorReadingPosition {
  readonly targetJson: string;
  readonly occurrenceHint: { readonly occurrence: number; readonly resource: string } | null;
  /** Width-independent vertical offset within a fixed roll document. */
  readonly rollProgression?: number | undefined;
}

export interface RestoreAnnotationTargetOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export type RestoreAnnotationTargetResult =
  | {
      readonly status: "restored";
      readonly occurrence: number;
      readonly resource: string;
      readonly relocation: AnnotationTargetReconciliationResult | null;
    }
  | {
      readonly status: "cancelled";
      readonly reason: "superseded" | "replacement" | "close" | "abort";
    }
  | {
      readonly status: "failed";
      readonly reason: "invalid-position" | "unavailable" | "timeout";
      readonly message: string;
    };

export interface AnnotationRangeAdjustment {
  readonly edge: AnnotationRangeEdge;
  readonly movement: AnnotationRangeMovement;
}

export type AnnotationTargetGenerationOperationResult = AgentOperationContext &
  (
    | { readonly outcome: "completed"; readonly result: AnnotationTargetGenerationOutcome }
    | { readonly outcome: "failed"; readonly failure: AgentOperationFailure }
  );

export interface NavigatorSelectionSnapshot {
  readonly revision: number;
  readonly selection: NativeSelectionCaptureOutcome | null;
}

export interface TocTargetMeasurementOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface DocumentObservationOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface FixedViewState {
  readonly zoom: number;
  readonly minimumZoom: number;
  readonly maximumZoom: number;
  readonly panX: number;
  readonly panY: number;
}

export interface FixedViewPoint {
  readonly x: number;
  readonly y: number;
}

export interface NavigatorRuntime {
  open(occurrence: number): KernelTransition;
  attachFixedCompanion(
    ownerDocumentGeneration: number,
    frameGeneration: number,
    placement: FixedSpreadPlacement,
  ): KernelTransition;
  detachFixedCompanion(ownerDocumentGeneration: number, frameGeneration: number): KernelTransition;
  evictPreparedFrames(): KernelTransition;
  /** The occurrence `previous` would open, or null at the start of the reading order. */
  previousOccurrence(): number | null;
  /** The occurrence `next` would open, or null at the end of the reading order. */
  nextOccurrence(): number | null;
  previous(): KernelTransition;
  next(): KernelTransition;
  reload(): KernelTransition;
  cancel(): KernelTransition;
  resolve(locator: NavigatorLocation): Promise<LocatorResolution>;
  relocate(locator: NavigatorLocation): Promise<RelocationResult>;
  resolveAnnotationTarget(targetJson: string): Promise<AnnotationTargetOperationResult>;
  relocateAnnotationTarget(targetJson: string): Promise<AnnotationTargetOperationResult>;
  restoreAnnotationTarget(
    position: NavigatorReadingPosition,
    options?: RestoreAnnotationTargetOptions,
  ): Promise<RestoreAnnotationTargetResult>;
  advancePresentation(direction: PresentationAdvanceDirection): Promise<PresentationAdvanceResult>;
  currentSelection(): NavigatorSelectionSnapshot;
  captureSelection(): Promise<SelectionCaptureOperationResult>;
  currentLocation(): NavigatorLocationSnapshot;
  captureCurrentLocation(): Promise<NavigatorLocationCapture>;
  subscribeLocations(listener: NavigatorLocationListener): () => void;
  clearSelection(): void;
  generateSelectionAnnotationTarget(
    selectionRevision: number,
    options?: AnnotationTargetGenerationOptions,
  ): Promise<AnnotationTargetGenerationOperationResult>;
  generateCurrentLocationAnnotationTarget(
    locationRevision: number,
  ): Promise<AnnotationTargetGenerationOperationResult>;
  adjustAnnotationRange(
    projectionRevision: number,
    recordId: string,
    adjustment: AnnotationRangeAdjustment,
  ): Promise<AnnotationRangeAdjustmentOutcome>;
  cancelSelectionAnnotationTargetGeneration(): KernelTransition;
  setDecorationProjection(projection: DecorationProjection): void;
  decorationSnapshot(): DecorationSnapshot;
  measureTocTargets(
    targets: readonly TocTargetMeasurementRequest[],
    options?: TocTargetMeasurementOptions,
  ): Promise<readonly TocTargetMeasurementResult[]>;
  /** Observes the committed document; informative, and only when the runtime enabled it. */
  observeDocument(
    request: DocumentObservationRequest,
    options?: DocumentObservationOptions,
  ): Promise<DocumentObservationResult>;
  configure(configuration: ReaderConfiguration): void;
  setPresentationPreferences(preferences: PresentationPreferences): KernelTransition;
  snapshot(): KernelSnapshot;
  subscribe(listener: NavigatorTransitionListener): () => void;
  subscribeErrors(listener: NavigatorErrorListener): () => void;
  subscribeInteractions(listener: NavigatorInteractionListener): () => void;
  subscribeSelections(listener: NavigatorSelectionListener): () => void;
  subscribeDecorations(listener: NavigatorDecorationListener): () => void;
  subscribeDecorationActivations(listener: NavigatorDecorationActivationListener): () => void;
  subscribeActivations(listener: NavigatorActivationListener): () => void;
  subscribeExternalFormAttempts(listener: NavigatorExternalFormAttemptListener): () => void;
  subscribeFootnotes(listener: NavigatorFootnoteListener): () => void;
  /** Reports reader-initiated presentation movement handled inside the committed document. */
  subscribePresentationActivity(listener: NavigatorPresentationActivityListener): () => void;
  returnFromFootnote(activationId: number): Promise<NavigatorFootnoteReturnResult>;
  setActiveDecoration(projectionRevision: number, id: string | null): void;
  activateDecorationLink(activation: NavigatorDecorationActivation): void;
  /** Replaces the committed document's narration target; `null` clears narration state. */
  setMediaOverlayActive(target: MediaOverlayActiveTarget | null): Promise<MediaOverlayActiveResult>;
  /** Finds the first fragment at or after the visible start of the committed occurrence. */
  findMediaOverlayEntry(
    occurrence: number,
    fragments: readonly string[],
  ): Promise<MediaOverlayEntryResult>;
  paginationSnapshot(): BookPaginationSnapshot;
  subscribePagination(listener: PaginationSnapshotListener): () => void;
  setPaginationCapabilities(capabilities: PublicationPaginationCapabilities | undefined): void;
  fixedViewState(): FixedViewState | null;
  fixedRollProgression?(): number | null;
  visibleOccurrenceRange(): VisibleOccurrenceRange | null;
  /**
   * Leading occurrence of the book's final view when that view is a spread, so a reader can place
   * the end of the book on its progress rail. The pairing follows the authored spread properties
   * and the live frame size, which only the compositor knows. Null when the final view holds a
   * single occurrence.
   */
  finalSpreadLeadingOccurrence(): number | null;
  setFixedZoom(zoom: number, focalPoint?: FixedViewPoint): FixedViewState | null;
  panFixedBy(delta: FixedViewPoint, intrinsic?: boolean): FixedViewState | null;
  close(): KernelTransition;
}

export interface MediaOverlayActiveTarget {
  readonly occurrence: number;
  readonly fragment: string;
  readonly activeClasses: readonly string[];
  readonly playbackActiveClasses: readonly string[];
}

export type MediaOverlayActiveResult =
  | { readonly status: "applied"; readonly visible: boolean; readonly occurrence: number }
  | { readonly status: "cleared" | "missing" | "unsupported" | "stale" | "failed" };

export type MediaOverlayEntryResult =
  | { readonly status: "found"; readonly index: number }
  | { readonly status: "none" | "unsupported" | "stale" | "failed" };

export type NavigatorTransitionListener = (transition: KernelTransition) => void;

export type NavigatorErrorListener = (error: NavigatorError) => void;

export type ReaderConfiguration = AgentConfiguration;

export type NavigatorInteraction = { readonly participant: ActiveDocumentParticipant } & (
  | Pick<AgentInteractionMessage, "command" | "source">
  | {
      readonly command: "fixed-zoom";
      readonly source: "keyboard" | "pointer" | "touch";
      readonly factor: number;
      readonly focal: FixedViewPoint;
    }
  | {
      readonly command: "fixed-pan";
      readonly source: "keyboard" | "pointer" | "touch";
      readonly delta: FixedViewPoint;
    }
  | { readonly command: "fixed-reset"; readonly source: "keyboard" }
);

export type NavigatorInteractionListener = (interaction: NavigatorInteraction) => void;

export type NavigatorSelectionListener = (snapshot: NavigatorSelectionSnapshot) => void;

export type NavigatorDecorationListener = (snapshot: DecorationSnapshot) => void;

export interface NavigatorDecorationActivation {
  readonly participant: ActiveDocumentParticipant;
  readonly projectionRevision: number;
  readonly ids: readonly string[];
  readonly anchor: ReaderViewportAnchor;
  readonly link: AgentLinkActivation | null;
}

export type NavigatorDecorationActivationListener = (
  activation: NavigatorDecorationActivation,
) => void;

export interface NavigatorActivation {
  readonly participant: ActiveDocumentParticipant;
  readonly href: string;
  readonly resolvedUrl: string;
  readonly target: string | null;
  readonly download: string | null;
  readonly internal: boolean;
  readonly footnote: NavigatorFootnoteNavigation | null;
  /**
   * Set when the agent recognised a note reference and deliberately left the page where it was,
   * because the reader shows the note itself.
   */
  readonly noteReference: {
    readonly referenceRect: { x: number; y: number; width: number; height: number } | null;
    readonly referenceLabel: string | null;
  } | null;
}

export type NavigatorActivationListener = (activation: NavigatorActivation) => void;

export interface NavigatorExternalFormAttempt {
  readonly action: string | null;
  readonly resolvedUrl: string;
  readonly method: string;
  readonly target: string | null;
}

export type NavigatorExternalFormAttemptListener = (
  attempt: NavigatorExternalFormAttempt & {
    readonly participant: ActiveDocumentParticipant;
  },
) => void;

export type NavigatorFootnoteListener = (navigation: NavigatorFootnoteNavigation | null) => void;

export type NavigatorPresentationActivityListener = (activity: {
  readonly participant: ActiveDocumentParticipant;
}) => void;

export type { VisibleCompanionOccurrence, VisibleOccurrenceRange } from "../../generated/kernel.js";
export type { NavigatorFootnoteReturnResult } from "../../footnotes.js";
