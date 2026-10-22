import { normalizeDocumentObservationRequest } from "./codecs/document-observation.js";
import type {
  AgentRequest,
  DocumentAdapter,
  FixedPageGeometry,
  LayoutRequest,
} from "../../generated/kernel.js";
import type {
  ContentAgentOperation,
  AgentConfiguration,
  AgentInitializeMessage,
  AgentRole,
  AgentSetRoleMessage,
  AgentConfigureMessage,
  AgentClearSelectionMessage,
  AgentReleaseMessage,
  AgentReturnFromFootnoteMessage,
  AgentSetActiveDecorationMessage,
  AgentSetMediaOverlayActiveMessage,
  AgentCancelOperationMessage,
  AgentFixedViewportAppliedMessage,
  DocumentLocatorTarget,
  DocumentObservationRequest,
  AgentRequestMessage,
} from "./types.js";
import {
  isMediaOverlayClassTokens,
  isMediaOverlayFragment,
  isMediaOverlayFragmentList,
} from "./codecs/media-overlays.js";
import { CONTENT_AGENT_PROTOCOL_VERSION } from "./types.js";
import { normalizeFixedPageGeometry } from "./codecs/layout.js";
import { isAnnotationTextFragmentPolicy } from "./codecs/annotation.js";
import { envelope, assertSession } from "./codecs/envelope.js";
import { isBoundedString, isOperation, isOperationId } from "./codecs/primitives.js";

export const defaultAgentConfiguration: AgentConfiguration = {
  appearance: {
    rootScrollbar: "publisher",
  },
  input: {
    keyboardMode: "off",
    touchZones: false,
    progressionDirection: "ltr",
    selectionMenu: "native",
  },
};

export function buildAgentInitialize(
  session: string,
  adapter: DocumentAdapter,
  configuration: AgentConfiguration = defaultAgentConfiguration,
  diagnostics = false,
  role: AgentRole = "foreground",
  observation = false,
): AgentInitializeMessage {
  assertSession(session);
  return envelope(session, {
    type: "initialize",
    protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION,
    adapter,
    role,
    configuration,
    diagnostics,
    observation,
  });
}

export function buildAgentSetRole(
  session: string,
  role: AgentRole,
  roleChange: number,
  configuration: AgentConfiguration,
): AgentSetRoleMessage {
  assertSession(session);
  if (!isOperationId(roleChange)) throw new TypeError("content-agent role change must be uint32");
  return envelope(session, { type: "set-role", role, roleChange, configuration });
}

export function buildAgentConfigure(
  session: string,
  configuration: AgentConfiguration,
): AgentConfigureMessage {
  assertSession(session);
  return envelope(session, { type: "configure", configuration });
}

export function buildAgentClearSelection(session: string): AgentClearSelectionMessage {
  assertSession(session);
  return envelope(session, { type: "clear-selection" });
}

export function buildAgentRelease(session: string): AgentReleaseMessage {
  assertSession(session);
  return envelope(session, { type: "release" });
}

export function buildAgentReturnFromFootnote(
  session: string,
  activationId: number,
): AgentReturnFromFootnoteMessage {
  assertSession(session);
  if (!isOperationId(activationId)) throw new TypeError("footnote activation ID must be uint32");
  return envelope(session, { type: "return-from-footnote", activationId });
}

export function buildAgentSetMediaOverlayActive(
  session: string,
  commandId: number,
  fragment: string | null,
  activeClasses: readonly string[],
  playbackActiveClasses: readonly string[],
): AgentSetMediaOverlayActiveMessage {
  assertSession(session);
  if (!isOperationId(commandId)) throw new TypeError("media overlay command ID must be uint32");
  if (fragment !== null && !isMediaOverlayFragment(fragment)) {
    throw new TypeError("media overlay fragment must be a bounded non-empty string");
  }
  if (
    !isMediaOverlayClassTokens(activeClasses) ||
    !isMediaOverlayClassTokens(playbackActiveClasses)
  ) {
    throw new TypeError("media overlay classes must be bounded class tokens");
  }
  return envelope(session, {
    type: "set-media-overlay-active",
    commandId,
    fragment,
    activeClasses: [...activeClasses],
    playbackActiveClasses: [...playbackActiveClasses],
  });
}

export function buildAgentSetActiveDecoration(
  session: string,
  projectionRevision: number,
  id: string | null,
): AgentSetActiveDecorationMessage {
  assertSession(session);
  if (
    !isOperationId(projectionRevision) ||
    (id !== null && (!isBoundedString(id) || id.length === 0))
  ) {
    throw new TypeError("active decoration is invalid");
  }
  return envelope(session, { type: "set-active-decoration", projectionRevision, id });
}

