use super::*;
use epub_stack::annotation::AnnotationTarget;

impl NavigatorKernel {
    /// Projects authored Stack annotation JSON into bounded browser execution work.
    pub fn project_annotation_target_json(&self, target_json: &str) -> Result<String, KernelError> {
        let projected = self.project_annotation_target(target_json)?;
        serde_json::to_string(&projected.plan).map_err(|_| KernelError::InvalidAnnotationTarget)
    }
    pub(in crate::kernel) fn project_annotation_target(
        &self,
        target_json: &str,
    ) -> Result<ProjectedAnnotationTarget, KernelError> {
        if target_json.len() > MAX_ANNOTATION_TARGET_JSON_BYTES {
            return Err(KernelError::InvalidAnnotationTarget);
        }
        let target = AnnotationTarget::parse_json(target_json)
            .map_err(|_| KernelError::InvalidAnnotationTarget)?;
        let document_text_start = annotation_document_text_start(&target);
        let resource = self
            .publication
            .resolve_annotation_source(target.source().unwrap_or_default())?;
        let selectors = if target.selectors().is_empty() {
            vec![AnnotationSelectorNode::Resource {
                path: vec![0],
                values: AnnotationResourceSelectorValues {},
                refinements: Vec::new(),
            }]
        } else {
            project_annotation_selectors(target.selectors(), resource, &mut Vec::new(), &mut 0)?
        };
        let plan = AnnotationTargetResolutionPlan {
            resource: resource.path.clone(),
            selectors,
        };
        plan.validate()?;
        Ok(ProjectedAnnotationTarget {
            plan,
            document_text_start,
        })
    }
    pub(in crate::kernel) fn annotation_target_operation(
        &mut self,
        plan: AnnotationTargetResolutionPlan,
        relocate: bool,
    ) -> KernelTransition {
        let Some(committed) = &self.committed else {
            return self.reject(NavigatorFailure::NoCurrentDocument {
                message: "annotation target resolution requires a committed document".to_string(),
            });
        };
        if plan.validate().is_err() || plan.resource != committed.resource() {
            return self.reject(NavigatorFailure::InvalidCommand {
                message:
                    "the annotation target plan does not identify the committed primary resource"
                        .to_string(),
            });
        }
        let operation_kind = if relocate {
            AgentOperationKind::RelocateAnnotationTarget
        } else {
            AgentOperationKind::ResolveAnnotationTarget
        };
        if !committed.supported_operations.contains(&operation_kind) {
            return self.reject(NavigatorFailure::InvalidCommand {
                message:
                    "the primary content agent does not support the annotation target operation"
                        .to_string(),
            });
        }
        let participant = ActiveDocumentParticipant::Primary {
            document_generation: committed.generation,
        };
        let request = if relocate {
            AgentRequest::RelocateAnnotationTarget { plan }
        } else {
            AgentRequest::ResolveAnnotationTarget { plan }
        };
        self.start_agent_operation(participant, operation_kind, request)
    }
    pub(in crate::kernel) fn generate_annotation_target(
        &mut self,
        participant: ActiveDocumentParticipant,
        location: NavigatorLocation,
        local_content_basis: u32,
        text_fragment_policy: AnnotationTextFragmentPolicy,
    ) -> KernelTransition {
        if self.pending.is_some() {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "annotation target generation is unavailable during document replacement"
                    .to_string(),
            });
        }
        let Some((supported_operations, _, _, occurrence, resource)) =
            self.selection_capture_context(participant)
        else {
            return self.reject(NavigatorFailure::InvalidCommand {
                message:
                    "annotation target generation requires the exact active document participant"
                        .to_string(),
            });
        };
        if !supported_operations.contains(&AgentOperationKind::GenerateAnnotationTarget) {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the active content agent does not support annotation target generation"
                    .to_string(),
            });
        }
        if location.validate().is_err()
            || !matches!(location, NavigatorLocation::Range { .. })
            || location.context() != (occurrence, resource)
            || validate_selection_locator_limits(&location).is_err()
            || self
                .publication
                .annotation_source_for_occurrence(occurrence, resource)
                .is_err()
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "annotation target generation requires a valid captured range for the active occurrence"
                    .to_string(),
            });
        }
        self.start_agent_operation(
            participant,
            AgentOperationKind::GenerateAnnotationTarget,
            AgentRequest::GenerateAnnotationTarget {
                location,
                local_content_basis,
                text_fragment_policy,
            },
        )
    }
    pub(in crate::kernel) fn generate_current_location_annotation_target(
        &mut self,
        participant: ActiveDocumentParticipant,
        location: NavigatorLocation,
        local_content_basis: u32,
    ) -> KernelTransition {
        if self.pending.is_some() {
            return self.reject(NavigatorFailure::InvalidCommand {
                message:
                    "current-location target generation is unavailable during document replacement"
                        .to_string(),
            });
        }
        let Some((supported_operations, _, _, occurrence, resource)) =
            self.selection_capture_context(participant)
        else {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "current-location target generation requires the exact active document participant"
                    .to_string(),
            });
        };
        if !supported_operations
            .contains(&AgentOperationKind::GenerateCurrentLocationAnnotationTarget)
            || location.validate().is_err()
            || !matches!(location, NavigatorLocation::Point { .. })
            || location.context() != (occurrence, resource)
            || self
                .publication
                .annotation_source_for_occurrence(occurrence, resource)
                .is_err()
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "current-location target generation requires a valid point for the active occurrence"
                    .to_string(),
            });
        }
        self.start_agent_operation(
            participant,
            AgentOperationKind::GenerateCurrentLocationAnnotationTarget,
            AgentRequest::GenerateCurrentLocationAnnotationTarget {
                location,
                local_content_basis,
            },
        )
    }
    pub(in crate::kernel) fn cancel_selection_annotation_target_generation(
        &mut self,
    ) -> KernelTransition {
        let mut events = Vec::new();
        let mut index = 0;
        while index < self.pending_operations.len() {
            if self.pending_operations[index].operation_kind()
                != AgentOperationKind::GenerateAnnotationTarget
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
                failure: AgentOperationFailure::OperationCancelled {
                    reason: AgentOperationCancellationReason::SelectionSuperseded,
                },
            });
        }
        self.accept(events, Vec::new())
    }
    pub(in crate::kernel) fn adjust_annotation_range(
        &mut self,
        participant: ActiveDocumentParticipant,
        projection_revision: u32,
        record_id: String,
        edge: AnnotationRangeEdge,
        movement: AnnotationRangeMovement,
    ) -> KernelTransition {
        let Some(committed) = &self.committed else {
            return self.reject(NavigatorFailure::NoCurrentDocument {
                message: "annotation range adjustment requires a committed document".to_string(),
            });
        };
        let expected_participant = ActiveDocumentParticipant::Primary {
            document_generation: committed.generation,
        };
        let rendered = self.decoration_outcomes.iter().any(|entry| {
            entry.participant == participant
                && entry.projection_revision == projection_revision
                && entry.outcomes.iter().any(|result| {
                    result.id == record_id
                        && matches!(result.outcome, DecorationRecordOutcome::Rendered)
                })
        });
        let record =
            self.decoration_projection.records.iter().find(|record| {
                record.id == record_id && record.occurrence == committed.occurrence()
            });
        if participant != expected_participant
            || projection_revision != self.decoration_projection.revision
            || record_id.is_empty()
            || record_id.len() > MAX_DECORATION_ID_BYTES
            || record.is_none()
            || !rendered
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message:
                    "annotation range adjustment requires the exact current rendered decoration"
                        .to_string(),
            });
        }
        if committed.frame.adapter != DocumentAdapter::ReflowableXhtml
            || !committed
                .supported_operations
                .contains(&AgentOperationKind::AdjustAnnotationRange)
        {
            return self.reject(NavigatorFailure::InvalidCommand {
                message: "the active content agent does not support annotation range adjustment"
                    .to_string(),
            });
        }
        self.start_agent_operation(
            participant,
            AgentOperationKind::AdjustAnnotationRange,
            AgentRequest::AdjustAnnotationRange {
                projection_revision,
                record_id,
                edge,
                movement,
            },
        )
    }
    pub(in crate::kernel) fn cancel_annotation_range_adjustments(
        &mut self,
        events: &mut Vec<KernelEvent>,
        reason: AgentOperationCancellationReason,
    ) {
        let mut index = 0;
        while index < self.pending_operations.len() {
            if self.pending_operations[index].operation_kind()
                != AgentOperationKind::AdjustAnnotationRange
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
