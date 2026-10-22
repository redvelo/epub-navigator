import { expect, it } from "vitest";
import { normalizedScrollPosition } from "../src/runtime/content-agent/layout/document-scroll.js";

it("keeps a scrolled position inside the unit range the layout protocol accepts", () => {
  expect(normalizedScrollPosition(0, 1973)).toBe(0);
  expect(normalizedScrollPosition(986.5, 1973)).toBeCloseTo(0.5, 6);
  // A document scrolled to its end, measured against a `scrollHeight` rounded down to whole
  // pixels. Reported unclamped this is 1.00025, which the protocol refuses as malformed.
  expect(normalizedScrollPosition(1973.5, 1973)).toBe(1);
  expect(normalizedScrollPosition(-0.5, 1973)).toBe(0);
  expect(normalizedScrollPosition(42, 0)).toBe(0);
});
