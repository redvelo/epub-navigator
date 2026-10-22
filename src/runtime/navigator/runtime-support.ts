import { type ReaderConfiguration } from "./api.js";
import type {
  ActiveDocumentParticipant,
  AnnotationSelectorExecutionReport,
  AnnotationSelectorNode,
  DocumentAdapter,
  LayoutOwner,
  LayoutRequest,
} from "../../generated/kernel.js";
import { NavigatorError } from "../../runtime.js";
import { buildAgentRequest } from "../agent-protocol/index.js";
import type { AdapterLayoutSettlement } from "../../generated/kernel.js";

export function annotationSelectorMap(
  selectors: readonly AnnotationSelectorNode[],
  result = new Map<string, string>(),
): ReadonlyMap<string, string> {
  for (const selector of selectors) {
    result.set(selector.path.join("."), selector.kind);
    annotationSelectorMap(selector.refinements, result);
  }
  return result;
}

export function annotationReportsMatch(
  expected: ReadonlyMap<string, string> | null,
  reports: readonly AnnotationSelectorExecutionReport[],
): boolean {
  if (expected === null) return false;
  return reports.every((report) => expected.get(report.path.join(".")) === report.kind);
}

export function tocOperationAbortError(): DOMException {
  return new DOMException("the TOC target measurement was cancelled", "AbortError");
}

export function copyConfiguration(configuration: ReaderConfiguration): ReaderConfiguration {
  const { appearance, input } = configuration;
  if (
    (appearance.rootScrollbar !== "publisher" && appearance.rootScrollbar !== "hidden") ||
    (appearance.decorations !== undefined &&
      appearance.decorations !== "standard" &&
      appearance.decorations !== "monochrome") ||
    (input.keyboardMode !== "off" &&
      input.keyboardMode !== "standard" &&
      input.keyboardMode !== "vim") ||
    typeof input.touchZones !== "boolean" ||
    (input.clickZones !== undefined && typeof input.clickZones !== "boolean") ||
    (input.progressionDirection !== "ltr" && input.progressionDirection !== "rtl") ||
    (input.selectionMenu !== "native" && input.selectionMenu !== "reader")
  ) {
    throw new TypeError("invalid Navigator reader configuration");
  }
  return {
    appearance: { ...appearance },
    input: { ...input },
  };
}

export function buildAgentLayoutRequest(
  session: string,
  operation: number,
  request: LayoutRequest,
): ReturnType<typeof buildAgentRequest> {
  return buildAgentRequest(session, operation, request);
}

export function adapterSettlementPageCount(settlement: AdapterLayoutSettlement): number | null {
  if (isFixedAdapter(settlement.adapter)) return 1;
  return settlement.settlement.mode === "paginated" ? settlement.settlement.pages.pageCount : null;
}

export function isFixedAdapter(
  adapter: DocumentAdapter,
): adapter is "fixed-xhtml" | "fixed-svg" | "fixed-image" {
  return adapter === "fixed-xhtml" || adapter === "fixed-svg" || adapter === "fixed-image";
}

export function layoutOwnerParticipant(owner: LayoutOwner): ActiveDocumentParticipant | null {
  if (owner.kind === "prepared-frame" || (owner.kind === "document" && owner.phase === "initial")) {
    return null;
  }
  return owner.kind === "document"
    ? { kind: "primary", documentGeneration: owner.documentGeneration }
    : {
        kind: "fixed-companion",
        ownerDocumentGeneration: owner.ownerDocumentGeneration,
        frameGeneration: owner.frameGeneration,
      };
}

export function participantsEqual(
  left: ActiveDocumentParticipant | null,
  right: ActiveDocumentParticipant | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "primary" || right.kind === "primary") {
    return (
      left.kind === "primary" &&
      right.kind === "primary" &&
      left.documentGeneration === right.documentGeneration
    );
  }
  return (
    left.ownerDocumentGeneration === right.ownerDocumentGeneration &&
    left.frameGeneration === right.frameGeneration
  );
}

export function intersectRectangles(
  left: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  right: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const endX = Math.max(x, Math.min(left.x + left.width, right.x + right.width));
  const endY = Math.max(y, Math.min(left.y + left.height, right.y + right.height));
  return { x, y, width: endX - x, height: endY - y };
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function isExpectedBoundaryFailure(cause: unknown, closed: boolean): boolean {
  if (!(cause instanceof NavigatorError)) return false;
  return (
    cause.failure.code === "stale-observation" ||
    cause.failure.code === "stale-agent-operation-observation" ||
    (closed && cause.failure.code === "kernel-closed")
  );
}
