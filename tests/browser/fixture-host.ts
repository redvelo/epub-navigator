import { instrumentSvg } from "../../src/svg-instrumentation.js";
import { instrumentXhtml } from "../../src/xhtml-instrumentation.js";
import { imageDocumentSource } from "../../src/image-document.js";

export function instrumentFixtureImageDocument(resourceUrl: string): Uint8Array {
  return instrumentFixtureXhtml(imageDocumentSource(resourceUrl));
}

export const fixtureContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function instrumentFixtureXhtml(
  source: Uint8Array,
  agentRoute = "/_epub-navigator/content-agent.js",
): Uint8Array {
  return instrumentXhtml(source, { contentAgentUrl: agentRoute });
}

export function instrumentFixtureSvg(
  source: Uint8Array,
  agentRoute: string,
  nonce: string | null,
): Uint8Array {
  return instrumentSvg(source, { contentAgentUrl: agentRoute, nonce });
}

export function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (
    {
      xhtml: "application/xhtml+xml; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "text/javascript; charset=utf-8",
      svg: "image/svg+xml",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      avif: "image/avif",
      woff2: "font/woff2",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      wav: "audio/wav",
      json: "application/json; charset=utf-8",
      xml: "application/xml; charset=utf-8",
      opf: "application/oebps-package+xml; charset=utf-8",
    }[extension] ?? "application/octet-stream"
  );
}
