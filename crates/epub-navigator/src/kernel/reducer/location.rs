use super::*;

const MAX_MEDIA_OVERLAY_ENTRY_FRAGMENTS: usize = 4_096;
const MAX_MEDIA_OVERLAY_FRAGMENT_BYTES: usize = 16_384;

impl NavigatorKernel {
    pub(in crate::kernel) fn resolve_locator(
        &mut self,
        locator: NavigatorLocation,
    ) -> KernelTransition {
        if locator
            .validate()
            .and_then(|()| self.publication.validate_locator_context(&locator))
            .is_err()
        {
            return self.reject(NavigatorFailure::InvalidLocator {
                message: "the publication locator is invalid".to_string(),
            });
        }
        if self.committed.is_none() {
            return self.reject(NavigatorFailure::NoCurrentDocument {
                message: "locator resolution requires a committed document".to_string(),
            });
        }
        let Some((participant, supported_operations)) = self.locator_participant(&locator) else {
            return self.reject(NavigatorFailure::InvalidLocator {
                message: "the locator does not identify an active document participant".to_string(),
            });
        };
        if !supported_operations.contains(&AgentOperationKind::ResolveLocator) {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the active content agent does not support locator resolution".to_string(),
            });
        }
        self.start_agent_operation(
            participant,
            AgentOperationKind::ResolveLocator,
            AgentRequest::ResolveLocator { locator },
        )
    }
    pub(in crate::kernel) fn relocate(&mut self, locator: NavigatorLocation) -> KernelTransition {
        if locator
            .validate()
            .and_then(|()| self.publication.validate_locator_context(&locator))
            .is_err()
        {
            return self.reject(NavigatorFailure::InvalidLocator {
                message: "the publication locator is invalid".to_string(),
            });
        }
        if self.committed.is_none() {
            return self.reject(NavigatorFailure::NoCurrentDocument {
                message: "relocation requires a committed document".to_string(),
            });
        }
        let Some((participant, supported_operations)) = self.locator_participant(&locator) else {
            return self.reject(NavigatorFailure::InvalidLocator {
                message: "the relocation locator does not identify an active document participant"
                    .to_string(),
            });
        };
        if !supported_operations.contains(&AgentOperationKind::Relocate) {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the active content agent does not support relocation".to_string(),
            });
        }
        self.start_agent_operation(
            participant,
            AgentOperationKind::Relocate,
            AgentRequest::Relocate { locator },
        )
    }
    pub(in crate::kernel) fn capture_current_location(&mut self) -> KernelTransition {
        if self.pending.is_some() {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "current location capture is unavailable during document replacement"
                    .to_string(),
            });
        }
        let Some(committed) = self.committed.as_ref() else {
            return self.reject(NavigatorFailure::NoCurrentDocument {
                message: "current location capture requires a committed document".to_string(),
            });
        };
        if !matches!(committed.layout, CommittedLayoutState::Settled { .. }) {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "current location capture requires a settled committed layout".to_string(),
            });
        }
        if !committed
            .supported_operations
            .contains(&AgentOperationKind::CaptureCurrentLocation)
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the primary content agent does not support current location capture"
                    .to_string(),
            });
        }
        self.start_agent_operation(
            ActiveDocumentParticipant::Primary {
                document_generation: committed.generation,
            },
            AgentOperationKind::CaptureCurrentLocation,
            AgentRequest::CaptureCurrentLocation {},
        )
    }

    pub(in crate::kernel) fn find_media_overlay_entry(
        &mut self,
        occurrence: u32,
        fragments: Vec<String>,
    ) -> KernelTransition {
        if self.pending.is_some() {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "media overlay entry lookup is unavailable during document replacement"
                    .to_string(),
            });
        }
        let Some(committed) = self.committed.as_ref() else {
            return self.reject(NavigatorFailure::NoCurrentDocument {
                message: "media overlay entry lookup requires a committed document".to_string(),
            });
        };
        if committed.occurrence() != occurrence
            || !matches!(committed.layout, CommittedLayoutState::Settled { .. })
            || !committed
                .supported_operations
                .contains(&AgentOperationKind::FindMediaOverlayEntry)
            || fragments.is_empty()
            || fragments.len() > MAX_MEDIA_OVERLAY_ENTRY_FRAGMENTS
            || fragments.iter().any(|fragment| {
                fragment.is_empty() || fragment.len() > MAX_MEDIA_OVERLAY_FRAGMENT_BYTES
            })
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "media overlay entry lookup requires the settled committed occurrence and bounded fragments"
                    .to_string(),
            });
        }
        self.start_agent_operation(
            ActiveDocumentParticipant::Primary {
                document_generation: committed.generation,
            },
            AgentOperationKind::FindMediaOverlayEntry,
            AgentRequest::FindMediaOverlayEntry { fragments },
        )
    }
    pub(in crate::kernel) fn document_observed(
        &mut self,
        participant: ActiveDocumentParticipant,
        generation: u32,
        observation: DocumentObservation,
    ) -> KernelTransition {
        let expected = self.participant_frame(participant);
        if expected != Some(generation) {
            return self.stale(generation, expected);
        }
        if observation.validate().is_err() {
            return self.reject(NavigatorFailure::InvalidDocumentObservation {
                message: "the content-document observation is invalid".to_string(),
            });
        }
        if self
            .pending_layout
            .as_ref()
            .is_some_and(|pending| pending.participant() == Some(participant))
        {
            return self.accept(Vec::new(), Vec::new());
        }
        if matches!(
            participant,
            ActiveDocumentParticipant::FixedCompanion { .. }
        ) {
            // A fixed companion has no pages to observe; a reflowable one reports the page it
            // has turned to within its own paginated layout.
            let companion_layout = match &self.fixed_companion.as_ref().unwrap().layout {
                FixedCompanionLayoutState::Settled { layout, .. }
                | FixedCompanionLayoutState::Dirty { layout, .. }
                | FixedCompanionLayoutState::Updating { layout, .. } => layout,
            };
            let companion_pages = match &companion_layout.settlement {
                AdapterLayoutSettlement::ReflowableXhtml {
                    settlement: ReflowableSettlement::Paginated { pages, .. },
                    ..
                } => Some(pages.clone()),
                _ => None,
            };
            if observation
                .validate_pagination_against(companion_pages.as_ref())
                .is_err()
            {
                return self.reject(NavigatorFailure::InvalidDocumentObservation {
                    message: "the companion observation does not match its layout".to_string(),
                });
            }
            let companion = self.fixed_companion.as_mut().unwrap();
            let update = FixedCompanionLayoutObservation {
                document: observation.clone(),
            };
            companion.layout = match companion.layout.clone() {
                FixedCompanionLayoutState::Settled { layout, .. } => {
                    FixedCompanionLayoutState::Settled {
                        layout,
                        observation: update,
                    }
                }
                FixedCompanionLayoutState::Dirty { layout, cause, .. } => {
                    FixedCompanionLayoutState::Dirty {
                        layout,
                        observation: update,
                        cause,
                    }
                }
                FixedCompanionLayoutState::Updating { layout, .. } => {
                    FixedCompanionLayoutState::Updating {
                        layout,
                        observation: update,
                    }
                }
            };
            return self.accept(
                vec![KernelEvent::DocumentObserved {
                    participant,
                    generation: participant.owner_document_generation(),
                    observation,
                }],
                Vec::new(),
            );
        }
        let pages = match &self.committed.as_ref().unwrap().layout.layout().settlement {
            AdapterLayoutSettlement::ReflowableXhtml {
                settlement: ReflowableSettlement::Paginated { pages, .. },
                ..
            } => Some(pages),
            _ => None,
        };
        if observation.validate_pagination_against(pages).is_err() {
            return self.reject(NavigatorFailure::InvalidDocumentObservation {
                message: "the pagination observation does not match the committed layout"
                    .to_string(),
            });
        }
        let document_generation = self.committed.as_ref().unwrap().generation;
        let committed = self.committed.as_mut().unwrap();
        committed.layout = match committed.layout.clone() {
            CommittedLayoutState::Settled { layout, .. } => CommittedLayoutState::Settled {
                layout,
                observation: observation.clone(),
            },
            CommittedLayoutState::Dirty { layout, cause, .. } => CommittedLayoutState::Dirty {
                layout,
                observation: observation.clone(),
                cause,
            },
            CommittedLayoutState::Updating { layout, .. } => CommittedLayoutState::Updating {
                layout,
                observation: observation.clone(),
            },
        };
        self.accept(
            vec![KernelEvent::DocumentObserved {
                participant,
                generation: document_generation,
                observation,
            }],
            Vec::new(),
        )
    }
    pub(in crate::kernel) fn link_activated(
        &mut self,
        participant: ActiveDocumentParticipant,
        generation: u32,
        activation: LinkActivation,
    ) -> KernelTransition {
        let expected = self.participant_frame(participant);
        if expected != Some(generation) {
            return self.stale(generation, expected);
        }
        self.accept(
            vec![KernelEvent::LinkActivated {
                participant,
                activation,
            }],
            Vec::new(),
        )
    }
    pub(in crate::kernel) fn locator_participant(
        &self,
        locator: &NavigatorLocation,
    ) -> Option<(ActiveDocumentParticipant, &[AgentOperationKind])> {
        let (occurrence, resource) = locator.context();
        if let Some(primary) = self
            .committed
            .as_ref()
            .filter(|primary| primary.occurrence() == occurrence && primary.resource() == resource)
        {
            return Some((
                ActiveDocumentParticipant::Primary {
                    document_generation: primary.generation,
                },
                &primary.supported_operations,
            ));
        }
        self.fixed_companion
            .as_ref()
            .filter(|companion| {
                companion.frame.occurrence == occurrence && companion.frame.resource == resource
            })
            .map(|companion| {
                (
                    ActiveDocumentParticipant::FixedCompanion {
                        owner_document_generation: companion.owner_document_generation,
                        frame_generation: companion.frame.generation,
                    },
                    companion.supported_operations.as_slice(),
                )
            })
    }
}
