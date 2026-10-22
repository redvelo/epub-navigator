use super::support::*;
use crate::kernel::*;
use serde_json::json;

fn capture(kernel: &mut NavigatorKernel) -> KernelTransition {
    kernel.dispatch(NavigatorCommand::CaptureSelection {
        participant: primary(1),
    })
}
fn capture_result(
    kernel: &mut NavigatorKernel,
    operation: u32,
    outcome: NativeSelectionCaptureOutcome,
) -> KernelTransition {
    agent_result(kernel, operation, AgentResult::CaptureSelection { outcome })
}
fn captured_range(
    outcome: &mut NativeSelectionCaptureOutcome,
) -> (&mut u32, &mut String, &mut Vec<RangeEvidence>) {
    let NativeSelectionCaptureOutcome::Captured {
        location:
            NavigatorLocation::Range {
                occurrence,
                resource,
                evidence,
                ..
            },
        ..
    } = outcome
    else {
        unreachable!()
    };
    (occurrence, resource, evidence)
}

#[test]
fn selection_generation_can_be_cancelled_when_selection_is_superseded() {
    let mut kernel = opened_with(vec![AgentOperationKind::GenerateAnnotationTarget]);
    request_annotation_generation(
        &mut kernel,
        selection_range(0, "EPUB/chapter.xhtml"),
        AnnotationTextFragmentPolicy::Include,
    );
    let cancelled = kernel.dispatch(NavigatorCommand::CancelSelectionAnnotationTargetGeneration {});
    assert!(matches!(
        cancelled.events.as_slice(),
        [KernelEvent::AgentOperationFailed {
            failure: AgentOperationFailure::OperationCancelled {
                reason: AgentOperationCancellationReason::SelectionSuperseded
            },
            ..
        }]
    ));
    assert!(kernel.pending_operations.is_empty());
}
#[test]
fn selection_capture_types_have_exact_json_and_validate_decimal_offsets() {
    for (value, expected) in [
        (
            serde_json::to_value(PointEvidence::BrowserTextPosition {
                offset: u64::MAX.to_string(),
            }),
            json!({ "kind": "browser-text-position", "offset": "18446744073709551615" }),
        ),
        (
            serde_json::to_value(NavigatorCommand::CaptureSelection {
                participant: primary(4),
            }),
            json!({
                "type": "capture-selection",
                "participant": { "kind": "primary", "documentGeneration": 4 }
            }),
        ),
        (
            serde_json::to_value(AgentRequest::CaptureSelection {}),
            json!({ "type": "capture-selection" }),
        ),
        (
            serde_json::to_value(NavigatorCommand::CaptureCurrentLocation {}),
            json!({ "type": "capture-current-location" }),
        ),
        (
            serde_json::to_value(NativeSelectionCaptureOutcome::Unavailable {
                reason: NativeSelectionCaptureReason::DocumentInactive,
                basis: SelectionCaptureBasis {
                    participant: primary(4),
                    frame_generation: 9,
                    layout_generation: 2,
                    local_content_basis: 12,
                    local_geometry_basis: 7,
                },
            }),
            json!({
                "status": "unavailable",
                "reason": "document-inactive",
                "basis": {
                    "participant": { "kind": "primary", "documentGeneration": 4 },
                    "frameGeneration": 9,
                    "layoutGeneration": 2,
                    "localContentBasis": 12,
                    "localGeometryBasis": 7
                }
            }),
        ),
    ] {
        assert_eq!(value.unwrap(), expected);
    }

    let point = |offset: &str, layout_progression| NavigatorLocation::Point {
        occurrence: 0,
        resource: "EPUB/chapter.xhtml".to_string(),
        evidence: vec![PointEvidence::BrowserTextPosition {
            offset: offset.to_string(),
        }],
        observation: LocatorObservation {
            layout_progression,
            rendered_text_progression: None,
        },
    };
    let mut invalid = vec![point("1", Some(f64::NAN))];
    invalid
        .extend(["", "00", "+1", "-1", "18446744073709551616"].map(|offset| point(offset, None)));
    for (start, end) in [("1", "1"), ("2", "1"), ("01", "2")] {
        let mut range = selection_range(0, "EPUB/chapter.xhtml");
        let NavigatorLocation::Range { evidence, .. } = &mut range else {
            unreachable!()
        };
        evidence[0] = RangeEvidence::BrowserTextPosition {
            start: start.to_string(),
            end: end.to_string(),
        };
        invalid.push(range);
    }
    for location in invalid {
        assert_eq!(location.validate(), Err(KernelError::InvalidLocator));
    }
}
#[test]
fn selection_capture_routes_to_primary_and_fixed_companion() {
    assert_failure(
        &capture(&mut opened(&initialization(), 0)),
        "invalid-command",
    );
    let mut kernel = opened_with(vec![AgentOperationKind::CaptureSelection]);
    assert_eq!(
        capture(&mut kernel).effects,
        vec![KernelEffect::AgentRequest {
            participant: primary(1),
            operation: 1,
            generation: 1,
            request: AgentRequest::CaptureSelection {},
        }]
    );
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 });
    assert_failure(&capture(&mut kernel), "invalid-command");

    let (mut kernel, companion) = attach_fixed_companion(&initialization_with_fixed_pair(), 0);
    kernel
        .fixed_companion
        .as_mut()
        .unwrap()
        .supported_operations
        .push(AgentOperationKind::CaptureSelection);
    assert!(matches!(
        kernel
            .dispatch(NavigatorCommand::CaptureSelection {
                participant: companion,
            })
            .effects
            .as_slice(),
        [KernelEffect::AgentRequest {
            participant,
            generation: 2,
            request: AgentRequest::CaptureSelection {},
            ..
        }] if *participant == companion
    ));
    assert_failure(
        &kernel.dispatch(NavigatorCommand::CaptureSelection {
            participant: primary(99),
        }),
        "invalid-command",
    );
}
#[test]
fn media_overlay_entry_lookup_is_settled_primary_layout_owned() {
    let mut kernel = opened_with(vec![AgentOperationKind::FindMediaOverlayEntry]);
    let fragments = vec!["a".to_string(), "b".to_string()];
    let find = |occurrence, fragments| NavigatorCommand::FindMediaOverlayEntry {
        occurrence,
        fragments,
    };
    let found = |index| AgentResult::FindMediaOverlayEntry {
        outcome: MediaOverlayEntryOutcome::Found { index },
    };
    assert_failure(
        &kernel.dispatch(find(1, fragments.clone())),
        "invalid-command",
    );
    assert_failure(&kernel.dispatch(find(0, Vec::new())), "invalid-command");
    assert_eq!(
        kernel.dispatch(find(0, fragments.clone())).effects,
        vec![KernelEffect::AgentRequest {
            participant: primary(1),
            operation: 1,
            generation: 1,
            request: AgentRequest::FindMediaOverlayEntry {
                fragments: fragments.clone(),
            },
        }]
    );
    assert!(is_delivery_failure(&agent_result(&mut kernel, 1, found(2))));

    kernel.dispatch(find(0, fragments));
    assert!(matches!(
        agent_result(&mut kernel, 2, found(1)).events.as_slice(),
        [KernelEvent::AgentOperationReported { result, .. }] if *result == found(1)
    ));
}
#[test]
fn current_location_capture_is_settled_primary_layout_owned() {
    assert_failure(
        &opened(&initialization(), 0).dispatch(NavigatorCommand::CaptureCurrentLocation {}),
        "invalid-command",
    );
    let mut kernel = opened_with(vec![AgentOperationKind::CaptureCurrentLocation]);
    assert_eq!(
        kernel
            .dispatch(NavigatorCommand::CaptureCurrentLocation {})
            .effects,
        vec![KernelEffect::AgentRequest {
            participant: primary(1),
            operation: 1,
            generation: 1,
            request: AgentRequest::CaptureCurrentLocation {},
        }]
    );
    let layout_generation = kernel
        .committed
        .as_ref()
        .unwrap()
        .layout
        .layout()
        .layout_generation;
    let basis = |layout_generation| CurrentLocationCaptureBasis {
        document_generation: 1,
        frame_generation: 1,
        layout_generation,
        local_content_basis: 2,
        local_geometry_basis: 3,
    };
    let reported = agent_result(
        &mut kernel,
        1,
        AgentResult::CaptureCurrentLocation {
            outcome: CurrentLocationCaptureOutcome::Unavailable {
                basis: basis(layout_generation),
            },
        },
    );
    assert!(matches!(
        reported.events.as_slice(),
        [KernelEvent::AgentOperationReported {
            result: AgentResult::CaptureCurrentLocation { .. },
            ..
        }]
    ));

    kernel.dispatch(NavigatorCommand::CaptureCurrentLocation {});
    assert!(is_delivery_failure(&agent_result(
        &mut kernel,
        2,
        AgentResult::CaptureCurrentLocation {
            outcome: CurrentLocationCaptureOutcome::Stale {
                basis: basis(layout_generation + 1),
            },
        },
    )));
}
#[test]
fn captured_selection_requires_matching_kind_range_context_and_basis() {
    let mut kernel = opened_with(vec![AgentOperationKind::CaptureSelection]);
    capture(&mut kernel);
    assert_failure(
        &agent_result(
            &mut kernel,
            1,
            AgentResult::Relocate {
                status: LocatorResolutionStatus::Resolved,
            },
        ),
        "stale-agent-operation-observation",
    );
    let outcome = captured_selection(&kernel, primary(1));
    assert!(matches!(
        capture_result(&mut kernel, 1, outcome).events.as_slice(),
        [KernelEvent::AgentOperationReported {
            result: AgentResult::CaptureSelection {
                outcome: NativeSelectionCaptureOutcome::Captured { .. }
            },
            ..
        }]
    ));

    let edits: [fn(&mut NativeSelectionCaptureOutcome); 4] = [
        |outcome| {
            if let NativeSelectionCaptureOutcome::Captured { location, .. } = outcome {
                *location = locator(0, "EPUB/chapter.xhtml");
            }
        },
        |outcome| *captured_range(outcome).0 = 5,
        |outcome| *captured_range(outcome).1 = "EPUB/afterword.xhtml".to_string(),
        |outcome| {
            if let NativeSelectionCaptureOutcome::Captured { basis, .. } = outcome {
                basis.layout_generation += 1;
            }
        },
    ];
    for (operation, edit) in (2..).zip(edits) {
        let mut outcome = captured_selection(&kernel, primary(1));
        edit(&mut outcome);
        capture(&mut kernel);
        assert!(is_delivery_failure(&capture_result(
            &mut kernel,
            operation,
            outcome
        )));
    }
}
#[test]
fn selection_capture_accepts_collapsed_and_other_terminal_states() {
    let mut kernel = opened_with(vec![AgentOperationKind::CaptureSelection]);
    let basis = capture_basis(&kernel, primary(1));
    let outcomes = [
        NativeSelectionCaptureOutcome::Collapsed {
            basis: basis.clone(),
        },
        NativeSelectionCaptureOutcome::Unavailable {
            reason: NativeSelectionCaptureReason::NoSelection,
            basis: basis.clone(),
        },
        NativeSelectionCaptureOutcome::Unsupported {
            basis: basis.clone(),
        },
        NativeSelectionCaptureOutcome::Ambiguous {
            basis: basis.clone(),
        },
        NativeSelectionCaptureOutcome::Conflict {
            basis: basis.clone(),
        },
        NativeSelectionCaptureOutcome::Stale {
            basis: basis.clone(),
        },
        NativeSelectionCaptureOutcome::Failed {
            message: Some("selection conversion failed".to_string()),
            basis,
        },
    ];
    for (operation, outcome) in (1..).zip(outcomes) {
        capture(&mut kernel);
        assert!(matches!(
            capture_result(&mut kernel, operation, outcome.clone()).events.as_slice(),
            [KernelEvent::AgentOperationReported {
                result: AgentResult::CaptureSelection { outcome: retained },
                ..
            }] if *retained == outcome
        ));
    }
}
#[test]
fn selection_capture_enforces_nested_evidence_string_and_geometry_limits() {
    let kernel = opened(&initialization(), 0);
    let (_, frame_generation, layout_generation, occurrence, resource) =
        kernel.selection_capture_context(primary(1)).unwrap();
    let validate = |edit: &dyn Fn(&mut NativeSelectionCaptureOutcome)| {
        let mut outcome = captured_selection(&kernel, primary(1));
        edit(&mut outcome);
        outcome.validate(
            primary(1),
            frame_generation,
            layout_generation,
            occurrence,
            resource,
        )
    };
    let quote = |bytes| RangeEvidence::RenderedTextQuote {
        exact: "x".repeat(bytes),
        prefix: String::new(),
        suffix: String::new(),
    };
    let language = |language: Option<String>| {
        move |outcome: &mut NativeSelectionCaptureOutcome| {
            if let NativeSelectionCaptureOutcome::Captured {
                language: value, ..
            } = outcome
            {
                *value = language.clone();
            }
        }
    };
    let rect = |x, width| {
        move |outcome: &mut NativeSelectionCaptureOutcome| {
            if let NativeSelectionCaptureOutcome::Captured { anchor, .. } = outcome {
                anchor.rect.x = x;
                anchor.rect.width = width;
            }
        }
    };

    assert_eq!(validate(&language(Some("fr-CA".to_string()))), Ok(()));
    assert_eq!(validate(&rect(-1.0, 30.0)), Ok(()));
    let invalid: [&dyn Fn(&mut NativeSelectionCaptureOutcome); 7] = [
        &|outcome| {
            *captured_range(outcome).2 = (0..=MAX_SELECTION_CAPTURE_EVIDENCE_ITEMS)
                .map(|_| RangeEvidence::BrowserTextPosition {
                    start: "1".to_string(),
                    end: "2".to_string(),
                })
                .collect();
        },
        &|outcome| {
            captured_range(outcome)
                .2
                .push(quote(MAX_SELECTION_CAPTURE_STRING_BYTES + 1));
        },
        &|outcome| {
            *captured_range(outcome).2 = (0..5)
                .map(|_| quote(MAX_SELECTION_CAPTURE_STRING_BYTES))
                .collect();
        },
        &language(Some(String::new())),
        &language(Some("x".repeat(MAX_SELECTION_CAPTURE_STRING_BYTES + 1))),
        &rect(10.0, -1.0),
        &rect(f64::INFINITY, 1.0),
    ];
    for edit in invalid {
        assert_eq!(validate(edit), Err(KernelError::InvalidLocator));
    }
}
