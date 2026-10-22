use super::*;

struct ValidatedDecorationProjection {
    projected_records: Vec<(u32, ProjectedDecorationRecord)>,
    record_positions: Vec<DecorationRecordPosition>,
}

impl NavigatorKernel {
    pub(in crate::kernel) fn set_decoration_projection(
        &mut self,
        projection: DecorationProjection,
    ) -> KernelTransition {
        let validated = match self.validate_decoration_projection(&projection) {
            Ok(validated) => validated,
            Err(message) => return self.reject(NavigatorFailure::InvalidCommand { message }),
        };
        let will_reconcile = self
            .decoration_reconciliation_context(&validated.projected_records)
            .is_some();
        if will_reconcile && self.agent_operation == u32::MAX {
            return self.reject(NavigatorFailure::AgentOperationExhausted {
                message: "the content-agent operation counter is exhausted".to_string(),
            });
        }

        let mut events = Vec::new();
        self.cancel_decoration_reconciliations(
            &mut events,
            AgentOperationCancellationReason::ProjectionSuperseded,
        );
        self.cancel_annotation_range_adjustments(
            &mut events,
            AgentOperationCancellationReason::ProjectionSuperseded,
        );
        self.decoration_projection = projection;
        self.decoration_record_positions = validated.record_positions;
        self.projected_decorations = validated.projected_records;
        self.decoration_outcomes.clear();
        let mut effects = Vec::new();
        self.enqueue_decoration_reconciliation(&mut effects);
        self.accept(events, effects)
    }
    pub(in crate::kernel) fn reconcile_decorations(&mut self) -> KernelTransition {
        if self
            .decoration_reconciliation_context(&self.projected_decorations)
            .is_some()
            && self.agent_operation == u32::MAX
        {
            return self.reject(NavigatorFailure::AgentOperationExhausted {
                message: "the content-agent operation counter is exhausted".to_string(),
            });
        }
        let mut events = Vec::new();
        self.cancel_decoration_reconciliations(
            &mut events,
            AgentOperationCancellationReason::ProjectionSuperseded,
        );
        let mut effects = Vec::new();
        self.enqueue_decoration_reconciliation(&mut effects);
        self.accept(events, effects)
    }
    fn validate_decoration_projection(
        &self,
        projection: &DecorationProjection,
    ) -> Result<ValidatedDecorationProjection, String> {
        if projection.revision <= self.decoration_projection.revision {
            return Err("the decoration projection revision is invalid".to_string());
        }
        let mut ids = std::collections::HashSet::<&str>::new();
        let mut projected = Vec::with_capacity(projection.records.len());
        let mut positions = Vec::with_capacity(projection.records.len());
        for record in &projection.records {
            if record.id.is_empty()
                || record.id.len() > MAX_DECORATION_ID_BYTES
                || !ids.insert(record.id.as_str())
            {
                return Err("the decoration projection contains invalid records".to_string());
            }
            let occurrence = self
                .publication
                .occurrence(record.occurrence)
                .ok_or_else(|| "a decoration projection occurrence is out of bounds".to_string())?;
            let target = self
                .project_annotation_target(&record.target_json)
                .map_err(|_| "a decoration projection target is invalid".to_string())?;
            if occurrence.document.loadable().map(|target| target.0)
                != Some(target.plan.resource.as_str())
            {
                return Err(
                    "a decoration target does not identify its occurrence resource".to_string(),
                );
            }
            projected.push((
                record.occurrence,
                ProjectedDecorationRecord {
                    id: record.id.clone(),
                    plan: target.plan,
                    appearance: record.appearance,
                },
            ));
            positions.push(DecorationRecordPosition {
                id: record.id.clone(),
                occurrence: record.occurrence,
                document_text_start: target.document_text_start.map(|start| start.to_string()),
            });
        }
        Ok(ValidatedDecorationProjection {
            projected_records: projected,
            record_positions: positions,
        })
    }
    pub(in crate::kernel) fn decoration_reconciliation_context(
        &self,
        projected: &[(u32, ProjectedDecorationRecord)],
    ) -> Option<(ActiveDocumentParticipant, Vec<ProjectedDecorationRecord>)> {
        if self.decoration_projection.revision == 0 {
            return None;
        }
        let committed = self.committed.as_ref()?;
        if committed.frame.adapter != DocumentAdapter::ReflowableXhtml
            || !committed
                .supported_operations
                .contains(&AgentOperationKind::ReconcileDecorations)
        {
            return None;
        }
        Some((
            ActiveDocumentParticipant::Primary {
                document_generation: committed.generation,
            },
            projected
                .iter()
                .filter(|(occurrence, _)| *occurrence == committed.occurrence())
                .map(|(_, record)| record.clone())
                .collect(),
        ))
    }
    pub(in crate::kernel) fn enqueue_decoration_reconciliation(
        &mut self,
        effects: &mut Vec<KernelEffect>,
    ) {
        let Some((participant, records)) =
            self.decoration_reconciliation_context(&self.projected_decorations)
        else {
            return;
        };
        let request = AgentRequest::ReconcileDecorations {
            projection_revision: self.decoration_projection.revision,
            records,
        };
        effects.push(
            self.enqueue_agent_operation(
                participant,
                AgentOperationKind::ReconcileDecorations,
                request,
            )
            .expect("decoration reconciliation capacity was preflighted"),
        );
    }
    pub(in crate::kernel) fn cancel_decoration_reconciliations(
        &mut self,
        events: &mut Vec<KernelEvent>,
        reason: AgentOperationCancellationReason,
    ) {
        let mut index = 0;
        while index < self.pending_operations.len() {
            if self.pending_operations[index].operation_kind()
                != AgentOperationKind::ReconcileDecorations
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
