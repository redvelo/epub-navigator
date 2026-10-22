import { findSvgRootInsertion } from "./xml-insertion-scanner.js";
import { decodeXmlUtf8, escapeXmlAttribute, insertXmlBytes } from "./xml-instrumentation.js";

const svgNamespace = "http://www.w3.org/2000/svg";
const invalidAttributeMessage = "an injected SVG attribute contains an invalid XML character";

export interface SvgInstrumentationOptions {
  readonly contentAgentUrl: string;
  readonly nestedPublicationBaseUrl?: string | null;
  readonly nonce?: string | null;
}

export function instrumentSvg(source: Uint8Array, options: SvgInstrumentationOptions): Uint8Array {
  const text = decodeXmlUtf8(source, "SVG");
  return insertXmlBytes(source, text, findSvgRootInsertion(text), injection(options));
}

function injection(options: SvgInstrumentationOptions): string {
  const nonce = options.nonce ?? null;
  const nonceAttribute =
    nonce === null ? "" : ` nonce="${escapeXmlAttribute(nonce, invalidAttributeMessage)}"`;
  const nestedPublicationBaseAttribute =
    options.nestedPublicationBaseUrl === undefined || options.nestedPublicationBaseUrl === null
      ? ""
      : ` data-epub-navigator-nested-publication-base-url="${escapeXmlAttribute(options.nestedPublicationBaseUrl, invalidAttributeMessage)}"`;
  return `<script xmlns="${svgNamespace}" href="${escapeXmlAttribute(options.contentAgentUrl, invalidAttributeMessage)}"${nestedPublicationBaseAttribute}${nonceAttribute}></script>`;
}
