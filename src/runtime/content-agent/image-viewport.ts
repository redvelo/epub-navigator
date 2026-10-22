import type { FixedViewportResolution } from "./fixed-viewport.js";

/** Called after the frame load event: failed decoding is a terminal, recoverable layout outcome. */
export function resolveImageIntrinsicViewport(document: Document): FixedViewportResolution {
  const root = document.documentElement;
  const images = document.getElementsByTagNameNS("http://www.w3.org/1999/xhtml", "img");
  const image = images[0];
  if (
    root.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
    root.localName !== "html" ||
    root.getAttribute("data-epub-navigator-image-document") !== "1" ||
    images.length !== 1 ||
    !(image instanceof HTMLImageElement)
  ) {
    return { status: "unavailable", issue: "intrinsic-viewport-invalid" };
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (
    !image.complete ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return { status: "unavailable", issue: "image-load-failed" };
  if (root.getAttribute("data-epub-navigator-viewport-source") !== "image-natural")
    root.setAttribute("data-epub-navigator-viewport-source", "image-natural");
  return { status: "resolved", viewport: { width, height, source: "image-natural" } };
}
