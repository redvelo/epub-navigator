use crate::kernel::{
    ActiveDocumentParticipant, AgentOperationFailure, AgentOperationKind, AgentRequest,
    AgentResult, AnnotationRangeAdjustmentOutcome, AnnotationRangeEdge, AnnotationRangeMovement,
    AnnotationTargetGenerationOutcome, AnnotationTargetResolutionPlan,
    AnnotationTextFragmentPolicy, DecorationProjection, DocumentAdapter, DocumentObservation,
    FixedLayoutIssue, FixedSpreadPlacement, LayoutInvalidationCause, LayoutIssue, LayoutOwner,
    LayoutPhase, LayoutRequest, LayoutResult, LinkActivation, NavigatorFailure, NavigatorLocation,
    PointEvidence, PresentationAdvanceDirection, PresentationAdvanceTarget,
    PresentationPreferences,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// A user or application command for the deterministic kernel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NavigatorCommand {
    /// Begin loading one exact reading-order occurrence.
    OpenOccurrence {
        /// Snapshot-local occurrence identity.
        occurrence: u32,
    },
    /// Begin loading an occurrence at exact reflowable point evidence.
    ///
    /// This always creates a fresh frame. Fixed-layout adapters safely ignore the
    /// reflow-only evidence and perform their normal managed containment layout.
    OpenOccurrenceAt {
        /// Snapshot-local occurrence identity.
        occurrence: u32,
        evidence: Vec<PointEvidence>,
    },
    /// Prepare a loadable occurrence adjacent to the committed document.
    PrepareOccurrence {
        occurrence: u32,
    },
    /// Transfer one settled prepared fixed frame into the current spread.
    AttachFixedCompanion {
        owner_document_generation: u32,
        frame_generation: u32,
        placement: FixedSpreadPlacement,
    },
    /// Remove the exact fixed companion from the current spread.
    DetachFixedCompanion {
        owner_document_generation: u32,
        frame_generation: u32,
    },
    /// Evict every non-current prepared frame.
    EvictPreparedFrames {},
    /// Load the previous visible reading step, including `linear=no` occurrences.
    Previous {},
    /// Load the next visible reading step, including `linear=no` occurrences.
    Next {},
    /// Begin a fresh load of the current occurrence.
    Reload {},
    /// Cancel the pending document load, if any.
    CancelDocument {},
    /// Ask the browser adapter to reconcile a locator against the committed document.
    ResolveLocator {
        /// Locator to reconcile.
        locator: NavigatorLocation,
    },
    /// Ask the committed content agent to relocate to a publication locator.
    Relocate {
        locator: NavigatorLocation,
    },
    /// Resolve a projected annotation target against the committed primary document.
    ResolveAnnotationTarget {
        plan: AnnotationTargetResolutionPlan,
    },
    /// Resolve and relocate to a projected annotation target in the committed primary document.
    RelocateAnnotationTarget {
        plan: AnnotationTargetResolutionPlan,
    },
    /// Capture the native selection belonging to one exact active document.
    CaptureSelection {
        participant: ActiveDocumentParticipant,
    },
    CaptureCurrentLocation {},
    /// Locate the first Media Overlay text fragment at or after the settled primary viewport.
    FindMediaOverlayEntry {
        occurrence: u32,
        fragments: Vec<String>,
    },
    /// Generate a portable annotation target for a previously captured selection range.
    GenerateAnnotationTarget {
        participant: ActiveDocumentParticipant,
        location: NavigatorLocation,
        local_content_basis: u32,
        text_fragment_policy: AnnotationTextFragmentPolicy,
    },
    /// Generate an authored target for the exact current-location point.
    GenerateCurrentLocationAnnotationTarget {
        participant: ActiveDocumentParticipant,
        location: NavigatorLocation,
        local_content_basis: u32,
    },
    CancelSelectionAnnotationTargetGeneration {},
    SetDecorationProjection {
        projection: DecorationProjection,
    },
    ReconcileDecorations {},
    /// Adjust one exact currently rendered controlled decoration by one logical word step.
    AdjustAnnotationRange {
        participant: ActiveDocumentParticipant,
        projection_revision: u32,
        record_id: String,
        edge: AnnotationRangeEdge,
        movement: AnnotationRangeMovement,
    },
    /// Ask the committed primary, or its reflowable fixed companion, to advance its live
    /// presentation.
    AdvancePresentation {
        direction: PresentationAdvanceDirection,
        target: PresentationAdvanceTarget,
    },
    /// Replace the validated session preference copy without replacing the frame.
    SetPresentationPreferences {
        preferences: PresentationPreferences,
    },
    /// Close the logical session.
    Close {},
    /// Validate locator invariants independent of the live DOM.
    ValidateLocator {
        /// Locator to validate.
        locator: NavigatorLocation,
    },
}

