// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  arrowPageDirection,
  capturePaginatedGeometryContext,
  documentFlow,
  paginatedMetrics,
  paginatedRectangleOffset,
  paginatedRectangleOffsetFromContext,
  scrollPaginatedBy,
  scrollToPaginatedPosition,
} from "../src/runtime/content-agent/layout/document-scroll.js";

afterEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("document flow", () => {
  it("uses the body flow root and normalizes sideways writing modes", () => {
    document.documentElement.style.writingMode = "horizontal-tb";
    document.documentElement.style.direction = "ltr";
    document.body.style.writingMode = "sideways-rl";
    document.body.style.direction = "rtl";

    expect(documentFlow(document)).toEqual({ writingMode: "vertical-rl", direction: "rtl" });
  });

  it("falls back to the document element when the body is unavailable", () => {
    document.body?.remove();
    document.documentElement.style.writingMode = "sideways-lr";
    document.documentElement.style.direction = "rtl";

    expect(documentFlow(document)).toEqual({ writingMode: "vertical-lr", direction: "rtl" });
  });

  it("maps page arrows from EPUB progression instead of CSS direction", () => {
    expect(arrowPageDirection("horizontal-tb", "ArrowRight", "ltr")).toBe("forward");
    expect(arrowPageDirection("horizontal-tb", "ArrowLeft", "rtl")).toBe("forward");
    expect(arrowPageDirection("vertical-rl", "ArrowUp", "rtl")).toBe("forward");
    expect(arrowPageDirection("vertical-lr", "ArrowDown", "ltr")).toBe("forward");
    expect(arrowPageDirection("horizontal-tb", "ArrowUp", "ltr")).toBeNull();
  });

  it("uses one positive logical pagination axis for vertical RTL", () => {
    document.body.style.writingMode = "vertical-rl";
    document.body.style.direction = "rtl";
    const scrollingElement = document.documentElement;
    Object.defineProperties(scrollingElement, {
      scrollHeight: { configurable: true, value: 1800 },
      scrollTop: { configurable: true, value: -240, writable: true },
    });
    Object.defineProperties(window, {
      innerHeight: { configurable: true, value: 600 },
      innerWidth: { configurable: true, value: 800 },
    });
    Object.defineProperty(document, "scrollingElement", {
      configurable: true,
      value: scrollingElement,
    });

    expect(paginatedMetrics(document, "vertical-rl")).toEqual({
      position: 240,
      maximum: 1200,
      viewport: 600,
    });
    expect(
      paginatedRectangleOffset(
        document,
        { top: 100, right: 500, bottom: 180, left: 400 },
        "start",
        "vertical-rl",
      ),
    ).toBe(420);
    expect(
      paginatedRectangleOffset(
        document,
        { top: 100, right: 500, bottom: 180, left: 400 },
        "end",
        "vertical-rl",
      ),
    ).toBe(500);

    scrollPaginatedBy(document, 60, "vertical-rl");
    expect(scrollingElement.scrollTop).toBe(-300);
    scrollToPaginatedPosition(document, 480, "vertical-rl");
    expect(scrollingElement.scrollTop).toBe(-480);
  });

  it("converts rectangles without rereading flow when direction is captured", () => {
    const computedStyle = vi.spyOn(window, "getComputedStyle");
    for (let index = 0; index < 100; index += 1) {
      expect(
        paginatedRectangleOffset(
          document,
          { top: 0, right: index + 10, bottom: 10, left: index },
          "end",
          "horizontal-tb",
          "rtl",
        ),
      ).toBe(window.innerWidth - index);
    }
    expect(computedStyle).not.toHaveBeenCalled();
  });

  it("captures scroll geometry once for a batch of pagination targets", () => {
    const scrollingElement = document.documentElement;
    const extent = vi.fn(() => 2400);
    const position = vi.fn(() => 400);
    Object.defineProperties(scrollingElement, {
      scrollWidth: { configurable: true, get: extent },
      scrollLeft: { configurable: true, get: position },
    });
    Object.defineProperty(document, "scrollingElement", {
      configurable: true,
      value: scrollingElement,
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    const computedStyle = vi.spyOn(window, "getComputedStyle");

    const context = capturePaginatedGeometryContext(document, {
      writingMode: "horizontal-tb",
      direction: "ltr",
    });
    expect(context).not.toBeNull();
    for (let index = 0; index < 100; index += 1) {
      expect(
        paginatedRectangleOffsetFromContext(
          { top: 0, right: index + 10, bottom: 10, left: index },
          "start",
          context!,
        ),
      ).toBe(index);
    }

    expect(extent).toHaveBeenCalledOnce();
    expect(position).toHaveBeenCalledOnce();
    expect(computedStyle).not.toHaveBeenCalled();
  });
});
