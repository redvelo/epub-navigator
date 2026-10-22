import type {
  DocumentObservationFonts,
  DocumentObservationQuery,
  DocumentObservationQueryResult,
  DocumentObservationRequest,
  DocumentObservationResource,
  DocumentObservationResult,
} from "../agent-protocol/index.js";
import { MAX_OBSERVATION_FONTS, MAX_OBSERVATION_RESOURCES } from "../agent-protocol/index.js";
import { MAX_OBSERVATION_TEXT_CODE_UNITS } from "../agent-protocol/limits.js";

/**
 * A bounded, read-only look at the document for a diagnostic owner: what a query's
 * first match says, whether replaced content loaded, and which fonts the document
 * holds. The agent shares the publication's realm, so this is an observation of
 * what the publication presents, never a proof against a publication that lies.
 */
export function observeDocument(
  root: Document,
  request: DocumentObservationRequest,
): DocumentObservationResult {
  const result: {
    document: DocumentObservationResult["document"];
    queries: DocumentObservationQueryResult[];
    resources?: DocumentObservationResource[];
    fonts?: DocumentObservationFonts;
  } = {
    document: {
      title: root.title.slice(0, 512),
      lang: root.documentElement.getAttribute("lang") ?? "",
      dir: root.documentElement.getAttribute("dir") ?? "",
      readyState: root.readyState,
      contentType: root.contentType,
      svgRoot: root.documentElement.namespaceURI === "http://www.w3.org/2000/svg",
    },
    queries: request.queries.map((query) => observeQuery(root, query)),
  };
  if (request.resources) result.resources = observeResources(root);
  if (request.fonts) result.fonts = observeFonts(root);
  return result;
}

function scopeFor(
  root: Document,
  within: readonly string[] | undefined,
): Document | "cross-origin" | "no-frame" {
  let scope: Document = root;
  for (const selector of within ?? []) {
    const frame = select(scope, selector);
    if (
      !(
        frame instanceof HTMLIFrameElement ||
        frame instanceof HTMLObjectElement ||
        frame instanceof HTMLEmbedElement
      )
    ) {
      return "no-frame";
    }
    let nested: Document | null;
    try {
      nested = frame instanceof HTMLEmbedElement ? frame.getSVGDocument() : frame.contentDocument;
    } catch {
      return "cross-origin";
    }
    if (nested === null) return "cross-origin";
    scope = nested;
  }
  return scope;
}

function select(scope: Document, selector: string): Element | null {
  try {
    return scope.querySelector(selector);
  } catch {
    return null;
  }
}

function count(scope: Document, selector: string): number {
  try {
    return scope.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function observeQuery(
  root: Document,
  query: DocumentObservationQuery,
): DocumentObservationQueryResult {
  const scope = scopeFor(root, query.within);
  if (typeof scope === "string") return { id: query.id, inaccessible: scope };
  const matches = count(scope, query.selector);
  const element = matches === 0 ? null : select(scope, query.selector);
  if (element === null) return { id: query.id, matches: 0, first: null };
  const first: {
    text?: string;
    styles?: Record<string, string>;
    rect?: { x: number; y: number; width: number; height: number };
    attributes?: Record<string, string | null>;
  } = {};
  if (query.text === true) {
    first.text = (element.textContent ?? "").trim().slice(0, MAX_OBSERVATION_TEXT_CODE_UNITS);
  }
  if (query.styles !== undefined) {
    const view = scope.defaultView;
    const computed = view === null ? null : view.getComputedStyle(element);
    const styles: Record<string, string> = {};
    for (const property of query.styles) {
      styles[property] = computed === null ? "" : computed.getPropertyValue(property).slice(0, 512);
    }
    first.styles = styles;
  }
  if (query.rect === true) {
    const rect = element.getBoundingClientRect();
    first.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  if (query.attributes !== undefined) {
    const attributes: Record<string, string | null> = {};
    for (const name of query.attributes) {
      const value = element.getAttribute(name);
      attributes[name] = value === null ? null : value.slice(0, 512);
    }
    first.attributes = attributes;
  }
  return { id: query.id, matches, first };
}

function sourceOf(element: Element): string {
  const value = element.getAttribute("src") ?? element.getAttribute("href") ?? "";
  return value.slice(0, 512);
}

function observeResources(root: Document): DocumentObservationResource[] {
  const resources: DocumentObservationResource[] = [];
  for (const element of root.querySelectorAll("img, video, audio")) {
    if (resources.length >= MAX_OBSERVATION_RESOURCES) break;
    if (element instanceof HTMLImageElement) {
      resources.push({
        kind: "image",
        source: sourceOf(element),
        state: element.complete ? (element.naturalWidth > 0 ? "loaded" : "failed") : "pending",
        naturalWidth: element.naturalWidth,
        naturalHeight: element.naturalHeight,
      });
    } else if (element instanceof HTMLMediaElement) {
      resources.push({
        kind: "media",
        source: sourceOf(element),
        state: element.error !== null ? "failed" : element.readyState >= 1 ? "loaded" : "pending",
        readyState: element.readyState,
      });
    }
  }
  return resources;
}

function observeFonts(root: Document): DocumentObservationFonts {
  const loaded: string[] = [];
  const fonts = root.fonts as FontFaceSet | undefined;
  if (fonts === undefined) return { status: "loaded", loaded };
  for (const face of fonts) {
    if (loaded.length >= MAX_OBSERVATION_FONTS) break;
    if (face.status === "loaded") loaded.push(face.family.slice(0, 512));
  }
  return { status: fonts.status, loaded };
}
