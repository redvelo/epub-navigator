use epub_navigator::facts::PublicationFacts;
use epub_navigator::kernel::{
    ActiveDocumentParticipant, AdapterLayoutPlan, AdapterLayoutSettlement, AdapterObservation,
    AgentOperationCancellationReason, AgentOperationFailure, AgentOperationKind, AgentRequest,
    AgentResult, AnnotationCssPointCandidate, AnnotationCssRangeCandidate,
    AnnotationDocumentPointCandidate, AnnotationDocumentRangeCandidate,
    AnnotationInvalidSelectorValues, AnnotationPointSelectorCandidate,
    AnnotationPointTargetGenerationCandidate, AnnotationPointTargetGenerationCandidateStatus,
    AnnotationRangeAdjustmentCandidate, AnnotationRangeAdjustmentOutcome, AnnotationRangeEdge,
    AnnotationRangeMovement, AnnotationResourceSelectorValues, AnnotationSelectorCandidate,
    AnnotationSelectorExecutionOutcome, AnnotationSelectorExecutionReport, AnnotationSelectorKind,
    AnnotationSelectorNode, AnnotationStringSelectorValues, AnnotationTargetGenerationCandidate,
    AnnotationTargetGenerationCandidateStatus, AnnotationTargetGenerationOutcome,
    AnnotationTargetGenerationUnavailableReason, AnnotationTargetReconciliationResult,
    AnnotationTargetResolutionPlan, AnnotationTextFragmentPolicy,
    AnnotationTextPositionSelectorValues, AnnotationUnsupportedSelectorValues, CommittedDocument,
    CommittedLayout, CommittedLayoutState, ContentOriginProfile, CurrentLocationCaptureBasis,
    CurrentLocationCaptureOutcome, DecorationAppearance, DecorationProjection, DecorationRecord,
    DecorationRecordOutcome, DecorationRecordPosition, DecorationRecordResult, DecorationSnapshot,
    DocumentAdapter, DocumentCanvas, DocumentDirection, DocumentEntry, DocumentInvalidationReason,
    DocumentObservation, DocumentSnapshot, DocumentViewport, DocumentWritingMode,
    FixedCompanionDocument, FixedCompanionLayout, FixedCompanionLayoutObservation,
    FixedCompanionLayoutState, FixedIntrinsicViewport, FixedLayoutIssue, FixedLayoutOutcome,
    FixedPageGeometry, FixedSettlement, FixedSpreadPlacement, FontScale, FrameFailureReason,
    FrameObservation, Hyphenation, KernelEffect, KernelEvent, KernelInput, KernelSnapshot,
    KernelTransition, LayoutInvalidationCause, LayoutIssue, LayoutMeasurement, LayoutOwner,
    LayoutPhase, LayoutRepairReport, LayoutRequest, LayoutResult, LayoutSnapshot, LetterSpacing,
    LineHeight, LinkActivation, LocatorObservation, LocatorResolutionStatus, LogicalSize,
    MediaOverlayEntryOutcome, NativeSelectionCaptureOutcome, NativeSelectionCaptureReason,
    NativeSelectionDirection, NavigationBoundary, NavigatorCommand, NavigatorFailure,
    NavigatorLocation, NavigatorLocationBasis, NavigatorLocationCapture, NavigatorLocationSnapshot,
    ObservedBoundary, OccurrenceDocumentTarget, OccurrenceLinear,
    OccurrencePageProgressionDirection, OccurrencePageSpread, OccurrencePresentation,
    OccurrenceRenditionCandidate, OccurrenceRenditionFlow, OccurrenceRenditionLayout,
    OccurrenceRenditionOrientation, OccurrenceRenditionSetting, OccurrenceRenditionSpread,
    OccurrenceRenditionValueSource, OccurrenceUnavailableReason, PaginatedLayout,
    PaginationColumns, ParagraphSpacing, ParticipantDecorationOutcomes, PendingAdapterLayout,
    PendingAgentOperation, PendingDocument, PendingDocumentState, PendingLayoutOperation,
    PhysicalFrame, PhysicalMovementVector, PointEvidence, PreparedFrame, PreparedFrameState,
    PreparedLayout, PresentationAdvanceDirection, PresentationAdvanceStatus,
    PresentationAdvanceTarget, PresentationAdvanceUnavailableReason, PresentationMode,
    PresentationPreferences, ProjectedDecorationRecord, PublicationColorScheme, PublicationMount,
    PublicationTheme, PublicationTypeface, RangeEvidence, ReaderViewportAnchor, ReaderViewportRect,
    ReadingMeasure, ReadingOrderOccurrence, ReadingOrderTarget, ReflowPositionRequest,
    ReflowableLayoutMode, ReflowableLayoutOutcome, ReflowablePresentation, ReflowableSettlement,
    RemoteResourcePolicy, RequiredAssetSettlement, ResolvedAnnotationSegment, RootScrollbar,
    SelectionCaptureBasis, SelectionGesture, SessionState, TextAlignment, TextIndent,
    VisibleCompanionOccurrence, VisibleOccurrenceRange, WordSpacing,
};
use specta::Types;
use specta_typescript::Typescript;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let publication_types = Types::default().register::<PublicationFacts<'static>>();
    Typescript::default().export_to(
        manifest_directory.join("../../target/publication.generated.ts"),
        &publication_types,
        specta_serde::Format,
    )?;

    let types = Types::default()
        .register::<RemoteResourcePolicy>()
        .register::<ContentOriginProfile>()
        .register::<PublicationMount>()
        .register::<LocatorObservation>()
        .register::<PointEvidence>()
        .register::<RangeEvidence>()
        .register::<NavigatorLocation>()
        .register::<NavigatorLocationBasis>()
        .register::<VisibleCompanionOccurrence>()
        .register::<VisibleOccurrenceRange>()
        .register::<NavigatorLocationSnapshot>()
        .register::<CurrentLocationCaptureBasis>()
        .register::<CurrentLocationCaptureOutcome>()
        .register::<MediaOverlayEntryOutcome>()
        .register::<NavigatorLocationCapture>()
        .register::<AnnotationResourceSelectorValues>()
        .register::<AnnotationStringSelectorValues>()
        .register::<AnnotationTextPositionSelectorValues>()
        .register::<AnnotationInvalidSelectorValues>()
        .register::<AnnotationUnsupportedSelectorValues>()
        .register::<AnnotationSelectorNode>()
        .register::<AnnotationTargetResolutionPlan>()
        .register::<AnnotationSelectorKind>()
        .register::<AnnotationSelectorExecutionOutcome>()
        .register::<ResolvedAnnotationSegment>()
        .register::<AnnotationSelectorExecutionReport>()
        .register::<AnnotationTargetReconciliationResult>()
        .register::<ReadingOrderTarget>()
        .register::<OccurrenceLinear>()
        .register::<DocumentAdapter>()
        .register::<OccurrenceUnavailableReason>()
        .register::<OccurrenceDocumentTarget>()
        .register::<OccurrenceRenditionValueSource>()
        .register::<OccurrenceRenditionCandidate<OccurrenceRenditionLayout>>()
        .register::<OccurrenceRenditionSetting<OccurrenceRenditionLayout>>()
        .register::<OccurrenceRenditionLayout>()
        .register::<OccurrenceRenditionFlow>()
        .register::<PresentationMode>()
        .register::<PaginationColumns>()
        .register::<PublicationTheme>()
        .register::<PublicationColorScheme>()
        .register::<PublicationTypeface>()
        .register::<FontScale>()
        .register::<LetterSpacing>()
        .register::<WordSpacing>()
        .register::<ParagraphSpacing>()
        .register::<TextIndent>()
        .register::<LineHeight>()
        .register::<ReadingMeasure>()
        .register::<TextAlignment>()
        .register::<Hyphenation>()
        .register::<RootScrollbar>()
        .register::<PresentationPreferences>()
        .register::<ReflowableLayoutMode>()
        .register::<LayoutIssue>()
        .register::<AdapterLayoutPlan>()
        .register::<ReflowablePresentation>()
        .register::<OccurrenceRenditionOrientation>()
        .register::<OccurrenceRenditionSpread>()
        .register::<OccurrencePageSpread>()
        .register::<FixedSpreadPlacement>()
        .register::<ActiveDocumentParticipant>()
        .register::<NativeSelectionDirection>()
        .register::<SelectionGesture>()
        .register::<SelectionCaptureBasis>()
        .register::<ReaderViewportRect>()
        .register::<ReaderViewportAnchor>()
        .register::<NativeSelectionCaptureReason>()
        .register::<NativeSelectionCaptureOutcome>()
        .register::<AnnotationTextFragmentPolicy>()
        .register::<AnnotationCssRangeCandidate>()
        .register::<AnnotationDocumentRangeCandidate>()
        .register::<AnnotationSelectorCandidate>()
        .register::<AnnotationCssPointCandidate>()
        .register::<AnnotationDocumentPointCandidate>()
        .register::<AnnotationPointSelectorCandidate>()
        .register::<AnnotationPointTargetGenerationCandidateStatus>()
        .register::<AnnotationPointTargetGenerationCandidate>()
        .register::<AnnotationTargetGenerationUnavailableReason>()
        .register::<AnnotationTargetGenerationCandidateStatus>()
        .register::<AnnotationTargetGenerationCandidate>()
        .register::<AnnotationTargetGenerationOutcome>()
        .register::<AnnotationRangeEdge>()
        .register::<AnnotationRangeMovement>()
        .register::<AnnotationRangeAdjustmentCandidate>()
        .register::<AnnotationRangeAdjustmentOutcome>()
        .register::<DecorationAppearance>()
        .register::<DecorationRecord>()
        .register::<DecorationProjection>()
        .register::<DecorationRecordPosition>()
        .register::<ProjectedDecorationRecord>()
        .register::<DecorationRecordOutcome>()
        .register::<DecorationRecordResult>()
        .register::<ParticipantDecorationOutcomes>()
        .register::<DecorationSnapshot>()
        .register::<OccurrencePageProgressionDirection>()
        .register::<OccurrencePresentation>()
        .register::<ReadingOrderOccurrence>()
        .register::<NavigationBoundary>()
        .register::<LocatorResolutionStatus>()
        .register::<DocumentWritingMode>()
        .register::<DocumentDirection>()
        .register::<DocumentViewport>()
        .register::<DocumentCanvas>()
        .register::<ObservedBoundary>()
        .register::<DocumentObservation>()
        .register::<DocumentEntry>()
        .register::<ReflowPositionRequest>()
        .register::<LogicalSize>()
        .register::<PhysicalMovementVector>()
        .register::<RequiredAssetSettlement>()
        .register::<LayoutMeasurement>()
        .register::<PaginatedLayout>()
        .register::<LayoutRepairReport>()
        .register::<ReflowableSettlement>()
        .register::<FixedIntrinsicViewport>()
        .register::<FixedPageGeometry>()
        .register::<FixedLayoutIssue>()
        .register::<FixedSettlement>()
        .register::<AdapterLayoutSettlement>()
        .register::<LayoutRequest>()
        .register::<ReflowableLayoutOutcome>()
        .register::<FixedLayoutOutcome>()
        .register::<LayoutResult>()
        .register::<LayoutInvalidationCause>()
        .register::<LayoutPhase>()
        .register::<LinkActivation>()
        .register::<AgentOperationKind>()
        .register::<PresentationAdvanceDirection>()
        .register::<PresentationAdvanceTarget>()
        .register::<PresentationAdvanceUnavailableReason>()
        .register::<PresentationAdvanceStatus>()
        .register::<AgentRequest>()
        .register::<AgentResult>()
        .register::<AgentOperationCancellationReason>()
        .register::<AgentOperationFailure>()
        .register::<NavigatorFailure>()
        .register::<NavigatorCommand>()
        .register::<FrameObservation>()
        .register::<AdapterObservation>()
        .register::<KernelInput>()
        .register::<FrameFailureReason>()
        .register::<DocumentInvalidationReason>()
        .register::<KernelEffect>()
        .register::<KernelEvent>()
        .register::<KernelTransition>()
        .register::<SessionState>()
        .register::<PhysicalFrame>()
        .register::<PendingDocument>()
        .register::<PendingDocumentState>()
        .register::<CommittedDocument>()
        .register::<FixedCompanionLayout>()
        .register::<FixedCompanionLayoutObservation>()
        .register::<FixedCompanionLayoutState>()
        .register::<FixedCompanionDocument>()
        .register::<CommittedLayoutState>()
        .register::<DocumentSnapshot>()
        .register::<PendingAgentOperation>()
        .register::<PendingLayoutOperation>()
        .register::<PendingAdapterLayout>()
        .register::<LayoutOwner>()
        .register::<PreparedFrameState>()
        .register::<PreparedFrame>()
        .register::<PreparedLayout>()
        .register::<CommittedLayout>()
        .register::<LayoutSnapshot>()
        .register::<KernelSnapshot>();
    let output = manifest_directory.join("../../target/kernel.generated.ts");

    Typescript::default().export_to(output, &types, specta_serde::Format)?;
    Ok(())
}
