import type {
  AgentActivationMessage,
  AgentDecorationActivationMessage,
  AgentFootnoteReturnedMessage,
  AgentFormSubmissionMessage,
} from "../../agent-protocol/index.js";
import type { ContentAgentState } from "../state.js";
import { CONTENT_AGENT_NAMESPACE } from "../../agent-protocol/index.js";
import type { OutboundMessageInput } from "../transport.js";
import { post } from "../transport.js";
import { anchorFromEvent, authoredHref } from "./links.js";
import {
  activeDecorationProjectionRevision,
  decorationsAtPoint,
  setActiveDecoration,
} from "../decorations.js";
import {
  capturePointAtElementStartInDocument,
  relocateLocatorInDocument,
  resolvePointEvidenceInDocument,
} from "../targets/resolver/locator.js";
import { scheduleSelectionSignal } from "../selection/controller.js";
import type { PointEvidence } from "../../../generated/kernel.js";

export const epubNamespace = "http://www.idpf.org/2007/ops";

export function hasSemanticToken(
  state: ContentAgentState,
  element: Element,
  attribute: "type" | "role",
  token: string,
): boolean {
  void state;
  const value =
    attribute === "type"
      ? (element.getAttributeNS(epubNamespace, "type") ?? element.getAttribute("epub:type"))
      : element.getAttribute("role");
  return value?.split(/[\t\n\f\r ]+/u).includes(token) === true;
}

export function footnoteSemanticAncestor(
  state: ContentAgentState,
  element: Element,
): Element | null {
  void state;
  for (
    let candidate: Element | null = element;
    candidate !== null;
    candidate = candidate.parentElement
  ) {
    if (
      hasSemanticToken(state, candidate, "type", "footnote") ||
      hasSemanticToken(state, candidate, "type", "endnote") ||
      hasSemanticToken(state, candidate, "role", "doc-footnote") ||
      hasSemanticToken(state, candidate, "role", "doc-endnote")
    ) {
      return candidate;
    }
  }
  return null;
}

export function legacyNoteAncestor(state: ContentAgentState, element: Element): Element | null {
  void state;
  for (
    let candidate: Element | null = element;
    candidate !== null;
    candidate = candidate.parentElement
  ) {
    if (candidate.classList.contains("footnote") || candidate.classList.contains("endnote")) {
      return candidate;
    }
  }
  return null;
}

export function uniqueFragmentTarget(state: ContentAgentState, fragment: string): Element | null {
  void state;
  const target = document.getElementById(fragment);
  if (target === null) return null;
  try {
    return document.querySelectorAll(`#${CSS.escape(fragment)}`).length === 1 ? target : null;
  } catch {
    return null;
  }
}

export function hasReciprocalNoteBacklink(
  state: ContentAgentState,
  note: Element,
  reference: HTMLAnchorElement,
  currentUrl: URL,
): boolean {
  void state;
  if (reference.id.length === 0 || uniqueFragmentTarget(state, reference.id) !== reference)
    return false;
  for (const backlink of note.querySelectorAll("a")) {
    const href = authoredHref(state, backlink);
    if (href === null) continue;
    try {
      const target = new URL(href, document.baseURI);
      if (
        target.origin === currentUrl.origin &&
        target.pathname === currentUrl.pathname &&
        target.search === currentUrl.search &&
        target.hash.length > 1 &&
        decodeURIComponent(target.hash.slice(1)) === reference.id
      ) {
        return true;
      }
    } catch {
      // Malformed authored backlinks are not reciprocal evidence.
    }
  }
  return false;
}

export function createFootnoteFocusAid(
  state: ContentAgentState,
  target: Element,
  label: string,
): HTMLElement | null {
  void state;
  const parent = target.parentNode;
  if (parent === null) return null;
  const aid = document.createElement("span");
  state.activation.footnoteFocusAids.add(aid);
  aid.tabIndex = -1;
  aid.setAttribute("role", label === "Footnote" ? "note" : "link");
  aid.setAttribute("aria-label", label);
  aid.setAttribute("data-epub-navigator-configuration", "footnote-focus");
  aid.style.cssText =
    "position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important";
  parent.insertBefore(aid, target);
  aid.focus({ preventScroll: true });
  if (document.activeElement !== aid) {
    aid.remove();
    return null;
  }
  return aid;
}

export function removeFootnoteAid(state: ContentAgentState, aid: HTMLElement | null): void {
  void state;
  if (aid?.isConnected === true) aid.remove();
}

