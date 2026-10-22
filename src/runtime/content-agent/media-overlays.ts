import type { PublicationTheme } from "../../generated/kernel.js";
import type {
  AgentMediaOverlayActiveAppliedMessage,
  AgentSetMediaOverlayActiveMessage,
} from "../agent-protocol/index.js";
import { decorationApiAvailable } from "./decorations.js";
import { isElement } from "./dom.js";

interface ClassChange {
  readonly element: Element;
  readonly added: readonly string[];
}

interface ClassTransition {
  readonly element: Element;
  readonly oldValue: string | null;
}

interface MediaOverlayState {
  active: ClassChange | null;
  playback: ClassChange | null;
  highlightName: string | null;
  style: HTMLStyleElement | SVGStyleElement | null;
  readonly removedStyles: Set<Node>;
}

interface Geometry {
  readonly root: readonly number[];
  readonly rects: readonly (readonly number[])[];
}

const states = new WeakMap<Document, MediaOverlayState>();
const ownedClassTransitions = new WeakMap<Element, (string | null)[]>();
const provenanceNeutralClassTransitions = new WeakMap<Element, (string | null)[]>();
const highlightName = `epub-navigator-media-overlay-${Math.random().toString(36).slice(2)}`;
const highlightBackground = "color-mix(in srgb, CanvasText 20%, transparent)";
const GEOMETRY_TOLERANCE_PX = 1;

export function setMediaOverlayActive(
  document: Document,
  message: Pick<
    AgentSetMediaOverlayActiveMessage,
    "fragment" | "activeClasses" | "playbackActiveClasses"
  >,
  theme: PublicationTheme,
): Pick<AgentMediaOverlayActiveAppliedMessage, "status" | "visible"> {
  const state = stateFor(document);
  const element = message.fragment === null ? null : document.getElementById(message.fragment);
  const measured = [state.active?.element, document.documentElement, element].filter(
    (item): item is Element => item !== null && item !== undefined,
  );
  const before = geometry(document, measured);
  const transitions: ClassTransition[] = [];

  transitions.push(...restore(state.active));
  state.active = null;
  clearHighlight(document, state);
  let result: Pick<AgentMediaOverlayActiveAppliedMessage, "status" | "visible">;
  if (message.fragment === null) {
    transitions.push(...restore(state.playback));
    state.playback = null;
    removeStyle(state);
    result = { status: "cleared", visible: false };
  } else {
    if (state.playback === null && message.playbackActiveClasses.length > 0) {
      state.playback = addClasses(
        document.documentElement,
        message.playbackActiveClasses,
        transitions,
      );
    }
    if (element === null) {
      result = { status: "missing", visible: false };
    } else if (message.activeClasses.length > 0) {
      ensureStyle(document, state, message.activeClasses, theme);
      state.active = addClasses(element, message.activeClasses, transitions);
      result = { status: "applied", visible: elementPlacement(element) === "visible" };
    } else if (decorationApiAvailable(document)) {
      const view = document.defaultView!;
      const range = document.createRange();
      range.selectNodeContents(element);
      view.CSS.highlights.set(highlightName, new view.Highlight(range));
      state.highlightName = highlightName;
      ensureStyle(document, state, [], theme);
      result = { status: "applied", visible: elementPlacement(element) === "visible" };
    } else {
      result = { status: "unsupported", visible: elementPlacement(element) === "visible" };
    }
  }

  // Class changes never alter authored content; only those that also move nothing skip reflow.
  const unmoved = sameGeometry(geometry(document, measured), before);
  for (const transition of transitions) {
    recordTransition(provenanceNeutralClassTransitions, transition);
    if (unmoved) recordTransition(ownedClassTransitions, transition);
  }
  return result;
}

export function findMediaOverlayEntry(
  document: Document,
  fragments: readonly string[],
): { readonly state: "found"; readonly index: number } | { readonly state: "none" } {
  let firstFollowing: number | null = null;
  for (const [index, fragment] of fragments.entries()) {
    const element = document.getElementById(fragment);
    if (element === null) continue;
    const placement = elementPlacement(element);
    if (placement === "visible") return { state: "found", index };
    if (placement === "following" && firstFollowing === null) firstFollowing = index;
  }
  return firstFollowing === null ? { state: "none" } : { state: "found", index: firstFollowing };
}

export function mediaOverlayMutationIsRuntimeOwned(
  document: Document,
  record: MutationRecord,
): boolean {
  if (record.type === "attributes") return consumeTransition(ownedClassTransitions, record);
  if (record.type !== "childList") return false;
  const state = states.get(document);
  if (state === undefined) return false;
  if (state.style !== null && record.target === state.style) return true;
  const changed = [...record.addedNodes, ...record.removedNodes];
  if (
    changed.length === 0 ||
    !changed.every((node) => node === state.style || state.removedStyles.has(node))
  ) {
    return false;
  }
  for (const node of record.removedNodes) state.removedStyles.delete(node);
  return true;
}

export function mediaOverlayMutationIsProvenanceNeutral(record: MutationRecord): boolean {
  return (
    record.type === "attributes" && consumeTransition(provenanceNeutralClassTransitions, record)
  );
}

