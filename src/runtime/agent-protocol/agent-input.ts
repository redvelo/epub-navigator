import { normalizeDocumentObservationRequest } from "./codecs/document-observation.js";
import type {
  AgentInitializeMessage,
  AgentSetRoleMessage,
  AgentConfigureMessage,
  AgentClearSelectionMessage,
  AgentReleaseMessage,
  AgentReturnFromFootnoteMessage,
  AgentSetActiveDecorationMessage,
  AgentSetMediaOverlayActiveMessage,
  AgentCancelOperationMessage,
  AgentFixedViewportAppliedMessage,
  AgentRequestMessage,
} from "./types.js";
import {
  isMediaOverlayClassTokens,
  isMediaOverlayFragment,
  isMediaOverlayFragmentList,
} from "./codecs/media-overlays.js";
import { CONTENT_AGENT_PROTOCOL_VERSION } from "./types.js";
import { normalizeTocTargetRequests } from "./codecs/toc.js";
import { normalizeFixedPageGeometry, normalizeLayoutRequest } from "./codecs/layout.js";
import { normalizeCaptureRangeEvidence } from "./codecs/selection.js";
import {
  normalizeAnnotationTargetPlan,
  isAnnotationRangeEdge,
  isAnnotationRangeMovement,
  isAnnotationTextFragmentPolicy,
} from "./codecs/annotation.js";
import { normalizeProjectedDecorationRecords } from "./codecs/decorations.js";
import { normalizeConfiguration, isDocumentAdapter } from "./codecs/configuration.js";
import { normalizePointEvidenceList, normalizeDocumentLocatorTarget } from "./codecs/evidence.js";
import { hasEnvelope, envelope } from "./codecs/envelope.js";
import {
  isRecord,
  hasExactKeys,
  isBoundedString,
  isOperation,
  isOperationId,
  safely,
} from "./codecs/primitives.js";

export function normalizeAgentInitialize(value: unknown): AgentInitializeMessage | null {
  return safely(() => {
    if (!hasEnvelope(value, "initialize")) return null;
    const initializeKeys = [
      "namespace",
      "session",
      "type",
      "protocolVersion",
      "adapter",
      "role",
      "configuration",
    ];
    if (
      !hasExactKeys(value, initializeKeys) &&
      !hasExactKeys(value, [...initializeKeys, "diagnostics"]) &&
      !hasExactKeys(value, [...initializeKeys, "diagnostics", "observation"])
    )
      return null;
    if (
      value.protocolVersion !== CONTENT_AGENT_PROTOCOL_VERSION ||
      !isDocumentAdapter(value.adapter)
    )
      return null;
    if (value.role !== "foreground" && value.role !== "auxiliary" && value.role !== "prepared")
      return null;
    const configuration = normalizeConfiguration(value.configuration);
    if (value.diagnostics !== undefined && typeof value.diagnostics !== "boolean") return null;
    if (value.observation !== undefined && typeof value.observation !== "boolean") return null;
    return configuration === null
      ? null
      : envelope(value.session, {
          type: "initialize",
          protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION,
          adapter: value.adapter,
          role: value.role,
          configuration,
          diagnostics: value.diagnostics === true,
          observation: value.observation === true,
        });
  });
}

export function normalizeAgentSetRole(value: unknown): AgentSetRoleMessage | null {
  return safely(() => {
    if (
      !hasEnvelope(value, "set-role") ||
      (value.role !== "foreground" && value.role !== "auxiliary" && value.role !== "prepared")
    ) {
      return null;
    }
    if (!isOperationId(value.roleChange)) return null;
    const configuration = normalizeConfiguration(value.configuration);
    return configuration === null
      ? null
      : envelope(value.session, {
          type: "set-role",
          role: value.role,
          roleChange: value.roleChange,
          configuration,
        });
  });
}

export function normalizeAgentConfigure(value: unknown): AgentConfigureMessage | null {
  return safely(() => {
    if (!hasEnvelope(value, "configure")) return null;
    const configuration = normalizeConfiguration(value.configuration);
    return configuration === null
      ? null
      : envelope(value.session, { type: "configure", configuration });
  });
}

