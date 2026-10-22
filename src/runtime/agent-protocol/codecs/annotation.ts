import type {
  AnnotationSelectorExecutionReport,
  AnnotationSelectorNode,
  AnnotationRangeAdjustmentCandidate,
  AnnotationRangeEdge,
  AnnotationRangeMovement,
  AnnotationPointTargetGenerationCandidate,
  AnnotationTargetGenerationCandidate,
  AnnotationTargetReconciliationResult,
  AnnotationTargetResolutionPlan,
  AnnotationTextFragmentPolicy,
} from "../../../generated/kernel.js";
import {
  MAX_PROTOCOL_STRING,
  MAX_ANNOTATION_DEPTH,
  MAX_ANNOTATION_EXCERPT_CODE_POINTS,
  MAX_ANNOTATION_EXCERPT_BYTES,
  MAX_ANNOTATION_SELECTORS,
  MAX_ANNOTATION_AGGREGATE_STRING_BYTES,
} from "../limits.js";
import {
  isCanonicalBrowserTextOffset,
  utf8ByteLength,
  isRecord,
  hasExactKeys,
  isBoundedString,
  isArrayOf,
  isNonnegativeInteger,
  isOperationId,
} from "./primitives.js";

export function normalizeAnnotationTargetPlan(
  value: unknown,
  aggregateCounter?: { nodes: number; stringBytes: number },
): AnnotationTargetResolutionPlan | null {
  if (
    !isRecord(value) ||
    !isBoundedAnnotationString(value.resource) ||
    !Array.isArray(value.selectors)
  )
    return null;
  const counter = aggregateCounter ?? { nodes: 0, stringBytes: 0 };
  if (!addAnnotationString(counter, value.resource)) return null;
  const selectors = normalizeAnnotationSelectorNodes(value.selectors, [], counter);
  return selectors === null || selectors.length === 0
    ? null
    : { resource: value.resource, selectors };
}

export function normalizeAnnotationTargetGenerationCandidate(
  value: unknown,
): AnnotationTargetGenerationCandidate | null {
  if (
    !isRecord(value) ||
    !isOperationId(value.localContentBasis) ||
    !isAnnotationTextFragmentPolicy(value.textFragmentPolicy) ||
    !isRecord(value.status)
  ) {
    return null;
  }
  const { status } = value;
  if (status.status === "generated") {
    if (!isRecord(status.selectors)) return null;
    const css = normalizeAnnotationCssRangeCandidate(status.selectors.css);
    const document = normalizeAnnotationDocumentRangeCandidate(status.selectors.document);
    const textFragment = status.selectors.textFragment;
    if (
      (status.selectors.css !== null && css === null) ||
      (status.selectors.document !== null && document === null) ||
      (textFragment !== null &&
        (!isBoundedAnnotationString(textFragment) || textFragment.trim().length === 0)) ||
      (css === null && document === null) ||
      (value.textFragmentPolicy === "exclude" && textFragment !== null)
    ) {
      return null;
    }
    return {
      localContentBasis: value.localContentBasis,
      textFragmentPolicy: value.textFragmentPolicy,
      status: { status: "generated", selectors: { css, document, textFragment } },
    };
  }
  let normalizedStatus: AnnotationTargetGenerationCandidate["status"];
  if (
    status.status === "unavailable" &&
    (status.reason === "not-authored" ||
      status.reason === "no-exact-selector" ||
      status.reason === "no-exact-movement" ||
      status.reason === "decoration-not-rendered")
  ) {
    normalizedStatus = { status: "unavailable", reason: status.reason };
  } else if (
    status.status === "unsupported" ||
    status.status === "ambiguous" ||
    status.status === "conflict" ||
    status.status === "stale"
  ) {
    normalizedStatus = { status: status.status };
  } else if (
    status.status === "failed" &&
    (status.message === null || isBoundedAnnotationString(status.message))
  ) {
    normalizedStatus = { status: "failed", message: status.message };
  } else {
    return null;
  }
  return {
    localContentBasis: value.localContentBasis,
    textFragmentPolicy: value.textFragmentPolicy,
    status: normalizedStatus,
  };
}

