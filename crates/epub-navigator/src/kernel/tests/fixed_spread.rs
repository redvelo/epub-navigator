use super::support::*;
use crate::kernel::*;
use serde_json::json;

fn committed_settlement(kernel: &NavigatorKernel) -> AdapterLayoutSettlement {
    kernel
        .snapshot()
        .document
        .committed
        .unwrap()
        .layout
        .layout()
        .settlement
        .clone()
}

#[test]
fn fixed_svg_rejects_wrong_adapter_and_invalid_viewport_before_commit() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    assert!(
        kernel
            .dispatch(NavigatorCommand::OpenOccurrence { occurrence: 8 })
            .accepted
    );
    assert!(matches!(
        load(&mut kernel, 1).effects.as_slice(),
        [KernelEffect::LayoutRequest {
            request: LayoutRequest::FixedSvg,
            ..
        }]
    ));
    let pending = kernel.snapshot().layout.pending;
    let mut invalid_geometry = fixed_geometry();
    invalid_geometry.containing_viewport.width = 0.0;
    for result in [
        layout_result(
            AdapterLayoutPlan::FixedXhtml,
            settled_layout(AdapterLayoutPlan::FixedXhtml),
        ),
        LayoutResult::FixedSvg {
            outcome: FixedLayoutOutcome::Settled {
                settlement: Box::new(FixedSettlement::Contain {
                    measurement: fixed_layout_measurement(),
                    geometry: invalid_geometry.clone(),
                }),
            },
        },
    ] {
        assert_failure(
            &report_layout(&mut kernel, 1, |_| result),
            "invalid-layout-result",
        );
        assert_eq!(kernel.snapshot().layout.pending, pending);
    }

    settle_pending_layout(&mut kernel, 1);
    assert_eq!(
        kernel.snapshot().document.committed.unwrap().frame.adapter,
        DocumentAdapter::FixedSvg
    );
    assert!(matches!(
        committed_settlement(&kernel),
        AdapterLayoutSettlement::FixedSvg { .. }
    ));
}
#[test]
fn fixed_svg_update_supersedes_operations_and_rejects_stale_results() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 8 });
    commit_with_operations(
        &mut kernel,
        1,
        vec![AgentOperationKind::AdvancePresentation],
    );
    kernel.dispatch(NavigatorCommand::AdvancePresentation {
        direction: PresentationAdvanceDirection::Forward,
        target: PresentationAdvanceTarget::Primary,
    });

    let invalidated = invalidate_primary(&mut kernel, LayoutInvalidationCause::Viewport);
    assert!(invalidated.events.iter().any(|event| matches!(
        event,
        KernelEvent::AgentOperationFailed {
            operation_kind: AgentOperationKind::AdvancePresentation,
            failure: AgentOperationFailure::OperationCancelled {
                reason: AgentOperationCancellationReason::LayoutInvalidated,
            },
            ..
        }
    )));
    assert!(matches!(
        invalidated.effects.last(),
        Some(KernelEffect::LayoutRequest {
            request: LayoutRequest::FixedSvg,
            ..
        })
    ));
    let first = kernel.snapshot().layout.pending.unwrap();
    assert_eq!(first.adapter, PendingAdapterLayout::FixedSvg);

    invalidate_primary(&mut kernel, LayoutInvalidationCause::Fonts);
    let current = kernel.snapshot().layout.pending.unwrap();
    assert!(current.operation > first.operation);
    let stale = kernel.dispatch(AdapterObservation::LayoutResult {
        participant: first.participant(),
        operation: first.operation,
        generation: 1,
        layout_generation: first.layout_generation,
        result: settled_result(AdapterLayoutPlan::FixedSvg),
    });
    assert_failure(&stale, "stale-agent-operation-observation");
    assert_eq!(kernel.snapshot().layout.pending, Some(current));
    settle_pending_layout(&mut kernel, 1);
    assert!(matches!(
        committed_settlement(&kernel),
        AdapterLayoutSettlement::FixedSvg { .. }
    ));
}
#[test]
fn fixed_svg_prepares_promotes_and_advances_as_one_reading_step() {
    let mut kernel = opened(&initialization_with_fixed_adapters(true, true), 0);
    let prepared_generation = prepare(&mut kernel, 1);
    assert!(matches!(
        &kernel.snapshot().prepared_frames[0].state,
        PreparedFrameState::Prepared { layout, .. }
            if matches!(layout.settlement, AdapterLayoutSettlement::FixedSvg { .. })
    ));

    assert!(matches!(
        kernel.dispatch(NavigatorCommand::Next {}).effects.as_slice(),
        [KernelEffect::PromoteFrame { frame_generation, .. }]
            if *frame_generation == prepared_generation
    ));
    assert!(
        kernel
            .dispatch(FrameObservation::Promoted {
                frame_generation: prepared_generation,
            })
            .accepted
    );
    let committed = kernel.snapshot().document.committed.unwrap();
    assert_eq!(committed.occurrence(), 1);
    assert_eq!(committed.frame.adapter, DocumentAdapter::FixedSvg);
    assert!(matches!(
        committed_settlement(&kernel),
        AdapterLayoutSettlement::FixedSvg { .. }
    ));
}
#[test]
fn fixed_companions_accept_svg_pairs_and_both_mixed_adapter_orders() {
    for (primary_svg, companion_svg) in [(true, true), (false, true), (true, false)] {
        let (mut kernel, participant) = attach_fixed_companion(
            &initialization_with_fixed_adapters(primary_svg, companion_svg),
            0,
        );
        let snapshot = kernel.snapshot();
        let companion = snapshot.document.fixed_companion.unwrap();
        assert_eq!(
            snapshot.document.committed.unwrap().frame.adapter == DocumentAdapter::FixedSvg,
            primary_svg
        );
        assert_eq!(
            companion.frame.adapter == DocumentAdapter::FixedSvg,
            companion_svg
        );
        let FixedCompanionLayoutState::Settled { layout, .. } = companion.layout else {
            panic!("companion should be settled");
        };
        assert_eq!(
            matches!(layout.settlement, AdapterLayoutSettlement::FixedSvg { .. }),
            companion_svg
        );

        let invalidated = kernel.dispatch(AdapterObservation::LayoutInvalidated {
            participant: Some(participant),
            generation: 2,
            cause: LayoutInvalidationCause::Viewport,
        });
        assert!(matches!(
            invalidated.effects.as_slice(),
            [KernelEffect::LayoutRequest { request, .. }]
                if *request == if companion_svg { LayoutRequest::FixedSvg } else { LayoutRequest::FixedXhtml }
        ));
        settle_pending_layout(&mut kernel, 2);
    }
}
#[test]
fn fixed_svg_structural_unavailability_retains_exact_adapter() {
    for (resource, reason) in [
        (
            json!({ "presence": { "state": "missing" } }),
            OccurrenceUnavailableReason::ResourceMissing,
        ),
        (
            json!({
                "address": { "kind": "remote", "value": "https://example.test/page.svg" },
                "presence": { "state": "not-applicable" }
            }),
            OccurrenceUnavailableReason::NonLocal,
        ),
    ] {
        let initialization = initialization_with(|value| {
            for (key, field) in resource.as_object().unwrap() {
                value["facts"]["resources"]["resources"][4][key] = field.clone();
            }
        });
        let snapshot = NavigatorKernel::create(&initialization).unwrap().snapshot();
        assert!(matches!(
            snapshot.reading_order[8].document,
            OccurrenceDocumentTarget::Unavailable {
                adapter: Some(DocumentAdapter::FixedSvg),
                reason: actual,
                ..
            } if actual == reason
        ));
    }
}
#[test]
fn presentation_advance_targets_the_primary_and_refuses_a_fixed_companion() {
    let (mut kernel, _) = attach_fixed_companion(&initialization_with_fixed_pair(), 0);
    for supported_operations in [
        &mut kernel.committed.as_mut().unwrap().supported_operations,
        &mut kernel
            .fixed_companion
            .as_mut()
            .unwrap()
            .supported_operations,
    ] {
        supported_operations.push(AgentOperationKind::AdvancePresentation);
    }

    let requested = kernel.dispatch(NavigatorCommand::AdvancePresentation {
        direction: PresentationAdvanceDirection::Forward,
        target: PresentationAdvanceTarget::Primary,
    });
    assert!(matches!(
        requested.effects.as_slice(),
        [KernelEffect::AgentRequest {
            participant,
            generation: 1,
            request: AgentRequest::AdvancePresentation { .. },
            ..
        }] if *participant == primary(1)
    ));
    assert_failure(
        &kernel.dispatch(NavigatorCommand::AdvancePresentation {
            direction: PresentationAdvanceDirection::Forward,
            target: PresentationAdvanceTarget::FixedCompanion,
        }),
        "invalid-command",
    );
}
#[test]
fn presentation_advance_targets_a_reflowable_companion_on_request() {
    let (mut kernel, companion) =
        attach_fixed_companion(&initialization_with_three_loadable_occurrences(), 1);
    let attached = kernel.snapshot().document.fixed_companion.unwrap();
    assert_eq!(attached.frame.adapter, DocumentAdapter::ReflowableXhtml);
    let frame_generation = attached.frame.generation;
    assert_failure(
        &kernel.dispatch(NavigatorCommand::AdvancePresentation {
            direction: PresentationAdvanceDirection::Forward,
            target: PresentationAdvanceTarget::FixedCompanion,
        }),
        "invalid-command",
    );
    kernel
        .fixed_companion
        .as_mut()
        .unwrap()
        .supported_operations
        .push(AgentOperationKind::AdvancePresentation);

    let requested = kernel.dispatch(NavigatorCommand::AdvancePresentation {
        direction: PresentationAdvanceDirection::Forward,
        target: PresentationAdvanceTarget::FixedCompanion,
    });
    assert!(requested.accepted, "{requested:?}");
    let [
        KernelEffect::AgentRequest {
            participant,
            operation,
            generation,
            request:
                AgentRequest::AdvancePresentation {
                    direction: PresentationAdvanceDirection::Forward,
                },
            ..
        },
    ] = requested.effects.as_slice()
    else {
        panic!("unexpected effects: {:?}", requested.effects);
    };
    assert_eq!(*participant, companion);
    assert_eq!(*generation, frame_generation);
    let reported = kernel.dispatch(AdapterObservation::AgentResult {
        participant: companion,
        operation: *operation,
        generation: frame_generation,
        result: AgentResult::AdvancePresentation {
            status: PresentationAdvanceStatus::Advanced,
        },
    });
    assert!(reported.accepted, "{reported:?}");
    assert!(reported.events.iter().any(|event| matches!(
        event,
        KernelEvent::AgentOperationReported {
            participant: reported_participant,
            result: AgentResult::AdvancePresentation {
                status: PresentationAdvanceStatus::Advanced,
            },
            ..
        } if *reported_participant == companion
    )));
}
#[test]
fn fixed_initial_layout_failure_preserves_typed_issue() {
    let mut kernel = NavigatorKernel::create(&initialization()).unwrap();
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 1 });
    assert!(matches!(
        load(&mut kernel, 1).effects.as_slice(),
        [KernelEffect::LayoutRequest {
            request: LayoutRequest::FixedXhtml,
            ..
        }]
    ));
    let transition = report_layout(&mut kernel, 1, |_| LayoutResult::FixedXhtml {
        outcome: FixedLayoutOutcome::Unavailable {
            issue: FixedLayoutIssue::FinalViewportUnavailable,
        },
    });
    assert!(transition.accepted);
    assert!(transition.events.iter().any(|event| matches!(
        event,
        KernelEvent::DocumentLoadFailed {
            reason: FrameFailureReason::FixedLayoutUnavailable {
                issue: FixedLayoutIssue::FinalViewportUnavailable,
            },
            ..
        }
    )));
}
#[test]
fn reading_step_navigation_skips_the_visible_fixed_companion() {
    for (owner, command, destination) in [
        (0, NavigatorCommand::Next {}, 2),
        (1, NavigatorCommand::Previous {}, 0),
    ] {
        let (mut kernel, _) = attach_fixed_companion(&initialization_with_fixed_triplet(), owner);
        assert!(kernel.dispatch(command).accepted);
        let snapshot = kernel.snapshot();
        assert_eq!(
            snapshot.document.pending.unwrap().frame().occurrence,
            destination
        );
        assert!(snapshot.document.fixed_companion.is_none());
    }
}
#[test]
fn reading_step_boundary_includes_the_visible_fixed_companion() {
    let (mut kernel, _) = attach_fixed_companion(&initialization_with_fixed_triplet(), 0);
    let before = kernel.snapshot();
    assert_failure(
        &kernel.dispatch(NavigatorCommand::Previous {}),
        "navigation-boundary",
    );
    assert_eq!(kernel.snapshot(), before);
}
#[test]
fn fixed_companion_attach_rejects_stale_primary_generation_without_mutation() {
    let mut kernel = opened(&initialization_with_fixed_pair(), 0);
    let frame_generation = prepare(&mut kernel, 1);
    let before = kernel.snapshot();
    assert_failure(
        &kernel.dispatch(NavigatorCommand::AttachFixedCompanion {
            owner_document_generation: 2,
            frame_generation,
            placement: FixedSpreadPlacement::Right,
        }),
        "stale-observation",
    );
    assert_eq!(kernel.snapshot(), before);
}
#[test]
fn fixed_companion_attach_transfers_settled_prepared_frame_identity() {
    let mut kernel = opened(&initialization_with_fixed_pair(), 0);
    let frame_generation = prepare(&mut kernel, 1);
    let attached = kernel.dispatch(NavigatorCommand::AttachFixedCompanion {
        owner_document_generation: 1,
        frame_generation,
        placement: FixedSpreadPlacement::Right,
    });
    assert!(attached.accepted);
    assert!(attached.effects.is_empty());
    let snapshot = kernel.snapshot();
    assert!(snapshot.prepared_frames.is_empty());
    let companion = snapshot.document.fixed_companion.unwrap();
    assert_eq!(companion.owner_document_generation, 1);
    assert_eq!(companion.frame.generation, frame_generation);
    assert_eq!(companion.frame.occurrence, 1);
    assert_eq!(companion.placement, FixedSpreadPlacement::Right);
    assert!(matches!(
        companion.layout,
        FixedCompanionLayoutState::Settled { .. }
    ));
}
#[test]
fn primary_replacement_and_companion_failure_remove_only_the_companion_frame() {
    for replace_primary in [true, false] {
        let (mut kernel, _) = attach_fixed_companion(&initialization_with_fixed_pair(), 0);
        let transition = if replace_primary {
            kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 })
        } else {
            kernel.dispatch(FrameObservation::Failed {
                generation: 2,
                reason: FrameFailureReason::LoadError,
            })
        };
        assert!(transition.accepted);
        assert!(
            transition
                .effects
                .contains(&KernelEffect::CancelFrame { generation: 2 })
        );
        let snapshot = kernel.snapshot();
        assert!(snapshot.document.fixed_companion.is_none());
        assert_eq!(snapshot.document.committed.unwrap().generation, 1);
    }
}
#[test]
fn companion_observation_and_link_activation_are_companion_sourced() {
    let (mut kernel, participant) = attach_fixed_companion(&initialization_with_fixed_pair(), 0);
    let primary_observation = kernel
        .committed
        .as_ref()
        .unwrap()
        .layout
        .observation()
        .clone();
    let mut observation = document_observation();
    observation.language = Some("ja".to_string());

    let observed = kernel.dispatch(AdapterObservation::DocumentObserved {
        participant,
        generation: 2,
        observation: observation.clone(),
    });
    assert_eq!(
        observed.events,
        vec![KernelEvent::DocumentObserved {
            participant,
            generation: 1,
            observation: observation.clone(),
        }]
    );
    let snapshot = kernel.snapshot();
    assert_eq!(
        snapshot.document.committed.unwrap().layout.observation(),
        &primary_observation
    );
    assert!(matches!(
        snapshot.document.fixed_companion.unwrap().layout,
        FixedCompanionLayoutState::Settled { observation: retained, .. }
            if retained.document == observation
    ));

    let activation = LinkActivation {
        href: "next.xhtml".to_string(),
        resolved_url: "https://reader.example/publications/book/EPUB/next.xhtml".to_string(),
        target: None,
        download: None,
    };
    let activated = kernel.dispatch(AdapterObservation::LinkActivated {
        participant,
        generation: 2,
        activation: activation.clone(),
    });
    assert_eq!(
        activated.events,
        vec![KernelEvent::LinkActivated {
            participant,
            activation,
        }]
    );
}
#[test]
fn companion_locator_routes_and_reports_with_exact_participant() {
    let (mut kernel, participant) = attach_fixed_companion(&initialization_with_fixed_pair(), 0);
    kernel
        .fixed_companion
        .as_mut()
        .unwrap()
        .supported_operations = vec![AgentOperationKind::ResolveLocator];
    let target = locator(1, "EPUB/chapter.xhtml");

    let requested = kernel.dispatch(NavigatorCommand::ResolveLocator {
        locator: target.clone(),
    });
    assert_eq!(
        requested.effects,
        vec![KernelEffect::AgentRequest {
            participant,
            operation: 1,
            generation: 2,
            request: AgentRequest::ResolveLocator { locator: target },
        }]
    );
    assert_eq!(
        kernel.snapshot().pending_agent_operations[0].participant,
        participant
    );

    let reported = kernel.dispatch(AdapterObservation::AgentResult {
        participant,
        operation: 1,
        generation: 2,
        result: AgentResult::ResolveLocator {
            status: LocatorResolutionStatus::Resolved,
        },
    });
    assert!(matches!(
        reported.events.as_slice(),
        [KernelEvent::AgentOperationReported {
            participant: owner,
            generation: 1,
            ..
        }] if *owner == participant
    ));
}
#[test]
fn companion_document_invalidation_retains_primary_and_rejects_delayed_reports() {
    let (mut kernel, participant) = attach_fixed_companion(&initialization_with_fixed_pair(), 0);
    kernel
        .fixed_companion
        .as_mut()
        .unwrap()
        .supported_operations = vec![AgentOperationKind::ResolveLocator];
    kernel.dispatch(NavigatorCommand::ResolveLocator {
        locator: locator(1, "EPUB/chapter.xhtml"),
    });

    let invalidated = kernel.dispatch(AdapterObservation::DocumentInvalidated {
        participant,
        generation: 2,
        reason: DocumentInvalidationReason::UnexpectedNavigation,
    });
    assert!(invalidated.accepted);
    assert_eq!(kernel.snapshot().document.committed.unwrap().generation, 1);
    assert!(kernel.snapshot().document.fixed_companion.is_none());
    assert_failure(
        &kernel.dispatch(AdapterObservation::AgentResult {
            participant,
            operation: 1,
            generation: 2,
            result: AgentResult::ResolveLocator {
                status: LocatorResolutionStatus::Resolved,
            },
        }),
        "stale-agent-operation-observation",
    );
    assert_failure(
        &kernel.dispatch(AdapterObservation::DocumentObserved {
            participant,
            generation: 2,
            observation: document_observation(),
        }),
        "stale-observation",
    );
}
#[test]
fn companion_dirty_layout_waits_updates_and_reconciles_serially() {
    let (mut kernel, companion) = attach_fixed_companion(&initialization_with_fixed_pair(), 0);
    let companion_layout =
        |kernel: &NavigatorKernel| kernel.snapshot().document.fixed_companion.unwrap().layout;
    let invalidate_companion = |kernel: &mut NavigatorKernel, cause| {
        kernel.dispatch(AdapterObservation::LayoutInvalidated {
            participant: Some(companion),
            generation: 2,
            cause,
        })
    };
    invalidate_primary(&mut kernel, LayoutInvalidationCause::Viewport);
    let primary_layout = kernel.snapshot().layout.pending;

    assert!(
        invalidate_companion(&mut kernel, LayoutInvalidationCause::Dom)
            .effects
            .is_empty()
    );
    assert_eq!(kernel.snapshot().layout.pending, primary_layout);
    assert!(matches!(
        companion_layout(&kernel),
        FixedCompanionLayoutState::Dirty { .. }
    ));

    let primary_settled = settle_pending_layout(&mut kernel, 1);
    assert!(primary_settled.effects.iter().any(|effect| matches!(
        effect,
        KernelEffect::LayoutRequest {
            owner: LayoutOwner::FixedCompanion { .. },
            generation: 2,
            ..
        }
    )));
    assert!(matches!(
        companion_layout(&kernel),
        FixedCompanionLayoutState::Updating { .. }
    ));

    invalidate_companion(&mut kernel, LayoutInvalidationCause::Fonts);
    assert!(matches!(
        companion_layout(&kernel),
        FixedCompanionLayoutState::Dirty { .. }
    ));
    let reinvalidated = settle_pending_layout(&mut kernel, 2);
    assert_eq!(
        reinvalidated
            .effects
            .iter()
            .filter(|effect| matches!(effect, KernelEffect::LayoutRequest { .. }))
            .count(),
        1
    );
    settle_pending_layout(&mut kernel, 2);
    assert!(kernel.snapshot().layout.pending.is_none());
    assert!(matches!(
        companion_layout(&kernel),
        FixedCompanionLayoutState::Settled { .. }
    ));
}
#[test]
fn generation_capability_duplicate_occurrence_and_fixed_unsupported_are_coherent() {
    let mut kernel = opened(&initialization(), 1);
    let command = |occurrence| NavigatorCommand::GenerateAnnotationTarget {
        participant: primary(1),
        location: selection_range(occurrence, "EPUB/chapter.xhtml"),
        local_content_basis: 12,
        text_fragment_policy: AnnotationTextFragmentPolicy::Exclude,
    };
    assert_failure(&kernel.dispatch(command(1)), "invalid-command");
    kernel.committed.as_mut().unwrap().supported_operations =
        vec![AgentOperationKind::GenerateAnnotationTarget];
    assert_failure(&kernel.dispatch(command(0)), "invalid-command");
    let (operation, _) = agent_request(&kernel.dispatch(command(1)));
    let transition = agent_result(
        &mut kernel,
        operation,
        AgentResult::GenerateAnnotationTarget {
            candidate: AnnotationTargetGenerationCandidate {
                local_content_basis: 12,
                text_fragment_policy: AnnotationTextFragmentPolicy::Exclude,
                status: AnnotationTargetGenerationCandidateStatus::Unsupported,
            },
        },
    );
    assert!(matches!(
        transition.events.as_slice(),
        [KernelEvent::AnnotationTargetGenerationReported {
            outcome: AnnotationTargetGenerationOutcome::Unsupported,
            ..
        }]
    ));

    let (operation, _) = request_annotation_generation(
        &mut kernel,
        selection_range(1, "EPUB/chapter.xhtml"),
        AnnotationTextFragmentPolicy::Include,
    );
    assert!(is_delivery_failure(&agent_result(
        &mut kernel,
        operation,
        generated_candidate(AnnotationTextFragmentPolicy::Include),
    )));
}
#[test]
fn a_reflowable_companion_relayouts_under_invalidation() {
    let (mut kernel, companion) =
        attach_fixed_companion(&initialization_with_three_loadable_occurrences(), 1);
    let snapshot = kernel.snapshot();
    let attached = snapshot.document.fixed_companion.unwrap();
    assert_eq!(attached.frame.adapter, DocumentAdapter::ReflowableXhtml);
    let frame_generation = attached.frame.generation;

    let invalidated = kernel.dispatch(AdapterObservation::LayoutInvalidated {
        participant: Some(companion),
        generation: frame_generation,
        cause: LayoutInvalidationCause::Viewport,
    });
    assert!(invalidated.accepted, "{invalidated:?}");
    assert!(invalidated.effects.iter().any(|effect| matches!(
        effect,
        KernelEffect::LayoutRequest {
            owner: LayoutOwner::FixedCompanion { .. },
            request: LayoutRequest::ReflowableXhtml { .. },
            ..
        }
    )));
    assert!(matches!(
        kernel.snapshot().document.fixed_companion.unwrap().layout,
        FixedCompanionLayoutState::Updating { .. }
    ));

    let settled = settle_pending_layout(&mut kernel, frame_generation);
    assert!(settled.accepted);
    assert!(kernel.snapshot().layout.pending.is_none());
    let relaid = kernel.snapshot().document.fixed_companion.unwrap();
    assert_eq!(relaid.frame.generation, frame_generation);
    assert!(matches!(
        relaid.layout,
        FixedCompanionLayoutState::Settled { .. }
    ));
}
#[test]
fn presentation_advance_waits_for_settled_layouts_on_both_members() {
    let (mut kernel, companion) =
        attach_fixed_companion(&initialization_with_three_loadable_occurrences(), 1);
    for supported_operations in [
        &mut kernel.committed.as_mut().unwrap().supported_operations,
        &mut kernel
            .fixed_companion
            .as_mut()
            .unwrap()
            .supported_operations,
    ] {
        supported_operations.push(AgentOperationKind::AdvancePresentation);
    }
    let frame_generation = kernel
        .snapshot()
        .document
        .fixed_companion
        .unwrap()
        .frame
        .generation;
    let advance = |target| NavigatorCommand::AdvancePresentation {
        direction: PresentationAdvanceDirection::Forward,
        target,
    };

    // A dirty primary layout refuses both targets: the spread is mid-relayout.
    invalidate_primary(&mut kernel, LayoutInvalidationCause::Viewport);
    assert_failure(
        &kernel.dispatch(advance(PresentationAdvanceTarget::Primary)),
        "invalid-command",
    );
    assert_failure(
        &kernel.dispatch(advance(PresentationAdvanceTarget::FixedCompanion)),
        "invalid-command",
    );
    settle_pending_layout(&mut kernel, 1);
    let requested = kernel.dispatch(advance(PresentationAdvanceTarget::FixedCompanion));
    assert!(requested.accepted, "{requested:?}");
    let [KernelEffect::AgentRequest { operation, .. }] = requested.effects.as_slice() else {
        panic!("unexpected effects: {:?}", requested.effects);
    };
    let reported = kernel.dispatch(AdapterObservation::AgentResult {
        participant: companion,
        operation: *operation,
        generation: frame_generation,
        result: AgentResult::AdvancePresentation {
            status: PresentationAdvanceStatus::Boundary,
        },
    });
    assert!(reported.accepted, "{reported:?}");

    // A companion still laying out refuses its own target while the primary stays available.
    let invalidated = kernel.dispatch(AdapterObservation::LayoutInvalidated {
        participant: Some(companion),
        generation: frame_generation,
        cause: LayoutInvalidationCause::Viewport,
    });
    assert!(invalidated.accepted, "{invalidated:?}");
    assert!(matches!(
        kernel.snapshot().document.fixed_companion.unwrap().layout,
        FixedCompanionLayoutState::Updating { .. }
    ));
    assert_failure(
        &kernel.dispatch(advance(PresentationAdvanceTarget::FixedCompanion)),
        "invalid-command",
    );
    let primary_advance = kernel.dispatch(advance(PresentationAdvanceTarget::Primary));
    assert!(primary_advance.accepted, "{primary_advance:?}");
    settle_pending_layout(&mut kernel, frame_generation);
    assert!(
        kernel
            .dispatch(advance(PresentationAdvanceTarget::FixedCompanion))
            .accepted
    );
}
#[test]
fn a_reflowable_companion_reports_the_page_it_turned_to() {
    let (mut kernel, companion) =
        attach_fixed_companion(&initialization_with_three_loadable_occurrences(), 1);
    let attached = kernel.snapshot().document.fixed_companion.unwrap();
    assert_eq!(attached.frame.adapter, DocumentAdapter::ReflowableXhtml);
    let frame_generation = attached.frame.generation;
    let mut observation = document_observation();
    observation.pagination = Some(PaginationObservation {
        first_visible_page: 1,
        page_count: 3,
        visible_page_count: 1,
    });
    let observed = kernel.dispatch(AdapterObservation::DocumentObserved {
        participant: companion,
        generation: frame_generation,
        observation: observation.clone(),
    });
    assert!(observed.accepted, "{observed:?}");
    let FixedCompanionLayoutState::Settled {
        observation: stored,
        ..
    } = kernel.snapshot().document.fixed_companion.unwrap().layout
    else {
        panic!("the companion layout is no longer settled");
    };
    assert_eq!(stored.document.pagination, observation.pagination);

    // A page position from another layout of the companion is not accepted.
    observation.pagination = Some(PaginationObservation {
        first_visible_page: 1,
        page_count: 4,
        visible_page_count: 1,
    });
    assert_failure(
        &kernel.dispatch(AdapterObservation::DocumentObserved {
            participant: companion,
            generation: frame_generation,
            observation,
        }),
        "invalid-document-observation",
    );
}
#[test]
fn a_synthetic_spread_pairs_reflowable_and_fixed_page_participants() {
    for (initialization, primary, adapters) in [
        (
            initialization(),
            0,
            (
                DocumentAdapter::ReflowableXhtml,
                DocumentAdapter::FixedXhtml,
            ),
        ),
        (
            initialization_with_three_loadable_occurrences(),
            1,
            (
                DocumentAdapter::FixedXhtml,
                DocumentAdapter::ReflowableXhtml,
            ),
        ),
    ] {
        let (kernel, _) = attach_fixed_companion(&initialization, primary);
        let snapshot = kernel.snapshot();
        let companion = snapshot.document.fixed_companion.unwrap();
        assert_eq!(companion.frame.occurrence, primary + 1);
        assert_eq!(companion.placement, FixedSpreadPlacement::Right);
        assert_eq!(companion.frame.adapter, adapters.1);
        assert_eq!(
            snapshot.document.committed.unwrap().frame.adapter,
            adapters.0
        );
    }
}
