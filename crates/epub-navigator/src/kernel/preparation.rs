use crate::kernel::{
    AdapterLayoutPlan, AdapterLayoutSettlement, AgentOperationKind, PhysicalFrame,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Data-bearing lifecycle of one adjacent non-current physical frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PreparedFrameState {
    Loading,
    AgentInitializing,
    LayoutQueued {
        supported_operations: Vec<AgentOperationKind>,
    },
    LayoutInitializing {
        supported_operations: Vec<AgentOperationKind>,
        plan: AdapterLayoutPlan,
    },
    Prepared {
        supported_operations: Vec<AgentOperationKind>,
        layout: Box<PreparedLayout>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedFrame {
    pub frame: PhysicalFrame,
    pub state: PreparedFrameState,
}

impl PreparedFrame {
    pub(in crate::kernel) fn frame(&self) -> &PhysicalFrame {
        &self.frame
    }

    pub(in crate::kernel) fn is_prepared(&self) -> bool {
        matches!(self.state, PreparedFrameState::Prepared { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedLayout {
    pub layout_generation: u32,
    pub settlement: AdapterLayoutSettlement,
}