export function buildAgentCancelOperation(
  session: string,
  operation: number,
  operationType: ContentAgentOperation,
): AgentCancelOperationMessage {
  assertSession(session);
  if (!isOperationId(operation)) throw new TypeError("content-agent operation must be uint32");
  if (!isOperation(operationType)) {
    throw new TypeError("content-agent operation type is invalid");
  }
  return envelope(session, { type: "cancel-operation", operation, operationType });
}

export function buildAgentFixedViewportApplied(
  session: string,
  operation: number,
  geometry: FixedPageGeometry,
): AgentFixedViewportAppliedMessage {
  assertSession(session);
  if (!isOperationId(operation)) throw new TypeError("content-agent operation must be uint32");
  const normalized = normalizeFixedPageGeometry(geometry);
  if (normalized === null) throw new TypeError("fixed-page geometry is invalid");
  return envelope(session, {
    type: "fixed-viewport-applied",
    operation,
    status: "applied",
    geometry: normalized,
  });
}

export function buildAgentFixedViewportUnavailable(
  session: string,
  operation: number,
): AgentFixedViewportAppliedMessage {
  assertSession(session);
  if (!isOperationId(operation)) throw new TypeError("content-agent operation must be uint32");
  return envelope(session, {
    type: "fixed-viewport-applied",
    operation,
    status: "unavailable",
    issue: "final-viewport-unavailable",
  });
}

export function buildAgentRequest(
  session: string,
  operation: number,
  request:
    | AgentRequest
    | LayoutRequest
    | { readonly type: "observe-document"; readonly observation: DocumentObservationRequest },
): AgentRequestMessage {
  assertSession(session);
  if (!isOperationId(operation)) throw new TypeError("content-agent operation must be uint32");
  if ("adapter" in request) {
    return envelope(session, {
      type: "request",
      operation,
      request: { type: "layout", ...request },
    });
  }
  if (request.type === "advance-presentation") {
    return envelope(session, {
      type: "request",
      operation,
      request: { type: request.type, direction: request.direction },
    });
  }
  if (request.type === "capture-selection" || request.type === "capture-current-location") {
    return envelope(session, {
      type: "request",
      operation,
      request: { type: request.type },
    });
  }
  if (request.type === "observe-document") {
    const observation = normalizeDocumentObservationRequest(request.observation);
    if (observation === null) throw new TypeError("document observation request is invalid");
    return envelope(session, {
      type: "request",
      operation,
      request: { type: "observe-document", observation },
    });
  }
  if (request.type === "find-media-overlay-entry") {
    if (!isMediaOverlayFragmentList(request.fragments)) {
      throw new TypeError("media overlay entry fragments are invalid");
    }
    return envelope(session, {
      type: "request",
      operation,
      request: { type: request.type, fragments: [...request.fragments] },
    });
  }
  if (request.type === "generate-annotation-target") {
    if (
      request.location.kind !== "range" ||
      !isOperationId(request.localContentBasis) ||
      !isAnnotationTextFragmentPolicy(request.textFragmentPolicy)
    ) {
      throw new TypeError("content-agent annotation target generation request is invalid");
    }
    return envelope(session, {
      type: "request",
      operation,
      request: {
        type: "generate-annotation-target",
        target: { kind: "range", evidence: request.location.evidence },
        localContentBasis: request.localContentBasis,
        textFragmentPolicy: request.textFragmentPolicy,
      },
    });
  }
  if (request.type === "generate-current-location-annotation-target") {
    if (request.location.kind !== "point" || !isOperationId(request.localContentBasis)) {
      throw new TypeError("content-agent current-location target generation request is invalid");
    }
    return envelope(session, {
      type: "request",
      operation,
      request: {
        type: request.type,
        target: { kind: "point", evidence: request.location.evidence },
        localContentBasis: request.localContentBasis,
      },
    });
  }
  if (request.type === "reconcile-decorations") {
    return envelope(session, {
      type: "request",
      operation,
      request: {
        type: "reconcile-decorations",
        projectionRevision: request.projectionRevision,
        records: request.records,
      },
    });
  }
  if (request.type === "adjust-annotation-range") {
    return envelope(session, {
      type: "request",
      operation,
      request: {
        type: "adjust-annotation-range",
        projectionRevision: request.projectionRevision,
        recordId: request.recordId,
        edge: request.edge,
        movement: request.movement,
      },
    });
  }
  if (
    request.type === "resolve-annotation-target" ||
    request.type === "relocate-annotation-target"
  ) {
    return envelope(session, {
      type: "request",
      operation,
      request: { type: request.type, plan: request.plan },
    });
  }
  const target: DocumentLocatorTarget =
    request.locator.kind === "point"
      ? { kind: "point", evidence: request.locator.evidence }
      : { kind: "range", evidence: request.locator.evidence };
  return envelope(session, {
    type: "request",
    operation,
    request: { type: request.type, target },
  });
}
