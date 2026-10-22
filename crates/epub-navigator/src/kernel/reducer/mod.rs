use super::*;

mod agent;
mod annotation;
mod decoration;
mod document;
mod fixed_spread;
mod layout;
mod location;
mod preparation;
mod selection;

impl NavigatorKernel {
    /// Creates a kernel from the browser boundary's JSON publication handoff.
    pub fn create(initialization_json: &str) -> Result<Self, KernelError> {
        let initialization: KernelInitialization = serde_json::from_str(initialization_json)
            .map_err(|_| KernelError::InvalidInitialization)?;
        initialization.mount.validate()?;
        let publication = KernelPublication::from_facts(&initialization.facts)?;
        Ok(Self {
            state_revision: 0,
            state: SessionState::Open,
            publication,
            document_generation: 0,
            frame_generation: 0,
            layout_generation: 0,
            pending: None,
            pending_exact_position: None,
            committed: None,
            fixed_companion: None,
            agent_operation: 0,
            layout_operation: 0,
            pending_operations: Vec::new(),
            decoration_projection: DecorationProjection {
                revision: 0,
                records: Vec::new(),
            },
            decoration_record_positions: Vec::new(),
            projected_decorations: Vec::new(),
            decoration_outcomes: Vec::new(),
            preferences: initialization.preferences,
            pending_layout: None,
            prepared_frames: Vec::new(),
        })
    }
    /// Applies one command or browser report atomically.
    pub fn dispatch(&mut self, input: impl Into<KernelInput>) -> KernelTransition {
        let input = input.into();
        if self.state_revision == u32::MAX
            || (self.state_revision == u32::MAX - 1
                && !matches!(
                    &input,
                    KernelInput::Command {
                        command: NavigatorCommand::Close {}
                    }
                ))
        {
            return self.reject(NavigatorFailure::StateRevisionExhausted {
                message: "the state revision counter is exhausted".to_string(),
            });
        }

        if self.state == SessionState::Closed {
            return KernelTransition {
                accepted: false,
                state_revision: self.state_revision,
                events: Vec::new(),
                effects: Vec::new(),
                failure: Some(NavigatorFailure::KernelClosed {
                    message: "the Navigator kernel is closed".to_string(),
                }),
            };
        }

        match input {
            KernelInput::Command { command } => self.dispatch_command(command),
            KernelInput::Frame { frame } => self.dispatch_frame(frame),
            KernelInput::Adapter { adapter } => self.dispatch_adapter(adapter),
        }
    }
    pub(in crate::kernel) fn dispatch_command(
        &mut self,
        command: NavigatorCommand,
    ) -> KernelTransition {
        match command {
            NavigatorCommand::OpenOccurrence { occurrence } => {
                self.open_occurrence(occurrence, None)
            }
            NavigatorCommand::OpenOccurrenceAt {
                occurrence,
                evidence,
            } => {
                if validate_nonempty_point_evidence(&evidence).is_err() {
                    return self.reject(NavigatorFailure::InvalidCommand {
                        message: "exact occurrence opening requires valid point evidence"
                            .to_string(),
                    });
                }
                self.open_occurrence(occurrence, Some(evidence))
            }
            NavigatorCommand::PrepareOccurrence { occurrence } => {
                self.prepare_occurrence(occurrence)
            }
            NavigatorCommand::AttachFixedCompanion {
                owner_document_generation,
                frame_generation,
                placement,
            } => {
                self.attach_fixed_companion(owner_document_generation, frame_generation, placement)
            }
            NavigatorCommand::DetachFixedCompanion {
                owner_document_generation,
                frame_generation,
            } => self.detach_fixed_companion(owner_document_generation, frame_generation),
            NavigatorCommand::EvictPreparedFrames {} => self.evict_prepared_frames(),
            NavigatorCommand::Previous {} => self.navigate(false),
            NavigatorCommand::Next {} => self.navigate(true),
            NavigatorCommand::Reload {} => {
                let Some(occurrence) = self.current_occurrence() else {
                    return self.reject(NavigatorFailure::NoCurrentDocument {
                        message: "there is no current document to reload".to_string(),
                    });
                };
                self.open_occurrence(occurrence, None)
            }
            NavigatorCommand::CancelDocument {} => self.cancel_document(),
            NavigatorCommand::ResolveLocator { locator } => self.resolve_locator(locator),
            NavigatorCommand::Relocate { locator } => self.relocate(locator),
            NavigatorCommand::ResolveAnnotationTarget { plan } => {
                self.annotation_target_operation(plan, false)
            }
            NavigatorCommand::RelocateAnnotationTarget { plan } => {
                self.annotation_target_operation(plan, true)
            }
            NavigatorCommand::CaptureSelection { participant } => {
                self.capture_selection(participant)
            }
            NavigatorCommand::CaptureCurrentLocation {} => self.capture_current_location(),
            NavigatorCommand::FindMediaOverlayEntry {
                occurrence,
                fragments,
            } => self.find_media_overlay_entry(occurrence, fragments),
            NavigatorCommand::GenerateAnnotationTarget {
                participant,
                location,
                local_content_basis,
                text_fragment_policy,
            } => self.generate_annotation_target(
                participant,
                location,
                local_content_basis,
                text_fragment_policy,
            ),
            NavigatorCommand::GenerateCurrentLocationAnnotationTarget {
                participant,
                location,
                local_content_basis,
            } => self.generate_current_location_annotation_target(
                participant,
                location,
                local_content_basis,
            ),
            NavigatorCommand::CancelSelectionAnnotationTargetGeneration {} => {
                self.cancel_selection_annotation_target_generation()
            }
            NavigatorCommand::SetDecorationProjection { projection } => {
                self.set_decoration_projection(projection)
            }
            NavigatorCommand::ReconcileDecorations {} => self.reconcile_decorations(),
            NavigatorCommand::AdjustAnnotationRange {
                participant,
                projection_revision,
                record_id,
                edge,
                movement,
            } => self.adjust_annotation_range(
                participant,
                projection_revision,
                record_id,
                edge,
                movement,
            ),
            NavigatorCommand::AdvancePresentation { direction, target } => {
                self.advance_presentation(direction, target)
            }
            NavigatorCommand::SetPresentationPreferences { preferences } => {
                self.set_presentation_preferences(preferences)
            }
            NavigatorCommand::Close {} => self.close(),
            NavigatorCommand::ValidateLocator { locator } => match locator
                .validate()
                .and_then(|()| self.publication.validate_locator_context(&locator))
            {
                Ok(()) => self.accept(vec![KernelEvent::LocatorValidated], Vec::new()),
                Err(_) => self.reject(NavigatorFailure::InvalidLocator {
                    message: "the publication locator is invalid".to_string(),
                }),
            },
        }
    }
    pub(in crate::kernel) fn dispatch_frame(
        &mut self,
        frame: FrameObservation,
    ) -> KernelTransition {
        match frame {
            FrameObservation::Loaded { generation } => self.frame_loaded(generation),
            FrameObservation::Failed { generation, reason } => {
                self.frame_failed(generation, reason)
            }
            FrameObservation::Promoted { frame_generation } => {
                self.frame_promoted(frame_generation)
            }
        }
    }
    pub(in crate::kernel) fn dispatch_adapter(
        &mut self,
        adapter: AdapterObservation,
    ) -> KernelTransition {
        match adapter {
            AdapterObservation::Ready {
                generation,
                supported_operations,
            } => self.agent_ready(generation, supported_operations),
            AdapterObservation::ReadinessTimeout { generation } => {
                self.readiness_timeout(generation)
            }
            AdapterObservation::DocumentInvalidated {
                participant,
                generation,
                reason,
            } => self.document_invalidated(participant, generation, reason),
            AdapterObservation::AgentResult {
                participant,
                operation,
                generation,
                result,
            } => self.agent_result(participant, operation, generation, result),
            AdapterObservation::LayoutResult {
                participant,
                operation,
                generation,
                layout_generation,
                result,
            } => self.layout_result(
                participant,
                operation,
                generation,
                layout_generation,
                result,
            ),
            AdapterObservation::LayoutTimeout {
                participant,
                operation,
                generation,
                layout_generation,
            } => self.layout_failed(participant, operation, generation, layout_generation, None),
            AdapterObservation::LayoutDeliveryFailed {
                participant,
                operation,
                generation,
                layout_generation,
                message,
            } => self.layout_failed(
                participant,
                operation,
                generation,
                layout_generation,
                Some(message),
            ),
            AdapterObservation::LayoutInvalidated {
                participant,
                generation,
                cause,
            } => self.layout_invalidated(participant, generation, cause),
            AdapterObservation::OperationTimeout {
                participant,
                operation,
                generation,
            } => self.operation_timeout(participant, operation, generation),
            AdapterObservation::OperationDeliveryFailed {
                participant,
                operation,
                generation,
                message,
            } => self.operation_delivery_failed(participant, operation, generation, message),
            AdapterObservation::DocumentObserved {
                participant,
                generation,
                observation,
            } => self.document_observed(participant, generation, observation),
            AdapterObservation::LinkActivated {
                participant,
                generation,
                activation,
            } => self.link_activated(participant, generation, activation),
        }
    }
    pub(in crate::kernel) fn physical_frame_count(&self) -> usize {
        let mut generations = Vec::with_capacity(4);
        if let Some(committed) = &self.committed {
            generations.push(committed.frame_generation());
        }
        if let Some(companion) = &self.fixed_companion
            && !generations.contains(&companion.frame.generation)
        {
            generations.push(companion.frame.generation);
        }
        if let Some(pending) = &self.pending
            && !generations.contains(&pending.frame_generation())
        {
            generations.push(pending.frame_generation());
        }
        for prepared in &self.prepared_frames {
            if !generations.contains(&prepared.frame.generation) {
                generations.push(prepared.frame.generation);
            }
        }
        generations.len()
    }
    pub(in crate::kernel) fn stale(
        &self,
        observed_generation: u32,
        expected_generation: Option<u32>,
    ) -> KernelTransition {
        self.reject(NavigatorFailure::StaleObservation {
            message: "the browser observation does not match the current document generation"
                .to_string(),
            observed_generation,
            expected_generation,
        })
    }
    pub(in crate::kernel) fn accept(
        &mut self,
        events: Vec<KernelEvent>,
        effects: Vec<KernelEffect>,
    ) -> KernelTransition {
        debug_assert!(self.physical_frame_count() <= 3);
        self.state_revision = self
            .state_revision
            .checked_add(1)
            .expect("dispatch preflighted the state revision");
        KernelTransition {
            accepted: true,
            state_revision: self.state_revision,
            events,
            effects,
            failure: None,
        }
    }
    pub(in crate::kernel) fn reject(&self, failure: NavigatorFailure) -> KernelTransition {
        KernelTransition {
            accepted: false,
            state_revision: self.state_revision,
            events: Vec::new(),
            effects: Vec::new(),
            failure: Some(failure),
        }
    }
    /// Returns the current state revision.
    pub fn state_revision(&self) -> u32 {
        self.state_revision
    }
}
