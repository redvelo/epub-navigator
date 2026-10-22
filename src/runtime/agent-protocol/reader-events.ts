import { normalizeDocumentObservationResultMessage } from "./codecs/document-observation.js";
import type { AgentDocumentObservationResultMessage } from "./types.js";
import type {
  AgentRoleChangedMessage,
  AgentReleasedMessage,
  AgentReadyMessage,
  AgentLocatorResultMessage,
  AgentAnnotationTargetResultMessage,
  AgentAnnotationTargetGenerationResultMessage,
  AgentAnnotationPointTargetGenerationResultMessage,
  AgentDecorationResultMessage,
  AgentAnnotationRangeAdjustmentResultMessage,
  AgentLayoutResultMessage,
  AgentAdvancePresentationResultMessage,
  AgentSelectionResultMessage,
  AgentCurrentLocationResultMessage,
  AgentTocTargetsResultMessage,
  AgentObservationMessage,
  AgentLayoutInvalidatedMessage,
  AgentSelectionChangedMessage,
  AgentActivityMessage,
  AgentActivationMessage,
  AgentFormSubmissionMessage,
  AgentFootnoteReturnedMessage,
  AgentMediaOverlayActiveAppliedMessage,
  AgentMediaOverlayEntryResultMessage,
  AgentDecorationActivationMessage,
  AgentInteractionMessage,
  AgentFixedViewInteractionMessage,
  AgentPaginationDiagnosticMessage,
  AgentFontEvidenceMessage,
  AgentFixedViewportMessage,
} from "./types.js";
import { normalizeReady, normalizeResult } from "./codecs/results.js";
import { normalizeTocTargetsResult } from "./codecs/toc.js";
import { normalizeLayoutInvalidated, normalizeFixedViewport } from "./codecs/layout.js";
import { normalizeObservation } from "./codecs/observation.js";
import {
  normalizeActivation,
  normalizeFormSubmission,
  normalizeInteraction,
} from "./codecs/activation.js";
import { normalizeDecorationActivation } from "./codecs/decorations.js";
import { hasEnvelope, envelope, withExpectedSession } from "./codecs/envelope.js";
import {
  isOperationId,
  isFiniteNumber,
  isNonnegativeFinite,
  isPositiveFinite,
  isNonnegativeInteger,
  safely,
} from "./codecs/primitives.js";

export function hasAgentMessageSource(
  event: Pick<MessageEvent<unknown>, "source">,
  expectedSource: Window,
): boolean {
  return event.source === expectedSource;
}

export function normalizeAgentReady(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentReadyMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => withExpectedSession(normalizeReady(event.data), expectedSession));
}

export function normalizeAgentResult(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
):
  | AgentLocatorResultMessage
  | AgentAnnotationTargetResultMessage
  | AgentAnnotationTargetGenerationResultMessage
  | AgentAnnotationPointTargetGenerationResultMessage
  | AgentDecorationResultMessage
  | AgentAnnotationRangeAdjustmentResultMessage
  | AgentSelectionResultMessage
  | AgentCurrentLocationResultMessage
  | AgentMediaOverlayEntryResultMessage
  | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const result = withExpectedSession(normalizeResult(event.data), expectedSession);
    return result?.resultType === "resolve-locator" ||
      result?.resultType === "find-media-overlay-entry" ||
      result?.resultType === "relocate" ||
      result?.resultType === "resolve-annotation-target" ||
      result?.resultType === "relocate-annotation-target" ||
      result?.resultType === "generate-annotation-target" ||
      result?.resultType === "generate-current-location-annotation-target" ||
      result?.resultType === "reconcile-decorations" ||
      result?.resultType === "adjust-annotation-range" ||
      result?.resultType === "capture-selection" ||
      result?.resultType === "capture-current-location"
      ? result
      : null;
  });
}

export function normalizeAgentSelectionChanged(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentSelectionChangedMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const value = event.data;
    return !hasEnvelope(value, "selection-changed")
      ? null
      : withExpectedSession(
          envelope(value.session, { type: "selection-changed" }),
          expectedSession,
        );
  });
}

