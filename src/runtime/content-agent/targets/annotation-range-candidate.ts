import type { PointEvidence, RangeEvidence } from "../../../generated/kernel.js";
import { mediaOverlayMutationIsProvenanceNeutral } from "../media-overlays.js";
import { resolveAnnotationTargetInDocument } from "./resolver/annotation.js";
import { resolveLocatorInDocument } from "./resolver/locator.js";
import {
  createDocumentTextSnapshot,
  documentTextGeneration,
  documentTextSnapshotIsCurrent,
  mapElementToDocumentText,
  mapRangeToDocumentText,
} from "./resolver/text-index.js";
import type { AnnotationSelectorNode } from "./resolver/types.js";
import { ANNOTATION_RESOLUTION_YIELD_WORK_UNITS } from "./resolver/types.js";
import { isElement } from "../dom.js";

const runtimeOwnedElementSelector =
  "[data-epub-navigator-configuration], [data-epub-navigator-reader-font]";
const runtimeAttributePrefix = "data-epub-navigator-";
const executableElementSelector = "script, iframe, object, embed";
const executableUrlAttributes = new Set(["href", "src", "action", "formaction", "xlink:href"]);

export interface AnnotationRangeContentBasis {
  readonly expectedDocumentTextGeneration: number;
  readonly isCurrent: () => boolean;
}

export type AnnotationRangeSource =
  | { readonly range: Range }
  | { readonly evidence: readonly RangeEvidence[] };

export interface VerifiedAnnotationRangeCandidate {
  readonly css: {
    readonly value: string;
    readonly start: string;
    readonly end: string;
  } | null;
  readonly document: {
    readonly start: string;
    readonly end: string;
  } | null;
  readonly textFragment?: string;
}

export type AnnotationRangeCandidateResult =
  | { readonly status: "generated"; readonly candidate: VerifiedAnnotationRangeCandidate }
  | { readonly status: "unavailable"; readonly reason: "not-authored" | "no-exact-selector" }
  | { readonly status: "unsupported" }
  | { readonly status: "ambiguous" }
  | { readonly status: "conflict" }
  | { readonly status: "stale" }
  | { readonly status: "failed"; readonly message: string | null };

export interface VerifiedAnnotationPointCandidate {
  readonly css: { readonly value: string; readonly offset: string } | null;
  readonly document: { readonly offset: string } | null;
}

export type AnnotationPointCandidateResult =
  | { readonly status: "generated"; readonly candidate: VerifiedAnnotationPointCandidate }
  | Exclude<AnnotationRangeCandidateResult, { readonly status: "generated" }>;

export interface AnnotationAuthoredProvenanceTracker {
  readonly document: Document;
  readonly finalized: boolean;
  readonly hasExecutableContent: boolean;
  readonly documentPositionStable: boolean;
  finalize(): void;
  disconnect(): void;
  isAuthored(node: Node): boolean;
  siblingPosition(element: Element): number | null;
}

/**
 * Starts an authored-DOM baseline before publisher scripts run. Pre-DOMContentLoaded
 * parser additions are accepted only when the completed document has no executable surface.
 */
