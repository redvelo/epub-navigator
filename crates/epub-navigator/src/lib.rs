//! Rust implementation and WebAssembly bindings for EPUB Navigator.

pub mod facts;
pub mod kernel;
mod preparation;
mod search;
pub use preparation::foreground_preparation_state;
pub use search::{SearchTextEntry, search_text_entries};

use epub_stack::{
    Epub, EpubPath, EpubZip,
    analysis::{AnalysisOutcome, PublicationAnalysis, fingerprint::Blake3Hash},
};
use kernel::{
    KernelInput, NavigatorKernel, OccurrenceDocumentTarget, ReadingOrderOccurrence,
    project_reading_order,
};
use serde::Serialize;
use std::{
    cell::OnceCell,
    collections::{BTreeMap, HashMap},
    io::Cursor,
};
use wasm_bindgen::prelude::*;

type BrowserEpub = Epub<EpubZip<Cursor<Vec<u8>>>>;

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum ExecutableContentState {
    Detected,
    AnalyzedAbsent,
    Unknown,
    Inapplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ForegroundPreparationState {
    Eligible,
    Ineligible,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisProjection<'a> {
    executable_content: Vec<ExecutableContentState>,
    foreground_preparation: Vec<ForegroundPreparationState>,
    search_documents: Vec<SearchDocumentProjection>,
    search_entries: Vec<SearchEntryProjection>,
    search_document_states: BTreeMap<&'a str, LocalSearchDocumentState>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum LocalSearchDocumentState {
    Complete,
    Partial,
    Unavailable,
    Inapplicable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchEntryProjection {
    id: String,
    resource_path: String,
    fragment: Option<String>,
    text: String,
    source: String,
    reading_order_occurrence_indexes: Vec<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchDocumentProjection {
    occurrence: usize,
    resource_path: String,
    source: String,
}

struct SearchOccurrenceGroup<'a> {
    source: &'a str,
    occurrences: Vec<usize>,
}

type SearchDocumentIndex<'a> = HashMap<&'a str, Vec<SearchOccurrenceGroup<'a>>>;

/// An EPUB publication owned by WebAssembly.
#[wasm_bindgen]
pub struct WasmPublication {
    epub: BrowserEpub,
    analysis: OnceCell<PublicationAnalysis>,
}

#[wasm_bindgen]
impl WasmPublication {
    /// Computes the lowercase hexadecimal BLAKE3 digest of complete source bytes.
    #[wasm_bindgen(js_name = hashBlake3)]
    pub fn hash_blake3(bytes: &[u8]) -> String {
        Blake3Hash::hash(bytes).to_string()
    }

    /// Opens the default rendition from complete EPUB archive bytes.
    #[wasm_bindgen(js_name = open)]
    pub fn open(bytes: Vec<u8>) -> Result<WasmPublication, JsError> {
        console_error_panic_hook::set_once();

        let container = EpubZip::from_reader(Cursor::new(bytes)).map_err(js_error)?;
        let epub = container.default_rendition().map_err(js_error)?;
        Ok(Self {
            epub,
            analysis: OnceCell::new(),
        })
    }

    /// Returns one coherent JSON-safe snapshot of current structural publication facts.
    #[wasm_bindgen(getter, js_name = publicationFactsJson)]
    pub fn publication_facts_json(&self) -> Result<String, JsError> {
        let facts = crate::facts::PublicationFacts::of(&self.epub).map_err(js_error)?;
        serde_json::to_string(&facts).map_err(js_error)
    }

    /// Returns all analysis-backed host projections from one retained snapshot.
    #[wasm_bindgen(js_name = analysisJson)]
    pub fn analysis_json(&self) -> Result<String, JsError> {
        let analysis = self.analysis();
        let facts = crate::facts::PublicationFacts::of(&self.epub).map_err(js_error)?;
        let reading_order = project_reading_order(&facts).map_err(js_error)?;
        let search_documents =
            search_document_projections(&facts, &reading_order).map_err(js_error)?;
        let search_document_index = search_document_index(&search_documents);
        let projection = AnalysisProjection {
            executable_content: executable_content_states(analysis),
            foreground_preparation: foreground_preparation_states(analysis),
            search_entries: search_entry_projections(analysis, &search_document_index),
            search_documents,
            search_document_states: search_document_states(analysis),
        };
        serde_json::to_string(&projection).map_err(js_error)
    }

    /// Reads the complete current bytes for one canonical publication resource.
    #[wasm_bindgen(js_name = readResource)]
    pub fn read_resource(&self, path: &str) -> Result<Vec<u8>, JsError> {
        let path = EpubPath::new(path).map_err(js_error)?;
        self.epub.bytes(&path).map_err(js_error)
    }

    fn analysis(&self) -> &PublicationAnalysis {
        self.analysis.get_or_init(|| self.epub.analyze())
    }
}

fn executable_content_states(analysis: &PublicationAnalysis) -> Vec<ExecutableContentState> {
    analysis
        .analyzed_resources()
        .map(|facts| match facts.content() {
            AnalysisOutcome::Complete(content) => content.executable_content_detected().map_or(
                ExecutableContentState::Inapplicable,
                |detected| {
                    if detected {
                        ExecutableContentState::Detected
                    } else {
                        ExecutableContentState::AnalyzedAbsent
                    }
                },
            ),
            AnalysisOutcome::Partial { value, .. } => value
                .executable_content_detected()
                .filter(|detected| *detected)
                .map_or(ExecutableContentState::Unknown, |_| {
                    ExecutableContentState::Detected
                }),
            AnalysisOutcome::NotApplicable => ExecutableContentState::Inapplicable,
            AnalysisOutcome::Unavailable(_) => ExecutableContentState::Unknown,
        })
        .collect()
}

fn foreground_preparation_states(
    analysis: &PublicationAnalysis,
) -> Vec<ForegroundPreparationState> {
    analysis
        .analyzed_resources()
        .map(foreground_preparation_state)
        .collect()
}

fn search_document_states(
    analysis: &PublicationAnalysis,
) -> BTreeMap<&str, LocalSearchDocumentState> {
    let mut states = BTreeMap::new();
    for facts in analysis.analyzed_resources() {
        let resource = facts.resource();
        let Some(path) = resource.local_path() else {
            continue;
        };
        let state = match facts.content() {
            AnalysisOutcome::Complete(content) => {
                if content.as_xhtml().is_some() {
                    LocalSearchDocumentState::Complete
                } else {
                    LocalSearchDocumentState::Inapplicable
                }
            }
            AnalysisOutcome::Partial { value, .. } => {
                if value.as_xhtml().is_some() {
                    LocalSearchDocumentState::Partial
                } else {
                    LocalSearchDocumentState::Inapplicable
                }
            }
            AnalysisOutcome::Unavailable(_) => LocalSearchDocumentState::Unavailable,
            AnalysisOutcome::NotApplicable => LocalSearchDocumentState::Inapplicable,
        };
        states.insert(path.as_str(), state);
    }
    states
}

fn search_entry_projections(
    analysis: &PublicationAnalysis,
    documents: &SearchDocumentIndex<'_>,
) -> Vec<SearchEntryProjection> {
    let mut projections = Vec::new();
    for entry in search_text_entries(analysis) {
        let Some(path) = entry.resource.local_path() else {
            continue;
        };
        let Some(groups) = documents.get(path.as_str()) else {
            continue;
        };
        let mut text = Some(entry.text.to_string());
        for (index, group) in groups.iter().enumerate() {
            projections.push(SearchEntryProjection {
                id: format!(
                    "{}#text-{}-{}@{}",
                    path.as_str(),
                    entry.range.start(),
                    entry.range.end(),
                    group.occurrences[0]
                ),
                resource_path: path.as_str().to_string(),
                fragment: entry.fragment.map(str::to_string),
                text: if index + 1 == groups.len() {
                    text.take().expect("the final source group owns the text")
                } else {
                    text.as_ref()
                        .expect("a source group retains the text")
                        .clone()
                },
                source: group.source.to_string(),
                reading_order_occurrence_indexes: group.occurrences.clone(),
            });
        }
    }
    projections
}

fn search_document_index(documents: &[SearchDocumentProjection]) -> SearchDocumentIndex<'_> {
    let mut index: SearchDocumentIndex<'_> = HashMap::new();
    let mut group_indexes: HashMap<(&str, &str), usize> = HashMap::new();
    for document in documents {
        let path = document.resource_path.as_str();
        let source = document.source.as_str();
        if let Some(group_index) = group_indexes.get(&(path, source)).copied() {
            index
                .get_mut(path)
                .expect("an indexed source has an indexed resource")[group_index]
                .occurrences
                .push(document.occurrence);
        } else {
            let groups = index.entry(path).or_default();
            group_indexes.insert((path, source), groups.len());
            groups.push(SearchOccurrenceGroup {
                source,
                occurrences: vec![document.occurrence],
            });
        }
    }
    index
}

fn search_document_projections(
    facts: &crate::facts::PublicationFacts<'_>,
    reading_order: &[ReadingOrderOccurrence],
) -> Result<Vec<SearchDocumentProjection>, &'static str> {
    let mut documents = Vec::new();
    for occurrence in reading_order {
        let OccurrenceDocumentTarget::Loadable { resource, .. } = &occurrence.document else {
            continue;
        };
        let declaration = occurrence
            .selected_declaration
            .ok_or("loadable search document has no effective declaration")?;
        let source = facts
            .package
            .manifest()
            .items()
            .get(declaration as usize)
            .and_then(|item| item.authored_href())
            .ok_or("loadable search document has no authored source")?;
        documents.push(SearchDocumentProjection {
            occurrence: occurrence.ordinal as usize,
            resource_path: resource.clone(),
            source: source.to_string(),
        });
    }
    Ok(documents)
}

