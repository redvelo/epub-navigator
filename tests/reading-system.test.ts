import { describe, expect, it } from "vitest";
import { readingSystemFeature } from "../src/runtime/reading-system.js";

describe("EPUB reading-system features", () => {
  it("matches standard names exactly and reports tested event capability", () => {
    const capabilities = { touch: false, mouse: true, keyboard: true };
    expect(readingSystemFeature("dom-manipulation", capabilities)).toBe(true);
    expect(readingSystemFeature("touch-events", capabilities)).toBe(false);
    expect(readingSystemFeature("mouse-events", capabilities)).toBe(true);
    expect(readingSystemFeature("DOM-manipulation", capabilities)).toBeUndefined();
    expect(readingSystemFeature("unknown", capabilities)).toBeUndefined();
  });
});
