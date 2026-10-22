import { isXmlCodePoint, XmlInstrumentationError } from "./xml-instrumentation.js";

const qnamePattern = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/u;
const xhtmlNamespace = "http://www.w3.org/1999/xhtml";
const svgNamespace = "http://www.w3.org/2000/svg";

interface StartTag {
  readonly name: string;
  readonly end: number;
  readonly selfClosing: boolean;
  readonly namespaceDeclarations: ReadonlyMap<string, string>;
}

interface ScanTarget {
  readonly documentName: "XHTML" | "SVG";
  readonly namespace: string;
  readonly rootName: "html" | "svg";
  readonly childName?: "head";
}

const xhtmlTarget: ScanTarget = {
  documentName: "XHTML",
  namespace: xhtmlNamespace,
  rootName: "html",
  childName: "head",
};
const svgTarget: ScanTarget = {
  documentName: "SVG",
  namespace: svgNamespace,
  rootName: "svg",
};

export function findXhtmlHeadInsertion(text: string): number {
  return findInsertion(text, xhtmlTarget);
}

export function findSvgRootInsertion(text: string): number {
  return findInsertion(text, svgTarget);
}

function findInsertion(text: string, target: ScanTarget): number {
  const stack: string[] = [];
  let rootNamespaces: ReadonlyMap<string, string> | undefined;
  let cursor = 0;
  let rootSeen = false;

  while (cursor < text.length) {
    // Character data is skipped, not judged: whether an entity resolves or a code point is legal
    // decides whether the browser parses this document, which it decides for itself. Refusing
    // here would withhold a document a browser renders.
    const opening = text.indexOf("<", cursor);
    if (opening < 0) break;

    if (text.startsWith("<!--", opening)) {
      cursor = commentEnd(text, opening, target);
      continue;
    }
    if (text.startsWith("<![CDATA[", opening)) {
      if (stack.length === 0) throw malformed(target, "CDATA precedes the root");
      cursor = requiredTerminator(text, opening + 9, "]]>", target);
      continue;
    }
    if (text.startsWith("<?", opening)) {
      cursor = processingInstructionEnd(text, opening, target);
      continue;
    }
    if (text.startsWith("<!DOCTYPE", opening)) {
      cursor = doctypeEnd(text, opening, target);
      continue;
    }
    if (text.startsWith("<!", opening)) {
      throw malformed(target, "an unsupported declaration precedes the insertion point");
    }
    if (text.startsWith("</", opening)) {
      const closing = parseClosingTag(text, opening, target);
      const current = stack.pop();
      if (current === undefined || current !== closing.name) {
        throw malformed(target, "element tags before the insertion point are mismatched");
      }
      cursor = closing.end;
      if (stack.length === 0 && target.childName !== undefined) {
        throw missingHead();
      }
      continue;
    }

    const start = parseStartTag(text, opening, target);
    if (stack.length === 0) {
      if (rootSeen) throw malformed(target, "more than one root precedes the insertion point");
      rootSeen = true;
      rootNamespaces = applyNamespaces(undefined, start.namespaceDeclarations);
      if (
        localName(start.name) !== target.rootName ||
        namespaceFor(start.name, rootNamespaces) !== target.namespace
      ) {
        throw malformed(target, `the root is not ${target.rootName} in the required namespace`);
      }
      if (start.selfClosing) throw malformed(target, "the root is self-closing");
      if (target.childName === undefined) return start.end;
    } else {
      if (localName(start.name) === "script") {
        throw malformed(target, "a script element precedes the XHTML insertion point");
      }
      if (stack.length === 1 && localName(start.name) === target.childName) {
        const namespaces = applyNamespaces(rootNamespaces, start.namespaceDeclarations);
        if (namespaceFor(start.name, namespaces) === target.namespace) {
          if (start.selfClosing) throw malformed(target, "the XHTML head is self-closing");
          return start.end;
        }
      }
    }

    if (!start.selfClosing) stack.push(start.name);
    cursor = start.end;
  }

  if (target.childName !== undefined && rootSeen) throw missingHead();
  if (target.childName !== undefined) throw malformed(target, "the XHTML document has no root");
  throw new XmlInstrumentationError("the SVG document has no root element");
}

