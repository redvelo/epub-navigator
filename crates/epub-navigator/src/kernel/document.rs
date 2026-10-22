use crate::kernel::{
    AdapterLayoutPlan, AgentOperationKind, CommittedLayoutState, CurrentLocationCaptureBasis,
    PreparedFrame, PreparedFrameState,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Browser document implementation selected for one reading-order occurrence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentAdapter {
    ReflowableXhtml,
    FixedXhtml,
    FixedSvg,
    FixedImage,
}

/// Exact live document participant addressed by browser runtime work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ActiveDocumentParticipant {
    Primary {
        document_generation: u32,
    },
    FixedCompanion {
        owner_document_generation: u32,
        frame_generation: u32,
    },
}

impl ActiveDocumentParticipant {
    pub(in crate::kernel) fn owner_document_generation(self) -> u32 {
        match self {
            Self::Primary {
                document_generation,
            } => document_generation,
            Self::FixedCompanion {
                owner_document_generation,
                ..
            } => owner_document_generation,
        }
    }
}

/// Identity and immutable publication context of one physical browser frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhysicalFrame {
    pub generation: u32,
    pub occurrence: u32,
    pub resource: String,
    pub adapter: DocumentAdapter,
}

/// Data-bearing lifecycle of one pending document replacement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PendingDocumentState {
    Loading {
        frame: PhysicalFrame,
    },
    AgentInitializing {
        frame: PhysicalFrame,
    },
    LayoutInitializing {
        frame: PhysicalFrame,
        supported_operations: Vec<AgentOperationKind>,
        plan: AdapterLayoutPlan,
    },
    Preparing {
        prepared: Box<PreparedFrame>,
    },
    PromotionAcknowledging {
        prepared: Box<PreparedFrame>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingDocument {
    pub generation: u32,
    pub state: PendingDocumentState,
}

impl PendingDocument {
    pub(in crate::kernel) fn frame(&self) -> &PhysicalFrame {
        match &self.state {
            PendingDocumentState::Loading { frame }
            | PendingDocumentState::AgentInitializing { frame }
            | PendingDocumentState::LayoutInitializing { frame, .. } => frame,
            PendingDocumentState::Preparing { prepared }
            | PendingDocumentState::PromotionAcknowledging { prepared } => prepared.frame(),
        }
    }

    pub(in crate::kernel) fn frame_generation(&self) -> u32 {
        self.frame().generation
    }

    pub(in crate::kernel) fn supported_operations(self) -> Vec<AgentOperationKind> {
        match self.state {
            PendingDocumentState::LayoutInitializing {
                supported_operations,
                ..
            } => supported_operations,
            PendingDocumentState::PromotionAcknowledging { prepared } => match prepared.state {
                PreparedFrameState::Prepared {
                    supported_operations,
                    ..
                } => supported_operations,
                _ => unreachable!("only settled prepared frames are promotable"),
            },
            _ => unreachable!("committed pending document has initialized its adapter"),
        }
    }
}

/// One successfully committed physical frame and its live layout state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommittedDocument {
    pub generation: u32,
    pub frame: PhysicalFrame,
    pub supported_operations: Vec<AgentOperationKind>,
    pub layout: CommittedLayoutState,
}

impl CommittedDocument {
    pub(in crate::kernel) fn frame_generation(&self) -> u32 {
        self.frame.generation
    }

    pub(in crate::kernel) fn occurrence(&self) -> u32 {
        self.frame.occurrence
    }

    pub(in crate::kernel) fn resource(&self) -> &str {
        &self.frame.resource
    }
}

pub(in crate::kernel) fn current_location_basis_matches(
    committed: &CommittedDocument,
    basis: &CurrentLocationCaptureBasis,
) -> bool {
    basis.document_generation == committed.generation
        && basis.frame_generation == committed.frame_generation()
        && basis.layout_generation == committed.layout.layout().layout_generation
}
