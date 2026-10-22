import type { PointEvidence } from "../../../generated/kernel.js";
import type {
  TocTargetIdentity,
  TocTargetMeasurementRequest,
  TocTargetPageResult,
  TocTargetMeasurementResult,
  AgentTocTargetsResultMessage,
} from "../types.js";
import {
  MAX_TOC_TARGETS_PER_OPERATION,
  MAX_TOC_EVIDENCE_ITEMS_PER_OPERATION,
  MAX_TOC_EVIDENCE_CODE_UNITS_PER_OPERATION,
  MAX_TOC_POINT_PATH,
} from "../limits.js";
import { normalizePointEvidenceList } from "./evidence.js";
import { hasEnvelope, envelope } from "./envelope.js";
import { isRecord, isBoundedString, isOperationId, isNonnegativeInteger } from "./primitives.js";

export function normalizeTocTargetsResult(value: unknown): AgentTocTargetsResultMessage | null {
  if (
    !hasEnvelope(value, "result") ||
    !isOperationId(value.operation) ||
    value.resultType !== "measure-toc-targets" ||
    !Array.isArray(value.results) ||
    value.results.length === 0 ||
    value.results.length > MAX_TOC_TARGETS_PER_OPERATION
  ) {
    return null;
  }
  const results: TocTargetMeasurementResult[] = [];
  const identities = new Set<string>();
  for (const candidate of value.results) {
    const identity = normalizeTocTargetIdentity(candidate);
    if (identity === null || !isRecord(candidate) || !isRecord(candidate.result)) return null;
    const key = `${identity.listIndex}:${identity.pointPath.join("/")}`;
    if (identities.has(key)) return null;
    identities.add(key);
    const result = candidate.result;
    let normalized: TocTargetPageResult;
    if (result.state === "located" && isNonnegativeInteger(result.physicalPage)) {
      normalized = { state: "located", physicalPage: result.physicalPage };
    } else if (
      (result.state === "ambiguous" || result.state === "unavailable") &&
      isBoundedString(result.reason)
    ) {
      normalized = { state: result.state, reason: result.reason };
    } else if (result.state === "failed" && isBoundedString(result.message)) {
      normalized = { state: "failed", message: result.message };
    } else {
      return null;
    }
    results.push({ ...identity, result: normalized });
  }
  return envelope(value.session, {
    type: "result",
    operation: value.operation,
    resultType: "measure-toc-targets",
    results,
  });
}

export function normalizeTocTargetRequests(value: unknown): TocTargetMeasurementRequest[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOC_TARGETS_PER_OPERATION)
    return null;
  const targets: TocTargetMeasurementRequest[] = [];
  const identities = new Set<string>();
  let evidenceItems = 0;
  let evidenceCodeUnits = 0;
  for (const candidate of value) {
    const identity = normalizeTocTargetIdentity(candidate);
    if (identity === null || !isRecord(candidate)) return null;
    const evidence = normalizePointEvidenceList(candidate.evidence);
    if (evidence === null) return null;
    evidenceItems += evidence.length;
    evidenceCodeUnits += evidence.reduce((total, item) => {
      if (item.kind === "html-fragment") {
        return total + item.value.length;
      }
      if (item.kind === "rendered-text-context") {
        return total + item.before.length + item.after.length;
      }
      return total;
    }, 0);
    if (
      evidenceItems > MAX_TOC_EVIDENCE_ITEMS_PER_OPERATION ||
      evidenceCodeUnits > MAX_TOC_EVIDENCE_CODE_UNITS_PER_OPERATION
    ) {
      return null;
    }
    const key = `${identity.listIndex}:${identity.pointPath.join("/")}`;
    if (identities.has(key)) return null;
    identities.add(key);
    targets.push({ ...identity, evidence });
  }
  return targets;
}

export function normalizeTocTargetIdentity(value: unknown): TocTargetIdentity | null {
  if (
    !isRecord(value) ||
    !isNonnegativeInteger(value.listIndex) ||
    !Array.isArray(value.pointPath) ||
    value.pointPath.length === 0 ||
    value.pointPath.length > MAX_TOC_POINT_PATH ||
    !value.pointPath.every(isNonnegativeInteger)
  ) {
    return null;
  }
  return { listIndex: value.listIndex, pointPath: [...value.pointPath] };
}

export function tocTargetIdentityKey(identity: TocTargetIdentity): string {
  return `${identity.listIndex}:${identity.pointPath.join("/")}`;
}

export function pointEvidenceCodeUnits(evidence: readonly PointEvidence[]): number {
  return evidence.reduce((total, item) => {
    if (item.kind === "html-fragment") return total + item.value.length;
    if (item.kind === "rendered-text-context")
      return total + item.before.length + item.after.length;
    return total;
  }, 0);
}
