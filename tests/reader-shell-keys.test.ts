import { describe, expect, it } from "vitest";
import { shellKeyDirection } from "../src/react/input/focus.js";

const movement = (key: string, shiftKey = false, mode: "standard" | "vim" = "standard") =>
  shellKeyDirection(key, shiftKey, mode, "horizontal-tb", "ltr");

describe("what a reader-shell key asks to move", () => {
  it("moves the text with the page keys", () => {
    expect(movement("PageDown")).toEqual({ direction: "forward", intent: "block" });
    expect(movement("PageUp")).toEqual({ direction: "backward", intent: "block" });
    expect(movement(" ")).toEqual({ direction: "forward", intent: "block" });
    expect(movement(" ", true)).toEqual({ direction: "backward", intent: "block" });
    expect(movement("j", false, "vim")).toEqual({ direction: "forward", intent: "block" });
  });

  it("moves along the reading order with the inline arrows", () => {
    expect(movement("ArrowRight")).toEqual({ direction: "forward", intent: "inline" });
    expect(movement("ArrowLeft")).toEqual({ direction: "backward", intent: "inline" });
  });

  it("leaves the section outright on vim's inline keys, as the content agent does", () => {
    expect(movement("l", false, "vim")).toEqual({ direction: "forward", intent: "section" });
    expect(movement("h", false, "vim")).toEqual({ direction: "backward", intent: "section" });
    expect(movement("l")).toBeNull();
  });

  it("leaves the block arrows to the browser's own scrolling", () => {
    expect(movement("ArrowDown")).toBeNull();
    expect(movement("ArrowUp")).toBeNull();
  });
});
