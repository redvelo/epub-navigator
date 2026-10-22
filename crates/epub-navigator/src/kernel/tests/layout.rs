use super::support::*;
use crate::kernel::*;
use serde_json::json;

type FixedEdit = fn(&mut FixedPageGeometry, &mut LayoutMeasurement);
type PagesEdit = fn(&mut PaginatedLayout, &mut LayoutMeasurement);

fn replacing() -> NavigatorKernel {
    let mut kernel = opened(&initialization(), 0);
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 });
    load(&mut kernel, 2);
    kernel
}
fn exhaust_layout(kernel: &mut NavigatorKernel, exhaust_generation: bool, value: u32) {
    if exhaust_generation {
        kernel.layout_generation = value;
    } else {
        kernel.layout_operation = value;
    }
}
fn requested_position(transition: &KernelTransition) -> Option<&ReflowPositionRequest> {
    transition.effects.iter().find_map(|effect| match effect {
        KernelEffect::LayoutRequest {
            request: LayoutRequest::ReflowableXhtml { position, .. },
            ..
        } => Some(position),
        _ => None,
    })
}
fn larger_font() -> NavigatorCommand {
    NavigatorCommand::SetPresentationPreferences {
        preferences: PresentationPreferences {
            font_scale: FontScale::Percent125,
            ..PresentationPreferences::default()
        },
    }
}
fn update_owner(document_generation: u32) -> LayoutOwner {
    LayoutOwner::Document {
        document_generation,
        phase: LayoutPhase::Update,
    }
}

