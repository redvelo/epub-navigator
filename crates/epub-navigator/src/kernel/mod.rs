//! Portable, deterministic state kernel for EPUB Navigator.

mod agent;
mod annotation;
mod decoration;
mod document;
mod error;
mod fixed_spread;
mod host;
mod layout;
mod location;
mod preparation;
mod presentation;
mod protocol;
mod publication;
mod reducer;
mod selection;
mod snapshot;
mod state;

pub use agent::{
    AgentOperationCancellationReason, AgentOperationFailure, AgentOperationKind, AgentRequest,
    AgentResult, LayoutPhase, LinkActivation, MediaOverlayEntryOutcome,
};
pub use annotation::{
    AnnotationCssPointCandidate, AnnotationCssRangeCandidate, AnnotationDocumentPointCandidate,
    AnnotationDocumentRangeCandidate, AnnotationInvalidSelectorValues,
    AnnotationPointSelectorCandidate, AnnotationPointTargetGenerationCandidate,
    AnnotationPointTargetGenerationCandidateStatus, AnnotationRangeAdjustmentCandidate,
    AnnotationRangeAdjustmentOutcome, AnnotationRangeEdge, AnnotationRangeMovement,
    AnnotationResourceSelectorValues, AnnotationSelectorCandidate,
    AnnotationSelectorExecutionOutcome, AnnotationSelectorExecutionReport, AnnotationSelectorKind,
    AnnotationSelectorNode, AnnotationStringSelectorValues, AnnotationTargetGenerationCandidate,
    AnnotationTargetGenerationCandidateStatus, AnnotationTargetGenerationOutcome,
    AnnotationTargetGenerationUnavailableReason, AnnotationTargetReconciliationResult,
    AnnotationTargetResolutionPlan, AnnotationTextFragmentPolicy,
    AnnotationTextPositionSelectorValues, AnnotationUnsupportedSelectorValues,
    LocatorResolutionStatus, ResolvedAnnotationSegment,
};
pub use decoration::{
    DecorationAppearance, DecorationProjection, DecorationRecord, DecorationRecordOutcome,
    DecorationRecordPosition, DecorationRecordResult, ProjectedDecorationRecord,
};
pub use document::{
    ActiveDocumentParticipant, CommittedDocument, DocumentAdapter, PendingDocument,
    PendingDocumentState, PhysicalFrame,
};
pub use error::{
    KernelError, MAX_ANNOTATION_AGGREGATE_STRING_BYTES, MAX_ANNOTATION_EXCERPT_BYTES,
    MAX_ANNOTATION_EXCERPT_CODE_POINTS, MAX_ANNOTATION_SELECTOR_DEPTH,
    MAX_ANNOTATION_SELECTOR_NODES, MAX_ANNOTATION_SELECTOR_VALUE_BYTES,
    MAX_ANNOTATION_TARGET_JSON_BYTES, MAX_DECORATION_ID_BYTES,
    MAX_SELECTION_CAPTURE_AGGREGATE_STRING_BYTES, MAX_SELECTION_CAPTURE_EVIDENCE_ITEMS,
    MAX_SELECTION_CAPTURE_STRING_BYTES, NavigatorFailure,
};
pub use fixed_spread::{
    FixedCompanionDocument, FixedCompanionLayout, FixedCompanionLayoutObservation,
    FixedCompanionLayoutState, FixedSpreadPlacement,
};
pub use host::{ContentOriginProfile, PublicationMount, RemoteResourcePolicy};
pub use layout::{
    AdapterLayoutSettlement, CommittedLayout, CommittedLayoutState, DocumentCanvas,
    DocumentDirection, DocumentEntry, DocumentObservation, DocumentViewport, DocumentWritingMode,
    FixedIntrinsicViewport, FixedIntrinsicViewportSource, FixedLayoutIssue, FixedLayoutOutcome,
    FixedPageGeometry, FixedSettlement, LayoutInvalidationCause, LayoutMeasurement, LayoutOwner,
    LayoutRepairReport, LayoutRequest, LayoutResult, LogicalSize, ObservedBoundary,
    PaginatedLayout, PaginationObservation, PendingAdapterLayout, PendingLayoutOperation,
    PhysicalMovementVector, ReflowPositionRequest, ReflowableLayoutOutcome, ReflowableSettlement,
    RequiredAssetSettlement, resolve_layout_plan,
};
pub use location::{
    CurrentLocationCaptureBasis, CurrentLocationCaptureOutcome, DocumentBoundary,
    LocatorObservation, NavigatorLocation, NavigatorLocationBasis, NavigatorLocationCapture,
    NavigatorLocationSnapshot, PointEvidence, RangeEvidence, VisibleCompanionOccurrence,
    VisibleOccurrenceRange,
};
pub use preparation::{PreparedFrame, PreparedFrameState, PreparedLayout};
pub use presentation::{
    AdapterLayoutPlan, FontScale, Hyphenation, LayoutIssue, LetterSpacing, LineHeight,
    PaginationColumns, ParagraphSpacing, PresentationAdvanceDirection, PresentationAdvanceStatus,
    PresentationAdvanceTarget, PresentationAdvanceUnavailableReason, PresentationMode,
    PresentationPreferences, PublicationColorScheme, PublicationTheme, PublicationTypeface,
    ReadingMeasure, ReflowableLayoutMode, ReflowablePresentation, RootScrollbar, TextAlignment,
    TextIndent, WordSpacing,
};
pub use protocol::{
    AdapterObservation, DocumentInvalidationReason, FrameFailureReason, FrameObservation,
    KernelEffect, KernelEvent, KernelInput, KernelTransition, NavigatorCommand,
};
pub use publication::{
    NavigationBoundary, OccurrenceDocumentTarget, OccurrenceLinear,
    OccurrencePageProgressionDirection, OccurrencePageSpread, OccurrencePresentation,
    OccurrenceRenditionCandidate, OccurrenceRenditionFlow, OccurrenceRenditionLayout,
    OccurrenceRenditionOrientation, OccurrenceRenditionSetting, OccurrenceRenditionSpread,
    OccurrenceRenditionValueSource, OccurrenceUnavailableReason, PublicationLayout,
    ReadingOrderOccurrence, ReadingOrderTarget, project_reading_order,
};
pub use selection::{
    NativeSelectionCaptureOutcome, NativeSelectionCaptureReason, NativeSelectionDirection,
    ReaderViewportAnchor, ReaderViewportRect, SelectionCaptureBasis, SelectionGesture,
};
pub use snapshot::{
    DecorationSnapshot, DocumentSnapshot, KernelSnapshot, LayoutSnapshot,
    ParticipantDecorationOutcomes, PendingAgentOperation,
};
pub use state::{NavigatorKernel, SessionState};

pub(in crate::kernel) use agent::TerminalLayout;
pub(in crate::kernel) use annotation::{
    PendingAnnotationRangeAdjustment, PendingAnnotationTargetGeneration, ProjectedAnnotationTarget,
    annotation_document_text_start, decoration_outcome_valid,
    finalize_annotation_point_target_candidate, finalize_annotation_target_candidate,
    project_annotation_selectors, validate_decimal_offset, validate_nonempty_point_evidence,
    validate_resource_path, validate_selection_locator_limits,
};
pub(in crate::kernel) use decoration::PendingDecorationReconciliation;
pub(in crate::kernel) use document::current_location_basis_matches;
pub(in crate::kernel) use publication::{KernelInitialization, KernelPublication, KernelResource};
pub(in crate::kernel) use state::{PendingOperation, PendingOperationMetadata};

#[cfg(test)]
mod tests;