export function normalizeAnnotationPointTargetGenerationCandidate(
  value: unknown,
): AnnotationPointTargetGenerationCandidate | null {
  if (!isRecord(value) || !isOperationId(value.localContentBasis) || !isRecord(value.status)) {
    return null;
  }
  const status = value.status;
  if (status.status === "generated") {
    if (!isRecord(status.selectors) || typeof status.selectors.wholeResource !== "boolean") {
      return null;
    }
    const normalizeCssPoint = (candidate: unknown) => {
      if (candidate === null) return null;
      if (!isRecord(candidate) || !isCanonicalBrowserTextOffset(candidate.offset)) return undefined;
      if (!isBoundedAnnotationString(candidate.value) || candidate.value.trim().length === 0) {
        return undefined;
      }
      return { value: candidate.value, offset: candidate.offset };
    };
    const normalizeDocumentPoint = (candidate: unknown) => {
      if (candidate === null) return null;
      if (!isRecord(candidate) || !isCanonicalBrowserTextOffset(candidate.offset)) return undefined;
      return { offset: candidate.offset };
    };
    const css = normalizeCssPoint(status.selectors.css);
    const document = normalizeDocumentPoint(status.selectors.document);
    if (
      css === undefined ||
      document === undefined ||
      (status.selectors.wholeResource && (css !== null || document !== null)) ||
      (!status.selectors.wholeResource && css === null && document === null)
    ) {
      return null;
    }
    return {
      localContentBasis: value.localContentBasis,
      status: {
        status: "generated",
        selectors: { css, document, wholeResource: status.selectors.wholeResource },
      },
    };
  }
  const normalized = normalizeAnnotationTargetGenerationCandidate({
    localContentBasis: value.localContentBasis,
    textFragmentPolicy: "exclude",
    status,
  });
  return normalized === null || normalized.status.status === "generated"
    ? null
    : { localContentBasis: value.localContentBasis, status: normalized.status };
}

export function normalizeAnnotationRangeAdjustmentCandidate(
  value: unknown,
): AnnotationRangeAdjustmentCandidate | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "projectionRevision",
      "recordId",
      "edge",
      "movement",
      "status",
      "excerpt",
    ]) ||
    !isOperationId(value.projectionRevision) ||
    !isBoundedString(value.recordId) ||
    value.recordId.length === 0 ||
    !isAnnotationRangeEdge(value.edge) ||
    !isAnnotationRangeMovement(value.movement)
  ) {
    return null;
  }
  const normalized = normalizeAnnotationTargetGenerationCandidate({
    localContentBasis: 0,
    textFragmentPolicy: "exclude",
    status: value.status,
  });
  if (normalized === null) return null;
  const generated = normalized.status.status === "generated";
  let excerpt: string | null = null;
  if (generated) {
    if (
      typeof value.excerpt !== "string" ||
      Array.from(value.excerpt).length > MAX_ANNOTATION_EXCERPT_CODE_POINTS ||
      utf8ByteLength(value.excerpt) > MAX_ANNOTATION_EXCERPT_BYTES
    ) {
      return null;
    }
    excerpt = value.excerpt;
  } else if (value.excerpt !== null) {
    return null;
  }
  return {
    projectionRevision: value.projectionRevision,
    recordId: value.recordId,
    edge: value.edge,
    movement: value.movement,
    status: normalized.status,
    excerpt,
  };
}

export function isAnnotationRangeEdge(value: unknown): value is AnnotationRangeEdge {
  return value === "start" || value === "end";
}

export function isAnnotationRangeMovement(value: unknown): value is AnnotationRangeMovement {
  return value === "backward" || value === "forward";
}

export function normalizeAnnotationCssRangeCandidate(
  value: unknown,
): Extract<
  Extract<
    AnnotationTargetGenerationCandidate["status"],
    { status: "generated" }
  >["selectors"]["css"],
  object
> | null {
  if (
    !isRecord(value) ||
    !isBoundedAnnotationString(value.value) ||
    value.value.trim().length === 0 ||
    !isAnnotationOffset(value.start) ||
    !isAnnotationOffset(value.end) ||
    !increasingAnnotationRange(value.start, value.end)
  )
    return null;
  return { value: value.value, start: value.start, end: value.end };
}

export function normalizeAnnotationDocumentRangeCandidate(
  value: unknown,
): Extract<
  Extract<
    AnnotationTargetGenerationCandidate["status"],
    { status: "generated" }
  >["selectors"]["document"],
  object
