import { decodePublicationRoute } from "../mount.js";
import { instrumentSvg } from "../svg-instrumentation.js";
import { instrumentXhtml } from "../xhtml-instrumentation.js";
import { imageDocumentQuery, imageDocumentSource } from "../image-document.js";
import {
  factsCacheRequest,
  isPublicationId,
  isResourceManifest,
  localCacheName,
  manifestCacheRequest,
  markerCacheRequest,
  responseForText,
  resourceCacheRequest,
  sourceCacheRequest,
} from "./storage.js";
import {
  localServiceWorkerCacheName,
  localServiceWorkerConfigurationRequest,
} from "./service-worker-protocol.js";
import type {
  LocalServiceWorkerConfiguration,
  LocalServiceWorkerMessage,
} from "./service-worker-protocol.js";

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends Event {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

interface ServiceWorkerGlobalLike {
  addEventListener(type: "install", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<LocalServiceWorkerMessage>) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  readonly location: Location;
  readonly crypto: Crypto;
}

const serviceWorker = globalThis as unknown as ServiceWorkerGlobalLike;
let configuration: LocalServiceWorkerConfiguration | undefined;
const configurationLoaded = loadConfiguration();
let configurationUpdate: Promise<void> = Promise.resolve();

serviceWorker.addEventListener("install", (event) => {
  event.waitUntil(serviceWorker.skipWaiting());
});

serviceWorker.addEventListener("activate", (event) => {
  event.waitUntil(serviceWorker.clients.claim());
});

serviceWorker.addEventListener("message", (event) => {
  if (event.data.type !== "configure" || !isTrustedConfigurationMessage(event)) return;
  const message = event.data;
  const update = configurationUpdate.then(async () => {
    await configurationLoaded;
    const next = validateConfiguration(message);
    if (
      configuration !== undefined &&
      (configuration.mountBaseUrl !== next.mountBaseUrl ||
        configuration.measurementMountBaseUrl !== next.measurementMountBaseUrl)
    ) {
      throw new Error("the service-worker mount base is already configured");
    }
    await persistConfiguration(next);
    configuration = next;
  });
  configurationUpdate = update.then(
    () => undefined,
    () => undefined,
  );
  void update.then(
    () => event.ports[0]?.postMessage({ type: "configured" }),
    (cause: unknown) =>
      event.ports[0]?.postMessage({
        type: "configuration-error",
        message: errorMessage(cause, "the local service-worker configuration is invalid"),
      }),
  );
});

serviceWorker.addEventListener("fetch", (event) => {
  event.respondWith(serveConfiguredRequest(event.request));
});

async function serveConfiguredRequest(request: Request): Promise<Response> {
  await configurationLoaded;
  await configurationUpdate;
  const currentConfiguration = configuration;
  if (currentConfiguration === undefined) return fetch(request);
  const url = new URL(request.url);
  const foregroundBase = new URL(currentConfiguration.mountBaseUrl);
  const measurementBase = new URL(currentConfiguration.measurementMountBaseUrl);
  if (url.origin !== foregroundBase.origin) return fetch(request);
  if (url.pathname.startsWith(measurementBase.pathname)) {
    return servePublicationRequest(
      request,
      currentConfiguration,
      "measurement",
      currentConfiguration.measurementMountBaseUrl,
    );
  }
  if (url.pathname.startsWith(foregroundBase.pathname)) {
    return servePublicationRequest(
      request,
      currentConfiguration,
      "foreground",
      currentConfiguration.mountBaseUrl,
    );
  }
  return fetch(request);
}

async function servePublicationRequest(
  request: Request,
  currentConfiguration: LocalServiceWorkerConfiguration,
  profile: "foreground" | "measurement",
  mountBaseUrl: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "publication resources only support GET and HEAD");
  }
  const url = new URL(request.url);
  const imageDocument = url.search === `?${imageDocumentQuery}`;
  if (url.search.length > 0 && !imageDocument)
    return errorResponse(400, "publication routes cannot contain a query");
  if (request.headers.has("range") && !imageDocument) {
    return errorResponse(416, "range requests are not supported by the local demo host");
  }

  let route: string;
  try {
    route = decodePublicationRoute(mountBaseUrl, url.pathname);
  } catch {
    return errorResponse(400, "the publication route is invalid");
  }
  const [id, ...pathSegments] = route.split("/");
  const path = pathSegments.join("/");
  if (id === undefined || !isPublicationId(id) || path.length === 0) {
    return errorResponse(404, "the publication resource was not found");
  }
  if (!(await caches.has(localCacheName(id)))) {
    return errorResponse(404, "the local publication is unavailable");
  }

  const cache = await caches.open(localCacheName(id));
  const markerResponse = await cache.match(markerCacheRequest(id));
  const factsResponse = await cache.match(factsCacheRequest(id));
  const manifestResponse = await cache.match(manifestCacheRequest(id));
  const sourceResponse = await cache.match(sourceCacheRequest(id));
  if (
    markerResponse === undefined ||
    factsResponse === undefined ||
    manifestResponse === undefined ||
    sourceResponse === undefined
  ) {
    return errorResponse(410, "the local publication import is incomplete");
  }
  const marker = await readJson(markerResponse);
  const manifest = await readJson(manifestResponse);
  if (
    !isRecord(marker) ||
    marker.id !== id ||
    typeof marker.sourceSizeBytes !== "number" ||
    !Number.isFinite(marker.importedAt) ||
    !isResourceManifest(manifest)
  ) {
    return errorResponse(410, "the local publication metadata is invalid");
  }
  const resource = manifest.resources.find((candidate) => candidate.path === path);
  if (resource === undefined) return errorResponse(404, "the publication resource was not found");
  if (
    imageDocument &&
    (profile !== "foreground" || resource.responseInstrumentation !== "fixed-image")
  )
    return errorResponse(403, "image document is not an effective roll frame");
  if (
    profile === "measurement" &&
    resource.responseInstrumentation !== "none" &&
    resource.responseInstrumentation !== "fixed-image" &&
    resource.executableContent !== "analyzed-absent"
  ) {
    return errorResponse(
      403,
      "the publication document is not eligible for background measurement",
    );
  }

  const cached = await cache.match(resourceCacheRequest(id, path));
  if (cached === undefined) return errorResponse(410, "the publication resource was evicted");
  const nonce = profile === "measurement" ? responseNonce() : null;
  const contentSecurityPolicy = contentSecurityPolicyFor(profile, nonce);
  const raw =
    resource.responseInstrumentation === "none" ||
    (resource.responseInstrumentation === "fixed-image" && !imageDocument);
  if (request.method === "HEAD" && raw) {
    return responseHeaders(cached, resource.mediaType, null, contentSecurityPolicy);
  }
  if (raw) {
    return responseHeaders(cached, resource.mediaType, cached.body, contentSecurityPolicy);
  }

  let source: Uint8Array;
  try {
    url.search = "";
    source = imageDocument
      ? imageDocumentSource(url.href)
      : new Uint8Array(await cached.arrayBuffer());
  } catch {
    return errorResponse(500, "the publication document could not be read");
  }
  let transformed: Uint8Array;
  try {
    transformed =
      resource.responseInstrumentation === "svg"
        ? instrumentSvg(source, {
            contentAgentUrl: currentConfiguration.contentAgentUrl,
            nonce,
          })
        : instrumentXhtml(source, {
            contentAgentUrl: currentConfiguration.contentAgentUrl,
            readerFontStylesheetUrl: currentConfiguration.readerFontStylesheetUrl,
            nonce,
          });
  } catch (cause) {
    return errorResponse(
      422,
      errorMessage(cause, "the publication document could not be instrumented"),
    );
  }
  const headers = new Headers({
    "Content-Type":
      resource.responseInstrumentation === "svg"
        ? resource.mediaType
        : "application/xhtml+xml; charset=utf-8",
    "Content-Security-Policy": contentSecurityPolicy,
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "none",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(transformed.byteLength),
  });
  return new Response(request.method === "HEAD" ? null : (transformed as unknown as BodyInit), {
    headers,
  });
}

