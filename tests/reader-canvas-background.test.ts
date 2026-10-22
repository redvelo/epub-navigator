// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { ReflowablePresentation } from "../src/generated/kernel.js";
import { createContentAgentState } from "../src/runtime/content-agent/state.js";
import {
  installReaderStyle,
  presentationRules,
} from "../src/runtime/content-agent/layout/reader-style.js";

const presentation: ReflowablePresentation = {
  mode: "document-scroll",
  paginationColumns: "auto",
  theme: "original",
  colorScheme: "light",
  typeface: "original",
  fontScale: "100",
  lineHeight: "original",
  letterSpacing: "0",
  wordSpacing: "0",
  paragraphSpacing: "original",
  textIndent: "original",
  measure: "wide",
  alignment: "original",
  hyphenation: "original",
  rootScrollbar: "publisher",
  alignXCenter: false,
};

const rootRule = (rules: readonly string[]): string =>
  rules.find((rule) => rule.startsWith(":where(:root)")) ?? "";

const authored = (css: string): HTMLStyleElement => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  return style;
};

describe("original theme canvas background", () => {
  afterEach(() => {
    document.head.replaceChildren();
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  it("paints the root with Canvas when the publication paints nothing", () => {
    expect(rootRule(presentationRules(createContentAgentState(), presentation))).toContain(
      "background-color: Canvas;",
    );
  });

  it("propagates an authored body colour to the root, as the browser would to the canvas", () => {
    authored("body { background-color: #fff4e7; }");
    expect(rootRule(presentationRules(createContentAgentState(), presentation))).toContain(
      "background-color: rgb(255, 244, 231);",
    );
  });

  it("keeps an authored root colour ahead of the body colour", () => {
    authored("html { background-color: #112233; } body { background-color: #fff4e7; }");
    expect(rootRule(presentationRules(createContentAgentState(), presentation))).toContain(
      "background-color: rgb(17, 34, 51);",
    );
  });

  // jsdom resolves computed styles without honouring a disabled stylesheet, so the re-capture
  // with the reader stylesheet in the cascade is covered by the haruko local-host spec instead.
  it("leaves the reader stylesheet enabled after capturing", () => {
    authored("body { background-color: #fff4e7; }");
    const state = createContentAgentState();
    state.layout.readerStyle = installReaderStyle(state);
    presentationRules(state, presentation);
    expect(state.layout.readerStyle.disabled).toBe(false);
    expect(state.layout.readerStyle.isConnected).toBe(true);
  });
});
