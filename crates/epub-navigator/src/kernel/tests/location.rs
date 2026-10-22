use super::support::*;
use crate::kernel::*;

fn resolved() -> AgentResult {
    AgentResult::ResolveLocator {
        status: LocatorResolutionStatus::Resolved,
    }
}
fn resolve_current(kernel: &mut NavigatorKernel) -> KernelTransition {
    kernel.dispatch(NavigatorCommand::ResolveLocator {
        locator: locator(0, "EPUB/chapter.xhtml"),
    })
}
fn cancelled(operation: u32, reason: AgentOperationCancellationReason) -> KernelEvent {
    KernelEvent::AgentOperationFailed {
        participant: primary(1),
        operation,
        generation: 1,
        operation_kind: AgentOperationKind::ResolveLocator,
        failure: AgentOperationFailure::OperationCancelled { reason },
    }
}

#[test]
fn locator_resolution_requires_and_tracks_the_committed_generation() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    assert_failure(&resolve_current(&mut kernel), "no-current-document");
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 0 });
    kernel.dispatch(FrameObservation::Loaded { generation: 1 });
    assert_failure(&resolve_current(&mut kernel), "no-current-document");
    kernel.dispatch(AdapterObservation::Ready {
        generation: 1,
        supported_operations: vec![AgentOperationKind::ResolveLocator],
    });
    settle_pending_layout(&mut kernel, 1);
    assert_failure(
        &agent_result(&mut kernel, 1, resolved()),
        "stale-agent-operation-observation",
    );

    assert_eq!(
        resolve_current(&mut kernel).effects,
        vec![KernelEffect::AgentRequest {
            participant: primary(1),
            operation: 1,
            generation: 1,
            request: AgentRequest::ResolveLocator {
                locator: locator(0, "EPUB/chapter.xhtml"),
            },
        }]
    );
    assert_eq!(resolve_current(&mut kernel).effects.len(), 1);
    assert!(
        agent_result(
            &mut kernel,
            1,
            AgentResult::ResolveLocator {
                status: LocatorResolutionStatus::UnsupportedEvidence {
                    message: "unsupported evidence".to_string(),
                },
            },
        )
        .accepted
    );
    assert_failure(
        &agent_result(&mut kernel, 1, resolved()),
        "stale-agent-operation-observation",
    );
}
#[test]
fn close_cancels_pending_work_before_frames_and_rejects_later_observations() {
    let mut kernel = opened(&initialization(), 0);
    resolve_current(&mut kernel);
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 1 });
    let closed = kernel.dispatch(NavigatorCommand::Close {});

    assert_eq!(
        closed.events,
        vec![
            cancelled(1, AgentOperationCancellationReason::Close),
            KernelEvent::DocumentCancelled { generation: 2 },
            KernelEvent::Closed,
        ]
    );
    assert_eq!(
        closed.effects,
        vec![
            KernelEffect::CancelFrame { generation: 2 },
            KernelEffect::CancelFrame { generation: 1 },
        ]
    );
    let snapshot = kernel.snapshot();
    assert_eq!(snapshot.session, SessionState::Closed);
    assert_eq!(snapshot.document.pending, None);
    assert_eq!(snapshot.document.committed, None);
    assert_failure(
        &kernel.dispatch(FrameObservation::Loaded { generation: 1 }),
        "kernel-closed",
    );
}
#[test]
fn replacement_commit_cancels_old_generation_operation() {
    let mut kernel = opened(&initialization(), 0);
    resolve_current(&mut kernel);
    let transition = kernel.dispatch(NavigatorCommand::Next {});
    assert_eq!(
        transition.events,
        vec![KernelEvent::DocumentPending {
            generation: 2,
            occurrence: 1,
            resource: "EPUB/chapter.xhtml".to_string(),
        }]
    );
    assert_eq!(kernel.snapshot().pending_agent_operations.len(), 1);

    load(&mut kernel, 2);
    assert!(matches!(
        settle_pending_layout(&mut kernel, 2).events.as_slice(),
        [
            KernelEvent::LayoutReported { generation: 2, .. },
            event,
            KernelEvent::DocumentCommitted { generation: 2, .. }
        ] if *event == cancelled(1, AgentOperationCancellationReason::Replacement)
    ));
    assert!(kernel.snapshot().pending_agent_operations.is_empty());
}
#[test]
fn document_observation_is_validated_retained_and_generation_owned() {
    let mut kernel = opened(&initialization(), 0);
    let mut observation = document_observation();
    observation.pagination = Some(PaginationObservation {
        first_visible_page: 2,
        page_count: 3,
        visible_page_count: 1,
    });
    assert_eq!(
        observe(&mut kernel, observation.clone()).events,
        vec![KernelEvent::DocumentObserved {
            participant: primary(1),
            generation: 1,
            observation: observation.clone(),
        }]
    );
    assert_eq!(
        kernel.committed.as_ref().unwrap().layout.observation(),
        &observation
    );

    let before = kernel.snapshot();
    assert_failure(
        &kernel.dispatch(AdapterObservation::DocumentObserved {
            participant: primary(1),
            generation: 2,
            observation: document_observation(),
        }),
        "stale-observation",
    );
    assert_eq!(kernel.snapshot(), before);

    fn pagination(
        first_visible_page: u32,
        page_count: u32,
        visible_page_count: u32,
    ) -> Option<PaginationObservation> {
        Some(PaginationObservation {
            first_visible_page,
            page_count,
            visible_page_count,
        })
    }
    let invalid: [fn(&mut DocumentObservation); 6] = [
        |observation| observation.viewport.width = f64::NAN,
        |observation| observation.visible_start = ObservedBoundary::Located { evidence: vec![] },
        |observation| {
            observation.canvas = DocumentCanvas::SolidColor {
                css_color: "x".repeat(257),
            }
        },
        |observation| observation.pagination = pagination(4, 5, 2),
        |observation| observation.pagination = pagination(0, 4, 1),
        |observation| observation.pagination = pagination(0, 3, 2),
    ];
    for edit in invalid {
        let mut observation = document_observation();
        edit(&mut observation);
        assert_failure(
            &observe(&mut kernel, observation),
            "invalid-document-observation",
        );
    }
    let mut unavailable = document_observation();
    unavailable.visible_start = ObservedBoundary::Unavailable;
    unavailable.visible_end = ObservedBoundary::Unavailable;
    assert!(observe(&mut kernel, unavailable).accepted);
}
#[test]
fn link_activation_is_raw_evidence_from_only_the_committed_generation() {
    let mut kernel = opened(&initialization(), 0);
    let activation = LinkActivation {
        href: "afterword.xhtml#note".to_string(),
        resolved_url: "https://reader.example/publications/book/EPUB/afterword.xhtml#note"
            .to_string(),
        target: Some("_blank".to_string()),
        download: None,
    };
    let transition = kernel.dispatch(AdapterObservation::LinkActivated {
        participant: primary(1),
        generation: 1,
        activation: activation.clone(),
    });
    assert_eq!(
        transition.events,
        vec![KernelEvent::LinkActivated {
            participant: primary(1),
            activation: activation.clone(),
        }]
    );
    assert!(transition.effects.is_empty());
    assert_failure(
        &kernel.dispatch(AdapterObservation::LinkActivated {
            participant: primary(1),
            generation: 2,
            activation,
        }),
        "stale-observation",
    );
}
#[test]
fn relocation_validates_context_and_matches_result_kind_or_timeout() {
    let mut kernel = opened(&initialization(), 0);
    let destination = locator(0, "EPUB/chapter.xhtml");
    let relocate = NavigatorCommand::Relocate {
        locator: destination.clone(),
    };
    assert_eq!(
        kernel.dispatch(relocate.clone()).effects,
        vec![KernelEffect::AgentRequest {
            participant: primary(1),
            operation: 1,
            generation: 1,
            request: AgentRequest::Relocate {
                locator: destination,
            },
        }]
    );
    assert_failure(
        &agent_result(&mut kernel, 1, resolved()),
        "stale-agent-operation-observation",
    );
    let relocated = AgentResult::Relocate {
        status: LocatorResolutionStatus::Resolved,
    };
    assert_eq!(
        agent_result(&mut kernel, 1, relocated.clone()).events,
        vec![KernelEvent::AgentOperationReported {
            participant: primary(1),
            operation: 1,
            generation: 1,
            result: relocated,
        }]
    );

    kernel.dispatch(relocate);
    let timeout = kernel.dispatch(AdapterObservation::OperationTimeout {
        participant: primary(1),
        operation: 2,
        generation: 1,
    });
    assert!(matches!(
        timeout.events.as_slice(),
        [KernelEvent::AgentOperationFailed {
            operation_kind: AgentOperationKind::Relocate,
            failure: AgentOperationFailure::OperationTimeout { .. },
            ..
        }]
    ));
    assert_failure(
        &kernel.dispatch(NavigatorCommand::Relocate {
            locator: locator(5, "EPUB/afterword.xhtml"),
        }),
        "invalid-locator",
    );
}
#[test]
fn exact_committed_invalidation_cancels_locator_and_frame_but_keeps_session_open() {
    let mut kernel = opened(&initialization(), 0);
    resolve_current(&mut kernel);
    observe(&mut kernel, document_observation());
    let transition = kernel.dispatch(AdapterObservation::DocumentInvalidated {
        participant: primary(1),
        generation: 1,
        reason: DocumentInvalidationReason::UnexpectedNavigation,
    });
    assert_eq!(
        transition.events,
        vec![
            KernelEvent::DocumentInvalidated {
                participant: primary(1),
                generation: 1,
                reason: DocumentInvalidationReason::UnexpectedNavigation,
            },
            cancelled(1, AgentOperationCancellationReason::DocumentInvalidated),
        ]
    );
    assert_eq!(
        transition.effects,
        vec![KernelEffect::CancelFrame { generation: 1 }]
    );
    let snapshot = kernel.snapshot();
    assert_eq!(snapshot.session, SessionState::Open);
    assert_eq!(snapshot.document.committed, None);
    assert!(snapshot.pending_agent_operations.is_empty());
}
#[test]
fn revision_and_locator_operation_exhaustion_are_non_mutating() {
    let mut revision = NavigatorKernel::create(&initialization()).unwrap();
    revision.state_revision = u32::MAX - 1;
    let before = revision.snapshot();
    assert_failure(
        &revision.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 0 }),
        "state-revision-exhausted",
    );
    assert_eq!(revision.snapshot(), before);

    let closed = revision.dispatch(NavigatorCommand::Close {});
    assert!(closed.accepted);
    assert_eq!(closed.state_revision, u32::MAX);
    assert_eq!(revision.snapshot().session, SessionState::Closed);
    assert_failure(
        &revision.dispatch(NavigatorCommand::Close {}),
        "state-revision-exhausted",
    );

    let mut exhausted = opened(&initialization(), 0);
    exhausted.agent_operation = u32::MAX;
    let before = exhausted.snapshot();
    assert_failure(
        &resolve_current(&mut exhausted),
        "agent-operation-exhausted",
    );
    assert_eq!(exhausted.snapshot(), before);
}
