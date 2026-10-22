use crate::kernel::{
    AnnotationTargetGenerationCandidateStatus, AnnotationTargetGenerationUnavailableReason,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Logical edge of a controlled annotation range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum AnnotationRangeEdge {
    Start,
    End,
}

/// Logical word-step direction, independent of document writing direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum AnnotationRangeMovement {
    Backward,
    Forward,
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::kernel) struct PendingAnnotationRangeAdjustment {
    pub(in crate::kernel) projection_revision: u32,
    pub(in crate::kernel) record_id: String,
    pub(in crate::kernel) edge: AnnotationRangeEdge,
    pub(in crate::kernel) movement: AnnotationRangeMovement,
    pub(in crate::kernel) source: String,
}

/// Browser-generated adjustment data correlated to one controlled decoration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationRangeAdjustmentCandidate {
    pub projection_revision: u32,
    pub record_id: String,
    pub edge: AnnotationRangeEdge,
    pub movement: AnnotationRangeMovement,
    pub status: AnnotationTargetGenerationCandidateStatus,
    pub excerpt: Option<String>,
}

/// Kernel-finalized result of one controlled word-step range adjustment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AnnotationRangeAdjustmentOutcome {
    Adjusted {
        target_json: String,
        excerpt: String,
    },
    Unavailable {
        reason: AnnotationTargetGenerationUnavailableReason,
    },
    Unsupported,
    Ambiguous,
    Conflict,
    Stale,
    Failed {
        message: Option<String>,
    },
}
