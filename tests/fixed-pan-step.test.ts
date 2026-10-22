import { expect, it } from "vitest";
import { fixedPanStep } from "../src/runtime/content-agent/layout/document-scroll.js";

it("moves the view in the direction the arrow names, so the page travels the other way", () => {
  expect(fixedPanStep("ArrowRight")).toEqual({ x: -48, y: 0 });
  expect(fixedPanStep("ArrowLeft")).toEqual({ x: 48, y: 0 });
  expect(fixedPanStep("ArrowDown")).toEqual({ x: 0, y: -48 });
  expect(fixedPanStep("ArrowUp")).toEqual({ x: 0, y: 48 });
  expect(fixedPanStep("ArrowRight", 10)).toEqual({ x: -10, y: 0 });
  expect(fixedPanStep("PageDown")).toBeNull();
});
