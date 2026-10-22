use crate::kernel::{NavigationBoundary, OccurrenceUnavailableReason};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Stable JSON-safe failure data used by Rust and browser adapters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "code",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum NavigatorFailure {
    LocalRuntimeInitializationFailed {
        message: String,
    },
    PublicationOpenFailed {
        message: String,
    },
    PublicationFactsReadFailed {
        message: String,
    },
    PublicationFactsParseFailed {
        message: String,
    },
    PublicationFactsInvalid {
        message: String,
    },
    PublicationClosed {
        message: String,
    },
    PublicationCloseFailed {
        message: String,
    },
    ResourceReadFailed {
        message: String,
        path: String,
    },
    KernelRuntimeInitializationFailed {
        message: String,
    },
    KernelCreateFailed {
        message: String,
    },
    KernelResponseParseFailed {
        message: String,
    },
    KernelClosed {
        message: String,
    },
    KernelCloseFailed {
        message: String,
    },
    InvalidMount {
        message: String,
    },
    InvalidPublicationRoute {
        message: String,
        route: String,
    },
    InvalidLocator {
        message: String,
    },
    InvalidDocumentObservation {
        message: String,
    },
    InvalidLayoutResult {
        message: String,
    },
    InvalidCommand {
        message: String,
    },
    KernelCommandFailed {
        message: String,
    },
    OccurrenceOutOfBounds {
        message: String,
        occurrence: u32,
    },
    OccurrenceUnresolved {
        message: String,
        occurrence: u32,
    },
    OccurrenceUnavailable {
        message: String,
        occurrence: u32,
        reason: OccurrenceUnavailableReason,
    },
    NavigationBoundary {
        message: String,
        boundary: NavigationBoundary,
    },
    NoCurrentDocument {
        message: String,
    },
    NoPendingDocument {
        message: String,
    },
    DocumentPending {
        message: String,
        generation: u32,
    },
    DocumentGenerationExhausted {
        message: String,
    },
    FrameGenerationExhausted {
        message: String,
    },
    LayoutGenerationExhausted {
        message: String,
    },
    AgentOperationExhausted {
        message: String,
    },
    StateRevisionExhausted {
        message: String,
    },
    StaleObservation {
        message: String,
        observed_generation: u32,
        expected_generation: Option<u32>,
    },
    StaleAgentOperationObservation {
        message: String,
        observed_operation: u32,
        observed_generation: u32,
        expected_operation: Option<u32>,
        expected_generation: Option<u32>,
    },
}

/// Fatal kernel construction or serialization failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum KernelError {
    #[error("kernel initialization JSON is invalid")]
    InvalidInitialization,
    #[error("publication facts are invalid")]
    InvalidFacts,
    #[error("publication mount is invalid")]
    InvalidMount,
    #[error("publication locator is invalid")]
    InvalidLocator,
    #[error("content-document observation is invalid")]
    InvalidDocumentObservation,
    #[error("layout result is invalid")]
    InvalidLayoutResult,
    #[error("annotation target or execution data is invalid")]
    InvalidAnnotationTarget,
}

pub const MAX_ANNOTATION_TARGET_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_ANNOTATION_SELECTOR_NODES: usize = 4096;
pub const MAX_ANNOTATION_SELECTOR_DEPTH: usize = epub_stack::annotation::MAX_SELECTOR_NESTING_DEPTH;
pub const MAX_ANNOTATION_SELECTOR_VALUE_BYTES: usize = 16 * 1024;
pub const MAX_ANNOTATION_AGGREGATE_STRING_BYTES: usize = 1024 * 1024;
pub const MAX_DECORATION_ID_BYTES: usize = 1024;
pub const MAX_ANNOTATION_EXCERPT_CODE_POINTS: usize = 512;
pub const MAX_ANNOTATION_EXCERPT_BYTES: usize = 2048;
pub const MAX_SELECTION_CAPTURE_EVIDENCE_ITEMS: usize = 64;
pub const MAX_SELECTION_CAPTURE_STRING_BYTES: usize = 16 * 1024;
pub const MAX_SELECTION_CAPTURE_AGGREGATE_STRING_BYTES: usize = 64 * 1024;
