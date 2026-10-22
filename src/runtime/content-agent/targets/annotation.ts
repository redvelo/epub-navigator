import type {
  AnnotationSelectorNode,
  AnnotationTargetReconciliationResult,
} from "../../../generated/kernel.js";
import type { ContentAgentState } from "../state.js";
import { decorationStyleIsRuntimeOwned } from "../decorations.js";
import type { AnnotationTargetResolutionResult } from "./resolver/types.js";
import { isElement } from "../dom.js";

const maximumStyleBasisCodeUnits = 1024 * 1024;
const dynamicStyleStateSelector =
  ":hover,:active,:focus,:focus-within,:focus-visible,:checked,:indeterminate,:placeholder-shown,:valid,:invalid,:target";

export function annotationTargetResult(
  resource: string,
  resolution: AnnotationTargetResolutionResult,
): AnnotationTargetReconciliationResult {
  const segment =
    resolution.segmentKind === null ? null : { kind: resolution.segmentKind, resource };
  return {
    outcome: resolution.outcome,
    reports: resolution.reports.map((report) => ({
      path: [...report.path],
      kind: report.kind,
      outcome: report.outcome,
      matchCount: report.matchCount,
      segment: report.segmentKind === null ? null : { kind: report.segmentKind, resource },
      message: report.message ?? null,
    })),
    segment,
  };
}

export function unsupportedAnnotationTarget(
  selectors: readonly AnnotationSelectorNode[],
): AnnotationTargetResolutionResult {
  const reports = selectors.map((selector) => ({
    path: selector.path,
    kind: selector.kind,
    outcome: "unsupported" as const,
    matchCount: 0,
    segmentKind: null,
    message: "annotation selector execution requires reflowable XHTML",
  }));
  return { outcome: "unsupported", reports, segmentKind: null, range: null };
}

export function unavailableAnnotationTarget(
  selectors: readonly AnnotationSelectorNode[],
  message: string,
): AnnotationTargetResolutionResult {
  const reports = selectors.map((selector) => ({
    path: selector.path,
    kind: selector.kind,
    outcome: "unavailable" as const,
    matchCount: 0,
    segmentKind: null,
    message,
  }));
  return { outcome: "unavailable", reports, segmentKind: null, range: null };
}

export function captureDocumentStyleBasis(
  state: ContentAgentState,
  document: Document,
): string | null {
  let codeUnits = 0;
  const parts: string[] = [];
  const append = (value: unknown): boolean => {
    const text = String(value);
    codeUnits += text.length;
    if (codeUnits > maximumStyleBasisCodeUnits) return false;
    parts.push(`${text.length}:`, text);
    return true;
  };
  const sheets = new Set<CSSStyleSheet>([
    ...Array.from(document.styleSheets).filter(
      (sheet) => !decorationStyleIsRuntimeOwned(document, sheet.ownerNode),
    ),
    ...document.adoptedStyleSheets,
  ]);
  for (const sheet of sheets) {
    if (!append(sheet.href) || !append(sheet.disabled) || !append(sheet.media.mediaText))
      return null;
    try {
      for (const rule of sheet.cssRules) if (!append(rule.cssText)) return null;
    } catch {
      if (!append("opaque")) return null;
    }
  }
  try {
    if (!append(location.hash)) return null;
    for (const element of document.querySelectorAll(dynamicStyleStateSelector)) {
      let identity = state.layout.styleBasisElementIds.get(element);
      if (identity === undefined) {
        identity = ++state.layout.styleBasisElementSequence;
        state.layout.styleBasisElementIds.set(element, identity);
      }
      if (!append(identity)) return null;
    }
    if (document.fullscreenElement !== null) {
      let identity = state.layout.styleBasisElementIds.get(document.fullscreenElement);
      if (identity === undefined) {
        identity = ++state.layout.styleBasisElementSequence;
        state.layout.styleBasisElementIds.set(document.fullscreenElement, identity);
      }
      if (!append(identity)) return null;
    }
  } catch {
    return null;
  }
  if (typeof document.getAnimations === "function") {
    for (const animation of document.getAnimations()) {
      if (
        !append(animation.id) ||
        !append(animation.playState) ||
        !append(animation.currentTime) ||
        !append(animation.playbackRate)
      ) {
        return null;
      }
    }
  }
  if (!append(sheets.size)) return null;
  return parts.join("");
}

export function captureRangeScrollRollback(document: Document, range: Range): () => void {
  const elements = new Set<Element>();
  if (document.scrollingElement !== null) elements.add(document.scrollingElement);
  let element = isElement(range.startContainer)
    ? range.startContainer
    : range.startContainer.parentElement;
  while (element !== null) {
    elements.add(element);
    element = element.parentElement;
  }
  const positions = [...elements].map((element) => ({
    element,
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  return () => {
    for (const position of positions) {
      position.element.scrollLeft = position.left;
      position.element.scrollTop = position.top;
    }
  };
}
