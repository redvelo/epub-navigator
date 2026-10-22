use crate::kernel::{
    ActiveDocumentParticipant, KernelError, MAX_SELECTION_CAPTURE_STRING_BYTES, NavigatorLocation,
    validate_selection_locator_limits,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Direction retained from the browser's native Selection object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum NativeSelectionDirection {
    Forward,
    Backward,
    Directionless,
}

/// The touch gesture still holding a captured selection, when a finger has not yet lifted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum SelectionGesture {
    /// The finger has come to rest on the selection; the reader may draw against it.
    Settled,
    /// The finger is extending the selection; nothing drawn against it would keep up.
    Dragging,
}

/// Exact browser state against which native selection evidence was captured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionCaptureBasis {
    pub participant: ActiveDocumentParticipant,
    pub frame_generation: u32,
    pub layout_generation: u32,
    /// Agent-local monotonic content basis.
    pub local_content_basis: u32,
    /// Agent-local monotonic geometry basis.
    pub local_geometry_basis: u32,
}

/// One rectangle after conversion into reader visual-viewport coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderViewportRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ReaderViewportRect {
    fn validate(self) -> Result<(), KernelError> {
        if !self.x.is_finite()
            || !self.y.is_finite()
            || !self.width.is_finite()
            || !self.height.is_finite()
            || self.width < 0.0
            || self.height < 0.0
        {
            return Err(KernelError::InvalidLocator);
        }
        Ok(())
    }
}

/// Bounded selection geometry retained for reader-owned contextual UI.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderViewportAnchor {
    pub rect: ReaderViewportRect,
    pub clipping_rect: ReaderViewportRect,
}

impl ReaderViewportAnchor {
    fn validate(self) -> Result<(), KernelError> {
        self.rect.validate()?;
        self.clipping_rect.validate()
    }
}

/// Why a native selection was not currently available for capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum NativeSelectionCaptureReason {
    NoSelection,
    DocumentInactive,
    LayoutUnavailable,
    GeometryUnavailable,
}

/// Browser-authoritative terminal outcome of one native selection capture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeSelectionCaptureOutcome {
    Captured {
        location: NavigatorLocation,
        direction: NativeSelectionDirection,
        /// Authored language of the selection start, from the nearest `xml:lang` or `lang`.
        language: Option<String>,
        anchor: ReaderViewportAnchor,
        /// The touch gesture still holding the selection, or `None` once it has been let go.
        gesture: Option<SelectionGesture>,
        basis: SelectionCaptureBasis,
    },
    Collapsed {
        basis: SelectionCaptureBasis,
    },
    Unavailable {
        reason: NativeSelectionCaptureReason,
        basis: SelectionCaptureBasis,
    },
    Unsupported {
        basis: SelectionCaptureBasis,
    },
    Ambiguous {
        basis: SelectionCaptureBasis,
    },
    Conflict {
        basis: SelectionCaptureBasis,
    },
    Stale {
        basis: SelectionCaptureBasis,
    },
    Failed {
        message: Option<String>,
        basis: SelectionCaptureBasis,
    },
}

impl NativeSelectionCaptureOutcome {
    pub(in crate::kernel) fn basis(&self) -> &SelectionCaptureBasis {
        match self {
            Self::Captured { basis, .. }
            | Self::Collapsed { basis }
            | Self::Unavailable { basis, .. }
            | Self::Unsupported { basis }
            | Self::Ambiguous { basis }
            | Self::Conflict { basis }
            | Self::Stale { basis }
            | Self::Failed { basis, .. } => basis,
        }
    }

    pub(in crate::kernel) fn validate(
        &self,
        participant: ActiveDocumentParticipant,
        frame_generation: u32,
        layout_generation: u32,
        occurrence: u32,
        resource: &str,
    ) -> Result<(), KernelError> {
        let basis = self.basis();
        if basis.participant != participant
            || basis.frame_generation != frame_generation
            || basis.layout_generation != layout_generation
        {
            return Err(KernelError::InvalidLocator);
        }
        match self {
            Self::Captured {
                location,
                language,
                anchor,
                ..
            } => {
                if language.as_ref().is_some_and(|language| {
                    language.is_empty() || language.len() > MAX_SELECTION_CAPTURE_STRING_BYTES
                }) {
                    return Err(KernelError::InvalidLocator);
                }
                location.validate()?;
                if !matches!(location, NavigatorLocation::Range { .. })
                    || location.context() != (occurrence, resource)
                {
                    return Err(KernelError::InvalidLocator);
                }
                validate_selection_locator_limits(location)?;
                anchor.validate()?;
            }
            Self::Failed { message, .. } => {
                if message
                    .as_ref()
                    .is_some_and(|message| message.len() > MAX_SELECTION_CAPTURE_STRING_BYTES)
                {
                    return Err(KernelError::InvalidLocator);
                }
            }
            Self::Collapsed { .. }
            | Self::Unavailable { .. }
            | Self::Unsupported { .. }
            | Self::Ambiguous { .. }
            | Self::Conflict { .. }
            | Self::Stale { .. } => {}
        }
        Ok(())
    }
}