/// Typed reason a pending browser frame failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(
    tag = "reason",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FrameFailureReason {
    LoadError,
    UnexpectedNavigation,
    EffectExecutionFailed { message: String },
    ReadinessTimeout,
    ReflowableLayoutConflict { issue: LayoutIssue },
    ReflowableLayoutUnavailable { issue: LayoutIssue },
    FixedLayoutConflict { issue: FixedLayoutIssue },
    FixedLayoutUnavailable { issue: FixedLayoutIssue },
}

impl<'de> Deserialize<'de> for FrameFailureReason {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        FrameFailureReasonRepr::deserialize(deserializer).map(Into::into)
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "reason",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum FrameFailureReasonRepr {
    LoadError {},
    UnexpectedNavigation {},
    EffectExecutionFailed { message: String },
    ReadinessTimeout {},
    ReflowableLayoutConflict { issue: LayoutIssue },
    ReflowableLayoutUnavailable { issue: LayoutIssue },
    FixedLayoutConflict { issue: FixedLayoutIssue },
    FixedLayoutUnavailable { issue: FixedLayoutIssue },
}

impl From<FrameFailureReasonRepr> for FrameFailureReason {
    fn from(reason: FrameFailureReasonRepr) -> Self {
        match reason {
            FrameFailureReasonRepr::LoadError {} => Self::LoadError,
            FrameFailureReasonRepr::UnexpectedNavigation {} => Self::UnexpectedNavigation,
            FrameFailureReasonRepr::EffectExecutionFailed { message } => {
                Self::EffectExecutionFailed { message }
            }
            FrameFailureReasonRepr::ReadinessTimeout {} => Self::ReadinessTimeout,
            FrameFailureReasonRepr::ReflowableLayoutConflict { issue } => {
                Self::ReflowableLayoutConflict { issue }
            }
            FrameFailureReasonRepr::ReflowableLayoutUnavailable { issue } => {
                Self::ReflowableLayoutUnavailable { issue }
            }
            FrameFailureReasonRepr::FixedLayoutConflict { issue } => {
                Self::FixedLayoutConflict { issue }
            }
            FrameFailureReasonRepr::FixedLayoutUnavailable { issue } => {
                Self::FixedLayoutUnavailable { issue }
            }
        }
    }
}

/// Typed reason a committed document became unusable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentInvalidationReason {
    UnexpectedNavigation,
    ContentDocumentUnavailable,
}

/// A browser-frame lifecycle report about reducer-owned work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FrameObservation {
    Loaded {
        generation: u32,
    },
    Failed {
        generation: u32,
        reason: FrameFailureReason,
    },
    Promoted {
        frame_generation: u32,
    },
}

/// A content-adapter report about reducer-owned work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AdapterObservation {
    DocumentInvalidated {
        participant: ActiveDocumentParticipant,
        generation: u32,
        reason: DocumentInvalidationReason,
    },
    Ready {
        generation: u32,
        supported_operations: Vec<AgentOperationKind>,
    },
    ReadinessTimeout {
        generation: u32,
    },
    AgentResult {
        participant: ActiveDocumentParticipant,
        operation: u32,
        generation: u32,
        result: AgentResult,
    },
    LayoutResult {
        participant: Option<ActiveDocumentParticipant>,
        operation: u32,
        generation: u32,
        layout_generation: u32,
        result: LayoutResult,
    },
    LayoutTimeout {
        participant: Option<ActiveDocumentParticipant>,
        operation: u32,
        generation: u32,
        layout_generation: u32,
    },
    LayoutDeliveryFailed {
        participant: Option<ActiveDocumentParticipant>,
        operation: u32,
        generation: u32,
        layout_generation: u32,
        message: String,
    },
    LayoutInvalidated {
        participant: Option<ActiveDocumentParticipant>,
        generation: u32,
        cause: LayoutInvalidationCause,
    },
    OperationTimeout {
        participant: ActiveDocumentParticipant,
        operation: u32,
        generation: u32,
    },
    OperationDeliveryFailed {
        participant: ActiveDocumentParticipant,
        operation: u32,
        generation: u32,
        message: String,
    },
    DocumentObserved {
        participant: ActiveDocumentParticipant,
        generation: u32,
        observation: DocumentObservation,
    },
    LinkActivated {
        participant: ActiveDocumentParticipant,
        generation: u32,
        activation: LinkActivation,
    },
}

/// Strict category envelope consumed by the reducer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelInput {
    Command { command: NavigatorCommand },
    Frame { frame: FrameObservation },
    Adapter { adapter: AdapterObservation },
}

impl From<NavigatorCommand> for KernelInput {
    fn from(command: NavigatorCommand) -> Self {
        Self::Command { command }
    }
}

impl From<FrameObservation> for KernelInput {
    fn from(frame: FrameObservation) -> Self {
        Self::Frame { frame }
    }
}

impl From<AdapterObservation> for KernelInput {
    fn from(adapter: AdapterObservation) -> Self {
        Self::Adapter { adapter }
    }
}

