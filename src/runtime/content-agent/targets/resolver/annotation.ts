import type {
  AnnotationSelectorExecutionOutcome,
  AnnotationSelectorExecutionReport,
  AnnotationSelectorNode,
  AnnotationSelectorSegmentKind,
  AnnotationTargetResolutionPlan,
  AnnotationTargetResolutionResult,
  CooperativeResolverWork,
  DocumentTextSnapshot,
  ResolverWorkMeter,
  TextMatch,
  VisibleTextMap,
} from "./types.js";
import {
  ResolverWorkLimitExceeded,
  htmlWhitespace,
  maximumAnnotationCandidates,
  maximumUnsignedU64,
  runtimeOwnedElementSelector,
} from "./types.js";
import {
  assertResolverActive,
  chargeResolverWork,
  isAbortError,
  rangeFromOffsets,
  sameRange,
  validateCooperativeWork,
} from "./evidence.js";
import { createDocumentTextSnapshotCooperatively, textMapFromSnapshot } from "./text-index.js";
import { textOffsetForBoundary } from "./viewport.js";

/** Normalizes only the whitespace characters collapsed by ordinary HTML text layout. */
export function normalizeHtmlWhitespace(value: string): string {
  let normalized = "";
  let inWhitespace = false;
  for (const character of value) {
    if (htmlWhitespace.test(character)) {
      if (!inWhitespace) normalized += " ";
      inWhitespace = true;
    } else {
      normalized += character;
      inWhitespace = false;
    }
  }
  return normalized;
}

/** Finds quote matches whose supplied immediate context also agrees. */
export function findTextQuoteMatches(
  text: string,
  exact: string,
  prefix: string,
  suffix: string,
): TextMatch[] {
  if (exact.length === 0) return [];
  const matches: TextMatch[] = [];
  let from = 0;
  while (from <= text.length - exact.length) {
    const start = text.indexOf(exact, from);
    if (start < 0) break;
    const end = start + exact.length;
    if (
      text.slice(Math.max(0, start - prefix.length), start) === prefix &&
      text.slice(end, end + suffix.length) === suffix
    ) {
      matches.push({ start, end });
    }
    from = start + 1;
  }
  return matches;
}

export interface AnnotationCandidate {
  readonly range: Range;
  readonly segmentKind: AnnotationSelectorSegmentKind;
  readonly element: Element | null;
}

export interface AnnotationBranchResult {
  readonly outcome: AnnotationSelectorExecutionOutcome;
  readonly candidate: AnnotationCandidate | null;
}

export interface AnnotationScope {
  readonly element: Element | null;
  readonly range: Range | null;
}

export class AnnotationUnavailable extends Error {}

export class UnsupportedTextFragment extends Error {}

export class ResolverBasisStale extends Error {}

