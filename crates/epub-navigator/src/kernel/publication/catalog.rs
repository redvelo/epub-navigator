use super::handoff::{PublicationFactsInput, occurrence_presentation, publication_layout};
use crate::facts::PublicationFacts;
use crate::kernel::{
    DocumentAdapter, KernelError, NavigatorLocation, OccurrenceDocumentTarget,
    OccurrencePresentation, OccurrenceRenditionCandidate, OccurrenceRenditionLayout,
    OccurrenceRenditionSetting, OccurrenceRenditionValueSource, OccurrenceUnavailableReason,
    PublicationLayout, ReadingOrderOccurrence, ReadingOrderTarget,
};
use epub_stack::EpubPath;
use epub_stack::package::metadata::Meta;
use epub_stack::package::normalize_manifest_id;
use epub_stack::resource::{
    AuthoredHref, DeclarationTarget, IdrefTarget, ManifestDeclarationRef, MediaType,
    ProviderPresence, ReadingOrderOccurrenceRef, ResourceAddress, ResourceIndex, ResourceRef,
    resolve_publication_href,
};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug)]
pub(in crate::kernel) struct KernelPublication {
    pub(in crate::kernel) publication_layout: PublicationLayout,
    pub(in crate::kernel) package_path: String,
    pub(in crate::kernel) declaration_hrefs: Vec<Option<String>>,
    pub(in crate::kernel) resources: Vec<KernelResource>,
    pub(in crate::kernel) reading_order: Vec<ReadingOrderOccurrence>,
    pub(in crate::kernel) reading_order_length: u32,
}

impl KernelPublication {
    pub(in crate::kernel) fn from_facts(facts: &Value) -> Result<Self, KernelError> {
        let facts: PublicationFactsInput =
            serde_json::from_value(facts.clone()).map_err(|_| KernelError::InvalidFacts)?;
        let (meta, resources) = (facts.package.metadata.meta.as_slice(), &facts.resources);
        let declaration_hrefs = resources
            .declarations()
            .map(|declaration| declaration.href().map(ToString::to_string))
            .collect::<Vec<_>>();
        validate_projection_input(resources)?;
        let kernel_resources = resources
            .resources()
            .filter_map(|resource| match resource.address() {
                ResourceAddress::Local(path) => Some(KernelResource {
                    path: path.as_str().to_owned(),
                    present: resource.presence().is_present(),
                    manifest: resource.declarations().len() != 0,
                    has_xhtml_declaration: resource.has_xhtml_declaration(),
                    has_svg_declaration: resource.has_svg_declaration(),
                }),
                ResourceAddress::Remote(_)
                | ResourceAddress::Data(_)
                | ResourceAddress::External(_) => None,
            })
            .collect();
        let reading_order = project_reading_order_input(meta, resources)?;
        let reading_order_length =
            u32::try_from(reading_order.len()).map_err(|_| KernelError::InvalidFacts)?;
        Ok(Self {
            publication_layout: publication_layout(meta),
            package_path: resources.package_path().as_str().to_owned(),
            declaration_hrefs,
            resources: kernel_resources,
            reading_order,
            reading_order_length,
        })
    }

    pub(in crate::kernel) fn occurrence(&self, ordinal: u32) -> Option<&ReadingOrderOccurrence> {
        usize::try_from(ordinal)
            .ok()
            .and_then(|index| self.reading_order.get(index))
    }

    pub(in crate::kernel) fn annotation_source_for_occurrence(
        &self,
        ordinal: u32,
        canonical_resource: &str,
    ) -> Result<&str, KernelError> {
        let occurrence = self
            .occurrence(ordinal)
            .ok_or(KernelError::InvalidAnnotationTarget)?;
        let declaration = occurrence
            .selected_declaration
            .ok_or(KernelError::InvalidAnnotationTarget)?;
        if occurrence.document.loadable().map(|target| target.0) != Some(canonical_resource) {
            return Err(KernelError::InvalidAnnotationTarget);
        }
        let href = usize::try_from(declaration)
            .ok()
            .and_then(|index| self.declaration_hrefs.get(index))
            .and_then(Option::as_deref)
            .ok_or(KernelError::InvalidAnnotationTarget)?;
        let package_path =
            EpubPath::new(&self.package_path).map_err(|_| KernelError::InvalidAnnotationTarget)?;
        let resolved = resolve_publication_href(&AuthoredHref::new(href), &package_path)
            .ok_or(KernelError::InvalidAnnotationTarget)?;
        if resolved.as_str() != canonical_resource {
            return Err(KernelError::InvalidAnnotationTarget);
        }
        Ok(href)
    }