export function clearFootnoteNavigation(state: ContentAgentState): void {
  void state;
  removeFootnoteAid(state, state.activation.activeFootnoteNavigation?.destinationAid ?? null);
  state.activation.activeFootnoteNavigation = null;
}

export function currentRelocationPresentation(state: ContentAgentState) {
  void state;
  return state.layout.settledLayout?.presentation.mode === "paginated"
    ? {
        mode: "paginated" as const,
        spreadStride:
          state.layout.settledLayout.settlement.mode === "paginated"
            ? state.layout.settledLayout.settlement.pages.spreadStride
            : undefined,
      }
    : { mode: "document-scroll" as const };
}

/**
 * What the publication printed as the reference, when that is a marker rather than prose.
 *
 * A marker is a number, a symbol, or a bracketed few characters: short, and never a phrase. A
 * reference worded as a sentence names nothing a title could usefully repeat, so it names
 * nothing at all.
 */
function referenceMarker(anchor: HTMLAnchorElement): string | null {
  const text = (anchor.textContent ?? "").trim();
  return text.length > 0 && text.length <= 8 && !/\s/u.test(text) ? text : null;
}

/**
 * Whether the publication printed this reference as a raised marker.
 *
 * A note kept in another document leaves nothing to inspect but the reference, and raising the
 * marker is the one thing a note reference does that an ordinary cross-reference does not.
 * Publications wrap the marker on either side of the link, so both are read: `<a><sup>1</sup></a>`
 * and `<sup><a>1</a></sup>` are the same reference. A rule is read as well as an element, because
 * a publication that raises its markers by stylesheet means it just as plainly.
 */
function raisedMarkerReference(anchor: HTMLAnchorElement): boolean {
  if (anchor.closest("sup, sub") !== null || anchor.querySelector("sup, sub") !== null) return true;
  const view = anchor.ownerDocument.defaultView;
  return [anchor, anchor.parentElement, anchor.firstElementChild].some((element) => {
    const alignment = element === null ? null : view?.getComputedStyle(element).verticalAlign;
    return alignment === "super" || alignment === "sub";
  });
}

export function activateFootnote(
  state: ContentAgentState,
  anchor: HTMLAnchorElement,
  resolvedUrl: URL,
): AgentActivationMessage["footnote"] {
  void state;
  if (
    anchor.hasAttribute("download") ||
    ![null, "", "_self"].includes(anchor.getAttribute("target"))
  ) {
    return null;
  }
  const authoredNoteref =
    hasSemanticToken(state, anchor, "type", "noteref") ||
    hasSemanticToken(state, anchor, "role", "doc-noteref");
  const currentUrl = new URL(document.URL);
  if (resolvedUrl.origin !== currentUrl.origin || resolvedUrl.hash.length <= 1) return null;
  let fragment: string;
  try {
    fragment = decodeURIComponent(resolvedUrl.hash.slice(1));
  } catch {
    return null;
  }
  let originEvidence: PointEvidence[] | null;
  try {
    originEvidence = capturePointAtElementStartInDocument(document, anchor);
  } catch {
    return null;
  }
  if (originEvidence === null) return null;
  const activationId = state.activation.nextFootnoteActivationId;
  state.activation.nextFootnoteActivationId = (state.activation.nextFootnoteActivationId + 1) >>> 0;
  const navigated = {
    activationId,
    originEvidence,
    disposition: "navigated",
    referenceRect: null,
    referenceLabel: null,
  } as const;
  // The reader is about to show this note, so the page stays where the reader left it. Reporting
  // the reference is all that is wanted; moving to the note as well would take the page away.
  const reported = () => {
    clearFootnoteNavigation(state);
    const box = anchor.getBoundingClientRect();
    return {
      activationId,
      originEvidence,
      disposition: "reported",
      referenceRect: { x: box.x, y: box.y, width: box.width, height: box.height },
      referenceLabel: referenceMarker(anchor),
    } as const;
  };
  // A note the publication keeps in another document cannot be examined from here, so the
  // reference carries the whole case for being one: either the publication said so, or it printed
  // a raised marker, which an ordinary cross-reference does not.
  if (resolvedUrl.pathname !== currentUrl.pathname || resolvedUrl.search !== currentUrl.search) {
    const printedAsNote = referenceMarker(anchor) !== null && raisedMarkerReference(anchor);
    if (!authoredNoteref && !printedAsNote) return null;
    return state.lifecycle.configuration.input.notes === "show" ? reported() : navigated;
  }
  const fragmentTarget = uniqueFragmentTarget(state, fragment);
  if (fragmentTarget === null) return null;
  const footnote = footnoteSemanticAncestor(state, fragmentTarget);
  const legacyNote = legacyNoteAncestor(state, fragmentTarget);
  if (
    (footnote === null || !authoredNoteref) &&
    (legacyNote === null || !hasReciprocalNoteBacklink(state, legacyNote, anchor, currentUrl))
  ) {
    return null;
  }
  if (state.lifecycle.configuration.input.notes === "show") return reported();
  const relocation = relocateLocatorInDocument(
    document,
    { kind: "point", evidence: [{ kind: "html-fragment", value: fragment }] },
    currentRelocationPresentation(state),
  );
  if (relocation.status !== "resolved") return null;
  clearFootnoteNavigation(state);
  if (fragmentTarget instanceof HTMLElement) fragmentTarget.focus({ preventScroll: true });
  const destinationAid =
    document.activeElement === fragmentTarget
      ? null
      : createFootnoteFocusAid(state, fragmentTarget, "Footnote");
  if (document.activeElement !== fragmentTarget && destinationAid === null) return null;
  state.activation.activeFootnoteNavigation = {
    activationId,
    origin: new WeakRef(anchor),
    originEvidence,
    destinationAid,
  };
  return navigated;
}