export function normalizeAgentClearSelection(value: unknown): AgentClearSelectionMessage | null {
  return safely(() =>
    hasEnvelope(value, "clear-selection")
      ? envelope(value.session, { type: "clear-selection" })
      : null,
  );
}

export function normalizeAgentRelease(value: unknown): AgentReleaseMessage | null {
  return safely(() =>
    hasEnvelope(value, "release") ? envelope(value.session, { type: "release" }) : null,
  );
}

export function normalizeAgentReturnFromFootnote(
  value: unknown,
): AgentReturnFromFootnoteMessage | null {
  return safely(() =>
    hasEnvelope(value, "return-from-footnote") && isOperationId(value.activationId)
      ? envelope(value.session, {
          type: "return-from-footnote",
          activationId: value.activationId,
        })
      : null,
  );
}

export function normalizeAgentSetActiveDecoration(
  value: unknown,
): AgentSetActiveDecorationMessage | null {
  return safely(() => {
    if (
      !hasEnvelope(value, "set-active-decoration") ||
      !isOperationId(value.projectionRevision) ||
      (value.id !== null && (!isBoundedString(value.id) || value.id.length === 0))
    ) {
      return null;
    }
    return envelope(value.session, {
      type: "set-active-decoration",
      projectionRevision: value.projectionRevision,
      id: value.id,
    });
  });
}

export function normalizeAgentSetMediaOverlayActive(
  value: unknown,
): AgentSetMediaOverlayActiveMessage | null {
  return safely(() => {
    if (
      !hasEnvelope(value, "set-media-overlay-active") ||
      !isOperationId(value.commandId) ||
      (value.fragment !== null && !isMediaOverlayFragment(value.fragment)) ||
      !isMediaOverlayClassTokens(value.activeClasses) ||
      !isMediaOverlayClassTokens(value.playbackActiveClasses)
    ) {
      return null;
    }
    return envelope(value.session, {
      type: "set-media-overlay-active",
      commandId: value.commandId,
      fragment: value.fragment,
      activeClasses: [...value.activeClasses],
      playbackActiveClasses: [...value.playbackActiveClasses],
    });
  });
}

export function normalizeAgentCancelOperation(value: unknown): AgentCancelOperationMessage | null {
  return safely(() => {
    if (
      !hasEnvelope(value, "cancel-operation") ||
      !isOperationId(value.operation) ||
      !isOperation(value.operationType)
    ) {
      return null;
    }
    return envelope(value.session, {
      type: "cancel-operation",
      operation: value.operation,
      operationType: value.operationType,
    });
  });
}

export function normalizeAgentFixedViewportApplied(
  value: unknown,
): AgentFixedViewportAppliedMessage | null {
  if (!hasEnvelope(value, "fixed-viewport-applied") || !isOperationId(value.operation)) return null;
  if (value.status === "unavailable" && value.issue === "final-viewport-unavailable") {
    return envelope(value.session, {
      type: "fixed-viewport-applied",
      operation: value.operation,
      status: "unavailable",
      issue: value.issue,
    });
  }
  if (value.status !== "applied") return null;
  const geometry = normalizeFixedPageGeometry(value.geometry);
  return geometry === null
    ? null
    : envelope(value.session, {
        type: "fixed-viewport-applied",
        operation: value.operation,
        status: "applied",
        geometry,
      });
}

