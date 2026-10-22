const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf]);

export class XmlInstrumentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlInstrumentationError";
  }
}

export function decodeXmlUtf8(source: Uint8Array, documentName: "XHTML" | "SVG"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new XmlInstrumentationError(`the ${documentName} document is not valid UTF-8`);
  }
}

export function insertXmlBytes(
  source: Uint8Array,
  text: string,
  insertion: number,
  markup: string,
): Uint8Array {
  const injected = new TextEncoder().encode(markup);
  const bomLength = hasUtf8Bom(source) ? utf8Bom.byteLength : 0;
  const sourceOffset = bomLength + new TextEncoder().encode(text.slice(0, insertion)).byteLength;
  const transformed = new Uint8Array(source.byteLength + injected.byteLength);
  transformed.set(source.subarray(0, sourceOffset));
  transformed.set(injected, sourceOffset);
  transformed.set(source.subarray(sourceOffset), sourceOffset + injected.byteLength);
  return transformed;
}

export function escapeXmlAttribute(value: string, invalidCharacterMessage: string): string {
  assertXmlCharacters(value, invalidCharacterMessage);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("\t", "&#x9;")
    .replaceAll("\n", "&#xA;")
    .replaceAll("\r", "&#xD;");
}

export function assertXmlCharacters(value: string, message: string): void {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined || !isXmlCodePoint(point)) {
      throw new XmlInstrumentationError(message);
    }
  }
}

export function isXmlCodePoint(point: number): boolean {
  return (
    point === 0x9 ||
    point === 0xa ||
    point === 0xd ||
    (point >= 0x20 && point <= 0xd7ff) ||
    (point >= 0xe000 && point <= 0xfffd) ||
    (point >= 0x10000 && point <= 0x10ffff)
  );
}

function hasUtf8Bom(source: Uint8Array): boolean {
  return source[0] === utf8Bom[0] && source[1] === utf8Bom[1] && source[2] === utf8Bom[2];
}
