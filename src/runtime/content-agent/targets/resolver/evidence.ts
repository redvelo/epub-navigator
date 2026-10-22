import type {
  Boundary,
  CandidateResult,
  CooperativeResolverWork,
  DomLocatorResolution,
  ResolverWorkMeter,
  VisibleTextMap,
} from "./types.js";
import type { PointEvidence } from "../../../../generated/kernel.js";
import {
  ResolverBasisStale,
  parseTextPositionOffset,
  utf16OffsetForCodePoint,
  utf16OffsetsForCodePoints,
} from "./annotation.js";
import { ResolverWorkLimitExceeded, nonRenderedElements } from "./types.js";

export type ComputedStyleFor = (element: Element) => CSSStyleDeclaration;

export function elementIsPruned(element: Element, styleFor: ComputedStyleFor): boolean {
  if (nonRenderedElements.has(element.tagName) || element.hasAttribute("hidden")) {
    return true;
  }
  const style = styleFor(element);
  return style.display === "none" || style.contentVisibility === "hidden";
}

export function textNodeIsVisible(node: Node, styleFor: ComputedStyleFor): boolean {
  const parent = node.parentElement;
  if (parent === null) return true;
  const visibility = styleFor(parent).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

export function createsRenderedBoundary(element: Element, styleFor: ComputedStyleFor): boolean {
  const display = styleFor(element).display;
  return display !== "contents" && !display.startsWith("inline") && display !== "ruby";
}

export function elementBoundary(element: Element, after: boolean): Boundary {
  const parent = element.parentNode;
  if (parent === null) return { node: element, offset: after ? element.childNodes.length : 0 };
  const index = Array.prototype.indexOf.call(parent.childNodes, element);
  return { node: parent, offset: index + (after ? 1 : 0) };
}

export function resolvePointEvidence(
  document: Document,
  getTextMap: () => VisibleTextMap,
  evidence: PointEvidence,
): CandidateResult {
  if (evidence.kind === "document-boundary") {
    const root = document.body ?? document.documentElement;
    if (root === null) return { kind: "candidates", ranges: [] };
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(evidence.boundary === "start");
    return { kind: "candidates", ranges: [range] };
  }
  if (evidence.kind === "html-fragment") {
    const element = document.getElementById(evidence.value);
    if (element === null) return { kind: "candidates", ranges: [] };
    const range = document.createRange();
    range.setStart(element, 0);
    range.collapse(true);
    return { kind: "candidates", ranges: [range] };
  }
  if (evidence.kind === "browser-text-position") {
    const textMap = getTextMap();
    const offset = utf16OffsetForCodePoint(textMap.text, parseTextPositionOffset(evidence.offset));
    return {
      kind: "candidates",
      ranges: offset === null ? [] : [rangeFromOffsets(document, textMap, offset, offset)],
    };
  }
  const { before, after } = evidence;
  const textMap = getTextMap();
  const ranges: Range[] = [];
  for (let offset = 0; offset <= textMap.text.length; offset += 1) {
    if (textMap.text.slice(Math.max(0, offset - before.length), offset) !== before) continue;
    if (textMap.text.slice(offset, offset + after.length) !== after) continue;
    ranges.push(rangeFromOffsets(document, textMap, offset, offset));
  }
  return { kind: "candidates", ranges };
}

export function resolveTextPositionRange(
  document: Document,
  textMap: VisibleTextMap,
  startValue: string,
  endValue: string,
): CandidateResult {
  const startPosition = parseTextPositionOffset(startValue);
  const endPosition = parseTextPositionOffset(endValue);
  if (startPosition > endPosition) {
    throw new Error("browser-text-position start must not follow its end");
  }
  const start = utf16OffsetForCodePoint(textMap.text, startPosition);
  const end = utf16OffsetForCodePoint(textMap.text, endPosition);
  return {
    kind: "candidates",
    ranges: start === null || end === null ? [] : [rangeFromOffsets(document, textMap, start, end)],
  };
}

export async function resolvePointEvidenceCooperatively(
  document: Document,
  getTextMap: () => VisibleTextMap,
  evidence: PointEvidence,
  meter: ResolverWorkMeter,
): Promise<CandidateResult> {
  if (evidence.kind === "browser-text-position") {
    const position = parseTextPositionOffset(evidence.offset);
    if (position > BigInt(Number.MAX_SAFE_INTEGER)) {
      await chargeResolverWork(meter, 1);
      return { kind: "candidates", ranges: [] };
    }
    const textMap = getTextMap();
    const offsets = await utf16OffsetsForCodePoints(
      textMap.text,
      Number(position),
      Number(position),
      meter,
    );
    return {
      kind: "candidates",
      ranges: offsets === null ? [] : [rangeFromOffsets(document, textMap, offsets[0], offsets[0])],
    };
  }
  if (evidence.kind !== "rendered-text-context") {
    await chargeResolverWork(meter, 1);
    return resolvePointEvidence(document, getTextMap, evidence);
  }
  const { before, after } = evidence;
  const textMap = getTextMap();
  const ranges: Range[] = [];
  const workPerOffset = 1 + before.length + after.length;
  let pendingWork = 0;
  for (let offset = 0; offset <= textMap.text.length; offset += 1) {
    if (
      textMap.text.slice(Math.max(0, offset - before.length), offset) === before &&
      textMap.text.slice(offset, offset + after.length) === after
    ) {
      ranges.push(rangeFromOffsets(document, textMap, offset, offset));
    }
    pendingWork += workPerOffset;
    if (pendingWork >= meter.yieldEveryWorkUnits) {
      await chargeResolverWork(meter, pendingWork);
      pendingWork = 0;
    }
  }
  await chargeResolverWork(meter, pendingWork);
  return { kind: "candidates", ranges };
}

export async function chargeResolverWork(meter: ResolverWorkMeter, units: number): Promise<void> {
  meter.used += units;
  meter.sinceYield += units;
  if (meter.used > meter.maximumWorkUnits) throw new ResolverWorkLimitExceeded();
  assertResolverActive(meter);
  if (meter.sinceYield < meter.yieldEveryWorkUnits) return;
  meter.sinceYield = 0;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assertResolverActive(meter, true);
}

export function validateCooperativeWork(work: CooperativeResolverWork): void {
  if (
    !Number.isSafeInteger(work.maximumWorkUnits) ||
    work.maximumWorkUnits <= 0 ||
    !Number.isSafeInteger(work.yieldEveryWorkUnits) ||
    work.yieldEveryWorkUnits <= 0
  ) {
    throw new Error("cooperative resolver work limits must be positive finite integers");
  }
}

export function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

export function assertResolverActive(meter: ResolverWorkMeter, checkBasis = false): void {
  if (meter.signal.aborted) {
    throw new DOMException("browser resolution was cancelled", "AbortError");
  }
  if (checkBasis && meter.isCurrent?.() === false) {
    throw new ResolverBasisStale("document style state changed during browser resolution");
  }
}

export function resolveBoundaries(
  document: Document,
  getTextMap: () => VisibleTextMap,
  startEvidence: PointEvidence[],
  endEvidence: PointEvidence[],
): CandidateResult {
  const start = reconcileCandidates(
    startEvidence.map((evidence) => resolvePointEvidence(document, getTextMap, evidence)),
  );
  const end = reconcileCandidates(
    endEvidence.map((evidence) => resolvePointEvidence(document, getTextMap, evidence)),
  );
  if (start.kind === "unsupported" || end.kind === "unsupported") return { kind: "unsupported" };
  if (start.kind === "status") return start;
  if (end.kind === "status") return end;
  const range = document.createRange();
  const startRange = start.ranges[0]!;
  const endRange = end.ranges[0]!;
  if (startRange.compareBoundaryPoints(Range.START_TO_START, endRange) > 0) {
    return {
      kind: "status",
      status: {
        status: "conflicting-evidence",
        message: "range boundary evidence places the end before the start",
      },
    };
  }
  range.setStart(startRange.startContainer, startRange.startOffset);
  range.setEnd(endRange.startContainer, endRange.startOffset);
  return { kind: "candidates", ranges: [range] };
}

export function reconcile(results: CandidateResult[]): DomLocatorResolution {
  const explicitStatus = results.find(
    (
      result,
    ): result is Extract<
      CandidateResult,
      {
        kind: "status";
      }
    > => result.kind === "status",
  );
  if (explicitStatus !== undefined) return { range: null, status: explicitStatus.status };
  const supported = results.filter(
    (
      result,
    ): result is Extract<
      CandidateResult,
      {
        kind: "candidates";
      }
    > => result.kind === "candidates",
  );
  if (supported.length === 0) {
    return statusOnly("unsupported-evidence", "the locator contains no supported DOM evidence");
  }
  if (supported.some((result) => result.ranges.length === 0)) {
    return statusOnly("not-found", "supported locator evidence did not match the document");
  }
  if (supported.some((result) => result.ranges.length > 1)) {
    return statusOnly("ambiguous", "supported locator evidence matched more than one location");
  }
  const first = supported[0]?.ranges[0]!;
  if (supported.some((result) => !sameRange(first, result.ranges[0]!))) {
    return statusOnly(
      "conflicting-evidence",
      "supported locator evidence identified different locations",
    );
  }
  return { range: first, status: { status: "resolved" } };
}

export function reconcileCandidates(results: CandidateResult[]): CandidateResult {
  const explicitStatus = results.find(
    (
      result,
    ): result is Extract<
      CandidateResult,
      {
        kind: "status";
      }
    > => result.kind === "status",
  );
  if (explicitStatus !== undefined) return explicitStatus;
  const supported = results.filter(
    (
      result,
    ): result is Extract<
      CandidateResult,
      {
        kind: "candidates";
      }
    > => result.kind === "candidates",
  );
  if (supported.length === 0) return { kind: "unsupported" };
  if (supported.some((result) => result.ranges.length === 0)) {
    return {
      kind: "status",
      status: {
        status: "not-found",
        message: "point boundary evidence did not match the document",
      },
    };
  }
  if (supported.some((result) => result.ranges.length > 1)) {
    return {
      kind: "status",
      status: {
        status: "ambiguous",
        message: "point boundary evidence matched multiple locations",
      },
    };
  }
  const first = supported[0]?.ranges[0]!;
  return supported.every((result) => sameRange(first, result.ranges[0]!))
    ? { kind: "candidates", ranges: [first] }
    : {
        kind: "status",
        status: {
          status: "conflicting-evidence",
          message: "point boundary evidence identified different locations",
        },
      };
}

export function rangeFromOffsets(
  document: Document,
  textMap: VisibleTextMap,
  start: number,
  end: number,
): Range {
  const root = document.body ?? document.documentElement;
  if (root === null) throw new Error("the content document has no root element");
  const startBoundary = textMap.boundaries[start] ?? { node: root, offset: 0 };
  const endBoundary = textMap.boundaries[end] ?? startBoundary;
  const range = document.createRange();
  range.setStart(startBoundary.node, startBoundary.offset);
  range.setEnd(endBoundary.node, endBoundary.offset);
  return range;
}

export function sameRange(left: Range, right: Range): boolean {
  return (
    left.startContainer === right.startContainer &&
    left.startOffset === right.startOffset &&
    left.endContainer === right.endContainer &&
    left.endOffset === right.endOffset
  );
}

export function statusOnly(
  status: "not-found" | "ambiguous" | "conflicting-evidence" | "unsupported-evidence",
  message: string,
): DomLocatorResolution {
  return { range: null, status: { status, message } };
}
