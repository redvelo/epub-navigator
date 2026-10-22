/**
 * EPUB's `-epub-` prefixed CSS, restated in the properties the engine implements.
 *
 * The prefixed properties are retained by EPUB 3.4 as outdated features, defined in
 * EPUB 3.3 appendix E. A browser drops the ones it does not know at parse time, so
 * the authored declaration is gone from the CSSOM but still present in the `style`
 * attribute and in a `style` element's text. Each prefixed declaration found there
 * gains its unprefixed equivalent immediately after it, which keeps the cascade and
 * the authored order intact. Restating one the engine already aliases is harmless,
 * so the table is applied without asking what this engine knows.
 */

const prefix = /-epub-/iu;
const important = /\s*!\s*important\s*$/iu;

/** The prefixed properties EPUB 3.3 appendix E defines, each named after its own. */
const supported = new Set([
  "-epub-hyphens",
  "-epub-line-break",
  "-epub-text-align-last",
  "-epub-text-combine",
  "-epub-text-combine-horizontal",
  "-epub-text-emphasis-color",
  "-epub-text-emphasis-position",
  "-epub-text-emphasis-style",
  "-epub-text-orientation",
  "-epub-text-underline-position",
  "-epub-word-break",
  "-epub-writing-mode",
]);

/** The two whose unprefixed property is not the prefixed name without its prefix. */
const renamed: Record<string, string> = {
  "-epub-text-combine": "text-combine-upright",
  "-epub-text-combine-horizontal": "text-combine-upright",
};

/** Keywords CSS renamed, or `null` where it has none to offer. */
const keywords: Record<string, Record<string, string | null>> = {
  "-epub-hyphens": { all: null },
  "-epub-text-combine": { none: "none", horizontal: "all" },
  "-epub-text-combine-horizontal": { none: "none", all: "all" },
  "-epub-text-orientation": {
    "vertical-right": "mixed",
    "rotate-right": "sideways",
    "rotate-normal": "sideways",
  },
  "-epub-text-underline-position": { alphabetic: "auto" },
};

/** Properties whose prefixed grammar is only the keywords listed above. */
const closed = new Set(["-epub-text-combine", "-epub-text-combine-horizontal"]);

function mapValue(property: string, value: string): string | null {
  const replacements = keywords[property];
  if (replacements === undefined) return value;
  const keyword = value.toLowerCase();
  if (Object.hasOwn(replacements, keyword)) return replacements[keyword] ?? null;
  return closed.has(property) ? null : value;
}

/** `-epub-fullwidth` is a prefixed value rather than a property. */
function mapTextTransform(value: string): string | null {
  let replaced = false;
  const mapped = value.replaceAll(/\S+/gu, (token) => {
    if (token.toLowerCase() !== "-epub-fullwidth") return token;
    replaced = true;
    return "full-width";
  });
  return replaced ? mapped : null;
}

function mapDeclaration(property: string, value: string): string | null {
  const suffix = important.exec(value);
  const body = (suffix === null ? value : value.slice(0, suffix.index)).trim();
  const name = property.toLowerCase();
  if (body === "") return null;
  const target =
    name === "text-transform"
      ? name
      : supported.has(name)
        ? (renamed[name] ?? name.slice(6))
        : null;
  if (target === null) return null;
  const mapped = name === "text-transform" ? mapTextTransform(body) : mapValue(name, body);
  if (mapped === null) return null;
  return `${target}: ${mapped}${suffix === null ? "" : " !important"}`;
}