export function normalizeAgentActivity(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentActivityMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const value = event.data;
    if (!hasEnvelope(value, "activity")) return null;
    const activity = value.activity;
    if (activity !== "pointer" && activity !== "scroll" && activity !== "presentation") {
      return null;
    }
    return withExpectedSession(
      envelope(value.session, { type: "activity", activity }),
      expectedSession,
    );
  });
}

export function normalizeAgentAdvancePresentationResult(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentAdvancePresentationResultMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const result = withExpectedSession(normalizeResult(event.data), expectedSession);
    return result?.resultType === "advance-presentation" ? result : null;
  });
}

export function normalizeAgentDecorationResult(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentDecorationResultMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const result = withExpectedSession(normalizeResult(event.data), expectedSession);
    return result?.resultType === "reconcile-decorations" ? result : null;
  });
}

export function normalizeAgentLayoutResult(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentLayoutResultMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const result = withExpectedSession(normalizeResult(event.data), expectedSession);
    return result?.resultType === "layout" ? result : null;
  });
}

export function normalizeAgentFixedViewport(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentFixedViewportMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => withExpectedSession(normalizeFixedViewport(event.data), expectedSession));
}

export function normalizeAgentLayoutInvalidated(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentLayoutInvalidatedMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => withExpectedSession(normalizeLayoutInvalidated(event.data), expectedSession));
}

export function normalizeAgentObservation(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentObservationMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => withExpectedSession(normalizeObservation(event.data), expectedSession));
}

export function normalizeAgentActivation(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentActivationMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => withExpectedSession(normalizeActivation(event.data), expectedSession));
}

export function normalizeAgentFormSubmission(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentFormSubmissionMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => withExpectedSession(normalizeFormSubmission(event.data), expectedSession));
}

export function normalizeAgentFootnoteReturned(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentFootnoteReturnedMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const value = event.data;
    if (
      !hasEnvelope(value, "footnote-returned") ||
      !isOperationId(value.activationId) ||
      (value.status !== "returned" &&
        value.status !== "unavailable" &&
        value.status !== "stale" &&
        value.status !== "failed")
    ) {
      return null;
    }
    return withExpectedSession(
      envelope(value.session, {
        type: "footnote-returned",
        activationId: value.activationId,
        status: value.status,
      }),
      expectedSession,
    );
  });
}

export function normalizeAgentMediaOverlayActiveApplied(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentMediaOverlayActiveAppliedMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const value = event.data;
    if (
      !hasEnvelope(value, "media-overlay-active-applied") ||
      !isOperationId(value.commandId) ||
      (value.status !== "applied" &&
        value.status !== "cleared" &&
        value.status !== "missing" &&
        value.status !== "unsupported") ||
      typeof value.visible !== "boolean"
    ) {
      return null;
    }
    return withExpectedSession(
      envelope(value.session, {
        type: "media-overlay-active-applied",
        commandId: value.commandId,
        status: value.status,
        visible: value.visible,
      }),
      expectedSession,
    );
  });
}

export function normalizeAgentDecorationActivation(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentDecorationActivationMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() =>
    withExpectedSession(normalizeDecorationActivation(event.data), expectedSession),
  );
}

export function normalizeAgentInteraction(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentInteractionMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => withExpectedSession(normalizeInteraction(event.data), expectedSession));
}

