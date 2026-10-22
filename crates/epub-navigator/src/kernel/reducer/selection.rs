use super::*;

impl NavigatorKernel {
    pub(in crate::kernel) fn capture_selection(
        &mut self,
        participant: ActiveDocumentParticipant,
    ) -> KernelTransition {
        if self.pending.is_some() {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "selection capture is unavailable during document replacement".to_string(),
            });
        }
        let Some((supported_operations, _, _, _, _)) = self.selection_capture_context(participant)
        else {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "selection capture requires the exact active document participant"
                    .to_string(),
            });
        };
        if !supported_operations.contains(&AgentOperationKind::CaptureSelection) {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the active content agent does not support selection capture".to_string(),
            });
        }
        self.start_agent_operation(
            participant,
            AgentOperationKind::CaptureSelection,
            AgentRequest::CaptureSelection {},
        )
    }
    pub(in crate::kernel) fn selection_capture_context(
        &self,
        participant: ActiveDocumentParticipant,
    ) -> Option<(&[AgentOperationKind], u32, u32, u32, &str)> {
        match participant {
            ActiveDocumentParticipant::Primary {
                document_generation,
            } => self
                .committed
                .as_ref()
                .filter(|document| document.generation == document_generation)
                .map(|document| {
                    (
                        document.supported_operations.as_slice(),
                        document.frame_generation(),
                        document.layout.layout().layout_generation,
                        document.occurrence(),
                        document.resource(),
                    )
                }),
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
                    .map(|companion| {
                        let layout_generation = match &companion.layout {
                            FixedCompanionLayoutState::Settled { layout, .. }
                            | FixedCompanionLayoutState::Dirty { layout, .. }
                            | FixedCompanionLayoutState::Updating { layout, .. } => {
                                layout.layout_generation
                            }
                        };
                        (
                            companion.supported_operations.as_slice(),
                            companion.frame.generation,
                            layout_generation,
                            companion.frame.occurrence,
                            companion.frame.resource.as_str(),
                        )
                    })
            }
        }
    }
}