interface Insertion {
  readonly at: number;
  readonly text: string;
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

function skipComment(text: string, start: number): number {
  const end = text.indexOf("*/", start + 2);
  return end === -1 ? text.length : end + 2;
}

/**
 * Where each declaration in one block gains its unprefixed restatement, as an offset
 * into the text the block came from. Strings, comments and parentheses are stepped
 * over so a `url(data:…;base64,…)` or a quoted `-epub-` keeps its meaning.
 */
function declarationInsertions(block: string, offset: number): Insertion[] {
  const insertions: Insertion[] = [];
  let start = 0;
  let colon = -1;
  let parentheses = 0;
  let index = 0;
  const record = (end: number): void => {
    if (colon === -1) return;
    const property = block.slice(start, colon).trim();
    if (property.startsWith("--")) return;
    const value = block.slice(colon + 1, end);
    const mapped = mapDeclaration(property, value);
    if (mapped === null) return;
    const text = `;${mapped}`;
    // Immediately after the value rather than after the whitespace that follows it.
    const at = colon + 1 + value.trimEnd().length;
    // A second pass over an already mapped block would otherwise restate it again.
    if (!block.startsWith(text, at)) insertions.push({ at: offset + at, text });
  };
  while (index < block.length) {
    const character = block[index];
    if (character === "/" && block[index + 1] === "*") {
      index = skipComment(block, index);
      continue;
    }
    if (character === '"' || character === "'") {
      index = skipString(block, index);
      continue;
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (parentheses === 0 && character === ":" && colon === -1) colon = index;
    else if (parentheses === 0 && character === ";") {
      record(index);
      start = index + 1;
      colon = -1;
    }
    index += 1;
  }
  record(block.length);
  return insertions;
}

function applyInsertions(text: string, insertions: readonly Insertion[]): string {
  let output = text;
  for (const insertion of [...insertions].sort((left, right) => right.at - left.at)) {
    output = `${output.slice(0, insertion.at)}${insertion.text}${output.slice(insertion.at)}`;
  }
  return output;
}

/** The contents of one declaration block, such as a `style` attribute. */
export function rewriteDeclarationBlock(block: string): string | null {
  if (!prefix.test(block)) return null;
  const insertions = declarationInsertions(block, 0);
  return insertions.length === 0 ? null : applyInsertions(block, insertions);
}

/**
 * A whole stylesheet. A block that holds no block of its own is a declaration block:
 * that reads `@media`, `@supports` and `@keyframes` correctly without a table of
 * grouping at-rules, and an unbalanced block is left as authored.
 */
export function rewriteStyleSheet(text: string): string | null {
  if (!prefix.test(text)) return null;
  const open: { start: number; nested: boolean }[] = [];
  const insertions: Insertion[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "*") {
      index = skipComment(text, index);
      continue;
    }
    if (character === '"' || character === "'") {
      index = skipString(text, index);
      continue;
    }
    if (character === "{") {
      const parent = open.at(-1);
      if (parent !== undefined) parent.nested = true;
      open.push({ start: index + 1, nested: false });
    } else if (character === "}") {
      const block = open.pop();
      if (block !== undefined && !block.nested) {
        insertions.push(...declarationInsertions(text.slice(block.start, index), block.start));
      }
    }
    index += 1;
  }
  return insertions.length === 0 ? null : applyInsertions(text, insertions);
}

export function applyPrefixedCss(root: Document): number {
  let rewritten = 0;
  for (const element of root.querySelectorAll('[style*="-epub-" i]')) {
    const authored = element.getAttribute("style");
    const mapped = authored === null ? null : rewriteDeclarationBlock(authored);
    if (mapped === null) continue;
    element.setAttribute("style", mapped);
    rewritten += 1;
  }
  for (const element of root.getElementsByTagName("style")) {
    const mapped = rewriteStyleSheet(element.textContent ?? "");
    if (mapped === null) continue;
    element.textContent = mapped;
    rewritten += 1;
  }
  return rewritten;
}

/**
 * Maps the document once its authored content is parsed, before any layout is
 * reported. Content a publisher script adds later keeps the prefixed declarations
 * the engine dropped.
 */
export function installPrefixedCssMapping(): void {
  const apply = (): void => {
    applyPrefixedCss(document);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
    return;
  }
  apply();
}
