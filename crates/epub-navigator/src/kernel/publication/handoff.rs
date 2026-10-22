use crate::kernel::{
    OccurrencePageProgressionDirection, OccurrencePageSpread, OccurrencePresentation,
    OccurrenceRenditionCandidate, OccurrenceRenditionFlow, OccurrenceRenditionLayout,
    OccurrenceRenditionOrientation, OccurrenceRenditionSetting, OccurrenceRenditionSpread,
    OccurrenceRenditionValueSource, PresentationPreferences, PublicationLayout, PublicationMount,
};
use epub_stack::package::metadata::{KnownMetaProperty, Meta};
use epub_stack::package::spine::{PageProgressionDirection, PageSpread};
use epub_stack::package::{
    ReadingOrderPresentation, RenditionCandidate, RenditionFlow, RenditionLayout,
    RenditionOrientation, RenditionSetting, RenditionSpread, RenditionValueSource,
};
use epub_stack::resource::ResourceIndex;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::kernel) struct KernelInitialization {
    pub(in crate::kernel) facts: Value,
    pub(in crate::kernel) mount: PublicationMount,
    #[serde(default)]
    pub(in crate::kernel) preferences: PresentationPreferences,
}

/// The structural facts a host supplies, read back into Stack's own models.
///
/// The package is narrowed to the metadata this kernel reads rather than the whole OPF model,
/// which it would otherwise parse in full on every initialization.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublicationFactsInput {
    #[serde(default)]
    pub(super) package: PackageInput,
    pub(super) resources: ResourceIndex,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct PackageInput {
    #[serde(default)]
    pub(super) metadata: MetadataInput,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct MetadataInput {
    #[serde(default)]
    pub(super) meta: Vec<Meta>,
}

/// Counts every unrefined declaration, including unknown or missing values, because Stack's
/// first-recognized metadata getter would hide the ambiguity this projection reports.
pub(super) fn publication_layout(meta: &[Meta]) -> PublicationLayout {
    let mut layouts = meta.iter().filter(|meta| {
        meta.refines().is_none()
            && meta.property().and_then(|property| property.known_value())
                == Some(KnownMetaProperty::RenditionLayout)
    });
    let first = layouts.next();
    if layouts.next().is_none()
        && first
            .and_then(|meta| meta.content())
            .and_then(|content| content.as_str().trim().parse::<RenditionLayout>().ok())
            == Some(RenditionLayout::Roll)
    {
        PublicationLayout::Roll
    } else {
        PublicationLayout::Ordinary
    }
}

pub(super) fn occurrence_presentation(
    presentation: &ReadingOrderPresentation,
) -> OccurrencePresentation {
    OccurrencePresentation {
        layout: rendition_setting(presentation.layout(), |value| match value {
            RenditionLayout::Reflowable => OccurrenceRenditionLayout::Reflowable,
            RenditionLayout::PrePaginated => OccurrenceRenditionLayout::PrePaginated,
            RenditionLayout::Roll => OccurrenceRenditionLayout::Roll,
        }),
        flow: rendition_setting(presentation.flow(), |value| match value {
            RenditionFlow::Auto => OccurrenceRenditionFlow::Auto,
            RenditionFlow::Paginated => OccurrenceRenditionFlow::Paginated,
            RenditionFlow::ScrolledContinuous => OccurrenceRenditionFlow::ScrolledContinuous,
            RenditionFlow::ScrolledDoc => OccurrenceRenditionFlow::ScrolledDoc,
        }),
        orientation: rendition_setting(presentation.orientation(), |value| match value {
            RenditionOrientation::Auto => OccurrenceRenditionOrientation::Auto,
            RenditionOrientation::Landscape => OccurrenceRenditionOrientation::Landscape,
            RenditionOrientation::Portrait => OccurrenceRenditionOrientation::Portrait,
        }),
        spread: rendition_setting(presentation.spread(), |value| match value {
            RenditionSpread::Auto => OccurrenceRenditionSpread::Auto,
            RenditionSpread::Both => OccurrenceRenditionSpread::Both,
            RenditionSpread::Landscape => OccurrenceRenditionSpread::Landscape,
            RenditionSpread::None => OccurrenceRenditionSpread::None,
            RenditionSpread::Portrait => OccurrenceRenditionSpread::Portrait,
        }),
        page_spread: rendition_setting(presentation.page_spread(), |value| match value {
            PageSpread::Left => OccurrencePageSpread::Left,
            PageSpread::Right => OccurrencePageSpread::Right,
            PageSpread::Center => OccurrencePageSpread::Center,
        }),
        page_progression_direction: presentation.page_progression_direction().map(|value| {
            match value {
                PageProgressionDirection::Ltr => OccurrencePageProgressionDirection::Ltr,
                PageProgressionDirection::Rtl => OccurrencePageProgressionDirection::Rtl,
                PageProgressionDirection::Default => OccurrencePageProgressionDirection::Default,
            }
        }),
        align_x_center: presentation.align_x_center(),
    }
}

fn rendition_setting<T, U>(
    setting: &RenditionSetting<T>,
    map: impl Fn(&T) -> U + Copy,
) -> OccurrenceRenditionSetting<U> {
    match setting {
        RenditionSetting::Unspecified => OccurrenceRenditionSetting::Unspecified,
        RenditionSetting::Specified(candidate) => {
            OccurrenceRenditionSetting::Specified(rendition_candidate(candidate, map))
        }
        RenditionSetting::Ambiguous(candidates) => OccurrenceRenditionSetting::Ambiguous(
            candidates
                .iter()
                .map(|candidate| rendition_candidate(candidate, map))
                .collect(),
        ),
    }
}

fn rendition_candidate<T, U>(
    candidate: &RenditionCandidate<T>,
    map: impl Fn(&T) -> U,
) -> OccurrenceRenditionCandidate<U> {
    OccurrenceRenditionCandidate {
        source: match candidate.source() {
            RenditionValueSource::PackageMetadata => {
                OccurrenceRenditionValueSource::PackageMetadata
            }
            RenditionValueSource::ItemRefProperty => {
                OccurrenceRenditionValueSource::ItemRefProperty
            }
        },
        authored_value: candidate.authored_value().map(ToString::to_string),
        value: candidate.value().map(map),
    }
}
