use super::*;

impl NavigatorKernel {
    pub(in crate::kernel) fn open_occurrence(
        &mut self,
        ordinal: u32,
        exact_position: Option<Vec<PointEvidence>>,
    ) -> KernelTransition {
        let Some(occurrence) = self.publication.occurrence(ordinal).cloned() else {
            return self.reject(NavigatorFailure::OccurrenceOutOfBounds {
                message: "the reading-order occurrence is out of bounds".to_string(),
                occurrence: ordinal,
            });
        };
        let (resource, adapter) = match occurrence.document {
            OccurrenceDocumentTarget::Loadable { resource, adapter } => (resource, adapter),
            OccurrenceDocumentTarget::Unavailable { reason, .. } => {
                return self.reject(NavigatorFailure::OccurrenceUnavailable {
                    message: "the reading-order occurrence is not available for loading"
                        .to_string(),
                    occurrence: ordinal,
                    reason,
                });
            }
            OccurrenceDocumentTarget::Unresolved => {
                return self.reject(NavigatorFailure::OccurrenceUnresolved {
                    message: "the available occurrence has no local resource".to_string(),
                    occurrence: ordinal,
                });
            }
        };
        let Some(generation) = self.document_generation.checked_add(1) else {
            return self.reject(NavigatorFailure::DocumentGenerationExhausted {
                message: "the document generation counter is exhausted".to_string(),
            });
        };

        let superseded_promotion_frame = self.pending.as_ref().and_then(|pending| {
            matches!(
                pending.state,
                PendingDocumentState::PromotionAcknowledging { .. }
            )
            .then(|| pending.frame_generation())
        });
        let prepared_is_adjacent = self
            .committed
            .as_ref()
            .is_some_and(|committed| committed.occurrence().abs_diff(ordinal) == 1);
        if exact_position.is_none()
            && let Some(index) = self.prepared_frames.iter().position(|prepared| {
                prepared.frame.occurrence == ordinal
                    && prepared.is_prepared()
                    && prepared_is_adjacent
                    && Some(prepared.frame.generation) != superseded_promotion_frame
            })
        {
            let prepared = self.prepared_frames.remove(index);
            let frame_generation = prepared.frame.generation;
            let resource = prepared.frame.resource.clone();
            let mut events = Vec::new();
            let mut effects = Vec::new();
            self.remove_fixed_companion(
                &mut events,
                &mut effects,
                AgentOperationCancellationReason::Replacement,
            );
            self.cancel_pending_replacement(
                &mut events,
                &mut effects,
                AgentOperationCancellationReason::Replacement,
            );
            self.document_generation = generation;
            self.pending_exact_position = None;
            self.pending = Some(PendingDocument {
                generation,
                state: PendingDocumentState::PromotionAcknowledging {
                    prepared: Box::new(prepared),
                },
            });
            events.push(KernelEvent::DocumentPending {
                generation,
                occurrence: ordinal,
                resource,
            });
            effects.push(KernelEffect::PromoteFrame {
                frame_generation,
                document_generation: generation,
            });
            return self.accept(events, effects);
        }
        if exact_position.is_none()
            && prepared_is_adjacent
            && let Some(index) = self.prepared_frames.iter().position(|prepared| {
                prepared.frame.occurrence == ordinal && !prepared.is_prepared()
            })
        {
            let prepared = self.prepared_frames.remove(index);
            let resource = prepared.frame.resource.clone();
            let mut events = Vec::new();
            let mut effects = Vec::new();
            self.remove_fixed_companion(
                &mut events,
                &mut effects,
                AgentOperationCancellationReason::Replacement,
            );
            self.cancel_pending_replacement(
                &mut events,
                &mut effects,
                AgentOperationCancellationReason::Replacement,
            );
            self.document_generation = generation;
            self.pending_exact_position = None;
            self.pending = Some(PendingDocument {
                generation,
                state: PendingDocumentState::Preparing {
                    prepared: Box::new(prepared),
                },
            });
            events.push(KernelEvent::DocumentPending {
                generation,
                occurrence: ordinal,
                resource,
            });
            return self.accept(events, effects);
        }

        let Some(frame_generation) = self.frame_generation.checked_add(1) else {
            return self.reject(NavigatorFailure::FrameGenerationExhausted {
                message: "the physical frame generation counter is exhausted".to_string(),
            });
        };

        let mut events = Vec::new();
        let mut effects = Vec::new();
        self.remove_fixed_companion(
            &mut events,
            &mut effects,
            AgentOperationCancellationReason::Replacement,
        );
        self.cancel_pending_replacement(
            &mut events,
            &mut effects,
            AgentOperationCancellationReason::Replacement,
        );
        effects.extend(self.take_prepared_cancel_effects());
        if let Some(committed) = self.committed.as_mut()
            && let CommittedLayoutState::Updating {
                layout,
                observation,
            } = committed.layout.clone()
        {
            committed.layout = CommittedLayoutState::Settled {
                layout,
                observation,
            };
        }
        self.document_generation = generation;
        self.frame_generation = frame_generation;
        self.pending_exact_position = exact_position;
        self.pending = Some(PendingDocument {
            generation,
            state: PendingDocumentState::Loading {
                frame: PhysicalFrame {
                    generation: frame_generation,
                    occurrence: ordinal,
                    resource: resource.clone(),
                    adapter,
                },
            },
        });
        effects.push(KernelEffect::ReplaceFrame {
            generation: frame_generation,
            occurrence: ordinal,
            resource: resource.clone(),
        });
        events.push(KernelEvent::DocumentPending {
            generation,
            occurrence: ordinal,
            resource,
        });
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn navigate(&mut self, forward: bool) -> KernelTransition {
        let Some(current) = self.current_occurrence() else {
            return self.reject(NavigatorFailure::NoCurrentDocument {
                message: "there is no current document to navigate from".to_string(),
            });
        };
        let companion = self
            .fixed_companion
            .as_ref()
            .map(|companion| companion.frame.occurrence);
        let first_visible = companion.map_or(current, |occurrence| current.min(occurrence));
        let last_visible = companion.map_or(current, |occurrence| current.max(occurrence));
        let next = if forward {
            last_visible.checked_add(1)
        } else {
            first_visible.checked_sub(1)
        };
        let Some(next) = next.filter(|value| *value < self.publication.reading_order_length) else {
            let boundary = if forward {
                NavigationBoundary::End
            } else {
                NavigationBoundary::Start
            };
            return self.reject(NavigatorFailure::NavigationBoundary {
                message: "the reading-order navigation boundary was reached".to_string(),
                boundary,
            });
        };
        self.open_occurrence(next, None)
    }
    pub(in crate::kernel) fn cancel_document(&mut self) -> KernelTransition {
        let Some(pending) = self.pending.take() else {
            return self.reject(NavigatorFailure::NoPendingDocument {
                message: "there is no pending document to cancel".to_string(),
            });
        };
        let frame_generation = pending.frame_generation();
        self.clear_prepared_layout(frame_generation);
        let mut events = Vec::new();
        self.cancel_layout_operation_for_generation(
            &mut events,
            pending.generation,
            AgentOperationCancellationReason::DocumentInvalidated,
        );
        let mut effects = vec![KernelEffect::CancelFrame {
            generation: frame_generation,
        }];
        events.push(KernelEvent::DocumentCancelled {
            generation: pending.generation,
        });
        self.reconcile_retained_frame(&mut events, &mut effects);
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn frame_loaded(&mut self, generation: u32) -> KernelTransition {
        if let Some(prepared) = self
            .prepared_frame_mut(generation)
            .filter(|prepared| matches!(prepared.state, PreparedFrameState::Loading))
        {
            prepared.state = PreparedFrameState::AgentInitializing;
            let occurrence = prepared.frame.occurrence;
            let resource = prepared.frame.resource.clone();
            let adapter = prepared.frame.adapter;
            return self.accept(
                Vec::new(),
                vec![KernelEffect::InitializeAgent {
                    generation,
                    occurrence,
                    resource,
                    adapter,
                }],
            );
        }
        let expected = self.pending.as_ref().map(PendingDocument::frame_generation);
        if expected != Some(generation) {
            return self.stale(generation, expected);
        }
        let pending = self.pending.as_mut().expect("generation was checked");
        let PendingDocumentState::Loading { frame } = &pending.state else {
            return self.stale(generation, expected);
        };
        let frame = frame.clone();
        let occurrence = frame.occurrence;
        let resource = frame.resource.clone();
        let adapter = frame.adapter;
        pending.state = PendingDocumentState::AgentInitializing { frame };
        self.accept(
            Vec::new(),
            vec![KernelEffect::InitializeAgent {
                generation,
                occurrence,
                resource,
                adapter,
            }],
        )
    }
    pub(in crate::kernel) fn occurrence_entry_position(
        &self,
        occurrence: u32,
    ) -> ReflowPositionRequest {
        let Some(committed) = self.committed.as_ref() else {
            return ReflowPositionRequest::Unavailable;
        };
        ReflowPositionRequest::Entry {
            entry: if occurrence < committed.occurrence() {
                DocumentEntry::End
            } else {
                DocumentEntry::Start
            },
        }
    }
    pub(in crate::kernel) fn agent_ready(
        &mut self,
        generation: u32,
        supported_operations: Vec<AgentOperationKind>,
    ) -> KernelTransition {
        if self
            .prepared_frame(generation)
            .is_some_and(|prepared| matches!(prepared.state, PreparedFrameState::AgentInitializing))
        {
            return self.prepared_agent_ready(generation, supported_operations);
        }
        let expected = self.pending.as_ref().map(PendingDocument::frame_generation);
        if expected != Some(generation) {
            return self.stale(generation, expected);
        }
        if !matches!(
            self.pending.as_ref().expect("generation was checked").state,
            PendingDocumentState::AgentInitializing { .. }
        ) {
            return self.stale(generation, expected);
        }
        if supported_operations
            .iter()
            .enumerate()
            .any(|(index, operation)| supported_operations[..index].contains(operation))
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the content agent reported duplicate supported operations".to_string(),
            });
        }
        let occurrence_ordinal = self
            .pending
            .as_ref()
            .expect("generation was checked")
            .frame()
            .occurrence;
        let occurrence = self
            .publication
            .occurrence(occurrence_ordinal)
            .expect("pending occurrence exists");
        let plan = resolve_layout_plan(occurrence, self.preferences);
        let position = self.pending_exact_position.clone().map_or_else(
            || self.occurrence_entry_position(occurrence_ordinal),
            |evidence| ReflowPositionRequest::Exact {
                evidence,
                fallback_progression: 0.0,
            },
        );
        let adapter_layout = PendingAdapterLayout::from_plan(plan, position)
            .expect("available adapter has a layout request");
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
        if self.retained_frame_needs_reconciliation(self.preferences)
            && let Err(failure) = Self::ensure_reconciliation_capacity(operation, layout_generation)
        {
            return self.reject(failure);
        }
        let mut events = Vec::new();
        self.cancel_layout_operation(&mut events, AgentOperationCancellationReason::Replacement);
        self.layout_operation = operation;
        self.layout_generation = layout_generation;
        let pending = self.pending.as_mut().expect("generation was checked");
        let document_generation = pending.generation;
        let frame = pending.frame().clone();
        pending.state = PendingDocumentState::LayoutInitializing {
            frame,
            supported_operations,
            plan,
        };
        self.pending_layout = Some(PendingLayoutOperation {
            operation,
            frame_generation: generation,
            layout_generation,
            owner: LayoutOwner::Document {
                document_generation,
                phase: LayoutPhase::Initial,
            },
            adapter: adapter_layout.clone(),
        });
        events.push(KernelEvent::LayoutPending {
            participant: None,
            operation,
            generation: document_generation,
            layout_generation,
            phase: LayoutPhase::Initial,
        });
        self.accept(
            events,
            vec![KernelEffect::LayoutRequest {
                owner: LayoutOwner::Document {
                    document_generation,
                    phase: LayoutPhase::Initial,
                },
                operation,
                generation,
                layout_generation,
                request: adapter_layout.effect_request(),
            }],
        )
    }
    pub(in crate::kernel) fn readiness_timeout(&mut self, generation: u32) -> KernelTransition {
        if self
            .prepared_frame(generation)
            .is_some_and(|prepared| matches!(prepared.state, PreparedFrameState::AgentInitializing))
        {
            return self.fail_prepared(generation, FrameFailureReason::ReadinessTimeout);
        }
        let expected = self.pending.as_ref().map(PendingDocument::frame_generation);
        if expected != Some(generation)
            || !self.pending.as_ref().is_some_and(|document| {
                matches!(
                    document.state,
                    PendingDocumentState::AgentInitializing { .. }
                )
            })
        {
            return self.stale(generation, expected);
        }
        self.fail_pending(generation, FrameFailureReason::ReadinessTimeout)
    }
    pub(in crate::kernel) fn frame_failed(
        &mut self,
        generation: u32,
        reason: FrameFailureReason,
    ) -> KernelTransition {
        if self
            .fixed_companion
            .as_ref()
            .is_some_and(|companion| companion.frame.generation == generation)
        {
            let mut events = Vec::new();
            let mut effects = Vec::new();
            self.remove_fixed_companion(
                &mut events,
                &mut effects,
                AgentOperationCancellationReason::DocumentInvalidated,
            );
            self.reconcile_dirty_layout(&mut events, &mut effects);
            return self.accept(events, effects);
        }
        if self.pending.as_ref().is_some_and(|pending| {
            pending.frame_generation() == generation
                && matches!(
                    pending.state,
                    PendingDocumentState::PromotionAcknowledging { .. }
                )
        }) {
            let document_generation = self.pending.take().unwrap().generation;
            let mut events = vec![KernelEvent::DocumentLoadFailed {
                generation: document_generation,
                reason,
            }];
            let mut effects = vec![KernelEffect::CancelFrame { generation }];
            self.reconcile_retained_frame(&mut events, &mut effects);
            return self.accept(events, effects);
        }
        if self.prepared_frame(generation).is_some() {
            return self.fail_prepared(generation, reason);
        }
        let expected = self.pending.as_ref().map(PendingDocument::frame_generation);
        if expected != Some(generation) {
            return self.stale(generation, expected);
        }
        self.fail_pending(generation, reason)
    }
    pub(in crate::kernel) fn document_invalidated(
        &mut self,
        participant: ActiveDocumentParticipant,
        generation: u32,
        reason: DocumentInvalidationReason,
    ) -> KernelTransition {
        let expected = self.participant_frame(participant);
        if expected != Some(generation) {
            return self.stale(generation, expected);
        }
        if matches!(
            participant,
            ActiveDocumentParticipant::FixedCompanion { .. }
        ) {
            let mut events = vec![KernelEvent::DocumentInvalidated {
                participant,
                generation: participant.owner_document_generation(),
                reason,
            }];
            let mut effects = Vec::new();
            self.remove_fixed_companion(
                &mut events,
                &mut effects,
                AgentOperationCancellationReason::DocumentInvalidated,
            );
            self.reconcile_dirty_layout(&mut events, &mut effects);
            return self.accept(events, effects);
        }
        let committed = self.committed.take().unwrap();
        let document_generation = committed.generation;
        let mut events = vec![KernelEvent::DocumentInvalidated {
            participant,
            generation: document_generation,
            reason,
        }];
        let mut effects = Vec::new();
        self.remove_fixed_companion(
            &mut events,
            &mut effects,
            AgentOperationCancellationReason::DocumentInvalidated,
        );
        self.cancel_agent_operations_for_generation(
            &mut events,
            document_generation,
            AgentOperationCancellationReason::DocumentInvalidated,
        );
        self.cancel_layout_operation_for_generation(
            &mut events,
            document_generation,
            AgentOperationCancellationReason::DocumentInvalidated,
        );
        effects.push(KernelEffect::CancelFrame { generation });
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn close(&mut self) -> KernelTransition {
        let mut events = Vec::new();
        let mut effects = Vec::new();
        self.cancel_agent_operations(&mut events, AgentOperationCancellationReason::Close);
        self.cancel_layout_operation(&mut events, AgentOperationCancellationReason::Close);
        self.remove_fixed_companion(
            &mut events,
            &mut effects,
            AgentOperationCancellationReason::Close,
        );
        if let Some(document) = self.pending.take() {
            events.push(KernelEvent::DocumentCancelled {
                generation: document.generation,
            });
            effects.push(KernelEffect::CancelFrame {
                generation: document.frame_generation(),
            });
        }
        if let Some(document) = self.committed.take() {
            effects.push(KernelEffect::CancelFrame {
                generation: document.frame_generation(),
            });
        }
        effects.extend(self.take_prepared_cancel_effects());
        self.state = SessionState::Closed;
        events.push(KernelEvent::Closed);
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn frame_promoted(&mut self, frame_generation: u32) -> KernelTransition {
        let Some(pending) = self.pending.as_ref().filter(|pending| {
            pending.frame_generation() == frame_generation
                && matches!(
                    pending.state,
                    PendingDocumentState::PromotionAcknowledging { .. }
                )
        }) else {
            let expected = self.pending.as_ref().and_then(|pending| {
                matches!(
                    pending.state,
                    PendingDocumentState::PromotionAcknowledging { .. }
                )
                .then(|| pending.frame_generation())
            });
            return self.stale(frame_generation, expected);
        };
        let document_generation = pending.generation;
        let pending = self.pending.take().unwrap();
        let PendingDocumentState::PromotionAcknowledging { prepared } = pending.state else {
            unreachable!("promotion state was checked")
        };
        let PreparedFrameState::Prepared {
            supported_operations,
            layout: prepared_layout,
        } = prepared.state
        else {
            unreachable!("only settled prepared frames are promotable")
        };
        let layout_generation = prepared_layout.layout_generation;
        let settlement = prepared_layout.settlement;
        let observation = settlement.measurement().observation.clone();
        let occurrence = prepared.frame.occurrence;
        let resource = prepared.frame.resource.clone();
        let mut events = Vec::new();
        let mut effects = Vec::new();
        if let Some(previous_generation) =
            self.committed.as_ref().map(|previous| previous.generation)
        {
            self.cancel_layout_operation_for_generation(
                &mut events,
                previous_generation,
                AgentOperationCancellationReason::Replacement,
            );
        }
        let previous = self.committed.replace(CommittedDocument {
            generation: document_generation,
            frame: prepared.frame,
            supported_operations,
            layout: CommittedLayoutState::Settled {
                layout: CommittedLayout {
                    document_generation,
                    layout_generation,
                    settlement,
                },
                observation,
            },
        });
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
        let (retained, evicted): (Vec<_>, Vec<_>) = self
            .prepared_frames
            .drain(..)
            .partition(|prepared| prepared.frame.occurrence.abs_diff(occurrence) == 1);
        self.prepared_frames = retained;
        for prepared in evicted {
            self.clear_prepared_layout(prepared.frame.generation);
            effects.push(KernelEffect::CancelFrame {
                generation: prepared.frame.generation,
            });
        }
        events.push(KernelEvent::DocumentCommitted {
            generation: document_generation,
            occurrence,
            resource,
        });
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn cancel_pending_replacement(
        &mut self,
        events: &mut Vec<KernelEvent>,
        effects: &mut Vec<KernelEffect>,
        reason: AgentOperationCancellationReason,
    ) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        let frame_generation = pending.frame_generation();
        self.clear_prepared_layout(frame_generation);
        self.cancel_layout_operation_for_generation(events, pending.generation, reason);
        events.push(KernelEvent::DocumentCancelled {
            generation: pending.generation,
        });
        effects.push(KernelEffect::CancelFrame {
            generation: frame_generation,
        });
    }
    pub(in crate::kernel) fn fail_pending(
        &mut self,
        generation: u32,
        reason: FrameFailureReason,
    ) -> KernelTransition {
        let document_generation = self
            .pending
            .take()
            .expect("failed frame owns a pending document")
            .generation;
        let mut events = Vec::new();
        self.cancel_layout_operation_for_generation(
            &mut events,
            document_generation,
            AgentOperationCancellationReason::DocumentInvalidated,
        );
        events.push(KernelEvent::DocumentLoadFailed {
            generation: document_generation,
            reason,
        });
        let mut effects = vec![KernelEffect::CancelFrame { generation }];
        self.reconcile_retained_frame(&mut events, &mut effects);
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn current_occurrence(&self) -> Option<u32> {
        self.pending
            .as_ref()
            .map(|document| document.frame().occurrence)
            .or_else(|| self.committed.as_ref().map(CommittedDocument::occurrence))
    }
    pub(in crate::kernel) fn participant_frame(
        &self,
        participant: ActiveDocumentParticipant,
    ) -> Option<u32> {
        match participant {
            ActiveDocumentParticipant::Primary {
                document_generation,
            } => self
                .committed
                .as_ref()
                .filter(|document| document.generation == document_generation)
                .map(CommittedDocument::frame_generation),
            ActiveDocumentParticipant::FixedCompanion {
                owner_document_generation,
                frame_generation,
            } => {
                self.fixed_companion
                    .as_ref()
                    .filter(|companion| {
                        companion.owner_document_generation == owner_document_generation
                            && companion.frame.generation == frame_generation
                            && self.committed.as_ref().is_some_and(|primary| {
                                primary.generation == owner_document_generation
                            })
                    })
                    .map(|companion| companion.frame.generation)
            }
        }
    }
}
