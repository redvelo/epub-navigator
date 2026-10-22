// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ReflowablePresentation } from "../src/generated/kernel.js";
import { createContentAgentState } from "../src/runtime/content-agent/state.js";
import { presentationRules } from "../src/runtime/content-agent/layout/reader-style.js";

/** Scrolled mode keeps the rules free of the paginated path's geometry capture. */
const presentation = (overrides: Partial<ReflowablePresentation> = {}): ReflowablePresentation => ({
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
  ...overrides,
});

const rulesFor = (overrides: Partial<ReflowablePresentation> = {}): string =>
  presentationRules(createContentAgentState(), presentation(overrides)).join("\n");

describe("reader text spacing", () => {
  it("imposes nothing at its defaults, so authored spacing stands", () => {
    const css = rulesFor();
    expect(css).not.toContain("letter-spacing");
    expect(css).not.toContain("word-spacing");
    expect(css).not.toContain("margin-block");
    expect(css).not.toContain("text-indent");
  });

  it("expresses spacing against font size, so the ratios hold at every text size", () => {
    expect(rulesFor({ letterSpacing: "0.12" })).toContain("letter-spacing: 0.12em !important");
    expect(rulesFor({ wordSpacing: "0.16" })).toContain("word-spacing: 0.16em !important");
    expect(rulesFor({ paragraphSpacing: "2" })).toContain("margin-block: 2em !important");
    expect(rulesFor({ textIndent: "1" })).toContain("text-indent: 1em !important");
  });

  it("collapses authored paragraph spacing and indent when asked for none", () => {
    expect(rulesFor({ paragraphSpacing: "0" })).toContain("margin-block: 0em !important");
    expect(rulesFor({ textIndent: "0" })).toContain("text-indent: 0em !important");
  });

  it("withholds letter spacing from scripts whose shaping it would break", () => {
    const css = rulesFor({ letterSpacing: "0.12" });
    for (const language of ["ar", "fa", "ur", "hi", "bn", "ta", "th", "km", "bo"]) {
      expect(css).toContain(`:not(:lang(${language}))`);
    }
    // Hebrew does not join, and untagged text is assumed Latin, so neither is excluded.
    expect(css).not.toContain(":not(:lang(he))");
  });

  it("leaves word spacing, paragraph spacing, and indent unscoped by language", () => {
    for (const overrides of [
      { wordSpacing: "0.16" },
      { paragraphSpacing: "2" },
      { textIndent: "1" },
    ] as Partial<ReflowablePresentation>[]) {
      const rule = presentationRules(createContentAgentState(), presentation(overrides))
        .filter((candidate) => !candidate.includes("letter-spacing"))
        .join("\n");
      expect(rule).not.toContain(":not(:lang(");
    }
  });
});