async function loadConfiguration(): Promise<void> {
  try {
    const cache = await caches.open(localServiceWorkerCacheName);
    const response = await cache.match(localServiceWorkerConfigurationRequest());
    if (response === undefined) return;
    const value = await readJson(response);
    if (!isConfiguration(value)) return;
    configuration = validateConfiguration(value);
  } catch {
    configuration = undefined;
  }
}

async function persistConfiguration(next: LocalServiceWorkerConfiguration): Promise<void> {
  const cache = await caches.open(localServiceWorkerCacheName);
  await cache.put(localServiceWorkerConfigurationRequest(), responseForText(JSON.stringify(next)));
}

function isTrustedConfigurationMessage(event: MessageEvent<LocalServiceWorkerMessage>): boolean {
  if (event.origin !== serviceWorker.location.origin || event.source === null) return false;
  const source = event.source as { readonly id?: unknown };
  return typeof source.id === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isConfiguration(value: unknown): value is LocalServiceWorkerConfiguration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "configure" &&
    typeof (value as { mountBaseUrl?: unknown }).mountBaseUrl === "string" &&
    typeof (value as { measurementMountBaseUrl?: unknown }).measurementMountBaseUrl === "string" &&
    typeof (value as { contentAgentUrl?: unknown }).contentAgentUrl === "string" &&
    ((value as { readerFontStylesheetUrl?: unknown }).readerFontStylesheetUrl === null ||
      typeof (value as { readerFontStylesheetUrl?: unknown }).readerFontStylesheetUrl === "string")
  );
}

