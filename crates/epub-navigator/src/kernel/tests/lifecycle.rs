use super::support::*;
use crate::kernel::*;
use serde_json::json;

fn chapter_frame(generation: u32) -> PhysicalFrame {
    PhysicalFrame {
        generation,
        occurrence: 0,
        resource: "EPUB/chapter.xhtml".to_string(),
        adapter: DocumentAdapter::ReflowableXhtml,
    }
}
fn replace_frame(generation: u32, occurrence: u32) -> KernelEffect {
    KernelEffect::ReplaceFrame {
        generation,
        occurrence,
        resource: "EPUB/chapter.xhtml".to_string(),
    }
}

#[test]
fn replacement_retains_committed_frame_and_rejects_stale_layout() {
    let mut kernel = opened(&initialization(), 0);
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 1 });
    load(&mut kernel, 2);
    assert!(!report_layout(&mut kernel, 1, settled_result).accepted);
    assert_eq!(
        kernel
            .snapshot()
            .document
            .committed
            .unwrap()
            .frame_generation(),
        1
    );
}
#[test]
fn backward_entry_uses_document_end_anchor() {
    let mut kernel = opened(&initialization(), 1);
    kernel.dispatch(NavigatorCommand::Previous {});
    assert!(matches!(
        load(&mut kernel, 2).effects.as_slice(),
        [KernelEffect::LayoutRequest {
            request: LayoutRequest::ReflowableXhtml {
                position: ReflowPositionRequest::Entry {
                    entry: DocumentEntry::End
                },
                ..
            },
            ..
        }]
    ));
}
#[test]
fn kernel_opens_validates_and_closes_deterministically() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    assert_eq!(kernel.snapshot().reading_order_length, 10);

    let validate = |kernel: &mut NavigatorKernel, occurrence| {
        kernel
            .dispatch(NavigatorCommand::ValidateLocator {
                locator: locator(occurrence, "EPUB/chapter.xhtml"),
            })
            .accepted
    };
    assert!(validate(&mut kernel, 0));
    assert!(!validate(&mut kernel, 5));

    let closed = kernel.dispatch(NavigatorCommand::Close {});
    assert!(closed.accepted);
    assert_eq!(closed.state_revision, 2);
    assert_eq!(kernel.snapshot().session, SessionState::Closed);
    assert!(!kernel.dispatch(NavigatorCommand::Close {}).accepted);
}
#[test]
fn open_commit_and_duplicate_navigation_use_distinct_generations() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    let opened = kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 0 });
    assert_eq!(opened.effects, vec![replace_frame(1, 0)]);
    assert_eq!(kernel.snapshot().document.committed, None);
    assert_eq!(kernel.snapshot().document.pending.unwrap().generation, 1);

    let loaded = kernel.dispatch(FrameObservation::Loaded { generation: 1 });
    assert_eq!(
        loaded.effects,
        vec![KernelEffect::InitializeAgent {
            generation: 1,
            occurrence: 0,
            resource: "EPUB/chapter.xhtml".to_string(),
            adapter: DocumentAdapter::ReflowableXhtml,
        }]
    );
    assert_eq!(
        kernel.snapshot().document.pending.unwrap().state,
        PendingDocumentState::AgentInitializing {
            frame: chapter_frame(1),
        }
    );
    assert!(
        kernel
            .dispatch(AdapterObservation::Ready {
                generation: 1,
                supported_operations: vec![AgentOperationKind::ResolveLocator],
            })
            .accepted
    );
    assert_eq!(
        kernel.snapshot().document.pending.unwrap().state,
        PendingDocumentState::LayoutInitializing {
            frame: chapter_frame(1),
            supported_operations: vec![AgentOperationKind::ResolveLocator],
            plan: reflow_plan(ReflowableLayoutMode::Paginated),
        }
    );
    assert_eq!(kernel.snapshot().document.committed, None);
    settle_pending_layout(&mut kernel, 1);

    let next = kernel.dispatch(NavigatorCommand::Next {});
    assert_eq!(next.effects, vec![replace_frame(2, 1)]);
    let snapshot = kernel.snapshot();
    assert_eq!(snapshot.document.committed.unwrap().occurrence(), 0);
    assert_eq!(snapshot.document.pending.unwrap().frame().occurrence, 1);

    load(&mut kernel, 2);
    assert_eq!(
        settle_pending_layout(&mut kernel, 2).effects,
        vec![KernelEffect::CancelFrame { generation: 1 }]
    );
}
#[test]
fn superseding_reload_cancels_before_replacement_and_cancel_invalidates_work() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 0 });

    let reload = kernel.dispatch(NavigatorCommand::Reload {});
    assert_eq!(
        reload.effects,
        vec![
            KernelEffect::CancelFrame { generation: 1 },
            replace_frame(2, 0)
        ]
    );
    let revision = kernel.state_revision();
    assert_failure(
        &kernel.dispatch(FrameObservation::Loaded { generation: 1 }),
        "stale-observation",
    );
    assert_eq!(kernel.state_revision(), revision);
    assert_eq!(kernel.snapshot().document.pending.unwrap().generation, 2);

    let cancelled = kernel.dispatch(NavigatorCommand::CancelDocument {});
    assert_eq!(
        cancelled.effects,
        vec![KernelEffect::CancelFrame { generation: 2 }]
    );
    assert_eq!(kernel.snapshot().document.pending, None);
    assert_failure(
        &kernel.dispatch(FrameObservation::Loaded { generation: 2 }),
        "stale-observation",
    );
}
#[test]
fn stale_readiness_is_rejected_and_current_readiness_commits_capabilities() {
    let mut kernel = opened(&initialization(), 0);
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 });
    kernel.dispatch(FrameObservation::Loaded { generation: 2 });

    let before = kernel.snapshot();
    assert_failure(
        &kernel.dispatch(AdapterObservation::Ready {
            generation: 1,
            supported_operations: vec![AgentOperationKind::ResolveLocator],
        }),
        "stale-observation",
    );
    assert_eq!(kernel.snapshot(), before);

    let ready = kernel.dispatch(AdapterObservation::Ready {
        generation: 2,
        supported_operations: vec![AgentOperationKind::Relocate],
    });
    assert!(matches!(
        ready.events.as_slice(),
        [KernelEvent::LayoutPending { .. }]
    ));
    settle_pending_layout(&mut kernel, 2);
    let snapshot = kernel.snapshot();
    assert_eq!(snapshot.document.pending, None);
    let committed = snapshot.document.committed.unwrap();
    assert_eq!(committed.generation, 2);
    assert_eq!(
        committed.supported_operations,
        vec![AgentOperationKind::Relocate]
    );
}
#[test]
fn readiness_timeout_is_explicit_and_late_ready_cannot_replace_committed() {
    let mut kernel = opened(&initialization(), 0);
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 });
    kernel.dispatch(FrameObservation::Loaded { generation: 2 });

    let timeout = kernel.dispatch(AdapterObservation::ReadinessTimeout { generation: 2 });
    assert_eq!(
        timeout.events,
        vec![KernelEvent::DocumentLoadFailed {
            generation: 2,
            reason: FrameFailureReason::ReadinessTimeout,
        }]
    );
    assert_eq!(
        timeout.effects,
        vec![KernelEffect::CancelFrame { generation: 2 }]
    );
    assert_eq!(kernel.snapshot().document.committed.unwrap().generation, 1);
    assert_failure(
        &kernel.dispatch(AdapterObservation::Ready {
            generation: 2,
            supported_operations: vec![],
        }),
        "stale-observation",
    );
}
#[test]
fn unresolved_and_unavailable_occurrences_fail_without_skipping() {
    let mut kernel = opened(&initialization(), 1);
    let before = kernel.snapshot();
    assert_failure(
        &kernel.dispatch(NavigatorCommand::Next {}),
        "occurrence-unresolved",
    );
    for (occurrence, code) in [
        (3, "occurrence-unavailable"),
        (4, "occurrence-unavailable"),
        (99, "occurrence-out-of-bounds"),
    ] {
        assert_failure(
            &kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence }),
            code,
        );
    }
    assert_eq!(kernel.snapshot(), before);
}
#[test]
fn navigation_boundaries_are_explicit() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 0 });
    assert_failure(
        &kernel.dispatch(NavigatorCommand::Previous {}),
        "navigation-boundary",
    );
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 9 });
    assert_failure(
        &kernel.dispatch(NavigatorCommand::Next {}),
        "navigation-boundary",
    );
}
#[test]
fn document_generation_exhaustion_is_explicit_and_non_mutating() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    kernel.document_generation = u32::MAX;
    let before = kernel.snapshot();
    assert_failure(
        &kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 0 }),
        "document-generation-exhausted",
    );
    assert_eq!(kernel.snapshot(), before);
}
#[test]
fn exact_kernel_input_unions_reject_extra_fields() {
    assert_eq!(
        serde_json::from_value::<KernelInput>(json!({
            "type": "command",
            "command": { "type": "next" }
        }))
        .unwrap(),
        KernelInput::Command {
            command: NavigatorCommand::Next {},
        }
    );
    for input in [
        json!({ "type": "command", "command": { "type": "next" }, "extra": true }),
        json!({ "type": "command", "command": { "type": "next", "extra": true } }),
        json!({
            "type": "frame",
            "frame": {
                "type": "failed",
                "generation": 1,
                "reason": { "reason": "load-error", "extra": true }
            }
        }),
        json!({
            "type": "adapter",
            "adapter": {
                "type": "ready",
                "generation": 1,
                "supportedOperations": [],
                "extra": true
            }
        }),
    ] {
        assert!(serde_json::from_value::<KernelInput>(input).is_err());
    }
}
#[test]
fn rapid_navigation_uses_pending_destination_and_orders_lifecycle_output() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 0 });
    let transition = kernel.dispatch(NavigatorCommand::Next {});
    assert_eq!(
        transition.events,
        vec![
            KernelEvent::DocumentCancelled { generation: 1 },
            KernelEvent::DocumentPending {
                generation: 2,
                occurrence: 1,
                resource: "EPUB/chapter.xhtml".to_string(),
            },
        ]
    );
    assert_eq!(
        transition.effects,
        vec![
            KernelEffect::CancelFrame { generation: 1 },
            replace_frame(2, 1)
        ]
    );
    assert_eq!(kernel.current_occurrence(), Some(1));
}
#[test]
fn typed_frame_failure_is_reported_and_preserves_committed_document() {
    let mut kernel = opened(&initialization(), 0);
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 1 });
    let reason = FrameFailureReason::EffectExecutionFailed {
        message: "frame replacement failed".to_string(),
    };
    let transition = kernel.dispatch(FrameObservation::Failed {
        generation: 2,
        reason: reason.clone(),
    });
    assert_eq!(
        transition.events,
        vec![KernelEvent::DocumentLoadFailed {
            generation: 2,
            reason,
        }]
    );
    assert_eq!(
        transition.effects,
        vec![KernelEffect::CancelFrame { generation: 2 }]
    );
    let snapshot = kernel.snapshot();
    assert_eq!(snapshot.document.pending, None);
    assert_eq!(snapshot.document.committed.unwrap().generation, 1);
}
#[test]
fn mount_requires_an_absolute_base_and_a_known_content_origin_profile() {
    let mount = PublicationMount {
        base_url: "relative/path/".to_string(),
        remote_resources: RemoteResourcePolicy::Blocked,
        content_origin: ContentOriginProfile::SharedReaderOrigin,
    };
    assert_eq!(mount.validate(), Err(KernelError::InvalidMount));

    let create = |base_url: &str, content_origin: Option<&str>| {
        NavigatorKernel::create(&initialization_with(|value| {
            value["mount"]["baseUrl"] = json!(base_url);
            match content_origin {
                Some(content_origin) => value["mount"]["contentOrigin"] = json!(content_origin),
                None => {
                    value["mount"]
                        .as_object_mut()
                        .unwrap()
                        .remove("contentOrigin");
                }
            }
        }))
        .map(|_| ())
    };
    let book = "https://reader.example/publications/book/";
    let root = "https://publication.example/";
    for (base_url, content_origin, expected) in [
        (book, Some("shared-reader-origin"), Ok(())),
        (root, Some("isolated-publication-origin"), Ok(())),
        (
            book,
            Some("isolated-publication-origin"),
            Err(KernelError::InvalidMount),
        ),
        (root, None, Err(KernelError::InvalidInitialization)),
        (
            root,
            Some("opaque-origin"),
            Err(KernelError::InvalidInitialization),
        ),
    ] {
        assert_eq!(
            create(base_url, content_origin),
            expected,
            "{content_origin:?}"
        );
    }
}
#[test]
fn cancelled_generation_rejects_stale_browser_candidate() {
    let mut kernel = opened_with(vec![AgentOperationKind::GenerateAnnotationTarget]);
    let (operation, _) = request_annotation_generation(
        &mut kernel,
        selection_range(0, "EPUB/chapter.xhtml"),
        AnnotationTextFragmentPolicy::Include,
    );
    let cancellation = invalidate_primary(&mut kernel, LayoutInvalidationCause::Viewport);
    assert!(cancellation.events.iter().any(|event| matches!(
        event,
        KernelEvent::AgentOperationFailed {
            operation: cancelled,
            operation_kind: AgentOperationKind::GenerateAnnotationTarget,
            failure: AgentOperationFailure::OperationCancelled { .. },
            ..
        } if *cancelled == operation
    )));
    assert!(kernel.pending_operations.is_empty());
    assert_failure(
        &agent_result(
            &mut kernel,
            operation,
            generated_candidate(AnnotationTextFragmentPolicy::Include),
        ),
        "stale-agent-operation-observation",
    );
}