#[test]
fn fixed_image_requires_natural_source_and_valid_containment() {
    let mut geometry = fixed_geometry();
    let validate = |geometry| {
        LayoutResult::FixedImage {
            outcome: FixedLayoutOutcome::Settled {
                settlement: Box::new(FixedSettlement::Contain {
                    measurement: fixed_layout_measurement(),
                    geometry,
                }),
            },
        }
        .validate(AdapterLayoutPlan::FixedImage)
    };
    assert!(validate(geometry.clone()).is_err());
    geometry.intrinsic_viewport.source = Some(FixedIntrinsicViewportSource::ImageNatural);
    assert!(validate(geometry.clone()).is_ok());
    geometry.scale = 2.0;
    assert!(validate(geometry).is_err());
    assert!(
        serde_json::from_value::<FixedIntrinsicViewport>(json!({
            "width": 10, "height": 10, "source": "unknown"
        }))
        .is_err()
    );
}
#[test]
fn exact_occurrence_open_requests_exact_initial_reflow_position() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    let evidence = vec![PointEvidence::HtmlFragment {
        value: "chapter-point".to_string(),
    }];
    assert!(
        kernel
            .dispatch(NavigatorCommand::OpenOccurrenceAt {
                occurrence: 0,
                evidence: evidence.clone(),
            })
            .accepted
    );
    assert_eq!(
        requested_position(&load(&mut kernel, 1)),
        Some(&ReflowPositionRequest::Exact {
            evidence,
            fallback_progression: 0.0,
        })
    );
}
#[test]
fn layout_repair_report_has_tagged_json_and_validates_counts() {
    for (report, value) in [
        (
            LayoutRepairReport::NoIssuesDetected {},
            json!({ "status": "no-issues-detected" }),
        ),
        (
            LayoutRepairReport::Repaired {
                repaired_elements: 2,
            },
            json!({ "status": "repaired", "repairedElements": 2 }),
        ),
        (
            LayoutRepairReport::Unresolved {
                repaired_elements: 0,
                unresolved_elements: 1,
            },
            json!({ "status": "unresolved", "repairedElements": 0, "unresolvedElements": 1 }),
        ),
    ] {
        assert_eq!(serde_json::to_value(report).unwrap(), value);
        assert_eq!(report.validate(), Ok(()));
    }
    for report in [
        LayoutRepairReport::Repaired {
            repaired_elements: 0,
        },
        LayoutRepairReport::Unresolved {
            repaired_elements: 0,
            unresolved_elements: 0,
        },
    ] {
        assert_eq!(report.validate(), Err(KernelError::InvalidLayoutResult));
    }
}
#[test]
fn itemref_flow_uses_first_recognized_candidate_without_changing_facts() {
    let snapshot = NavigatorKernel::create(&initialization())
        .unwrap()
        .snapshot();
    let defaults = PresentationPreferences::default();
    for source in [
        OccurrenceRenditionValueSource::ItemRefProperty,
        OccurrenceRenditionValueSource::PackageMetadata,
    ] {
        for (authored, value, mode, notice) in [
            (
                "auto",
                Some(OccurrenceRenditionFlow::Auto),
                ReflowableLayoutMode::Paginated,
                None,
            ),
            (
                "paginated",
                Some(OccurrenceRenditionFlow::Paginated),
                ReflowableLayoutMode::Paginated,
                None,
            ),
            (
                "scrolled-doc",
                Some(OccurrenceRenditionFlow::ScrolledDoc),
                ReflowableLayoutMode::DocumentScroll,
                None,
            ),
            (
                "scrolled-continuous",
                Some(OccurrenceRenditionFlow::ScrolledContinuous),
                ReflowableLayoutMode::DocumentScroll,
                Some(LayoutIssue::PublicationContinuousUnavailable),
            ),
            (
                "unknown",
                None,
                ReflowableLayoutMode::Paginated,
                Some(LayoutIssue::AuthoredPresentationAmbiguous),
            ),
        ] {
            let mut occurrence = snapshot.reading_order[0].clone();
            let candidate = |authored: &str, value| OccurrenceRenditionCandidate {
                source,
                authored_value: Some(
                    if source == OccurrenceRenditionValueSource::ItemRefProperty {
                        format!("rendition:flow-{authored}")
                    } else {
                        authored.to_string()
                    },
                ),
                value,
            };
            occurrence.presentation.flow = OccurrenceRenditionSetting::Ambiguous(vec![
                candidate("unknown-first", None),
                candidate(authored, value),
                candidate("unknown-middle", None),
                candidate(
                    "later",
                    value.map(|_| {
                        if mode == ReflowableLayoutMode::Paginated {
                            OccurrenceRenditionFlow::ScrolledDoc
                        } else {
                            OccurrenceRenditionFlow::Paginated
                        }
                    }),
                ),
            ]);
            let raw = occurrence.presentation.clone();
            for preference in [
                PresentationMode::Auto,
                PresentationMode::Paginated,
                PresentationMode::DocumentScroll,
            ] {
                let requested = PresentationPreferences {
                    mode: preference,
                    ..defaults
                };
                let (expected_mode, expected_notice) = match preference {
                    PresentationMode::Paginated => (ReflowableLayoutMode::Paginated, None),
                    PresentationMode::DocumentScroll => {
                        (ReflowableLayoutMode::DocumentScroll, None)
                    }
                    PresentationMode::Auto
                        if source == OccurrenceRenditionValueSource::PackageMetadata =>
                    {
                        (
                            ReflowableLayoutMode::Paginated,
                            Some(LayoutIssue::AuthoredPresentationAmbiguous),
                        )
                    }
                    PresentationMode::Auto => (mode, notice),
                };
                assert_eq!(
                    resolve_layout_plan(&occurrence, requested),
                    AdapterLayoutPlan::ReflowableXhtml {
                        requested,
                        mode: expected_mode,
                        notice: expected_notice,
                        align_x_center: false,
                    },
                    "{source:?} {authored} {preference:?}"
                );
                assert_eq!(occurrence.presentation, raw);
            }
        }
    }
}
#[test]
fn adapter_layout_plan_matrix_is_deterministic() {
    let snapshot = NavigatorKernel::create(&initialization())
        .unwrap()
        .snapshot();
    let defaults = PresentationPreferences::default();
    for (flow, mode, notice) in [
        (None, ReflowableLayoutMode::Paginated, None),
        (
            Some(OccurrenceRenditionFlow::ScrolledDoc),
            ReflowableLayoutMode::DocumentScroll,
            None,
        ),
        (
            Some(OccurrenceRenditionFlow::ScrolledContinuous),
            ReflowableLayoutMode::DocumentScroll,
            Some(LayoutIssue::PublicationContinuousUnavailable),
        ),
    ] {
        let mut occurrence = snapshot.reading_order[0].clone();
        if let Some(flow) = flow {
            occurrence.presentation.flow =
                OccurrenceRenditionSetting::Specified(OccurrenceRenditionCandidate {
                    source: OccurrenceRenditionValueSource::ItemRefProperty,
                    authored_value: Some(format!("rendition:flow-{flow:?}")),
                    value: Some(flow),
                });
        }
        assert_eq!(
            resolve_layout_plan(&occurrence, defaults),
            AdapterLayoutPlan::ReflowableXhtml {
                requested: defaults,
                mode,
                notice,
                align_x_center: false,
            }
        );
    }
    assert_eq!(
        resolve_layout_plan(&snapshot.reading_order[1], defaults),
        AdapterLayoutPlan::FixedXhtml
    );
    assert_eq!(
        resolve_layout_plan(&snapshot.reading_order[8], defaults),
        AdapterLayoutPlan::FixedSvg
    );

    let ambiguous = initialization_with(|value| {
        value["facts"]["resources"]["readingOrder"][0]["presentation"]["layout"] = json!({
            "state": "ambiguous",
            "value": [
                { "source": "package-metadata", "authoredValue": "reflowable", "value": "reflowable" },
                { "source": "package-metadata", "authoredValue": "pre-paginated", "value": "pre-paginated" }
            ]
        });
    });
    assert!(matches!(
        NavigatorKernel::create(&ambiguous)
            .unwrap()
            .snapshot()
            .reading_order[0]
            .document,
        OccurrenceDocumentTarget::Unavailable {
            reason: OccurrenceUnavailableReason::AmbiguousRendition,
            ..
        }
    ));
}
#[test]
fn layout_invalidation_supersedes_and_stale_results_do_not_mutate() {
    let mut kernel = opened(&initialization(), 0);
    assert!(invalidate_primary(&mut kernel, LayoutInvalidationCause::Viewport).accepted);
    let pending = kernel.snapshot().layout.pending.unwrap();
    let before = kernel.snapshot();
    assert_failure(
        &kernel.dispatch(AdapterObservation::LayoutResult {
            participant: pending.participant(),
            operation: pending.operation,
            generation: 1,
            layout_generation: pending.layout_generation - 1,
            result: settled_result(pending.adapter.plan()),
        }),
        "stale-agent-operation-observation",
    );
    assert_eq!(kernel.snapshot(), before);
    assert_failure(
        &kernel.dispatch(AdapterObservation::LayoutInvalidated {
            participant: Some(primary(1)),
            generation: 99,
            cause: LayoutInvalidationCause::Dom,
        }),
        "stale-observation",
    );
}
#[test]
fn preference_change_allocates_one_layout_generation_without_replacing_frame() {
    let mut kernel = opened(&initialization(), 0);
    let before = kernel.snapshot().layout.layout_generation;
    let preferences = PresentationPreferences {
        mode: PresentationMode::DocumentScroll,
        pagination_columns: PaginationColumns::Double,
        theme: PublicationTheme::Dark,
        color_scheme: PublicationColorScheme::Dark,
        typeface: PublicationTypeface::Original,
        font_scale: FontScale::Percent125,
        line_height: LineHeight::Original,
        letter_spacing: LetterSpacing::None,
        word_spacing: WordSpacing::None,
        paragraph_spacing: ParagraphSpacing::Original,
        text_indent: TextIndent::Original,
        measure: ReadingMeasure::FullWidth,
        alignment: TextAlignment::Original,
        hyphenation: Hyphenation::Original,
        root_scrollbar: RootScrollbar::Hidden,
    };
    let changed = kernel.dispatch(NavigatorCommand::SetPresentationPreferences { preferences });
    assert!(
        !changed
            .effects
            .iter()
            .any(|effect| matches!(effect, KernelEffect::ReplaceFrame { .. }))
    );
    let snapshot = kernel.snapshot();
    assert_eq!(snapshot.layout.layout_generation, before + 1);
    assert_eq!(snapshot.layout.preferences, preferences);
    assert_eq!(
        snapshot.layout.pending.unwrap().adapter.plan(),
        AdapterLayoutPlan::ReflowableXhtml {
            requested: preferences,
            mode: ReflowableLayoutMode::DocumentScroll,
            notice: None,
            align_x_center: false,
        }
    );
}
#[test]
fn preference_change_uses_the_latest_observed_position_as_its_reflow_anchor() {
    let mut kernel = opened(&initialization(), 0);
    let end = ObservedBoundary::Located {
        evidence: vec![PointEvidence::DocumentBoundary {
            boundary: DocumentBoundary::End,
        }],
    };
    let mut observation = document_observation();
    observation.visible_start = end.clone();
    let observed = observe(&mut kernel, observation);
    assert!(observed.accepted, "{:?}", observed.failure);

    assert_eq!(
        requested_position(&kernel.dispatch(larger_font())),
        Some(&ReflowPositionRequest::Exact {
            evidence: vec![PointEvidence::DocumentBoundary {
                boundary: DocumentBoundary::End,
            }],
            fallback_progression: 0.25,
        })
    );

    let transient = observe(&mut kernel, document_observation());
    assert!(transient.accepted);
    assert!(transient.events.is_empty());
    assert_eq!(
        kernel
            .committed
            .as_ref()
            .unwrap()
            .layout
            .observation()
            .visible_start,
        end
    );
}
#[test]
fn preference_change_uses_live_pagination_when_boundary_evidence_is_contradictory() {
    let mut kernel = opened(&initialization(), 0);
    let mut observation = document_observation();
    observation.rendered_text_progression = None;
    observation.pagination = Some(PaginationObservation {
        first_visible_page: 2,
        page_count: 3,
        visible_page_count: 1,
    });
    let observed = observe(&mut kernel, observation);
    assert!(observed.accepted, "{:?}", observed.failure);
    let expected = ReflowPositionRequest::Progression {
        normalized_progression: 1.0,
    };
    assert_eq!(kernel.reflow_position(1), expected);
    assert_eq!(
        requested_position(&kernel.dispatch(larger_font())),
        Some(&expected)
    );
}
#[test]
fn incoming_agent_readiness_cancels_an_outgoing_relayout() {
    let mut kernel = opened(&initialization(), 0);
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 1 });
    kernel.dispatch(FrameObservation::Loaded { generation: 2 });
    let outgoing_operation = kernel
        .dispatch(larger_font())
        .events
        .iter()
        .find_map(|event| match event {
            KernelEvent::LayoutPending {
                operation,
                generation: 1,
                ..
            } => Some(*operation),
            _ => None,
        })
        .expect("the outgoing relayout is pending");

    let ready = kernel.dispatch(AdapterObservation::Ready {
        generation: 2,
        supported_operations: vec![],
    });
    assert!(ready.events.iter().any(|event| matches!(
        event,
        KernelEvent::LayoutOperationFailed {
            operation,
            generation: 1,
            failure: AgentOperationFailure::OperationCancelled {
                reason: AgentOperationCancellationReason::Replacement,
            },
            ..
        } if *operation == outgoing_operation
    )));
    assert_eq!(
        kernel.snapshot().layout.pending.unwrap().owner,
        LayoutOwner::Document {
            document_generation: 2,
            phase: LayoutPhase::Initial,
        }
    );
    settle_pending_layout(&mut kernel, 2);
    assert_eq!(kernel.snapshot().document.committed.unwrap().generation, 2);
}
#[test]
fn outgoing_layout_invalidation_after_incoming_initial_layout_is_non_interfering() {
    let mut kernel = replacing();
    let incoming = kernel.snapshot().layout.pending;

    let invalidated = invalidate_primary(&mut kernel, LayoutInvalidationCause::Dom);
    assert!(invalidated.accepted);
    assert!(invalidated.events.is_empty());
    assert!(invalidated.effects.is_empty());
    assert_eq!(kernel.snapshot().layout.pending, incoming);
    assert!(matches!(
        kernel.committed.as_ref().unwrap().layout,
        CommittedLayoutState::Dirty {
            cause: LayoutInvalidationCause::Dom,
            ..
        }
    ));

    settle_pending_layout(&mut kernel, 2);
    assert_eq!(kernel.snapshot().document.committed.unwrap().generation, 2);
    assert_eq!(kernel.snapshot().layout.pending, None);
    assert!(matches!(
        kernel.committed.as_ref().unwrap().layout,
        CommittedLayoutState::Settled { .. }
    ));
}
#[test]
fn deferred_outgoing_layout_invalidation_reflows_once_after_replacement_ends() {
    for outcome in ["cancel", "frame-failed", "layout-failed"] {
        let mut kernel = replacing();
        let operation_before = kernel.layout_operation;
        let layout_generation_before = kernel.layout_generation;

        for cause in [LayoutInvalidationCause::Dom, LayoutInvalidationCause::Fonts] {
            let invalidated = invalidate_primary(&mut kernel, cause);
            assert!(invalidated.accepted, "{outcome}");
            assert!(invalidated.events.is_empty(), "{outcome}");
            assert!(invalidated.effects.is_empty(), "{outcome}");
        }
        assert_eq!(kernel.layout_operation, operation_before, "{outcome}");
        assert_eq!(
            kernel.layout_generation, layout_generation_before,
            "{outcome}"
        );

        let ended = match outcome {
            "cancel" => kernel.dispatch(NavigatorCommand::CancelDocument {}),
            "frame-failed" => kernel.dispatch(FrameObservation::Failed {
                generation: 2,
                reason: FrameFailureReason::LoadError,
            }),
            _ => layout_timeout(&mut kernel, 2),
        };
        assert!(ended.accepted, "{outcome}");
        assert_eq!(
            ended
                .effects
                .iter()
                .filter(|effect| matches!(
                    effect,
                    KernelEffect::LayoutRequest { generation: 1, .. }
                ))
                .count(),
            1,
            "{outcome}"
        );
        assert_eq!(
            kernel.snapshot().layout.pending.unwrap().owner,
            update_owner(1),
            "{outcome}"
        );
        assert!(
            matches!(
                kernel.committed.as_ref().unwrap().layout,
                CommittedLayoutState::Updating { .. }
            ),
            "{outcome}"
        );
    }
}
#[test]
fn layout_allocation_exhaustion_is_fully_non_mutating() {
    for exhaust_generation in [false, true] {
        let mut kernel = replacing();
        exhaust_layout(&mut kernel, exhaust_generation, u32::MAX);
        let before = kernel.snapshot();
        assert!(!invalidate_primary(&mut kernel, LayoutInvalidationCause::Viewport).accepted);
        assert_eq!(kernel.snapshot(), before);

        for (mut kernel, value) in [
            (opened(&initialization(), 0), u32::MAX),
            (replacing(), u32::MAX - 1),
        ] {
            exhaust_layout(&mut kernel, exhaust_generation, value);
            let before = kernel.snapshot();
            assert!(!kernel.dispatch(larger_font()).accepted);
            assert_eq!(kernel.snapshot(), before);
        }
    }
}
#[test]
fn outgoing_document_invalidation_never_cancels_incoming_initial_layout() {
    for invalidate_after_ready in [false, true] {
        let mut kernel = opened(&initialization(), 0);
        kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 });
        kernel.dispatch(FrameObservation::Loaded { generation: 2 });
        let ready = AdapterObservation::Ready {
            generation: 2,
            supported_operations: vec![],
        };
        if invalidate_after_ready {
            kernel.dispatch(ready.clone());
        }

        let invalidated = kernel.dispatch(AdapterObservation::DocumentInvalidated {
            participant: primary(1),
            generation: 1,
            reason: DocumentInvalidationReason::UnexpectedNavigation,
        });
        assert!(invalidated.accepted);
        assert!(!invalidated.events.iter().any(|event| matches!(
            event,
            KernelEvent::AgentOperationFailed { generation: 2, .. }
        )));
        if !invalidate_after_ready {
            kernel.dispatch(ready);
        }
        assert_eq!(
            kernel.snapshot().layout.pending.unwrap().owner,
            LayoutOwner::Document {
                document_generation: 2,
                phase: LayoutPhase::Initial,
            }
        );
        settle_pending_layout(&mut kernel, 2);
        assert_eq!(kernel.snapshot().document.committed.unwrap().generation, 2);
    }
}
#[test]
fn every_replacement_failure_reconciles_retained_preferences() {
    for outcome in [
        "cancel-before-load",
        "frame-failed",
        "cancel",
        "timeout",
        "conflict",
        "unavailable",
    ] {
        let mut kernel = opened(&initialization(), 0);
        let preferences = start_replacement_with_stale_retained_preferences(&mut kernel);
        let transition = match outcome {
            "cancel-before-load" => kernel.dispatch(NavigatorCommand::CancelDocument {}),
            "frame-failed" => kernel.dispatch(FrameObservation::Failed {
                generation: 2,
                reason: FrameFailureReason::LoadError,
            }),
            _ => {
                load(&mut kernel, 2);
                match outcome {
                    "cancel" => kernel.dispatch(NavigatorCommand::CancelDocument {}),
                    "timeout" => layout_timeout(&mut kernel, 2),
                    "conflict" => report_layout(&mut kernel, 2, |plan| {
                        failed_layout_result(plan, LayoutIssue::IncompatiblePublisherCss, false)
                    }),
                    _ => report_layout(&mut kernel, 2, |plan| {
                        failed_layout_result(plan, LayoutIssue::AgentStyleUnavailable, true)
                    }),
                }
            }
        };
        assert!(transition.accepted, "{outcome}");
        assert!(
            transition
                .effects
                .iter()
                .any(|effect| matches!(effect, KernelEffect::LayoutRequest { generation: 1, .. })),
            "{outcome}"
        );
        let snapshot = kernel.snapshot();
        assert_eq!(
            snapshot.document.committed.unwrap().generation,
            1,
            "{outcome}"
        );
        assert_eq!(snapshot.document.pending, None, "{outcome}");
        assert_eq!(snapshot.layout.preferences, preferences, "{outcome}");
        assert_eq!(
            snapshot.layout.pending.unwrap().owner,
            update_owner(1),
            "{outcome}"
        );
    }
}
#[test]
fn settled_anchor_uses_exact_then_retains_it_across_unavailable_boundary() {
    let mut kernel = opened(&initialization(), 0);
    let exact = committed_position(&kernel);
    assert!(matches!(exact, ReflowPositionRequest::Exact { .. }));
    invalidate_primary(&mut kernel, LayoutInvalidationCause::Fonts);
    report_layout(&mut kernel, 1, |plan| {
        let mut layout = settled_layout(plan);
        if let AdapterLayoutSettlement::ReflowableXhtml {
            settlement: ReflowableSettlement::Paginated { measurement, .. },
            ..
        } = &mut layout
        {
            measurement.observation.visible_start = ObservedBoundary::Unavailable;
        }
        layout_result(plan, layout)
    });
    assert_eq!(committed_position(&kernel), exact);
}
#[test]
fn layout_result_validation_rejects_invalid_geometry_pages_and_anchor() {
    let fixed_plan = AdapterLayoutPlan::FixedXhtml;
    let fixed_validation = |edit: FixedEdit| {
        let mut settlement = settled_layout(fixed_plan);
        let AdapterLayoutSettlement::FixedXhtml {
            settlement:
                FixedSettlement::Contain {
                    geometry,
                    measurement,
                },
        } = &mut settlement
        else {
            unreachable!()
        };
        edit(geometry, measurement);
        layout_result(fixed_plan, settlement).validate(fixed_plan)
    };
    assert_eq!(fixed_validation(|_, _| {}), Ok(()));
    let invalid_fixed: [FixedEdit; 6] = [
        |geometry, _| geometry.scale = f64::NAN,
        |geometry, _| geometry.scale = 1.6,
        |geometry, _| geometry.rendered_width = 640.0,
        |geometry, _| geometry.offset_x = 0.0,
        |geometry, _| geometry.containing_viewport.width = 900.0,
        |_, measurement| {
            measurement.observation.pagination = Some(PaginationObservation {
                first_visible_page: 0,
                page_count: 1,
                visible_page_count: 1,
            })
        },
    ];
    for edit in invalid_fixed {
        assert_eq!(
            fixed_validation(edit),
            Err(KernelError::InvalidLayoutResult)
        );
    }

    let plan = reflow_plan(ReflowableLayoutMode::Paginated);
    let reflow_validation = |edit: PagesEdit| {
        let mut settlement = settled_layout(plan);
        let AdapterLayoutSettlement::ReflowableXhtml {
            settlement: ReflowableSettlement::Paginated { pages, measurement },
            ..
        } = &mut settlement
        else {
            unreachable!()
        };
        edit(pages, measurement);
        layout_result(plan, settlement).validate(plan)
    };
    fn odd_spread(pages: &mut PaginatedLayout) {
        *pages = PaginatedLayout {
            spread_stride: 800.0,
            column_origin: 16.0,
            column_width: 368.0,
            column_gap: 32.0,
            column_pitch: 400.0,
            first_visible_page: 2,
            page_count: 3,
            visible_page_count: 1,
            columns_per_view: 2,
            layout_repairs: LayoutRepairReport::NoIssuesDetected {},
        }
    }
    assert_eq!(reflow_validation(|pages, _| odd_spread(pages)), Ok(()));
    let invalid_reflow: [PagesEdit; 4] = [
        |pages, _| {
            odd_spread(pages);
            pages.spread_stride = 1000.0;
            pages.column_pitch = 500.0;
        },
        |pages, _| {
            odd_spread(pages);
            pages.visible_page_count = 2;
        },
        |_, measurement| measurement.normalized_position = f64::NAN,
        |pages, _| {
            pages.spread_stride = 0.0;
            pages.columns_per_view = 3;
        },
    ];
    for edit in invalid_reflow {
        assert_eq!(
            reflow_validation(edit),
            Err(KernelError::InvalidLayoutResult)
        );
    }
    assert_eq!(
        ReflowPositionRequest::Progression {
            normalized_progression: 2.0,
        }
        .validate(),
        Err(KernelError::InvalidLayoutResult)
    );
}