export function createAnnotationAuthoredProvenanceTracker(
  document: Document,
): AnnotationAuthoredProvenanceTracker {
  let finalized = false;
  let hasExecutableContent = false;
  let documentPositionStable = false;
  let authoredNodes = new WeakSet<Node>();
  let authoredSiblingPositions = new WeakMap<Element, number>();
  const taintedNodes = new WeakSet<Node>();
  const injectedScript = document.currentScript;
  const view = document.defaultView;
  const Observer = view?.MutationObserver ?? globalThis.MutationObserver;

  const markTainted = (node: Node): void => {
    taintedNodes.add(node);
    for (const descendant of node.childNodes) markTainted(descendant);
  };
  const isRuntimeOwned = (node: Node): boolean => {
    const element = isElement(node) ? node : (node.parentElement ?? node.parentNode?.parentElement);
    return (
      element !== null &&
      element !== undefined &&
      element.closest(runtimeOwnedElementSelector) !== null
    );
  };
  const processRecords = (records: MutationRecord[]): void => {
    if (!finalized) return;
    for (const record of records) {
      if (isRuntimeOwned(record.target)) continue;
      if (
        record.type === "attributes" &&
        record.attributeName?.startsWith(runtimeAttributePrefix) === true
      ) {
        continue;
      }
      if (mediaOverlayMutationIsProvenanceNeutral(record)) continue;
      if (record.type === "childList") {
        const changed = [...record.addedNodes, ...record.removedNodes].filter(
          (node) => !isElement(node) || !node.matches(runtimeOwnedElementSelector),
        );
        if (changed.length === 0) continue;
        documentPositionStable = false;
        for (const node of changed) markTainted(node);
      } else {
        documentPositionStable = false;
        markTainted(record.target);
      }
    }
  };
  const observer = new Observer(processRecords);
  observer.observe(document, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    childList: true,
    subtree: true,
  });

  const containsExecutableContent = (): boolean => {
    for (const element of document.querySelectorAll(executableElementSelector)) {
      if (element !== injectedScript && !element.matches(runtimeOwnedElementSelector)) return true;
    }
    for (const element of document.querySelectorAll("*")) {
      if (element === injectedScript || element.matches(runtimeOwnedElementSelector)) continue;
      for (const attribute of element.attributes) {
        const name = attribute.localName.toLowerCase();
        if (name.startsWith("on")) return true;
        if (
          executableUrlAttributes.has(name) &&
          attribute.value.trimStart().toLowerCase().startsWith("javascript:")
        ) {
          return true;
        }
      }
    }
    return false;
  };
  const finalize = (): void => {
    if (finalized) return;
    observer.takeRecords();
    hasExecutableContent = containsExecutableContent();
    authoredNodes = new WeakSet<Node>();
    authoredSiblingPositions = new WeakMap<Element, number>();
    const visit = (node: Node): void => {
      if (
        node === injectedScript ||
        (isElement(node) && node.matches(runtimeOwnedElementSelector))
      ) {
        return;
      }
      authoredNodes.add(node);
      const siblingCounts = new Map<string, number>();
      for (const child of node.childNodes) visit(child);
      for (const child of node.childNodes) {
        if (!isElement(child) || !authoredNodes.has(child)) continue;
        const element = child;
        const key = `${element.namespaceURI ?? ""}\u0000${element.localName}`;
        const position = (siblingCounts.get(key) ?? 0) + 1;
        siblingCounts.set(key, position);
        authoredSiblingPositions.set(element, position);
      }
    };
    visit(document);
    finalized = true;
    documentPositionStable = true;
  };
  const onContentLoaded = (): void => finalize();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onContentLoaded, { once: true });
  }

  return {
    document,
    get finalized() {
      return finalized;
    },
    get hasExecutableContent() {
      return hasExecutableContent;
    },
    get documentPositionStable() {
      processRecords(observer.takeRecords());
      return documentPositionStable;
    },
    finalize,
    disconnect() {
      observer.disconnect();
      document.removeEventListener("DOMContentLoaded", onContentLoaded);
    },
    isAuthored(node: Node) {
      processRecords(observer.takeRecords());
      return finalized && authoredNodes.has(node) && !taintedNodes.has(node);
    },
    siblingPosition(element: Element) {
      processRecords(observer.takeRecords());
      return finalized && authoredNodes.has(element) && !taintedNodes.has(element)
        ? (authoredSiblingPositions.get(element) ?? null)
        : null;
    },
  };
}