export function returnFromFootnote(
  state: ContentAgentState,
  activationId: number,
): AgentFootnoteReturnedMessage["status"] {
  void state;
  const navigation = state.activation.activeFootnoteNavigation;
  if (navigation === null || navigation.activationId !== activationId) return "stale";
  removeFootnoteAid(state, navigation.destinationAid);
  const relocation = relocateLocatorInDocument(
    document,
    { kind: "point", evidence: navigation.originEvidence },
    currentRelocationPresentation(state),
  );
  if (relocation.status !== "resolved") {
    state.activation.activeFootnoteNavigation = { ...navigation, destinationAid: null };
    return relocation.status === "failed" ? "failed" : "unavailable";
  }
  const origin = navigation.origin.deref();
  if (origin?.isConnected === true) {
    origin.focus({ preventScroll: true });
    if (document.activeElement === origin) {
      state.activation.activeFootnoteNavigation = null;
      return "returned";
    }
  }
  const resolution = resolvePointEvidenceInDocument(document, navigation.originEvidence);
  const container = resolution.range?.startContainer;
  const element = container instanceof Element ? container : (container?.parentElement ?? null);
  const aid = element === null ? null : createFootnoteFocusAid(state, element, "Note reference");
  if (aid === null) {
    state.activation.activeFootnoteNavigation = { ...navigation, destinationAid: null };
    return "unavailable";
  }
  state.activation.activeFootnoteNavigation = null;
  aid.addEventListener("blur", () => removeFootnoteAid(state, aid), { once: true });
  return "returned";
}

export function postDecorationDismissal(
  state: ContentAgentState,
  projectionRevision: number,
  clientX = 0,
  clientY = 0,
): void {
  void state;
  setActiveDecoration(document, projectionRevision, null);
  const visualViewport = window.visualViewport;
  const offsetX = visualViewport?.offsetLeft ?? 0;
  const offsetY = visualViewport?.offsetTop ?? 0;
  post(state, {
    namespace: CONTENT_AGENT_NAMESPACE,
    type: "decoration-activation",
    projectionRevision,
    ids: [],
    anchor: {
      rect: { x: clientX - offsetX, y: clientY - offsetY, width: 0, height: 0 },
      clippingRect: {
        x: 0,
        y: 0,
        width: visualViewport?.width ?? window.innerWidth,
        height: visualViewport?.height ?? window.innerHeight,
      },
      visualViewportOffset: { x: offsetX, y: offsetY },
    },
    link: null,
  } satisfies OutboundMessageInput<AgentDecorationActivationMessage>);
}

export const dismissActiveDecorationOnGeometryChange = (state: ContentAgentState): void => {
  void state;
  if (!state.lifecycle.initialized || state.lifecycle.agentRole !== "foreground") return;
  if (state.selection.selectionEdgeGesture?.selectionActive === true) return;
  const revision = activeDecorationProjectionRevision(document);
  if (revision !== null) postDecorationDismissal(state, revision);
};