/// Observable kernel event emitted by an accepted transition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum KernelEvent {
    /// A document replacement is pending.
    DocumentPending {
        generation: u32,
        occurrence: u32,
        resource: String,
    },
    /// A loaded document became committed.
    DocumentCommitted {
        generation: u32,
        occurrence: u32,
        resource: String,
    },
    /// A settled prepared frame became the primary document's fixed companion.
    FixedCompanionAttached {
        owner_document_generation: u32,
        frame_generation: u32,
        occurrence: u32,
        placement: FixedSpreadPlacement,
    },
    /// A fixed companion was removed without invalidating its primary document.
    FixedCompanionDetached {
        owner_document_generation: u32,
        frame_generation: u32,
    },
    /// A pending document load was cancelled.
    DocumentCancelled { generation: u32 },
    /// A pending document load failed.
    DocumentLoadFailed {
        generation: u32,
        reason: FrameFailureReason,
    },
    /// A committed document was invalidated by an exact-generation browser report.
    DocumentInvalidated {
        participant: ActiveDocumentParticipant,
        generation: u32,
        reason: DocumentInvalidationReason,
    },
    /// A new layout generation superseded prior measurements.
    LayoutPending {
        participant: Option<ActiveDocumentParticipant>,
        operation: u32,
        generation: u32,
        layout_generation: u32,
        phase: LayoutPhase,
    },
    /// A layout transaction produced an accepted terminal result.
    LayoutReported {
        participant: Option<ActiveDocumentParticipant>,
        operation: u32,
        generation: u32,
        layout_generation: u32,
        result: LayoutResult,
    },
    /// A content-agent operation result was accepted.
    AgentOperationReported {
        participant: ActiveDocumentParticipant,
        operation: u32,
        generation: u32,
        result: AgentResult,
    },
    /// Browser selector evidence was validated and finalized by the kernel.
    AnnotationTargetGenerationReported {
        participant: ActiveDocumentParticipant,
        operation: u32,
        generation: u32,
        outcome: AnnotationTargetGenerationOutcome,
    },
    /// Browser adjustment evidence was validated and finalized by the kernel.
    AnnotationRangeAdjustmentReported {
        participant: ActiveDocumentParticipant,
        operation: u32,
        generation: u32,
        outcome: AnnotationRangeAdjustmentOutcome,
    },
    /// A content-agent operation ended without a current result.
    AgentOperationFailed {
        participant: ActiveDocumentParticipant,
        operation: u32,
        generation: u32,
        operation_kind: AgentOperationKind,
        failure: AgentOperationFailure,
    },
    /// A layout operation ended without an adapter settlement.
    LayoutOperationFailed {
        participant: Option<ActiveDocumentParticipant>,
        operation: u32,
        generation: u32,
        failure: AgentOperationFailure,
    },
    /// A coherent observation of the exact committed document was accepted.
    DocumentObserved {
        participant: ActiveDocumentParticipant,
        generation: u32,
        observation: DocumentObservation,
    },
    /// Raw ordinary-link activation evidence was accepted.
    LinkActivated {
        participant: ActiveDocumentParticipant,
        activation: LinkActivation,
    },
    /// The logical session closed.
    Closed,
    /// A locator passed portable validation.
    LocatorValidated,
}

/// Ordered browser work emitted by an accepted transition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum KernelEffect {
    /// Replace the browser frame with one occurrence's canonical resource.
    ReplaceFrame {
        #[serde(rename = "frameGeneration")]
        generation: u32,
        occurrence: u32,
        resource: String,
    },
    /// Cancel frame-owned listeners and work for a generation.
    CancelFrame {
        #[serde(rename = "frameGeneration")]
        generation: u32,
    },
    /// Initialize the content agent in a loaded pending frame.
    InitializeAgent {
        #[serde(rename = "frameGeneration")]
        generation: u32,
        occurrence: u32,
        resource: String,
        adapter: DocumentAdapter,
    },
    /// Send one request to the current committed document's content agent.
    AgentRequest {
        participant: ActiveDocumentParticipant,
        operation: u32,
        #[serde(rename = "frameGeneration")]
        generation: u32,
        request: AgentRequest,
    },
    /// Send one generation-correlated layout request to a pending or committed frame.
    LayoutRequest {
        owner: LayoutOwner,
        operation: u32,
        #[serde(rename = "frameGeneration")]
        generation: u32,
        layout_generation: u32,
        request: LayoutRequest,
    },
    /// Create a hidden physical frame owned by the preparation lifecycle.
    CreatePreparedFrame {
        #[serde(rename = "frameGeneration")]
        generation: u32,
        occurrence: u32,
        resource: String,
    },
    /// Promote a settled physical frame to a fresh logical document generation.
    PromoteFrame {
        frame_generation: u32,
        document_generation: u32,
    },
}

/// Result of one transactional kernel command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KernelTransition {
    /// Whether the command was accepted.
    pub accepted: bool,
    /// Revision after this transition.
    pub state_revision: u32,
    /// Ordered events emitted by the transition.
    pub events: Vec<KernelEvent>,
    /// Ordered browser effects emitted by the transition.
    pub effects: Vec<KernelEffect>,
    /// Structured rejection, when not accepted.
    pub failure: Option<NavigatorFailure>,
}
