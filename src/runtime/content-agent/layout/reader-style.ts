import type { AgentConfiguration } from "../../agent-protocol/index.js";
import { setDecorationPalette } from "../decorations.js";
import type { ContentAgentState } from "../state.js";
import type { ReflowablePresentation } from "../../../generated/kernel.js";
import {
  captureBodyInsets,
  centredBlockGeometry,
  paginationGeometry,
} from "./pagination-geometry.js";
import { documentFlow } from "./document-scroll.js";
import { fragmentationMarkerAttribute } from "./constants.js";
import { invalidateDocumentTextIndex } from "../targets/resolver/text-index.js";
import { lineHeightValue } from "./fragmentation-repair.js";
import { queueLayoutInvalidation, scheduleObservation } from "../observation/controller.js";

/**
 * Languages whose shaping letter spacing would damage: the Arabic script's cursive joining,
 * Indic conjuncts, and South-East Asian and Tibetan clusters.
 */
const letterSpacingExcludedLanguages = [
  "ar",
  "fa",
  "ur",
  "ps",
  "sd",
  "ug",
  "ku",
  "syr",
  "dv",
  "hi",
  "mr",
  "ne",
  "sa",
  "as",
  "bn",
  "pa",
  "gu",
  "or",
  "ta",
  "te",
  "kn",
  "ml",
  "si",
  "th",
  "lo",
  "my",
  "km",
  "bo",
] as const;

const letterSpacingExclusions = letterSpacingExcludedLanguages
  .map((language) => `:not(:lang(${language}))`)
  .join("");

export function installReaderStyle(state: ContentAgentState): HTMLStyleElement {
  void state;
  const style = document.createElement("style");
  style.dataset.epubNavigatorConfiguration = "m3";
  (document.head ?? document.documentElement).append(style);
  state.layout.expectedReaderCss = "";
  return style;
}

export function applyConfiguration(state: ContentAgentState, next: AgentConfiguration): void {
  void state;
  setDecorationPalette(document, next.appearance.decorations ?? "standard");
  const appearanceChanged = !sameAppearancePolicy(state, state.lifecycle.configuration, next);
  const geometryChanged =
    state.lifecycle.configuration.appearance.rootScrollbar !== next.appearance.rootScrollbar;
  state.lifecycle.configuration = next;
  if (appearanceChanged && state.lifecycle.documentAdapter !== "fixed-svg") {
    const presentation =
      state.layout.activePresentation ?? state.layout.settledLayout?.presentation ?? null;
    updateReaderStyle(state, [
      ...configurationRules(state),
      ...(presentation === null ? [] : presentationRules(state, presentation)),
    ]);
  }
  if (geometryChanged && state.lifecycle.documentAdapter !== "fixed-svg")
    queueLayoutInvalidation(state, "preferences");
  scheduleObservation(state);
}

export function sameAppearancePolicy(
  state: ContentAgentState,
  left: AgentConfiguration,
  right: AgentConfiguration,
): boolean {
  void state;
  return left.appearance.rootScrollbar === right.appearance.rootScrollbar;
}

export function configurationRules(state: ContentAgentState): string[] {
  void state;
  const rules: string[] = [];
  const { appearance } = state.lifecycle.configuration;
  if (appearance.rootScrollbar === "hidden") {
    rules.push(":root { scrollbar-width: none; }");
    rules.push(":root::-webkit-scrollbar { display: none; }");
  }
  return rules;
}

export function updateReaderStyle(state: ContentAgentState, rules: string[]): void {
  void state;
  if (state.layout.readerStyle === null) return;
  state.layout.expectedReaderCss = rules.join("\n");
  if (state.layout.readerStyle.textContent !== state.layout.expectedReaderCss) {
    invalidateDocumentTextIndex(document);
    state.layout.readerStyle.textContent = state.layout.expectedReaderCss;
  }
}

export function readerFontStylesheetAvailable(state: ContentAgentState): boolean {
  void state;
  const link = document.querySelector<HTMLLinkElement>(
    'link[data-epub-navigator-reader-font="reader-serif"]',
  );
  return link !== null && link.isConnected && link.sheet !== null;
}

export function readerStyleAvailable(state: ContentAgentState): boolean {
  void state;
  return (
    state.layout.readerStyle !== null &&
    state.layout.readerStyle.isConnected &&
    state.layout.readerStyle.ownerDocument === document &&
    state.layout.readerStyle.dataset.epubNavigatorConfiguration === "m3" &&
    state.layout.readerStyle.textContent === state.layout.expectedReaderCss
  );
}

