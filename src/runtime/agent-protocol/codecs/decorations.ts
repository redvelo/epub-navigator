import type {
  DecorationAppearance,
  DecorationRecordOutcome,
  DecorationRecordResult,
  ProjectedDecorationRecord,
} from "../../../generated/kernel.js";
import type { AgentDecorationActivationMessage } from "../types.js";
import { normalizeLinkActivation } from "./activation.js";
import { normalizeVisualViewportAnchor } from "./selection.js";
import { normalizeAnnotationTargetPlan, addAnnotationString } from "./annotation.js";
import { hasEnvelope, envelope } from "./envelope.js";
import { isRecord, isBoundedString, isOperationId } from "./primitives.js";

export function normalizeDecorationActivation(
  value: unknown,
): AgentDecorationActivationMessage | null {
  if (
    !hasEnvelope(value, "decoration-activation") ||
    !isOperationId(value.projectionRevision) ||
    !Array.isArray(value.ids)
  ) {
    return null;
  }
  const ids = value.ids.filter(
    (id): id is string => typeof id === "string" && id.length > 0 && isBoundedString(id),
  );
  if (ids.length !== value.ids.length || new Set(ids).size !== ids.length) return null;
  const anchor = normalizeVisualViewportAnchor(value.anchor);
  const link = value.link === null ? null : normalizeLinkActivation(value.link);
  if (anchor === null || (value.link !== null && link === null)) return null;
  return envelope(value.session, {
    type: "decoration-activation",
    projectionRevision: value.projectionRevision,
    ids,
    anchor,
    link,
  });
}

export function normalizeProjectedDecorationRecords(
  value: unknown,
): ProjectedDecorationRecord[] | null {
  if (!Array.isArray(value)) return null;
  const records: ProjectedDecorationRecord[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const counter = { nodes: 0, stringBytes: 0 };
    if (
      !isRecord(candidate) ||
      !addDecorationId(counter, candidate.id) ||
      ids.has(candidate.id) ||
      !isDecorationAppearance(candidate.appearance)
    ) {
      return null;
    }
    const plan = normalizeAnnotationTargetPlan(candidate.plan, counter);
    if (plan === null) return null;
    ids.add(candidate.id);
    records.push({ id: candidate.id, plan, appearance: candidate.appearance });
  }
  return records;
}

export function normalizeDecorationRecordResults(value: unknown): DecorationRecordResult[] | null {
  if (!Array.isArray(value)) return null;
  const results: DecorationRecordResult[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const counter = { stringBytes: 0 };
    if (!isRecord(candidate) || !addDecorationId(counter, candidate.id) || ids.has(candidate.id)) {
      return null;
    }
    const outcome = normalizeDecorationOutcome(candidate.outcome, counter);
    if (outcome === null) return null;
    ids.add(candidate.id);
    results.push({ id: candidate.id, outcome });
  }
  return results;
}

export function normalizeDecorationOutcome(
  value: unknown,
  counter: { stringBytes: number },
): DecorationRecordOutcome | null {
  if (!isRecord(value)) return null;
  if (
    value.status === "rendered" ||
    value.status === "broken" ||
    value.status === "ambiguous" ||
    value.status === "conflict" ||
    value.status === "unsupported" ||
    value.status === "stale"
  )
    return { status: value.status };
  if (value.status !== "unavailable" && value.status !== "failed") return null;
  if (value.message !== null && !addAnnotationString(counter, value.message)) return null;
  return { status: value.status, message: value.message };
}

export function addDecorationId(counter: { stringBytes: number }, value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && addAnnotationString(counter, value);
}

export function isDecorationAppearance(value: unknown): value is DecorationAppearance {
  return (
    value === "annotation-highlight" ||
    value === "annotation-note" ||
    value === "search-result" ||
    value === "active-search-result" ||
    value === "temporary-emphasis"
  );
}