export function normalizeAgentFixedViewInteraction(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentFixedViewInteractionMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const value = event.data;
    if (
      !hasEnvelope(value, "fixed-view-interaction") ||
      (value.source !== "keyboard" && value.source !== "pointer" && value.source !== "touch")
    ) {
      return null;
    }
    let normalized: AgentFixedViewInteractionMessage;
    if (
      value.action === "zoom" &&
      isPositiveFinite(value.factor) &&
      value.factor >= 0.5 &&
      value.factor <= 2 &&
      isFiniteNumber(value.focalX) &&
      isFiniteNumber(value.focalY)
    ) {
      normalized = envelope(value.session, {
        type: "fixed-view-interaction",
        action: "zoom",
        source: value.source,
        factor: value.factor,
        focalX: value.focalX,
        focalY: value.focalY,
      });
    } else if (
      value.action === "pan" &&
      isFiniteNumber(value.deltaX) &&
      isFiniteNumber(value.deltaY) &&
      Math.abs(value.deltaX) <= 4096 &&
      Math.abs(value.deltaY) <= 4096
    ) {
      normalized = envelope(value.session, {
        type: "fixed-view-interaction",
        action: "pan",
        source: value.source,
        deltaX: value.deltaX,
        deltaY: value.deltaY,
      });
    } else if (value.action === "reset" && value.source === "keyboard") {
      normalized = envelope(value.session, {
        type: "fixed-view-interaction",
        action: "reset",
        source: "keyboard",
      });
    } else {
      return null;
    }
    return withExpectedSession(normalized, expectedSession);
  });
}

export function normalizeAgentPaginationDiagnostic(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentPaginationDiagnosticMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const value = event.data;
    if (!hasEnvelope(value, "pagination-diagnostic")) return null;
    if (
      (value.phase !== "capture" &&
        value.phase !== "content-end-scan" &&
        value.phase !== "text-assessment" &&
        value.phase !== "settlement" &&
        value.phase !== "observation" &&
        value.phase !== "live-observation") ||
      !isNonnegativeFinite(value.durationMs) ||
      !isNonnegativeInteger(value.scanCount) ||
      !isNonnegativeInteger(value.rectangleCount)
    ) {
      return null;
    }
    return withExpectedSession(
      envelope(value.session, {
        type: "pagination-diagnostic",
        phase: value.phase,
        durationMs: value.durationMs,
        scanCount: value.scanCount,
        rectangleCount: value.rectangleCount,
      }),
      expectedSession,
    );
  });
}

export function normalizeAgentFontEvidence(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentFontEvidenceMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const value = event.data;
    if (
      !hasEnvelope(value, "font-evidence") ||
      value.target !== "publication" ||
      value.family !== "navigator-reader-serif" ||
      typeof value.configured !== "boolean" ||
      typeof value.declared !== "boolean" ||
      typeof value.loaded !== "boolean" ||
      typeof value.check !== "boolean"
    ) {
      return null;
    }
    return withExpectedSession(
      envelope(value.session, {
        type: "font-evidence",
        target: "publication",
        family: "navigator-reader-serif",
        configured: value.configured,
        declared: value.declared,
        loaded: value.loaded,
        check: value.check,
      }),
      expectedSession,
    );
  });
}

export function normalizeAgentRoleChanged(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentRoleChangedMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => {
    const value = event.data;
    if (
      !hasEnvelope(value, "role-changed") ||
      (value.role !== "foreground" && value.role !== "auxiliary" && value.role !== "prepared") ||
      !isOperationId(value.roleChange)
    ) {
      return null;
    }
    return withExpectedSession(
      envelope(value.session, {
        type: "role-changed",
        role: value.role,
        roleChange: value.roleChange,
      }),
      expectedSession,
    );
  });
}

export function normalizeAgentReleased(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentReleasedMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() =>
    hasEnvelope(event.data, "released")
      ? withExpectedSession(envelope(event.data.session, { type: "released" }), expectedSession)
      : null,
  );
}

export function normalizeAgentDocumentObservationResult(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentDocumentObservationResultMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() =>
    withExpectedSession(normalizeDocumentObservationResultMessage(event.data), expectedSession),
  );
}

export function normalizeAgentTocTargetsResult(
  event: MessageEvent<unknown>,
  expectedSource: Window,
  expectedSession?: string,
): AgentTocTargetsResultMessage | null {
  if (!hasAgentMessageSource(event, expectedSource)) return null;
  return safely(() => withExpectedSession(normalizeTocTargetsResult(event.data), expectedSession));
}