export function captureAuthoredCanvasBackground(state: ContentAgentState): string {
  // The reader stylesheet is disabled, not removed, while the authored colours are read: a DOM
  // mutation here would invalidate the very layout this is styling.
  const readerStyle = state.layout.readerStyle;
  const readerStyleWasDisabled = readerStyle?.disabled ?? false;
  if (readerStyle !== null) readerStyle.disabled = true;
  try {
    const root = getComputedStyle(document.documentElement).backgroundColor;
    if (paintsColor(root)) return root;
    const body = document.body === null ? "" : getComputedStyle(document.body).backgroundColor;
    return paintsColor(body) ? body : "Canvas";
  } finally {
    if (readerStyle !== null) readerStyle.disabled = readerStyleWasDisabled;
  }
}

function paintsColor(value: string): boolean {
  return value !== "" && value !== "transparent" && value !== "rgba(0, 0, 0, 0)";
}

export function presentationRules(
  state: ContentAgentState,
  presentation: ReflowablePresentation,
): string[] {
  void state;
  const rules: string[] = [];
  // Publisher typography is often declared with `!important` under selectors such as
  // `section[data-type="titlepage"] p.author` (0,2,2). The repeated `:root` outranks those
  // without an ID selector, so reader typography wins in the ordinary case.
  const typographyRoot = ":root:root:root:root:root:root:root:root";
  const proseBlocks = `${typographyRoot} :where(p, li, blockquote, dd, dt, figcaption):not(:where(pre *, code *, kbd *, samp *, math *, svg *))`;
  if (presentation.typeface !== "original") {
    // Reader Sans covers Latin only, so both reader faces fall back to the same script chain.
    // A wholly non-Latin publication therefore renders serif under either choice, which is
    // honest degradation rather than whatever the platform resolves `sans-serif` to.
    const scriptFallbacks =
      '"Noto Naskh Arabic Variable", "Noto Serif Hebrew Variable", "Noto Serif Devanagari Variable", "Noto Serif Bengali Variable", "Noto Serif Tamil Variable", "Noto Serif Telugu Variable"';
    const [reader, generic] =
      presentation.typeface === "reader-serif"
        ? ['"Navigator Reader Serif"', "Georgia, serif"]
        : ['"Navigator Reader Sans"', "sans-serif"];
    rules.push(
      `:root, ${typographyRoot} body, ${proseBlocks}, ${typographyRoot} :where(h1, h2, h3, h4, h5, h6):not(:where(pre *, code *, math *, svg *)) { font-family: ${reader}, ${scriptFallbacks}, ${generic} !important; }`,
    );
  }
  if (presentation.mode === "paginated") {
    const writingMode = documentFlow(document).writingMode;
    state.layout.authoredBodyInsets ??= captureBodyInsets(state);
    const geometry = paginationGeometry(
      state,
      writingMode,
      state.layout.authoredBodyInsets,
      presentation.paginationColumns,
    );
    rules.push(
      `:root { position: relative !important; margin: 0 !important; padding: 0 !important; border: 0 !important; width: 100vw !important; min-width: 0 !important; max-width: none !important; height: 100vh !important; min-height: 0 !important; max-height: none !important; box-sizing: border-box !important; overflow: hidden !important; touch-action: ${writingMode === "horizontal-tb" ? "" : "pan-x "}pinch-zoom !important; }`,
    );
    if (state.layout.paginationEndExtent > 0) {
      const extentSelector = document.body === null ? ":root::after" : "body::after";
      rules.push(
        `${extentSelector} { content: ""; position: absolute; inset-inline-start: ${state.layout.paginationEndExtent - 1}px; inset-block-start: 0; inline-size: 1px; block-size: 1px; pointer-events: none; }`,
      );
    }
    if (document.body !== null) {
      const columnSizing =
        state.layout.singleColumnPaginationFallback && geometry.columnsPerView === 1
          ? `column-count: auto !important; column-width: ${geometry.flowInlineSize}px !important;`
          : `column-count: ${geometry.columnsPerView} !important; column-width: auto !important;`;
      const block = centredBlockGeometry(state, geometry);
      rules.push(
        `body { display: block !important; margin-inline-start: ${geometry.inlineStart}px !important; margin-inline-end: ${geometry.inlineEnd}px !important; inline-size: ${geometry.flowInlineSize}px !important; min-inline-size: 0 !important; max-inline-size: none !important; margin-block-start: ${block.blockStart}px !important; margin-block-end: ${block.blockEnd}px !important; block-size: ${block.blockSize}px !important; min-block-size: 0 !important; max-block-size: none !important; box-sizing: border-box !important; ${columnSizing} column-gap: ${geometry.gap}px !important; column-fill: auto !important; overflow: visible !important; }`,
      );
    } else {
      rules.push(
        `:root { column-count: ${geometry.columnsPerView} !important; column-width: auto !important; column-gap: ${geometry.gap}px !important; column-fill: auto !important; }`,
      );
    }
    rules.push(
      `figure { max-inline-size: 100% !important; break-inside: avoid !important; }`,
      `img, video, canvas, object, embed, svg:not(:root) { max-inline-size: 100% !important; max-block-size: ${geometry.columnBlockSize}px !important; object-fit: contain !important; break-inside: avoid !important; }`,
    );
    for (const repair of state.layout.fragmentationRepairs) {
      const remedy = repair.remedy;
      const declarations =
        remedy.kind === "block-flow"
          ? "display: block !important;"
          : remedy.kind === "inline-margins"
            ? `margin-inline-start: ${remedy.start}px !important; margin-inline-end: ${remedy.end}px !important;`
            : remedy.kind === "wrap"
              ? "white-space: pre-wrap !important; overflow-wrap: anywhere !important;"
              : `zoom: ${remedy.zoom} !important;`;
      rules.push(
        `:root [${fragmentationMarkerAttribute}="${repair.marker}"]:not(#epub-navigator-fragmentation-a#epub-navigator-fragmentation-b) { ${declarations} }`,
      );
    }
  } else {
    // The block axis is the browser's to scroll. The inline axis is the reader's gesture for
    // leaving the section, and the browser cancels the pointer the moment it may pan there, so
    // the swipe would never arrive.
    const writingMode = documentFlow(document).writingMode;
    rules.push(
      `:root { touch-action: ${writingMode === "horizontal-tb" ? "pan-y" : "pan-x"} pinch-zoom !important; }`,
    );
  }
  const theme = presentation.theme;
  const scheme = presentation.colorScheme;
  if (theme === "original") {
    // Painting the root stops the body background propagating to the canvas, which is how an
    // authored body colour reaches the whole page in a browser. Paint the root with that colour
    // instead, so every page of a paginated section keeps it.
    state.layout.authoredCanvasBackground ??= captureAuthoredCanvasBackground(state);
    rules.push(
      `:where(:root) { background-color: ${state.layout.authoredCanvasBackground}; color: CanvasText; color-scheme: ${scheme}; }`,
    );
  } else {
    rules.push(
      `:root, body { background-color: Canvas !important; color: CanvasText !important; color-scheme: ${scheme}; }`,
      "@media (forced-colors: active) { :root, body { background-color: Canvas !important; color: CanvasText !important; color-scheme: normal; } }",
    );
  }
  const monochromeImage =
    'img:is([*|type~="se:image.color-depth.black-on-transparent"], [data-properties~="se:image.color-depth.black-on-transparent"])';
  const realisticImage = `${monochromeImage}:is([*|type~="se:image.style.realistic"], [data-properties~="se:image.style.realistic"])`;
  if (scheme === "light") {
    rules.push(
      `${monochromeImage} { background-color: transparent !important; filter: none !important; }`,
    );
  } else {
    rules.push(
      `${monochromeImage} { background-color: transparent !important; filter: invert(100%) !important; }`,
      `${realisticImage} { background-color: currentColor !important; filter: none !important; }`,
    );
  }
  rules.push(`:root { font-size: ${presentation.fontScale}% !important; }`);
  if (presentation.lineHeight !== "original") {
    rules.push(
      `:root, ${typographyRoot} body, ${proseBlocks} { line-height: ${lineHeightValue(state, presentation.lineHeight)} !important; }`,
    );
  }
  // Letter spacing breaks cursive joining in Arabic-script text and conjunct formation in
  // Indic and South-East Asian scripts, so the declaration is withheld from those languages
  // rather than the control being withheld from the reader. Untagged text is spaced: the
  // common case is Latin, and a document that declares a complex script opts itself out.
  if (presentation.letterSpacing !== "0") {
    rules.push(
      `${proseBlocks}${letterSpacingExclusions} { letter-spacing: ${presentation.letterSpacing}em !important; }`,
    );
  }
  if (presentation.wordSpacing !== "0") {
    rules.push(`${proseBlocks} { word-spacing: ${presentation.wordSpacing}em !important; }`);
  }
  if (presentation.paragraphSpacing !== "original") {
    rules.push(`${proseBlocks} { margin-block: ${presentation.paragraphSpacing}em !important; }`);
  }
  if (presentation.textIndent !== "original") {
    rules.push(`${proseBlocks} { text-indent: ${presentation.textIndent}em !important; }`);
  }
  if (presentation.alignment !== "original") {
    const alignment = presentation.alignment === "justify" ? "justify" : "start";
    rules.push(`${proseBlocks} { text-align: ${alignment} !important; }`);
  }
  if (presentation.hyphenation !== "original") {
    const hyphens = presentation.hyphenation === "auto" ? "auto" : "none";
    rules.push(`${proseBlocks} { hyphens: ${hyphens} !important; }`);
  }
  // A word that would overflow its line breaks instead; nothing else changes. A URL or a long
  // compound is otherwise clipped at the column edge, and a block box does not grow to show it.
  rules.push(`${proseBlocks} { overflow-wrap: break-word; }`);
  if (presentation.rootScrollbar === "hidden") {
    rules.push(":root { scrollbar-width: none !important; }");
    rules.push(":root::-webkit-scrollbar { display: none !important; }");
  }
  return rules;
}