function validateConfiguration(
  value: LocalServiceWorkerConfiguration,
): LocalServiceWorkerConfiguration {
  const mount = new URL(value.mountBaseUrl);
  const measurementMount = new URL(value.measurementMountBaseUrl);
  const agent = new URL(value.contentAgentUrl);
  const readerFonts =
    value.readerFontStylesheetUrl === null ? null : new URL(value.readerFontStylesheetUrl);
  if (
    (mount.protocol !== "http:" && mount.protocol !== "https:") ||
    mount.search.length > 0 ||
    mount.hash.length > 0 ||
    !mount.pathname.endsWith("/") ||
    measurementMount.origin !== mount.origin ||
    measurementMount.search.length > 0 ||
    measurementMount.hash.length > 0 ||
    !measurementMount.pathname.endsWith("/") ||
    measurementMount.pathname === mount.pathname ||
    measurementMount.pathname.startsWith(mount.pathname) ||
    mount.pathname.startsWith(measurementMount.pathname) ||
    agent.origin !== mount.origin ||
    (readerFonts !== null &&
      (readerFonts.origin !== mount.origin ||
        (readerFonts.protocol !== "http:" && readerFonts.protocol !== "https:") ||
        readerFonts.username.length > 0 ||
        readerFonts.password.length > 0)) ||
    agent.pathname.startsWith(mount.pathname) ||
    agent.pathname.startsWith(measurementMount.pathname)
  ) {
    throw new Error("the local service-worker configuration must use one queryless origin");
  }
  return value;
}

function responseHeaders(
  response: Response,
  contentType: string,
  body: BodyInit | null = null,
  contentSecurityPolicy = publicationDocumentContentSecurityPolicy,
): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", contentType);
  headers.set("Content-Security-Policy", contentSecurityPolicy);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Accept-Ranges", "none");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": publicationDocumentContentSecurityPolicy,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

const publicationDocumentContentSecurityPolicy =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; connect-src 'none'; " +
  "frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; " +
  "base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-same-origin";

function contentSecurityPolicyFor(
  profile: "foreground" | "measurement",
  nonce: string | null,
): string {
  if (profile === "foreground") return publicationDocumentContentSecurityPolicy;
  if (nonce === null) throw new Error("the measurement response nonce is unavailable");
  return measurementDocumentContentSecurityPolicy(nonce);
}

function responseNonce(): string {
  const bytes = new Uint8Array(16);
  serviceWorker.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function measurementDocumentContentSecurityPolicy(nonce: string): string {
  return (
    `default-src 'self'; script-src 'nonce-${nonce}'; script-src-attr 'none'; ` +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
    "media-src 'self' data:; connect-src 'none'; frame-src 'none'; child-src 'none'; " +
    "worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; " +
    "frame-ancestors 'self'; sandbox allow-scripts allow-same-origin"
  );
}