/// A deterministic EPUB Navigator session kernel owned by WebAssembly.
#[wasm_bindgen]
pub struct WasmNavigatorKernel {
    kernel: NavigatorKernel,
}

#[wasm_bindgen]
impl WasmNavigatorKernel {
    /// Creates a kernel from one JSON publication handoff.
    #[wasm_bindgen(js_name = create)]
    pub fn create(initialization_json: &str) -> Result<WasmNavigatorKernel, JsError> {
        console_error_panic_hook::set_once();
        let kernel = NavigatorKernel::create(initialization_json).map_err(js_error)?;
        Ok(Self { kernel })
    }

    /// Applies one JSON command and returns its coherent transition.
    #[wasm_bindgen(js_name = dispatchJson)]
    pub fn dispatch_json(&mut self, command_json: &str) -> Result<String, JsError> {
        let command: KernelInput = serde_json::from_str(command_json).map_err(js_error)?;
        serde_json::to_string(&self.kernel.dispatch(command)).map_err(js_error)
    }

    /// Projects authored annotation target JSON into a browser execution plan.
    #[wasm_bindgen(js_name = projectAnnotationTargetJson)]
    pub fn project_annotation_target_json(&self, target_json: &str) -> Result<String, JsError> {
        self.kernel
            .project_annotation_target_json(target_json)
            .map_err(js_error)
    }

