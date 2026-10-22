import { findXhtmlHeadInsertion } from "./xml-insertion-scanner.js";
import { decodeXmlUtf8, escapeXmlAttribute, insertXmlBytes } from "./xml-instrumentation.js";

const xhtmlNamespace = "http://www.w3.org/1999/xhtml";
const invalidAttributeMessage = "an injected XHTML attribute contains an invalid XML character";

export interface XhtmlInstrumentationOptions {
  readonly contentAgentUrl: string;
  readonly nestedPublicationBaseUrl?: string | null;
  readonly readerFontStylesheetUrl?: string | null;
  readonly nonce?: string | null;
}

export function instrumentXhtml(
  source: Uint8Array,
  options: XhtmlInstrumentationOptions,
): Uint8Array {
  const text = decodeXmlUtf8(source, "XHTML");
  return insertXmlBytes(source, text, findXhtmlHeadInsertion(text), injection(options));
}

function injection(options: XhtmlInstrumentationOptions): string {
  const nonce = options.nonce ?? null;
  const nonceAttribute =
    nonce === null ? "" : ` nonce="${escapeXmlAttribute(nonce, invalidAttributeMessage)}"`;
  const nestedPublicationBaseAttribute =
    options.nestedPublicationBaseUrl === undefined || options.nestedPublicationBaseUrl === null
      ? ""
      : ` data-epub-navigator-nested-publication-base-url="${escapeXmlAttribute(options.nestedPublicationBaseUrl, invalidAttributeMessage)}"`;
  const stylesheet =
    options.readerFontStylesheetUrl === undefined || options.readerFontStylesheetUrl === null
      ? ""
      : `<link xmlns="${xhtmlNamespace}" rel="stylesheet" href="${escapeXmlAttribute(options.readerFontStylesheetUrl, invalidAttributeMessage)}" data-epub-navigator-reader-font="reader-serif" />`;
  const agent = `<script xmlns="${xhtmlNamespace}" src="${escapeXmlAttribute(options.contentAgentUrl, invalidAttributeMessage)}"${nestedPublicationBaseAttribute}${nonceAttribute}></script>`;
  return `${stylesheet}${agent}`;
}
