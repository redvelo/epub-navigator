use crate::kernel::{
    AnnotationTargetResolutionPlan, DecorationRecordOutcome, KernelError,
    MAX_ANNOTATION_AGGREGATE_STRING_BYTES, MAX_ANNOTATION_SELECTOR_DEPTH,
    MAX_ANNOTATION_SELECTOR_NODES, MAX_ANNOTATION_SELECTOR_VALUE_BYTES,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Browser locator reconciliation outcome without live DOM values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LocatorResolutionStatus {
    /// The requested locator resolved to one browser range or point.
    Resolved,
    /// No matching browser range or point was found.
    NotFound { message: String },
    /// More than one browser range or point matched.
    Ambiguous { message: String },
    /// Corroborating evidence identified conflicting locations.
    ConflictingEvidence { message: String },
    /// The browser adapter does not support the supplied evidence.
    UnsupportedEvidence { message: String },
    /// Browser reconciliation failed operationally.
    Failed { message: String },
}
/// Stable selector kind copied into execution reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum AnnotationSelectorKind {
    Resource,
    HtmlFragment,
    Css,
    TextPosition,
    TextFragment,
    Invalid,
    Unsupported,
}

/// Browser-authoritative selector or branch outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum AnnotationSelectorExecutionOutcome {
    Resolved,
    Broken,
    Ambiguous,
    Invalid,
    Unsupported,
    Conflict,
    Unavailable,
    Stale,
    Failed,
}

/// The kind of live segment selected in the committed document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResolvedAnnotationSegment {
    Resource { resource: String },
    Element { resource: String },
    Point { resource: String },
    Range { resource: String },
}

impl ResolvedAnnotationSegment {
    fn resource(&self) -> &str {
        match self {
            Self::Resource { resource }
            | Self::Element { resource }
            | Self::Point { resource }
            | Self::Range { resource } => resource,
        }
    }

    fn same_kind(&self, other: &Self) -> bool {
        matches!(
            (self, other),
            (Self::Resource { .. }, Self::Resource { .. })
                | (Self::Element { .. }, Self::Element { .. })
                | (Self::Point { .. }, Self::Point { .. })
                | (Self::Range { .. }, Self::Range { .. })
        )
    }
}

/// Browser report for one selector node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationSelectorExecutionReport {
    pub path: Vec<u32>,
    pub kind: AnnotationSelectorKind,
    pub outcome: AnnotationSelectorExecutionOutcome,
    pub match_count: u32,
    pub segment: Option<ResolvedAnnotationSegment>,
    pub message: Option<String>,
}

/// Portable reconciliation result returned by the browser agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationTargetReconciliationResult {
    pub outcome: AnnotationSelectorExecutionOutcome,
    pub reports: Vec<AnnotationSelectorExecutionReport>,
    pub segment: Option<ResolvedAnnotationSegment>,
}

