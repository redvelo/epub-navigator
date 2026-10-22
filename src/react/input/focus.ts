import { currentDocument } from "../../runtime/kernel-view.js";
import type { VisibleOccurrenceRange } from "../../runtime/navigator/api.js";
import {
  navigationIntentAtom,
  releaseNavigationIntent,
  type NavigationIntent,
} from "../navigation/state.js";
import type { ReaderStore } from "../lib/store.js";
import type { NavigatorReaderPreferences } from "../public-types.js";

export function focusVisiblePrimaryPublicationFrame(container: HTMLElement): void {
  requestAnimationFrame(() => {
    const frame = visiblePrimaryPublicationFrame(container);
    const region = container.parentElement;
    const root = container.closest<HTMLElement>(".epub-navigator-reader");
    if (
      frame !== null &&
      region !== null &&
      root !== null &&
      shellOwnsKeyboardFocus(
        container.ownerDocument.activeElement,
        container.ownerDocument,
        root,
        region,
        container,
      )
    ) {
      frame.focus({ preventScroll: true });
    }
  });
}

export function activePublicationFrame(container: HTMLElement | null): HTMLIFrameElement | null {
  return (
    visiblePrimaryPublicationFrame(container) ??
    container?.querySelector<HTMLIFrameElement>('iframe:not([aria-hidden="true"]):not([inert])') ??
    null
  );
}

export function visiblePrimaryPublicationFrame(
  container: HTMLElement | null,
): HTMLIFrameElement | null {
  const frame =
    container?.querySelector<HTMLIFrameElement>(
      '[data-epub-navigator-roll-current="true"] iframe[data-epub-navigator-participant="primary"]:not([aria-hidden="true"]):not([inert])',
    ) ??
    container?.querySelector<HTMLIFrameElement>(
      'iframe[data-epub-navigator-participant="primary"]:not([aria-hidden="true"]):not([inert])',
    ) ??
    null;
  if (frame === null || frame.hidden || frame.closest("[inert]") !== null) return null;
  const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
  return style?.display === "none" || style?.visibility === "hidden" ? null : frame;
}

export function requestPublicationFocus(
  container: HTMLElement,
  store: ReaderStore,
  intent: NavigationIntent,
): void {
  if (intent.focusCancelled || intent.generation === null) {
    if (intent.focusCancelled) releaseNavigationIntent(store, intent);
    return;
  }
  const committed = currentDocument(intent.runtime.snapshot());
  if (committed?.generation !== intent.generation) return;
  requestAnimationFrame(() => {
    if (store.get(navigationIntentAtom) !== intent) return;
    const frame = visiblePrimaryPublicationFrame(container);
    if (frame === null || frame.dataset.epubNavigatorOccurrence !== String(intent.occurrence))
      return;
    const document = container.ownerDocument;
    const active = document.activeElement;
    const region = container.parentElement;
    const root = container.closest<HTMLElement>(".epub-navigator-reader");
    if (
      root === null ||
      region === null ||
      !shellOwnsKeyboardFocus(active, document, root, region, container)
    ) {
      store.set(navigationIntentAtom, null);
      return;
    }
    frame.focus({ preventScroll: true });
    releaseNavigationIntent(store, intent);
  });
}

export function shellOwnsKeyboardFocus(
  active: Element | null,
  document: Document,
  root: HTMLElement,
  region: HTMLElement,
  container: HTMLElement,
): boolean {
  if (active === null || active === document.body || active === document.documentElement) {
    const readers = document.querySelectorAll(".epub-navigator-reader[data-reader-state]");
    return readers.length === 1 && readers[0] === root;
  }
  if (active === root || active === region || active === container) return true;
  return active instanceof HTMLIFrameElement && container.contains(active);
}

export function sameVisibleOccurrenceRange(
  left: VisibleOccurrenceRange | null,
  right: VisibleOccurrenceRange | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.primaryOccurrence === right.primaryOccurrence &&
      left.firstOccurrence === right.firstOccurrence &&
      left.lastOccurrence === right.lastOccurrence &&
      (left.companion === right.companion ||
        (left.companion !== null &&
          right.companion !== null &&
          left.companion.occurrence === right.companion.occurrence &&
          left.companion.placement === right.companion.placement)))
  );
}

/**
 * What a key asks the reader to move, which is the same question the content agent answers for
 * the keys it sees first. A page key moves the text, an inline arrow moves along the reading
 * order, and vim's `h` and `l` leave the section outright.
 */
export type ShellKeyIntent = "section" | "inline" | "block";

export interface ShellKeyMovement {
  readonly direction: "forward" | "backward";
  readonly intent: ShellKeyIntent;
}

export function shellKeyDirection(
  key: string,
  shiftKey: boolean,
  keyboardMode: NavigatorReaderPreferences["keyboardMode"],
  writingMode: "horizontal-tb" | "vertical-rl" | "vertical-lr",
  progressionDirection: "ltr" | "rtl",
): ShellKeyMovement | null {
  if ((key === "PageDown" || key === " ") && !shiftKey) {
    return { direction: "forward", intent: "block" };
  }
  if (key === "PageUp" && !shiftKey) return { direction: "backward", intent: "block" };
  if (key === " " && shiftKey) return { direction: "backward", intent: "block" };
  if (shiftKey) return null;
  const forwardArrow =
    writingMode === "horizontal-tb"
      ? progressionDirection === "rtl"
        ? "ArrowLeft"
        : "ArrowRight"
      : progressionDirection === "rtl"
        ? "ArrowUp"
        : "ArrowDown";
  const backwardArrow =
    writingMode === "horizontal-tb"
      ? progressionDirection === "rtl"
        ? "ArrowRight"
        : "ArrowLeft"
      : progressionDirection === "rtl"
        ? "ArrowDown"
        : "ArrowUp";
  if (key === forwardArrow) return { direction: "forward", intent: "inline" };
  if (key === backwardArrow) return { direction: "backward", intent: "inline" };
  if (keyboardMode !== "vim") return null;
  if (key === "l") return { direction: "forward", intent: "section" };
  if (key === "h") return { direction: "backward", intent: "section" };
  if (key === "j") return { direction: "forward", intent: "block" };
  if (key === "k") return { direction: "backward", intent: "block" };
  return null;
}

export function parentOwnedPublicationEvent(
  target: EventTarget | null,
  region: HTMLElement,
  container: HTMLElement | null,
): boolean {
  if (target === region || (container !== null && target === container)) return true;
  return (
    container !== null &&
    target instanceof Element &&
    !(target instanceof HTMLIFrameElement) &&
    container.contains(target)
  );
}

export function editableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