export class AnnotationReportAccumulator {
  readonly #reports = new Map<
    string,
    {
      readonly path: readonly number[];
      readonly kind: AnnotationSelectorNode["kind"];
      matchCount: number;
      readonly outcomes: Set<AnnotationSelectorExecutionReport["outcome"]>;
      segmentKind: AnnotationSelectorSegmentKind | null;
      segmentKindsAgree: boolean;
      readonly messages: Map<AnnotationSelectorExecutionReport["outcome"], string>;
    }
  >();
  add(report: AnnotationSelectorExecutionReport): void {
    const key = annotationPathKey(report.path);
    let entry = this.#reports.get(key);
    if (entry === undefined) {
      entry = {
        path: report.path,
        kind: report.kind,
        matchCount: 0,
        outcomes: new Set(),
        segmentKind: report.segmentKind,
        segmentKindsAgree: true,
        messages: new Map(),
      };
      this.#reports.set(key, entry);
    }
    entry.matchCount += report.matchCount;
    entry.outcomes.add(report.outcome);
    if (report.segmentKind !== null) {
      if (entry.segmentKind === null) entry.segmentKind = report.segmentKind;
      else if (entry.segmentKind !== report.segmentKind) entry.segmentKindsAgree = false;
    }
    if (report.message !== undefined && !entry.messages.has(report.outcome)) {
      entry.messages.set(report.outcome, report.message);
    }
  }
  finish(): AnnotationSelectorExecutionReport[] {
    return [...this.#reports.values()].map(mergeAnnotationReports).toSorted(compareSelectorReports);
  }
}

export function mergeAnnotationReports(
  entry: Readonly<{
    path: readonly number[];
    kind: AnnotationSelectorNode["kind"];
    matchCount: number;
    outcomes: Set<AnnotationSelectorExecutionReport["outcome"]>;
    segmentKind: AnnotationSelectorSegmentKind | null;
    segmentKindsAgree: boolean;
    messages: Map<AnnotationSelectorExecutionReport["outcome"], string>;
  }>,
): AnnotationSelectorExecutionReport {
  const outcomes = [...entry.outcomes];
  const indeterminate = annotationIndeterminateOutcome(outcomes);
  const outcome =
    indeterminate ??
    (entry.matchCount > 1
      ? "ambiguous"
      : entry.matchCount === 1 && entry.outcomes.has("resolved")
        ? "resolved"
        : annotationReportOutcome(outcomes));
  const segmentKind =
    indeterminate === null && entry.segmentKind !== null && entry.segmentKindsAgree
      ? entry.segmentKind
      : null;
  const message = entry.messages.get(outcome);
  return {
    path: entry.path,
    kind: entry.kind,
    outcome,
    matchCount: indeterminate === null ? entry.matchCount : 0,
    segmentKind,
    ...(message === undefined ? {} : { message }),
  };
}

export function annotationReportOutcome(
  outcomes: readonly AnnotationSelectorExecutionReport["outcome"][],
): AnnotationSelectorExecutionReport["outcome"] {
  for (const outcome of [
    "resolved",
    "failed",
    "stale",
    "ambiguous",
    "broken",
    "invalid",
    "unavailable",
    "unsupported",
  ] as const) {
    if (outcomes.includes(outcome)) return outcome;
  }
  return "broken";
}

export function annotationIndeterminateOutcome(
  outcomes: readonly AnnotationSelectorExecutionReport["outcome"][],
): "failed" | "stale" | "unavailable" | null {
  for (const outcome of ["failed", "stale", "unavailable"] as const) {
    if (outcomes.includes(outcome)) return outcome;
  }
  return null;
}

export function annotationPathKey(path: readonly number[]): string {
  return path.join(".");
}

/** Executes a browser annotation-selector plan cooperatively without modifying the publication DOM. */
export async function resolveAnnotationTargetInDocument(
  document: Document,
  plan: AnnotationTargetResolutionPlan,
  work: CooperativeResolverWork,
  snapshot?: DocumentTextSnapshot,
): Promise<AnnotationTargetResolutionResult> {
  validateCooperativeWork(work);
  const meter: ResolverWorkMeter = { ...work, used: 0, sinceYield: 0 };
  const reports = new AnnotationReportAccumulator();
  try {
    let textMap: VisibleTextMap | null = null;
    const getTextMap = async () =>
      (textMap ??=
        snapshot === undefined
          ? (await createDocumentTextSnapshotCooperatively(document, meter)).index
          : textMapFromSnapshot(document, snapshot));
    const branches: AnnotationBranchResult[] = [];
    for (const selector of plan.selectors) {
      branches.push(
        await executeAnnotationSelector(
          document,
          selector,
          { element: null, range: null },
          getTextMap,
          reports,
          meter,
        ),
      );
      if (meter.used > meter.maximumWorkUnits) {
        return unavailableAnnotationResult(reports);
      }
    }
    assertResolverActive(meter, true);
    const aggregate = reconcileAnnotationBranches(branches);
    return {
      outcome: aggregate.outcome,
      reports: reports.finish(),
      segmentKind: aggregate.candidate?.segmentKind ?? null,
      range: aggregate.candidate?.range ?? null,
    };
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    const stale = cause instanceof ResolverBasisStale;
    return {
      outcome: stale ? "stale" : "failed",
      reports: stale
        ? reports.finish().map((report) => ({
            ...report,
            outcome: "stale" as const,
            message: cause.message,
          }))
        : reports.finish(),
      segmentKind: null,
      range: null,
    };
  }
}

export async function executeAnnotationSelector(
  document: Document,
  selector: AnnotationSelectorNode,
  scope: AnnotationScope,
  getTextMap: () => Promise<VisibleTextMap>,
  reports: AnnotationReportAccumulator,
  meter: ResolverWorkMeter,
): Promise<AnnotationBranchResult> {
  let candidates: AnnotationCandidate[] = [];
  let failure: Exclude<
    AnnotationSelectorExecutionOutcome,
    "resolved" | "conflict" | "failed"
  > | null = null;
  let message: string | undefined;
  try {
    await chargeResolverWork(meter, 1);
    if (selector.kind === "invalid") {
      failure = "invalid";
      message = selector.values.message ?? undefined;
    } else if (selector.kind === "unsupported") {
      failure = "unsupported";
      message = selector.values.selectorType ?? undefined;
    } else {
      candidates = await candidatesForAnnotationSelector(
        document,
        selector,
        scope,
        getTextMap,
        meter,
      );
      candidates = uniqueAnnotationCandidates(candidates);
      if (candidates.length > maximumAnnotationCandidates) {
        throw new AnnotationUnavailable("annotation selector matched too many candidates");
      }
      failure = candidates.length === 0 ? "broken" : candidates.length > 1 ? "ambiguous" : null;
    }
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    failure =
      cause instanceof ResolverBasisStale
        ? "stale"
        : cause instanceof ResolverWorkLimitExceeded || cause instanceof AnnotationUnavailable
          ? "unavailable"
          : cause instanceof UnsupportedTextFragment
            ? "unsupported"
            : "invalid";
    message = cause instanceof Error ? cause.message : "invalid selector";
  }
  reports.add({
    path: selector.path,
    kind: selector.kind,
    outcome: failure ?? "resolved",
    matchCount: candidates.length,
    segmentKind: candidates.length === 0 ? null : commonSegmentKind(candidates),
    ...(message === undefined ? {} : { message }),
  });
  if (candidates.length === 0) return { outcome: failure ?? "broken", candidate: null };
  if (selector.refinements.length === 0) {
    return candidates.length === 1
      ? { outcome: "resolved", candidate: candidates[0]! }
      : { outcome: "ambiguous", candidate: null };
  }
  const parentBranches: AnnotationBranchResult[] = [];
  for (const candidate of candidates) {
    const siblingBranches: AnnotationBranchResult[] = [];
    for (const refinement of selector.refinements) {
      siblingBranches.push(
        await executeAnnotationSelector(
          document,
          refinement,
          scopeForCandidate(candidate),
          getTextMap,
          reports,
          meter,
        ),
      );
      if (meter.used > meter.maximumWorkUnits) {
        return { outcome: "unavailable", candidate: null };
      }
    }
    parentBranches.push(reconcileAnnotationBranches(siblingBranches));
  }
  return reconcileAnnotationBranches(parentBranches);
}

export function unavailableAnnotationResult(
  reports: AnnotationReportAccumulator,
): AnnotationTargetResolutionResult {
  return { outcome: "unavailable", reports: reports.finish(), segmentKind: null, range: null };
}

export async function candidatesForAnnotationSelector(
  document: Document,
  selector: Exclude<
    AnnotationSelectorNode,
    {
      kind: "invalid" | "unsupported";
    }
  >,
  scope: AnnotationScope,
  getTextMap: () => Promise<VisibleTextMap>,
  meter: ResolverWorkMeter,
): Promise<AnnotationCandidate[]> {
  if (selector.kind === "resource") {
    const root = document.body ?? document.documentElement;
    if (root === null) return [];
    const range = document.createRange();
    range.selectNodeContents(root);
    return [{ range, segmentKind: "resource", element: root }];
  }
  if (selector.kind === "css") {
    if (selector.values.value.trim().length === 0) throw new Error("CSS selector is empty");
    const elements = (scope.element ?? document).querySelectorAll(selector.values.value);
    await chargeResolverWork(meter, 1);
    return candidatesForElements(
      document,
      elements,
      meter,
      scope.element === null ? scope.range : null,
    );
  }
  if (selector.kind === "html-fragment") {
    if (selector.values.value.length === 0) throw new Error("HTML fragment is empty");
    const elements = (scope.element ?? document).querySelectorAll("[id]");
    await chargeResolverWork(meter, 1);
    const candidates: AnnotationCandidate[] = [];
    for (const element of elements) {
      await chargeResolverWork(meter, 1);
      if (
        element.id === selector.values.value &&
        annotationElementIsInScope(element, scope.element === null ? scope.range : null)
      )
        candidates.push(candidateForElement(document, element));
      if (candidates.length > maximumAnnotationCandidates) {
        throw new AnnotationUnavailable("annotation selector matched too many candidates");
      }
    }
    return candidates;
  }
  const map = await getTextMap();
  const { start: scopeStart, end: scopeEnd } = textBoundsForScope(scope, map);
  if (selector.kind === "text-position") {
    const start = parseTextPositionOffset(selector.values.start);
    const end = parseTextPositionOffset(selector.values.end);
    if (start > end) throw new Error("text-position start must not follow its end");
    if (end > BigInt(Number.MAX_SAFE_INTEGER)) return [];
    const view = map.text.slice(scopeStart, scopeEnd);
    const offsets = await utf16OffsetsForCodePoints(view, Number(start), Number(end), meter);
    if (offsets === null) return [];
    const [startOffset, endOffset] = offsets;
    return [candidateForTextRange(document, map, scopeStart + startOffset, scopeStart + endOffset)];
  }
  const fragment = parseTextFragment(selector.values.value);
  await chargeResolverWork(meter, scopeEnd - scopeStart);
  const view = map.text.slice(scopeStart, scopeEnd);
  return findBoundedExactMatches(view, fragment.exact, fragment.prefix, fragment.suffix).map(
    (match) =>
      candidateForTextRange(document, map, scopeStart + match.start, scopeStart + match.end),
  );
}

export async function candidatesForElements(
  document: Document,
  elements: NodeListOf<Element>,
  meter: ResolverWorkMeter,
  range: Range | null,
): Promise<AnnotationCandidate[]> {
  const candidates: AnnotationCandidate[] = [];
  for (const element of elements) {
    await chargeResolverWork(meter, 1);
    if (!annotationElementIsInScope(element, range)) continue;
    candidates.push(candidateForElement(document, element));
    if (candidates.length > maximumAnnotationCandidates) {
      throw new AnnotationUnavailable("annotation selector matched too many candidates");
    }
  }
  return candidates;
}

export function annotationElementIsInScope(element: Element, range: Range | null): boolean {
  if (element.closest(runtimeOwnedElementSelector) !== null) return false;
  if (range === null) return true;
  try {
    return range.intersectsNode(element);
  } catch {
    return false;
  }
}

export function findBoundedExactMatches(
  text: string,
  exact: string,
  prefix = "",
  suffix = "",
): TextMatch[] {
  const matches: TextMatch[] = [];
  let from = 0;
  while (matches.length < 2) {
    const start = text.indexOf(exact, from);
    if (start < 0) break;
    const end = start + exact.length;
    if (
      text.slice(Math.max(0, start - prefix.length), start) === prefix &&
      text.slice(end, end + suffix.length) === suffix
    ) {
      matches.push({ start, end });
    }
    from = start + 1;
  }
  return matches;
}

export function scopeForCandidate(candidate: AnnotationCandidate): AnnotationScope {
  return { element: candidate.element, range: candidate.range };
}

export function textBoundsForScope(
  scope: AnnotationScope,
  map: VisibleTextMap,
): {
  start: number;
  end: number;
} {
  if (scope.element !== null) return map.spans.get(scope.element) ?? { start: 0, end: 0 };
  if (scope.range === null) return { start: 0, end: map.text.length };
  const start = textOffsetForBoundary(map, {
    node: scope.range.startContainer,
    offset: scope.range.startOffset,
  });
  const end = textOffsetForBoundary(map, {
    node: scope.range.endContainer,
    offset: scope.range.endOffset,
  });
  return { start: start ?? 0, end: end ?? map.text.length };
}

export function candidateForElement(document: Document, element: Element): AnnotationCandidate {
  const range = document.createRange();
  range.setStart(element, 0);
  range.collapse(true);
  return { range, segmentKind: "element", element };
}

export function candidateForTextRange(
  document: Document,
  map: VisibleTextMap,
  start: number,
  end: number,
): AnnotationCandidate {
  return {
    range: rangeFromOffsets(document, map, start, end),
    segmentKind: start === end ? "point" : "range",
    element: null,
  };
}

export function parseTextPositionOffset(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("text-position offsets must be canonical unsigned decimal strings");
  }
  if (value.length > 20 || (value.length === 20 && value > maximumUnsignedU64.toString())) {
    throw new Error("text-position offsets must fit in an unsigned 64-bit integer");
  }
  const offset = BigInt(value);
  return offset;
}

