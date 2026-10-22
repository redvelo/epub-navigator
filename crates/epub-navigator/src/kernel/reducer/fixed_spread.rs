use super::*;

impl NavigatorKernel {
    pub(in crate::kernel) fn attach_fixed_companion(
        &mut self,
        owner_document_generation: u32,
        frame_generation: u32,
        placement: FixedSpreadPlacement,
    ) -> KernelTransition {
        let expected_owner = self.committed.as_ref().map(|document| document.generation);
        if expected_owner != Some(owner_document_generation) {
            return self.stale(owner_document_generation, expected_owner);
        }
        if self.pending.is_some() {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "a fixed companion cannot be attached during primary replacement"
                    .to_string(),
            });
        }
        if self.fixed_companion.is_some() {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the committed primary already owns a fixed companion".to_string(),
            });
        }
        if placement == FixedSpreadPlacement::Center {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "a companion cannot occupy the center spread placement".to_string(),
            });
        }
        let primary = self
            .committed
            .as_ref()
            .expect("owner generation was checked");
        if !matches!(
            (
                primary.frame.adapter,
                primary.layout.layout().settlement.plan()
            ),
            (
                DocumentAdapter::ReflowableXhtml,
                AdapterLayoutPlan::ReflowableXhtml { .. }
            ) | (DocumentAdapter::FixedXhtml, AdapterLayoutPlan::FixedXhtml)
                | (DocumentAdapter::FixedSvg, AdapterLayoutPlan::FixedSvg)
                | (DocumentAdapter::FixedImage, AdapterLayoutPlan::FixedImage)
        ) {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "a fixed companion requires a settled primary page".to_string(),
            });
        }
        let Some(index) = self
            .prepared_frames
            .iter()
            .position(|prepared| prepared.frame.generation == frame_generation)
        else {
            return self.stale(frame_generation, None);
        };
        if self
            .prepared_frames
            .iter()
            .skip(index + 1)
            .any(|prepared| prepared.frame.generation == frame_generation)
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the physical frame has duplicate prepared ownership".to_string(),
            });
        }
        let prepared = &self.prepared_frames[index];
        if prepared.frame.generation == primary.frame.generation
            || prepared.frame.occurrence == primary.frame.occurrence
            || prepared.frame.occurrence.abs_diff(primary.frame.occurrence) != 1
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the companion must be a distinct adjacent occurrence".to_string(),
            });
        }
        let PreparedFrameState::Prepared { layout, .. } = &prepared.state else {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the companion frame has not reached a settled prepared state".to_string(),
            });
        };
        if !matches!(
            (&layout.settlement, prepared.frame.adapter),
            (
                AdapterLayoutSettlement::ReflowableXhtml { .. },
                DocumentAdapter::ReflowableXhtml
            ) | (
                AdapterLayoutSettlement::FixedXhtml { .. },
                DocumentAdapter::FixedXhtml
            ) | (
                AdapterLayoutSettlement::FixedSvg { .. },
                DocumentAdapter::FixedSvg
            ) | (
                AdapterLayoutSettlement::FixedImage { .. },
                DocumentAdapter::FixedImage
            )
        ) || !self.fixed_placement_compatible(primary.frame.occurrence, placement.opposite())
            || !self.fixed_placement_compatible(prepared.frame.occurrence, placement)
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the requested spread placement conflicts with authored page placement"
                    .to_string(),
            });
        }

        let prepared = self.prepared_frames.remove(index);
        let PreparedFrameState::Prepared {
            supported_operations,
            layout,
        } = prepared.state
        else {
            unreachable!("prepared state was checked")
        };
        let settlement = layout.settlement;
        let observation = FixedCompanionLayoutObservation {
            document: settlement.measurement().observation.clone(),
        };
        let companion_layout = FixedCompanionLayout {
            owner_document_generation,
            frame_generation,
            layout_generation: layout.layout_generation,
            settlement,
        };
        let occurrence = prepared.frame.occurrence;
        self.fixed_companion = Some(FixedCompanionDocument {
            owner_document_generation,
            frame: prepared.frame,
            placement,
            supported_operations,
            layout: FixedCompanionLayoutState::Settled {
                layout: companion_layout,
                observation,
            },
        });
        self.accept(
            vec![KernelEvent::FixedCompanionAttached {
                owner_document_generation,
                frame_generation,
                occurrence,
                placement,
            }],
            Vec::new(),
        )
    }
    pub(in crate::kernel) fn detach_fixed_companion(
        &mut self,
        owner_document_generation: u32,
        frame_generation: u32,
    ) -> KernelTransition {
        let expected_owner = self.committed.as_ref().map(|document| document.generation);
        if expected_owner != Some(owner_document_generation) {
            return self.stale(owner_document_generation, expected_owner);
        }
        let expected_frame = self
            .fixed_companion
            .as_ref()
            .map(|companion| companion.frame.generation);
        if expected_frame != Some(frame_generation) {
            return self.stale(frame_generation, expected_frame);
        }
        let mut events = Vec::new();
        let mut effects = Vec::new();
        self.remove_fixed_companion(
            &mut events,
            &mut effects,
            AgentOperationCancellationReason::FixedCompanionDetached,
        );
        self.reconcile_dirty_layout(&mut events, &mut effects);
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn fixed_companion_layout_result(
        &mut self,
        pending: PendingLayoutOperation,
        result: LayoutResult,
    ) -> KernelTransition {
        let participant = pending
            .participant()
            .expect("companion layout has a participant");
        let plan = pending.adapter.plan();
        if result.validate(plan).is_err() {
            return self.reject(NavigatorFailure::InvalidLayoutResult {
                message: "the companion layout result violates fixed-layout invariants".to_string(),
            });
        }
        self.pending_layout = None;
        let reported = KernelEvent::LayoutReported {
            participant: Some(participant),
            operation: pending.operation,
            generation: participant.owner_document_generation(),
            layout_generation: pending.layout_generation,
            result: result.clone(),
        };
        let TerminalLayout::Settled(settlement) =
            result.into_terminal(plan, ReflowPositionRequest::Unavailable)
        else {
            let mut events = vec![reported];
            let mut effects = Vec::new();
            self.remove_fixed_companion(
                &mut events,
                &mut effects,
                AgentOperationCancellationReason::LayoutInvalidated,
            );
            self.reconcile_dirty_layout(&mut events, &mut effects);
            return self.accept(events, effects);
        };
        let settlement = *settlement;
        let observation = FixedCompanionLayoutObservation {
            document: settlement.measurement().observation.clone(),
        };
        let companion = self
            .fixed_companion
            .as_mut()
            .expect("validated companion participant is still active");
        let was_reinvalidated = matches!(companion.layout, FixedCompanionLayoutState::Dirty { .. });
        if !was_reinvalidated {
            companion.layout = FixedCompanionLayoutState::Settled {
                layout: FixedCompanionLayout {
                    owner_document_generation: companion.owner_document_generation,
                    frame_generation: companion.frame.generation,
                    layout_generation: pending.layout_generation,
                    settlement,
                },
                observation,
            };
        }
        let mut events = vec![reported];
        let mut effects = Vec::new();
        self.reconcile_dirty_layout(&mut events, &mut effects);
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn fixed_companion_layout_failed(
        &mut self,
        pending: PendingLayoutOperation,
        delivery_message: Option<String>,
    ) -> KernelTransition {
        let participant = pending
            .participant()
            .expect("companion layout has a participant");
        let failure = delivery_message.map_or_else(
            || AgentOperationFailure::OperationTimeout {
                message: "the companion layout operation timed out".to_string(),
            },
            |message| AgentOperationFailure::OperationDeliveryFailed { message },
        );
        let mut events = vec![KernelEvent::LayoutOperationFailed {
            participant: Some(participant),
            operation: pending.operation,
            generation: participant.owner_document_generation(),
            failure,
        }];
        let mut effects = Vec::new();
        self.remove_fixed_companion(
            &mut events,
            &mut effects,
            AgentOperationCancellationReason::LayoutInvalidated,
        );
        self.reconcile_dirty_layout(&mut events, &mut effects);
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn fixed_companion_layout_invalidated(
        &mut self,
        participant: ActiveDocumentParticipant,
        cause: LayoutInvalidationCause,
    ) -> KernelTransition {
        if self.layout_operation.checked_add(1).is_none() {
            return self.reject(NavigatorFailure::AgentOperationExhausted {
                message:
                    "the content-agent operation counter cannot reserve companion reconciliation"
                        .to_string(),
            });
        }
        if self.layout_generation.checked_add(1).is_none() {
            return self.reject(NavigatorFailure::LayoutGenerationExhausted {
                message: "the layout generation counter cannot reserve companion reconciliation"
                    .to_string(),
            });
        }
        let companion = self
            .fixed_companion
            .as_mut()
            .expect("participant validation found the companion");
        let (layout, observation) = match companion.layout.clone() {
            FixedCompanionLayoutState::Settled {
                layout,
                observation,
            }
            | FixedCompanionLayoutState::Dirty {
                layout,
                observation,
                ..
            }
            | FixedCompanionLayoutState::Updating {
                layout,
                observation,
            } => (layout, observation),
        };
        companion.layout = FixedCompanionLayoutState::Dirty {
            layout,
            observation,
            cause,
        };
        if self.pending_layout.is_some() {
            return self.accept(Vec::new(), Vec::new());
        }
        let mut events = Vec::new();
        let mut effects = Vec::new();
        if let Err(failure) =
            self.queue_fixed_companion_layout(participant, &mut events, &mut effects)
        {
            return self.reject(failure);
        }
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn queue_fixed_companion_layout(
        &mut self,
        participant: ActiveDocumentParticipant,
        events: &mut Vec<KernelEvent>,
        effects: &mut Vec<KernelEffect>,
    ) -> Result<(), NavigatorFailure> {
        let Some(operation) = self.layout_operation.checked_add(1) else {
            return Err(NavigatorFailure::AgentOperationExhausted {
                message: "the content-agent operation counter is exhausted".to_string(),
            });
        };
        let Some(layout_generation) = self.layout_generation.checked_add(1) else {
            return Err(NavigatorFailure::LayoutGenerationExhausted {
                message: "the layout generation counter is exhausted".to_string(),
            });
        };
        let ActiveDocumentParticipant::FixedCompanion {
            owner_document_generation,
            frame_generation,
        } = participant
        else {
            unreachable!("only a fixed companion can own this layout")
        };
        let (companion_occurrence, companion_adapter) = {
            let companion = self
                .fixed_companion
                .as_ref()
                .expect("participant validation found the companion");
            (companion.frame.occurrence, companion.frame.adapter)
        };
        let adapter = match companion_adapter {
            DocumentAdapter::FixedXhtml => PendingAdapterLayout::FixedXhtml,
            DocumentAdapter::FixedSvg => PendingAdapterLayout::FixedSvg,
            DocumentAdapter::FixedImage => PendingAdapterLayout::FixedImage,
            // A reflowable companion shows its first page, so it re-lays out from its entry
            // position under the current preferences, as its preparation did.
            DocumentAdapter::ReflowableXhtml => {
                let position = self.occurrence_entry_position(companion_occurrence);
                let plan = resolve_layout_plan(
                    self.publication
                        .occurrence(companion_occurrence)
                        .expect("companion occurrence exists"),
                    self.preferences,
                );
                PendingAdapterLayout::from_plan(plan, position)
                    .expect("a reflowable companion has a layout request")
            }
        };
        let companion = self
            .fixed_companion
            .as_mut()
            .expect("participant validation found the companion");
        let (layout, observation) = match companion.layout.clone() {
            FixedCompanionLayoutState::Settled {
                layout,
                observation,
            }
            | FixedCompanionLayoutState::Dirty {
                layout,
                observation,
                ..
            }
            | FixedCompanionLayoutState::Updating {
                layout,
                observation,
            } => (layout, observation),
        };
        companion.layout = FixedCompanionLayoutState::Updating {
            layout,
            observation,
        };
        let owner = LayoutOwner::FixedCompanion {
            owner_document_generation,
            frame_generation,
        };
        self.layout_operation = operation;
        self.layout_generation = layout_generation;
        self.pending_layout = Some(PendingLayoutOperation {
            operation,
            frame_generation,
            layout_generation,
            owner,
            adapter: adapter.clone(),
        });
        events.push(KernelEvent::LayoutPending {
            participant: Some(participant),
            operation,
            generation: owner_document_generation,
            layout_generation,
            phase: LayoutPhase::Update,
        });
        effects.push(KernelEffect::LayoutRequest {
            owner,
            operation,
            generation: frame_generation,
            layout_generation,
            request: adapter.effect_request(),
        });
        Ok(())
    }
    pub(in crate::kernel) fn fixed_placement_compatible(
        &self,
        occurrence: u32,
        placement: FixedSpreadPlacement,
    ) -> bool {
        let expected = match placement {
            FixedSpreadPlacement::Left => OccurrencePageSpread::Left,
            FixedSpreadPlacement::Right => OccurrencePageSpread::Right,
            FixedSpreadPlacement::Center => OccurrencePageSpread::Center,
        };
        match &self
            .publication
            .occurrence(occurrence)
            .expect("owned occurrence exists")
            .presentation
            .page_spread
        {
            OccurrenceRenditionSetting::Unspecified => true,
            OccurrenceRenditionSetting::Specified(candidate) => candidate.value == Some(expected),
            OccurrenceRenditionSetting::Ambiguous(_) => false,
        }
    }
    pub(in crate::kernel) fn remove_fixed_companion(
        &mut self,
        events: &mut Vec<KernelEvent>,
        effects: &mut Vec<KernelEffect>,
        cancellation_reason: AgentOperationCancellationReason,
    ) {
        let Some(companion) = self.fixed_companion.take() else {
            return;
        };
        let participant = ActiveDocumentParticipant::FixedCompanion {
            owner_document_generation: companion.owner_document_generation,
            frame_generation: companion.frame.generation,
        };
        let mut index = 0;
        while index < self.pending_operations.len() {
            if self.pending_operations[index].participant != participant {
                index += 1;
                continue;
            }
            let pending = self.pending_operations.remove(index);
            events.push(KernelEvent::AgentOperationFailed {
                participant,
                operation: pending.operation,
                generation: companion.owner_document_generation,
                operation_kind: pending.operation_kind(),
                failure: AgentOperationFailure::OperationCancelled {
                    reason: cancellation_reason,
                },
            });
        }
        if self
            .pending_layout
            .as_ref()
            .is_some_and(|pending| pending.participant() == Some(participant))
            && let Some(pending) = self.pending_layout.take()
        {
            events.push(KernelEvent::LayoutOperationFailed {
                participant: Some(participant),
                operation: pending.operation,
                generation: companion.owner_document_generation,
                failure: AgentOperationFailure::OperationCancelled {
                    reason: cancellation_reason,
                },
            });
        }
        events.push(KernelEvent::FixedCompanionDetached {
            owner_document_generation: companion.owner_document_generation,
            frame_generation: companion.frame.generation,
        });
        effects.push(KernelEffect::CancelFrame {
            generation: companion.frame.generation,
        });
    }
}
