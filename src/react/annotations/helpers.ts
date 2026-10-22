import type { NavigatorBookmarkAnnotationRecord } from "../../annotations.js";
import type {
  AnnotationRangeAdjustmentOutcome,
  AnnotationTargetGenerationOutcome,
  NavigatorLocation,
  ReaderViewportAnchor,
} from "../../generated/kernel.js";
import type { MountedPublication } from "../../publication.js";
import type { SelectionToolbarRect } from "../selection-toolbar.js";

export function bookmarkOccurrenceHint(
  facts: MountedPublication["facts"],
  record: NavigatorBookmarkAnnotationRecord,
): { readonly occurrence: number; readonly resource: string } | null {
  const occurrence = facts.resources.readingOrder[record.occurrence];
  if (occurrence === undefined || occurrence.resource === null) return null;
  const resource = facts.resources.resources[occurrence.resource];
  if (resource?.address.kind !== "local") return null;
  return { occurrence: record.occurrence, resource: resource.address.value };
}

export function selectionExactText(location: NavigatorLocation): string | null {
  if (location.kind !== "range") return null;
  const quote = location.evidence.find((evidence) => evidence.kind === "rendered-text-quote");
  return quote === undefined || quote.exact.length === 0 ? null : quote.exact;
}

export function selectionExcerpt(location: NavigatorLocation): string | null {
  const exact = selectionExactText(location);
  if (exact === null) return null;
  const codePoints = Array.from(exact).slice(0, 512);
  while (codePoints.length > 0 && new TextEncoder().encode(codePoints.join("")).length > 2_048) {
    codePoints.pop();
  }
  return codePoints.join("") || null;
}

export async function writeClipboardText(text: string): Promise<void> {
  let clipboardFailure: unknown = null;
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (cause) {
      clipboardFailure = cause;
    }
  }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;inset:0 auto auto -10000px;opacity:0";
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    active?.focus({ preventScroll: true });
  }
  if (copied) return;
  if (clipboardFailure instanceof Error) throw clipboardFailure;
  throw new Error("Clipboard access is unavailable.");
}

export function noteTextError(text: string): string | null {
  if (!/\S/u.test(text)) return "Enter note text before saving.";
  if (Array.from(text).length > 4_096) return "Note text must be 4,096 characters or fewer.";
  if (new TextEncoder().encode(text).length > 16_384) {
    return "Note text must be 16 KiB or smaller when encoded as UTF-8.";
  }
  return null;
}

export function selectionToolbarRects(
  anchor: ReaderViewportAnchor,
  frameHost: HTMLElement | null,
): {
  readonly anchorRect: SelectionToolbarRect;
  readonly clippingRect: SelectionToolbarRect;
} | null {
  if (frameHost === null) return null;
  const view = frameHost.ownerDocument.defaultView;
  if (view === null) return null;
  const host = frameHost.getBoundingClientRect();
  const offsetX = host.left - (view.visualViewport?.offsetLeft ?? 0);
  const offsetY = host.top - (view.visualViewport?.offsetTop ?? 0);
  const convert = (rect: ReaderViewportAnchor["rect"]): SelectionToolbarRect | null => {
    const { x, y, width, height } = rect;
    if (
      x === null ||
      y === null ||
      width === null ||
      height === null ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 0 ||
      height < 0
    ) {
      return null;
    }
    return {
      left: x - offsetX,
      top: y - offsetY,
      right: x - offsetX + width,
      bottom: y - offsetY + height,
    };
  };
  const anchorRect = convert(anchor.rect);
  const clippingRect = convert(anchor.clippingRect);
  return anchorRect === null || clippingRect === null ? null : { anchorRect, clippingRect };
}

export function highlightGenerationFailureMessage(
  status: AnnotationTargetGenerationOutcome["status"],
): string {
  switch (status) {
    case "unavailable":
      return "This selection cannot be mapped reliably to authored publication content.";
    case "unsupported":
      return "Highlights are not supported for this selection.";
    case "ambiguous":
      return "This selection matches more than one authored range.";
    case "conflict":
      return "The selection evidence identifies conflicting authored ranges.";
    case "stale":
      return "The publication changed before the highlight could be created.";
    case "failed":
      return "The highlight target could not be generated.";
    case "generated":
      return "The highlight target was generated.";
  }
}

export function bookmarkGenerationFailureMessage(
  outcome: Exclude<AnnotationTargetGenerationOutcome, { readonly status: "generated" }>,
): string {
  switch (outcome.status) {
    case "unavailable":
      return "The current location cannot be mapped reliably to authored publication content.";
    case "unsupported":
      return "Bookmarks are not supported at the current location.";
    case "ambiguous":
    case "conflict":
      return "The current location could not be identified unambiguously.";
    case "stale":
      return "The publication location changed before the bookmark could be created.";
    case "failed":
      return outcome.message ?? "The bookmark target could not be generated.";
  }
}

export function annotationRangeAdjustmentFailureMessage(
  outcome: Exclude<AnnotationRangeAdjustmentOutcome, { readonly status: "adjusted" }>,
): string {
  switch (outcome.status) {
    case "unavailable":
      return outcome.reason === "decoration-not-rendered"
        ? "This annotation is not currently rendered."
        : outcome.reason === "no-exact-movement"
          ? "The annotation edge cannot move another complete word in that direction."
          : "An exact authored range could not be generated for this adjustment.";
    case "unsupported":
      return "Range adjustment is unavailable for this publication content.";
    case "stale":
      return "The publication layout changed during range adjustment. Try again.";
    case "ambiguous":
    case "conflict":
      return "The adjusted range could not be identified unambiguously.";
    case "failed":
      return outcome.message ?? "The annotation range could not be adjusted.";
  }
}
