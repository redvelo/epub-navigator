use crate::kernel::{
    KernelError, PaginatedLayout, PointEvidence, validate_nonempty_point_evidence,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Browser-authoritative document writing mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentWritingMode {
    HorizontalTb,
    VerticalRl,
    VerticalLr,
}

/// Browser-authoritative document direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentDirection {
    Ltr,
    Rtl,
}

/// Current content-document viewport measured by the browser.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentViewport {
    #[specta(type = u32)]
    pub width: f64,
    #[specta(type = u32)]
    pub height: f64,
}

/// Representable publication canvas observed from browser-computed styles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DocumentCanvas {
    SolidColor { css_color: String },
    Unavailable,
}

impl DocumentCanvas {
    fn validate(&self) -> Result<(), KernelError> {
        match self {
            Self::SolidColor { css_color } if css_color.is_empty() || css_color.len() > 256 => {
                Err(KernelError::InvalidDocumentObservation)
            }
            _ => Ok(()),
        }
    }
}

/// Availability of one browser-observed visible document boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ObservedBoundary {
    Located { evidence: Vec<PointEvidence> },
    Unavailable,
}

impl ObservedBoundary {
    fn validate(&self) -> Result<(), KernelError> {
        match self {
            Self::Located { evidence } => validate_nonempty_point_evidence(evidence),
            Self::Unavailable => Ok(()),
        }
    }
}

/// Live page position within one settled paginated layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaginationObservation {
    pub first_visible_page: u32,
    pub page_count: u32,
    pub visible_page_count: u32,
}

impl PaginationObservation {
    fn validate(&self) -> Result<(), KernelError> {
        if self.page_count == 0
            || self.visible_page_count == 0
            || self.first_visible_page >= self.page_count
            || self
                .first_visible_page
                .checked_add(self.visible_page_count)
                .is_none_or(|end| end > self.page_count)
        {
            return Err(KernelError::InvalidDocumentObservation);
        }
        Ok(())
    }

    fn validate_against(&self, pages: &PaginatedLayout) -> Result<(), KernelError> {
        if self.page_count != pages.page_count
            || !self
                .first_visible_page
                .is_multiple_of(pages.columns_per_view)
            || self.visible_page_count
                != pages
                    .columns_per_view
                    .min(pages.page_count - self.first_visible_page)
        {
            return Err(KernelError::InvalidDocumentObservation);
        }
        Ok(())
    }
}

/// One coherent browser observation from the committed content document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentObservation {
    pub writing_mode: DocumentWritingMode,
    pub direction: DocumentDirection,
    pub language: Option<String>,
    pub viewport: DocumentViewport,
    pub canvas: DocumentCanvas,
    pub visible_start: ObservedBoundary,
    pub visible_end: ObservedBoundary,
    pub rendered_text_progression: Option<f64>,
    /// Finite `[0, 1]` scroll progression through a scrolled document layout. A document
    /// without rendered text has no text progression, so this is the only continuous
    /// position a scrolled image document reports.
    pub layout_progression: Option<f64>,
    pub pagination: Option<PaginationObservation>,
}

impl DocumentObservation {
    pub(in crate::kernel) fn validate(&self) -> Result<(), KernelError> {
        if !self.viewport.width.is_finite()
            || self.viewport.width < 0.0
            || !self.viewport.height.is_finite()
            || self.viewport.height < 0.0
            || self.rendered_text_progression.is_some_and(|progression| {
                !progression.is_finite() || !(0.0..=1.0).contains(&progression)
            })
            || self.layout_progression.is_some_and(|progression| {
                !progression.is_finite() || !(0.0..=1.0).contains(&progression)
            })
        {
            return Err(KernelError::InvalidDocumentObservation);
        }
        self.canvas
            .validate()
            .and_then(|()| self.visible_start.validate())
            .and_then(|()| self.visible_end.validate())
            .and_then(|()| {
                self.pagination
                    .as_ref()
                    .map_or(Ok(()), PaginationObservation::validate)
            })
            .map_err(|_| KernelError::InvalidDocumentObservation)
    }

    pub(in crate::kernel) fn validate_pagination_against(
        &self,
        pages: Option<&PaginatedLayout>,
    ) -> Result<(), KernelError> {
        match (&self.pagination, pages) {
            (None, _) => Ok(()),
            (Some(pagination), Some(pages)) => pagination.validate_against(pages),
            (Some(_), None) => Err(KernelError::InvalidDocumentObservation),
        }
    }
}
