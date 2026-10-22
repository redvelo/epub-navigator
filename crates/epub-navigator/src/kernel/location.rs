use crate::kernel::{
    AgentOperationCancellationReason, FixedSpreadPlacement, KernelError, validate_decimal_offset,
    validate_nonempty_point_evidence, validate_resource_path,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Browser-derived fallback observations that never replace physical identity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocatorObservation {
    /// Finite `[0, 1]` logical progression through current browser layout.
    pub layout_progression: Option<f64>,
    /// Finite `[0, 1]` progression through current browser-rendered text.
    pub rendered_text_progression: Option<f64>,
}

impl LocatorObservation {
    pub(in crate::kernel) fn validate(&self) -> Result<(), KernelError> {
        for value in [self.layout_progression, self.rendered_text_progression]
            .into_iter()
            .flatten()
        {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err(KernelError::InvalidLocator);
            }
        }
        Ok(())
    }
}

/// One item of corroborating evidence for a browser-resolved point.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PointEvidence {
    /// Decoded XHTML fragment identifier.
    HtmlFragment {
        /// Decoded identifier.
        value: String,
    },
    /// Rendered text around a point.
    RenderedTextContext {
        /// Rendered text before the point.
        before: String,
        /// Rendered text after the point.
        after: String,
    },
    /// Unicode-code-point offset in the browser-owned normalized text snapshot.
    BrowserTextPosition {
        /// Canonical unsigned decimal offset.
        offset: String,
    },
    /// Explicit document start or end.
    DocumentBoundary {
        /// Selected document boundary.
        boundary: DocumentBoundary,
    },
}

impl PointEvidence {
    pub(in crate::kernel) fn validate(&self) -> Result<(), KernelError> {
        match self {
            Self::HtmlFragment { value } if value.is_empty() => {
                return Err(KernelError::InvalidLocator);
            }
            Self::RenderedTextContext { before, after }
                if before.is_empty() && after.is_empty() =>
            {
                return Err(KernelError::InvalidLocator);
            }
            Self::BrowserTextPosition { offset } => {
                validate_decimal_offset(offset)?;
            }
            Self::HtmlFragment { .. }
            | Self::RenderedTextContext { .. }
            | Self::DocumentBoundary { .. } => {}
        }
        Ok(())
    }
}

/// A document boundary used as exact point evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentBoundary {
    /// Start of the content document.
    Start,
    /// End of the content document.
    End,
}

/// One item of corroborating evidence for a same-document range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RangeEvidence {
    /// Rendered selected text and context.
    RenderedTextQuote {
        /// Exact selected text.
        exact: String,
        /// Text immediately before the selection.
        prefix: String,
        /// Text immediately after the selection.
        suffix: String,
    },
    /// Independent evidence for the inclusive start and exclusive end.
    Boundaries {
        /// Inclusive start evidence.
        start: Vec<PointEvidence>,
        /// Exclusive end evidence.
        end: Vec<PointEvidence>,
    },
    /// Half-open Unicode-code-point offsets in the browser-owned normalized text snapshot.
    BrowserTextPosition {
        /// Inclusive canonical unsigned decimal offset.
        start: String,
        /// Exclusive canonical unsigned decimal offset.
        end: String,
    },
}

impl RangeEvidence {
    fn validate(&self) -> Result<(), KernelError> {
        match self {
            Self::RenderedTextQuote { exact, .. } if exact.is_empty() => {
                return Err(KernelError::InvalidLocator);
            }
            Self::Boundaries { start, end } => {
                validate_nonempty_point_evidence(start)?;
                validate_nonempty_point_evidence(end)?;
            }
            Self::BrowserTextPosition { start, end } => {
                let start = validate_decimal_offset(start)?;
                let end = validate_decimal_offset(end)?;
                if start >= end {
                    return Err(KernelError::InvalidLocator);
                }
            }
            Self::RenderedTextQuote { .. } => {}
        }
        Ok(())
    }
}