    /// Resolves through Stack semantics, then limits execution to present manifest resources.
    pub(in crate::kernel) fn resolve_annotation_source(
        &self,
        source: &str,
    ) -> Result<&KernelResource, KernelError> {
        let package_path =
            EpubPath::new(&self.package_path).map_err(|_| KernelError::InvalidAnnotationTarget)?;
        let path = resolve_publication_href(&AuthoredHref::new(source), &package_path)
            .ok_or(KernelError::InvalidAnnotationTarget)?;
        self.resources
            .iter()
            .find(|resource| {
                resource.path == path.as_str() && resource.present && resource.manifest
            })
            .ok_or(KernelError::InvalidAnnotationTarget)
    }
}

/// Applies Navigator's supported-document policy to Stack publication facts.
pub fn project_reading_order(
    facts: &PublicationFacts<'_>,
) -> Result<Vec<ReadingOrderOccurrence>, KernelError> {
    validate_projection_input(facts.resources)?;
    project_reading_order_input(facts.package.metadata().meta(), facts.resources)
}

fn validate_projection_input(resources: &ResourceIndex) -> Result<(), KernelError> {
    validate_manifest_fallbacks(resources)?;
    validate_resource_topology(resources)
}

/// Recomputes each authored fallback outcome the way Stack's index does, then compares, because
/// the facts arrive from a host rather than from this process.
fn validate_manifest_fallbacks(resources: &ResourceIndex) -> Result<(), KernelError> {
    for declaration in resources.declarations() {
        let expected = declaration
            .fallback()
            .map(|fallback| resolve_idref(resources, fallback.as_str()));
        if declaration.fallback_target().map(idref_shape) != expected.as_ref().map(idref_shape) {
            return Err(KernelError::InvalidFacts);
        }
    }
    Ok(())
}

/// Resolves one authored IDREF the way Stack's index does, against the index's own identifiers.
fn resolve_idref(resources: &ResourceIndex, idref: &str) -> IdrefTarget {
    let Ok(candidates) = resources.declarations_with_id(idref) else {
        return IdrefTarget::Invalid;
    };
    let candidates = candidates
        .map(|declaration| declaration.ordinal())
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [] => IdrefTarget::Missing,
        [declaration] => IdrefTarget::Declaration(*declaration),
        _ => IdrefTarget::Ambiguous(candidates),
    }
}

/// Compares outcomes without their candidate lists, which the index does not serialize.
fn idref_shape(target: &IdrefTarget) -> (u8, Option<u32>) {
    match target {
        IdrefTarget::Declaration(declaration) => (0, Some(declaration.as_u32())),
        IdrefTarget::Invalid => (1, None),
        IdrefTarget::Missing => (2, None),
        IdrefTarget::Ambiguous(_) => (3, None),
    }
}