export function utf16OffsetForCodePoint(value: string, offset: bigint): number | null {
  if (offset > BigInt(value.length)) return null;
  let codePoints = 0n;
  let utf16 = 0;
  while (utf16 < value.length && codePoints < offset) {
    const codePoint = value.codePointAt(utf16);
    if (codePoint === undefined) return null;
    utf16 += codePoint > 0xffff ? 2 : 1;
    codePoints += 1n;
  }
  return codePoints === offset ? utf16 : null;
}

export function codePointOffsetForUtf16(value: string, offset: number): string {
  let codePoints = 0;
  let utf16 = 0;
  while (utf16 < offset) {
    const codePoint = value.codePointAt(utf16);
    if (codePoint === undefined) throw new Error("invalid rendered-text boundary");
    utf16 += codePoint > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  if (utf16 !== offset) throw new Error("rendered-text boundary splits a Unicode code point");
  return String(codePoints);
}

export async function utf16OffsetsForCodePoints(
  value: string,
  start: number,
  end: number,
  meter: ResolverWorkMeter,
): Promise<readonly [number, number] | null> {
  let codePoints = 0;
  let utf16 = 0;
  let pendingWork = 0;
  let startOffset = start === 0 ? 0 : null;
  while (utf16 < value.length && codePoints < end) {
    const codePoint = value.codePointAt(utf16);
    if (codePoint === undefined) return null;
    utf16 += codePoint > 0xffff ? 2 : 1;
    codePoints += 1;
    pendingWork += 1;
    if (codePoints === start) startOffset = utf16;
    if (pendingWork >= 4096) {
      await chargeResolverWork(meter, pendingWork);
      pendingWork = 0;
    }
  }
  if (pendingWork > 0) await chargeResolverWork(meter, pendingWork);
  return codePoints === end && startOffset !== null ? [startOffset, utf16] : null;
}

export function parseTextFragment(value: string): {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
} {
  if (!value.startsWith("text=")) throw new Error("text fragment must start with text=");
  const encoded = value.slice(5);
  if (encoded.length === 0 || encoded.length > 16384)
    throw new Error("text fragment is empty or exceeds its size limit");
  const components = encoded.split(",");
  if (components.length > 4 || components.some((component) => component.length === 0)) {
    throw new Error("text fragment has invalid range or context syntax");
  }
  if (components.length === 1) {
    return { exact: decodeTextFragmentComponent(components[0]!), prefix: "", suffix: "" };
  }

  const first = components[0]!;
  const last = components.at(-1)!;
  const hasPrefix = first.endsWith("-");
  const hasSuffix = last.startsWith("-");
  if ((hasPrefix && first.length === 1) || (hasSuffix && last.length === 1)) {
    throw new Error("text fragment has empty context");
  }
  if (components.length === 2 && hasPrefix) {
    return {
      prefix: decodeTextFragmentComponent(first.slice(0, -1)),
      exact: decodeTextFragmentComponent(last),
      suffix: "",
    };
  }
  if (components.length === 2 && hasSuffix) {
    return {
      prefix: "",
      exact: decodeTextFragmentComponent(first),
      suffix: decodeTextFragmentComponent(last.slice(1)),
    };
  }
  if (components.length === 3 && hasPrefix && hasSuffix) {
    return {
      prefix: decodeTextFragmentComponent(first.slice(0, -1)),
      exact: decodeTextFragmentComponent(components[1]!),
      suffix: decodeTextFragmentComponent(last.slice(1)),
    };
  }
  const validRange =
    components.length === 2 ||
    (components.length === 3 && (hasPrefix || hasSuffix)) ||
    (components.length === 4 && hasPrefix && hasSuffix);
  if (!validRange) throw new Error("text fragment has invalid range or context syntax");
  throw new UnsupportedTextFragment("text fragment range forms are unsupported");
}

export function decodeTextFragmentComponent(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0) throw new Error();
    return decoded;
  } catch {
    throw new Error("text fragment contains invalid percent encoding or an empty component");
  }
}