> | null {
  return isRecord(value) &&
    isAnnotationOffset(value.start) &&
    isAnnotationOffset(value.end) &&
    increasingAnnotationRange(value.start, value.end)
    ? { start: value.start, end: value.end }
    : null;
}

export function increasingAnnotationRange(start: string, end: string): boolean {
  return BigInt(start) < BigInt(end);
}

export function isAnnotationTextFragmentPolicy(
  value: unknown,
): value is AnnotationTextFragmentPolicy {
  return value === "exclude" || value === "include";
}

export function normalizeAnnotationSelectorNodes(
  value: unknown[],
  parentPath: readonly number[],
  counter: { nodes: number; stringBytes: number },
): AnnotationSelectorNode[] | null {
  if (parentPath.length >= MAX_ANNOTATION_DEPTH) return null;
  const nodes: AnnotationSelectorNode[] = [];
  for (const [index, candidate] of value.entries()) {
    counter.nodes += 1;
    if (counter.nodes > MAX_ANNOTATION_SELECTORS) return null;
    const node = normalizeAnnotationSelectorNode(candidate, [...parentPath, index], counter);
    if (node === null) return null;
    nodes.push(node);
  }
  return nodes;
}

export function normalizeAnnotationSelectorNode(
  value: unknown,
  expectedPath: readonly number[],
  counter: { nodes: number; stringBytes: number },
): AnnotationSelectorNode | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.path) ||
    value.path.length !== expectedPath.length ||
    value.path.length > MAX_ANNOTATION_DEPTH ||
    !isArrayOf(value.path, isNonnegativeInteger) ||
    value.path.some((item, index) => item !== expectedPath[index]) ||
    !isRecord(value.values) ||
    !Array.isArray(value.refinements)
  )
    return null;
  const refinements = normalizeAnnotationSelectorNodes(value.refinements, expectedPath, counter);
  if (refinements === null) return null;
  const path = [...value.path];
  if (value.kind === "resource") return { kind: "resource", path, values: {}, refinements };
  if (value.kind === "html-fragment" || value.kind === "css" || value.kind === "text-fragment")
    return addAnnotationString(counter, value.values.value)
      ? { kind: value.kind, path, values: { value: value.values.value }, refinements }
      : null;
  if (value.kind === "text-position")
    return addAnnotationString(counter, value.values.start) &&
      addAnnotationString(counter, value.values.end) &&
      isAnnotationOffset(value.values.start) &&
      isAnnotationOffset(value.values.end)
      ? {
          kind: "text-position",
          path,
          values: { start: value.values.start, end: value.values.end },
          refinements,
        }
      : null;
  if (value.kind === "invalid")
    return value.values.message === null || addAnnotationString(counter, value.values.message)
      ? { kind: "invalid", path, values: { message: value.values.message }, refinements }
      : null;
  if (value.kind === "unsupported")
    return value.values.selectorType === null ||
      addAnnotationString(counter, value.values.selectorType)
      ? {
          kind: "unsupported",
          path,
          values: { selectorType: value.values.selectorType },
          refinements,
        }
      : null;
  return null;
}

export function normalizeAnnotationTargetResult(
  value: unknown,
): AnnotationTargetReconciliationResult | null {
  if (
    !isRecord(value) ||
    !isAnnotationOutcome(value.outcome) ||
    !Array.isArray(value.reports) ||
    value.reports.length > MAX_ANNOTATION_SELECTORS
  ) {
    return null;
  }
  const reports: AnnotationSelectorExecutionReport[] = [];
  const reportsByPath = new Map<string, AnnotationSelectorExecutionReport>();
  const counter = { nodes: 0, stringBytes: 0 };
  for (const candidate of value.reports) {
    const report = normalizeAnnotationReport(candidate, counter);
    if (report === null) return null;
    const key = report.path.join("/");
    if (reportsByPath.has(key)) return null;
    reportsByPath.set(key, report);
    reports.push(report);
  }
  if (
    reports.some((report) => {
      if (report.path.length === 1) return false;
      const parent = reportsByPath.get(report.path.slice(0, -1).join("/"));
      return (
        parent === undefined ||
        (parent.outcome !== "resolved" &&
          parent.outcome !== "ambiguous" &&
          parent.outcome !== "stale")
      );
    })
  ) {
    return null;
  }
  const segment = normalizeAnnotationSegment(value.segment, counter);
  if (value.segment !== null && segment === null) return null;
  if ((value.outcome === "resolved") !== (segment !== null)) return null;
  if (value.outcome === "resolved" && reports.length === 0) return null;
  if (!annotationReconciliationOutcomeValid(value.outcome, reports, segment)) return null;
  return { outcome: value.outcome, reports, segment };
}

