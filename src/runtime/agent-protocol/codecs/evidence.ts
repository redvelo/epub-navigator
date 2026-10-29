import type {
  LocatorResolutionStatus,
  PointEvidence,
  RangeEvidence,
} from "../../../generated/kernel.js";
import type { DocumentLocatorTarget } from "../types.js";
import { MAX_EVIDENCE_ITEMS } from "../limits.js";
import {
  isCanonicalBrowserTextOffset,
  isCanonicalDocumentProgression,
  isRecord,
  isBoundedString,
} from "./primitives.js";

export function normalizeResolutionStatus(value: unknown): LocatorResolutionStatus | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (value.status === "resolved") return { status: "resolved" };
  if (
    (value.status === "not-found" ||
      value.status === "ambiguous" ||
      value.status === "conflicting-evidence" ||
      value.status === "unsupported-evidence" ||
      value.status === "failed") &&
    isBoundedString(value.message)
  )
    return { status: value.status, message: value.message };
  return null;
}

export function normalizePointEvidenceList(value: unknown): PointEvidence[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE_ITEMS) return null;
  const normalized: PointEvidence[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (item.kind === "html-fragment" && isBoundedString(item.value) && item.value.length > 0) {
      normalized.push({ kind: "html-fragment", value: item.value });
    } else if (
      item.kind === "rendered-text-context" &&
      isBoundedString(item.before) &&
      isBoundedString(item.after) &&
      (item.before.length > 0 || item.after.length > 0)
    ) {
      normalized.push({ kind: item.kind, before: item.before, after: item.after });
    } else if (item.kind === "browser-text-position" && isCanonicalBrowserTextOffset(item.offset)) {
      normalized.push({ kind: item.kind, offset: item.offset });
    } else if (
      item.kind === "document-boundary" &&
      (item.boundary === "start" || item.boundary === "end")
    ) {
      normalized.push({ kind: item.kind, boundary: item.boundary });
    } else if (item.kind === "document-progression" && isCanonicalDocumentProgression(item.value)) {
      normalized.push({ kind: item.kind, value: item.value });
    } else return null;
  }
  return normalized;
}

export function normalizeDocumentLocatorTarget(value: unknown): DocumentLocatorTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === "point") {
    const evidence = normalizePointEvidenceList(value.evidence);
    return evidence === null ? null : { kind: "point", evidence };
  }
  if (
    value.kind !== "range" ||
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    value.evidence.length > MAX_EVIDENCE_ITEMS
  )
    return null;
  const evidence: RangeEvidence[] = [];
  for (const item of value.evidence) {
    if (!isRecord(item)) return null;
    if (
      item.kind === "rendered-text-quote" &&
      isBoundedString(item.exact) &&
      item.exact.length > 0 &&
      isBoundedString(item.prefix) &&
      isBoundedString(item.suffix)
    ) {
      evidence.push({
        kind: "rendered-text-quote",
        exact: item.exact,
        prefix: item.prefix,
        suffix: item.suffix,
      });
      continue;
    }
    if (
      item.kind === "browser-text-position" &&
      isCanonicalBrowserTextOffset(item.start) &&
      isCanonicalBrowserTextOffset(item.end) &&
      BigInt(item.start) < BigInt(item.end)
    ) {
      evidence.push({ kind: item.kind, start: item.start, end: item.end });
      continue;
    }
    const start = item.kind === "boundaries" ? normalizePointEvidenceList(item.start) : null;
    const end = item.kind === "boundaries" ? normalizePointEvidenceList(item.end) : null;
    if (start === null || end === null) return null;
    evidence.push({ kind: "boundaries", start, end });
  }
  return { kind: "range", evidence };
}
