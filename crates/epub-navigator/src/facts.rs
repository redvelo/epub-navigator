//! The structural publication facts Navigator hands to its kernel and hosts.
//!
//! Stack owns each model; this module owns the wire shape that carries them together.

use epub_stack::navigation::NavigationDocument;
use epub_stack::navigation::facts::{NavigationLoadingFacts, NavigationTargetFacts};
use epub_stack::package::Package;
use epub_stack::resource::ResourceIndex;
use epub_stack::{Epub, resource::provider::ResourceProvider};

/// One coherent view of a publication's structure, borrowed from the open publication.
#[derive(Debug, Clone, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PublicationFacts<'a> {
    /// Complete modeled OPF package structure.
    pub package: &'a Package,
    /// Selected normalized EPUB NAV or NCX structure.
    pub navigation: Option<&'a NavigationDocument>,
    /// Resource inventory and resolution outcomes aligned with the package structure.
    pub resources: &'a ResourceIndex,
    /// Navigation acquisition observations aligned with the same state.
    pub navigation_loading: NavigationLoadingFacts,
    /// Navigation targets in list order and depth-first point order.
    pub navigation_targets: Vec<NavigationTargetFacts>,
}

impl<'a> PublicationFacts<'a> {
    /// Borrows the structural facts of an open publication.
    ///
    /// # Errors
    ///
    /// Returns an error when navigation positions exceed portable 32-bit facts indices.
    pub fn of<R: ResourceProvider>(
        epub: &'a Epub<R>,
    ) -> Result<Self, epub_stack::navigation::facts::NavigationPositionOverflow> {
        Ok(Self {
            package: epub.package(),
            navigation: epub.navigation(),
            resources: epub.resources(),
            navigation_loading: epub.navigation_loading(),
            navigation_targets: epub.navigation_targets()?,
        })
    }
}
