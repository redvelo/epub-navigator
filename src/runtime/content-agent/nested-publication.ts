const nestedPublicationBaseAttribute = "data-epub-navigator-nested-publication-base-url";

export function validateNestedPublicationBaseUrl(
  value: string | null,
  currentDocumentUrl: URL,
): URL | null {
  if (value === null || value === "" || value.includes("?") || value.includes("#")) return null;

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.origin === currentDocumentUrl.origin
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Elements that embed a publication document as a nested navigable. An `object` or
 * `embed` whose resource is an image loads as an image, not a navigable, and stays
 * on the publication origin.
 */
export type NestedPublicationEmbed = HTMLIFrameElement | HTMLObjectElement | HTMLEmbedElement;

const documentTypes = new Set(["application/xhtml+xml", "image/svg+xml", "text/html"]);
const documentExtensions = /\.(?:xhtml|html|htm|svg)$/iu;

function embedSourceAttribute(element: NestedPublicationEmbed): "src" | "data" {
  return element instanceof HTMLObjectElement ? "data" : "src";
}

function embedsDocument(element: NestedPublicationEmbed, resolved: URL): boolean {
  if (element instanceof HTMLIFrameElement) return true;
  const type = element.getAttribute("type")?.trim().toLowerCase().split(";")[0] ?? "";
  if (type !== "") return documentTypes.has(type);
  return documentExtensions.test(resolved.pathname);
}

export function projectLocalEmbedUrl(
  element: NestedPublicationEmbed,
  currentDocumentUrl: URL,
  nestedPublicationBaseUrl: URL,
): void {
  if (element instanceof HTMLIFrameElement && element.hasAttribute("srcdoc")) return;

  const attribute = embedSourceAttribute(element);
  const authored = element.getAttribute(attribute);
  if (authored === null || authored.trim() === "") return;

  try {
    const resolved = new URL(authored, element.ownerDocument.baseURI);
    if (
      (resolved.protocol !== "http:" && resolved.protocol !== "https:") ||
      resolved.origin !== currentDocumentUrl.origin ||
      !embedsDocument(element, resolved)
    ) {
      return;
    }

    element.setAttribute(
      attribute,
      `${nestedPublicationBaseUrl.origin}${resolved.pathname}${resolved.search}${resolved.hash}`,
    );
    // An iframe navigates when its src changes, but an object or embed whose first load the
    // publication CSP refused stays on its fallback content; only a fresh insertion runs its
    // representation steps against the projected URL.
    if (!(element instanceof HTMLIFrameElement) && element.isConnected) {
      element.replaceWith(element.cloneNode(true));
    }
  } catch {
    // An invalid authored URL remains untouched.
  }
}

function isNestedPublicationEmbed(node: Node): node is NestedPublicationEmbed {
  return (
    node instanceof HTMLIFrameElement ||
    node instanceof HTMLObjectElement ||
    node instanceof HTMLEmbedElement
  );
}

export function installNestedPublicationProjection(): MutationObserver | null {
  const currentDocumentUrl = new URL(document.URL);
  const nestedPublicationBaseUrl = validateNestedPublicationBaseUrl(
    document.currentScript?.getAttribute(nestedPublicationBaseAttribute) ?? null,
    currentDocumentUrl,
  );
  if (nestedPublicationBaseUrl === null) return null;

  const project = (element: NestedPublicationEmbed): void =>
    projectLocalEmbedUrl(element, currentDocumentUrl, nestedPublicationBaseUrl);
  const projectTree = (node: Node): void => {
    if (!(node instanceof Element)) return;
    if (isNestedPublicationEmbed(node)) project(node);
    for (const element of node.querySelectorAll("iframe, object, embed")) {
      if (isNestedPublicationEmbed(element)) project(element);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) projectTree(node);
    }
  });
  observer.observe(document, { childList: true, subtree: true });
  projectTree(document.documentElement);
  return observer;
}