export function reconcileAnnotationBranches(
  branches: readonly AnnotationBranchResult[],
): AnnotationBranchResult {
  for (const outcome of ["failed", "stale", "unavailable"] as const) {
    if (branches.some((branch) => branch.outcome === outcome)) return { outcome, candidate: null };
  }
  const successful = branches.filter(
    (
      branch,
    ): branch is AnnotationBranchResult & {
      candidate: AnnotationCandidate;
    } => branch.outcome === "resolved" && branch.candidate !== null,
  );
  if (successful.length > 0) {
    const first = successful[0]!.candidate;
    return successful.every((branch) => sameAnnotationCandidate(first, branch.candidate))
      ? { outcome: "resolved", candidate: first }
      : { outcome: "conflict", candidate: null };
  }
  for (const outcome of ["conflict", "ambiguous", "broken", "invalid", "unsupported"] as const) {
    if (branches.some((branch) => branch.outcome === outcome)) return { outcome, candidate: null };
  }
  return { outcome: "broken", candidate: null };
}

export function uniqueAnnotationCandidates(
  candidates: readonly AnnotationCandidate[],
): AnnotationCandidate[] {
  const nodeIds = new WeakMap<Node, number>();
  const keys = new Set<string>();
  const unique: AnnotationCandidate[] = [];
  let nextNodeId = 0;
  const nodeId = (node: Node): number => {
    let id = nodeIds.get(node);
    if (id === undefined) {
      id = ++nextNodeId;
      nodeIds.set(node, id);
    }
    return id;
  };
  for (const candidate of candidates) {
    const key =
      candidate.element === null
        ? `${candidate.segmentKind}:${nodeId(candidate.range.startContainer)}:${candidate.range.startOffset}:${nodeId(candidate.range.endContainer)}:${candidate.range.endOffset}`
        : `${candidate.segmentKind}:element:${nodeId(candidate.element)}`;
    if (keys.has(key)) continue;
    keys.add(key);
    unique.push(candidate);
  }
  return unique;
}

export function sameAnnotationCandidate(
  left: AnnotationCandidate,
  right: AnnotationCandidate,
): boolean {
  if (left.segmentKind !== right.segmentKind) return false;
  if (left.element !== null || right.element !== null) return left.element === right.element;
  return sameRange(left.range, right.range);
}

export function commonSegmentKind(
  candidates: readonly AnnotationCandidate[],
): AnnotationSelectorSegmentKind | null {
  const first = candidates[0]?.segmentKind;
  return first !== undefined && candidates.every((candidate) => candidate.segmentKind === first)
    ? first
    : null;
}

export function compareSelectorReports(
  left: AnnotationSelectorExecutionReport,
  right: AnnotationSelectorExecutionReport,
): number {
  const length = Math.max(left.path.length, right.path.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.path[index] ?? -1) - (right.path[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}
