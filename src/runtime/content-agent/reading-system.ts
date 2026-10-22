import type { ContentAgentState } from "./state.js";
import { readingSystemFeature } from "../reading-system.js";

/**
 * The renderer names itself, not the application embedding it.
 *
 * Publications sniff `name` to work around a reading system's rendering quirks, and the
 * rendering is this runtime's; a host shell that swapped its own product name in would
 * answer a question the publication did not ask.
 */
const NAME = "epub-navigator";
const VERSION = "0.1.0";

export function createReadingSystem(state: ContentAgentState): Navigator["epubReadingSystem"] {
  const eventCapabilities = {
    touch: "TouchEvent" in window,
    mouse: "MouseEvent" in window,
    keyboard: "KeyboardEvent" in window,
  };
  return Object.freeze({
    name: NAME,
    version: VERSION,
    /**
     * The mode this document is actually in, which `auto` resolves per publication and the
     * reader can change while it is open, so it is read at the call rather than frozen.
     * A fixed page is paginated by construction.
     */
    get layoutStyle(): "paginated" | "scrolling" {
      const settled = state.layout.settledLayout?.presentation.mode;
      const active = state.layout.activePresentation?.mode;
      return (settled ?? active) === "document-scroll" ? "scrolling" : "paginated";
    },
    hasFeature(feature: string, _version?: string): boolean | undefined {
      return readingSystemFeature(feature, eventCapabilities);
    },
  });
}
