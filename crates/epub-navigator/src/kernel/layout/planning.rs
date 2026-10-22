use crate::kernel::{
    AdapterLayoutPlan, DocumentAdapter, KernelError, LayoutIssue, OccurrenceRenditionFlow,
    OccurrenceRenditionSetting, OccurrenceRenditionValueSource, PointEvidence, PresentationMode,
    PresentationPreferences, ReadingOrderOccurrence, ReflowableLayoutMode, ReflowablePresentation,
    validate_nonempty_point_evidence,
};
use serde::{Deserialize, Serialize};
use specta::Type;

fn validate_progression(value: f64) -> Result<(), KernelError> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(KernelError::InvalidLayoutResult)
    }
}

/// Authored occurrence boundary used for initial document entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentEntry {
    Start,
    End,
}

/// Position evidence used only by reflowable layout transactions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReflowPositionRequest {
    Entry {
        entry: DocumentEntry,
    },
    Exact {
        evidence: Vec<PointEvidence>,
        #[specta(type = u32)]
        fallback_progression: f64,
    },
    Progression {
        #[specta(type = u32)]
        normalized_progression: f64,
    },
    Unavailable,
}

impl ReflowPositionRequest {
    pub fn validate(&self) -> Result<(), KernelError> {
        match self {
            Self::Entry { .. } => Ok(()),
            Self::Exact {
                evidence,
                fallback_progression,
            } => {
                validate_nonempty_point_evidence(evidence)?;
                validate_progression(*fallback_progression)
            }
            Self::Progression {
                normalized_progression,
            } => validate_progression(*normalized_progression),
            Self::Unavailable => Ok(()),
        }
    }
}

/// Adapter-tagged request for reflowable layout or managed fixed-page containment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "adapter",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LayoutRequest {
    ReflowableXhtml {
        presentation: ReflowablePresentation,
        position: ReflowPositionRequest,
    },
    FixedXhtml,
    FixedSvg,
    FixedImage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "adapter",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PendingAdapterLayout {
    ReflowableXhtml {
        requested: PresentationPreferences,
        mode: ReflowableLayoutMode,
        notice: Option<LayoutIssue>,
        position: ReflowPositionRequest,
        align_x_center: bool,
    },
    FixedXhtml,
    FixedSvg,
    FixedImage,
}

impl PendingAdapterLayout {
    pub(in crate::kernel) fn from_plan(
        plan: AdapterLayoutPlan,
        position: ReflowPositionRequest,
    ) -> Option<Self> {
        match plan {
            AdapterLayoutPlan::ReflowableXhtml {
                requested,
                mode,
                notice,
                align_x_center,
            } => Some(Self::ReflowableXhtml {
                requested,
                mode,
                notice,
                position,
                align_x_center,
            }),
            AdapterLayoutPlan::FixedXhtml => Some(Self::FixedXhtml),
            AdapterLayoutPlan::FixedSvg => Some(Self::FixedSvg),
            AdapterLayoutPlan::FixedImage => Some(Self::FixedImage),
        }
    }

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
            Self::FixedXhtml => AdapterLayoutPlan::FixedXhtml,
            Self::FixedSvg => AdapterLayoutPlan::FixedSvg,
            Self::FixedImage => AdapterLayoutPlan::FixedImage,
        }
    }

    pub(in crate::kernel) fn position(&self) -> ReflowPositionRequest {
        match self {
            Self::ReflowableXhtml { position, .. } => position.clone(),
            Self::FixedXhtml | Self::FixedSvg | Self::FixedImage => {
                ReflowPositionRequest::Unavailable
            }
        }
    }

    pub(in crate::kernel) fn effect_request(&self) -> LayoutRequest {
        match self {
            Self::ReflowableXhtml {
                requested,
                mode,
                position,
                align_x_center,
                ..
            } => LayoutRequest::ReflowableXhtml {
                presentation: ReflowablePresentation {
                    mode: *mode,
                    pagination_columns: requested.pagination_columns,
                    theme: requested.theme,
                    color_scheme: requested.color_scheme,
                    typeface: requested.typeface,
                    font_scale: requested.font_scale,
                    line_height: requested.line_height,
                    letter_spacing: requested.letter_spacing,
                    word_spacing: requested.word_spacing,
                    paragraph_spacing: requested.paragraph_spacing,
                    text_indent: requested.text_indent,
                    measure: requested.measure,
                    alignment: requested.alignment,
                    hyphenation: requested.hyphenation,
                    root_scrollbar: requested.root_scrollbar,
                    align_x_center: *align_x_center,
                },
                position: position.clone(),
            },
            Self::FixedXhtml => LayoutRequest::FixedXhtml,
            Self::FixedSvg => LayoutRequest::FixedSvg,
            Self::FixedImage => LayoutRequest::FixedImage,
        }
    }
}

pub fn resolve_layout_plan(
    occurrence: &ReadingOrderOccurrence,
    preferences: PresentationPreferences,
) -> AdapterLayoutPlan {
    let adapter = occurrence
        .document
        .loadable()
        .expect("layout planning requires a loadable occurrence")
        .1;
    match adapter {
        DocumentAdapter::FixedXhtml => return AdapterLayoutPlan::FixedXhtml,
        DocumentAdapter::FixedSvg => return AdapterLayoutPlan::FixedSvg,
        DocumentAdapter::FixedImage => return AdapterLayoutPlan::FixedImage,
        DocumentAdapter::ReflowableXhtml => {}
    }

    // Resolve itemref overrides without changing the authored ambiguity retained in facts.
    let first_override = match &occurrence.presentation.flow {
        OccurrenceRenditionSetting::Ambiguous(candidates) => candidates
            .iter()
            .find(|candidate| {
                candidate.source == OccurrenceRenditionValueSource::ItemRefProperty
                    && candidate.value.is_some()
            })
            .map(|candidate| OccurrenceRenditionSetting::Specified(candidate.clone())),
        _ => None,
    };
    let flow = first_override
        .as_ref()
        .unwrap_or(&occurrence.presentation.flow);
    let (mode, notice) = match preferences.mode {
        PresentationMode::Paginated => (ReflowableLayoutMode::Paginated, None),
        PresentationMode::DocumentScroll => (ReflowableLayoutMode::DocumentScroll, None),
        PresentationMode::Auto => match flow {
            OccurrenceRenditionSetting::Unspecified => (ReflowableLayoutMode::Paginated, None),
            OccurrenceRenditionSetting::Ambiguous(_) => (
                ReflowableLayoutMode::Paginated,
                Some(LayoutIssue::AuthoredPresentationAmbiguous),
            ),
            OccurrenceRenditionSetting::Specified(candidate) => match candidate.value {
                Some(OccurrenceRenditionFlow::Paginated | OccurrenceRenditionFlow::Auto) => {
                    (ReflowableLayoutMode::Paginated, None)
                }
                Some(OccurrenceRenditionFlow::ScrolledDoc) => {
                    (ReflowableLayoutMode::DocumentScroll, None)
                }
                Some(OccurrenceRenditionFlow::ScrolledContinuous) => (
                    ReflowableLayoutMode::DocumentScroll,
                    Some(LayoutIssue::PublicationContinuousUnavailable),
                ),
                None => (
                    ReflowableLayoutMode::Paginated,
                    Some(LayoutIssue::AuthoredPresentationUnsupported),
                ),
            },
        },
    };
    AdapterLayoutPlan::ReflowableXhtml {
        requested: preferences,
        mode,
        notice,
        align_x_center: occurrence.presentation.align_x_center,
    }
}
