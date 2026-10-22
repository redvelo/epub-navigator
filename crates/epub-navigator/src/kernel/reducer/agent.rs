use super::*;

impl NavigatorKernel {
    pub(in crate::kernel) fn advance_presentation(
        &mut self,
        direction: PresentationAdvanceDirection,
        target: PresentationAdvanceTarget,
    ) -> KernelTransition {
        if let Some(pending) = &self.pending {
            return self.reject(NavigatorFailure::DocumentPending {
                message: "presentation advance is unavailable while a replacement is pending"
                    .to_string(),
                generation: pending.generation,
            });
        }
        let Some(committed) = &self.committed else {
            return self.reject(NavigatorFailure::NoCurrentDocument {
                message: "presentation advance requires a committed document".to_string(),
            });
        };
        if !matches!(committed.layout, CommittedLayoutState::Settled { .. }) {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "presentation advance requires a settled committed layout".to_string(),
            });
        }
        let participant = match target {
            PresentationAdvanceTarget::Primary => {
                if !committed
                    .supported_operations
                    .contains(&AgentOperationKind::AdvancePresentation)
                {
                    return self.reject(NavigatorFailure::InvalidCommand {
                        message: "the primary content agent does not support presentation advance"
                            .to_string(),
                    });
                }
                ActiveDocumentParticipant::Primary {
                    document_generation: committed.generation,
                }
            }
            PresentationAdvanceTarget::FixedCompanion => {
                let Some(companion) = &self.fixed_companion else {
                    return self.reject(NavigatorFailure::InvalidCommand {
                        message:
                            "presentation advance targets a fixed companion that is not attached"
                                .to_string(),
                    });
                };
                if companion.frame.adapter != DocumentAdapter::ReflowableXhtml {
                    return self.reject(NavigatorFailure::InvalidCommand {
                        message: "only a reflowable fixed companion turns its own pages"
                            .to_string(),
                    });
                }
                if !matches!(companion.layout, FixedCompanionLayoutState::Settled { .. }) {
                    return self.reject(NavigatorFailure::InvalidCommand {
                        message: "presentation advance requires a settled companion layout"
                            .to_string(),
                    });
                }
                if !companion
                    .supported_operations
                    .contains(&AgentOperationKind::AdvancePresentation)
                {
                    return self.reject(NavigatorFailure::InvalidCommand {
                        message:
                            "the companion content agent does not support presentation advance"
                                .to_string(),
                    });
                }
                ActiveDocumentParticipant::FixedCompanion {
                    owner_document_generation: companion.owner_document_generation,
                    frame_generation: companion.frame.generation,
                }
            }
        };
        self.start_agent_operation(
            participant,
            AgentOperationKind::AdvancePresentation,
            AgentRequest::AdvancePresentation { direction },
        )
    }
    pub(in crate::kernel) fn start_agent_operation(
        &mut self,
        participant: ActiveDocumentParticipant,
        operation_kind: AgentOperationKind,
        request: AgentRequest,
    ) -> KernelTransition {
        match self.enqueue_agent_operation(participant, operation_kind, request) {
            Ok(effect) => self.accept(Vec::new(), vec![effect]),
            Err(failure) => self.reject(failure),
        }
    }
    pub(in crate::kernel) fn enqueue_agent_operation(
        &mut self,
        participant: ActiveDocumentParticipant,
        operation_kind: AgentOperationKind,
        request: AgentRequest,
    ) -> Result<KernelEffect, NavigatorFailure> {
        let Some(operation) = self.agent_operation.checked_add(1) else {
            return Err(NavigatorFailure::AgentOperationExhausted {
                message: "the content-agent operation counter is exhausted".to_string(),
            });
        };
        let metadata = match (&request, operation_kind) {
            (AgentRequest::ResolveLocator { .. }, AgentOperationKind::ResolveLocator) => {
                PendingOperationMetadata::ResolveLocator
            }
            (AgentRequest::Relocate { .. }, AgentOperationKind::Relocate) => {
                PendingOperationMetadata::Relocate
            }
            (
                AgentRequest::ResolveAnnotationTarget { plan },
                AgentOperationKind::ResolveAnnotationTarget,
            ) => PendingOperationMetadata::ResolveAnnotationTarget(plan.clone()),
            (
                AgentRequest::RelocateAnnotationTarget { plan },
                AgentOperationKind::RelocateAnnotationTarget,
            ) => PendingOperationMetadata::RelocateAnnotationTarget(plan.clone()),
            (AgentRequest::CaptureSelection {}, AgentOperationKind::CaptureSelection) => {
                PendingOperationMetadata::CaptureSelection
            }
            (
                AgentRequest::CaptureCurrentLocation {},
                AgentOperationKind::CaptureCurrentLocation,
            ) => PendingOperationMetadata::CaptureCurrentLocation,
            (
                AgentRequest::FindMediaOverlayEntry { fragments },
                AgentOperationKind::FindMediaOverlayEntry,
            ) => PendingOperationMetadata::FindMediaOverlayEntry {
                fragment_count: fragments.len(),
            },
            (
                AgentRequest::GenerateAnnotationTarget {
                    location,
                    local_content_basis,
                    text_fragment_policy,
                },
                AgentOperationKind::GenerateAnnotationTarget,
            ) => {
                let (occurrence, _) = location.context();
                PendingOperationMetadata::GenerateAnnotationTarget(
                    PendingAnnotationTargetGeneration {
                        location: location.clone(),
                        local_content_basis: *local_content_basis,
                        text_fragment_policy: Some(*text_fragment_policy),
                        adapter: self
                            .publication
                            .occurrence(occurrence)
                            .and_then(|occurrence| occurrence.document.loadable())
                            .map(|(_, adapter)| adapter)
                            .expect("validated annotation generation has a loadable occurrence"),
                    },
                )
            }
            (
                AgentRequest::GenerateCurrentLocationAnnotationTarget {
                    location,
                    local_content_basis,
                },
                AgentOperationKind::GenerateCurrentLocationAnnotationTarget,
            ) => {
                let (occurrence, _) = location.context();
                PendingOperationMetadata::GenerateCurrentLocationAnnotationTarget(
                    PendingAnnotationTargetGeneration {
                        location: location.clone(),
                        local_content_basis: *local_content_basis,
                        text_fragment_policy: None,
                        adapter: self
                            .publication
                            .occurrence(occurrence)
                            .and_then(|occurrence| occurrence.document.loadable())
                            .map(|(_, adapter)| adapter)
                            .expect("validated point generation has a loadable occurrence"),
                    },
                )
            }
            (
                AgentRequest::ReconcileDecorations {
                    projection_revision,
                    records,
                },
                AgentOperationKind::ReconcileDecorations,
            ) => PendingOperationMetadata::ReconcileDecorations(PendingDecorationReconciliation {
                projection_revision: *projection_revision,
                ids: records.iter().map(|record| record.id.clone()).collect(),
            }),
            (
                AgentRequest::AdjustAnnotationRange {
                    projection_revision,
                    record_id,
                    edge,
                    movement,
                },
                AgentOperationKind::AdjustAnnotationRange,
            ) => {
                let record = self
                    .decoration_projection
                    .records
                    .iter()
                    .find(|record| record.id == *record_id)
                    .expect("validated adjustment has a controlled decoration");
                let source = self
                    .publication
                    .annotation_source_for_occurrence(
                        record.occurrence,
                        self.projected_decorations
                            .iter()
                            .find(|(_, projected)| projected.id == *record_id)
                            .map(|(_, projected)| projected.plan.resource.as_str())
                            .expect("validated adjustment has a projected target"),
                    )
                    .expect("validated adjustment has an annotation source")
                    .to_string();
                PendingOperationMetadata::AdjustAnnotationRange(PendingAnnotationRangeAdjustment {
                    projection_revision: *projection_revision,
                    record_id: record_id.clone(),
                    edge: *edge,
                    movement: *movement,
                    source,
                })
            }
            (AgentRequest::AdvancePresentation { .. }, AgentOperationKind::AdvancePresentation) => {
                PendingOperationMetadata::AdvancePresentation
            }
            _ => unreachable!("agent operation kind must match its request"),
        };
        self.agent_operation = operation;
        let frame_generation = self
            .participant_frame(participant)
            .expect("agent operation belongs to an active participant");
        self.pending_operations.push(PendingOperation {
            operation,
            participant,
            frame_generation,
            metadata,
        });
        Ok(KernelEffect::AgentRequest {
            participant,
            operation,
            generation: frame_generation,
            request,
        })
    }
    pub(in crate::kernel) fn agent_result(
        &mut self,
        participant: ActiveDocumentParticipant,
        operation: u32,
        generation: u32,
        result: AgentResult,
    ) -> KernelTransition {
        let operation_kind = result.operation_kind();
        let Some(index) = self.pending_operations.iter().position(|pending| {
            pending.operation == operation
                && pending.frame_generation == generation
                && pending.participant == participant
                && pending.operation_kind() == operation_kind
                && self.participant_frame(participant) == Some(generation)
        }) else {
            let expected = self
                .pending_operations
                .iter()
                .find(|pending| pending.operation == operation)
                .map(PendingOperation::snapshot);
            return self.reject(NavigatorFailure::StaleAgentOperationObservation {
                message: "the agent result does not match a pending operation".to_string(),
                observed_operation: operation,
                observed_generation: generation,
                expected_operation: expected.map(|pending| pending.operation),
                expected_generation: expected.map(|pending| pending.frame_generation),
            });
        };
        let pending = self.pending_operations.remove(index);
        if let AgentResult::ReconcileDecorations {
            projection_revision,
            outcomes,
        } = &result
        {
            let request = match &pending.metadata {
                PendingOperationMetadata::ReconcileDecorations(request) => Some(request),
                _ => None,
            };
            let valid = request.is_some_and(|request| {
                *projection_revision == request.projection_revision
                    && outcomes.len() == request.ids.len()
                    && outcomes.iter().enumerate().all(|(index, outcome)| {
                        !outcome.id.is_empty()
                            && outcome.id.len() <= MAX_DECORATION_ID_BYTES
                            && request.ids.contains(&outcome.id)
                            && !outcomes[..index]
                                .iter()
                                .any(|previous| previous.id == outcome.id)
                            && decoration_outcome_valid(&outcome.outcome)
                    })
            });
            if !valid {
                return self.accept(
                    vec![KernelEvent::AgentOperationFailed {
                        participant: pending.participant,
                        operation,
                        generation: pending.participant.owner_document_generation(),
                        operation_kind: pending.operation_kind(),
                        failure: AgentOperationFailure::OperationDeliveryFailed {
                            message: "the decoration result does not match its projection request"
                                .to_string(),
                        },
                    }],
                    Vec::new(),
                );
            }
            self.decoration_outcomes
                .retain(|entry| entry.participant != pending.participant);
            self.decoration_outcomes
                .push(ParticipantDecorationOutcomes {
                    participant: pending.participant,
                    projection_revision: *projection_revision,
                    outcomes: outcomes.clone(),
                });
            return self.accept(
                vec![KernelEvent::AgentOperationReported {
                    participant: pending.participant,
                    operation,
                    generation: pending.participant.owner_document_generation(),
                    result,
                }],
                Vec::new(),
            );
        }
        if let AgentResult::GenerateAnnotationTarget { candidate } = &result {
            let finalized = match &pending.metadata {
                PendingOperationMetadata::GenerateAnnotationTarget(request) => Some(request),
                _ => None,
            }
            .and_then(|request| {
                if candidate.local_content_basis != request.local_content_basis
                    || Some(candidate.text_fragment_policy) != request.text_fragment_policy
                    || (request.adapter != DocumentAdapter::ReflowableXhtml
                        && !matches!(
                            &candidate.status,
                            AnnotationTargetGenerationCandidateStatus::Unsupported
                        ))
                {
                    return None;
                }
                let (occurrence, resource) = request.location.context();
                let source = self
                    .publication
                    .annotation_source_for_occurrence(occurrence, resource)
                    .ok()?;
                finalize_annotation_target_candidate(
                    source,
                    request.text_fragment_policy?,
                    &candidate.status,
                )
                .ok()
            });
            let Some(outcome) = finalized else {
                return self.accept(
                    vec![KernelEvent::AgentOperationFailed {
                        participant: pending.participant,
                        operation,
                        generation: pending.participant.owner_document_generation(),
                        operation_kind: pending.operation_kind(),
                        failure: AgentOperationFailure::OperationDeliveryFailed {
                            message: "the annotation target candidate is invalid for its generation request"
                                .to_string(),
                        },
                    }],
                    Vec::new(),
                );
            };
            return self.accept(
                vec![KernelEvent::AnnotationTargetGenerationReported {
                    participant: pending.participant,
                    operation,
                    generation: pending.participant.owner_document_generation(),
                    outcome,
                }],
                Vec::new(),
            );
        }
        if let AgentResult::GenerateCurrentLocationAnnotationTarget { candidate } = &result {
            let finalized = match &pending.metadata {
                PendingOperationMetadata::GenerateCurrentLocationAnnotationTarget(request) => {
                    Some(request)
                }
                _ => None,
            }
            .and_then(|request| {
                if candidate.local_content_basis != request.local_content_basis
                    || request.text_fragment_policy.is_some()
                {
                    return None;
                }
                let (occurrence, resource) = request.location.context();
                let source = self
                    .publication
                    .annotation_source_for_occurrence(occurrence, resource)
                    .ok()?;
                finalize_annotation_point_target_candidate(
                    source,
                    request.adapter,
                    &candidate.status,
                )
                .ok()
            });
            let Some(outcome) = finalized else {
                return self.accept(
                    vec![KernelEvent::AgentOperationFailed {
                        participant: pending.participant,
                        operation,
                        generation: pending.participant.owner_document_generation(),
                        operation_kind: pending.operation_kind(),
                        failure: AgentOperationFailure::OperationDeliveryFailed {
                            message:
                                "the current-location target candidate is invalid for its request"
                                    .to_string(),
                        },
                    }],
                    Vec::new(),
                );
            };
            return self.accept(
                vec![KernelEvent::AnnotationTargetGenerationReported {
                    participant: pending.participant,
                    operation,
                    generation: pending.participant.owner_document_generation(),
                    outcome,
                }],
                Vec::new(),
            );
        }
        if let AgentResult::AdjustAnnotationRange { candidate } = &result {
            let finalized = match &pending.metadata {
                PendingOperationMetadata::AdjustAnnotationRange(request) => Some(request),
                _ => None,
            }
            .and_then(|request| {
                if candidate.projection_revision != request.projection_revision
                    || candidate.record_id != request.record_id
                    || candidate.edge != request.edge
                    || candidate.movement != request.movement
                    || candidate.excerpt.is_some()
                        != matches!(
                            candidate.status,
                            AnnotationTargetGenerationCandidateStatus::Generated { .. }
                        )
                    || candidate.excerpt.as_ref().is_some_and(|excerpt| {
                        excerpt.chars().count() > MAX_ANNOTATION_EXCERPT_CODE_POINTS
                            || excerpt.len() > MAX_ANNOTATION_EXCERPT_BYTES
                    })
                {
                    return None;
                }
                let generated = finalize_annotation_target_candidate(
                    &request.source,
                    AnnotationTextFragmentPolicy::Exclude,
                    &candidate.status,
                )
                .ok()?;
                Some(match generated {
                    AnnotationTargetGenerationOutcome::Generated { target_json } => {
                        AnnotationRangeAdjustmentOutcome::Adjusted {
                            target_json,
                            excerpt: candidate.excerpt.clone()?,
                        }
                    }
                    AnnotationTargetGenerationOutcome::Unavailable { reason } => {
                        AnnotationRangeAdjustmentOutcome::Unavailable { reason }
                    }
                    AnnotationTargetGenerationOutcome::Unsupported => {
                        AnnotationRangeAdjustmentOutcome::Unsupported
                    }
                    AnnotationTargetGenerationOutcome::Ambiguous => {
                        AnnotationRangeAdjustmentOutcome::Ambiguous
                    }
                    AnnotationTargetGenerationOutcome::Conflict => {
                        AnnotationRangeAdjustmentOutcome::Conflict
                    }
                    AnnotationTargetGenerationOutcome::Stale => {
                        AnnotationRangeAdjustmentOutcome::Stale
                    }
                    AnnotationTargetGenerationOutcome::Failed { message } => {
                        AnnotationRangeAdjustmentOutcome::Failed { message }
                    }
                })
            });
            let Some(outcome) = finalized else {
                return self.accept(
                    vec![KernelEvent::AgentOperationFailed {
                        participant: pending.participant,
                        operation,
                        generation: pending.participant.owner_document_generation(),
                        operation_kind: pending.operation_kind(),
                        failure: AgentOperationFailure::OperationDeliveryFailed {
                            message: "the annotation range adjustment candidate is invalid for its request"
                                .to_string(),
                        },
                    }],
                    Vec::new(),
                );
            };
            return self.accept(
                vec![KernelEvent::AnnotationRangeAdjustmentReported {
                    participant: pending.participant,
                    operation,
                    generation: pending.participant.owner_document_generation(),
                    outcome,
                }],
                Vec::new(),
            );
        }
        if let AgentResult::ResolveAnnotationTarget { result }
        | AgentResult::RelocateAnnotationTarget { result } = &result
            && self.committed.as_ref().is_none_or(|committed| {
                let plan = match &pending.metadata {
                    PendingOperationMetadata::ResolveAnnotationTarget(plan)
                    | PendingOperationMetadata::RelocateAnnotationTarget(plan) => Some(plan),
                    _ => None,
                };
                plan.is_none_or(|plan| result.validate(committed.resource(), plan).is_err())
            })
        {
            return self.accept(
                vec![KernelEvent::AgentOperationFailed {
                    participant: pending.participant,
                    operation,
                    generation: pending.participant.owner_document_generation(),
                    operation_kind: pending.operation_kind(),
                    failure: AgentOperationFailure::OperationDeliveryFailed {
                        message: "the annotation target result is invalid for its execution plan"
                            .to_string(),
                    },
                }],
                Vec::new(),
            );
        }
        if let AgentResult::CaptureSelection { outcome } = &result {
            let invalid = self.selection_capture_context(participant).is_none_or(
                |(_, frame_generation, layout_generation, occurrence, resource)| {
                    outcome
                        .validate(
                            participant,
                            frame_generation,
                            layout_generation,
                            occurrence,
                            resource,
                        )
                        .is_err()
                },
            );
            if invalid {
                return self.accept(
                    vec![KernelEvent::AgentOperationFailed {
                        participant: pending.participant,
                        operation,
                        generation: pending.participant.owner_document_generation(),
                        operation_kind: pending.operation_kind(),
                        failure: AgentOperationFailure::OperationDeliveryFailed {
                            message: "the native selection capture result is invalid for the active participant"
                                .to_string(),
                        },
                    }],
                    Vec::new(),
                );
            }
        }
        if let AgentResult::CaptureCurrentLocation { outcome } = &result {
            let invalid = self.committed.as_ref().is_none_or(|committed| {
                participant
                    != (ActiveDocumentParticipant::Primary {
                        document_generation: committed.generation,
                    })
                    || !matches!(committed.layout, CommittedLayoutState::Settled { .. })
                    || match outcome {
                        CurrentLocationCaptureOutcome::Captured { location, basis } => {
                            location.validate().is_err()
                                || !matches!(location, NavigatorLocation::Point { .. })
                                || location.context()
                                    != (committed.occurrence(), committed.resource())
                                || !current_location_basis_matches(committed, basis)
                        }
                        CurrentLocationCaptureOutcome::Unavailable { basis }
                        | CurrentLocationCaptureOutcome::Stale { basis }
                        | CurrentLocationCaptureOutcome::Failed { basis, .. } => {
                            !current_location_basis_matches(committed, basis)
                        }
                    }
            });
            if invalid {
                return self.accept(
                    vec![KernelEvent::AgentOperationFailed {
                        participant: pending.participant,
                        operation,
                        generation: pending.participant.owner_document_generation(),
                        operation_kind: pending.operation_kind(),
                        failure: AgentOperationFailure::OperationDeliveryFailed {
                            message: "the current location capture result is invalid for the settled primary layout".to_string(),
                        },
                    }],
                    Vec::new(),
                );
            }
        }
        if let AgentResult::FindMediaOverlayEntry { outcome } = &result {
            let fragment_count = match pending.metadata {
                PendingOperationMetadata::FindMediaOverlayEntry { fragment_count } => {
                    Some(fragment_count)
                }
                _ => None,
            };
            let invalid = self.committed.as_ref().is_none_or(|committed| {
                participant
                    != (ActiveDocumentParticipant::Primary {
                        document_generation: committed.generation,
                    })
                    || fragment_count.is_none_or(|count| {
                        matches!(outcome, MediaOverlayEntryOutcome::Found { index } if *index as usize >= count)
                    })
            });
            if invalid {
                return self.accept(
                    vec![KernelEvent::AgentOperationFailed {
                        participant: pending.participant,
                        operation,
                        generation: pending.participant.owner_document_generation(),
                        operation_kind: pending.operation_kind(),
                        failure: AgentOperationFailure::OperationDeliveryFailed {
                            message: "the media overlay entry result does not match its request"
                                .to_string(),
                        },
                    }],
                    Vec::new(),
                );
            }
        }
        self.accept(
            vec![KernelEvent::AgentOperationReported {
                participant: pending.participant,
                operation,
                generation: pending.participant.owner_document_generation(),
                result,
            }],
            Vec::new(),
        )
    }
    pub(in crate::kernel) fn operation_timeout(
        &mut self,
        participant: ActiveDocumentParticipant,
        operation: u32,
        generation: u32,
    ) -> KernelTransition {
        let Some(index) = self.pending_operations.iter().position(|pending| {
            pending.operation == operation
                && pending.frame_generation == generation
                && pending.participant == participant
                && self.participant_frame(participant) == Some(generation)
        }) else {
            let expected = self
                .pending_operations
                .iter()
                .find(|pending| pending.operation == operation)
                .map(PendingOperation::snapshot);
            return self.reject(NavigatorFailure::StaleAgentOperationObservation {
                message: "the timeout does not match a pending agent operation".to_string(),
                observed_operation: operation,
                observed_generation: generation,
                expected_operation: expected.map(|pending| pending.operation),
                expected_generation: expected.map(|pending| pending.frame_generation),
            });
        };
        let pending = self.pending_operations.remove(index);
        self.accept(
            vec![KernelEvent::AgentOperationFailed {
                participant: pending.participant,
                operation,
                generation: pending.participant.owner_document_generation(),
                operation_kind: pending.operation_kind(),
                failure: AgentOperationFailure::OperationTimeout {
                    message: "the content-agent operation timed out".to_string(),
                },
            }],
            Vec::new(),
        )
    }
    pub(in crate::kernel) fn operation_delivery_failed(
        &mut self,
        participant: ActiveDocumentParticipant,
        operation: u32,
        generation: u32,
        message: String,
    ) -> KernelTransition {
        let Some(index) = self.pending_operations.iter().position(|pending| {
            pending.operation == operation
                && pending.frame_generation == generation
                && pending.participant == participant
                && self.participant_frame(participant) == Some(generation)
        }) else {
            let expected = self
                .pending_operations
                .iter()
                .find(|pending| pending.operation == operation)
                .map(PendingOperation::snapshot);
            return self.reject(NavigatorFailure::StaleAgentOperationObservation {
                message: "the delivery failure does not match a pending agent operation"
                    .to_string(),
                observed_operation: operation,
                observed_generation: generation,
                expected_operation: expected.map(|pending| pending.operation),
                expected_generation: expected.map(|pending| pending.frame_generation),
            });
        };
        let pending = self.pending_operations.remove(index);
        self.accept(
            vec![KernelEvent::AgentOperationFailed {
                participant: pending.participant,
                operation,
                generation: pending.participant.owner_document_generation(),
                operation_kind: pending.operation_kind(),
                failure: AgentOperationFailure::OperationDeliveryFailed { message },
            }],
            Vec::new(),
        )
    }
    pub(in crate::kernel) fn cancel_agent_operations(
        &mut self,
        events: &mut Vec<KernelEvent>,
        reason: AgentOperationCancellationReason,
    ) {
        for pending in self.pending_operations.drain(..) {
            events.push(KernelEvent::AgentOperationFailed {
                participant: pending.participant,
                operation: pending.operation,
                generation: pending.participant.owner_document_generation(),
                operation_kind: pending.operation_kind(),
                failure: AgentOperationFailure::OperationCancelled { reason },
            });
        }
    }
    pub(in crate::kernel) fn cancel_agent_operations_for_generation(
        &mut self,
        events: &mut Vec<KernelEvent>,
        generation: u32,
        reason: AgentOperationCancellationReason,
    ) {
        let mut index = 0;
        while index < self.pending_operations.len() {
            if self.pending_operations[index]
                .participant
                .owner_document_generation()
                != generation
            {
                index += 1;
                continue;
            }
            let pending = self.pending_operations.remove(index);
            events.push(KernelEvent::AgentOperationFailed {
                participant: pending.participant,
                operation: pending.operation,
                generation: pending.participant.owner_document_generation(),
                operation_kind: pending.operation_kind(),
                failure: AgentOperationFailure::OperationCancelled { reason },
            });
        }
    }
}