/** Generates only candidates that round-trip through the existing annotation resolver. */
export async function generateVerifiedAnnotationRangeCandidate(
  document: Document,
  source: AnnotationRangeSource,
  provenance: AnnotationAuthoredProvenanceTracker,
  basis: AnnotationRangeContentBasis,
  exactTextFragmentPermitted: boolean,
): Promise<AnnotationRangeCandidateResult> {
  if (
    provenance.document !== document ||
    !provenance.finalized ||
    !basis.isCurrent() ||
    documentTextGeneration(document) !== basis.expectedDocumentTextGeneration
  ) {
    return { status: "stale" };
  }
  if (provenance.hasExecutableContent) return { status: "unavailable", reason: "not-authored" };
  if (
    document.body === null ||
    document.documentElement?.localName.toLowerCase() !== "html" ||
    document.documentElement.namespaceURI !== "http://www.w3.org/1999/xhtml"
  ) {
    return { status: "unsupported" };
  }

  try {
    const resolved =
      "range" in source ? { range: source.range } : resolveEvidence(document, source);
    if ("result" in resolved) return resolved.result;
    const range = resolved.range.cloneRange();
    if (
      range.collapsed ||
      range.startContainer.ownerDocument !== document ||
      range.endContainer.ownerDocument !== document ||
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected
    ) {
      return { status: "unsupported" };
    }
    if (!rangeIsAuthored(range, provenance))
      return { status: "unavailable", reason: "not-authored" };

    const snapshot = createDocumentTextSnapshot(document);
    const mapping = mapRangeToDocumentText(document, range, snapshot);
    if (mapping === null || mapping.start >= mapping.end) return { status: "unsupported" };
    if (!basisIsCurrent(document, basis, snapshot)) return { status: "stale" };

    let documentVerification: Verification = "unsupported";
    let documentCandidate: VerifiedAnnotationRangeCandidate["document"] = null;
    if (provenance.documentPositionStable) {
      documentVerification = await verifyPlan(
        document,
        documentSelectorPlan(mapping.codePointStart, mapping.codePointEnd),
        range,
        snapshot,
        basis,
      );
      if (documentVerification === "stale") return { status: "stale" };
      if (documentVerification === "verified") {
        documentCandidate = { start: mapping.codePointStart, end: mapping.codePointEnd };
      }
    }

    let cssCandidate: VerifiedAnnotationRangeCandidate["css"] = null;
    const scope = preferredAuthoredScope(document, range, mapping, snapshot, provenance);
    if (scope !== null) {
      const scopeMapping = mapElementToDocumentText(document, scope.element, snapshot);
      if (
        scopeMapping !== null &&
        mapping.start >= scopeMapping.start &&
        mapping.end <= scopeMapping.end
      ) {
        const start = codePointLength(
          scopeMapping.exact.slice(0, mapping.start - scopeMapping.start),
        );
        const end = codePointLength(scopeMapping.exact.slice(0, mapping.end - scopeMapping.start));
        const cssVerification = await verifyPlan(
          document,
          selectorPlan(scope.selector, start, end),
          range,
          snapshot,
          basis,
        );
        if (cssVerification === "stale") return { status: "stale" };
        if (cssVerification === "verified") {
          cssCandidate = { value: scope.selector, start, end };
        }
      }
    }

    let textFragment: string | undefined;
    if (exactTextFragmentPermitted && mapping.exact.length > 0) {
      const directive = `text=${encodeURIComponent(mapping.exact)}`;
      const fragmentPlan: { selectors: AnnotationSelectorNode[] } = {
        selectors: [
          {
            kind: "text-fragment",
            path: [0],
            values: { value: directive },
            refinements: [],
          },
        ],
      };
      if ((await verifyPlan(document, fragmentPlan, range, snapshot, basis)) === "verified") {
        textFragment = directive;
      }
    }
    if (!basisIsCurrent(document, basis, snapshot)) return { status: "stale" };
    if (cssCandidate === null && documentCandidate === null) {
      return { status: "unavailable", reason: "no-exact-selector" };
    }
    return {
      status: "generated",
      candidate: {
        css: cssCandidate,
        document: documentCandidate,
        ...(textFragment === undefined ? {} : { textFragment }),
      },
    };
  } catch (cause) {
    if (!basis.isCurrent()) return { status: "stale" };
    return { status: "failed", message: cause instanceof Error ? cause.message : null };
  }
}

/** Generates a collapsed authored point and verifies every emitted selector on the same basis. */
export async function generateVerifiedAnnotationPointCandidate(
  document: Document,
  evidence: readonly PointEvidence[],
  provenance: AnnotationAuthoredProvenanceTracker,
  basis: AnnotationRangeContentBasis,
): Promise<AnnotationPointCandidateResult> {
  if (
    provenance.document !== document ||
    !provenance.finalized ||
    !basis.isCurrent() ||
    documentTextGeneration(document) !== basis.expectedDocumentTextGeneration
  ) {
    return { status: "stale" };
  }
  if (provenance.hasExecutableContent) return { status: "unavailable", reason: "not-authored" };
  if (
    document.body === null ||
    document.documentElement?.localName.toLowerCase() !== "html" ||
    document.documentElement.namespaceURI !== "http://www.w3.org/1999/xhtml"
  ) {
    return { status: "unsupported" };
  }
  try {
    const resolution = resolveLocatorInDocument(document, {
      kind: "point",
      evidence: [...evidence],
    });
    if (resolution.range === null) {
      if (resolution.status.status === "ambiguous") return { status: "ambiguous" };
      if (resolution.status.status === "conflicting-evidence") return { status: "conflict" };
      if (resolution.status.status === "unsupported-evidence") return { status: "unsupported" };
      if (resolution.status.status === "failed") {
        return { status: "failed", message: resolution.status.message };
      }
      return { status: "unavailable", reason: "no-exact-selector" };
    }
    const point = resolution.range.cloneRange();
    point.collapse(true);
    if (!point.startContainer.isConnected || !rangeIsAuthored(point, provenance)) {
      return { status: "unavailable", reason: "not-authored" };
    }
    const snapshot = createDocumentTextSnapshot(document);
    const mapping = mapRangeToDocumentText(document, point, snapshot);
    if (mapping === null || mapping.start !== mapping.end) return { status: "unsupported" };
    if (!basisIsCurrent(document, basis, snapshot)) return { status: "stale" };

    let documentCandidate: VerifiedAnnotationPointCandidate["document"] = null;
    if (provenance.documentPositionStable) {
      const verification = await verifyPlan(
        document,
        documentSelectorPlan(mapping.codePointStart, mapping.codePointStart),
        point,
        snapshot,
        basis,
      );
      if (verification === "stale") return { status: "stale" };
      if (verification === "verified") documentCandidate = { offset: mapping.codePointStart };
    }

    let cssCandidate: VerifiedAnnotationPointCandidate["css"] = null;
    const scope = preferredAuthoredScope(document, point, mapping, snapshot, provenance);
    if (scope !== null) {
      const scopeMapping = mapElementToDocumentText(document, scope.element, snapshot);
      if (
        scopeMapping !== null &&
        mapping.start >= scopeMapping.start &&
        mapping.end <= scopeMapping.end
      ) {
        const offset = codePointLength(
          scopeMapping.exact.slice(0, mapping.start - scopeMapping.start),
        );
        const verification = await verifyPlan(
          document,
          selectorPlan(scope.selector, offset, offset),
          point,
          snapshot,
          basis,
        );
        if (verification === "stale") return { status: "stale" };
        if (verification === "verified") cssCandidate = { value: scope.selector, offset };
      }
    }
    if (!basisIsCurrent(document, basis, snapshot)) return { status: "stale" };
    if (cssCandidate === null && documentCandidate === null) {
      return { status: "unavailable", reason: "no-exact-selector" };
    }
    return { status: "generated", candidate: { css: cssCandidate, document: documentCandidate } };
  } catch (cause) {
    return basis.isCurrent()
      ? { status: "failed", message: cause instanceof Error ? cause.message : null }
      : { status: "stale" };
  }
}

