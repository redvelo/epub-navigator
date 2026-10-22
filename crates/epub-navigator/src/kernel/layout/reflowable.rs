use crate::kernel::{DocumentObservation, KernelError, ReflowableLayoutMode};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Logical dimensions measured in the document writing mode.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicalSize {
    #[specta(type = u32)]
    pub inline: f64,
    #[specta(type = u32)]
    pub block: f64,
}

/// Physical movement needed to advance one logical layout step.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhysicalMovementVector {
    #[specta(type = i32)]
    pub x: f64,
    #[specta(type = i32)]
    pub y: f64,
}

/// Outcome of checking whether rendered text can paginate without oversized atomic boxes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LayoutRepairReport {
    NoIssuesDetected {},
    Repaired {
        repaired_elements: u32,
    },
    Unresolved {
        repaired_elements: u32,
        unresolved_elements: u32,
    },
}

impl LayoutRepairReport {
    pub(in crate::kernel) fn validate(self) -> Result<(), KernelError> {
        match self {
            Self::Repaired {
                repaired_elements: 0,
            }
            | Self::Unresolved {
                unresolved_elements: 0,
                ..
            } => Err(KernelError::InvalidLayoutResult),
            _ => Ok(()),
        }
    }
}

/// Browser-observed settlement of a required font or non-font asset class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum RequiredAssetSettlement {
    Loaded,
    Failed,
    TimedOut,
}

/// Browser-authoritative values shared by every adapter settlement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutMeasurement {
    pub observation: DocumentObservation,
    pub logical_viewport: LogicalSize,
    pub logical_content_extent: LogicalSize,
    #[specta(type = u32)]
    pub normalized_position: f64,
    pub physical_movement: PhysicalMovementVector,
    pub required_fonts: RequiredAssetSettlement,
    pub required_resources: RequiredAssetSettlement,
}

impl LayoutMeasurement {
    pub(in crate::kernel) fn validate(&self) -> Result<(), KernelError> {
        self.observation
            .validate()
            .map_err(|_| KernelError::InvalidLayoutResult)?;
        let dimensions = [
            self.logical_viewport.inline,
            self.logical_viewport.block,
            self.logical_content_extent.inline,
            self.logical_content_extent.block,
        ];
        if dimensions
            .into_iter()
            .any(|value| !value.is_finite() || value < 0.0)
            || !self.normalized_position.is_finite()
            || !(0.0..=1.0).contains(&self.normalized_position)
            || !self.physical_movement.x.is_finite()
            || !self.physical_movement.y.is_finite()
        {
            return Err(KernelError::InvalidLayoutResult);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaginatedLayout {
    #[specta(type = u32)]
    pub spread_stride: f64,
    #[specta(type = u32)]
    pub column_origin: f64,
    #[specta(type = u32)]
    pub column_width: f64,
    #[specta(type = u32)]
    pub column_gap: f64,
    #[specta(type = u32)]
    pub column_pitch: f64,
    pub first_visible_page: u32,
    pub page_count: u32,
    pub visible_page_count: u32,
    pub columns_per_view: u32,
    pub layout_repairs: LayoutRepairReport,
}

impl PaginatedLayout {
    fn validate(&self) -> Result<(), KernelError> {
        if !self.spread_stride.is_finite()
            || self.spread_stride <= 0.0
            || !self.column_origin.is_finite()
            || self.column_origin < 0.0
            || !self.column_width.is_finite()
            || self.column_width <= 0.0
            || !self.column_gap.is_finite()
            || self.column_gap < 0.0
            || !self.column_pitch.is_finite()
            || self.column_pitch <= 0.0
            || (self.column_pitch - (self.column_width + self.column_gap)).abs() > 1.0
            || (self.spread_stride - self.column_pitch * f64::from(self.columns_per_view)).abs()
                > 1.0
            || self.page_count == 0
            || !matches!(self.columns_per_view, 1 | 2)
            || self.first_visible_page >= self.page_count
            || !self
                .first_visible_page
                .is_multiple_of(self.columns_per_view)
            || self.visible_page_count
                != self
                    .columns_per_view
                    .min(self.page_count - self.first_visible_page)
        {
            return Err(KernelError::InvalidLayoutResult);
        }
        self.layout_repairs.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "mode",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReflowableSettlement {
    Paginated {
        measurement: LayoutMeasurement,
        pages: PaginatedLayout,
    },
    DocumentScroll {
        measurement: LayoutMeasurement,
    },
}

impl ReflowableSettlement {
    pub(in crate::kernel) fn validate(
        &self,
        mode: ReflowableLayoutMode,
    ) -> Result<(), KernelError> {
        match (self, mode) {
            (Self::Paginated { measurement, pages }, ReflowableLayoutMode::Paginated) => {
                measurement
                    .validate()
                    .and_then(|()| pages.validate())
                    .and_then(|()| {
                        measurement
                            .observation
                            .validate_pagination_against(Some(pages))
                            .map_err(|_| KernelError::InvalidLayoutResult)
                    })
            }
            (Self::DocumentScroll { measurement }, ReflowableLayoutMode::DocumentScroll) => {
                measurement.validate().and_then(|()| {
                    measurement
                        .observation
                        .validate_pagination_against(None)
                        .map_err(|_| KernelError::InvalidLayoutResult)
                })
            }
            _ => Err(KernelError::InvalidLayoutResult),
        }
    }

    pub(in crate::kernel) fn measurement(&self) -> &LayoutMeasurement {
        match self {
            Self::Paginated { measurement, .. } | Self::DocumentScroll { measurement } => {
                measurement
            }
        }
    }
}
