// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyPrefixedCss,
  rewriteDeclarationBlock,
  rewriteStyleSheet,
} from "../src/runtime/content-agent/prefixed-css.js";

describe("prefixed CSS declarations", () => {
  it("restates every prefixed property from the EPUB 3.3 table", () => {
    for (const [authored, expected] of [
      ["-epub-writing-mode: vertical-rl", "writing-mode: vertical-rl"],
      ["-epub-text-orientation: upright", "text-orientation: upright"],
      ["-epub-text-combine-horizontal: all", "text-combine-upright: all"],
      ["-epub-text-combine-horizontal: none", "text-combine-upright: none"],
      ["-epub-text-combine: horizontal", "text-combine-upright: all"],
      ["-epub-text-combine: none", "text-combine-upright: none"],
      ["-epub-hyphens: manual", "hyphens: manual"],
      ["-epub-line-break: strict", "line-break: strict"],
      ["-epub-text-align-last: start", "text-align-last: start"],
      ["-epub-word-break: keep-all", "word-break: keep-all"],
      ["-epub-text-emphasis-color: red", "text-emphasis-color: red"],
      ["-epub-text-emphasis-position: over left", "text-emphasis-position: over left"],
      ["-epub-text-emphasis-style: filled dot", "text-emphasis-style: filled dot"],
      ["-epub-text-underline-position: under left", "text-underline-position: under left"],
      ["text-transform: -epub-fullwidth", "text-transform: full-width"],
    ] as const) {
      expect(rewriteDeclarationBlock(authored)).toBe(`${authored};${expected}`);
    }
  });

  it("maps the keywords the prefixed properties kept and drops those without an equivalent", () => {
    for (const [authored, expected] of [
      ["-epub-text-orientation: vertical-right", "text-orientation: mixed"],
      ["-epub-text-orientation: rotate-right", "text-orientation: sideways"],
      ["-epub-text-orientation: rotate-normal", "text-orientation: sideways"],
      ["-epub-text-underline-position: alphabetic", "text-underline-position: auto"],
    ] as const) {
      expect(rewriteDeclarationBlock(authored)).toBe(`${authored};${expected}`);
    }
    for (const authored of [
      "-epub-hyphens: all",
      "-epub-text-combine: horizontal 2",
      "-epub-text-combine-horizontal: digits 2",
      "-epub-hyphens:",
    ]) {
      expect(rewriteDeclarationBlock(authored)).toBeNull();
    }
  });

  it("keeps the authored order so the later declaration still wins", () => {
    expect(rewriteDeclarationBlock("hyphens: none; -epub-hyphens: auto")).toBe(
      "hyphens: none; -epub-hyphens: auto;hyphens: auto",
    );
    expect(rewriteDeclarationBlock("-epub-hyphens: auto; hyphens: none")).toBe(
      "-epub-hyphens: auto;hyphens: auto; hyphens: none",
    );
  });

  it("carries importance and leaves the rest of the block as authored", () => {
    expect(rewriteDeclarationBlock("margin: 1em; -epub-hyphens: none !important;")).toBe(
      "margin: 1em; -epub-hyphens: none !important;hyphens: none !important;",
    );
  });

  it("restates a prefixed declaration only once", () => {
    const once = rewriteDeclarationBlock("-epub-line-break: loose");
    expect(once).not.toBeNull();
    expect(rewriteDeclarationBlock(once!)).toBeNull();
  });

  it("leaves strings, comments, parentheses and custom properties alone", () => {
    for (const authored of [
      'content: "-epub-hyphens: none"',
      "/* -epub-hyphens: none */ color: red",
      "background: url(data:image/gif;base64,-epub-hyphens:none)",
      "--kept: -epub-hyphens: none",
      "color: red",
    ]) {
      expect(rewriteDeclarationBlock(authored)).toBeNull();
    }
  });
});

describe("prefixed CSS stylesheets", () => {
  it("rewrites declaration blocks inside grouping and keyframe at-rules", () => {
    const sheet = [
      "@media (min-width: 30em) {",
      "  @supports (display: grid) { p.a { -epub-hyphens: none } }",
      "}",
      "@keyframes slide { from { -epub-word-break: break-all } }",
      "@font-face { font-family: X; src: url(x.otf) }",
      'p[class="-epub-trap"]::before { content: "{" }',
    ].join("\n");
    const rewritten = rewriteStyleSheet(sheet);
    expect(rewritten).not.toBeNull();
    expect(rewritten).toContain("-epub-hyphens: none;hyphens: none");
    expect(rewritten).toContain("-epub-word-break: break-all;word-break: break-all");
    expect(rewritten).toContain('p[class="-epub-trap"]::before { content: "{" }');
    expect(rewritten!.match(/hyphens/gu)).toHaveLength(2);
  });

  it("reports nothing when a sheet names no prefixed declaration", () => {
    expect(rewriteStyleSheet("p { color: red }")).toBeNull();
    expect(rewriteStyleSheet('p[data-x="-epub-hyphens"] { color: red }')).toBeNull();
    expect(rewriteStyleSheet("/* -epub-hyphens */ p { color: red }")).toBeNull();
  });

  it("leaves an unterminated block as authored", () => {
    expect(rewriteStyleSheet("p { -epub-hyphens: none")).toBeNull();
  });
});

describe("prefixed CSS in a document", () => {
  it("maps style attributes and style elements in place", () => {
    document.head.innerHTML = "<style>p { -epub-line-break: strict }</style>";
    document.body.innerHTML = [
      '<p id="inline" style="margin: 1em; -epub-hyphens: manual">a</p>',
      '<p id="upper" style="-EPUB-WORD-BREAK: keep-all">b</p>',
      '<p id="plain" style="color: red">c</p>',
    ].join("");

    expect(applyPrefixedCss(document)).toBe(3);
    expect(document.querySelector("#inline")?.getAttribute("style")).toBe(
      "margin: 1em; -epub-hyphens: manual;hyphens: manual",
    );
    expect(document.querySelector("#upper")?.getAttribute("style")).toBe(
      "-EPUB-WORD-BREAK: keep-all;word-break: keep-all",
    );
    expect(document.querySelector("#plain")?.getAttribute("style")).toBe("color: red");
    expect(document.querySelector("style")?.textContent).toBe(
      "p { -epub-line-break: strict;line-break: strict }",
    );
    expect(applyPrefixedCss(document)).toBe(0);
  });

  it("gives the engine the declaration it had dropped", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = '<p id="target" style="-epub-word-break: keep-all">a</p>';
    const target = document.querySelector<HTMLElement>("#target")!;
    expect(target.style.getPropertyValue("word-break")).toBe("");
    applyPrefixedCss(document);
    expect(target.style.getPropertyValue("word-break")).toBe("keep-all");
  });
});
