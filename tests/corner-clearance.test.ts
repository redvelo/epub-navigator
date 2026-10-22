import { expect, it } from "vitest";
import { cornerClearance } from "../src/react/compact/corner-clearance.js";

it("uses the arc at the visible glyph edge instead of the full corner radius", () => {
  expect(cornerClearance(50, 50, 50, 20, 0, true, true)).toBe(10);
  expect(cornerClearance(50, 350, 50, 20, 400, true, false)).toBe(10);
  expect(cornerClearance(50, 50, 750, 780, 0, false, true)).toBe(10);
  expect(cornerClearance(50, 350, 750, 780, 400, false, false)).toBe(10);
});

it("needs no clearance below a top corner or above a bottom corner", () => {
  expect(cornerClearance(50, 50, 50, 70, 0, true, true)).toBe(0);
  expect(cornerClearance(50, 350, 750, 730, 400, false, false)).toBe(0);
});

it("accounts for native or embedded viewport offsets", () => {
  expect(cornerClearance(50, 50, 50, 20, 8, true, true)).toBe(2);
  expect(cornerClearance(50, 350, 50, 20, 380, true, false)).toBe(0);
});

it("retains full clearance at the outer edge and none on rectangular screens", () => {
  expect(cornerClearance(50, 50, 50, 0, 0, true, true)).toBe(50);
  expect(cornerClearance(0, 0, 0, 0, 0, true, true)).toBe(0);
});
