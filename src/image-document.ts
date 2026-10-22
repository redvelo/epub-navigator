/** Explicit host alternate representation; the archive resource remains the logical document. */
export const imageDocumentQuery = "epub-navigator-image-document=1";

export function imageDocumentUrl(resourceUrl: string): string {
  const url = new URL(resourceUrl);
  if (url.search || url.hash) throw new Error("image resource URL must be canonical");
  url.search = imageDocumentQuery;
  return url.href;
}

/** Host-only XML generation with one escaped URL, never publication-supplied markup. */
export function imageDocumentSource(resourceUrl: string): Uint8Array {
  const url = new URL(resourceUrl);
  if (url.search || url.hash || !["http:", "https:"].includes(url.protocol))
    throw new Error("image resource URL must be canonical HTTP(S)");
  const escaped = url.href.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!,
  );
  return new TextEncoder().encode(
    `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" data-epub-navigator-image-document="1"><head><title></title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><img src="${escaped}" alt="" /></body></html>`,
  );
}
