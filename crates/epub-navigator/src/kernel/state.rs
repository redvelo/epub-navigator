use crate::kernel::{
    ActiveDocumentParticipant, AgentOperationKind, AnnotationTargetResolutionPlan,
    CommittedDocument, DecorationProjection, DecorationRecordPosition, FixedCompanionDocument,
    KernelPublication, ParticipantDecorationOutcomes, PendingAnnotationRangeAdjustment,
    PendingAnnotationTargetGeneration, PendingDecorationReconciliation, PendingDocument,
    PendingLayoutOperation, PointEvidence, PreparedFrame, PresentationPreferences,
    ProjectedDecorationRecord,
};

/// Logical publication-session lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SessionState {
    /// The publication session is open.
    Open,
    /// The publication session is closed.
    Closed,
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::kernel) struct PendingOperation {
    pub(in crate::kernel) operation: u32,
    pub(in crate::kernel) participant: ActiveDocumentParticipant,
    pub(in crate::kernel) frame_generation: u32,
    pub(in crate::kernel) metadata: PendingOperationMetadata,
}

impl PendingOperation {
    pub(in crate::kernel) fn operation_kind(&self) -> AgentOperationKind {
        self.metadata.operation_kind()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::kernel) enum PendingOperationMetadata {
    ResolveLocator,
    Relocate,
    ResolveAnnotationTarget(AnnotationTargetResolutionPlan),
    RelocateAnnotationTarget(AnnotationTargetResolutionPlan),
    CaptureSelection,
    CaptureCurrentLocation,
    GenerateAnnotationTarget(PendingAnnotationTargetGeneration),
    GenerateCurrentLocationAnnotationTarget(PendingAnnotationTargetGeneration),
    ReconcileDecorations(PendingDecorationReconciliation),
    AdjustAnnotationRange(PendingAnnotationRangeAdjustment),
    AdvancePresentation,
    FindMediaOverlayEntry { fragment_count: usize },
}

impl PendingOperationMetadata {
    fn operation_kind(&self) -> AgentOperationKind {
        match self {
            Self::ResolveLocator => AgentOperationKind::ResolveLocator,
            Self::Relocate => AgentOperationKind::Relocate,
            Self::ResolveAnnotationTarget(_) => AgentOperationKind::ResolveAnnotationTarget,
            Self::RelocateAnnotationTarget(_) => AgentOperationKind::RelocateAnnotationTarget,
            Self::CaptureSelection => AgentOperationKind::CaptureSelection,
            Self::CaptureCurrentLocation => AgentOperationKind::CaptureCurrentLocation,
            Self::GenerateAnnotationTarget(_) => AgentOperationKind::GenerateAnnotationTarget,
            Self::GenerateCurrentLocationAnnotationTarget(_) => {
                AgentOperationKind::GenerateCurrentLocationAnnotationTarget
            }
            Self::ReconcileDecorations(_) => AgentOperationKind::ReconcileDecorations,
            Self::AdjustAnnotationRange(_) => AgentOperationKind::AdjustAnnotationRange,
            Self::AdvancePresentation => AgentOperationKind::AdvancePresentation,
            Self::FindMediaOverlayEntry { .. } => AgentOperationKind::FindMediaOverlayEntry,
        }
    }
}

/// Portable deterministic Navigator state.
#[derive(Debug)]
pub struct NavigatorKernel {
    pub(in crate::kernel) state_revision: u32,
    pub(in crate::kernel) state: SessionState,
    pub(in crate::kernel) publication: KernelPublication,
    pub(in crate::kernel) document_generation: u32,
    pub(in crate::kernel) frame_generation: u32,
    pub(in crate::kernel) layout_generation: u32,
    pub(in crate::kernel) pending: Option<PendingDocument>,
    pub(in crate::kernel) pending_exact_position: Option<Vec<PointEvidence>>,
    pub(in crate::kernel) committed: Option<CommittedDocument>,
    pub(in crate::kernel) fixed_companion: Option<FixedCompanionDocument>,
    pub(in crate::kernel) agent_operation: u32,
    pub(in crate::kernel) layout_operation: u32,
    pub(in crate::kernel) pending_operations: Vec<PendingOperation>,
    pub(in crate::kernel) decoration_projection: DecorationProjection,
    pub(in crate::kernel) decoration_record_positions: Vec<DecorationRecordPosition>,
    pub(in crate::kernel) projected_decorations: Vec<(u32, ProjectedDecorationRecord)>,
    pub(in crate::kernel) decoration_outcomes: Vec<ParticipantDecorationOutcomes>,
    pub(in crate::kernel) preferences: PresentationPreferences,
    pub(in crate::kernel) pending_layout: Option<PendingLayoutOperation>,
    pub(in crate::kernel) prepared_frames: Vec<PreparedFrame>,
}