function resolveEvidence(
  document: Document,
  source: Extract<AnnotationRangeSource, { evidence: readonly RangeEvidence[] }>,
): { range: Range } | { result: AnnotationRangeCandidateResult } {
  const resolution = resolveLocatorInDocument(document, {
    kind: "range",
    evidence: [...source.evidence],
  });
  if (resolution.range !== null) return { range: resolution.range };
  if (resolution.status.status === "ambiguous") return { result: { status: "ambiguous" } };
  if (resolution.status.status === "conflicting-evidence")
    return { result: { status: "conflict" } };
  if (resolution.status.status === "unsupported-evidence") {
    return { result: { status: "unsupported" } };
  }
  if (resolution.status.status === "failed") {
    return { result: { status: "failed", message: resolution.status.message } };
  }
  return { result: { status: "unavailable", reason: "no-exact-selector" } };
}

function rangeIsAuthored(range: Range, provenance: AnnotationAuthoredProvenanceTracker): boolean {
  const common = range.commonAncestorContainer;
  for (let ancestor: Node | null = common; ancestor !== null; ancestor = ancestor.parentNode) {
    if (!provenance.isAuthored(ancestor)) return false;
    if (isElement(ancestor) && ancestor.matches(runtimeOwnedElementSelector)) return false;
  }
  const walker = range.startContainer.ownerDocument?.createTreeWalker(
    common,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  if (walker === undefined) return false;
  let node: Node | null = common;
  while (node !== null) {
    let intersects = false;
    try {
      intersects = range.intersectsNode(node);
    } catch {
      return false;
    }
    if (intersects && !provenance.isAuthored(node)) return false;
    if (intersects && isElement(node) && node.matches(runtimeOwnedElementSelector)) {
      return false;
    }
    node = walker.nextNode();
  }
  return true;
}

function preferredAuthoredScope(
  document: Document,
  range: Range,
  mapping: NonNullable<ReturnType<typeof mapRangeToDocumentText>>,
  snapshot: ReturnType<typeof createDocumentTextSnapshot>,
  provenance: AnnotationAuthoredProvenanceTracker,
): { element: Element; selector: string } | null {
  const commonElement = isElement(range.commonAncestorContainer)
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  let fallback = commonElement;
  const root = document.body ?? document.documentElement;
  if (root !== null) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node: Node | null = root; node !== null; node = walker.nextNode()) {
      if (!isElement(node)) continue;
      const candidateMapping = mapElementToDocumentText(document, node, snapshot);
      if (
        candidateMapping !== null &&
        candidateMapping.start <= mapping.start &&
        candidateMapping.end >= mapping.end &&
        (fallback === null || fallback.contains(node))
      ) {
        fallback = node;
      }
    }
  }
  let element = fallback;
  while (element !== null) {
    if (provenance.isAuthored(element) && authoredUniqueIdSelector(document, element) !== null) {
      return { element, selector: authoredUniqueIdSelector(document, element)! };
    }
    element = element.parentElement;
  }
  if (fallback === null || !provenance.isAuthored(fallback)) return null;
  const selector = structuralSelector(fallback, provenance);
  if (selector === null) return null;
  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === fallback ? { element: fallback, selector } : null;
  } catch {
    return null;
  }
}

