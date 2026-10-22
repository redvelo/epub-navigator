use crate::kernel::{
    AdapterLayoutPlan, DocumentObservation, FixedSettlement, LayoutInvalidationCause, LayoutIssue,
    LayoutMeasurement, LayoutPhase, PendingAdapterLayout, PresentationPreferences,
    ReflowPositionRequest, ReflowableLayoutMode, ReflowableSettlement,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Independent identity and ownership for one layout transaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingLayoutOperation {
    pub operation: u32,
    pub frame_generation: u32,
    pub layout_generation: u32,
    pub owner: LayoutOwner,
    pub adapter: PendingAdapterLayout,
}

/// Exact logical owner of the single serialized layout transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LayoutOwner {
    Document {
        document_generation: u32,
        phase: LayoutPhase,
    },
    FixedCompanion {
        owner_document_generation: u32,
        frame_generation: u32,
    },
    PreparedFrame,
}

/// One coherent adapter settlement with its complete reflow plan where applicable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "adapter",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AdapterLayoutSettlement {
    ReflowableXhtml {
        requested: PresentationPreferences,
        mode: ReflowableLayoutMode,
        notice: Option<LayoutIssue>,
        settlement: ReflowableSettlement,
        position: ReflowPositionRequest,
        align_x_center: bool,
    },
    FixedXhtml {
        settlement: FixedSettlement,
    },
    FixedSvg {
        settlement: FixedSettlement,
    },
    FixedImage {
        settlement: FixedSettlement,
    },
}

impl AdapterLayoutSettlement {
    pub(in crate::kernel) fn plan(&self) -> AdapterLayoutPlan {
        match self {
            Self::ReflowableXhtml {
                requested,
                mode,
                notice,
                align_x_center,
                ..
            } => AdapterLayoutPlan::ReflowableXhtml {
                requested: *requested,
                mode: *mode,
                notice: *notice,
                align_x_center: *align_x_center,
            },
            Self::FixedXhtml { .. } => AdapterLayoutPlan::FixedXhtml,
            Self::FixedSvg { .. } => AdapterLayoutPlan::FixedSvg,
            Self::FixedImage { .. } => AdapterLayoutPlan::FixedImage,
        }
    }

    pub(in crate::kernel) fn measurement(&self) -> &LayoutMeasurement {
        match self {
            Self::ReflowableXhtml { settlement, .. } => settlement.measurement(),
            Self::FixedXhtml { settlement }
            | Self::FixedSvg { settlement }
            | Self::FixedImage { settlement } => settlement.measurement(),
        }
    }
}

/// Last coherent layout committed for a document generation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommittedLayout {
    pub document_generation: u32,
    pub layout_generation: u32,
    pub settlement: AdapterLayoutSettlement,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommittedLayoutState {
    Settled {
        layout: CommittedLayout,
        observation: DocumentObservation,
    },
    Dirty {
        layout: CommittedLayout,
        observation: DocumentObservation,
        cause: LayoutInvalidationCause,
    },
    Updating {
        layout: CommittedLayout,
        observation: DocumentObservation,
    },
}

impl CommittedLayoutState {
    pub(in crate::kernel) fn layout(&self) -> &CommittedLayout {
        match self {
            Self::Settled { layout, .. }
            | Self::Dirty { layout, .. }
            | Self::Updating { layout, .. } => layout,
        }
    }

    pub(in crate::kernel) fn observation(&self) -> &DocumentObservation {
        match self {
            Self::Settled { observation, .. }
            | Self::Dirty { observation, .. }
            | Self::Updating { observation, .. } => observation,
        }
    }
}