/// A browser-resolved publication point or same-document range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NavigatorLocation {
    /// A point in one reading-order occurrence.
    Point {
        /// Snapshot-local reading-order occurrence.
        occurrence: u32,
        /// Canonical physical publication path.
        resource: String,
        /// Corroborating point evidence.
        evidence: Vec<PointEvidence>,
        /// Approximate browser observations.
        observation: LocatorObservation,
    },
    /// A half-open range in one reading-order occurrence and resource.
    Range {
        /// Snapshot-local reading-order occurrence.
        occurrence: u32,
        /// Canonical physical publication path.
        resource: String,
        /// Corroborating range evidence.
        evidence: Vec<RangeEvidence>,
        /// Approximate inclusive-start observations.
        start_observation: LocatorObservation,
        /// Approximate exclusive-end observations.
        end_observation: LocatorObservation,
    },
}

impl NavigatorLocation {
    /// Validates portable locator invariants that do not require a live browser DOM.
    pub fn validate(&self) -> Result<(), KernelError> {
        match self {
            Self::Point {
                resource,
                evidence,
                observation,
                ..
            } => {
                validate_resource_path(resource)?;
                validate_nonempty_point_evidence(evidence)?;
                observation.validate()?;
            }
            Self::Range {
                resource,
                evidence,
                start_observation,
                end_observation,
                ..
            } => {
                validate_resource_path(resource)?;
                if evidence.is_empty() {
                    return Err(KernelError::InvalidLocator);
                }
                for item in evidence {
                    item.validate()?;
                }
                start_observation.validate()?;
                end_observation.validate()?;
            }
        }
        Ok(())
    }

    pub(in crate::kernel) fn context(&self) -> (u32, &str) {
        match self {
            Self::Point {
                occurrence,
                resource,
                ..
            }
            | Self::Range {
                occurrence,
                resource,
                ..
            } => (*occurrence, resource),
        }
    }
}

/// Reducer-owned identity of the committed layout supporting a current location.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NavigatorLocationBasis {
    pub document_generation: u32,
    pub frame_generation: u32,
    pub layout_generation: u32,
}

/// One companion included in the currently visible fixed-layout spread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisibleCompanionOccurrence {
    pub occurrence: u32,
    pub placement: FixedSpreadPlacement,
}

/// Visible reading-order occurrences, with the operational primary kept explicit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisibleOccurrenceRange {
    pub primary_occurrence: u32,
    pub first_occurrence: u32,
    pub last_occurrence: u32,
    pub companion: Option<VisibleCompanionOccurrence>,
}

/// Last deduplicated passive current-location value published by the runtime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NavigatorLocationSnapshot {
    pub revision: u32,
    pub location: Option<NavigatorLocation>,
    pub basis: Option<NavigatorLocationBasis>,
    pub visible_occurrences: Option<VisibleOccurrenceRange>,
}

/// Exact reducer and content-agent generations supporting an explicit capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentLocationCaptureBasis {
    pub document_generation: u32,
    pub frame_generation: u32,
    pub layout_generation: u32,
    pub local_content_basis: u32,
    pub local_geometry_basis: u32,
}

/// Kernel-validated result produced by an explicit current-location agent operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CurrentLocationCaptureOutcome {
    Captured {
        location: NavigatorLocation,
        basis: CurrentLocationCaptureBasis,
    },
    Unavailable {
        basis: CurrentLocationCaptureBasis,
    },
    Stale {
        basis: CurrentLocationCaptureBasis,
    },
    Failed {
        message: Option<String>,
        basis: CurrentLocationCaptureBasis,
    },
}

/// Public terminal semantics of `captureCurrentLocation()`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NavigatorLocationCapture {
    Captured {
        location: NavigatorLocation,
        basis: CurrentLocationCaptureBasis,
        visible_occurrences: VisibleOccurrenceRange,
    },
    Unavailable {
        basis: Option<CurrentLocationCaptureBasis>,
    },
    Stale {
        basis: CurrentLocationCaptureBasis,
    },
    Failed {
        message: String,
        basis: Option<CurrentLocationCaptureBasis>,
    },
    Cancelled {
        reason: AgentOperationCancellationReason,
    },
}
