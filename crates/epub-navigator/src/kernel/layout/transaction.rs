use crate::kernel::{
    ActiveDocumentParticipant, AdapterLayoutPlan, AdapterLayoutSettlement, FixedLayoutIssue,
    FixedSettlement, KernelError, LayoutIssue, LayoutOwner, LayoutPhase, PendingLayoutOperation,
    ReflowPositionRequest, ReflowableSettlement, TerminalLayout,
};
use serde::{Deserialize, Serialize};
use specta::Type;

impl PendingLayoutOperation {
    pub(in crate::kernel) fn document(&self) -> Option<(u32, LayoutPhase)> {
        match self.owner {
            LayoutOwner::Document {
                document_generation,
                phase,
            } => Some((document_generation, phase)),
            LayoutOwner::PreparedFrame | LayoutOwner::FixedCompanion { .. } => None,
        }
    }

    pub(in crate::kernel) fn participant(&self) -> Option<ActiveDocumentParticipant> {
        match self.owner {
            LayoutOwner::Document {
                document_generation,
                phase: LayoutPhase::Update,
            } => Some(ActiveDocumentParticipant::Primary {
                document_generation,
            }),
            LayoutOwner::Document {
                phase: LayoutPhase::Initial,
                ..
            } => None,
            LayoutOwner::FixedCompanion {
                owner_document_generation,
                frame_generation,
            } => Some(ActiveDocumentParticipant::FixedCompanion {
                owner_document_generation,
                frame_generation,
            }),
            LayoutOwner::PreparedFrame => None,
        }
    }
}

/// Terminal result from a reflowable XHTML adapter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReflowableLayoutOutcome {
    Settled {
        settlement: Box<ReflowableSettlement>,
    },
    Conflict {
        issue: LayoutIssue,
    },
    Unavailable {
        issue: LayoutIssue,
    },
}

/// Terminal result from a managed fixed-page adapter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FixedLayoutOutcome {
    Settled { settlement: Box<FixedSettlement> },
    Conflict { issue: FixedLayoutIssue },
    Unavailable { issue: FixedLayoutIssue },
}

/// Strict adapter-tagged outcome of one operational layout request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "adapter",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LayoutResult {
    ReflowableXhtml { outcome: ReflowableLayoutOutcome },
    FixedXhtml { outcome: FixedLayoutOutcome },
    FixedSvg { outcome: FixedLayoutOutcome },
    FixedImage { outcome: FixedLayoutOutcome },
}

impl LayoutResult {
    pub(in crate::kernel) fn validate(&self, plan: AdapterLayoutPlan) -> Result<(), KernelError> {
        match (self, plan) {
            (
                Self::ReflowableXhtml {
                    outcome: ReflowableLayoutOutcome::Settled { settlement },
                },
                AdapterLayoutPlan::ReflowableXhtml { mode, .. },
            ) => settlement.validate(mode),
            (
                Self::FixedXhtml {
                    outcome: FixedLayoutOutcome::Settled { settlement },
                },
                AdapterLayoutPlan::FixedXhtml,
            ) => settlement.validate(),
            (
                Self::FixedSvg {
                    outcome: FixedLayoutOutcome::Settled { settlement },
                },
                AdapterLayoutPlan::FixedSvg,
            ) => settlement.validate(),
            (Self::ReflowableXhtml { .. }, AdapterLayoutPlan::ReflowableXhtml { .. })
            | (Self::FixedXhtml { .. }, AdapterLayoutPlan::FixedXhtml)
            | (Self::FixedSvg { .. }, AdapterLayoutPlan::FixedSvg) => Ok(()),
            (
                Self::FixedImage {
                    outcome: FixedLayoutOutcome::Settled { settlement },
                },
                AdapterLayoutPlan::FixedImage,
            ) => settlement.validate_image(),
            (Self::FixedImage { .. }, AdapterLayoutPlan::FixedImage) => Ok(()),
            _ => Err(KernelError::InvalidLayoutResult),
        }
    }

    pub(in crate::kernel) fn into_terminal(
        self,
        plan: AdapterLayoutPlan,
        position: ReflowPositionRequest,
    ) -> TerminalLayout {
        match (self, plan) {
            (
                Self::ReflowableXhtml { outcome },
                AdapterLayoutPlan::ReflowableXhtml {
                    requested,
                    mode,
                    notice,
                    align_x_center,
                },
            ) => match outcome {
                ReflowableLayoutOutcome::Settled { settlement } => {
                    TerminalLayout::Settled(Box::new(AdapterLayoutSettlement::ReflowableXhtml {
                        requested,
                        mode,
                        notice,
                        settlement: *settlement,
                        position,
                        align_x_center,
                    }))
                }
                ReflowableLayoutOutcome::Conflict { issue } => {
                    TerminalLayout::ReflowableConflict(issue)
                }
                ReflowableLayoutOutcome::Unavailable { issue } => {
                    TerminalLayout::ReflowableUnavailable(issue)
                }
            },
            (Self::FixedXhtml { outcome }, AdapterLayoutPlan::FixedXhtml) => match outcome {
                FixedLayoutOutcome::Settled { settlement } => {
                    TerminalLayout::Settled(Box::new(AdapterLayoutSettlement::FixedXhtml {
                        settlement: *settlement,
                    }))
                }
                FixedLayoutOutcome::Conflict { issue } => TerminalLayout::FixedConflict(issue),
                FixedLayoutOutcome::Unavailable { issue } => {
                    TerminalLayout::FixedUnavailable(issue)
                }
            },
            (Self::FixedSvg { outcome }, AdapterLayoutPlan::FixedSvg) => match outcome {
                FixedLayoutOutcome::Settled { settlement } => {
                    TerminalLayout::Settled(Box::new(AdapterLayoutSettlement::FixedSvg {
                        settlement: *settlement,
                    }))
                }
                FixedLayoutOutcome::Conflict { issue } => TerminalLayout::FixedConflict(issue),
                FixedLayoutOutcome::Unavailable { issue } => {
                    TerminalLayout::FixedUnavailable(issue)
                }
            },
            (Self::FixedImage { outcome }, AdapterLayoutPlan::FixedImage) => match outcome {
                FixedLayoutOutcome::Settled { settlement } => {
                    TerminalLayout::Settled(Box::new(AdapterLayoutSettlement::FixedImage {
                        settlement: *settlement,
                    }))
                }
                FixedLayoutOutcome::Conflict { issue } => TerminalLayout::FixedConflict(issue),
                FixedLayoutOutcome::Unavailable { issue } => {
                    TerminalLayout::FixedUnavailable(issue)
                }
            },
            _ => unreachable!("layout result was validated against its plan"),
        }
    }
}

/// Bounded browser causes that invalidate current layout measurements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutInvalidationCause {
    Viewport,
    Fonts,
    Dom,
    Attributes,
    StyleElement,
    StylesheetLink,
    WritingMode,
    Preferences,
    AgentStyle,
}
