use crate::kernel::{DocumentViewport, KernelError, LayoutMeasurement};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Fixed-page dimensions resolved from an authored viewport or a raster's natural dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixedIntrinsicViewport {
    #[serde(default)]
    #[specta(optional)]
    pub source: Option<FixedIntrinsicViewportSource>,
    #[specta(type = u32)]
    pub width: f64,
    #[specta(type = u32)]
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum FixedIntrinsicViewportSource {
    ImageNatural,
}

/// Browser-authoritative contain geometry for one managed fixed page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixedPageGeometry {
    pub intrinsic_viewport: FixedIntrinsicViewport,
    pub containing_viewport: DocumentViewport,
    #[specta(type = u32)]
    pub scale: f64,
    #[specta(type = u32)]
    pub rendered_width: f64,
    #[specta(type = u32)]
    pub rendered_height: f64,
    #[specta(type = i32)]
    pub offset_x: f64,
    #[specta(type = i32)]
    pub offset_y: f64,
}

impl FixedPageGeometry {
    fn validate(&self, measurement: &LayoutMeasurement) -> Result<(), KernelError> {
        let positive = [
            self.intrinsic_viewport.width,
            self.intrinsic_viewport.height,
            self.containing_viewport.width,
            self.containing_viewport.height,
            self.scale,
            self.rendered_width,
            self.rendered_height,
        ];
        if positive
            .into_iter()
            .any(|value| !value.is_finite() || value <= 0.0)
            || !self.offset_x.is_finite()
            || !self.offset_y.is_finite()
        {
            return Err(KernelError::InvalidLayoutResult);
        }

        let expected_scale = (self.containing_viewport.width / self.intrinsic_viewport.width)
            .min(self.containing_viewport.height / self.intrinsic_viewport.height);
        let expected_width = self.intrinsic_viewport.width * self.scale;
        let expected_height = self.intrinsic_viewport.height * self.scale;
        let expected_x = (self.containing_viewport.width - self.rendered_width) / 2.0;
        let expected_y = (self.containing_viewport.height - self.rendered_height) / 2.0;
        let scale_tolerance = expected_scale.abs().max(1.0) * 1e-6;
        const PIXEL_TOLERANCE: f64 = 1.0;

        if (self.intrinsic_viewport.width - measurement.observation.viewport.width).abs()
            > PIXEL_TOLERANCE
            || (self.intrinsic_viewport.height - measurement.observation.viewport.height).abs()
                > PIXEL_TOLERANCE
            || (self.scale - expected_scale).abs() > scale_tolerance
            || (self.rendered_width - expected_width).abs() > PIXEL_TOLERANCE
            || (self.rendered_height - expected_height).abs() > PIXEL_TOLERANCE
            || (self.offset_x - expected_x).abs() > PIXEL_TOLERANCE
            || (self.offset_y - expected_y).abs() > PIXEL_TOLERANCE
            || self.offset_x < -PIXEL_TOLERANCE
            || self.offset_y < -PIXEL_TOLERANCE
            || self.offset_x + self.rendered_width
                > self.containing_viewport.width + PIXEL_TOLERANCE
            || self.offset_y + self.rendered_height
                > self.containing_viewport.height + PIXEL_TOLERANCE
        {
            return Err(KernelError::InvalidLayoutResult);
        }
        Ok(())
    }
}

/// Typed explanation for managed fixed-page layout failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum FixedLayoutIssue {
    IntrinsicViewportMissing,
    IntrinsicViewportAmbiguous,
    IntrinsicViewportInvalid,
    IntrinsicViewportUnsupported,
    FinalViewportUnavailable,
    AgentStyleUnavailable,
    ImageLoadFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "mode",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FixedSettlement {
    Contain {
        measurement: LayoutMeasurement,
        geometry: FixedPageGeometry,
    },
}

impl FixedSettlement {
    pub(in crate::kernel) fn validate_image(&self) -> Result<(), KernelError> {
        let Self::Contain { geometry, .. } = self;
        if geometry.intrinsic_viewport.source != Some(FixedIntrinsicViewportSource::ImageNatural) {
            return Err(KernelError::InvalidLayoutResult);
        }
        self.validate()
    }

    pub(in crate::kernel) fn validate(&self) -> Result<(), KernelError> {
        match self {
            Self::Contain {
                measurement,
                geometry,
            } => measurement
                .validate()
                .and_then(|()| {
                    measurement
                        .observation
                        .validate_pagination_against(None)
                        .map_err(|_| KernelError::InvalidLayoutResult)
                })
                .and_then(|()| geometry.validate(measurement)),
        }
    }

    pub(in crate::kernel) fn measurement(&self) -> &LayoutMeasurement {
        match self {
            Self::Contain { measurement, .. } => measurement,
        }
    }
}