impl AnnotationTargetReconciliationResult {
    pub(in crate::kernel) fn validate(
        &self,
        resource: &str,
        plan: &AnnotationTargetResolutionPlan,
    ) -> Result<(), KernelError> {
        if self.reports.len() > MAX_ANNOTATION_SELECTOR_NODES
            || (self.outcome == AnnotationSelectorExecutionOutcome::Resolved)
                != self.segment.is_some()
            || (self.outcome == AnnotationSelectorExecutionOutcome::Resolved
                && self.reports.is_empty())
            || self
                .segment
                .as_ref()
                .is_some_and(|segment| segment.resource() != resource)
            || self.reports.iter().any(|report| {
                report.path.is_empty()
                    || report.path.len() > MAX_ANNOTATION_SELECTOR_DEPTH
                    || report
                        .message
                        .as_ref()
                        .is_some_and(|message| message.len() > MAX_ANNOTATION_SELECTOR_VALUE_BYTES)
                    || report
                        .segment
                        .as_ref()
                        .is_some_and(|segment| segment.resource() != resource)
            })
        {
            return Err(KernelError::InvalidAnnotationTarget);
        }

        let mut expected = Vec::new();
        let mut pending = plan.selectors.iter().collect::<Vec<_>>();
        while let Some(node) = pending.pop() {
            expected.push((node.path(), node.kind()));
            pending.extend(node.refinements());
        }
        let mut reported_paths = Vec::<&[u32]>::new();
        let mut string_bytes = self
            .segment
            .as_ref()
            .map_or(0, |segment| segment.resource().len());
        for report in &self.reports {
            if !expected
                .iter()
                .any(|(path, kind)| *path == report.path && *kind == report.kind)
                || reported_paths.contains(&report.path.as_slice())
                || (report.path.len() > 1
                    && !self.reports.iter().any(|parent| {
                        parent.path.as_slice() == &report.path[..report.path.len() - 1]
                            && matches!(
                                parent.outcome,
                                AnnotationSelectorExecutionOutcome::Resolved
                                    | AnnotationSelectorExecutionOutcome::Ambiguous
                                    | AnnotationSelectorExecutionOutcome::Stale
                            )
                    }))
                || !report_outcome_segment_valid(report)
            {
                return Err(KernelError::InvalidAnnotationTarget);
            }
            reported_paths.push(&report.path);
            string_bytes = string_bytes
                .checked_add(report.message.as_ref().map_or(0, String::len))
                .and_then(|total| {
                    total.checked_add(
                        report
                            .segment
                            .as_ref()
                            .map_or(0, |segment| segment.resource().len()),
                    )
                })
                .ok_or(KernelError::InvalidAnnotationTarget)?;
            if string_bytes > MAX_ANNOTATION_AGGREGATE_STRING_BYTES {
                return Err(KernelError::InvalidAnnotationTarget);
            }
        }
        if !reconciliation_outcome_valid(self) {
            return Err(KernelError::InvalidAnnotationTarget);
        }
        Ok(())
    }
}

fn reconciliation_outcome_valid(result: &AnnotationTargetReconciliationResult) -> bool {
    match result.outcome {
        AnnotationSelectorExecutionOutcome::Resolved => {
            result.segment.as_ref().is_some_and(|segment| {
                result.reports.iter().any(|report| {
                    matches!(
                        report.outcome,
                        AnnotationSelectorExecutionOutcome::Resolved
                            | AnnotationSelectorExecutionOutcome::Ambiguous
                    ) && report
                        .segment
                        .as_ref()
                        .is_some_and(|candidate| segment.same_kind(candidate))
                })
            })
        }
        AnnotationSelectorExecutionOutcome::Conflict => {
            result
                .reports
                .iter()
                .filter(|report| report.outcome == AnnotationSelectorExecutionOutcome::Resolved)
                .count()
                >= 2
                || result
                    .reports
                    .iter()
                    .any(|report| report.outcome == AnnotationSelectorExecutionOutcome::Conflict)
        }
        AnnotationSelectorExecutionOutcome::Failed => true,
        outcome => result
            .reports
            .iter()
            .any(|report| report.outcome == outcome),
    }
}

fn report_outcome_segment_valid(report: &AnnotationSelectorExecutionReport) -> bool {
    match report.outcome {
        AnnotationSelectorExecutionOutcome::Resolved => {
            report.match_count == 1 && report.segment.is_some()
        }
        AnnotationSelectorExecutionOutcome::Broken
        | AnnotationSelectorExecutionOutcome::Invalid
        | AnnotationSelectorExecutionOutcome::Unsupported
        | AnnotationSelectorExecutionOutcome::Unavailable => {
            report.match_count == 0 && report.segment.is_none()
        }
        AnnotationSelectorExecutionOutcome::Ambiguous => report.match_count > 1,
        AnnotationSelectorExecutionOutcome::Conflict => report.segment.is_none(),
        AnnotationSelectorExecutionOutcome::Stale | AnnotationSelectorExecutionOutcome::Failed => {
            true
        }
    }
}

/// Browser-authoritative block and inline flow orientation.
pub(in crate::kernel) fn decoration_outcome_valid(outcome: &DecorationRecordOutcome) -> bool {
    match outcome {
        DecorationRecordOutcome::Unavailable { message }
        | DecorationRecordOutcome::Failed { message } => message
            .as_ref()
            .is_none_or(|message| message.len() <= MAX_ANNOTATION_SELECTOR_VALUE_BYTES),
        _ => true,
    }
}
