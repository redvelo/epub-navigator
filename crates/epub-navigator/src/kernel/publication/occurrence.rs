use crate::kernel::{DocumentAdapter, OccurrencePresentation};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Exact declaration resolution retained for one authored occurrence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReadingOrderTarget {
    Declaration {
        declaration: u32,
        resource: Option<u32>,
    },
    MissingIdref,
    MissingManifestId,
    AmbiguousManifestId {
        candidates: Vec<u32>,
    },
}

/// Whether one spine occurrence belongs to the primary reading order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum OccurrenceLinear {
    Yes,
    No,
}

/// Why a resolved occurrence cannot be loaded by this kernel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum OccurrenceUnavailableReason {
    ResourceMissing,
    NonLocal,
    DocumentAdapterUnavailable,
    ManifestFallbackExhausted,
    ManifestFallbackUnresolved,
    ManifestFallbackCycle,
    AmbiguousRendition,
    UnsupportedRendition,
}

/// Structurally valid browser target derived for one authored occurrence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OccurrenceDocumentTarget {
    Loadable {
        resource: String,
        adapter: DocumentAdapter,
    },
    Unavailable {
        resource: Option<String>,
        adapter: Option<DocumentAdapter>,
        reason: OccurrenceUnavailableReason,
    },
    Unresolved,
}

impl OccurrenceDocumentTarget {
    pub(in crate::kernel) fn loadable(&self) -> Option<(&str, DocumentAdapter)> {
        match self {
            Self::Loadable { resource, adapter } => Some((resource, *adapter)),
            Self::Unavailable { .. } | Self::Unresolved => None,
        }
    }
}

/// One authored reading-order occurrence, identified only by its ordinal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadingOrderOccurrence {
    /// Snapshot-local occurrence identity.
    pub ordinal: u32,
    /// Exact declaration resolution retained from Stack facts.
    pub target: ReadingOrderTarget,
    /// Effective declaration selected from the authored fallback chain.
    pub selected_declaration: Option<u32>,
    /// Modeled `linear` value from the ordinal-aligned spine itemref.
    pub linear: OccurrenceLinear,
    /// Exact occurrence-owned authored presentation evidence.
    pub presentation: OccurrencePresentation,
    /// Canonical document identity, adapter, and operational availability.
    pub document: OccurrenceDocumentTarget,
}

/// An explicit end of reading-order navigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum NavigationBoundary {
    /// There is no previous occurrence.
    Start,
    /// There is no next occurrence.
    End,
}
