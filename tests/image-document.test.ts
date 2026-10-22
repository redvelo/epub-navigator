// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { imageDocumentSource, imageDocumentUrl } from "../src/image-document.js";
import { resolveImageIntrinsicViewport } from "../src/runtime/content-agent/image-viewport.js";
import {
  normalizeFixedIntrinsicViewport,
  normalizeLayoutResult,
} from "../src/runtime/agent-protocol/codecs/layout.js";
import { mutationIsAgentStyle } from "../src/runtime/content-agent/observation/controller.js";
import { createContentAgentState } from "../src/runtime/content-agent/state.js";
import { instrumentXhtml } from "../src/xhtml-instrumentation.js";

const sourceUrl = "https://publication.test/EPUB/a%20%26%22%3C%3E%27.png";
function wrapper(): Document {
  const source = imageDocumentSource(sourceUrl);
  return new DOMParser().parseFromString(new TextDecoder().decode(source), "application/xhtml+xml");
}

describe("fixed image alternate representation", () => {
  it("preserves the source identity with one query and one XML-escaped raw image", () => {
    expect(imageDocumentUrl(sourceUrl)).toBe(`${sourceUrl}?epub-navigator-image-document=1`);
    const document = wrapper();
    expect(document.querySelector("parsererror")).toBeNull();
    expect(document.querySelectorAll("img")).toHaveLength(1);
    expect(document.querySelector("img")!.getAttribute("src")).toBe(sourceUrl);
    expect(document.querySelector("meta[name=viewport]")).toBeNull();
    expect(document.querySelectorAll("script")).toHaveLength(0);
    const transformed = instrumentXhtml(imageDocumentSource(sourceUrl), {
      contentAgentUrl: "https://reader.test/agent.js",
    });
    expect(new TextDecoder().decode(transformed)).toContain("https://reader.test/agent.js");
    for (const suffix of ["?other=1", "#fragment"]) {
      expect(() => imageDocumentSource(sourceUrl + suffix)).toThrow();
      expect(() => imageDocumentUrl(sourceUrl + suffix)).toThrow();
    }
  });

  it("reports natural dimensions, never fabricated authored viewport metadata", () => {
    const document = wrapper();
    Object.defineProperties(document.querySelector("img"), {
      complete: { value: true },
      naturalWidth: { value: 1674 },
      naturalHeight: { value: 1378 },
    });
    expect(resolveImageIntrinsicViewport(document)).toEqual({
      status: "resolved",
      viewport: { width: 1674, height: 1378, source: "image-natural" },
    });
    expect(document.documentElement.getAttribute("data-epub-navigator-viewport-source")).toBe(
      "image-natural",
    );
    expect(document.querySelector("meta[name=viewport]")).toBeNull();
  });

  it.each([0, -1, NaN, Infinity])(
    "rejects invalid natural dimensions %s with a typed outcome",
    (width) => {
      const document = wrapper();
      Object.defineProperties(document.querySelector("img"), {
        complete: { value: true },
        naturalWidth: { value: width },
        naturalHeight: { value: 10 },
      });
      expect(resolveImageIntrinsicViewport(document)).toEqual({
        status: "unavailable",
        issue: "image-load-failed",
      });
      expect(normalizeFixedIntrinsicViewport({ width, height: 10 })).toBeNull();
    },
  );

  it("accepts recoverable image layout failure on the protocol", () => {
    expect(
      normalizeFixedIntrinsicViewport({ width: 10, height: 10, source: "unknown" }),
    ).toBeNull();
    const result = {
      adapter: "fixed-image",
      outcome: { status: "unavailable", issue: "image-load-failed" },
    };
    expect(normalizeLayoutResult(result)).toEqual(result);
    expect(resolveImageIntrinsicViewport(wrapper())).toEqual(result.outcome);
  });

  it("writes idempotent viewport metadata that cannot invalidate its own layout", () => {
    document.documentElement.setAttribute("data-epub-navigator-image-document", "1");
    document.body.innerHTML = "<img />";
    Object.defineProperties(document.querySelector("img")!, {
      naturalWidth: { value: 1674 },
      naturalHeight: { value: 1378 },
      complete: { value: true },
    });
    const state = createContentAgentState();
    state.lifecycle.documentAdapter = "fixed-image";
    const observer = new MutationObserver(() => {});
    observer.observe(document.documentElement, { attributes: true, attributeOldValue: true });
    expect(resolveImageIntrinsicViewport(document).status).toBe("resolved");
    const records = observer.takeRecords();
    expect(records).toHaveLength(1);
    expect(mutationIsAgentStyle(state, records[0]!)).toBe(true);
    resolveImageIntrinsicViewport(document);
    expect(observer.takeRecords()).toHaveLength(0);
    state.lifecycle.documentAdapter = "fixed-xhtml";
    expect(mutationIsAgentStyle(state, records[0]!)).toBe(false);
    state.lifecycle.documentAdapter = "fixed-image";
    document.documentElement.style.width = "100px";
    expect(mutationIsAgentStyle(state, observer.takeRecords()[0]!)).toBe(false);
    observer.disconnect();
  });
});
