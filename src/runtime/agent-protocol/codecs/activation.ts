import type {
  AgentActivationMessage,
  AgentFormSubmissionMessage,
  AgentLinkActivation,
  AgentInteractionMessage,
} from "../types.js";
import { normalizePointEvidenceList } from "./evidence.js";
import { hasEnvelope, envelope } from "./envelope.js";
import { isRecord, isBoundedString, isOperationId } from "./primitives.js";

export function normalizeActivation(value: unknown): AgentActivationMessage | null {
  if (!hasEnvelope(value, "activation")) return null;
  const activation = normalizeLinkActivation(value);
  if (activation === null) return null;
  const originEvidence = isRecord(value.footnote)
    ? normalizePointEvidenceList(value.footnote.originEvidence)
    : null;
  const footnote =
    isRecord(value.footnote) &&
    isOperationId(value.footnote.activationId) &&
    originEvidence !== null &&
    originEvidence.length > 0
      ? {
          activationId: value.footnote.activationId,
          originEvidence,
          disposition:
            value.footnote.disposition === "reported"
              ? ("reported" as const)
              : ("navigated" as const),
          referenceRect: normalizeReferenceRect(value.footnote.referenceRect),
          referenceLabel:
            typeof value.footnote.referenceLabel === "string" &&
            value.footnote.referenceLabel.length > 0 &&
            value.footnote.referenceLabel.length <= MAX_REFERENCE_LABEL_CODE_UNITS
              ? value.footnote.referenceLabel
              : null,
        }
      : null;
  return envelope(value.session, {
    type: "activation",
    ...activation,
    footnote,
  });
}

/** A marker, not a sentence: anything longer is not a marker. */
const MAX_REFERENCE_LABEL_CODE_UNITS = 8;

function normalizeReferenceRect(
  value: unknown,
): { x: number; y: number; width: number; height: number } | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  const finite = [x, y, width, height].every(
    (member) => typeof member === "number" && Number.isFinite(member),
  );
  return finite && (width as number) >= 0 && (height as number) >= 0
    ? { x: x as number, y: y as number, width: width as number, height: height as number }
    : null;
}

export function normalizeFormSubmission(value: unknown): AgentFormSubmissionMessage | null {
  if (!hasEnvelope(value, "form-submission")) return null;
  if (
    (value.action !== null && !isBoundedString(value.action)) ||
    !isBoundedString(value.resolvedUrl) ||
    !isBoundedString(value.method) ||
    (value.target !== null && !isBoundedString(value.target))
  ) {
    return null;
  }
  return envelope(value.session, {
    type: "form-submission",
    action: value.action,
    resolvedUrl: value.resolvedUrl,
    method: value.method,
    target: value.target,
  });
}

export function normalizeLinkActivation(value: unknown): AgentLinkActivation | null {
  if (!isRecord(value)) return null;
  if (
    !isBoundedString(value.href) ||
    !isBoundedString(value.resolvedUrl) ||
    (value.target !== null && !isBoundedString(value.target)) ||
    (value.download !== null && !isBoundedString(value.download))
  )
    return null;
  return {
    href: value.href,
    resolvedUrl: value.resolvedUrl,
    target: value.target,
    download: value.download,
  };
}

export function normalizeInteraction(value: unknown): AgentInteractionMessage | null {
  if (!hasEnvelope(value, "interaction")) return null;
  const { command, source } = value;
  if (
    (command !== "previous" &&
      command !== "next" &&
      command !== "reveal-top" &&
      command !== "reveal-bottom" &&
      !readerCommands.some((candidate) => candidate === command)) ||
    (source !== "keyboard" && source !== "touch" && source !== "pointer")
  )
    return null;
  return envelope(value.session, {
    type: "interaction",
    command: command as AgentInteractionMessage["command"],
    source,
  });
}
import { readerCommands } from "../../reader-commands.js";