export function installActivationController(state: ContentAgentState): void {
  document.addEventListener(
    "submit",
    (event) => {
      if (
        !state.lifecycle.initialized ||
        state.lifecycle.agentRole !== "foreground" ||
        !(event.target instanceof HTMLFormElement)
      ) {
        return;
      }
      const submitter = event instanceof SubmitEvent ? event.submitter : null;
      const override =
        submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
          ? submitter
          : null;
      const authoredAction =
        override?.getAttribute("formaction") ?? event.target.getAttribute("action");
      const method = (
        override?.getAttribute("formmethod") ??
        event.target.getAttribute("method") ??
        "get"
      ).toLowerCase();
      const target = override?.getAttribute("formtarget") ?? event.target.getAttribute("target");
      try {
        post(state, {
          namespace: CONTENT_AGENT_NAMESPACE,
          type: "form-submission",
          action: authoredAction,
          resolvedUrl: new URL(authoredAction ?? "", document.baseURI).href,
          method,
          target,
        } satisfies OutboundMessageInput<AgentFormSubmissionMessage>);
      } catch {
        // The browser remains responsible for malformed authored form actions.
      }
    },
    { capture: true },
  );

  document.addEventListener(
    "click",
    (event) => {
      if (
        !state.lifecycle.initialized ||
        state.lifecycle.agentRole !== "foreground" ||
        event.defaultPrevented ||
        (event.detail !== 0 && event.button !== 0)
      )
        return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (
        event.detail !== 0 &&
        performance.now() < state.selection.suppressDecorationActivationUntil
      )
        return;
      if (event.detail !== 0) {
        const hit = decorationsAtPoint(document, event.clientX, event.clientY);
        if (hit !== null) {
          event.preventDefault();
          const selection = window.getSelection();
          if (selection?.isCollapsed === false) {
            selection.removeAllRanges();
            scheduleSelectionSignal(state);
          }
          const visualViewport = window.visualViewport;
          const offsetX = visualViewport?.offsetLeft ?? 0;
          const offsetY = visualViewport?.offsetTop ?? 0;
          const anchor = {
            rect: {
              x: hit.rect.left - offsetX,
              y: hit.rect.top - offsetY,
              width: hit.rect.width,
              height: hit.rect.height,
            },
            clippingRect: {
              x: 0,
              y: 0,
              width: visualViewport?.width ?? window.innerWidth,
              height: visualViewport?.height ?? window.innerHeight,
            },
            visualViewportOffset: { x: offsetX, y: offsetY },
          };
          const authoredAnchor = anchorFromEvent(state, event);
          const href = authoredAnchor === null ? null : authoredHref(state, authoredAnchor);
          let link: AgentDecorationActivationMessage["link"] = null;
          if (authoredAnchor !== null && href !== null) {
            try {
              link = {
                href,
                resolvedUrl: new URL(href, document.baseURI).href,
                target: authoredAnchor.getAttribute("target"),
                download: authoredAnchor.getAttribute("download"),
              };
            } catch {
              link = null;
            }
          }
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "decoration-activation",
            projectionRevision: hit.projectionRevision,
            ids: hit.ids,
            anchor,
            link,
          } satisfies OutboundMessageInput<AgentDecorationActivationMessage>);
          return;
        }
        const activeRevision = activeDecorationProjectionRevision(document);
        if (activeRevision !== null && window.getSelection()?.isCollapsed !== false) {
          postDecorationDismissal(state, activeRevision, event.clientX, event.clientY);
        }
      }
      const anchor = anchorFromEvent(state, event);
      if (anchor === null) return;
      const href = authoredHref(state, anchor);
      if (href === null) return;
      event.preventDefault();
      let activation: AgentActivationMessage;
      try {
        const resolvedUrl = new URL(href, document.baseURI);
        const footnote =
          anchor instanceof HTMLAnchorElement ? activateFootnote(state, anchor, resolvedUrl) : null;
        if (footnote === null) clearFootnoteNavigation(state);
        activation = {
          session: state.transport.protocolSession ?? "",
          namespace: CONTENT_AGENT_NAMESPACE,
          type: "activation",
          href,
          resolvedUrl: resolvedUrl.href,
          target: anchor.getAttribute("target"),
          download: anchor.getAttribute("download"),
          footnote,
        };
      } catch {
        return;
      }
      post(state, activation);
    },
    { capture: true },
  );

  window.addEventListener("scroll", () => dismissActiveDecorationOnGeometryChange(state), {
    capture: true,
  });

  window.visualViewport?.addEventListener("resize", () =>
    dismissActiveDecorationOnGeometryChange(state),
  );
}