export function normalizeAgentRequest(value: unknown): AgentRequestMessage | null {
  return safely(() => {
    if (!hasEnvelope(value, "request") || !isOperationId(value.operation)) return null;
    const request = value.request;
    if (!isRecord(request) || !isOperation(request.type)) return null;
    if (request.type === "capture-selection" || request.type === "capture-current-location") {
      return envelope(value.session, {
        type: "request",
        operation: value.operation,
        request: { type: request.type },
      });
    }
    if (request.type === "find-media-overlay-entry") {
      if (
        !hasExactKeys(request, ["type", "fragments"]) ||
        !isMediaOverlayFragmentList(request.fragments)
      ) {
        return null;
      }
      return envelope(value.session, {
        type: "request",
        operation: value.operation,
        request: { type: "find-media-overlay-entry", fragments: [...request.fragments] },
      });
    }
    if (request.type === "reconcile-decorations") {
      const records = normalizeProjectedDecorationRecords(request.records);
      if (!isOperationId(request.projectionRevision) || records === null) return null;
      return envelope(value.session, {
        type: "request",
        operation: value.operation,
        request: {
          type: "reconcile-decorations",
          projectionRevision: request.projectionRevision,
          records,
        },
      });
    }
    if (request.type === "adjust-annotation-range") {
      if (
        !hasExactKeys(request, ["type", "projectionRevision", "recordId", "edge", "movement"]) ||
        !isOperationId(request.projectionRevision) ||
        !isBoundedString(request.recordId) ||
        request.recordId.length === 0 ||
        !isAnnotationRangeEdge(request.edge) ||
        !isAnnotationRangeMovement(request.movement)
      ) {
        return null;
      }
      return envelope(value.session, {
        type: "request",
        operation: value.operation,
        request: {
          type: "adjust-annotation-range",
          projectionRevision: request.projectionRevision,
          recordId: request.recordId,
          edge: request.edge,
          movement: request.movement,
        },
      });
    }
    if (request.type === "observe-document") {
      if (!hasExactKeys(request, ["type", "observation"])) return null;
      const observation = normalizeDocumentObservationRequest(request.observation);
      return observation === null
        ? null
        : envelope(value.session, {
            type: "request",
            operation: value.operation,
            request: { type: "observe-document", observation },
          });
    }
    if (request.type === "measure-toc-targets") {
      const targets = normalizeTocTargetRequests(request.targets);
      return targets === null
        ? null
        : envelope(value.session, {
            type: "request",
            operation: value.operation,
            request: { type: "measure-toc-targets", targets },
          });
    }
    if (request.type === "layout") {
      const layout = normalizeLayoutRequest(request);
      return layout === null
        ? null
        : envelope(value.session, {
            type: "request",
            operation: value.operation,
            request: { type: "layout", ...layout },
          });
    }
    if (request.type === "advance-presentation") {
      if (request.direction !== "forward" && request.direction !== "backward") return null;
      return envelope(value.session, {
        type: "request",
        operation: value.operation,
        request: { type: "advance-presentation", direction: request.direction },
      });
    }
    if (request.type === "generate-annotation-target") {
      const evidence =
        isRecord(request.target) && request.target.kind === "range"
          ? normalizeCaptureRangeEvidence(request.target.evidence, { items: 0, stringBytes: 0 })
          : null;
      if (
        evidence === null ||
        !isOperationId(request.localContentBasis) ||
        !isAnnotationTextFragmentPolicy(request.textFragmentPolicy)
      ) {
        return null;
      }
      return envelope(value.session, {
        type: "request",
        operation: value.operation,
        request: {
          type: "generate-annotation-target",
          target: { kind: "range", evidence },
          localContentBasis: request.localContentBasis,
          textFragmentPolicy: request.textFragmentPolicy,
        },
      });
    }
    if (request.type === "generate-current-location-annotation-target") {
      const evidence =
        isRecord(request.target) && request.target.kind === "point"
          ? normalizePointEvidenceList(request.target.evidence)
          : null;
      if (evidence === null || !isOperationId(request.localContentBasis)) return null;
      return envelope(value.session, {
        type: "request",
        operation: value.operation,
        request: {
          type: request.type,
          target: { kind: "point", evidence },
          localContentBasis: request.localContentBasis,
        },
      });
    }
    if (
      request.type === "resolve-annotation-target" ||
      request.type === "relocate-annotation-target"
    ) {
      const plan = normalizeAnnotationTargetPlan(request.plan);
      return plan === null
        ? null
        : envelope(value.session, {
            type: "request",
            operation: value.operation,
            request: { type: request.type, plan },
          });
    }
    const target = normalizeDocumentLocatorTarget(request.target);
    return target === null
      ? null
      : envelope(value.session, {
          type: "request",
          operation: value.operation,
          request: { type: request.type, target },
        });
  });
}
