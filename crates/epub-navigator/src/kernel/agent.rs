use crate::kernel::{
    AdapterLayoutSettlement, AnnotationPointTargetGenerationCandidate,
    AnnotationRangeAdjustmentCandidate, AnnotationRangeEdge, AnnotationRangeMovement,
    AnnotationTargetGenerationCandidate, AnnotationTargetReconciliationResult,
    AnnotationTargetResolutionPlan, AnnotationTextFragmentPolicy, CurrentLocationCaptureOutcome,
    DecorationRecordResult, FixedLayoutIssue, LayoutIssue, LocatorResolutionStatus,
    NativeSelectionCaptureOutcome, NavigatorLocation, PresentationAdvanceDirection,
    PresentationAdvanceStatus, ProjectedDecorationRecord,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Agent operation represented by a request, result, capability, or timeout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum AgentOperationKind {
    ResolveLocator,
    Relocate,
    ResolveAnnotationTarget,
    RelocateAnnotationTarget,
    CaptureSelection,
    CaptureCurrentLocation,
    GenerateAnnotationTarget,
    GenerateCurrentLocationAnnotationTarget,
    ReconcileDecorations,
    AdjustAnnotationRange,
    AdvancePresentation,
    FindMediaOverlayEntry,
}

/// Browser outcome of locating the first Media Overlay text fragment at or after the viewport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MediaOverlayEntryOutcome {
    /// Index of the first listed fragment intersecting or following the viewport.
    Found { index: u32 },
    /// No listed fragment intersects or follows the viewport.
    None {},
    /// The document layout was not settled when the lookup ran.
    Unavailable {},
    /// The document adapter cannot locate text fragments.
    Unsupported {},
}

/// Whether a layout transaction is gating initial commit or updating a live frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutPhase {
    Initial,
    Update,
}

/// Raw evidence for one ordinary anchor activation in the committed document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkActivation {
    pub href: String,
    pub resolved_url: String,
    pub target: Option<String>,
    pub download: Option<String>,
}

/// One operation request sent to the committed document's content agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentRequest {
    ResolveLocator {
        locator: NavigatorLocation,
    },
    Relocate {
        locator: NavigatorLocation,
    },
    ResolveAnnotationTarget {
        plan: AnnotationTargetResolutionPlan,
    },
    RelocateAnnotationTarget {
        plan: AnnotationTargetResolutionPlan,
    },
    CaptureSelection {},
    CaptureCurrentLocation {},
    GenerateAnnotationTarget {
        location: NavigatorLocation,
        local_content_basis: u32,
        text_fragment_policy: AnnotationTextFragmentPolicy,
    },
    GenerateCurrentLocationAnnotationTarget {
        location: NavigatorLocation,
        local_content_basis: u32,
    },
    ReconcileDecorations {
        projection_revision: u32,
        records: Vec<ProjectedDecorationRecord>,
    },
    AdjustAnnotationRange {
        projection_revision: u32,
        record_id: String,
        edge: AnnotationRangeEdge,
        movement: AnnotationRangeMovement,
    },
    AdvancePresentation {
        direction: PresentationAdvanceDirection,
    },
    FindMediaOverlayEntry {
        fragments: Vec<String>,
    },
}

/// One normalized result received from a committed document's content agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentResult {
    ResolveLocator {
        status: LocatorResolutionStatus,
    },
    Relocate {
        status: LocatorResolutionStatus,
    },
    ResolveAnnotationTarget {
        result: AnnotationTargetReconciliationResult,
    },
    RelocateAnnotationTarget {
        result: AnnotationTargetReconciliationResult,
    },
    CaptureSelection {
        outcome: NativeSelectionCaptureOutcome,
    },
    CaptureCurrentLocation {
        outcome: CurrentLocationCaptureOutcome,
    },
    GenerateAnnotationTarget {
        candidate: AnnotationTargetGenerationCandidate,
    },
    GenerateCurrentLocationAnnotationTarget {
        candidate: AnnotationPointTargetGenerationCandidate,
    },
    ReconcileDecorations {
        projection_revision: u32,
        outcomes: Vec<DecorationRecordResult>,
    },
    AdjustAnnotationRange {
        candidate: AnnotationRangeAdjustmentCandidate,
    },
    AdvancePresentation {
        status: PresentationAdvanceStatus,
    },
    FindMediaOverlayEntry {
        outcome: MediaOverlayEntryOutcome,
    },
}

impl AgentResult {
    pub(in crate::kernel) fn operation_kind(&self) -> AgentOperationKind {
        match self {
            Self::ResolveLocator { .. } => AgentOperationKind::ResolveLocator,
            Self::Relocate { .. } => AgentOperationKind::Relocate,
            Self::ResolveAnnotationTarget { .. } => AgentOperationKind::ResolveAnnotationTarget,
            Self::RelocateAnnotationTarget { .. } => AgentOperationKind::RelocateAnnotationTarget,
            Self::CaptureSelection { .. } => AgentOperationKind::CaptureSelection,
            Self::CaptureCurrentLocation { .. } => AgentOperationKind::CaptureCurrentLocation,
            Self::GenerateAnnotationTarget { .. } => AgentOperationKind::GenerateAnnotationTarget,
            Self::GenerateCurrentLocationAnnotationTarget { .. } => {
                AgentOperationKind::GenerateCurrentLocationAnnotationTarget
            }
            Self::ReconcileDecorations { .. } => AgentOperationKind::ReconcileDecorations,
            Self::AdjustAnnotationRange { .. } => AgentOperationKind::AdjustAnnotationRange,
            Self::AdvancePresentation { .. } => AgentOperationKind::AdvancePresentation,
            Self::FindMediaOverlayEntry { .. } => AgentOperationKind::FindMediaOverlayEntry,
        }
    }
}

pub(in crate::kernel) enum TerminalLayout {
    Settled(Box<AdapterLayoutSettlement>),
    ReflowableConflict(LayoutIssue),
    ReflowableUnavailable(LayoutIssue),
    FixedConflict(FixedLayoutIssue),
    FixedUnavailable(FixedLayoutIssue),
}

/// Structured terminal failure of one content-agent operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "code",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentOperationFailure {
    OperationTimeout {
        message: String,
    },
    OperationCancelled {
        reason: AgentOperationCancellationReason,
    },
    OperationDeliveryFailed {
        message: String,
    },
}

/// Reducer-owned reason an in-flight content-agent operation was cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum AgentOperationCancellationReason {
    Replacement,
    FixedCompanionDetached,
    DocumentInvalidated,
    LayoutInvalidated,
    PreferenceChanged,
    ProjectionSuperseded,
    SelectionSuperseded,
    Close,
}
