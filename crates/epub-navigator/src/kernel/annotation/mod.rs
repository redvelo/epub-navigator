mod adjustment;
mod generation;
mod projection;
mod reconciliation;

pub use adjustment::{
    AnnotationRangeAdjustmentCandidate, AnnotationRangeAdjustmentOutcome, AnnotationRangeEdge,
    AnnotationRangeMovement,
};
pub use generation::{
    AnnotationCssPointCandidate, AnnotationCssRangeCandidate, AnnotationDocumentPointCandidate,
    AnnotationDocumentRangeCandidate, AnnotationPointSelectorCandidate,
    AnnotationPointTargetGenerationCandidate, AnnotationPointTargetGenerationCandidateStatus,
    AnnotationSelectorCandidate, AnnotationTargetGenerationCandidate,
    AnnotationTargetGenerationCandidateStatus, AnnotationTargetGenerationOutcome,
    AnnotationTargetGenerationUnavailableReason, AnnotationTextFragmentPolicy,
};
pub use projection::{
    AnnotationInvalidSelectorValues, AnnotationResourceSelectorValues, AnnotationSelectorNode,
    AnnotationStringSelectorValues, AnnotationTargetResolutionPlan,
    AnnotationTextPositionSelectorValues, AnnotationUnsupportedSelectorValues,
};
pub use reconciliation::{
    AnnotationSelectorExecutionOutcome, AnnotationSelectorExecutionReport, AnnotationSelectorKind,
    AnnotationTargetReconciliationResult, LocatorResolutionStatus, ResolvedAnnotationSegment,
};

pub(in crate::kernel) use adjustment::PendingAnnotationRangeAdjustment;
pub(in crate::kernel) use generation::{
    PendingAnnotationTargetGeneration, finalize_annotation_point_target_candidate,
    finalize_annotation_target_candidate, validate_decimal_offset,
};
pub(in crate::kernel) use projection::{
    ProjectedAnnotationTarget, annotation_document_text_start, project_annotation_selectors,
    validate_nonempty_point_evidence, validate_resource_path, validate_selection_locator_limits,
};
pub(in crate::kernel) use reconciliation::decoration_outcome_valid;