function recordTransition(
  ledger: WeakMap<Element, (string | null)[]>,
  transition: ClassTransition,
): void {
  const pending = ledger.get(transition.element) ?? [];
  pending.push(transition.oldValue);
  ledger.set(transition.element, pending);
}

function consumeTransition(
  ledger: WeakMap<Element, (string | null)[]>,
  record: MutationRecord,
): boolean {
  if (record.attributeName !== "class" || !isElement(record.target)) return false;
  const pending = ledger.get(record.target);
  const index = pending?.indexOf(record.oldValue) ?? -1;
  if (pending === undefined || index < 0) return false;
  pending.splice(index, 1);
  return true;
}

function stateFor(document: Document): MediaOverlayState {
  let state = states.get(document);
  if (state === undefined) {
    state = {
      active: null,
      playback: null,
      highlightName: null,
      style: null,
      removedStyles: new Set(),
    };
    states.set(document, state);
  }
  return state;
}

function addClasses(
  element: Element,
  tokens: readonly string[],
  transitions: ClassTransition[],
): ClassChange {
  const added = [...new Set(tokens)].filter((token) => !element.classList.contains(token));
  if (added.length > 0) {
    transitions.push({ element, oldValue: element.getAttribute("class") });
    element.classList.add(...added);
  }
  return { element, added };
}

function restore(change: ClassChange | null): ClassTransition[] {
  if (change === null || change.added.length === 0) return [];
  const transition = { element: change.element, oldValue: change.element.getAttribute("class") };
  change.element.classList.remove(...change.added);
  return [transition];
}

function clearHighlight(document: Document, state: MediaOverlayState): void {
  if (state.highlightName === null) return;
  document.defaultView?.CSS.highlights.delete(state.highlightName);
  state.highlightName = null;
}

// An authored active-class background is opaque and knows nothing of the reader's palette, so
// a chosen theme replaces it with a translucent highlight that keeps themed text readable, the
// same trade the reader style makes for the authored page colours. The original theme asks for
// the publication as written, and there the authored highlight stands.
function ensureStyle(
  document: Document,
  state: MediaOverlayState,
  activeClasses: readonly string[],
  theme: PublicationTheme,
): void {
  const rules = [`::highlight(${highlightName}) { background-color: ${highlightBackground}; }`];
  if (activeClasses.length > 0 && theme !== "original") {
    const selectors = activeClasses.map((token) => `.${cssIdentifier(token)}`).join(", ");
    rules.push(`${selectors} { background-color: ${highlightBackground} !important; }`);
  }
  const text = rules.join("\n");
  if (state.style?.isConnected) {
    if (state.style.textContent !== text) state.style.textContent = text;
    return;
  }
  // An SVG document is not HTML: an element made without its namespace is inert there, and the
  // style belongs on the root because there is no head to put it in.
  const style = document.createElementNS(
    document.documentElement.namespaceURI ?? "http://www.w3.org/1999/xhtml",
    "style",
  ) as HTMLStyleElement | SVGStyleElement;
  style.setAttribute("data-epub-navigator-configuration", "media-overlays");
  style.textContent = text;
  state.style = style;
  (document.head ?? document.documentElement).append(style);
}

function removeStyle(state: MediaOverlayState): void {
  if (state.style === null) return;
  state.removedStyles.add(state.style);
  state.style.remove();
  state.style = null;
}

function cssIdentifier(value: string): string {
  return Array.from(value)
    .map((character, index) => {
      const leadingDigit =
        /[0-9]/u.test(character) && (index === 0 || (index === 1 && value.startsWith("-")));
      return /^[A-Za-z0-9_\--\u{10FFFF}]$/u.test(character) && !leadingDigit
        ? character
        : `\\${character.codePointAt(0)!.toString(16)} `;
    })
    .join("");
}

function geometry(document: Document, elements: readonly Element[]): Geometry {
  const root = document.documentElement;
  return {
    root: [root.scrollWidth, root.scrollHeight],
    rects: elements.flatMap((element) =>
      [...element.getClientRects()].map((rect) => [rect.left, rect.top, rect.width, rect.height]),
    ),
  };
}

function sameGeometry(left: Geometry, right: Geometry): boolean {
  const close = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length &&
    a.every((value, index) => Math.abs(value - b[index]!) <= GEOMETRY_TOLERANCE_PX);
  return (
    close(left.root, right.root) &&
    left.rects.length === right.rects.length &&
    left.rects.every((rect, index) => close(rect, right.rects[index]!))
  );
}

function elementPlacement(element: Element): "visible" | "preceding" | "following" {
  const view = element.ownerDocument.defaultView;
  const width = view?.innerWidth ?? 0;
  const height = view?.innerHeight ?? 0;
  const rects = [...element.getClientRects()];
  if (rects.length === 0) return "preceding";
  const intersects = rects.some(
    (rect) => rect.right > 0 && rect.left < width && rect.bottom > 0 && rect.top < height,
  );
  if (intersects) return "visible";
  const first = rects[0]!;
  return first.top >= height || first.left >= width ? "following" : "preceding";
}
