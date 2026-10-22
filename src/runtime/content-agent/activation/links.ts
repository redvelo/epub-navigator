import type { ContentAgentState } from "../state.js";

export function anchorFromEvent(state: ContentAgentState, event: MouseEvent): Element | null {
  void state;
  for (const item of event.composedPath()) {
    if (item instanceof Element && item.localName === "a" && authoredHref(state, item) !== null)
      return item;
  }
  let element = event.target instanceof Element ? event.target : null;
  while (element !== null) {
    if (element.localName === "a" && authoredHref(state, element) !== null) return element;
    element = element.parentElement;
  }
  return null;
}

export function authoredHref(state: ContentAgentState, anchor: Element): string | null {
  void state;
  return (
    anchor.getAttribute("href") ??
    anchor.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
    anchor.getAttribute("xlink:href")
  );
}
