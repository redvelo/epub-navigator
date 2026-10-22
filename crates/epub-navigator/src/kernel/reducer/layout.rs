use super::*;

impl NavigatorKernel {
    pub(in crate::kernel) fn layout_result(
        &mut self,
        participant: Option<ActiveDocumentParticipant>,
        operation: u32,
        generation: u32,
        layout_generation: u32,
        result: LayoutResult,
    ) -> KernelTransition {
        let expected = self.pending_layout.clone();
        let expected_operation = expected.as_ref().map(|pending| pending.operation);
        let expected_generation = expected.as_ref().map(|pending| pending.frame_generation);
        let Some(pending_layout) = expected.filter(|pending| {
            pending.operation == operation
                && pending.frame_generation == generation
                && pending.layout_generation == layout_generation
                && pending.participant() == participant
                && participant.is_none_or(|participant| {
                    self.participant_frame(participant) == Some(generation)
                })
        }) else {
            return self.reject(NavigatorFailure::StaleAgentOperationObservation {
                message: "the layout result does not match the pending layout operation"
                    .to_string(),
                observed_operation: operation,
                observed_generation: generation,
                expected_operation,
                expected_generation,
            });
        };
        if pending_layout.owner == LayoutOwner::PreparedFrame {
            return self.prepared_layout_result(operation, generation, layout_generation, result);
        }
        if matches!(pending_layout.owner, LayoutOwner::FixedCompanion { .. }) {
            return self.fixed_companion_layout_result(pending_layout, result);
        }
        let plan = pending_layout.adapter.plan();
        if result.validate(plan).is_err() {
            return self.reject(NavigatorFailure::InvalidLayoutResult {
                message: "the layout result violates adapter settlement invariants".to_string(),
            });
        }
        self.pending_layout = None;
        let (document_generation, phase) = pending_layout
            .document()
            .expect("non-prepared layout has a document owner");
        let reported = KernelEvent::LayoutReported {
            participant,
            operation,
            generation: document_generation,
            layout_generation,
            result: result.clone(),
        };
        match result.into_terminal(plan, pending_layout.adapter.position()) {
            TerminalLayout::Settled(mut settlement) => {
                let position = self.position_after_settlement(&settlement, phase);
                if let AdapterLayoutSettlement::ReflowableXhtml {
                    position: stored, ..
                } = settlement.as_mut()
                {
                    *stored = position;
                }
                let observation = settlement.measurement().observation.clone();
                let committed_layout = CommittedLayout {
                    document_generation,
                    layout_generation,
                    settlement: *settlement,
                };
                if phase == LayoutPhase::Initial {
                    let pending = self
                        .pending
                        .take()
                        .expect("initial layout owns pending document");
                    let occurrence = pending.frame().occurrence;
                    let resource = pending.frame().resource.clone();
                    let frame = pending.frame().clone();
                    let supported_operations = pending.supported_operations();
                    let previous = self.committed.replace(CommittedDocument {
                        generation: document_generation,
                        frame,
                        supported_operations,
                        layout: CommittedLayoutState::Settled {
                            layout: committed_layout,
                            observation,
                        },
                    });
                    let mut events = Vec::new();
                    let mut effects = Vec::new();
                    if let Some(previous) = previous {
                        self.cancel_agent_operations_for_generation(
                            &mut events,
                            previous.generation,
                            AgentOperationCancellationReason::Replacement,
                        );
                        effects.push(KernelEffect::CancelFrame {
                            generation: previous.frame_generation(),
                        });
                    }
                    events.insert(0, reported);
                    events.push(KernelEvent::DocumentCommitted {
                        generation: document_generation,
                        occurrence,
                        resource,
                    });
                    self.accept(events, effects)
                } else {
                    let committed = self
                        .committed
                        .as_mut()
                        .expect("layout update belongs to committed document");
                    committed.layout = CommittedLayoutState::Settled {
                        layout: committed_layout,
                        observation,
                    };
                    let mut events = vec![reported];
                    let mut effects = Vec::new();
                    self.reconcile_dirty_layout(&mut events, &mut effects);
                    self.accept(events, effects)
                }
            }
            TerminalLayout::ReflowableConflict(issue) => self.finish_failed_layout(
                pending_layout,
                reported,
                FrameFailureReason::ReflowableLayoutConflict { issue },
            ),
            TerminalLayout::ReflowableUnavailable(issue) => self.finish_failed_layout(
                pending_layout,
                reported,
                FrameFailureReason::ReflowableLayoutUnavailable { issue },
            ),
            TerminalLayout::FixedConflict(issue) => self.finish_failed_layout(
                pending_layout,
                reported,
                FrameFailureReason::FixedLayoutConflict { issue },
            ),
            TerminalLayout::FixedUnavailable(issue) => self.finish_failed_layout(
                pending_layout,
                reported,
                FrameFailureReason::FixedLayoutUnavailable { issue },
            ),
        }
    }
    pub(in crate::kernel) fn finish_failed_layout(
        &mut self,
        pending_layout: PendingLayoutOperation,
        reported: KernelEvent,
        reason: FrameFailureReason,
    ) -> KernelTransition {
        let (document_generation, phase) = pending_layout
            .document()
            .expect("failed layout has a document owner");
        if phase == LayoutPhase::Initial {
            self.pending = None;
            let mut events = vec![
                reported,
                KernelEvent::DocumentLoadFailed {
                    generation: document_generation,
                    reason,
                },
            ];
            let mut effects = vec![KernelEffect::CancelFrame {
                generation: pending_layout.frame_generation,
            }];
            self.reconcile_retained_frame(&mut events, &mut effects);
            self.accept(events, effects)
        } else {
            let mut events = vec![reported];
            let mut effects = Vec::new();
            self.reconcile_dirty_layout(&mut events, &mut effects);
            self.accept(events, effects)
        }
    }
    pub(in crate::kernel) fn layout_failed(
        &mut self,
        participant: Option<ActiveDocumentParticipant>,
        operation: u32,
        generation: u32,
        layout_generation: u32,
        delivery_message: Option<String>,
    ) -> KernelTransition {
        let expected = self.pending_layout.clone();
        let expected_operation = expected.as_ref().map(|pending| pending.operation);
        let expected_generation = expected.as_ref().map(|pending| pending.frame_generation);
        let Some(pending) = expected.filter(|pending| {
            pending.operation == operation
                && pending.frame_generation == generation
                && pending.layout_generation == layout_generation
                && pending.participant() == participant
                && participant.is_none_or(|participant| {
                    self.participant_frame(participant) == Some(generation)
                })
        }) else {
            return self.reject(NavigatorFailure::StaleAgentOperationObservation {
                message: "the layout failure does not match the pending layout operation"
                    .to_string(),
                observed_operation: operation,
                observed_generation: generation,
                expected_operation,
                expected_generation,
            });
        };
        self.pending_layout = None;
        if pending.owner == LayoutOwner::PreparedFrame {
            return self.fail_prepared(
                generation,
                FrameFailureReason::EffectExecutionFailed {
                    message: "initial layout failed".to_string(),
                },
            );
        }
        if matches!(pending.owner, LayoutOwner::FixedCompanion { .. }) {
            return self.fixed_companion_layout_failed(pending, delivery_message);
        }
        let (document_generation, phase) = pending.document().unwrap();
        let failure = delivery_message.map_or_else(
            || AgentOperationFailure::OperationTimeout {
                message: "the layout operation timed out".to_string(),
            },
            |message| AgentOperationFailure::OperationDeliveryFailed { message },
        );
        let event = KernelEvent::LayoutOperationFailed {
            participant,
            operation,
            generation: document_generation,
            failure,
        };
        if phase == LayoutPhase::Initial {
            self.pending = None;
            let mut events = vec![
                event,
                KernelEvent::DocumentLoadFailed {
                    generation: document_generation,
                    reason: FrameFailureReason::EffectExecutionFailed {
                        message: "initial layout failed".to_string(),
                    },
                },
            ];
            let mut effects = vec![KernelEffect::CancelFrame {
                generation: pending.frame_generation,
            }];
            self.reconcile_retained_frame(&mut events, &mut effects);
            self.accept(events, effects)
        } else {
            let mut events = vec![event];
            let mut effects = Vec::new();
            self.reconcile_dirty_layout(&mut events, &mut effects);
            self.accept(events, effects)
        }
    }
    pub(in crate::kernel) fn position_after_settlement(
        &self,
        settlement: &AdapterLayoutSettlement,
        phase: LayoutPhase,
    ) -> ReflowPositionRequest {
        let measurement = settlement.measurement();
        let fallback = measurement.normalized_position;
        if let ObservedBoundary::Located { evidence } = &measurement.observation.visible_start {
            return ReflowPositionRequest::Exact {
                evidence: evidence.clone(),
                fallback_progression: fallback,
            };
        }
        if phase == LayoutPhase::Update
            && let Some(CommittedDocument {
                layout:
                    CommittedLayoutState::Settled {
                        layout:
                            CommittedLayout {
                                settlement:
                                    AdapterLayoutSettlement::ReflowableXhtml {
                                        position: ReflowPositionRequest::Exact { evidence, .. },
                                        ..
                                    },
                                ..
                            },
                        ..
                    }
                    | CommittedLayoutState::Updating {
                        layout:
                            CommittedLayout {
                                settlement:
                                    AdapterLayoutSettlement::ReflowableXhtml {
                                        position: ReflowPositionRequest::Exact { evidence, .. },
                                        ..
                                    },
                                ..
                            },
                        ..
                    },
                ..
            }) = &self.committed
        {
            return ReflowPositionRequest::Exact {
                evidence: evidence.clone(),
                fallback_progression: fallback,
            };
        }
        ReflowPositionRequest::Progression {
            normalized_progression: fallback,
        }
    }
    pub(in crate::kernel) fn reflow_position(&self, generation: u32) -> ReflowPositionRequest {
        if let Some(pending) = self.pending_layout.as_ref().filter(|pending| {
            pending
                .document()
                .is_some_and(|owner| owner.0 == generation)
        }) {
            return pending.adapter.position();
        }
        let Some(committed) = self
            .committed
            .as_ref()
            .filter(|committed| committed.generation == generation)
        else {
            return ReflowPositionRequest::Unavailable;
        };
        let observation = committed.layout.observation();
        let pagination_progression = observation.pagination.as_ref().and_then(|pagination| {
            let AdapterLayoutSettlement::ReflowableXhtml {
                settlement: ReflowableSettlement::Paginated { pages, .. },
                ..
            } = &committed.layout.layout().settlement
            else {
                return None;
            };
            let last_first_visible_page =
                ((pages.page_count - 1) / pages.columns_per_view) * pages.columns_per_view;
            Some(if last_first_visible_page == 0 {
                0.0
            } else {
                f64::from(pagination.first_visible_page) / f64::from(last_first_visible_page)
            })
        });
        let fallback = observation
            .rendered_text_progression
            .or(pagination_progression)
            .unwrap_or_else(|| {
                committed
                    .layout
                    .layout()
                    .settlement
                    .measurement()
                    .normalized_position
            });
        let explicit_start_after_first_page = observation
            .pagination
            .as_ref()
            .is_some_and(|pagination| pagination.first_visible_page > 0)
            && matches!(
                &observation.visible_start,
                ObservedBoundary::Located { evidence }
                    if evidence.iter().any(|item| matches!(
                        item,
                        PointEvidence::DocumentBoundary {
                            boundary: DocumentBoundary::Start
                        }
                    ))
            );
        if let ObservedBoundary::Located { evidence } = &observation.visible_start
            && !explicit_start_after_first_page
        {
            return ReflowPositionRequest::Exact {
                evidence: evidence.clone(),
                fallback_progression: fallback,
            };
        }
        match &committed.layout.layout().settlement {
            AdapterLayoutSettlement::ReflowableXhtml { position, .. }
                if observation.rendered_text_progression.is_none()
                    && observation.pagination.is_none() =>
            {
                position.clone()
            }
            _ => ReflowPositionRequest::Progression {
                normalized_progression: fallback,
            },
        }
    }
    pub(in crate::kernel) fn set_presentation_preferences(
        &mut self,
        preferences: PresentationPreferences,
    ) -> KernelTransition {
        if self.preferences == preferences {
            return self.accept(Vec::new(), Vec::new());
        }
        let active_generation = self
            .pending
            .as_ref()
            .filter(|document| {
                matches!(
                    document.state,
                    PendingDocumentState::LayoutInitializing { .. }
                )
            })
            .map(|document| document.generation)
            .or_else(|| self.committed.as_ref().map(|document| document.generation));
        let Some(generation) = active_generation else {
            self.preferences = preferences;
            let effects = self.take_prepared_cancel_effects();
            return self.accept(Vec::new(), effects);
        };
        let Some(operation) = self.layout_operation.checked_add(1) else {
            return self.reject(NavigatorFailure::AgentOperationExhausted {
                message: "the content-agent operation counter is exhausted".to_string(),
            });
        };
        let Some(layout_generation) = self.layout_generation.checked_add(1) else {
            return self.reject(NavigatorFailure::LayoutGenerationExhausted {
                message: "the layout generation counter is exhausted".to_string(),
            });
        };
        if self
            .pending
            .as_ref()
            .is_some_and(|document| document.generation == generation)
            && self.retained_frame_needs_reconciliation(preferences)
            && let Err(failure) = Self::ensure_reconciliation_capacity(operation, layout_generation)
        {
            return self.reject(failure);
        }
        if self
            .pending_layout
            .as_ref()
            .is_some_and(|layout| matches!(layout.owner, LayoutOwner::FixedCompanion { .. }))
            && self
                .committed
                .as_ref()
                .is_some_and(|document| document.generation == generation)
        {
            self.preferences = preferences;
            let committed = self.committed.as_mut().unwrap();
            let (layout, observation) = match committed.layout.clone() {
                CommittedLayoutState::Settled {
                    layout,
                    observation,
                }
                | CommittedLayoutState::Dirty {
                    layout,
                    observation,
                    ..
                }
                | CommittedLayoutState::Updating {
                    layout,
                    observation,
                } => (layout, observation),
            };
            committed.layout = CommittedLayoutState::Dirty {
                layout,
                observation,
                cause: LayoutInvalidationCause::Preferences,
            };
            let effects = self.take_prepared_cancel_effects();
            return self.accept(Vec::new(), effects);
        }
        self.preferences = preferences;
        let mut transition = self.start_layout_update_allocated(
            generation,
            LayoutInvalidationCause::Preferences,
            AgentOperationCancellationReason::PreferenceChanged,
            operation,
            layout_generation,
        );
        if self.pending.as_ref().is_some_and(|pending| {
            matches!(
                pending.state,
                PendingDocumentState::PromotionAcknowledging { .. }
            )
        }) {
            let pending = self.pending.take().unwrap();
            transition.events.push(KernelEvent::DocumentCancelled {
                generation: pending.generation,
            });
            transition.effects.push(KernelEffect::CancelFrame {
                generation: pending.frame_generation(),
            });
        }
        if let Some(frame_generation) = self.adopted_frame_generation() {
            transition.events.push(KernelEvent::DocumentCancelled {
                generation: self.pending.take().unwrap().generation,
            });
            transition.effects.push(KernelEffect::CancelFrame {
                generation: frame_generation,
            });
        }
        transition
            .effects
            .extend(self.take_prepared_cancel_effects());
        transition
    }
    pub(in crate::kernel) fn layout_invalidated(
        &mut self,
        participant: Option<ActiveDocumentParticipant>,
        generation: u32,
        cause: LayoutInvalidationCause,
    ) -> KernelTransition {
        if self.pending.as_ref().is_some_and(|pending| {
            pending.frame_generation() == generation
                && matches!(
                    pending.state,
                    PendingDocumentState::PromotionAcknowledging { .. }
                )
        }) {
            let pending = self.pending.take().unwrap();
            let mut events = vec![KernelEvent::DocumentLoadFailed {
                generation: pending.generation,
                reason: FrameFailureReason::EffectExecutionFailed {
                    message: "the prepared frame was invalidated before promotion acknowledgment"
                        .to_string(),
                },
            }];
            let mut effects = vec![KernelEffect::CancelFrame { generation }];
            self.reconcile_retained_frame(&mut events, &mut effects);
            return self.accept(events, effects);
        }
        if self.prepared_frame(generation).is_some() {
            return self.fail_prepared(
                generation,
                FrameFailureReason::EffectExecutionFailed {
                    message: "the prepared frame was invalidated before promotion".to_string(),
                },
            );
        }
        if participant.is_none()
            && let Some(document_generation) = self
                .pending
                .as_ref()
                .filter(|document| {
                    document.frame_generation() == generation
                        && matches!(
                            document.state,
                            PendingDocumentState::LayoutInitializing { .. }
                        )
                })
                .map(|document| document.generation)
        {
            return self.start_layout_update(
                document_generation,
                cause,
                AgentOperationCancellationReason::LayoutInvalidated,
            );
        }
        let Some(participant) = participant else {
            return self.stale(generation, None);
        };
        let expected_frame = self.participant_frame(participant);
        if expected_frame != Some(generation) {
            return self.stale(generation, expected_frame);
        }
        if matches!(
            participant,
            ActiveDocumentParticipant::FixedCompanion { .. }
        ) {
            return self.fixed_companion_layout_invalidated(participant, cause);
        }
        let observed_frame_generation = generation;
        let generation = self
            .pending
            .as_ref()
            .filter(|document| document.frame_generation() == observed_frame_generation)
            .map(|document| document.generation)
            .or_else(|| {
                self.committed
                    .as_ref()
                    .filter(|document| document.frame_generation() == observed_frame_generation)
                    .map(|document| document.generation)
            });
        let Some(generation) = generation else {
            let expected = self
                .pending
                .as_ref()
                .map(PendingDocument::frame_generation)
                .or_else(|| {
                    self.committed
                        .as_ref()
                        .map(CommittedDocument::frame_generation)
                });
            return self.stale(observed_frame_generation, expected);
        };
        let pending_matches = self.pending.as_ref().is_some_and(|document| {
            document.generation == generation
                && matches!(
                    document.state,
                    PendingDocumentState::LayoutInitializing { .. }
                )
        });
        let committed_matches = self
            .committed
            .as_ref()
            .is_some_and(|document| document.generation == generation);
        if !pending_matches && !committed_matches {
            let expected = self
                .pending
                .as_ref()
                .filter(|document| {
                    matches!(
                        document.state,
                        PendingDocumentState::LayoutInitializing { .. }
                    )
                })
                .map(|document| document.generation)
                .or_else(|| self.committed.as_ref().map(|document| document.generation));
            return self.stale(generation, expected);
        }
        let serialized_elsewhere = self.pending_layout.as_ref().is_some_and(|pending| {
            pending
                .participant()
                .is_some_and(|owner| owner != participant)
        });
        if committed_matches && (self.pending.is_some() || serialized_elsewhere) {
            let already_dirty = self.committed.as_ref().is_some_and(|committed| {
                matches!(committed.layout, CommittedLayoutState::Dirty { .. })
            });
            if !already_dirty {
                if self.layout_operation.checked_add(1).is_none() {
                    return self.reject(NavigatorFailure::AgentOperationExhausted {
                        message: "the content-agent operation counter cannot reserve retained-frame reconciliation"
                            .to_string(),
                    });
                }
                if self.layout_generation.checked_add(1).is_none() {
                    return self.reject(NavigatorFailure::LayoutGenerationExhausted {
                        message: "the layout generation counter cannot reserve retained-frame reconciliation"
                            .to_string(),
                    });
                }
                let committed = self.committed.as_mut().unwrap();
                let current = committed.layout.clone();
                let (layout, observation) = match current {
                    CommittedLayoutState::Settled {
                        layout,
                        observation,
                    }
                    | CommittedLayoutState::Updating {
                        layout,
                        observation,
                    } => (layout, observation),
                    CommittedLayoutState::Dirty {
                        layout,
                        observation,
                        ..
                    } => (layout, observation),
                };
                committed.layout = CommittedLayoutState::Dirty {
                    layout,
                    observation,
                    cause,
                };
            }
            return self.accept(Vec::new(), Vec::new());
        }
        let preempted_preparation = self
            .pending_layout
            .as_ref()
            .filter(|layout| layout.owner == LayoutOwner::PreparedFrame)
            .map(|layout| layout.frame_generation);
        let mut transition = self.start_layout_update(
            generation,
            cause,
            AgentOperationCancellationReason::LayoutInvalidated,
        );
        if transition.accepted {
            // Only a viewport change stales neighbouring layouts; other causes are local to
            // this document and cost at most a preparation whose layout was in flight.
            if cause == LayoutInvalidationCause::Viewport {
                transition
                    .effects
                    .extend(self.take_prepared_cancel_effects());
            } else if let Some(frame_generation) = preempted_preparation {
                self.prepared_frames
                    .retain(|prepared| prepared.frame.generation != frame_generation);
                transition.effects.push(KernelEffect::CancelFrame {
                    generation: frame_generation,
                });
            }
        }
        transition
    }
    pub(in crate::kernel) fn start_layout_update(
        &mut self,
        generation: u32,
        _cause: LayoutInvalidationCause,
        cancellation_reason: AgentOperationCancellationReason,
    ) -> KernelTransition {
        let Some(operation) = self.layout_operation.checked_add(1) else {
            return self.reject(NavigatorFailure::AgentOperationExhausted {
                message: "the content-agent operation counter is exhausted".to_string(),
            });
        };
        let Some(layout_generation) = self.layout_generation.checked_add(1) else {
            return self.reject(NavigatorFailure::LayoutGenerationExhausted {
                message: "the layout generation counter is exhausted".to_string(),
            });
        };
        if self
            .pending
            .as_ref()
            .is_some_and(|document| document.generation == generation)
            && self.retained_frame_needs_reconciliation(self.preferences)
            && let Err(failure) = Self::ensure_reconciliation_capacity(operation, layout_generation)
        {
            return self.reject(failure);
        }
        self.start_layout_update_allocated(
            generation,
            _cause,
            cancellation_reason,
            operation,
            layout_generation,
        )
    }
    pub(in crate::kernel) fn start_layout_update_allocated(
        &mut self,
        generation: u32,
        _cause: LayoutInvalidationCause,
        cancellation_reason: AgentOperationCancellationReason,
        operation: u32,
        layout_generation: u32,
    ) -> KernelTransition {
        let (events, effects) = self.queue_layout_update_allocated(
            generation,
            cancellation_reason,
            operation,
            layout_generation,
        );
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn queue_layout_update_allocated(
        &mut self,
        generation: u32,
        cancellation_reason: AgentOperationCancellationReason,
        operation: u32,
        layout_generation: u32,
    ) -> (Vec<KernelEvent>, Vec<KernelEffect>) {
        let occurrence = self
            .pending
            .as_ref()
            .filter(|document| document.generation == generation)
            .map(|document| document.frame().occurrence)
            .or_else(|| {
                self.committed
                    .as_ref()
                    .filter(|document| document.generation == generation)
                    .map(CommittedDocument::occurrence)
            })
            .expect("active layout generation has a document");
        let plan = resolve_layout_plan(
            self.publication
                .occurrence(occurrence)
                .expect("active occurrence exists"),
            self.preferences,
        );
        let phase = if self
            .pending
            .as_ref()
            .is_some_and(|document| document.generation == generation)
        {
            LayoutPhase::Initial
        } else {
            LayoutPhase::Update
        };
        let position = self.reflow_position(generation);
        let adapter_layout = PendingAdapterLayout::from_plan(plan, position)
            .expect("active adapter has an operational layout request");
        let mut events = Vec::new();
        self.cancel_agent_operations_for_generation(&mut events, generation, cancellation_reason);
        self.cancel_layout_operation(&mut events, cancellation_reason);
        self.layout_operation = operation;
        self.layout_generation = layout_generation;
        if let Some(document) = self
            .pending
            .as_mut()
            .filter(|document| document.generation == generation)
        {
            let frame = document.frame().clone();
            let supported_operations = match &document.state {
                PendingDocumentState::LayoutInitializing {
                    supported_operations,
                    ..
                } => supported_operations.clone(),
                _ => Vec::new(),
            };
            document.state = PendingDocumentState::LayoutInitializing {
                frame,
                supported_operations,
                plan,
            };
        } else if let Some(committed) = self
            .committed
            .as_mut()
            .filter(|document| document.generation == generation)
        {
            let current = committed.layout.clone();
            let (layout, observation) = match current {
                CommittedLayoutState::Settled {
                    layout,
                    observation,
                }
                | CommittedLayoutState::Dirty {
                    layout,
                    observation,
                    ..
                }
                | CommittedLayoutState::Updating {
                    layout,
                    observation,
                } => (layout, observation),
            };
            committed.layout = CommittedLayoutState::Updating {
                layout,
                observation,
            };
        }
        self.pending_layout = Some(PendingLayoutOperation {
            operation,
            frame_generation: self
                .pending
                .as_ref()
                .filter(|document| document.generation == generation)
                .map(PendingDocument::frame_generation)
                .or_else(|| {
                    self.committed
                        .as_ref()
                        .filter(|document| document.generation == generation)
                        .map(CommittedDocument::frame_generation)
                })
                .expect("active layout generation has a frame"),
            layout_generation,
            owner: LayoutOwner::Document {
                document_generation: generation,
                phase,
            },
            adapter: adapter_layout.clone(),
        });
        let frame_generation = self.pending_layout.as_ref().unwrap().frame_generation;
        events.push(KernelEvent::LayoutPending {
            participant: self.pending_layout.as_ref().unwrap().participant(),
            operation,
            generation,
            layout_generation,
            phase,
        });
        (
            events,
            vec![KernelEffect::LayoutRequest {
                owner: LayoutOwner::Document {
                    document_generation: generation,
                    phase,
                },
                operation,
                generation: frame_generation,
                layout_generation,
                request: adapter_layout.effect_request(),
            }],
        )
    }
    pub(in crate::kernel) fn cancel_layout_operation(
        &mut self,
        events: &mut Vec<KernelEvent>,
        reason: AgentOperationCancellationReason,
    ) {
        if let Some(pending) = self.pending_layout.take() {
            let Some((generation, _)) = pending.document() else {
                return;
            };
            events.push(KernelEvent::LayoutOperationFailed {
                participant: pending.participant(),
                operation: pending.operation,
                generation,
                failure: AgentOperationFailure::OperationCancelled { reason },
            });
        }
    }
    pub(in crate::kernel) fn cancel_layout_operation_for_generation(
        &mut self,
        events: &mut Vec<KernelEvent>,
        generation: u32,
        reason: AgentOperationCancellationReason,
    ) {
        if self.pending_layout.as_ref().is_some_and(|pending| {
            pending
                .document()
                .is_some_and(|owner| owner.0 == generation)
        }) {
            self.cancel_layout_operation(events, reason);
        }
    }
    pub(in crate::kernel) fn reconcile_retained_frame(
        &mut self,
        events: &mut Vec<KernelEvent>,
        effects: &mut Vec<KernelEffect>,
    ) {
        let Some(committed_generation) =
            self.committed.as_ref().map(|document| document.generation)
        else {
            return;
        };
        let retained_layout_invalidated = self.committed.as_ref().is_some_and(|committed| {
            matches!(committed.layout, CommittedLayoutState::Dirty { .. })
        });
        if !retained_layout_invalidated
            && (self.pending_layout.as_ref().is_some_and(|layout| {
                layout
                    .document()
                    .is_some_and(|owner| owner.0 == committed_generation)
                    && layout
                        .adapter
                        .plan()
                        .requested()
                        .is_none_or(|requested| requested == self.preferences)
                    && self.committed.as_ref().is_some_and(|committed| {
                        committed.layout.layout().settlement.plan() == layout.adapter.plan()
                    })
            }) || self.committed.as_ref().is_some_and(|committed| {
                committed
                    .layout
                    .layout()
                    .settlement
                    .plan()
                    .requested()
                    .is_none_or(|requested| requested == self.preferences)
            }))
        {
            return;
        }
        // Retained-frame layout takes the serialized layout slot from an in-flight preparation.
        if let Some(frame_generation) = self
            .pending_layout
            .as_ref()
            .filter(|layout| layout.owner == LayoutOwner::PreparedFrame)
            .map(|layout| layout.frame_generation)
        {
            self.prepared_frames
                .retain(|prepared| prepared.frame.generation != frame_generation);
            effects.push(KernelEffect::CancelFrame {
                generation: frame_generation,
            });
        }
        let operation = self
            .layout_operation
            .checked_add(1)
            .expect("a retained-frame preference reconciliation operation is available");
        let layout_generation = self
            .layout_generation
            .checked_add(1)
            .expect("a retained-frame preference reconciliation generation is available");
        let (new_events, new_effects) = self.queue_layout_update_allocated(
            committed_generation,
            if retained_layout_invalidated {
                AgentOperationCancellationReason::LayoutInvalidated
            } else {
                AgentOperationCancellationReason::PreferenceChanged
            },
            operation,
            layout_generation,
        );
        events.extend(new_events);
        effects.extend(new_effects);
    }
    pub(in crate::kernel) fn reconcile_dirty_layout(
        &mut self,
        events: &mut Vec<KernelEvent>,
        effects: &mut Vec<KernelEffect>,
    ) {
        if self.pending_layout.is_some() {
            return;
        }
        if let Some(generation) = self.committed.as_ref().and_then(|document| {
            matches!(document.layout, CommittedLayoutState::Dirty { .. })
                .then_some(document.generation)
        }) {
            let operation = self
                .layout_operation
                .checked_add(1)
                .expect("dirty primary reserved a reconciliation operation");
            let layout_generation = self
                .layout_generation
                .checked_add(1)
                .expect("dirty primary reserved a reconciliation generation");
            let (new_events, new_effects) = self.queue_layout_update_allocated(
                generation,
                AgentOperationCancellationReason::LayoutInvalidated,
                operation,
                layout_generation,
            );
            events.extend(new_events);
            effects.extend(new_effects);
            return;
        }
        let participant = self.fixed_companion.as_ref().and_then(|companion| {
            matches!(companion.layout, FixedCompanionLayoutState::Dirty { .. }).then_some(
                ActiveDocumentParticipant::FixedCompanion {
                    owner_document_generation: companion.owner_document_generation,
                    frame_generation: companion.frame.generation,
                },
            )
        });
        if let Some(participant) = participant {
            self.queue_fixed_companion_layout(participant, events, effects)
                .expect("dirty companion reserved a reconciliation transaction");
        }
        self.start_queued_prepared_layout(effects);
    }
    pub(in crate::kernel) fn retained_frame_needs_reconciliation(
        &self,
        preferences: PresentationPreferences,
    ) -> bool {
        self.committed.as_ref().is_some_and(|committed| {
            matches!(committed.layout, CommittedLayoutState::Dirty { .. })
                || committed
                    .layout
                    .layout()
                    .settlement
                    .plan()
                    .requested()
                    .is_some_and(|requested| requested != preferences)
        })
    }
    pub(in crate::kernel) fn ensure_reconciliation_capacity(
        operation: u32,
        layout_generation: u32,
    ) -> Result<(), NavigatorFailure> {
        if operation.checked_add(1).is_none() {
            return Err(NavigatorFailure::AgentOperationExhausted {
                message: "the content-agent operation counter cannot reserve retained-frame reconciliation"
                    .to_string(),
            });
        }
        if layout_generation.checked_add(1).is_none() {
            return Err(NavigatorFailure::LayoutGenerationExhausted {
                message:
                    "the layout generation counter cannot reserve retained-frame reconciliation"
                        .to_string(),
            });
        }
        Ok(())
    }
}