function authoredUniqueIdSelector(document: Document, element: Element): string | null {
  if (element.id.length === 0) return null;
  const selector = `#${escapeCssIdentifier(element.id)}`;
  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element ? selector : null;
  } catch {
    return null;
  }
}

function structuralSelector(
  element: Element,
  provenance: AnnotationAuthoredProvenanceTracker,
): string | null {
  const parts: string[] = [];
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    const position = provenance.siblingPosition(current);
    if (position === null) return null;
    parts.push(`${escapeCssIdentifier(current.localName)}:nth-of-type(${position})`);
  }
  return parts.reverse().join(" > ");
}

function escapeCssIdentifier(value: string): string {
  let escaped = "";
  let index = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const digit = character >= "0" && character <= "9";
    if (codePoint === 0) {
      escaped += "\ufffd";
      index += 1;
      continue;
    }
    if (
      (codePoint >= 0x01 && codePoint <= 0x1f) ||
      codePoint === 0x7f ||
      (index === 0 && digit) ||
      (index === 1 && value[0] === "-" && digit)
    ) {
      escaped += `\\${codePoint.toString(16)} `;
      index += 1;
      continue;
    }
    if (index === 0 && character === "-" && value.length === 1) {
      escaped += "\\-";
      index += 1;
      continue;
    }
    const safe =
      codePoint >= 0x80 ||
      character === "-" ||
      character === "_" ||
      digit ||
      (character >= "A" && character <= "Z") ||
      (character >= "a" && character <= "z");
    escaped += safe ? character : `\\${character}`;
    index += 1;
  }
  return escaped;
}

function selectorPlan(
  cssSelector: string,
  start: string,
  end: string,
): { selectors: AnnotationSelectorNode[] } {
  const refinement: AnnotationSelectorNode = {
    kind: "text-position",
    path: [0, 0],
    values: { start, end },
    refinements: [],
  };
  return {
    selectors: [
      {
        kind: "css",
        path: [0],
        values: { value: cssSelector },
        refinements: [refinement],
      },
    ],
  };
}

function documentSelectorPlan(start: string, end: string): { selectors: AnnotationSelectorNode[] } {
  return {
    selectors: [
      {
        kind: "text-position",
        path: [0],
        values: { start, end },
        refinements: [],
      },
    ],
  };
}

type Verification = "verified" | "ambiguous" | "conflict" | "stale" | "unsupported" | "failed";

async function verifyPlan(
  document: Document,
  plan: { selectors: AnnotationSelectorNode[] },
  expected: Range,
  snapshot: ReturnType<typeof createDocumentTextSnapshot>,
  basis: AnnotationRangeContentBasis,
): Promise<Verification> {
  const result = await resolveAnnotationTargetInDocument(
    document,
    plan,
    {
      signal: new AbortController().signal,
      maximumWorkUnits: 8_000_000,
      yieldEveryWorkUnits: ANNOTATION_RESOLUTION_YIELD_WORK_UNITS,
      isCurrent: () => basisIsCurrent(document, basis, snapshot),
    },
    snapshot,
  );
  if (result.outcome !== "resolved" || result.range === null) {
    if (result.outcome === "ambiguous") return "ambiguous";
    if (result.outcome === "conflict") return "conflict";
    if (result.outcome === "stale") return "stale";
    if (result.outcome === "unsupported") return "unsupported";
    return "failed";
  }
  const actualMapping = mapRangeToDocumentText(document, result.range, snapshot);
  const expectedMapping = mapRangeToDocumentText(document, expected, snapshot);
  return actualMapping !== null &&
    expectedMapping !== null &&
    actualMapping.start === expectedMapping.start &&
    actualMapping.end === expectedMapping.end
    ? "verified"
    : "conflict";
}

function basisIsCurrent(
  document: Document,
  basis: AnnotationRangeContentBasis,
  snapshot: ReturnType<typeof createDocumentTextSnapshot>,
): boolean {
  return (
    basis.isCurrent() &&
    documentTextGeneration(document) === basis.expectedDocumentTextGeneration &&
    documentTextSnapshotIsCurrent(snapshot)
  );
}

function codePointLength(value: string): string {
  let length = 0;
  for (const _character of value) length += 1;
  return String(length);
}
