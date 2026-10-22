use super::support::*;
use crate::kernel::*;

fn promotes(transition: &KernelTransition) -> bool {
    transition
        .effects
        .iter()
        .any(|effect| matches!(effect, KernelEffect::PromoteFrame { .. }))
}

#[test]
fn exact_occurrence_open_bypasses_settled_prepared_frame() {
    let mut kernel = opened(&initialization(), 0);
    let prepared_generation = prepare(&mut kernel, 1);

    let opened = kernel.dispatch(NavigatorCommand::OpenOccurrenceAt {
        occurrence: 1,
        evidence: vec![PointEvidence::HtmlFragment {
            value: "target".to_string(),
        }],
    });
    assert!(opened.accepted);
    assert!(opened.effects.contains(&KernelEffect::CancelFrame {
        generation: prepared_generation
    }));
    assert!(opened.effects.iter().any(|effect| matches!(
        effect,
        KernelEffect::ReplaceFrame { generation, .. } if *generation != prepared_generation
    )));
    assert!(!promotes(&opened));
}
#[test]
fn preparation_advances_past_the_visible_spread_boundary_only_by_one() {
    for (owner, occurrence, accepted) in [(0, 2, true), (1, 0, true), (0, 3, false)] {
        let (mut kernel, _) = attach_fixed_companion(&initialization_with_fixed_triplet(), owner);
        let prepared = kernel.dispatch(NavigatorCommand::PrepareOccurrence { occurrence });
        if accepted {
            assert!(matches!(
                prepared.effects.as_slice(),
                [KernelEffect::CreatePreparedFrame { occurrence: prepared, .. }]
                    if *prepared == occurrence
            ));
            assert_eq!(kernel.physical_frame_count(), 3);
        } else {
            assert_failure(&prepared, "invalid-command");
            assert!(kernel.snapshot().prepared_frames.is_empty());
            assert_eq!(kernel.physical_frame_count(), 2);
        }
    }
}
#[test]
fn preparation_ignores_stale_and_detached_fixed_companions() {
    let (mut stale, _) = attach_fixed_companion(&initialization_with_fixed_triplet(), 0);
    stale
        .fixed_companion
        .as_mut()
        .unwrap()
        .owner_document_generation = 2;
    assert_failure(
        &stale.dispatch(NavigatorCommand::PrepareOccurrence { occurrence: 2 }),
        "invalid-command",
    );
    assert_eq!(stale.physical_frame_count(), 2);

    let (mut detached, _) = attach_fixed_companion(&initialization_with_fixed_triplet(), 0);
    assert!(
        detached
            .dispatch(NavigatorCommand::DetachFixedCompanion {
                owner_document_generation: 1,
                frame_generation: 2,
            })
            .accepted
    );
    assert_failure(
        &detached.dispatch(NavigatorCommand::PrepareOccurrence { occurrence: 2 }),
        "invalid-command",
    );
    assert_eq!(detached.physical_frame_count(), 1);
}
#[test]
fn prepared_previous_starts_at_the_document_end() {
    let mut kernel = opened(&initialization(), 1);
    let prepared = kernel.dispatch(NavigatorCommand::PrepareOccurrence { occurrence: 0 });
    let [KernelEffect::CreatePreparedFrame { generation, .. }] = prepared.effects.as_slice() else {
        panic!("unexpected preparation effects: {:?}", prepared.effects);
    };
    assert!(matches!(
        load(&mut kernel, *generation).effects.as_slice(),
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
fn prepared_next_promotes_frame_and_layout_with_fresh_document_generation() {
    let mut kernel = opened(&initialization(), 0);
    let frame_generation = prepare(&mut kernel, 1);
    let PreparedFrameState::Prepared { layout, .. } = &kernel.snapshot().prepared_frames[0].state
    else {
        panic!("prepared frame has not settled")
    };
    let prepared_layout_generation = layout.layout_generation;

    let opened = kernel.dispatch(NavigatorCommand::Next {});
    assert_eq!(opened.events.len(), 1);
    assert_eq!(
        opened.effects,
        vec![KernelEffect::PromoteFrame {
            frame_generation,
            document_generation: 2,
        }]
    );
    assert_eq!(kernel.snapshot().document.committed.unwrap().generation, 1);

    let promoted = kernel.dispatch(FrameObservation::Promoted { frame_generation });
    assert!(promoted.accepted);
    assert_eq!(promoted.events.len(), 1);
    assert!(
        !promoted
            .effects
            .iter()
            .any(|effect| matches!(effect, KernelEffect::LayoutRequest { .. }))
    );
    let snapshot = kernel.snapshot();
    let committed = snapshot.document.committed.unwrap();
    assert_eq!(committed.generation, 2);
    assert_eq!(committed.frame_generation(), frame_generation);
    assert_eq!(
        committed.layout.layout().layout_generation,
        prepared_layout_generation
    );
    assert!(snapshot.prepared_frames.is_empty());
}
#[test]
fn failed_or_invalidated_prepared_promotion_preserves_committed_document() {
    for invalidate in [false, true] {
        let mut kernel = opened(&initialization(), 0);
        let frame_generation = prepare(&mut kernel, 1);
        kernel.dispatch(NavigatorCommand::Next {});

        let failed = if invalidate {
            kernel.dispatch(AdapterObservation::LayoutInvalidated {
                participant: None,
                generation: frame_generation,
                cause: LayoutInvalidationCause::Viewport,
            })
        } else {
            kernel.dispatch(FrameObservation::Failed {
                generation: frame_generation,
                reason: FrameFailureReason::LoadError,
            })
        };
        assert!(failed.accepted);
        assert!(matches!(
            failed.events.as_slice(),
            [KernelEvent::DocumentLoadFailed { generation: 2, .. }]
        ));
        assert_eq!(
            failed.effects,
            vec![KernelEffect::CancelFrame {
                generation: frame_generation,
            }]
        );
        let snapshot = kernel.snapshot();
        assert_eq!(snapshot.document.pending, None);
        assert_eq!(snapshot.document.committed.unwrap().generation, 1);
        assert!(snapshot.prepared_frames.is_empty());
        assert_failure(
            &kernel.dispatch(FrameObservation::Promoted { frame_generation }),
            "stale-observation",
        );
    }
}
#[test]
fn promotion_does_not_reuse_outgoing_document_anchor_evidence() {
    let mut kernel = opened(
        &initialization_with(|value| {
            value["facts"]["resources"]["readingOrder"][1]["presentation"] =
                presentation("reflowable");
        }),
        0,
    );
    let prepared_frame = prepare(&mut kernel, 1);
    let PreparedFrameState::Prepared { layout, .. } = &mut kernel.prepared_frames[0].state else {
        unreachable!()
    };
    let AdapterLayoutSettlement::ReflowableXhtml {
        settlement: ReflowableSettlement::Paginated { measurement, .. },
        ..
    } = &mut layout.settlement
    else {
        unreachable!()
    };
    measurement.observation.visible_start = ObservedBoundary::Unavailable;

    kernel.dispatch(NavigatorCommand::Next {});
    kernel.dispatch(FrameObservation::Promoted {
        frame_generation: prepared_frame,
    });
    assert_eq!(
        committed_position(&kernel),
        ReflowPositionRequest::Entry {
            entry: DocumentEntry::Start,
        }
    );
}
#[test]
fn layout_invalidation_and_preference_change_evict_prepared_frames() {
    for change_preferences in [false, true] {
        let mut kernel = opened(&initialization_with_three_loadable_occurrences(), 1);
        let previous = prepare(&mut kernel, 0);
        let next = prepare(&mut kernel, 2);

        let transition = if change_preferences {
            kernel.dispatch(NavigatorCommand::SetPresentationPreferences {
                preferences: PresentationPreferences {
                    theme: PublicationTheme::Dark,
                    ..PresentationPreferences::default()
                },
            })
        } else {
            invalidate_primary(&mut kernel, LayoutInvalidationCause::Viewport)
        };
        assert!(transition.accepted);
        for generation in [previous, next] {
            assert!(
                transition
                    .effects
                    .contains(&KernelEffect::CancelFrame { generation })
            );
        }
        assert!(kernel.snapshot().prepared_frames.is_empty());
        assert_eq!(kernel.physical_frame_count(), 1);
    }
}
#[test]
fn preparation_rejects_pending_replacement_and_total_frames_stop_at_three() {
    let mut pending = opened(&initialization(), 0);
    pending.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 });
    assert_failure(
        &pending.dispatch(NavigatorCommand::PrepareOccurrence { occurrence: 1 }),
        "invalid-command",
    );
    assert_eq!(pending.physical_frame_count(), 2);
    assert!(pending.snapshot().prepared_frames.is_empty());

    let mut kernel = opened(&initialization_with_three_loadable_occurrences(), 1);
    prepare(&mut kernel, 0);
    prepare(&mut kernel, 2);
    assert_eq!(kernel.physical_frame_count(), 3);
    assert_eq!(kernel.snapshot().prepared_frames.len(), 2);
}
#[test]
fn evicted_frames_reject_observations_and_keep_physical_generations_divergent() {
    let mut kernel = opened(&initialization(), 0);
    let frame_generation = prepare(&mut kernel, 1);
    kernel.dispatch(NavigatorCommand::EvictPreparedFrames {});
    let before = kernel.snapshot();
    assert_failure(
        &kernel.dispatch(FrameObservation::Loaded {
            generation: frame_generation,
        }),
        "stale-observation",
    );
    assert_eq!(kernel.snapshot(), before);

    let opened = kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 });
    assert!(matches!(
        opened.effects.as_slice(),
        [KernelEffect::ReplaceFrame { generation: 3, .. }]
    ));
    let pending = kernel.snapshot().document.pending.unwrap();
    assert_eq!(pending.generation, 2);
    assert_eq!(pending.frame_generation(), 3);

    let cancelled = kernel.dispatch(NavigatorCommand::CancelDocument {});
    assert_eq!(
        cancelled.effects,
        vec![KernelEffect::CancelFrame { generation: 3 }]
    );
}
#[test]
fn superseding_promotion_cancels_and_cannot_reuse_its_frame() {
    let mut kernel = opened(&initialization(), 0);
    let promoted_frame = prepare(&mut kernel, 1);
    kernel.dispatch(NavigatorCommand::Next {});

    let superseded = kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 });
    assert!(superseded.effects.contains(&KernelEffect::CancelFrame {
        generation: promoted_frame,
    }));
    assert!(
        superseded
            .effects
            .iter()
            .any(|effect| matches!(effect, KernelEffect::ReplaceFrame { generation: 3, .. }))
    );
    assert!(!promotes(&superseded));
    assert!(kernel.snapshot().prepared_frames.is_empty());
    assert_failure(
        &kernel.dispatch(FrameObservation::Promoted {
            frame_generation: promoted_frame,
        }),
        "stale-observation",
    );
}
#[test]
fn promotion_evicts_nonadjacent_prepared_frame_and_direct_open_does_not_promote_it() {
    let mut kernel = opened(&initialization_with_three_loadable_occurrences(), 1);
    let previous_frame = prepare(&mut kernel, 0);
    let next_frame = prepare(&mut kernel, 2);
    kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 2 });

    let promoted = kernel.dispatch(FrameObservation::Promoted {
        frame_generation: next_frame,
    });
    assert!(promoted.effects.contains(&KernelEffect::CancelFrame {
        generation: previous_frame,
    }));
    assert!(kernel.snapshot().prepared_frames.is_empty());

    let opened = kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 0 });
    assert!(
        opened
            .effects
            .iter()
            .any(|effect| matches!(effect, KernelEffect::ReplaceFrame { .. }))
    );
    assert!(!promotes(&opened));
}
#[test]
fn close_cancels_prepared_physical_frames_and_operations() {
    let mut kernel = opened(&initialization(), 0);
    let started = kernel.dispatch(NavigatorCommand::PrepareOccurrence { occurrence: 1 });
    let [KernelEffect::CreatePreparedFrame { generation, .. }] = started.effects.as_slice() else {
        panic!("unexpected preparation effects: {:?}", started.effects);
    };

    let closed = kernel.dispatch(NavigatorCommand::Close {});
    assert!(closed.effects.contains(&KernelEffect::CancelFrame {
        generation: *generation,
    }));
    assert!(kernel.snapshot().prepared_frames.is_empty());
    assert!(kernel.snapshot().layout.pending.is_none());
}
#[test]
fn prepared_frame_state_never_accepts_more_than_two_entries() {
    let mut kernel = opened(&initialization(), 0);
    prepare(&mut kernel, 1);
    let mut duplicate = kernel.snapshot().prepared_frames[0].clone();
    duplicate.frame.occurrence = 5;
    duplicate.frame.generation += 1;
    kernel.prepared_frames.push(duplicate);
    kernel.committed.as_mut().unwrap().frame.occurrence = 8;

    assert_failure(
        &kernel.dispatch(NavigatorCommand::PrepareOccurrence { occurrence: 9 }),
        "invalid-command",
    );
    assert_eq!(kernel.snapshot().prepared_frames.len(), 2);
}
fn start_preparation(kernel: &mut NavigatorKernel, occurrence: u32, stage: u32) -> u32 {
    let started = kernel.dispatch(NavigatorCommand::PrepareOccurrence { occurrence });
    let [KernelEffect::CreatePreparedFrame { generation, .. }] = started.effects.as_slice() else {
        panic!("unexpected preparation effects: {:?}", started.effects);
    };
    let generation = *generation;
    if stage >= 1 {
        assert!(
            kernel
                .dispatch(FrameObservation::Loaded { generation })
                .accepted
        );
    }
    if stage >= 2 {
        assert!(
            kernel
                .dispatch(AdapterObservation::Ready {
                    generation,
                    supported_operations: vec![],
                })
                .accepted
        );
    }
    generation
}
#[test]
fn next_adopts_in_flight_prepared_frame_and_promotes_it_once_settled() {
    for stage in 0..3 {
        let mut kernel = opened(&initialization(), 0);
        let frame_generation = start_preparation(&mut kernel, 1, stage);

        let adopted = kernel.dispatch(NavigatorCommand::Next {});
        assert!(adopted.accepted);
        assert!(adopted.effects.is_empty(), "{:?}", adopted.effects);
        assert!(matches!(
            adopted.events.as_slice(),
            [KernelEvent::DocumentPending {
                generation: 2,
                occurrence: 1,
                ..
            }]
        ));
        let pending = kernel.snapshot().document.pending.unwrap();
        assert!(matches!(
            pending.state,
            PendingDocumentState::Preparing { .. }
        ));
        assert_eq!(pending.frame_generation(), frame_generation);
        assert!(kernel.snapshot().prepared_frames.is_empty());

        if stage < 1 {
            let loaded = kernel.dispatch(FrameObservation::Loaded {
                generation: frame_generation,
            });
            assert!(matches!(
                loaded.effects.as_slice(),
                [KernelEffect::InitializeAgent { generation, .. }] if *generation == frame_generation
            ));
        }
        if stage < 2 {
            let ready = kernel.dispatch(AdapterObservation::Ready {
                generation: frame_generation,
                supported_operations: vec![],
            });
            assert!(matches!(
                ready.effects.as_slice(),
                [KernelEffect::LayoutRequest {
                    owner: LayoutOwner::PreparedFrame,
                    ..
                }]
            ));
        }
        let settled = settle_pending_layout(&mut kernel, frame_generation);
        assert!(settled.events.is_empty());
        assert_eq!(
            settled.effects,
            vec![KernelEffect::PromoteFrame {
                frame_generation,
                document_generation: 2,
            }]
        );
        assert!(kernel.snapshot().layout.pending.is_none());

        let promoted = kernel.dispatch(FrameObservation::Promoted { frame_generation });
        assert!(matches!(
            promoted.events.as_slice(),
            [KernelEvent::DocumentCommitted {
                generation: 2,
                occurrence: 1,
                ..
            }]
        ));
        let snapshot = kernel.snapshot();
        assert_eq!(snapshot.document.pending, None);
        let committed = snapshot.document.committed.unwrap();
        assert_eq!(committed.generation, 2);
        assert_eq!(committed.frame_generation(), frame_generation);
    }
}
#[test]
fn adopted_frame_failure_fails_the_pending_document_and_preserves_committed() {
    for case in 0..4 {
        let mut kernel = opened(&initialization(), 0);
        let stage = match case {
            0 => 0,
            1 => 1,
            _ => 2,
        };
        let frame_generation = start_preparation(&mut kernel, 1, stage);
        kernel.dispatch(NavigatorCommand::Next {});

        let failed = match case {
            0 => kernel.dispatch(FrameObservation::Failed {
                generation: frame_generation,
                reason: FrameFailureReason::LoadError,
            }),
            1 => kernel.dispatch(AdapterObservation::ReadinessTimeout {
                generation: frame_generation,
            }),
            2 => layout_timeout(&mut kernel, frame_generation),
            _ => report_layout(&mut kernel, frame_generation, |plan| {
                failed_layout_result(plan, LayoutIssue::IncompatiblePublisherCss, false)
            }),
        };
        assert!(failed.accepted, "{failed:?}");
        let [
            KernelEvent::DocumentLoadFailed {
                generation: 2,
                reason,
            },
        ] = failed.events.as_slice()
        else {
            panic!("unexpected failure events: {:?}", failed.events);
        };
        assert_eq!(
            std::mem::discriminant(reason),
            std::mem::discriminant(&match case {
                0 => FrameFailureReason::LoadError,
                1 => FrameFailureReason::ReadinessTimeout,
                2 => FrameFailureReason::EffectExecutionFailed {
                    message: String::new(),
                },
                _ => FrameFailureReason::FixedLayoutConflict {
                    issue: FixedLayoutIssue::IntrinsicViewportInvalid,
                },
            })
        );
        assert_eq!(
            failed.effects,
            vec![KernelEffect::CancelFrame {
                generation: frame_generation,
            }]
        );
        let snapshot = kernel.snapshot();
        assert_eq!(snapshot.document.pending, None);
        assert_eq!(snapshot.document.committed.unwrap().generation, 1);
        assert!(snapshot.layout.pending.is_none());
        assert_failure(
            &kernel.dispatch(FrameObservation::Loaded {
                generation: frame_generation,
            }),
            "stale-observation",
        );
    }
}
#[test]
fn second_open_cancels_adopted_frame_and_its_layout() {
    let mut kernel = opened(&initialization(), 0);
    let frame_generation = start_preparation(&mut kernel, 1, 2);
    kernel.dispatch(NavigatorCommand::Next {});
    let adopted_layout = kernel.snapshot().layout.pending.unwrap();

    let reopened = kernel.dispatch(NavigatorCommand::OpenOccurrence { occurrence: 5 });
    assert!(reopened.accepted);
    assert!(reopened.effects.contains(&KernelEffect::CancelFrame {
        generation: frame_generation,
    }));
    assert!(
        reopened
            .effects
            .iter()
            .any(|effect| matches!(effect, KernelEffect::ReplaceFrame { occurrence: 5, .. }))
    );
    assert!(
        reopened
            .events
            .contains(&KernelEvent::DocumentCancelled { generation: 2 })
    );
    assert!(kernel.snapshot().layout.pending.is_none());

    let late = kernel.dispatch(AdapterObservation::LayoutResult {
        participant: None,
        operation: adopted_layout.operation,
        generation: frame_generation,
        layout_generation: adopted_layout.layout_generation,
        result: settled_result(adopted_layout.adapter.plan()),
    });
    assert!(!late.accepted);
}
#[test]
fn exact_open_bypasses_in_flight_prepared_frame() {
    let mut kernel = opened(&initialization(), 0);
    let frame_generation = start_preparation(&mut kernel, 1, 2);
    let opened = kernel.dispatch(NavigatorCommand::OpenOccurrenceAt {
        occurrence: 1,
        evidence: vec![PointEvidence::HtmlFragment {
            value: "target".to_string(),
        }],
    });
    assert!(opened.accepted);
    assert!(opened.effects.contains(&KernelEffect::CancelFrame {
        generation: frame_generation,
    }));
    assert!(
        opened
            .effects
            .iter()
            .any(|effect| matches!(effect, KernelEffect::ReplaceFrame { occurrence: 1, .. }))
    );
    assert!(kernel.snapshot().layout.pending.is_none());
}
#[test]
fn preferences_eviction_and_close_cancel_adopted_frame() {
    for action in 0..3 {
        let mut kernel = opened(&initialization(), 0);
        let frame_generation = start_preparation(&mut kernel, 1, 1);
        kernel.dispatch(NavigatorCommand::Next {});

        let cancelled = kernel.dispatch(match action {
            0 => NavigatorCommand::SetPresentationPreferences {
                preferences: PresentationPreferences {
                    theme: PublicationTheme::Dark,
                    ..PresentationPreferences::default()
                },
            },
            1 => NavigatorCommand::EvictPreparedFrames {},
            _ => NavigatorCommand::Close {},
        });
        assert!(cancelled.accepted);
        assert!(
            cancelled
                .events
                .contains(&KernelEvent::DocumentCancelled { generation: 2 })
        );
        assert!(cancelled.effects.contains(&KernelEffect::CancelFrame {
            generation: frame_generation,
        }));
        if action < 2 {
            assert_eq!(kernel.snapshot().document.pending, None);
            assert_failure(
                &kernel.dispatch(FrameObservation::Loaded {
                    generation: frame_generation,
                }),
                "stale-observation",
            );
        }
    }
}
#[test]
fn preferences_and_eviction_cancel_frame_awaiting_promotion() {
    for change_preferences in [false, true] {
        let mut kernel = opened(&initialization(), 0);
        let frame_generation = prepare(&mut kernel, 1);
        assert!(promotes(&kernel.dispatch(NavigatorCommand::Next {})));

        let cancelled = kernel.dispatch(if change_preferences {
            NavigatorCommand::SetPresentationPreferences {
                preferences: PresentationPreferences {
                    theme: PublicationTheme::Dark,
                    ..PresentationPreferences::default()
                },
            }
        } else {
            NavigatorCommand::EvictPreparedFrames {}
        });
        assert!(cancelled.accepted);
        assert!(
            cancelled
                .events
                .contains(&KernelEvent::DocumentCancelled { generation: 2 })
        );
        assert!(cancelled.effects.contains(&KernelEffect::CancelFrame {
            generation: frame_generation,
        }));
        assert_eq!(kernel.snapshot().document.pending, None);
        assert_eq!(kernel.physical_frame_count(), 1);
        assert_failure(
            &kernel.dispatch(FrameObservation::Promoted { frame_generation }),
            "stale-observation",
        );
    }
}
#[test]
fn failed_promotion_relays_out_invalidated_committed_document() {
    for invalidate_target in [false, true] {
        let mut kernel = opened(&initialization(), 0);
        let frame_generation = prepare(&mut kernel, 1);
        assert!(promotes(&kernel.dispatch(NavigatorCommand::Next {})));
        assert!(invalidate_primary(&mut kernel, LayoutInvalidationCause::Viewport).accepted);
        assert!(matches!(
            kernel.snapshot().document.committed.unwrap().layout,
            CommittedLayoutState::Dirty { .. }
        ));

        let failed = if invalidate_target {
            kernel.dispatch(AdapterObservation::LayoutInvalidated {
                participant: None,
                generation: frame_generation,
                cause: LayoutInvalidationCause::Viewport,
            })
        } else {
            kernel.dispatch(FrameObservation::Failed {
                generation: frame_generation,
                reason: FrameFailureReason::LoadError,
            })
        };
        assert!(failed.accepted);
        assert!(failed.effects.iter().any(|effect| matches!(
            effect,
            KernelEffect::LayoutRequest {
                owner: LayoutOwner::Document {
                    document_generation: 1,
                    phase: LayoutPhase::Update,
                },
                ..
            }
        )));
        assert!(matches!(
            kernel.snapshot().document.committed.unwrap().layout,
            CommittedLayoutState::Updating { .. }
        ));
    }
}
#[test]
fn retained_frame_reconciliation_cancels_in_flight_preparation() {
    for evict in [false, true] {
        let mut kernel = opened(&initialization_with_three_loadable_occurrences(), 1);
        let next = prepare(&mut kernel, 2);
        let previous = start_preparation(&mut kernel, 0, 2);
        assert!(promotes(&kernel.dispatch(NavigatorCommand::Next {})));
        assert!(invalidate_primary(&mut kernel, LayoutInvalidationCause::Viewport).accepted);

        let failed = if evict {
            kernel.dispatch(NavigatorCommand::EvictPreparedFrames {})
        } else {
            kernel.dispatch(FrameObservation::Failed {
                generation: next,
                reason: FrameFailureReason::LoadError,
            })
        };
        assert!(failed.accepted);
        for generation in [next, previous] {
            assert!(
                failed
                    .effects
                    .contains(&KernelEffect::CancelFrame { generation })
            );
        }
        assert!(kernel.snapshot().prepared_frames.is_empty());
        assert_eq!(
            kernel.snapshot().layout.pending.unwrap().owner,
            LayoutOwner::Document {
                document_generation: 1,
                phase: LayoutPhase::Update,
            }
        );
    }
}
#[test]
fn promotion_eviction_releases_in_flight_preparation_layout() {
    let mut kernel = opened(&initialization_with_three_loadable_occurrences(), 1);
    let next = prepare(&mut kernel, 2);
    let previous = start_preparation(&mut kernel, 0, 2);
    assert!(promotes(&kernel.dispatch(NavigatorCommand::Next {})));

    let promoted = kernel.dispatch(FrameObservation::Promoted {
        frame_generation: next,
    });
    assert!(promoted.effects.contains(&KernelEffect::CancelFrame {
        generation: previous,
    }));
    let snapshot = kernel.snapshot();
    assert!(snapshot.prepared_frames.is_empty());
    assert!(snapshot.layout.pending.is_none());
    assert!(
        kernel
            .dispatch(NavigatorCommand::PrepareOccurrence { occurrence: 1 })
            .accepted
    );
}
fn prepared_state(kernel: &NavigatorKernel, generation: u32) -> PreparedFrameState {
    kernel
        .snapshot()
        .prepared_frames
        .into_iter()
        .find(|prepared| prepared.frame.generation == generation)
        .map(|prepared| prepared.state)
        .unwrap_or_else(|| panic!("prepared frame {generation} is missing"))
}
#[test]
fn document_local_relayout_keeps_preparation_and_queues_its_layout() {
    for stage in 0..2 {
        let mut kernel = opened(&initialization_with_three_loadable_occurrences(), 1);
        let next = prepare(&mut kernel, 2);
        let previous = start_preparation(&mut kernel, 0, stage);

        let relayout = invalidate_primary(&mut kernel, LayoutInvalidationCause::Fonts);
        assert!(relayout.accepted);
        assert!(
            !relayout
                .effects
                .iter()
                .any(|effect| matches!(effect, KernelEffect::CancelFrame { .. }))
        );
        assert_eq!(kernel.snapshot().prepared_frames.len(), 2);

        if stage < 1 {
            assert!(
                kernel
                    .dispatch(FrameObservation::Loaded {
                        generation: previous,
                    })
                    .accepted
            );
        }
        let ready = kernel.dispatch(AdapterObservation::Ready {
            generation: previous,
            supported_operations: vec![],
        });
        assert!(ready.accepted);
        assert!(ready.effects.is_empty());
        assert!(matches!(
            prepared_state(&kernel, previous),
            PreparedFrameState::LayoutQueued { .. }
        ));

        let settled = settle_pending_layout(&mut kernel, 1);
        assert!(settled.effects.iter().any(|effect| matches!(
            effect,
            KernelEffect::LayoutRequest {
                owner: LayoutOwner::PreparedFrame,
                generation,
                ..
            } if *generation == previous
        )));
        assert!(settle_pending_layout(&mut kernel, previous).accepted);
        assert!(matches!(
            prepared_state(&kernel, previous),
            PreparedFrameState::Prepared { .. }
        ));
        assert!(matches!(
            prepared_state(&kernel, next),
            PreparedFrameState::Prepared { .. }
        ));
    }
}
#[test]
fn document_local_relayout_preempts_only_in_flight_preparation_layout() {
    let mut kernel = opened(&initialization_with_three_loadable_occurrences(), 1);
    let next = prepare(&mut kernel, 2);
    let previous = start_preparation(&mut kernel, 0, 2);

    let relayout = invalidate_primary(&mut kernel, LayoutInvalidationCause::Fonts);
    assert!(relayout.accepted);
    assert_eq!(
        relayout
            .effects
            .iter()
            .filter(|effect| matches!(effect, KernelEffect::CancelFrame { .. }))
            .collect::<Vec<_>>(),
        vec![&KernelEffect::CancelFrame {
            generation: previous,
        }]
    );
    let snapshot = kernel.snapshot();
    assert_eq!(snapshot.prepared_frames.len(), 1);
    assert_eq!(snapshot.prepared_frames[0].frame.generation, next);
    assert_eq!(
        snapshot.layout.pending.unwrap().owner,
        LayoutOwner::Document {
            document_generation: 1,
            phase: LayoutPhase::Update,
        }
    );
}
#[test]
fn adopted_frame_layout_waits_for_committed_relayout() {
    let mut kernel = opened(&initialization(), 0);
    let frame_generation = start_preparation(&mut kernel, 1, 1);
    assert!(invalidate_primary(&mut kernel, LayoutInvalidationCause::Fonts).accepted);
    let adopted = kernel.dispatch(NavigatorCommand::Next {});
    assert!(adopted.effects.is_empty());

    let ready = kernel.dispatch(AdapterObservation::Ready {
        generation: frame_generation,
        supported_operations: vec![],
    });
    assert!(ready.accepted);
    assert!(ready.effects.is_empty());

    let settled = settle_pending_layout(&mut kernel, 1);
    assert!(settled.effects.iter().any(|effect| matches!(
        effect,
        KernelEffect::LayoutRequest {
            owner: LayoutOwner::PreparedFrame,
            generation,
            ..
        } if *generation == frame_generation
    )));
    assert_eq!(
        settle_pending_layout(&mut kernel, frame_generation).effects,
        vec![KernelEffect::PromoteFrame {
            frame_generation,
            document_generation: 2,
        }]
    );
}
