use crate::kernel::KernelError;
use serde::{Deserialize, Serialize};
use specta::Type;

/// Effective package-global policy, not a rendering-support or settlement result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PublicationLayout {
    Ordinary,
    Roll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum OccurrenceRenditionValueSource {
    PackageMetadata,
    ItemRefProperty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OccurrenceRenditionCandidate<T> {
    pub source: OccurrenceRenditionValueSource,
    pub authored_value: Option<String>,
    pub value: Option<T>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    content = "value",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum OccurrenceRenditionSetting<T> {
    Unspecified,
    Specified(OccurrenceRenditionCandidate<T>),
    Ambiguous(Vec<OccurrenceRenditionCandidate<T>>),
}

impl<T> OccurrenceRenditionSetting<T> {
    fn validate(&self) -> Result<(), KernelError> {
        match self {
            Self::Ambiguous(candidates) if candidates.len() <= 1 => Err(KernelError::InvalidFacts),
            Self::Unspecified | Self::Specified(_) | Self::Ambiguous(_) => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum OccurrenceRenditionLayout {
    Reflowable,
    PrePaginated,
    Roll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum OccurrenceRenditionFlow {
    Auto,
    Paginated,
    ScrolledContinuous,
    ScrolledDoc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum OccurrenceRenditionOrientation {
    Auto,
    Landscape,
    Portrait,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum OccurrenceRenditionSpread {
    Auto,
    Both,
    Landscape,
    None,
    Portrait,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum OccurrencePageSpread {
    Left,
    Right,
    Center,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum OccurrencePageProgressionDirection {
    Ltr,
    Rtl,
    Default,
}

/// Exact occurrence-owned presentation evidence copied from Stack facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OccurrencePresentation {
    pub layout: OccurrenceRenditionSetting<OccurrenceRenditionLayout>,
    pub flow: OccurrenceRenditionSetting<OccurrenceRenditionFlow>,
    pub orientation: OccurrenceRenditionSetting<OccurrenceRenditionOrientation>,
    pub spread: OccurrenceRenditionSetting<OccurrenceRenditionSpread>,
    pub page_spread: OccurrenceRenditionSetting<OccurrencePageSpread>,
    pub page_progression_direction: Option<OccurrencePageProgressionDirection>,
    pub align_x_center: bool,
}

impl OccurrencePresentation {
    pub(super) fn validate(&self) -> Result<(), KernelError> {
        self.layout.validate()?;
        self.flow.validate()?;
        self.orientation.validate()?;
        self.spread.validate()?;
        self.page_spread.validate()
    }
}
