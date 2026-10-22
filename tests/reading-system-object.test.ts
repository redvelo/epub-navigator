// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createContentAgentState } from "../src/runtime/content-agent/state.js";
import { createReadingSystem } from "../src/runtime/content-agent/reading-system.js";

function stateInMode(mode: "paginated" | "document-scroll" | null) {
  const state = createContentAgentState();
  if (mode !== null) {
    state.layout.settledLayout = {
      presentation: { mode },
    } as unknown as typeof state.layout.settledLayout;
  }
  return state;
}

describe("epubReadingSystem", () => {
  it("names itself and answers every required feature string", () => {
    const system = createReadingSystem(stateInMode("paginated"))!;
    expect(system.name).toBe("epub-navigator");
    expect(system.version).toMatch(/^\d+\.\d+\.\d+$/u);
    for (const feature of [
      "dom-manipulation",
      "layout-changes",
      "spine-scripting",
      "touch-events",
      "mouse-events",
      "keyboard-events",
    ]) {
      expect(typeof system.hasFeature(feature), feature).toBe("boolean");
    }
    expect(system.hasFeature("something-nobody-defined")).toBeUndefined();
  });

  it("reports the layout style the document is actually in", () => {
    expect(createReadingSystem(stateInMode("paginated"))!.layoutStyle).toBe("paginated");
    expect(createReadingSystem(stateInMode("document-scroll"))!.layoutStyle).toBe("scrolling");
    // A fixed page settles no reflowable presentation and is paginated by construction.
    expect(createReadingSystem(stateInMode(null))!.layoutStyle).toBe("paginated");
  });

  it("follows the reader changing mode while the document is open", () => {
    const state = stateInMode("paginated");
    const system = createReadingSystem(state)!;
    expect(system.layoutStyle).toBe("paginated");
    state.layout.settledLayout = {
      presentation: { mode: "document-scroll" },
    } as unknown as typeof state.layout.settledLayout;
    expect(system.layoutStyle).toBe("scrolling");
  });
});
