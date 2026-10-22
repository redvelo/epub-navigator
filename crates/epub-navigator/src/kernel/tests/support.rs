use crate::kernel::*;
use serde_json::{Value, json};

pub(super) fn primary(document_generation: u32) -> ActiveDocumentParticipant {
    ActiveDocumentParticipant::Primary {
        document_generation,
    }
}
pub(super) fn presentation(layout: &str) -> Value {
    let layout = if layout == "unspecified" {
        json!({ "state": "unspecified" })
    } else {
        json!({
            "state": "specified",
            "value": {
                "source": "item-ref-property",
                "authoredValue": format!("rendition:layout-{layout}"),
                "value": layout
            }
        })
    };
    json!({
        "layout": layout,
        "flow": { "state": "unspecified" },
        "orientation": { "state": "unspecified" },
        "spread": { "state": "unspecified" },
        "pageSpread": { "state": "unspecified" },
        "pageProgressionDirection": null,
        "alignXCenter": false
    })
}
pub(super) fn mount() -> Value {
    json!({
        "baseUrl": "https://reader.example/publications/book/",
        "remoteResources": "blocked",
        "contentOrigin": "shared-reader-origin"
    })
}
fn declaration(id: &str, href: &str, media_type: &str, resource: u32) -> Value {
    json!({
        "id": { "state": "valid", "value": id },
        "href": href,
        "mediaType": media_type,
        "target": { "state": "resource", "resource": resource },
        "fallback": null,
        "fallbackTarget": null
    })
}
fn occurrence(idref: Option<&str>, declaration: Option<u32>, linear: &str, layout: &str) -> Value {
    json!({
        "idref": idref,
        "target": declaration.map(|value| json!({ "state": "declaration", "value": value })),
        "resource": declaration,
        "linear": linear,
        "presentation": presentation(layout)
    })
}
pub(super) fn initialization() -> String {
    json!({
            "facts": {
                "package": {},
                "resources": {
                    "packagePath": "EPUB/package.opf",
                    "resources": [
                        {
                            "address": { "kind": "local", "value": "EPUB/chapter.xhtml" },
                            "presence": { "state": "present", "sizeBytes": "1" },
                            "hasXhtmlDeclaration": true,
                            "hasStylesheetDeclaration": false,
                            "hasSvgDeclaration": false,
                            "scripted": false, "declarations": [0]
                        },
                        {
                            "address": { "kind": "local", "value": "EPUB/afterword.xhtml" },
                            "presence": { "state": "present", "sizeBytes": "1" },
                            "hasXhtmlDeclaration": true,
                            "hasStylesheetDeclaration": false,
                            "hasSvgDeclaration": false,
                            "scripted": false, "declarations": [1]
                        },
                        {
                            "address": { "kind": "local", "value": "EPUB/missing.xhtml" },
                            "presence": { "state": "missing" }, "hasXhtmlDeclaration": true,
                            "hasStylesheetDeclaration": false,
                            "hasSvgDeclaration": false,
                            "scripted": false, "declarations": [2]
                        },
                        {
                            "address": { "kind": "remote", "value": "https://example.test/book.xhtml" },
                            "presence": { "state": "not-applicable" }, "hasXhtmlDeclaration": true,
                            "hasStylesheetDeclaration": false,
                            "hasSvgDeclaration": false,
                            "scripted": false, "declarations": [3]
                        },
                        {
                            "address": { "kind": "local", "value": "EPUB/page.svg" },
                            "presence": { "state": "present", "sizeBytes": "1" },
                            "hasXhtmlDeclaration": false,
                            "hasStylesheetDeclaration": false,
                            "hasSvgDeclaration": true,
                            "scripted": false, "declarations": [4]
                        },
                        {
                            "address": { "kind": "local", "value": "EPUB/package.opf" },
                            "presence": { "state": "present", "sizeBytes": "1" },
                            "hasXhtmlDeclaration": false,
                            "hasStylesheetDeclaration": false,
                            "hasSvgDeclaration": false,
                            "scripted": false, "declarations": []
                        }
                    ],
                    "declarations": [
                        declaration("duplicate", "chapter.xhtml", "application/xhtml+xml", 0),
                        declaration("duplicate", "afterword.xhtml", "application/xhtml+xml", 1),
                        declaration("missing", "missing.xhtml", "application/xhtml+xml", 2),
                        declaration("remote", "https://example.test/book.xhtml", "Application/XHTML+XML; Profile=Authored", 3),
                        declaration("page", "page.svg", "image/svg+xml", 4)
                    ],
                    "readingOrder": [
                        occurrence(Some("duplicate"), Some(0), "yes", "reflowable"),
                        occurrence(Some("duplicate"), Some(0), "no", "pre-paginated"),
                        occurrence(None, None, "yes", "unspecified"),
                        occurrence(Some("missing"), Some(2), "yes", "unspecified"),
                        occurrence(Some("remote"), Some(3), "yes", "unspecified"),
                        occurrence(Some("duplicate"), Some(1), "yes", "unspecified"),
                        json!({
                            "idref": "absent", "target": { "state": "missing" },
                            "resource": null, "linear": "yes",
                            "presentation": presentation("unspecified")
                        }),
                        json!({
                            "idref": "duplicate", "target": { "state": "ambiguous" },
                            "resource": null, "linear": "yes",
                            "presentation": presentation("unspecified")
                        }),
                        occurrence(Some("page"), Some(4), "yes", "pre-paginated"),
                        occurrence(Some("duplicate"), Some(1), "yes", "unspecified")
                    ]
                }
            },
            "mount": mount()
        })
        .to_string()
}
pub(super) fn initialization_with(edit: impl FnOnce(&mut Value)) -> String {
    let mut value: Value = serde_json::from_str(&initialization()).unwrap();
    edit(&mut value);
    value.to_string()
}
fn reading_order(value: &mut Value) -> &mut Value {
    &mut value["facts"]["resources"]["readingOrder"]
}
/// Points an occurrence at a declaration, keeping the serialized resource join coherent.
fn point_at(occurrence: &mut Value, declaration: u32) {
    occurrence["target"] = json!({ "state": "declaration", "value": declaration });
    occurrence["resource"] = json!(declaration);
}
pub(super) fn initialization_with_three_loadable_occurrences() -> String {
    initialization_with(|value| point_at(&mut reading_order(value)[2], 1))
}
pub(super) fn initialization_with_fixed_pair() -> String {
    initialization_with(|value| {
        reading_order(value)[0]["presentation"] = presentation("pre-paginated");
    })
}
pub(super) fn initialization_with_fixed_triplet() -> String {
    initialization_with(|value| {
        let occurrences = reading_order(value);
        occurrences[0]["presentation"] = presentation("pre-paginated");
        point_at(&mut occurrences[2], 1);
        occurrences[2]["presentation"] = presentation("pre-paginated");
    })
}
pub(super) fn initialization_with_fixed_adapters(primary_svg: bool, companion_svg: bool) -> String {
    initialization_with(|value| {
        let occurrences = reading_order(value);
        occurrences[0]["presentation"] = presentation("pre-paginated");
        for (occurrence, svg) in [(0, primary_svg), (1, companion_svg)] {
            if svg {
                point_at(&mut occurrences[occurrence], 4);
            }
        }
    })
}
pub(super) fn opened(initialization: &str, occurrence: u32) -> NavigatorKernel {
    let mut kernel = NavigatorKernel::create(initialization).unwrap();
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence });
    commit(&mut kernel, 1);
    kernel
}
pub(super) fn opened_with(supported_operations: Vec<AgentOperationKind>) -> NavigatorKernel {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 0 });
    commit_with_operations(&mut kernel, 1, supported_operations);
    kernel
}
pub(super) fn load(kernel: &mut NavigatorKernel, generation: u32) -> KernelTransition {
    kernel.dispatch(FrameObservation::Loaded { generation });
    kernel.dispatch(AdapterObservation::Ready {
        generation,
        supported_operations: vec![],
    })
}
pub(super) fn locator(occurrence: u32, resource: &str) -> NavigatorLocation {
    NavigatorLocation::Point {
        occurrence,
        resource: resource.to_string(),
        evidence: vec![PointEvidence::DocumentBoundary {
            boundary: DocumentBoundary::Start,
        }],
        observation: LocatorObservation {
            layout_progression: Some(0.0),
            rendered_text_progression: None,
        },
    }
}
pub(super) fn selection_range(occurrence: u32, resource: &str) -> NavigatorLocation {
    NavigatorLocation::Range {
        occurrence,
        resource: resource.to_string(),
        evidence: vec![
            RangeEvidence::BrowserTextPosition {
                start: "3".to_string(),
                end: "8".to_string(),
            },
            RangeEvidence::RenderedTextQuote {
                exact: "hello".to_string(),
                prefix: "say ".to_string(),
                suffix: " world".to_string(),
            },
        ],
        start_observation: LocatorObservation {
            layout_progression: Some(0.25),
            rendered_text_progression: Some(0.1),
        },
        end_observation: LocatorObservation {
            layout_progression: Some(0.3),
            rendered_text_progression: Some(0.2),
        },
    }
}
pub(super) fn capture_basis(
    kernel: &NavigatorKernel,
    participant: ActiveDocumentParticipant,
) -> SelectionCaptureBasis {
    let (_, frame_generation, layout_generation, _, _) =
        kernel.selection_capture_context(participant).unwrap();
    SelectionCaptureBasis {
        participant,
        frame_generation,
        layout_generation,
        local_content_basis: 12,
        local_geometry_basis: 7,
    }
}
pub(super) fn captured_selection(
    kernel: &NavigatorKernel,
    participant: ActiveDocumentParticipant,
) -> NativeSelectionCaptureOutcome {
    let (_, _, _, occurrence, resource) = kernel.selection_capture_context(participant).unwrap();
    NativeSelectionCaptureOutcome::Captured {
        location: selection_range(occurrence, resource),
        direction: NativeSelectionDirection::Backward,
        language: None,
        gesture: None,
        anchor: ReaderViewportAnchor {
            rect: ReaderViewportRect {
                x: 10.0,
                y: 20.0,
                width: 30.0,
                height: 12.0,
            },
            clipping_rect: ReaderViewportRect {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            },
        },
        basis: capture_basis(kernel, participant),
    }
}
pub(super) fn agent_request(transition: &KernelTransition) -> (u32, u32) {
    match transition.effects.as_slice() {
        [
            KernelEffect::AgentRequest {
                operation,
                generation,
                ..
            },
        ] => (*operation, *generation),
        effects => panic!("unexpected agent request effects: {effects:?}"),
    }
}
pub(super) fn request_annotation_generation(
    kernel: &mut NavigatorKernel,
    location: NavigatorLocation,
    text_fragment_policy: AnnotationTextFragmentPolicy,
) -> (u32, u32) {
    let transition = kernel.dispatch(NavigatorCommand::GenerateAnnotationTarget {
        participant: primary(1),
        location: location.clone(),
        local_content_basis: 12,
        text_fragment_policy,
    });
    assert!(
        matches!(
            transition.effects.as_slice(),
            [KernelEffect::AgentRequest {
                request: AgentRequest::GenerateAnnotationTarget {
                    location: requested,
                    local_content_basis: 12,
                    text_fragment_policy: policy,
                },
                ..
            }] if *requested == location && *policy == text_fragment_policy
        ),
        "{transition:?}"
    );
    agent_request(&transition)
}
pub(super) fn generated_candidate(
    text_fragment_policy: AnnotationTextFragmentPolicy,
) -> AgentResult {
    AgentResult::GenerateAnnotationTarget {
        candidate: AnnotationTargetGenerationCandidate {
            local_content_basis: 12,
            text_fragment_policy,
            status: AnnotationTargetGenerationCandidateStatus::Generated {
                selectors: AnnotationSelectorCandidate {
                    css: Some(AnnotationCssRangeCandidate {
                        value: "main > p:nth-child(2)".to_string(),
                        start: "1".to_string(),
                        end: "6".to_string(),
                    }),
                    document: Some(AnnotationDocumentRangeCandidate {
                        start: "21".to_string(),
                        end: "26".to_string(),
                    }),
                    text_fragment: Some("text=hello".to_string()),
                },
            },
        },
    }
}
pub(super) fn agent_result(
    kernel: &mut NavigatorKernel,
    operation: u32,
    result: AgentResult,
) -> KernelTransition {
    kernel.dispatch(AdapterObservation::AgentResult {
        participant: primary(1),
        operation,
        generation: 1,
        result,
    })
}
pub(super) fn is_delivery_failure(transition: &KernelTransition) -> bool {
    matches!(
        transition.events.as_slice(),
        [KernelEvent::AgentOperationFailed {
            failure: AgentOperationFailure::OperationDeliveryFailed { .. },
            ..
        }]
    )
}
pub(super) fn document_observation() -> DocumentObservation {
    DocumentObservation {
        writing_mode: DocumentWritingMode::HorizontalTb,
        direction: DocumentDirection::Ltr,
        language: Some("en".to_string()),
        viewport: DocumentViewport {
            width: 800.0,
            height: 600.0,
        },
        canvas: DocumentCanvas::SolidColor {
            css_color: "rgb(255, 255, 255)".to_string(),
        },
        visible_start: ObservedBoundary::Located {
            evidence: vec![PointEvidence::DocumentBoundary {
                boundary: DocumentBoundary::Start,
            }],
        },
        visible_end: ObservedBoundary::Located {
            evidence: vec![PointEvidence::DocumentBoundary {
                boundary: DocumentBoundary::End,
            }],
        },
        rendered_text_progression: Some(0.25),
        pagination: None,
    }
}
pub(super) fn observe(
    kernel: &mut NavigatorKernel,
    observation: DocumentObservation,
) -> KernelTransition {
    kernel.dispatch(AdapterObservation::DocumentObserved {
        participant: primary(1),
        generation: 1,
        observation,
    })
}
pub(super) fn commit(kernel: &mut NavigatorKernel, generation: u32) {
    commit_with_operations(
        kernel,
        generation,
        vec![
            AgentOperationKind::ResolveLocator,
            AgentOperationKind::Relocate,
        ],
    );
}
pub(super) fn commit_with_operations(
    kernel: &mut NavigatorKernel,
    generation: u32,
    supported_operations: Vec<AgentOperationKind>,
) {
    assert!(
        kernel
            .dispatch(FrameObservation::Loaded { generation })
            .accepted
    );
    assert!(
        kernel
            .dispatch(AdapterObservation::Ready {
                generation,
                supported_operations,
            })
            .accepted
    );
    settle_pending_layout(kernel, generation);
}
pub(super) fn decoration(id: &str, occurrence: u32, source: &str) -> DecorationRecord {
    DecorationRecord {
        id: id.to_string(),
        target_json: json!({ "source": source }).to_string(),
        occurrence,
        appearance: DecorationAppearance::AnnotationHighlight,
    }
}
pub(super) fn set_decorations(
    kernel: &mut NavigatorKernel,
    revision: u32,
    records: Vec<DecorationRecord>,
) -> KernelTransition {
    kernel.dispatch(NavigatorCommand::SetDecorationProjection {
        projection: DecorationProjection { revision, records },
    })
}
pub(super) fn invalidate_primary(
    kernel: &mut NavigatorKernel,
    cause: LayoutInvalidationCause,
) -> KernelTransition {
    kernel.dispatch(AdapterObservation::LayoutInvalidated {
        participant: Some(primary(1)),
        generation: 1,
        cause,
    })
}
pub(super) fn report_layout(
    kernel: &mut NavigatorKernel,
    generation: u32,
    result: impl FnOnce(AdapterLayoutPlan) -> LayoutResult,
) -> KernelTransition {
    let pending = kernel.snapshot().layout.pending.unwrap();
    kernel.dispatch(AdapterObservation::LayoutResult {
        participant: pending.participant(),
        operation: pending.operation,
        generation,
        layout_generation: pending.layout_generation,
        result: result(pending.adapter.plan()),
    })
}
pub(super) fn settled_result(plan: AdapterLayoutPlan) -> LayoutResult {
    layout_result(plan, settled_layout(plan))
}
pub(super) fn settle_pending_layout(
    kernel: &mut NavigatorKernel,
    generation: u32,
) -> KernelTransition {
    let transition = report_layout(kernel, generation, settled_result);
    assert!(transition.accepted, "{transition:?}");
    transition
}
pub(super) fn layout_timeout(kernel: &mut NavigatorKernel, generation: u32) -> KernelTransition {
    let pending = kernel.snapshot().layout.pending.unwrap();
    kernel.dispatch(AdapterObservation::LayoutTimeout {
        participant: pending.participant(),
        operation: pending.operation,
        generation,
        layout_generation: pending.layout_generation,
    })
}
pub(super) fn prepare(kernel: &mut NavigatorKernel, occurrence: u32) -> u32 {
    let transition = kernel.dispatch(NavigatorCommand::PrepareOccurrence { occurrence });
    assert!(transition.accepted);
    assert!(transition.events.is_empty());
    let generation = match transition.effects.as_slice() {
        [KernelEffect::CreatePreparedFrame { generation, .. }] => *generation,
        effects => panic!("unexpected preparation effects: {effects:?}"),
    };
    assert!(load(kernel, generation).events.is_empty());
    assert_eq!(
        kernel.snapshot().layout.pending.unwrap().owner,
        LayoutOwner::PreparedFrame
    );
    let settled = settle_pending_layout(kernel, generation);
    assert!(settled.events.is_empty());
    assert!(settled.effects.is_empty());
    generation
}
pub(super) fn attach_fixed_companion(
    initialization: &str,
    occurrence: u32,
) -> (NavigatorKernel, ActiveDocumentParticipant) {
    let mut kernel = opened(initialization, occurrence);
    let frame_generation = prepare(&mut kernel, occurrence + 1);
    assert!(
        kernel
            .dispatch(NavigatorCommand::AttachFixedCompanion {
                owner_document_generation: 1,
                frame_generation,
                placement: FixedSpreadPlacement::Right,
            })
            .accepted
    );
    (
        kernel,
        ActiveDocumentParticipant::FixedCompanion {
            owner_document_generation: 1,
            frame_generation,
        },
    )
}
pub(super) fn reflow_plan(mode: ReflowableLayoutMode) -> AdapterLayoutPlan {
    AdapterLayoutPlan::ReflowableXhtml {
        requested: PresentationPreferences::default(),
        mode,
        notice: None,
        align_x_center: false,
    }
}
pub(super) fn layout_result(
    plan: AdapterLayoutPlan,
    settlement: AdapterLayoutSettlement,
) -> LayoutResult {
    match (plan, settlement) {
        (
            AdapterLayoutPlan::ReflowableXhtml { .. },
            AdapterLayoutSettlement::ReflowableXhtml { settlement, .. },
        ) => LayoutResult::ReflowableXhtml {
            outcome: ReflowableLayoutOutcome::Settled {
                settlement: Box::new(settlement),
            },
        },
        (AdapterLayoutPlan::FixedXhtml, AdapterLayoutSettlement::FixedXhtml { settlement }) => {
            LayoutResult::FixedXhtml {
                outcome: FixedLayoutOutcome::Settled {
                    settlement: Box::new(settlement),
                },
            }
        }
        (AdapterLayoutPlan::FixedSvg, AdapterLayoutSettlement::FixedSvg { settlement }) => {
            LayoutResult::FixedSvg {
                outcome: FixedLayoutOutcome::Settled {
                    settlement: Box::new(settlement),
                },
            }
        }
        (AdapterLayoutPlan::FixedImage, AdapterLayoutSettlement::FixedImage { settlement }) => {
            LayoutResult::FixedImage {
                outcome: FixedLayoutOutcome::Settled {
                    settlement: Box::new(settlement),
                },
            }
        }
        _ => unreachable!(),
    }
}
pub(super) fn layout_measurement() -> LayoutMeasurement {
    LayoutMeasurement {
        observation: document_observation(),
        logical_viewport: LogicalSize {
            inline: 800.0,
            block: 600.0,
        },
        logical_content_extent: LogicalSize {
            inline: 2400.0,
            block: 600.0,
        },
        normalized_position: 0.25,
        physical_movement: PhysicalMovementVector { x: 800.0, y: 0.0 },
        required_fonts: RequiredAssetSettlement::Loaded,
        required_resources: RequiredAssetSettlement::Loaded,
    }
}
pub(super) fn settled_layout(plan: AdapterLayoutPlan) -> AdapterLayoutSettlement {
    let contain = |geometry| FixedSettlement::Contain {
        measurement: fixed_layout_measurement(),
        geometry,
    };
    match plan {
        AdapterLayoutPlan::ReflowableXhtml {
            requested,
            mode,
            notice,
            align_x_center,
        } => AdapterLayoutSettlement::ReflowableXhtml {
            requested,
            mode,
            notice,
            align_x_center,
            position: ReflowPositionRequest::Unavailable,
            settlement: match mode {
                ReflowableLayoutMode::Paginated => ReflowableSettlement::Paginated {
                    measurement: layout_measurement(),
                    pages: PaginatedLayout {
                        spread_stride: 800.0,
                        column_origin: 0.0,
                        column_width: 768.0,
                        column_gap: 32.0,
                        column_pitch: 800.0,
                        first_visible_page: 0,
                        page_count: 3,
                        visible_page_count: 1,
                        columns_per_view: 1,
                        layout_repairs: LayoutRepairReport::NoIssuesDetected {},
                    },
                },
                ReflowableLayoutMode::DocumentScroll => ReflowableSettlement::DocumentScroll {
                    measurement: layout_measurement(),
                },
            },
        },
        AdapterLayoutPlan::FixedXhtml => AdapterLayoutSettlement::FixedXhtml {
            settlement: contain(fixed_geometry()),
        },
        AdapterLayoutPlan::FixedSvg => AdapterLayoutSettlement::FixedSvg {
            settlement: contain(fixed_geometry()),
        },
        AdapterLayoutPlan::FixedImage => AdapterLayoutSettlement::FixedImage {
            settlement: contain({
                let mut geometry = fixed_geometry();
                geometry.intrinsic_viewport.source =
                    Some(FixedIntrinsicViewportSource::ImageNatural);
                geometry
            }),
        },
    }
}
pub(super) fn fixed_geometry() -> FixedPageGeometry {
    FixedPageGeometry {
        intrinsic_viewport: FixedIntrinsicViewport {
            source: None,
            width: 400.0,
            height: 400.0,
        },
        containing_viewport: DocumentViewport {
            width: 800.0,
            height: 600.0,
        },
        scale: 1.5,
        rendered_width: 600.0,
        rendered_height: 600.0,
        offset_x: 100.0,
        offset_y: 0.0,
    }
}
pub(super) fn fixed_layout_measurement() -> LayoutMeasurement {
    let mut measurement = layout_measurement();
    measurement.observation.viewport = DocumentViewport {
        width: 400.0,
        height: 400.0,
    };
    measurement.logical_viewport = LogicalSize {
        inline: 400.0,
        block: 400.0,
    };
    measurement
}
pub(super) fn failed_layout_result(
    plan: AdapterLayoutPlan,
    issue: LayoutIssue,
    unavailable: bool,
) -> LayoutResult {
    let fixed = |unavailable_issue| {
        if unavailable {
            FixedLayoutOutcome::Unavailable {
                issue: unavailable_issue,
            }
        } else {
            FixedLayoutOutcome::Conflict {
                issue: FixedLayoutIssue::IntrinsicViewportInvalid,
            }
        }
    };
    match plan {
        AdapterLayoutPlan::ReflowableXhtml { .. } => LayoutResult::ReflowableXhtml {
            outcome: if unavailable {
                ReflowableLayoutOutcome::Unavailable { issue }
            } else {
                ReflowableLayoutOutcome::Conflict { issue }
            },
        },
        AdapterLayoutPlan::FixedXhtml => LayoutResult::FixedXhtml {
            outcome: fixed(FixedLayoutIssue::AgentStyleUnavailable),
        },
        AdapterLayoutPlan::FixedSvg => LayoutResult::FixedSvg {
            outcome: fixed(FixedLayoutIssue::AgentStyleUnavailable),
        },
        AdapterLayoutPlan::FixedImage => LayoutResult::FixedImage {
            outcome: fixed(FixedLayoutIssue::ImageLoadFailed),
        },
    }
}
pub(super) fn assert_failure(transition: &KernelTransition, code: &str) {
    assert!(!transition.accepted);
    assert!(transition.events.is_empty());
    assert!(transition.effects.is_empty());
    let value = serde_json::to_value(transition.failure.as_ref().unwrap()).unwrap();
    assert_eq!(value["code"], code);
}
pub(super) fn start_replacement_with_stale_retained_preferences(
    kernel: &mut NavigatorKernel,
) -> PresentationPreferences {
    let preferences = PresentationPreferences {
        font_scale: FontScale::Percent125,
        ..PresentationPreferences::default()
    };
    kernel.dispatch(NavigatorCommand::SetPresentationPreferences { preferences });
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 });
    preferences
}
pub(super) fn committed_position(kernel: &NavigatorKernel) -> ReflowPositionRequest {
    match &kernel
        .committed
        .as_ref()
        .unwrap()
        .layout
        .layout()
        .settlement
    {
        AdapterLayoutSettlement::ReflowableXhtml { position, .. } => position.clone(),
        settlement => panic!("unexpected fixed settlement: {settlement:?}"),
    }
}
