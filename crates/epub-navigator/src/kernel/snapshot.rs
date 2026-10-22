use crate::kernel::{
    ActiveDocumentParticipant, AgentOperationKind, CommittedDocument, DecorationProjection,
    DecorationRecordPosition, DecorationRecordResult, FixedCompanionDocument, NavigatorKernel,
    PendingDocument, PendingLayoutOperation, PendingOperation, PreparedFrame,
    PresentationPreferences, PublicationLayout, ReadingOrderOccurrence, SessionState,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Coherent diagnostic snapshot of the logical kernel state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KernelSnapshot {
    /// Current transition revision.
    pub state_revision: u32,
    /// Current logical session state.
    pub session: SessionState,
    /// Canonical package path from the accepted facts snapshot.
    pub package_path: String,
    /// Effective package-global policy; does not imply rendering support or settlement.
    pub publication_layout: PublicationLayout,
    /// Number of reading-order occurrences in the accepted facts snapshot.
    pub reading_order_length: u32,
    /// Ordinal-aligned occurrence facts retained by the kernel.
    pub reading_order: Vec<ReadingOrderOccurrence>,
    /// Pending and committed document lifecycle state.
    pub document: DocumentSnapshot,
    pub prepared_frames: Vec<PreparedFrame>,
    /// Content-agent operations currently awaiting results.
    pub pending_agent_operations: Vec<PendingAgentOperation>,
    /// Latest complete controlled decoration state and browser outcomes.
    pub decorations: DecorationSnapshot,
    /// Validated session preferences and current layout transaction state.
    pub layout: LayoutSnapshot,
}

/// Independent identity and document context for pending agent work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingAgentOperation {
    pub operation: u32,
    pub participant: ActiveDocumentParticipant,
    pub frame_generation: u32,
    pub operation_kind: AgentOperationKind,
}

impl PendingOperation {
    pub(in crate::kernel) fn snapshot(&self) -> PendingAgentOperation {
        PendingAgentOperation {
            operation: self.operation,
            participant: self.participant,
            frame_generation: self.frame_generation,
            operation_kind: self.operation_kind(),
        }
    }
}

/// Latest outcomes reported by one exact active document participant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParticipantDecorationOutcomes {
    pub participant: ActiveDocumentParticipant,
    pub projection_revision: u32,
    pub outcomes: Vec<DecorationRecordResult>,
}

/// Coherent controlled-decoration state retained by the kernel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecorationSnapshot {
    pub projection: DecorationProjection,
    pub record_positions: Vec<DecorationRecordPosition>,
    pub participant_outcomes: Vec<ParticipantDecorationOutcomes>,
}

/// Independent pending and last-committed document state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    /// Replacement currently awaiting a browser observation.
    pub pending: Option<PendingDocument>,
    /// Last successfully loaded document, retained across replacement failures.
    pub committed: Option<CommittedDocument>,
    /// Optional secondary fixed page owned by the committed primary generation.
    pub fixed_companion: Option<FixedCompanionDocument>,
}

/// Coherent reducer-owned presentation and layout snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSnapshot {
    pub preferences: PresentationPreferences,
    pub layout_generation: u32,
    pub pending: Option<PendingLayoutOperation>,
}

impl NavigatorKernel {
    /// Returns a coherent diagnostic snapshot.
    pub fn snapshot(&self) -> KernelSnapshot {
        KernelSnapshot {
            state_revision: self.state_revision,
            session: self.state,
            package_path: self.publication.package_path.clone(),
            publication_layout: self.publication.publication_layout,
            reading_order_length: self.publication.reading_order_length,
            reading_order: self.publication.reading_order.clone(),
            document: DocumentSnapshot {
                pending: self.pending.clone(),
                committed: self.committed.clone(),
                fixed_companion: self.fixed_companion.clone(),
            },
            prepared_frames: self.prepared_frames.clone(),
            pending_agent_operations: self
                .pending_operations
                .iter()
                .map(PendingOperation::snapshot)
                .collect(),
            decorations: DecorationSnapshot {
                projection: self.decoration_projection.clone(),
                record_positions: self.decoration_record_positions.clone(),
                participant_outcomes: self.decoration_outcomes.clone(),
            },
            layout: LayoutSnapshot {
                preferences: self.preferences,
                layout_generation: self.layout_generation,
                pending: self.pending_layout.clone(),
            },
        }
    }
}