function parseStartTag(text: string, opening: number, target: ScanTarget): StartTag {
  let cursor = opening + 1;
  const name = readQualifiedName(text, cursor, target);
  cursor += name.length;
  const namespaceDeclarations = new Map<string, string>();

  for (;;) {
    const beforeWhitespace = cursor;
    cursor = skipWhitespace(text, cursor);
    if (text[cursor] === ">") {
      return { name, end: cursor + 1, selfClosing: false, namespaceDeclarations };
    }
    if (text[cursor] === "/" && text[cursor + 1] === ">") {
      return { name, end: cursor + 2, selfClosing: true, namespaceDeclarations };
    }
    if (cursor === beforeWhitespace) throw malformed(target, "a start tag is malformed");

    const attributeName = readQualifiedName(text, cursor, target);
    cursor = skipWhitespace(text, cursor + attributeName.length);
    if (text[cursor] !== "=") throw malformed(target, "an attribute has no value");
    cursor = skipWhitespace(text, cursor + 1);
    const quote = text[cursor];
    if (quote !== '"' && quote !== "'") throw malformed(target, "an attribute is unquoted");
    const valueEnd = text.indexOf(quote, cursor + 1);
    if (valueEnd < 0) throw malformed(target, "an attribute value is unterminated");
    const value = text.slice(cursor + 1, valueEnd);

    const namespacePrefix =
      attributeName === "xmlns"
        ? ""
        : attributeName.startsWith("xmlns:")
          ? attributeName.slice(6)
          : null;
    if (namespacePrefix !== null) {
      // Resolved, not validated: the mapping is needed to tell an XHTML head from a foreign one.
      namespaceDeclarations.set(namespacePrefix, decodeEntities(value, target));
    }
    cursor = valueEnd + 1;
  }
}

function parseClosingTag(
  text: string,
  opening: number,
  target: ScanTarget,
): { readonly name: string; readonly end: number } {
  const name = readQualifiedName(text, opening + 2, target);
  const cursor = skipWhitespace(text, opening + 2 + name.length);
  if (text[cursor] !== ">") throw malformed(target, "a closing tag is malformed");
  return { name, end: cursor + 1 };
}

