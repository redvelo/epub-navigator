// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { resolveSvgIntrinsicViewport } from "../src/runtime/content-agent/svg-viewport.js";

const svgNamespace = "http://www.w3.org/2000/svg";

function xmlDocument(source: string): Document {
  return new DOMParser().parseFromString(source, "image/svg+xml");
}

function svgDocument(viewBox?: string, attributes = ""): Document {
  const authoredViewBox = viewBox === undefined ? "" : ` viewBox="${viewBox}"`;
  return xmlDocument(`<svg xmlns="${svgNamespace}"${authoredViewBox}${attributes}/>`);
}

describe("standalone SVG intrinsic viewport resolution", () => {
  it("resolves SVG number and comma-wsp grammar", () => {
    for (const [value, viewBox] of [
      ["0 0 1200 1577", { minX: 0, minY: 0, width: 1200, height: 1577 }],
      ["0,0,600,800", { minX: 0, minY: 0, width: 600, height: 800 }],
      ["\t-10.5, +2.5e1 .5E+2,1.e3\n", { minX: -10.5, minY: 25, width: 50, height: 1000 }],
      ["+7 -3 4e-1 5E+1", { minX: 7, minY: -3, width: 0.4, height: 50 }],
    ] as const) {
      expect(resolveSvgIntrinsicViewport(svgDocument(value)), value).toEqual({
        status: "resolved",
        viewport: { width: viewBox.width, height: viewBox.height },
        viewBox,
      });
    }
  });

  it("rejects invalid viewBox values", () => {
    for (const [value] of [
      ["", "empty"],
      ["0 0 100", "three numbers"],
      ["0 0 100 200 300", "five numbers"],
      ["0,0,,100,200", "empty token"],
      ["0 0 100px 200", "unit suffix"],
      ["0 0 100 200 junk", "trailing junk"],
      ["0 0 1e 200", "malformed exponent"],
      ["NaN 0 100 200", "NaN"],
      ["0 Infinity 100 200", "Infinity"],
      ["0 0 1e999 200", "non-finite exponent"],
      ["0 0 0 200", "zero width"],
      ["0 0 100 0", "zero height"],
      ["0 0 -100 200", "negative width"],
      ["0 0 100 -200", "negative height"],
    ] as const) {
      expect(resolveSvgIntrinsicViewport(svgDocument(value)), value).toEqual({
        status: "unavailable",
        issue: "intrinsic-viewport-invalid",
      });
    }
  });

  it("requires an authored viewBox instead of width and height fallback", () => {
    expect(
      resolveSvgIntrinsicViewport(svgDocument(undefined, ' width="600" height="800"')),
    ).toEqual({
      status: "unavailable",
      issue: "intrinsic-viewport-missing",
    });
  });

  it("rejects non-SVG roots", () => {
    for (const [source] of [
      ['<svg xmlns="" viewBox="0 0 600 800"/>', "an SVG-like root without the SVG namespace"],
      [
        `<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns="${svgNamespace}" viewBox="0 0 600 800"/></body></html>`,
        "a descendant SVG in an XHTML document",
      ],
      [`<g xmlns="${svgNamespace}" viewBox="0 0 600 800"/>`, "a non-SVG root in the SVG namespace"],
    ] as const) {
      expect(resolveSvgIntrinsicViewport(xmlDocument(source)), source).toEqual({
        status: "unavailable",
        issue: "intrinsic-viewport-unsupported",
      });
    }
  });

  it("does not mutate authored SVG state or inspect descendant geometry", () => {
    const document = xmlDocument(
      `<svg xmlns="${svgNamespace}" viewBox="-5 10 600 800" preserveAspectRatio="xMinYMin meet"><rect width="1" height="1"/></svg>`,
    );
    const before = document.documentElement.outerHTML;

    expect(resolveSvgIntrinsicViewport(document).status).toBe("resolved");
    expect(document.documentElement.outerHTML).toBe(before);
    expect(document.documentElement.getAttribute("preserveAspectRatio")).toBe("xMinYMin meet");
  });
});