fn project_reading_order_input(
    meta: &[Meta],
    resources: &ResourceIndex,
) -> Result<Vec<ReadingOrderOccurrence>, KernelError> {
    let layout = publication_layout(meta);
    let mut fallback_selector = FallbackSelector::new(resources);
    let reading_order = resources
        .reading_order()
        .enumerate()
        .map(|(index, entry)| {
            let ordinal = u32::try_from(index).map_err(|_| KernelError::InvalidFacts)?;
            let target = reading_order_target(resources, entry)?;
            validate_reading_order_target(&target, resources)?;
            let presentation = occurrence_presentation(entry.presentation());
            presentation.validate()?;
            let (selected_declaration, document) = select_document(
                resources,
                &target,
                &presentation,
                layout,
                &mut fallback_selector,
            )?;
            Ok(ReadingOrderOccurrence {
                ordinal,
                target,
                selected_declaration,
                linear: match entry.linear() {
                    epub_stack::package::spine::Linear::Yes => crate::kernel::OccurrenceLinear::Yes,
                    epub_stack::package::spine::Linear::No => crate::kernel::OccurrenceLinear::No,
                },
                presentation,
                document,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_effective_document_formats(resources, &reading_order)?;
    Ok(reading_order)
}

impl KernelPublication {
    pub(in crate::kernel) fn validate_locator_context(
        &self,
        locator: &NavigatorLocation,
    ) -> Result<(), KernelError> {
        let (occurrence, resource) = locator.context();
        let index = usize::try_from(occurrence).map_err(|_| KernelError::InvalidLocator)?;
        match self.reading_order.get(index) {
            Some(expected)
                if expected
                    .document
                    .loadable()
                    .is_some_and(|target| target.0 == resource) =>
            {
                Ok(())
            }
            _ => Err(KernelError::InvalidLocator),
        }
    }
}

#[derive(Debug)]
pub(in crate::kernel) struct KernelResource {
    pub(in crate::kernel) path: String,
    pub(in crate::kernel) present: bool,
    pub(in crate::kernel) manifest: bool,
    pub(in crate::kernel) has_xhtml_declaration: bool,
    pub(in crate::kernel) has_svg_declaration: bool,
}

/// Recovers ambiguity candidates from the occurrence's authored IDREF, which the index reports
/// without candidates because serializing them is quadratic.
fn reading_order_target(
    resources: &ResourceIndex,
    entry: ReadingOrderOccurrenceRef<'_>,
) -> Result<ReadingOrderTarget, KernelError> {
    match entry.target() {
        None => Ok(ReadingOrderTarget::MissingIdref),
        Some(IdrefTarget::Declaration(declaration)) => Ok(ReadingOrderTarget::Declaration {
            declaration: declaration.as_u32(),
            resource: entry.resource().map(|resource| resource.ordinal().as_u32()),
        }),
        Some(IdrefTarget::Invalid | IdrefTarget::Missing) => {
            Ok(ReadingOrderTarget::MissingManifestId)
        }
        Some(IdrefTarget::Ambiguous(_)) => {
            let idref = entry
                .idref()
                .map(|idref| idref.as_str())
                .and_then(|idref| normalize_manifest_id(idref).ok())
                .ok_or(KernelError::InvalidFacts)?;
            let candidates = resources
                .declarations_with_id(idref)
                .map_err(|_| KernelError::InvalidFacts)?
                .map(|declaration| declaration.ordinal().as_u32())
                .collect();
            Ok(ReadingOrderTarget::AmbiguousManifestId { candidates })
        }
    }
}

#[derive(Clone, Copy)]
enum FallbackSelection {
    Declaration(u32),
    Unavailable(OccurrenceUnavailableReason),
}

fn select_document(
    resources: &ResourceIndex,
    target: &ReadingOrderTarget,
    presentation: &OccurrencePresentation,
    publication_layout: PublicationLayout,
    fallback_selector: &mut FallbackSelector<'_>,
) -> Result<(Option<u32>, OccurrenceDocumentTarget), KernelError> {
    let ReadingOrderTarget::Declaration { declaration, .. } = target else {
        return Ok((None, OccurrenceDocumentTarget::Unresolved));
    };
    let selection = fallback_selector.select(
        *declaration,
        fixed_page_occurrence(presentation, publication_layout),
    )?;
    let ordinal = match selection {
        FallbackSelection::Declaration(ordinal) => ordinal,
        FallbackSelection::Unavailable(reason) => {
            return Ok((
                None,
                OccurrenceDocumentTarget::Unavailable {
                    resource: original_resource(resources, target),
                    adapter: None,
                    reason,
                },
            ));
        }
    };
    let declaration = resources
        .declaration(epub_stack::resource::ManifestOrdinal::new(ordinal))
        .ok_or(KernelError::InvalidFacts)?;
    let document = match declaration.target() {
        DeclarationTarget::Resource { resource } => {
            let resource = resources
                .resource(resource)
                .ok_or(KernelError::InvalidFacts)?;
            if let ResourceAddress::Local(path) = resource.address() {
                let resolved = declaration.href().and_then(|href| {
                    resolve_publication_href(
                        &AuthoredHref::new(href.as_str()),
                        resources.package_path(),
                    )
                });
                if resolved.as_ref().map(EpubPath::as_str) != Some(path.as_str()) {
                    return Err(KernelError::InvalidFacts);
                }
            }
            derive_resource(resource, declaration, presentation, publication_layout)?
        }
        DeclarationTarget::MissingHref | DeclarationTarget::InvalidHref => {
            OccurrenceDocumentTarget::Unresolved
        }
    };
    Ok((Some(ordinal), document))
}

struct FallbackSelector<'a> {
    resources: &'a ResourceIndex,
    selections: Vec<Option<FallbackSelection>>,
    path_positions: Vec<Option<usize>>,
}

impl<'a> FallbackSelector<'a> {
    fn new(resources: &'a ResourceIndex) -> Self {
        let declaration_count = resources.declarations().len();
        Self {
            resources,
            selections: vec![None; declaration_count],
            path_positions: vec![None; declaration_count],
        }
    }

    /// `fixed_page` reports whether this occurrence is laid out as a page of its own, which is
    /// what lets an image stand as the document: it cannot reflow, so anywhere else the image is
    /// a foreign content document and the chain is walked to something that can.
    fn select(&mut self, start: u32, fixed_page: bool) -> Result<FallbackSelection, KernelError> {
        let mut path = Vec::new();
        let mut current = start;
        let selection = loop {
            let index = usize::try_from(current).map_err(|_| KernelError::InvalidFacts)?;
            let declaration = self
                .resources
                .declaration(epub_stack::resource::ManifestOrdinal::new(current))
                .ok_or(KernelError::InvalidFacts)?;
            if declaration_supported(declaration) || (fixed_page && supported_raster(declaration)) {
                let selection = FallbackSelection::Declaration(current);
                self.selections[index] = Some(selection);
                break selection;
            }
            if let Some(selection) = self.selections[index] {
                break selection;
            }
            if self.path_positions[index].is_some() {
                break FallbackSelection::Unavailable(
                    OccurrenceUnavailableReason::ManifestFallbackCycle,
                );
            }
            self.path_positions[index] = Some(path.len());
            path.push(current);
            match declaration.fallback_target() {
                None => {
                    break FallbackSelection::Unavailable(
                        OccurrenceUnavailableReason::ManifestFallbackExhausted,
                    );
                }
                Some(IdrefTarget::Declaration(declaration)) => {
                    current = declaration.as_u32();
                }
                Some(IdrefTarget::Invalid | IdrefTarget::Missing | IdrefTarget::Ambiguous(_)) => {
                    break FallbackSelection::Unavailable(
                        OccurrenceUnavailableReason::ManifestFallbackUnresolved,
                    );
                }
            }
        };
        for declaration in path {
            let index = usize::try_from(declaration).map_err(|_| KernelError::InvalidFacts)?;
            self.path_positions[index] = None;
            self.selections[index] = Some(selection);
        }
        Ok(selection)
    }
}

fn declaration_supported(declaration: ManifestDeclarationRef<'_>) -> bool {
    declaration
        .media_type()
        .is_some_and(|media_type| media_type.is_xhtml() || media_type.is_svg())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DocumentFormat {
    Xhtml,
    Svg,
    Image,
}

/// Whether this occurrence is laid out as a page of its own rather than as reflowing text.
///
/// A roll publication is pages throughout, and elsewhere it is the occurrence's own layout that
/// decides, itemref override included, exactly as the adapter choice reads it.
fn fixed_page_occurrence(
    presentation: &OccurrencePresentation,
    publication_layout: PublicationLayout,
) -> bool {
    if publication_layout == PublicationLayout::Roll {
        return true;
    }
    let override_value = match &presentation.layout {
        OccurrenceRenditionSetting::Ambiguous(candidates) => candidates
            .iter()
            .find(|candidate| {
                candidate.source == OccurrenceRenditionValueSource::ItemRefProperty
                    && candidate.value.is_some()
            })
            .map(|candidate| candidate.value),
        _ => None,
    };
    let value = match override_value {
        Some(value) => value,
        None => match &presentation.layout {
            OccurrenceRenditionSetting::Specified(candidate) => candidate.value,
            _ => None,
        },
    };
    matches!(
        value,
        Some(OccurrenceRenditionLayout::PrePaginated | OccurrenceRenditionLayout::Roll)
    )
}

fn supported_raster(declaration: ManifestDeclarationRef<'_>) -> bool {
    declaration
        .media_type()
        .map(MediaType::as_str)
        .is_some_and(|mime| {
            [
                "image/png",
                "image/jpeg",
                "image/gif",
                "image/webp",
                "image/avif",
            ]
            .iter()
            .any(|supported| mime.eq_ignore_ascii_case(supported))
        })
}

fn declaration_format(declaration: ManifestDeclarationRef<'_>) -> Option<DocumentFormat> {
    declaration.media_type().and_then(|media_type| {
        if media_type.is_xhtml() {
            Some(DocumentFormat::Xhtml)
        } else if media_type.is_svg() {
            Some(DocumentFormat::Svg)
        } else if supported_raster(declaration) {
            Some(DocumentFormat::Image)
        } else {
            None
        }
    })
}

fn validate_effective_document_formats(
    resources: &ResourceIndex,
    reading_order: &[ReadingOrderOccurrence],
) -> Result<(), KernelError> {
    let mut formats = BTreeMap::new();
    for occurrence in reading_order {
        let Some(declaration) = occurrence.selected_declaration else {
            continue;
        };
        let declaration = resources
            .declaration(epub_stack::resource::ManifestOrdinal::new(declaration))
            .ok_or(KernelError::InvalidFacts)?;
        let DeclarationTarget::Resource { resource } = declaration.target() else {
            continue;
        };
        let resource = resources
            .resource(resource)
            .ok_or(KernelError::InvalidFacts)?;
        let ResourceAddress::Local(path) = resource.address() else {
            continue;
        };
        let format = declaration_format(declaration).ok_or(KernelError::InvalidFacts)?;
        if formats
            .insert(path.as_str(), format)
            .is_some_and(|seen| seen != format)
        {
            return Err(KernelError::InvalidFacts);
        }
    }
    Ok(())
}

fn original_resource(resources: &ResourceIndex, target: &ReadingOrderTarget) -> Option<String> {
    let ReadingOrderTarget::Declaration {
        resource: Some(resource),
        ..
    } = target
    else {
        return None;
    };
    match resources
        .resource(epub_stack::resource::ResourceOrdinal::new(*resource))?
        .address()
    {
        ResourceAddress::Local(path) => Some(path.as_str().to_owned()),
        _ => None,
    }
}

/// Checks that declarations and resources agree in both directions, because a host supplies both.
fn validate_resource_topology(resources: &ResourceIndex) -> Result<(), KernelError> {
    for resource in resources.resources() {
        let mut previous = None;
        for declaration in resource.declarations() {
            let ordinal = declaration.ordinal().as_u32();
            let expected = DeclarationTarget::Resource {
                resource: resource.ordinal(),
            };
            if previous.is_some_and(|previous| previous >= ordinal)
                || declaration.target() != expected
            {
                return Err(KernelError::InvalidFacts);
            }
            previous = Some(ordinal);
        }
    }

    for declaration in resources.declarations() {
        if let DeclarationTarget::Resource { resource } = declaration.target() {
            let resource = resources
                .resource(resource)
                .ok_or(KernelError::InvalidFacts)?;
            if !resource
                .declarations()
                .any(|entry| entry.ordinal() == declaration.ordinal())
            {
                return Err(KernelError::InvalidFacts);
            }
        }
    }
    Ok(())
}

fn validate_reading_order_target(
    target: &ReadingOrderTarget,
    resources: &ResourceIndex,
) -> Result<(), KernelError> {
    let manifest_target = |ordinal: u32| {
        resources
            .declaration(epub_stack::resource::ManifestOrdinal::new(ordinal))
            .map(|declaration| declaration.target())
    };
    match target {
        ReadingOrderTarget::Declaration {
            declaration,
            resource: Some(resource),
        } if manifest_target(*declaration)
            == Some(DeclarationTarget::Resource {
                resource: epub_stack::resource::ResourceOrdinal::new(*resource),
            }) =>
        {
            Ok(())
        }
        ReadingOrderTarget::Declaration {
            declaration,
            resource: None,
        } if matches!(
            manifest_target(*declaration),
            Some(DeclarationTarget::MissingHref | DeclarationTarget::InvalidHref)
        ) =>
        {
            Ok(())
        }
        ReadingOrderTarget::MissingIdref | ReadingOrderTarget::MissingManifestId => Ok(()),
        ReadingOrderTarget::AmbiguousManifestId { candidates }
            if candidates.len() > 1
                && candidates
                    .iter()
                    .copied()
                    .all(|candidate| manifest_target(candidate).is_some()) =>
        {
            Ok(())
        }
        _ => Err(KernelError::InvalidFacts),
    }
}

fn derive_resource(
    resource: ResourceRef<'_>,
    declaration: ManifestDeclarationRef<'_>,
    presentation: &OccurrencePresentation,
    publication_layout: PublicationLayout,
) -> Result<OccurrenceDocumentTarget, KernelError> {
    enum DeclarationKind {
        Xhtml,
        Svg,
        Image,
        Unsupported,
    }
    let declaration_kind =
        declaration
            .media_type()
            .map_or(DeclarationKind::Unsupported, |media_type| {
                if media_type.is_xhtml() {
                    DeclarationKind::Xhtml
                } else if media_type.is_svg() {
                    DeclarationKind::Svg
                } else if fixed_page_occurrence(presentation, publication_layout)
                    && supported_raster(declaration)
                {
                    DeclarationKind::Image
                } else {
                    DeclarationKind::Unsupported
                }
            });
    // Stack retains authored ambiguity; only itemref overrides have first-recognized semantics.
    let first_override = match &presentation.layout {
        OccurrenceRenditionSetting::Ambiguous(candidates) => candidates
            .iter()
            .find(|candidate| {
                candidate.source == OccurrenceRenditionValueSource::ItemRefProperty
                    && candidate.value.is_some()
            })
            .map(|candidate| OccurrenceRenditionSetting::Specified(candidate.clone())),
        _ => None,
    };
    let layout = first_override.as_ref().unwrap_or(&presentation.layout);
    let (adapter, unavailable) = match (declaration_kind, layout) {
        (DeclarationKind::Xhtml, _) if publication_layout == PublicationLayout::Roll => {
            (Some(DocumentAdapter::FixedXhtml), None)
        }
        (DeclarationKind::Xhtml, OccurrenceRenditionSetting::Unspecified)
        | (
            DeclarationKind::Xhtml,
            OccurrenceRenditionSetting::Specified(OccurrenceRenditionCandidate {
                value: Some(OccurrenceRenditionLayout::Reflowable),
                ..
            }),
        ) => (Some(DocumentAdapter::ReflowableXhtml), None),
        (
            DeclarationKind::Xhtml,
            OccurrenceRenditionSetting::Specified(OccurrenceRenditionCandidate {
                value:
                    Some(OccurrenceRenditionLayout::PrePaginated | OccurrenceRenditionLayout::Roll),
                ..
            }),
        ) => (Some(DocumentAdapter::FixedXhtml), None),
        (DeclarationKind::Svg, _) => (Some(DocumentAdapter::FixedSvg), None),
        (DeclarationKind::Image, _) => (Some(DocumentAdapter::FixedImage), None),
        (DeclarationKind::Xhtml, OccurrenceRenditionSetting::Ambiguous(_)) => {
            (None, Some(OccurrenceUnavailableReason::AmbiguousRendition))
        }
        (DeclarationKind::Xhtml, OccurrenceRenditionSetting::Specified(_)) => (
            None,
            Some(OccurrenceUnavailableReason::UnsupportedRendition),
        ),
        (DeclarationKind::Unsupported, _) => unreachable!("unsupported declarations are skipped"),
    };
    match (resource.address(), resource.presence()) {
        (ResourceAddress::Local(path), ProviderPresence::Present { .. }) => Ok(match unavailable {
            None => OccurrenceDocumentTarget::Loadable {
                resource: path.as_str().to_owned(),
                adapter: adapter.expect("an available document has a selected adapter"),
            },
            Some(reason) => OccurrenceDocumentTarget::Unavailable {
                resource: Some(path.as_str().to_owned()),
                adapter,
                reason,
            },
        }),
        (ResourceAddress::Local(path), ProviderPresence::Missing) => {
            Ok(OccurrenceDocumentTarget::Unavailable {
                resource: Some(path.as_str().to_owned()),
                adapter,
                reason: OccurrenceUnavailableReason::ResourceMissing,
            })
        }
        (
            ResourceAddress::Remote(_) | ResourceAddress::Data(_) | ResourceAddress::External(_),
            ProviderPresence::NotApplicable,
        ) => Ok(OccurrenceDocumentTarget::Unavailable {
            resource: None,
            adapter,
            reason: OccurrenceUnavailableReason::NonLocal,
        }),
        _ => Err(KernelError::InvalidFacts),
    }
}
