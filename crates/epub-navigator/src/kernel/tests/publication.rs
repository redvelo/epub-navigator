use super::support::*;
use crate::facts::PublicationFacts;
use crate::kernel::*;
use epub_stack::{Epub, EpubPath, resource::provider::MemoryResourceProvider};
use serde_json::{Value, json};

fn snapshot(initialization: &str) -> KernelSnapshot {
    NavigatorKernel::create(initialization).unwrap().snapshot()
}
fn assert_invalid_facts(initialization: &str) {
    assert_eq!(
        NavigatorKernel::create(initialization).unwrap_err(),
        KernelError::InvalidFacts
    );
}
fn stack_epub(package: &str, resources: &[(&str, &[u8])]) -> Epub<MemoryResourceProvider> {
    let mut provider = MemoryResourceProvider::new();
    let package_path = EpubPath::new("EPUB/package.opf").unwrap();
    provider.insert(package_path.clone(), package.as_bytes().to_vec());
    for (path, bytes) in resources {
        provider.insert(EpubPath::new(path).unwrap(), bytes.to_vec());
    }
    Epub::from_provider(provider, package_path).unwrap()
}
fn stack_initialization(package: &str, resources: &[(&str, &[u8])]) -> Value {
    let epub = stack_epub(package, resources);
    let facts = PublicationFacts::of(&epub).unwrap();
    json!({ "facts": facts, "mount": mount() })
}
fn projected_facts(package: &str, resources: &[(&str, &[u8])]) -> Vec<ReadingOrderOccurrence> {
    let epub = stack_epub(package, resources);
    projected(&PublicationFacts::of(&epub).unwrap())
}
fn projected(facts: &PublicationFacts<'_>) -> Vec<ReadingOrderOccurrence> {
    let typed = project_reading_order(facts).unwrap();
    let serialized = serde_json::to_value(facts).unwrap();
    assert_eq!(
        typed,
        KernelPublication::from_facts(&serialized)
            .unwrap()
            .reading_order
    );
    for (index, occurrence) in typed.iter().enumerate() {
        assert_eq!(
            serde_json::to_value(&occurrence.presentation).unwrap(),
            serialized["resources"]["readingOrder"][index]["presentation"]
        );
    }
    typed
}
fn adapter(occurrence: &ReadingOrderOccurrence) -> DocumentAdapter {
    occurrence.document.loadable().unwrap().1
}
fn unavailable_reason(occurrence: &ReadingOrderOccurrence) -> Option<OccurrenceUnavailableReason> {
    match occurrence.document {
        OccurrenceDocumentTarget::Unavailable { reason, .. } => Some(reason),
        _ => None,
    }
}
fn fallback_facts(
    start_fallback: Option<&str>,
    after_fallback: Option<&str>,
    page_fallback: Option<&str>,
    start_media_type: &str,
    after_media_type: &str,
    page_id: &str,
) -> Value {
    let fallback = |value: Option<&str>| {
        value.map_or_else(String::new, |value| format!(r#" fallback="{value}""#))
    };
    let package = format!(
        r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest>
<item id="start" href="chapter.mp3" media-type="{start_media_type}"{}/>
<item id="after" href="afterword.xhtml" media-type="{after_media_type}"{}/>
<item id="missing" href="missing.xhtml" media-type="application/xhtml+xml"/>
<item id="remote" href="https://example.test/book.xhtml" media-type="application/xhtml+xml"/>
<item id="{page_id}" href="page.svg" media-type="image/svg+xml"{}/>
</manifest><spine><itemref idref="start"/><itemref idref="start" linear="no"/></spine></package>"#,
        fallback(start_fallback),
        fallback(after_fallback),
        fallback(page_fallback),
    );
    stack_initialization(
        &package,
        &[
            ("EPUB/chapter.mp3", b"audio"),
            ("EPUB/afterword.xhtml", b"<html/>"),
            ("EPUB/page.svg", b"<svg/>"),
        ],
    )
}
fn fallback(start: Option<&str>, after: Option<&str>) -> Value {
    fallback_facts(
        start,
        after,
        None,
        "audio/mpeg",
        "application/xhtml+xml",
        "page",
    )
}

#[test]
fn facts_select_adapters_and_retain_targets_availability_and_duplicate_identity() {
    let snapshot = snapshot(&initialization());
    let order = &snapshot.reading_order;
    assert_eq!(adapter(&order[0]), DocumentAdapter::ReflowableXhtml);
    assert_eq!(adapter(&order[1]), DocumentAdapter::FixedXhtml);
    assert_eq!(
        order[8].document.loadable(),
        Some(("EPUB/page.svg", DocumentAdapter::FixedSvg))
    );
    assert_eq!(
        order[0].document.loadable().unwrap().0,
        order[1].document.loadable().unwrap().0
    );
    assert_ne!(order[0].presentation, order[1].presentation);
    assert_eq!(
        (
            order[0].ordinal,
            order[0].linear,
            order[1].ordinal,
            order[1].linear
        ),
        (0, OccurrenceLinear::Yes, 1, OccurrenceLinear::No)
    );
    assert_eq!(order[2].target, ReadingOrderTarget::MissingIdref);
    assert_eq!(order[2].document, OccurrenceDocumentTarget::Unresolved);
    assert_eq!(
        unavailable_reason(&order[3]),
        Some(OccurrenceUnavailableReason::ResourceMissing)
    );
    assert_eq!(
        unavailable_reason(&order[4]),
        Some(OccurrenceUnavailableReason::NonLocal)
    );
    assert_eq!(order[6].target, ReadingOrderTarget::MissingManifestId);
    assert_eq!(
        order[7].target,
        ReadingOrderTarget::AmbiguousManifestId {
            candidates: vec![0, 1]
        }
    );
    assert_eq!(snapshot.publication_layout, PublicationLayout::Ordinary);
    assert_eq!(snapshot.document.pending, None);
    assert_eq!(snapshot.document.committed, None);
}
#[test]
fn malformed_or_unknown_target_states_reject_the_facts_snapshot() {
    let edits: [fn(&mut Value); 6] = [
        |value| {
            value["facts"]["resources"]["readingOrder"][2]["target"] =
                json!({ "state": "future-state" })
        },
        |value| {
            value["facts"]["resources"]["readingOrder"][0]["target"] =
                json!({ "state": "declaration", "declaration": 0 })
        },
        |value| {
            value["facts"]["resources"]["readingOrder"][2]["target"] =
                json!({ "state": "missing", "extra": true })
        },
        |value| value["facts"]["resources"]["declarations"][0]["target"]["extra"] = json!(true),
        |value| {
            value["facts"]["resources"]["readingOrder"][7]["target"] =
                json!({ "state": "ambiguous-manifest-id" })
        },
        |value| value["facts"]["resources"]["readingOrder"][7]["target"]["extra"] = json!(true),
    ];
    for edit in edits {
        assert_invalid_facts(&initialization_with(edit));
    }
}
#[test]
fn fixed_layout_first_recognized_itemref_override_retains_stack_evidence() {
    for (properties, adapter, page_spreads, first_side, second_side) in [
        (
            "rendition:layout-unknown rendition:layout-pre-paginated rendition:layout-reflowable",
            DocumentAdapter::FixedXhtml,
            "page-spread-left rendition:page-spread-right",
            OccurrencePageSpread::Left,
            OccurrencePageSpread::Right,
        ),
        (
            "rendition:layout-unknown rendition:layout-reflowable rendition:layout-pre-paginated",
            DocumentAdapter::ReflowableXhtml,
            "rendition:page-spread-right page-spread-left",
            OccurrencePageSpread::Right,
            OccurrencePageSpread::Left,
        ),
    ] {
        let package = format!(
            r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata>
<meta property="rendition:layout">pre-paginated</meta>
</metadata><manifest><item id="page" href="page.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="page" properties="{properties} rendition:spread-unknown rendition:spread-both rendition:spread-none rendition:flow-unknown rendition:flow-paginated rendition:flow-scrolled-doc page-spread-unknown rendition:page-spread-unknown {page_spreads}"/></spine></package>"#
        );
        let typed = projected_facts(&package, &[("EPUB/page.xhtml", b"<html/>")]);
        assert_eq!(typed[0].document.loadable().unwrap().1, adapter);
        let presentation = &typed[0].presentation;
        assert!(
            matches!(&presentation.layout, OccurrenceRenditionSetting::Ambiguous(candidates) if candidates.len() == 2 && candidates[0].value.is_some())
        );
        assert!(
            matches!(&presentation.spread, OccurrenceRenditionSetting::Ambiguous(candidates) if candidates.len() == 2 && candidates[0].value == Some(OccurrenceRenditionSpread::Both))
        );
        assert!(
            matches!(&presentation.flow, OccurrenceRenditionSetting::Ambiguous(candidates) if candidates.len() == 2 && candidates[0].value == Some(OccurrenceRenditionFlow::Paginated))
        );
        assert!(
            matches!(&presentation.page_spread, OccurrenceRenditionSetting::Ambiguous(candidates) if candidates.len() == 4 && candidates[2].value == Some(first_side) && candidates[3].value == Some(second_side))
        );
    }
}
#[test]
fn typed_and_json_reading_order_projections_are_equivalent() {
    let epub = stack_epub(
        r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata>
<meta property="rendition:flow">scrolled-doc</meta>
</metadata><manifest>
<item id="audio" href="chapter.mp3" media-type="audio/mpeg" fallback="chapter"/>
<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
<item id="page" href="page.svg" media-type="image/svg+xml"/>
</manifest><spine page-progression-direction="rtl">
<itemref idref="audio" properties="rendition:layout-pre-paginated page-spread-left"/>
<itemref idref="page" linear="no"/>
</spine></package>"#,
        &[
            ("EPUB/chapter.mp3", b"audio"),
            ("EPUB/chapter.xhtml", b"<html/>"),
            ("EPUB/page.svg", b"<svg/>"),
        ],
    );
    let facts = PublicationFacts::of(&epub).unwrap();
    projected(&facts);
}
#[test]
fn global_roll_overrides_all_itemref_layouts_without_rewriting_evidence() {
    let epub = stack_epub(
        r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata>
<meta property="rendition:layout">roll</meta>
</metadata><manifest>
<item id="page" href="page.xhtml" media-type="application/xhtml+xml"/>
<item id="svg" href="page.svg" media-type="image/svg+xml"/>
<item id="raster" href="page.png" media-type="image/png" fallback="page"/>
<item id="unsupported" href="other.jxl" media-type="image/jxl"/>
<item id="missing" href="missing.xhtml" media-type="application/xhtml+xml"/>
<item id="remote" href="https://example.test/page.xhtml" media-type="application/xhtml+xml"/>
</manifest><spine>
<itemref idref="page" properties="rendition:layout-reflowable"/>
<itemref idref="page" properties="rendition:layout-pre-paginated"/>
<itemref idref="page" properties="rendition:layout-unknown rendition:layout-reflowable rendition:layout-pre-paginated"/>
<itemref idref="page" properties="rendition:layout-unknown"/>
<itemref idref="svg" properties="rendition:layout-reflowable"/>
<itemref idref="raster" properties="rendition:layout-reflowable"/>
<itemref idref="unsupported" properties="rendition:layout-reflowable"/>
<itemref idref="missing" properties="rendition:layout-reflowable"/>
<itemref idref="remote" properties="rendition:layout-reflowable"/>
</spine></package>"#,
        &[
            ("EPUB/page.xhtml", b"<html/>"),
            ("EPUB/page.svg", b"<svg/>"),
            ("EPUB/page.png", b"raster"),
        ],
    );
    let facts = PublicationFacts::of(&epub).unwrap();
    let typed = projected(&facts);
    let snapshot = snapshot(&initialization_with(|value| {
        value["facts"] = serde_json::to_value(&facts).unwrap();
    }));
    assert_eq!(snapshot.publication_layout, PublicationLayout::Roll);
    assert_eq!(
        serde_json::to_value(&snapshot).unwrap()["publicationLayout"],
        "roll"
    );
    assert_eq!(typed, snapshot.reading_order);
    for occurrence in &typed[..4] {
        assert_eq!(adapter(occurrence), DocumentAdapter::FixedXhtml);
    }
    assert_eq!(adapter(&typed[4]), DocumentAdapter::FixedSvg);
    assert_eq!(typed[5].selected_declaration, Some(2));
    assert_eq!(
        typed[5].document.loadable(),
        Some(("EPUB/page.png", DocumentAdapter::FixedImage))
    );
    for (index, expected_adapter, reason) in [
        (
            6,
            None,
            OccurrenceUnavailableReason::ManifestFallbackExhausted,
        ),
        (
            7,
            Some(DocumentAdapter::FixedXhtml),
            OccurrenceUnavailableReason::ResourceMissing,
        ),
        (
            8,
            Some(DocumentAdapter::FixedXhtml),
            OccurrenceUnavailableReason::NonLocal,
        ),
    ] {
        assert!(matches!(typed[index].document,
            OccurrenceDocumentTarget::Unavailable { adapter, reason: actual, .. }
                if adapter == expected_adapter && actual == reason));
    }
}
#[test]
fn native_raster_mimes_win_over_text_fallback_only_on_a_fixed_page() {
    for mime in [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "image/jxl",
        "image/tiff",
    ] {
        for layout in ["roll", "pre-paginated", "reflowable"] {
            let package = format!(
                r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><meta property="rendition:layout">{layout}</meta></metadata><manifest><item id="image" href="image" media-type="{mime}" fallback="text"/><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="image"/></spine></package>"#
            );
            let projected = projected_facts(
                &package,
                &[("EPUB/image", b"raw"), ("EPUB/text.xhtml", b"<html/>")],
            );
            // An image cannot reflow, so it stands as the document only where the occurrence is a
            // page of its own; a reflowing occurrence walks the chain to text that can.
            let image = layout != "reflowable" && !["image/jxl", "image/tiff"].contains(&mime);
            assert_eq!(
                projected[0].selected_declaration,
                Some(if image { 0 } else { 1 }),
                "{layout} {mime}"
            );
            assert_eq!(adapter(&projected[0]) == DocumentAdapter::FixedImage, image);
        }
    }
}
#[test]
fn global_roll_requires_one_unambiguous_unrefined_package_declaration() {
    use OccurrenceUnavailableReason::{AmbiguousRendition, UnsupportedRendition};
    use PublicationLayout::{Ordinary, Roll};
    for (metadata, expected, unavailable) in [
        ("", Ordinary, None),
        (
            r#"<meta property="rendition:layout">reflowable</meta>"#,
            Ordinary,
            None,
        ),
        (
            r#"<meta property="rendition:layout">unknown</meta>"#,
            Ordinary,
            Some(UnsupportedRendition),
        ),
        (
            r#"<meta property="rendition:layout"/>"#,
            Ordinary,
            Some(UnsupportedRendition),
        ),
        (
            r##"<meta property="rendition:layout" refines="#page">roll</meta>"##,
            Ordinary,
            None,
        ),
        (
            r#"<meta property="custom:layout">roll</meta>"#,
            Ordinary,
            None,
        ),
        (
            r#"<meta property="rendition:layout">roll</meta>"#,
            Roll,
            None,
        ),
        (
            r#"<meta property="RENDITION:LAYOUT"> RoLl </meta>"#,
            Roll,
            None,
        ),
        (
            r##"<meta property="rendition:layout">roll</meta><meta property="rendition:layout" refines="#page">unknown</meta>"##,
            Roll,
            None,
        ),
        (
            r#"<meta property="rendition:layout">roll</meta><meta property="rendition:layout">reflowable</meta>"#,
            Ordinary,
            Some(AmbiguousRendition),
        ),
        (
            r#"<meta property="rendition:layout">unknown</meta><meta property="rendition:layout">roll</meta>"#,
            Ordinary,
            Some(AmbiguousRendition),
        ),
        (
            r#"<meta property="rendition:layout">roll</meta><meta property="rendition:layout">unknown</meta>"#,
            Ordinary,
            Some(AmbiguousRendition),
        ),
        (
            r#"<meta property="rendition:layout">roll</meta><meta property="rendition:layout">roll</meta>"#,
            Ordinary,
            Some(AmbiguousRendition),
        ),
        (
            r#"<meta property="rendition:layout"/><meta property="rendition:layout">roll</meta>"#,
            Ordinary,
            Some(AmbiguousRendition),
        ),
    ] {
        let package = format!(
            r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata>{metadata}</metadata>
<manifest><item id="page" href="page.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="page"/><itemref idref="page" properties="rendition:layout-reflowable"/></spine></package>"#
        );
        let epub = stack_epub(&package, &[("EPUB/page.xhtml", b"<html/>")]);
        let facts = PublicationFacts::of(&epub).unwrap();
        let typed = projected(&facts);
        let catalog =
            KernelPublication::from_facts(&serde_json::to_value(&facts).unwrap()).unwrap();
        assert_eq!(catalog.publication_layout, expected, "{metadata}");
        let expected_adapter = if expected == Roll {
            DocumentAdapter::FixedXhtml
        } else {
            DocumentAdapter::ReflowableXhtml
        };
        assert_eq!(adapter(&typed[1]), expected_adapter, "{metadata}");
        match unavailable {
            Some(reason) => assert_eq!(unavailable_reason(&typed[0]), Some(reason), "{metadata}"),
            None => assert_eq!(adapter(&typed[0]), expected_adapter, "{metadata}"),
        }
    }
}
#[test]
fn stale_json_snapshot_still_rejects_before_projection() {
    let mut value = fallback(Some("page"), None);
    value["facts"]["resources"]["declarations"][0]["fallback"] = json!("after");
    assert_invalid_facts(&value.to_string());
}
#[test]
fn conflicting_document_formats_for_one_resource_are_rejected() {
    let mut value: Value = serde_json::from_str(&initialization()).unwrap();
    value["facts"]["resources"]["declarations"][1]["mediaType"] = json!("image/svg+xml");
    value["facts"]["resources"]["declarations"][1]["href"] = json!("chapter.xhtml?format=svg");
    value["facts"]["resources"]["declarations"][1]["target"]["resource"] = json!(0);
    for occurrence in [5, 9] {
        value["facts"]["resources"]["readingOrder"][occurrence]["resource"] = json!(0);
    }
    value["facts"]["resources"]["resources"][0]["declarations"] = json!([0, 1]);
    value["facts"]["resources"]["resources"][0]["hasSvgDeclaration"] = json!(true);
    value["facts"]["resources"]["resources"][1]["declarations"] = json!([]);
    assert_invalid_facts(&value.to_string());

    value["facts"]["resources"]["declarations"][1]["mediaType"] = json!("audio/mpeg");
    assert!(matches!(
        snapshot(&value.to_string()).reading_order[5].document,
        OccurrenceDocumentTarget::Unavailable {
            adapter: None,
            reason: OccurrenceUnavailableReason::ManifestFallbackExhausted,
            ..
        }
    ));
}
#[test]
fn effective_fallback_formats_conflict_but_xhtml_renditions_do_not() {
    let package = |second_type: &str, second_layout: &str| {
        format!(
            r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest>
<item id="first" href="first.bin" media-type="application/octet-stream" fallback="one"/>
<item id="second" href="second.bin" media-type="application/octet-stream" fallback="two"/>
<item id="one" href="shared" media-type="application/xhtml+xml"/>
<item id="two" href="./shared" media-type="{second_type}"/>
</manifest><spine><itemref idref="first"/><itemref idref="second"{second_layout}/></spine></package>"#
        )
    };
    let resources: &[(&str, &[u8])] = &[
        ("EPUB/first.bin", b"first"),
        ("EPUB/second.bin", b"second"),
        ("EPUB/shared", b"shared"),
    ];
    assert_invalid_facts(
        &stack_initialization(&package("image/svg+xml", ""), resources).to_string(),
    );

    let compatible = snapshot(
        &stack_initialization(
            &package(
                "application/xhtml+xml",
                r#" properties="rendition:layout-pre-paginated""#,
            ),
            resources,
        )
        .to_string(),
    );
    assert_eq!(
        adapter(&compatible.reading_order[0]),
        DocumentAdapter::ReflowableXhtml
    );
    assert_eq!(
        adapter(&compatible.reading_order[1]),
        DocumentAdapter::FixedXhtml
    );
}
#[test]
fn contradictory_topology_and_cardinalities_are_rejected() {
    let edits: [fn(&mut Value); 8] = [
        |value| value["facts"]["resources"]["declarations"][0]["target"]["resource"] = json!(1),
        |value| value["facts"]["resources"]["resources"][0]["declarations"] = json!([1]),
        |value| value["facts"]["resources"]["resources"][0]["declarations"] = json!([]),
        |value| {
            value["facts"]["resources"]["declarations"][0]["target"] =
                json!({ "state": "missing-href" })
        },
        |value| value["facts"]["resources"]["readingOrder"][7]["idref"] = json!("page"),
        |value| {
            value["facts"]["resources"]["readingOrder"][0]["presentation"]["layout"] =
                json!({ "state": "ambiguous", "value": [] })
        },
        |value| {
            value["facts"]["resources"]["readingOrder"][0]["presentation"]["layout"] = json!({
                "state": "ambiguous",
                "value": [{ "source": "package-metadata", "authoredValue": "reflowable", "value": "reflowable" }]
            })
        },
        |value| {
            value["facts"]["resources"]["readingOrder"][0]["presentation"]["layout"] = json!({
                "state": "specified",
                "value": [
                    { "source": "package-metadata", "authoredValue": "reflowable", "value": "reflowable" },
                    { "source": "package-metadata", "authoredValue": "pre-paginated", "value": "pre-paginated" }
                ]
            })
        },
    ];
    for edit in edits {
        assert_invalid_facts(&initialization_with(edit));
    }
}
#[test]
fn unresolved_declaration_preserves_manifest_target_distinctions() {
    for state in ["missing-href", "invalid-href"] {
        let snapshot = snapshot(&initialization_with(|value| {
            let index = &mut value["facts"]["resources"];
            index["declarations"][0]["target"] = json!({ "state": state });
            index["resources"][0]["declarations"] = json!([]);
            for occurrence in [0, 1] {
                index["readingOrder"][occurrence]["resource"] = Value::Null;
            }
        }));
        assert_eq!(
            snapshot.reading_order[0].target,
            ReadingOrderTarget::Declaration {
                declaration: 0,
                resource: None,
            }
        );
    }
}
#[test]
fn empty_data_resource_address_is_retained_as_non_local_evidence() {
    let snapshot = snapshot(&initialization_with(|value| {
        value["facts"]["resources"]["resources"][3]["address"] =
            json!({ "kind": "data", "value": "" });
    }));
    assert_eq!(
        unavailable_reason(&snapshot.reading_order[4]),
        Some(OccurrenceUnavailableReason::NonLocal)
    );
}
#[test]
fn fallback_selects_the_first_supported_declaration_in_authored_order() {
    for (facts, declaration, expected_adapter) in [
        (
            fallback_facts(
                Some("page"),
                None,
                Some("after"),
                "audio/mpeg",
                "application/xhtml+xml",
                "page",
            ),
            4,
            DocumentAdapter::FixedSvg,
        ),
        (
            fallback(Some("after"), Some("page")),
            1,
            DocumentAdapter::ReflowableXhtml,
        ),
        (
            fallback_facts(
                Some("after"),
                Some("start"),
                None,
                "audio/mpeg",
                "application/xhtml+xml",
                "page",
            ),
            1,
            DocumentAdapter::ReflowableXhtml,
        ),
    ] {
        let snapshot = snapshot(&facts.to_string());
        assert_eq!(
            snapshot.reading_order[0].selected_declaration,
            Some(declaration)
        );
        assert_eq!(adapter(&snapshot.reading_order[0]), expected_adapter);
    }
}
#[test]
fn unsupported_fallback_terminals_are_precise() {
    use OccurrenceUnavailableReason::{
        ManifestFallbackCycle, ManifestFallbackExhausted, ManifestFallbackUnresolved,
    };
    for (facts, reason) in [
        (fallback(None, None), ManifestFallbackExhausted),
        (fallback(Some("1bad"), None), ManifestFallbackUnresolved),
        (fallback(Some("unknown"), None), ManifestFallbackUnresolved),
        (
            fallback_facts(
                Some("after"),
                None,
                None,
                "audio/mpeg",
                "application/xhtml+xml",
                "after",
            ),
            ManifestFallbackUnresolved,
        ),
        (
            fallback_facts(
                Some("after"),
                Some("start"),
                None,
                "audio/mpeg",
                "audio/ogg",
                "page",
            ),
            ManifestFallbackCycle,
        ),
    ] {
        let snapshot = snapshot(&facts.to_string());
        assert_eq!(unavailable_reason(&snapshot.reading_order[0]), Some(reason));
        if reason != ManifestFallbackCycle {
            assert_eq!(snapshot.reading_order[0].selected_declaration, None);
        }
    }
}
#[test]
fn supported_missing_or_nonlocal_candidate_stops_without_following_fallback() {
    for state in ["missing-href", "invalid-href"] {
        let mut unresolved = fallback_facts(
            Some("page"),
            None,
            None,
            "application/xhtml+xml",
            "application/xhtml+xml",
            "page",
        );
        let index = &mut unresolved["facts"]["resources"];
        index["declarations"][0]["href"] = match state {
            "missing-href" => Value::Null,
            _ => json!("bad href"),
        };
        let resource = index["declarations"][0]["target"]["resource"]
            .as_u64()
            .unwrap() as usize;
        index["declarations"][0]["target"] = json!({ "state": state });
        index["resources"][resource]["declarations"] = json!([]);
        index["readingOrder"][0]["resource"] = Value::Null;
        index["readingOrder"][1]["resource"] = Value::Null;
        let snapshot = snapshot(&unresolved.to_string());
        assert_eq!(snapshot.reading_order[0].selected_declaration, Some(0));
        assert_eq!(
            snapshot.reading_order[0].document,
            OccurrenceDocumentTarget::Unresolved
        );
    }

    let mut rendition = fallback(Some("after"), Some("page"));
    rendition["facts"]["resources"]["readingOrder"][0]["presentation"]["layout"] = json!({
        "state": "specified",
        "value": {
            "source": "item-ref-property",
            "authoredValue": "rendition:layout-future",
            "value": null
        }
    });
    for (facts, declaration, reason) in [
        (
            fallback(Some("missing"), None),
            2,
            OccurrenceUnavailableReason::ResourceMissing,
        ),
        (
            fallback(Some("remote"), None),
            3,
            OccurrenceUnavailableReason::NonLocal,
        ),
        (
            rendition,
            1,
            OccurrenceUnavailableReason::UnsupportedRendition,
        ),
    ] {
        let snapshot = snapshot(&facts.to_string());
        assert_eq!(
            snapshot.reading_order[0].selected_declaration,
            Some(declaration)
        );
        assert_eq!(unavailable_reason(&snapshot.reading_order[0]), Some(reason));
    }
}
#[test]
fn fallback_preserves_authored_target_linear_duplicates_and_annotation_source() {
    let value = fallback(Some("page"), None);
    let snapshot = snapshot(&value.to_string());
    for occurrence in &snapshot.reading_order[..2] {
        assert_eq!(
            occurrence.target,
            ReadingOrderTarget::Declaration {
                declaration: 0,
                resource: Some(1)
            }
        );
        assert_eq!(occurrence.selected_declaration, Some(4));
        assert_eq!(occurrence.document.loadable().unwrap().0, "EPUB/page.svg");
    }
    assert_eq!(snapshot.reading_order[1].linear, OccurrenceLinear::No);
    assert_eq!(
        KernelPublication::from_facts(&value["facts"])
            .unwrap()
            .annotation_source_for_occurrence(0, "EPUB/page.svg")
            .unwrap(),
        "page.svg"
    );
}
#[test]
fn malformed_fallback_topology_is_invalid_facts() {
    let declarations = |edit: fn(&mut Value)| {
        let mut value = fallback(Some("page"), None);
        edit(&mut value["facts"]["resources"]["declarations"]);
        value.to_string()
    };
    for replacement in [
        json!({ "state": "declaration", "value": 99 }),
        json!({ "state": "declaration", "value": 1 }),
        Value::Null,
        json!({ "state": "invalid" }),
        json!({ "state": "missing" }),
    ] {
        let mut value = fallback(Some("page"), None);
        value["facts"]["resources"]["declarations"][0]["fallbackTarget"] = replacement;
        assert_invalid_facts(&value.to_string());
    }
    assert_invalid_facts(&declarations(|declarations| *declarations = json!([])));
    assert_invalid_facts(&declarations(|declarations| {
        declarations[1]["fallbackTarget"] = json!({ "state": "declaration", "value": 99 })
    }));

    let mut start = fallback(None, None);
    start["facts"]["resources"]["readingOrder"][0]["target"]["value"] = json!(99);
    assert_invalid_facts(&start.to_string());
}
#[test]
fn distinct_fallback_starts_share_one_large_chain_projection() {
    const DECLARATIONS: usize = 12_000;
    let last = DECLARATIONS - 1;
    let declarations = (0..DECLARATIONS)
        .map(|index| {
            json!({
                "id": { "state": "valid", "value": format!("d{index}") },
                "href": null,
                "mediaType": if index == last { "application/xhtml+xml" } else { "application/octet-stream" },
                "target": { "state": "missing-href" },
                "fallback": (index < last).then(|| format!("d{}", index + 1)),
                "fallbackTarget": (index < last)
                    .then(|| json!({ "state": "declaration", "value": index + 1 })),
            })
        })
        .collect::<Vec<_>>();
    let reading_order = (0..DECLARATIONS)
        .map(|index| {
            json!({
                "idref": format!("d{index}"),
                "target": { "state": "declaration", "value": index },
                "resource": null,
                "linear": "yes",
                "presentation": presentation("unspecified"),
            })
        })
        .collect::<Vec<_>>();
    let value = json!({
        "facts": {
            "package": {},
            "resources": {
                "packagePath": "EPUB/package.opf",
                "resources": [{
                    "address": { "kind": "local", "value": "EPUB/package.opf" },
                    "presence": { "state": "present", "sizeBytes": "1" },
                    "declarations": [],
                    "hasXhtmlDeclaration": false,
                    "hasStylesheetDeclaration": false,
                    "hasSvgDeclaration": false,
                    "scripted": false
                }],
                "declarations": declarations,
                "readingOrder": reading_order
            }
        },
        "mount": mount()
    });

    let snapshot = snapshot(&value.to_string());
    assert_eq!(snapshot.reading_order.len(), DECLARATIONS);
    assert!(
        snapshot
            .reading_order
            .iter()
            .all(|occurrence| occurrence.selected_declaration == Some(last as u32))
    );
}
