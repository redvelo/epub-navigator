use super::support::*;
use crate::kernel::*;
use serde_json::json;

#[test]
fn decoration_projection_rejects_malformed_duplicate_and_stale_inputs() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    for invalid in [
        vec![DecorationRecord {
            target_json: "{".to_string(),
            ..decoration("bad", 0, "chapter.xhtml")
        }],
        vec![
            decoration("same", 0, "chapter.xhtml"),
            decoration("same", 0, "chapter.xhtml"),
        ],
    ] {
        assert!(!set_decorations(&mut kernel, 1, invalid).accepted);
    }
    assert!(
        set_decorations(
            &mut kernel,
            1,
            vec![decoration("valid", 0, "chapter.xhtml")]
        )
        .accepted
    );
    assert!(!set_decorations(&mut kernel, 1, Vec::new()).accepted);
    assert_eq!(kernel.snapshot().decorations.projection.records.len(), 1);
}
#[test]
fn decoration_projection_derives_only_unambiguous_document_text_order() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    let record = |id: &str, direct_starts: &[u64], refined_start: Option<u64>| {
        let mut selectors = direct_starts
            .iter()
            .map(
                |start| json!({ "type": "TextPositionSelector", "start": start, "end": start + 5 }),
            )
            .collect::<Vec<_>>();
        if let Some(start) = refined_start {
            selectors.insert(
                0,
                json!({
                    "type": "CssSelector",
                    "value": ".choice",
                    "refinedBy": [{ "type": "TextPositionSelector", "start": start, "end": start + 2 }]
                }),
            );
        }
        DecorationRecord {
            target_json: json!({ "source": "chapter.xhtml", "selector": selectors }).to_string(),
            ..decoration(id, 0, "chapter.xhtml")
        }
    };
    let position = |id: &str, start: Option<&str>| DecorationRecordPosition {
        id: id.to_string(),
        occurrence: 0,
        document_text_start: start.map(str::to_string),
    };

    assert!(
        set_decorations(
            &mut kernel,
            1,
            vec![
                record("ordered", &[21], Some(1)),
                record("refined-only", &[], Some(7)),
                record("conflicting", &[9, 12], None),
                record("large", &[9007199254740993], None),
            ],
        )
        .accepted
    );
    assert_eq!(
        kernel.snapshot().decorations.record_positions,
        vec![
            position("ordered", Some("21")),
            position("refined-only", None),
            position("conflicting", None),
            position("large", Some("9007199254740993")),
        ]
    );
}
#[test]
fn decoration_projection_requests_only_current_occurrence_plans() {
    let mut kernel = opened_with(vec![AgentOperationKind::ReconcileDecorations]);
    let transition = set_decorations(
        &mut kernel,
        1,
        vec![
            decoration("current", 0, "chapter.xhtml"),
            decoration("later", 5, "afterword.xhtml"),
        ],
    );
    assert!(matches!(
        transition.effects.as_slice(),
        [KernelEffect::AgentRequest {
            request: AgentRequest::ReconcileDecorations {
                projection_revision: 1,
                records,
            },
            ..
        }] if matches!(
            records.as_slice(),
            [record] if record.id == "current" && record.plan.resource == "EPUB/chapter.xhtml"
        )
    ));
}
#[test]
fn forged_decoration_result_fails_the_pending_operation() {
    let mut kernel = opened_with(vec![AgentOperationKind::ReconcileDecorations]);
    let requested = set_decorations(
        &mut kernel,
        1,
        vec![decoration("expected", 0, "chapter.xhtml")],
    );
    let (operation, _) = agent_request(&requested);
    let forged = agent_result(
        &mut kernel,
        operation,
        AgentResult::ReconcileDecorations {
            projection_revision: 1,
            outcomes: vec![DecorationRecordResult {
                id: "forged".to_string(),
                outcome: DecorationRecordOutcome::Rendered,
            }],
        },
    );
    assert!(forged.accepted);
    assert!(matches!(
        forged.events.as_slice(),
        [KernelEvent::AgentOperationFailed {
            operation_kind: AgentOperationKind::ReconcileDecorations,
            ..
        }]
    ));
    assert!(
        kernel
            .snapshot()
            .decorations
            .participant_outcomes
            .is_empty()
    );
}
#[test]
fn newer_decoration_projection_supersedes_pending_reconciliation() {
    let mut kernel = opened_with(vec![AgentOperationKind::ReconcileDecorations]);
    set_decorations(&mut kernel, 1, vec![decoration("old", 0, "chapter.xhtml")]);
    let superseding = set_decorations(&mut kernel, 2, Vec::new());
    assert!(matches!(
        superseding.events.as_slice(),
        [KernelEvent::AgentOperationFailed {
            failure: AgentOperationFailure::OperationCancelled {
                reason: AgentOperationCancellationReason::ProjectionSuperseded
            },
            ..
        }]
    ));
    assert!(matches!(
        superseding.effects.as_slice(),
        [KernelEffect::AgentRequest {
            request: AgentRequest::ReconcileDecorations {
                projection_revision: 2,
                records,
            },
            ..
        }] if records.is_empty()
    ));
}
