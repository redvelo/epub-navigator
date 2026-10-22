use super::support::*;
use crate::kernel::*;
use epub_stack::annotation::{AnnotationSelector, AnnotationTarget, FragmentConformsTo};
use serde_json::{Value, json};

fn plan(kernel: &NavigatorKernel, target: Value) -> AnnotationTargetResolutionPlan {
    serde_json::from_str(
        &kernel
            .project_annotation_target_json(&target.to_string())
            .unwrap(),
    )
    .unwrap()
}
fn report(
    path: Vec<u32>,
    kind: AnnotationSelectorKind,
    outcome: AnnotationSelectorExecutionOutcome,
    match_count: u32,
    segment: Option<ResolvedAnnotationSegment>,
) -> AnnotationSelectorExecutionReport {
    AnnotationSelectorExecutionReport {
        path,
        kind,
        outcome,
        match_count,
        segment,
        message: None,
    }
}
fn element() -> Option<ResolvedAnnotationSegment> {
    Some(ResolvedAnnotationSegment::Element {
        resource: "EPUB/chapter.xhtml".to_string(),
    })
}

#[test]
fn annotation_range_adjustment_is_rendered_record_owned_and_kernel_finalized() {
    let mut kernel = opened_with(vec![
        AgentOperationKind::ReconcileDecorations,
        AgentOperationKind::AdjustAnnotationRange,
    ]);
    let adjust = |edge, movement| NavigatorCommand::AdjustAnnotationRange {
        participant: primary(1),
        projection_revision: 1,
        record_id: "annotation-1".to_string(),
        edge,
        movement,
    };
    let reconciliation = set_decorations(
        &mut kernel,
        1,
        vec![decoration("annotation-1", 0, "chapter.xhtml")],
    );
    assert!(
        !kernel
            .dispatch(adjust(
                AnnotationRangeEdge::End,
                AnnotationRangeMovement::Forward
            ))
            .accepted
    );
    let (reconcile_operation, _) = agent_request(&reconciliation);
    assert!(
        agent_result(
            &mut kernel,
            reconcile_operation,
            AgentResult::ReconcileDecorations {
                projection_revision: 1,
                outcomes: vec![DecorationRecordResult {
                    id: "annotation-1".to_string(),
                    outcome: DecorationRecordOutcome::Rendered,
                }],
            },
        )
        .accepted
    );

    let requested = kernel.dispatch(adjust(
        AnnotationRangeEdge::Start,
        AnnotationRangeMovement::Backward,
    ));
    assert!(matches!(
        requested.effects.as_slice(),
        [KernelEffect::AgentRequest {
            request: AgentRequest::AdjustAnnotationRange {
                projection_revision: 1,
                record_id,
                edge: AnnotationRangeEdge::Start,
                movement: AnnotationRangeMovement::Backward,
            },
            ..
        }] if record_id == "annotation-1"
    ));
    let (operation, _) = agent_request(&requested);
    let reported = agent_result(
        &mut kernel,
        operation,
        AgentResult::AdjustAnnotationRange {
            candidate: AnnotationRangeAdjustmentCandidate {
                projection_revision: 1,
                record_id: "annotation-1".to_string(),
                edge: AnnotationRangeEdge::Start,
                movement: AnnotationRangeMovement::Backward,
                status: AnnotationTargetGenerationCandidateStatus::Generated {
                    selectors: AnnotationSelectorCandidate {
                        css: None,
                        document: Some(AnnotationDocumentRangeCandidate {
                            start: "1".to_string(),
                            end: "11".to_string(),
                        }),
                        text_fragment: None,
                    },
                },
                excerpt: Some("alpha beta".to_string()),
            },
        },
    );
    assert!(matches!(
        reported.events.as_slice(),
        [KernelEvent::AnnotationRangeAdjustmentReported {
            outcome: AnnotationRangeAdjustmentOutcome::Adjusted { target_json, excerpt },
            ..
        }] if target_json.contains("TextPositionSelector") && excerpt == "alpha beta"
    ));
}
#[test]
fn annotation_projection_preserves_css_refinement_paths_and_u64_offsets() {
    let kernel = NavigatorKernel::create(&initialization()).unwrap();
    let plan = plan(
        &kernel,
        json!({
            "source": "chapter.xhtml",
            "selector": [{
                "type": "CssSelector",
                "value": ".choice",
                "refinedBy": [{
                    "type": "TextPositionSelector",
                    "start": 9007199254740993u64,
                    "end": u64::MAX
                }]
            }]
        }),
    );
    assert_eq!(plan.resource, "EPUB/chapter.xhtml");
    assert!(matches!(
        plan.selectors.as_slice(),
        [AnnotationSelectorNode::Css { path, refinements, .. }]
            if path == &[0] && matches!(
                refinements.as_slice(),
                [AnnotationSelectorNode::TextPosition { path, values, .. }]
                    if path == &[0, 0]
                        && values.start == "9007199254740993"
                        && values.end == u64::MAX.to_string()
            )
    ));
}
#[test]
fn annotation_projection_classifies_selectors_in_source_order_with_stack_fragment_decoding() {
    let kernel = NavigatorKernel::create(&initialization()).unwrap();
    let plan = plan(
        &kernel,
        json!({
            "source": "chapter.xhtml",
            "selector": [
                { "type": "FutureSelector" },
                { "value": "missing type" },
                { "type": "FragmentSelector", "value": "#one" },
                { "type": "FragmentSelector", "value": "one%23two" }
            ]
        }),
    );
    assert!(matches!(
        plan.selectors.as_slice(),
        [
            AnnotationSelectorNode::Unsupported { path: first, .. },
            AnnotationSelectorNode::Invalid { path: second, .. },
            AnnotationSelectorNode::Invalid { .. },
            AnnotationSelectorNode::HtmlFragment { values, .. }
        ] if first == &[0] && second == &[1] && values.value == "one#two"
    ));
}
#[test]
fn annotation_projection_uses_stack_source_reference_semantics() {
    let kernel = NavigatorKernel::create(&initialization()).unwrap();
    assert!(
        kernel
            .project_annotation_target_json(r#"{"source":"chapter.xhtml?edition=1"}"#)
            .is_ok()
    );
    for source in [
        "sub%2F..%2Fchapter.xhtml",
        "chapter.xhtml#fragment",
        "https://example.com/chapter.xhtml",
        " chapter.xhtml",
        "/EPUB/chapter.xhtml",
        "../../chapter.xhtml",
    ] {
        let target = json!({ "source": source }).to_string();
        assert_eq!(
            kernel.project_annotation_target_json(&target),
            Err(KernelError::InvalidAnnotationTarget),
            "unexpectedly accepted {source:?}"
        );
    }
}
#[test]
fn annotation_projection_and_plans_reject_more_than_the_execution_node_limit() {
    let kernel = NavigatorKernel::create(&initialization()).unwrap();
    let selectors = (0..=MAX_ANNOTATION_SELECTOR_NODES)
        .map(|index| json!({ "type": "CssSelector", "value": format!("#n{index}") }))
        .collect::<Vec<_>>();
    let target = json!({ "source": "chapter.xhtml", "selector": selectors }).to_string();
    assert_eq!(
        kernel.project_annotation_target_json(&target),
        Err(KernelError::InvalidAnnotationTarget)
    );

    let mut kernel = opened_with(vec![AgentOperationKind::ResolveAnnotationTarget]);
    let selectors = (0..=MAX_ANNOTATION_SELECTOR_NODES)
        .map(|index| AnnotationSelectorNode::Resource {
            path: vec![u32::try_from(index).unwrap()],
            values: AnnotationResourceSelectorValues {},
            refinements: Vec::new(),
        })
        .collect();
    assert_failure(
        &kernel.dispatch(NavigatorCommand::ResolveAnnotationTarget {
            plan: AnnotationTargetResolutionPlan {
                resource: "EPUB/chapter.xhtml".to_string(),
                selectors,
            },
        }),
        "invalid-command",
    );
    assert!(kernel.snapshot().pending_agent_operations.is_empty());
    assert_eq!(kernel.agent_operation, 0);
}
#[test]
fn annotation_commands_route_only_to_the_committed_primary_resource() {
    let mut kernel = opened_with(vec![
        AgentOperationKind::ResolveAnnotationTarget,
        AgentOperationKind::RelocateAnnotationTarget,
    ]);
    let plan = plan(&kernel, json!({ "source": "chapter.xhtml" }));

    let requested =
        kernel.dispatch(NavigatorCommand::ResolveAnnotationTarget { plan: plan.clone() });
    assert!(matches!(
        requested.effects.as_slice(),
        [KernelEffect::AgentRequest {
            participant: ActiveDocumentParticipant::Primary { .. },
            request: AgentRequest::ResolveAnnotationTarget { .. },
            ..
        }]
    ));

    let wrong_resource = AnnotationTargetResolutionPlan {
        resource: "EPUB/afterword.xhtml".to_string(),
        ..plan
    };
    assert_failure(
        &kernel.dispatch(NavigatorCommand::RelocateAnnotationTarget {
            plan: wrong_resource,
        }),
        "invalid-command",
    );
}
#[test]
fn annotation_results_are_unique_plan_subsets_with_reported_ancestors() {
    use AnnotationSelectorExecutionOutcome::{Ambiguous, Broken, Resolved, Stale};
    use AnnotationSelectorKind::{Css, Resource, TextPosition};
    let plan = AnnotationTargetResolutionPlan {
        resource: "EPUB/chapter.xhtml".to_string(),
        selectors: vec![AnnotationSelectorNode::Css {
            path: vec![0],
            values: AnnotationStringSelectorValues {
                value: ".missing".to_string(),
            },
            refinements: vec![AnnotationSelectorNode::TextPosition {
                path: vec![0, 0],
                values: AnnotationTextPositionSelectorValues {
                    start: "0".to_string(),
                    end: "1".to_string(),
                },
                refinements: Vec::new(),
            }],
        }],
    };
    let result = |outcome, reports, segment| AnnotationTargetReconciliationResult {
        outcome,
        reports,
        segment,
    };
    let broken_parent = || report(vec![0], Css, Broken, 0, None);
    let broken_child = || report(vec![0, 0], TextPosition, Broken, 0, None);
    let range = Some(ResolvedAnnotationSegment::Range {
        resource: "EPUB/chapter.xhtml".to_string(),
    });
    let parent_only = result(Broken, vec![broken_parent()], None);

    for valid in [
        parent_only.clone(),
        result(
            Stale,
            vec![
                report(vec![0], Css, Stale, 1, element()),
                report(vec![0, 0], TextPosition, Stale, 1, range),
            ],
            None,
        ),
        result(
            Resolved,
            vec![report(vec![0], Css, Ambiguous, 2, element())],
            element(),
        ),
    ] {
        assert_eq!(valid.validate("EPUB/chapter.xhtml", &plan), Ok(()));
    }
    for invalid in [
        result(Broken, vec![broken_parent(), broken_parent()], None),
        result(
            Broken,
            vec![report(vec![0], Resource, Broken, 0, None)],
            None,
        ),
        result(Resolved, vec![broken_parent()], None),
        result(
            Broken,
            vec![report(vec![0], Css, Resolved, 1, element())],
            None,
        ),
        result(Broken, vec![broken_parent(), broken_child()], None),
    ] {
        assert_eq!(
            invalid.validate("EPUB/chapter.xhtml", &plan),
            Err(KernelError::InvalidAnnotationTarget)
        );
    }

    let mut kernel = opened_with(vec![AgentOperationKind::ResolveAnnotationTarget]);
    let requested =
        kernel.dispatch(NavigatorCommand::ResolveAnnotationTarget { plan: plan.clone() });
    let (operation, _) = agent_request(&requested);
    assert!(
        agent_result(
            &mut kernel,
            operation,
            AgentResult::ResolveAnnotationTarget {
                result: parent_only
            },
        )
        .accepted
    );

    let requested = kernel.dispatch(NavigatorCommand::ResolveAnnotationTarget { plan });
    let (operation, _) = agent_request(&requested);
    let invalid = agent_result(
        &mut kernel,
        operation,
        AgentResult::ResolveAnnotationTarget {
            result: result(Broken, vec![broken_child()], None),
        },
    );
    assert!(invalid.accepted);
    assert!(is_delivery_failure(&invalid));
    assert!(kernel.snapshot().pending_agent_operations.is_empty());
}
#[test]
fn selection_annotation_generation_preserves_authored_query_and_stack_selector_order() {
    let mut kernel = opened(
        &initialization_with(|value| {
            value["facts"]["resources"]["declarations"][0]["href"] =
                json!("chapter.xhtml?edition=author");
        }),
        0,
    );
    kernel.committed.as_mut().unwrap().supported_operations =
        vec![AgentOperationKind::GenerateAnnotationTarget];
    let (operation, _) = request_annotation_generation(
        &mut kernel,
        selection_range(0, "EPUB/chapter.xhtml"),
        AnnotationTextFragmentPolicy::Include,
    );
    let transition = agent_result(
        &mut kernel,
        operation,
        generated_candidate(AnnotationTextFragmentPolicy::Include),
    );
    let [
        KernelEvent::AnnotationTargetGenerationReported {
            outcome: AnnotationTargetGenerationOutcome::Generated { target_json },
            ..
        },
    ] = transition.events.as_slice()
    else {
        panic!("unexpected generation events: {:?}", transition.events);
    };
    let target = AnnotationTarget::parse_json(target_json).unwrap();
    assert_eq!(target.source(), Some("chapter.xhtml?edition=author"));
    let [
        AnnotationSelector::Css(css),
        AnnotationSelector::TextPosition(position),
        AnnotationSelector::Fragment(fragment),
    ] = target.selectors()
    else {
        panic!("unexpected selectors: {:?}", target.selectors());
    };
    assert!(matches!(
        css.refined_by(),
        [AnnotationSelector::TextPosition(refined)]
            if refined.start() == Some(1) && refined.end() == Some(6)
    ));
    assert_eq!((position.start(), position.end()), (Some(21), Some(26)));
    assert_eq!(
        fragment.conforms_to(),
        Some(&FragmentConformsTo::TextFragment)
    );
    assert_eq!(target.to_json_string().unwrap(), *target_json);
}
#[test]
fn malformed_or_mismatched_annotation_candidates_fail_without_public_json() {
    let mut kernel = opened_with(vec![AgentOperationKind::GenerateAnnotationTarget]);
    let candidate = |local_content_basis, status| AgentResult::GenerateAnnotationTarget {
        candidate: AnnotationTargetGenerationCandidate {
            local_content_basis,
            text_fragment_policy: AnnotationTextFragmentPolicy::Include,
            status,
        },
    };
    let generated = |document, text_fragment: Option<&str>| {
        AnnotationTargetGenerationCandidateStatus::Generated {
            selectors: AnnotationSelectorCandidate {
                css: None,
                document,
                text_fragment: text_fragment.map(str::to_string),
            },
        }
    };

    for result in [
        candidate(99, AnnotationTargetGenerationCandidateStatus::Unsupported),
        candidate(12, generated(None, Some("text=hello"))),
        candidate(
            12,
            generated(
                Some(AnnotationDocumentRangeCandidate {
                    start: "01".to_string(),
                    end: "2".to_string(),
                }),
                None,
            ),
        ),
    ] {
        let (operation, _) = request_annotation_generation(
            &mut kernel,
            selection_range(0, "EPUB/chapter.xhtml"),
            AnnotationTextFragmentPolicy::Include,
        );
        assert!(is_delivery_failure(&agent_result(
            &mut kernel,
            operation,
            result
        )));
    }
}
