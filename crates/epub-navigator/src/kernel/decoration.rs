use crate::kernel::AnnotationTargetResolutionPlan;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DecorationAppearance {
    AnnotationHighlight,
    AnnotationNote,
    SearchResult,
    ActiveSearchResult,
    TemporaryEmphasis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecorationRecord {
    pub id: String,
    pub target_json: String,
    pub occurrence: u32,
    pub appearance: DecorationAppearance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecorationProjection {
    pub revision: u32,
    pub records: Vec<DecorationRecord>,
}

/// Comparable publication position derived from one controlled decoration target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecorationRecordPosition {
    pub id: String,
    pub occurrence: u32,
    /// Exact unsigned decimal document text start, when direct alternatives agree.
    pub document_text_start: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectedDecorationRecord {
    pub id: String,
    pub plan: AnnotationTargetResolutionPlan,
    pub appearance: DecorationAppearance,
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::kernel) struct PendingDecorationReconciliation {
    pub(in crate::kernel) projection_revision: u32,
    pub(in crate::kernel) ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DecorationRecordOutcome {
    Rendered,
    Broken,
    Ambiguous,
    Conflict,
    Unavailable { message: Option<String> },
    Unsupported,
    Stale,
    Failed { message: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecorationRecordResult {
    pub id: String,
    pub outcome: DecorationRecordOutcome,
}
