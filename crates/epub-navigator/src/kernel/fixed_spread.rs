use crate::kernel::{
    AdapterLayoutSettlement, AgentOperationKind, DocumentObservation, LayoutInvalidationCause,
    PhysicalFrame,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Physical page slot occupied by one fixed-layout spread participant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum FixedSpreadPlacement {
    Left,
    Right,
    Center,
}

impl FixedSpreadPlacement {
    pub(in crate::kernel) fn opposite(self) -> Self {
        match self {
            Self::Left => Self::Right,
            Self::Right => Self::Left,
            Self::Center => Self::Center,
        }
    }
}

/// One coherent settled layout retained for a fixed companion frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixedCompanionLayout {
    pub owner_document_generation: u32,
    pub frame_generation: u32,
    pub layout_generation: u32,
    pub settlement: AdapterLayoutSettlement,
}

/// Companion-specific browser observation retained independently from the primary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixedCompanionLayoutObservation {
    pub document: DocumentObservation,
}

/// Live layout lifecycle for a fixed companion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FixedCompanionLayoutState {
    Settled {
        layout: FixedCompanionLayout,
        observation: FixedCompanionLayoutObservation,
    },
    Dirty {
        layout: FixedCompanionLayout,
        observation: FixedCompanionLayoutObservation,
        cause: LayoutInvalidationCause,
    },
    Updating {
        layout: FixedCompanionLayout,
        observation: FixedCompanionLayoutObservation,
    },
}

/// Secondary fixed-page document owned by exactly one committed primary generation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixedCompanionDocument {
    pub owner_document_generation: u32,
    pub frame: PhysicalFrame,
    pub placement: FixedSpreadPlacement,
    pub supported_operations: Vec<AgentOperationKind>,
    pub layout: FixedCompanionLayoutState,
}