export function annotationReconciliationOutcomeValid(
  outcome: AnnotationTargetReconciliationResult["outcome"],
  reports: readonly AnnotationSelectorExecutionReport[],
  segment: AnnotationTargetReconciliationResult["segment"],
): boolean {
  if (outcome === "resolved") {
    return (
      segment !== null &&
      reports.some(
        (report) =>
          (report.outcome === "resolved" || report.outcome === "ambiguous") &&
          report.segment?.kind === segment.kind,
      )
    );
  }
  if (outcome === "conflict") {
    return (
      reports.filter((report) => report.outcome === "resolved").length >= 2 ||
      reports.some((report) => report.outcome === "conflict")
    );
  }
  if (outcome === "failed") return true;
  return reports.some((report) => report.outcome === outcome);
}

export function normalizeAnnotationReport(
  value: unknown,
  counter: { nodes: number; stringBytes: number },
): AnnotationSelectorExecutionReport | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.path) ||
    value.path.length === 0 ||
    value.path.length > MAX_ANNOTATION_DEPTH ||
    !isArrayOf(value.path, isNonnegativeInteger) ||
    !isAnnotationSelectorKind(value.kind) ||
    !isAnnotationOutcome(value.outcome) ||
    !isNonnegativeInteger(value.matchCount) ||
    (value.message !== null && !addAnnotationString(counter, value.message))
  )
    return null;
  const segment = normalizeAnnotationSegment(value.segment, counter);
  if (value.segment !== null && segment === null) return null;
  if (!annotationReportOutcomeSegmentValid(value.outcome, value.matchCount, segment)) return null;
  return {
    path: [...value.path],
    kind: value.kind,
    outcome: value.outcome,
    matchCount: value.matchCount,
    segment,
    message: value.message,
  };
}

export function normalizeAnnotationSegment(
  value: unknown,
  counter: { nodes: number; stringBytes: number },
): AnnotationTargetReconciliationResult["segment"] {
  if (
    !isRecord(value) ||
    (value.kind !== "resource" &&
      value.kind !== "element" &&
      value.kind !== "point" &&
      value.kind !== "range") ||
    !addAnnotationString(counter, value.resource)
  )
    return null;
  return { kind: value.kind, resource: value.resource };
}

export function isAnnotationOffset(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

export function isAnnotationOutcome(
  value: unknown,
): value is AnnotationSelectorExecutionReport["outcome"] {
  return (
    value === "resolved" ||
    value === "broken" ||
    value === "ambiguous" ||
    value === "invalid" ||
    value === "unsupported" ||
    value === "conflict" ||
    value === "unavailable" ||
    value === "stale" ||
    value === "failed"
  );
}

export function annotationReportOutcomeSegmentValid(
  outcome: AnnotationSelectorExecutionReport["outcome"],
  matchCount: number,
  segment: AnnotationSelectorExecutionReport["segment"],
): boolean {
  if (outcome === "resolved") return matchCount === 1 && segment !== null;
  if (
    outcome === "broken" ||
    outcome === "invalid" ||
    outcome === "unsupported" ||
    outcome === "unavailable"
  ) {
    return matchCount === 0 && segment === null;
  }
  if (outcome === "ambiguous") return matchCount > 1;
  if (outcome === "conflict") return segment === null;
  return true;
}

export function addAnnotationString(
  counter: { stringBytes: number },
  value: unknown,
): value is string {
  if (!isBoundedAnnotationString(value)) return false;
  counter.stringBytes += utf8ByteLength(value);
  return counter.stringBytes <= MAX_ANNOTATION_AGGREGATE_STRING_BYTES;
}

export function isBoundedAnnotationString(value: unknown): value is string {
  return typeof value === "string" && utf8ByteLength(value) <= MAX_PROTOCOL_STRING;
}

export function isAnnotationSelectorKind(
  value: unknown,
): value is AnnotationSelectorExecutionReport["kind"] {
  return (
    value === "resource" ||
    value === "html-fragment" ||
    value === "css" ||
    value === "text-position" ||
    value === "text-fragment" ||
    value === "invalid" ||
    value === "unsupported"
  );
}