    /// Returns one coherent JSON snapshot of current logical state.
    #[wasm_bindgen(getter, js_name = snapshotJson)]
    pub fn snapshot_json(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.kernel.snapshot()).map_err(js_error)
    }

    /// Returns the current accepted-transition revision.
    #[wasm_bindgen(getter, js_name = stateRevision)]
    pub fn state_revision(&self) -> u32 {
        self.kernel.state_revision()
    }
}

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use epub_stack::MemoryResourceProvider;
    use serde_json::Value;

    fn xhtml(body: &str) -> Vec<u8> {
        format!(r#"<html xmlns="http://www.w3.org/1999/xhtml"><body>{body}</body></html>"#)
            .into_bytes()
    }
    fn package_path() -> EpubPath {
        EpubPath::new("EPUB/package.opf").unwrap()
    }
    fn search_projection(
        manifest: &str,
        spine: &str,
        resources: Vec<(&str, Vec<u8>)>,
    ) -> (Vec<SearchDocumentProjection>, Vec<SearchEntryProjection>) {
        let package = format!(
            r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest>{manifest}</manifest><spine>{spine}</spine></package>"#
        );
        let provider = MemoryResourceProvider::from_entries(
            [("EPUB/package.opf", package.into_bytes())]
                .into_iter()
                .chain(resources),
        )
        .unwrap();
        let epub = Epub::from_provider(provider, package_path()).unwrap();
        let facts = crate::facts::PublicationFacts::of(&epub).unwrap();
        let documents =
            search_document_projections(&facts, &project_reading_order(&facts).unwrap()).unwrap();
        let entries = search_entry_projections(&epub.analyze(), &search_document_index(&documents));
        (documents, entries)
    }
    fn audio_with_fallback(
        fallback: Vec<u8>,
    ) -> (Vec<SearchDocumentProjection>, Vec<SearchEntryProjection>) {
        search_projection(
            r#"<item id="audio" href="chapter.mp3" media-type="audio/mpeg" fallback="text"/><item id="text" href="fallback.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<itemref idref="audio"/>"#,
            vec![
                ("EPUB/chapter.mp3", b"audio".to_vec()),
                ("EPUB/fallback.xhtml", fallback),
            ],
        )
    }

    #[test]
    fn empty_inline_scripts_are_not_executable_content() {
        let package = r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="empty" href="empty.xhtml" media-type="application/xhtml+xml"/><item id="run" href="run.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="empty"/><itemref idref="run"/></spine></package>"#;
        let provider = MemoryResourceProvider::from_entries([
            ("EPUB/package.opf", package.as_bytes().to_vec()),
            (
                "EPUB/empty.xhtml",
                xhtml(r#"<script type="text/javascript"></script><p>Text</p>"#),
            ),
            ("EPUB/run.xhtml", xhtml("<script>run()</script><p>Text</p>")),
        ])
        .unwrap();
        let epub = Epub::from_provider(provider, package_path()).unwrap();
        let states = executable_content_states(&epub.analyze());
        let labels = states
            .iter()
            .map(|state| serde_json::to_string(state).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            ["\"inapplicable\"", "\"analyzed-absent\"", "\"detected\""]
        );
    }

    #[test]
    fn wasm_publication_reuses_one_analysis_for_every_projection() {
        let publication = WasmPublication::open(
            include_bytes!("../../../tests/fixtures/host-conformance.epub").to_vec(),
        )
        .unwrap();
        assert!(publication.analysis.get().is_none());

        let first: Value = serde_json::from_str(&publication.analysis_json().unwrap()).unwrap();
        let retained = publication.analysis.get().unwrap() as *const PublicationAnalysis;
        let combined: Value = serde_json::from_str(&publication.analysis_json().unwrap()).unwrap();
        assert_eq!(combined, first);
        assert_eq!(
            retained,
            publication.analysis.get().unwrap() as *const PublicationAnalysis
        );

        for entry in combined["searchEntries"].as_array().unwrap() {
            let path = entry["resourcePath"].as_str().unwrap();
            assert_eq!(combined["searchDocumentStates"][path], "complete");
        }
    }

    #[test]
    fn search_entries_carry_context_and_unique_ids_across_documents() {
        let (_, entries) = search_projection(
            r#"<item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<itemref idref="one"/><itemref idref="one"/><itemref idref="two"/>"#,
            vec![
                (
                    "EPUB/one.xhtml",
                    xhtml(
                        r#"<form id="signup"><input id="email" name="address" value="reader@example.com"/></form><script id="inline">start()</script><p id="text">Search me</p>"#,
                    ),
                ),
                ("EPUB/two.xhtml", xhtml("<p>Two</p>")),
            ],
        );
        let [search, two] = entries.as_slice() else {
            panic!("unexpected search entries: {}", entries.len());
        };
        assert_eq!(search.text, "Search me");
        assert_eq!(search.resource_path, "EPUB/one.xhtml");
        assert_eq!(search.fragment.as_deref(), Some("text"));
        assert_eq!(search.reading_order_occurrence_indexes, vec![0, 1]);
        assert!(search.id.starts_with("EPUB/one.xhtml#"));
        assert!(two.id.starts_with("EPUB/two.xhtml#"));
        assert_ne!(search.id, two.id);
    }

    #[test]
    fn search_projection_uses_effective_fallback_occurrence_and_source() {
        let (_, entries) = audio_with_fallback(xhtml(r#"<p id="text">Fallback text</p>"#));
        let [entry] = entries.as_slice() else {
            panic!("unexpected search entries: {}", entries.len());
        };
        assert_eq!(entry.text, "Fallback text");
        assert_eq!(entry.resource_path, "EPUB/fallback.xhtml");
        assert_eq!(entry.source, "fallback.xhtml");
        assert_eq!(entry.reading_order_occurrence_indexes, vec![0]);

        let (documents, entries) = audio_with_fallback(xhtml(""));
        let [document] = documents.as_slice() else {
            panic!("unexpected search documents: {}", documents.len());
        };
        assert_eq!(document.resource_path, "EPUB/fallback.xhtml");
        assert_eq!(document.source, "fallback.xhtml");
        assert!(entries.is_empty());
    }

    #[test]
    fn search_projection_groups_duplicate_occurrences_by_authored_source() {
        let chapter = || vec![("EPUB/chapter.xhtml", xhtml("<p>One chunk</p>"))];
        let (documents, entries) = search_projection(
            r#"<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>"#,
            &r#"<itemref idref="chapter"/>"#.repeat(128),
            chapter(),
        );
        assert_eq!(documents.len(), 128);
        let [entry] = entries.as_slice() else {
            panic!("unexpected search entries: {}", entries.len());
        };
        assert_eq!(
            entry.reading_order_occurrence_indexes,
            (0..128).collect::<Vec<_>>()
        );

        let (_, entries) = search_projection(
            r#"<item id="one" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="two" href="./chapter.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<itemref idref="one"/><itemref idref="two"/>"#,
            chapter(),
        );
        assert_eq!(
            entries
                .iter()
                .map(|entry| (
                    entry.source.as_str(),
                    entry.reading_order_occurrence_indexes.as_slice()
                ))
                .collect::<Vec<_>>(),
            [("chapter.xhtml", &[0][..]), ("./chapter.xhtml", &[1][..])]
        );
    }
}
