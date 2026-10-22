use super::support::*;
use crate::kernel::*;

#[test]
fn duplicate_agent_capabilities_are_rejected_before_commit() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 0 });
    kernel.dispatch(FrameObservation::Loaded { generation: 1 });
    let before = kernel.snapshot();

    assert_failure(
        &kernel.dispatch(AdapterObservation::Ready {
            generation: 1,
            supported_operations: vec![
                AgentOperationKind::ResolveLocator,
                AgentOperationKind::ResolveLocator,
            ],
        }),
        "invalid-command",
    );
    assert_eq!(kernel.snapshot(), before);
}
#[test]
fn concurrent_agent_operations_complete_independently_by_result_or_timeout() {
    let mut kernel = opened(&initialization(), 0);
    let current = locator(0, "EPUB/chapter.xhtml");
    kernel.dispatch(NavigatorCommand::ResolveLocator {
        locator: current.clone(),
    });
    kernel.dispatch(NavigatorCommand::ResolveLocator { locator: current });
    assert_eq!(kernel.snapshot().pending_agent_operations.len(), 2);

    let resolved = AgentResult::ResolveLocator {
        status: LocatorResolutionStatus::Resolved,
    };
    assert_eq!(
        agent_result(&mut kernel, 2, resolved.clone()).events,
        vec![KernelEvent::AgentOperationReported {
            participant: primary(1),
            operation: 2,
            generation: 1,
            result: resolved,
        }]
    );
    let timeout = AdapterObservation::OperationTimeout {
        participant: primary(1),
        operation: 1,
        generation: 1,
    };
    assert_eq!(
        kernel.dispatch(timeout.clone()).events,
        vec![KernelEvent::AgentOperationFailed {
            participant: primary(1),
            operation: 1,
            generation: 1,
            operation_kind: AgentOperationKind::ResolveLocator,
            failure: AgentOperationFailure::OperationTimeout {
                message: "the content-agent operation timed out".to_string(),
            },
        }]
    );
    assert!(kernel.snapshot().pending_agent_operations.is_empty());
    assert_failure(
        &kernel.dispatch(timeout),
        "stale-agent-operation-observation",
    );
}
#[test]
fn delivery_failure_terminates_only_the_exact_pending_operation() {
    let mut kernel = opened(&initialization(), 0);
    let current = locator(0, "EPUB/chapter.xhtml");
    kernel.dispatch(NavigatorCommand::ResolveLocator {
        locator: current.clone(),
    });
    kernel.dispatch(NavigatorCommand::ResolveLocator { locator: current });

    let before = kernel.snapshot();
    assert_failure(
        &kernel.dispatch(AdapterObservation::OperationDeliveryFailed {
            participant: primary(1),
            operation: 1,
            generation: 2,
            message: "wrong frame".to_string(),
        }),
        "stale-agent-operation-observation",
    );
    assert_eq!(kernel.snapshot(), before);

    let failed = kernel.dispatch(AdapterObservation::OperationDeliveryFailed {
        participant: primary(1),
        operation: 1,
        generation: 1,
        message: "message channel closed".to_string(),
    });
    assert_eq!(
        failed.events,
        vec![KernelEvent::AgentOperationFailed {
            participant: primary(1),
            operation: 1,
            generation: 1,
            operation_kind: AgentOperationKind::ResolveLocator,
            failure: AgentOperationFailure::OperationDeliveryFailed {
                message: "message channel closed".to_string(),
            },
        }]
    );
    assert!(matches!(
        kernel.snapshot().pending_agent_operations.as_slice(),
        [PendingAgentOperation { operation: 2, .. }]
    ));
}
#[test]
fn presentation_advance_is_capability_gated_and_primary_generation_owned() {
    let advance = |direction| NavigatorCommand::AdvancePresentation {
        direction,
        target: PresentationAdvanceTarget::Primary,
    };
    assert_failure(
        &opened(&initialization(), 0).dispatch(advance(PresentationAdvanceDirection::Forward)),
        "invalid-command",
    );

    let mut kernel = opened_with(vec![AgentOperationKind::AdvancePresentation]);
    let requested = kernel.dispatch(advance(PresentationAdvanceDirection::Backward));
    assert_eq!(
        requested.effects,
        vec![KernelEffect::AgentRequest {
            participant: primary(1),
            operation: 1,
            generation: 1,
            request: AgentRequest::AdvancePresentation {
                direction: PresentationAdvanceDirection::Backward,
            },
        }]
    );
    assert_eq!(
        kernel.snapshot().pending_agent_operations,
        vec![PendingAgentOperation {
            operation: 1,
            participant: primary(1),
            frame_generation: 1,
            operation_kind: AgentOperationKind::AdvancePresentation,
        }]
    );

    let advanced = AgentResult::AdvancePresentation {
        status: PresentationAdvanceStatus::Advanced,
    };
    for wrong in [
        AdapterObservation::AgentResult {
            participant: primary(1),
            operation: 1,
            generation: 1,
            result: AgentResult::Relocate {
                status: LocatorResolutionStatus::Resolved,
            },
        },
        AdapterObservation::AgentResult {
            participant: primary(1),
            operation: 1,
            generation: 2,
            result: advanced.clone(),
        },
    ] {
        assert_failure(&kernel.dispatch(wrong), "stale-agent-operation-observation");
    }
    assert!(matches!(
        agent_result(&mut kernel, 1, advanced.clone()).events.as_slice(),
        [KernelEvent::AgentOperationReported { result, .. }] if *result == advanced
    ));
    assert_failure(
        &agent_result(&mut kernel, 1, advanced),
        "stale-agent-operation-observation",
    );

    kernel.dispatch(NavigatorCommand::Next {});
    assert_failure(
        &kernel.dispatch(advance(PresentationAdvanceDirection::Forward)),
        "document-pending",
    );
}