function readQualifiedName(text: string, from: number, target: ScanTarget): string {
  let end = from;
  while (end < text.length && !/[\t\n\r /=><!?"']/u.test(text[end]!)) end += 1;
  const name = text.slice(from, end);
  if (!qnamePattern.test(name)) throw malformed(target, "an XML name is ambiguous or unsupported");
  return name;
}

function applyNamespaces(
  parent: ReadonlyMap<string, string> | undefined,
  declarations: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const namespaces = new Map(parent);
  for (const [prefix, namespace] of declarations) namespaces.set(prefix, namespace);
  return namespaces;
}

const xmlNamespace = "http://www.w3.org/XML/1998/namespace";

function namespaceFor(name: string, namespaces: ReadonlyMap<string, string>): string {
  // The `xml` prefix is bound by the XML specification and cannot be rebound, so a document that
  // tries resolves the same way here as it does in a parser: not to the XHTML namespace.
  const prefix = prefixOf(name);
  if (prefix === "xml") return xmlNamespace;
  return namespaces.get(prefix ?? "") ?? "";
}

function decodeEntities(value: string, target: ScanTarget): string {
  return value.replaceAll(/&([^;]+);/gu, (_reference, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    return String.fromCodePoint(decodeNumericEntity(`&${body};`, target));
  });
}

function decodeNumericEntity(reference: string, target: ScanTarget): number {
  const hexadecimal = reference.startsWith("&#x");
  const digits = reference.slice(hexadecimal ? 3 : 2, -1);
  const point = Number.parseInt(digits, hexadecimal ? 16 : 10);
  if (!isXmlCodePoint(point)) throw malformed(target, "a numeric entity is not an XML character");
  return point;
}

/** Finds the end of a comment so an injection cannot land inside one. */
function commentEnd(text: string, opening: number, target: ScanTarget): number {
  return requiredTerminator(text, opening + 4, "-->", target);
}

function requiredTerminator(
  text: string,
  from: number,
  terminator: string,
  target: ScanTarget,
): number {
  const end = text.indexOf(terminator, from);
  if (end < 0) throw malformed(target, `an unterminated ${terminator} structure was scanned`);
  return end + terminator.length;
}

function processingInstructionEnd(text: string, opening: number, target: ScanTarget): number {
  const name = readQualifiedName(text, opening + 2, target);
  const nameEnd = opening + 2 + name.length;
  if (text[nameEnd] !== "?" && !isXmlWhitespace(text[nameEnd] ?? "")) {
    throw malformed(target, "a processing instruction is malformed");
  }
  const end = requiredTerminator(text, nameEnd, "?>", target);
  // A CSS or page-template stylesheet leaves this document alone. An XSLT stylesheet replaces the
  // document the browser builds, discarding the injection and leaving a frame with no agent.
  if (name.toLowerCase() === "xml-stylesheet" && declaresXslt(text.slice(nameEnd, end))) {
    throw malformed(target, "an XSLT stylesheet would replace the document before the agent runs");
  }
  return end;
}

/**
 * Whether an `xml-stylesheet` instruction names an XSLT transform.
 *
 * A declared XSLT type settles it; absent a type, an `.xsl` or `.xslt` href is treated as one,
 * because guessing wrong that way reports a document that cannot work, where guessing the other
 * way serves a frame that silently never starts.
 */
function declaresXslt(pseudoAttributes: string): boolean {
  const lowered = pseudoAttributes.toLowerCase();
  if (lowered.includes("text/xsl") || lowered.includes("application/xslt+xml")) return true;
  return (
    !lowered.includes("type=") &&
    lowered.split(/["']/u).some((value) => value.endsWith(".xsl") || value.endsWith(".xslt"))
  );
}

/**
 * Skips the doctype declaration, whatever it declares.
 *
 * An internal subset is how an older XHTML publication declares the named entities it then uses,
 * and browsers never fetch an external identifier, so neither is this scanner's business: it only
 * needs to know where the declaration ends. Quoted literals and the internal subset are tracked
 * for exactly that reason.
 */
function doctypeEnd(text: string, opening: number, target: ScanTarget): number {
  let cursor = opening + "<!DOCTYPE".length;
  const next = text[cursor];
  if (next === undefined || !(isXmlWhitespace(next) || next === ">")) {
    throw malformed(target, "a declaration is unsupported");
  }
  const literalEnd = (from: number): number => {
    const quote = text[from]!;
    const end = text.indexOf(quote, from + 1);
    if (end < 0) throw malformed(target, "a doctype declaration is unterminated");
    return end + 1;
  };
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (character === ">") return cursor + 1;
    if (character === '"' || character === "'") {
      cursor = literalEnd(cursor);
    } else if (character === "[") {
      cursor += 1;
      while (cursor < text.length && text[cursor] !== "]") {
        cursor = text[cursor] === '"' || text[cursor] === "'" ? literalEnd(cursor) : cursor + 1;
      }
      if (cursor >= text.length) throw malformed(target, "a doctype declaration is unterminated");
      cursor += 1;
    } else {
      cursor += 1;
    }
  }
  throw malformed(target, "a doctype declaration is unterminated");
}

function prefixOf(name: string): string | null {
  const separator = name.indexOf(":");
  return separator < 0 ? null : name.slice(0, separator);
}

function localName(name: string): string {
  const separator = name.indexOf(":");
  return separator < 0 ? name : name.slice(separator + 1);
}

function skipWhitespace(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length && isXmlWhitespace(text[cursor]!)) cursor += 1;
  return cursor;
}

function isXmlWhitespace(value: string): boolean {
  return /^[\t\n\r ]*$/u.test(value);
}

function missingHead(): XmlInstrumentationError {
  return new XmlInstrumentationError("the XHTML document has no direct head element");
}

function malformed(target: ScanTarget, detail: string): XmlInstrumentationError {
  return new XmlInstrumentationError(
    `the ${target.documentName} document is unsafe to instrument: ${detail}`,
  );
}
