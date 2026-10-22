use super::*;

impl NavigatorKernel {
    pub(in crate::kernel) fn prepare_occurrence(&mut self, ordinal: u32) -> KernelTransition {
        if self.pending.is_some() {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "preparation is unavailable while a document replacement is pending"
                    .to_string(),
            });
        }
        let Some(committed) = self.committed.as_ref() else {
            return self.reject(NavigatorFailure::NoCurrentDocument {
                message: "preparation requires a committed document".to_string(),
            });
        };
        let current = committed.occurrence();
        let companion = self
            .fixed_companion
            .as_ref()
            .filter(|companion| companion.owner_document_generation == committed.generation)
            .map(|companion| companion.frame.occurrence);
        let first_visible = companion.map_or(current, |occurrence| current.min(occurrence));
        let last_visible = companion.map_or(current, |occurrence| current.max(occurrence));
        if first_visible.checked_sub(1) != Some(ordinal)
            && last_visible.checked_add(1) != Some(ordinal)
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message:
                    "only an occurrence adjacent to the visible occurrence range can be prepared"
                        .to_string(),
            });
        }
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
                    message: "the reading-order occurrence is not available for preparation"
                        .to_string(),
                    occurrence: ordinal,
                    reason,
                });
            }
            OccurrenceDocumentTarget::Unresolved => {
                return self.reject(NavigatorFailure::OccurrenceUnresolved {
                    message: "the reading-order occurrence is unresolved".to_string(),
                    occurrence: ordinal,
                });
            }
        };
        if self
            .prepared_frames
            .iter()
            .any(|prepared| prepared.frame.occurrence == ordinal)
        {
            return self.accept(Vec::new(), Vec::new());
        }
        if self.physical_frame_count() >= 3
            || self.prepared_frames.len() >= 2
            || self.pending_layout.is_some()
            || self
                .prepared_frames
                .iter()
                .any(|prepared| !prepared.is_prepared())
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "preparation is serialized and limited to two frames".to_string(),
            });
        }
        let Some(frame_generation) = self.frame_generation.checked_add(1) else {
            return self.reject(NavigatorFailure::FrameGenerationExhausted {
                message: "the physical frame generation counter is exhausted".to_string(),
            });
        };
        self.frame_generation = frame_generation;
        self.prepared_frames.push(PreparedFrame {
            frame: PhysicalFrame {
                generation: frame_generation,
                occurrence: ordinal,
                resource: resource.clone(),
                adapter,
            },
            state: PreparedFrameState::Loading,
        });
        self.accept(
            Vec::new(),
            vec![KernelEffect::CreatePreparedFrame {
                generation: frame_generation,
                occurrence: ordinal,
                resource,
            }],
        )
    }
    pub(in crate::kernel) fn evict_prepared_frames(&mut self) -> KernelTransition {
        let mut events = Vec::new();
        let mut effects = Vec::new();
        if self.pending.as_ref().is_some_and(|pending| {
            matches!(
                pending.state,
                PendingDocumentState::Preparing { .. }
                    | PendingDocumentState::PromotionAcknowledging { .. }
            )
        }) {
            let pending = self.pending.take().unwrap();
            self.clear_prepared_layout(pending.frame_generation());
            events.push(KernelEvent::DocumentCancelled {
                generation: pending.generation,
            });
            effects.push(KernelEffect::CancelFrame {
                generation: pending.frame_generation(),
            });
        }
        effects.extend(self.take_prepared_cancel_effects());
        self.reconcile_retained_frame(&mut events, &mut effects);
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn prepared_frame(&self, generation: u32) -> Option<&PreparedFrame> {
        self.prepared_frames
            .iter()
            .find(|prepared| prepared.frame.generation == generation)
            .or_else(
                || match self.pending.as_ref().map(|pending| &pending.state) {
                    Some(PendingDocumentState::Preparing { prepared })
                        if prepared.frame.generation == generation =>
                    {
                        Some(prepared)
                    }
                    _ => None,
                },
            )
    }
    pub(in crate::kernel) fn prepared_frame_mut(
        &mut self,
        generation: u32,
    ) -> Option<&mut PreparedFrame> {
        if let Some(index) = self
            .prepared_frames
            .iter()
            .position(|prepared| prepared.frame.generation == generation)
        {
            return Some(&mut self.prepared_frames[index]);
        }
        match self.pending.as_mut().map(|pending| &mut pending.state) {
            Some(PendingDocumentState::Preparing { prepared })
                if prepared.frame.generation == generation =>
            {
                Some(prepared)
            }
            _ => None,
        }
    }
    pub(in crate::kernel) fn adopted_frame_generation(&self) -> Option<u32> {
        match self.pending.as_ref().map(|pending| &pending.state) {
            Some(PendingDocumentState::Preparing { prepared }) => Some(prepared.frame.generation),
            _ => None,
        }
    }
    pub(in crate::kernel) fn clear_prepared_layout(&mut self, frame_generation: u32) {
        if self.pending_layout.as_ref().is_some_and(|pending| {
            pending.owner == LayoutOwner::PreparedFrame
                && pending.frame_generation == frame_generation
        }) {
            self.pending_layout = None;
        }
    }
    pub(in crate::kernel) fn prepared_agent_ready(
        &mut self,
        frame_generation: u32,
        supported_operations: Vec<AgentOperationKind>,
    ) -> KernelTransition {
        if supported_operations
            .iter()
            .enumerate()
            .any(|(index, operation)| supported_operations[..index].contains(operation))
        {
            return self.fail_prepared(
                frame_generation,
                FrameFailureReason::EffectExecutionFailed {
                    message: "the content agent reported duplicate supported operations"
                        .to_string(),
                },
            );
        }
        if self.pending_layout.is_some() {
            self.prepared_frame_mut(frame_generation)
                .expect("prepared frame exists")
                .state = PreparedFrameState::LayoutQueued {
                supported_operations,
            };
            return self.accept(Vec::new(), Vec::new());
        }
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
        let effect = self.start_prepared_layout(
            frame_generation,
            supported_operations,
            operation,
            layout_generation,
        );
        self.accept(Vec::new(), vec![effect])
    }
    pub(in crate::kernel) fn start_queued_prepared_layout(
        &mut self,
        effects: &mut Vec<KernelEffect>,
    ) {
        if self.pending_layout.is_some() {
            return;
        }
        let queued = |prepared: &PreparedFrame| {
            matches!(prepared.state, PreparedFrameState::LayoutQueued { .. })
        };
        let Some(frame_generation) = self
            .adopted_frame_generation()
            .filter(|generation| self.prepared_frame(*generation).is_some_and(queued))
            .or_else(|| {
                self.prepared_frames
                    .iter()
                    .find(|prepared| queued(prepared))
                    .map(|prepared| prepared.frame.generation)
            })
        else {
            return;
        };
        let (Some(operation), Some(layout_generation)) = (
            self.layout_operation.checked_add(1),
            self.layout_generation.checked_add(1),
        ) else {
            return;
        };
        let prepared = self
            .prepared_frame_mut(frame_generation)
            .expect("queued prepared frame exists");
        let PreparedFrameState::LayoutQueued {
            supported_operations,
        } = std::mem::replace(&mut prepared.state, PreparedFrameState::Loading)
        else {
            unreachable!("prepared frame is queued")
        };
        effects.push(self.start_prepared_layout(
            frame_generation,
            supported_operations,
            operation,
            layout_generation,
        ));
    }
    fn start_prepared_layout(
        &mut self,
        frame_generation: u32,
        supported_operations: Vec<AgentOperationKind>,
        operation: u32,
        layout_generation: u32,
    ) -> KernelEffect {
        let prepared_occurrence = self
            .prepared_frame(frame_generation)
            .expect("prepared frame exists")
            .frame
            .occurrence;
        let position = self.occurrence_entry_position(prepared_occurrence);
        let plan = resolve_layout_plan(
            self.publication
                .occurrence(prepared_occurrence)
                .expect("prepared occurrence exists"),
            self.preferences,
        );
        let adapter_layout = PendingAdapterLayout::from_plan(plan, position)
            .expect("available adapter has a layout request");
        self.prepared_frame_mut(frame_generation)
            .expect("prepared frame exists")
            .state = PreparedFrameState::LayoutInitializing {
            supported_operations,
            plan,
        };
        self.layout_operation = operation;
        self.layout_generation = layout_generation;
        self.pending_layout = Some(PendingLayoutOperation {
            operation,
            frame_generation,
            layout_generation,
            owner: LayoutOwner::PreparedFrame,
            adapter: adapter_layout.clone(),
        });
        KernelEffect::LayoutRequest {
            owner: LayoutOwner::PreparedFrame,
            operation,
            generation: frame_generation,
            layout_generation,
            request: adapter_layout.effect_request(),
        }
    }
    pub(in crate::kernel) fn prepared_layout_result(
        &mut self,
        _operation: u32,
        frame_generation: u32,
        layout_generation: u32,
        result: LayoutResult,
    ) -> KernelTransition {
        let pending_layout = self
            .pending_layout
            .clone()
            .expect("prepared layout operation exists");
        let plan = pending_layout.adapter.plan();
        if result.validate(plan).is_err() {
            return self.fail_prepared(
                frame_generation,
                FrameFailureReason::EffectExecutionFailed {
                    message: "the layout result violates adapter settlement invariants".to_string(),
                },
            );
        }
        let settlement = match result.into_terminal(plan, pending_layout.adapter.position()) {
            TerminalLayout::Settled(settlement) => settlement,
            TerminalLayout::ReflowableConflict(issue) => {
                return self.fail_prepared(
                    frame_generation,
                    FrameFailureReason::ReflowableLayoutConflict { issue },
                );
            }
            TerminalLayout::ReflowableUnavailable(issue) => {
                return self.fail_prepared(
                    frame_generation,
                    FrameFailureReason::ReflowableLayoutUnavailable { issue },
                );
            }
            TerminalLayout::FixedConflict(issue) => {
                return self.fail_prepared(
                    frame_generation,
                    FrameFailureReason::FixedLayoutConflict { issue },
                );
            }
            TerminalLayout::FixedUnavailable(issue) => {
                return self.fail_prepared(
                    frame_generation,
                    FrameFailureReason::FixedLayoutUnavailable { issue },
                );
            }
        };
        let prepared = self
            .prepared_frame_mut(frame_generation)
            .expect("prepared layout owner exists");
        let PreparedFrameState::LayoutInitializing {
            supported_operations,
            ..
        } = std::mem::replace(&mut prepared.state, PreparedFrameState::Loading)
        else {
            unreachable!("prepared layout owner is initializing")
        };
        prepared.state = PreparedFrameState::Prepared {
            supported_operations,
            layout: Box::new(PreparedLayout {
                layout_generation,
                settlement: *settlement,
            }),
        };
        self.pending_layout = None;
        if self.adopted_frame_generation() != Some(frame_generation) {
            return self.accept(Vec::new(), Vec::new());
        }
        let pending = self.pending.take().expect("adopted frame is pending");
        let document_generation = pending.generation;
        let PendingDocumentState::Preparing { prepared } = pending.state else {
            unreachable!("adopted frame is preparing")
        };
        self.pending = Some(PendingDocument {
            generation: document_generation,
            state: PendingDocumentState::PromotionAcknowledging { prepared },
        });
        self.accept(
            Vec::new(),
            vec![KernelEffect::PromoteFrame {
                frame_generation,
                document_generation,
            }],
        )
    }
    pub(in crate::kernel) fn fail_prepared(
        &mut self,
        frame_generation: u32,
        reason: FrameFailureReason,
    ) -> KernelTransition {
        if self.adopted_frame_generation() == Some(frame_generation) {
            self.clear_prepared_layout(frame_generation);
            return self.fail_pending(frame_generation, reason);
        }
        let Some(index) = self
            .prepared_frames
            .iter()
            .position(|prepared| prepared.frame.generation == frame_generation)
        else {
            return self.stale(frame_generation, None);
        };
        self.prepared_frames.remove(index);
        self.clear_prepared_layout(frame_generation);
        self.accept(
            Vec::new(),
            vec![KernelEffect::CancelFrame {
                generation: frame_generation,
            }],
        )
    }
    pub(in crate::kernel) fn take_prepared_cancel_effects(&mut self) -> Vec<KernelEffect> {
        if self.pending_layout.as_ref().is_some_and(|pending| {
            pending.owner == LayoutOwner::PreparedFrame
                && self
                    .prepared_frames
                    .iter()
                    .any(|prepared| prepared.frame.generation == pending.frame_generation)
        }) {
            self.pending_layout = None;
        }
        self.prepared_frames
            .drain(..)
            .map(|prepared| KernelEffect::CancelFrame {
                generation: prepared.frame.generation,
            })
            .collect()
    }
}
