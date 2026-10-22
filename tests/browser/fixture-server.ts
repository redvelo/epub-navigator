import { readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import type { Plugin } from "vite";
import { decodePublicationRoute } from "../../src/mount.js";
import { instrumentSvg } from "../../src/svg-instrumentation.js";
import { instrumentXhtml } from "../../src/xhtml-instrumentation.js";
import { corpusPublication } from "../fixtures/epub3-samples/catalog.js";
import { loadCorpusArchive } from "../support/corpus-archive.js";
import { contentType, fixtureContentSecurityPolicy } from "./fixture-host.js";

const readerOrigin = "http://127.0.0.1:4174";

const fixtures = new URL("../fixtures/", import.meta.url);
const alicePath = new URL("alice-in-wonderland.epub", fixtures);
const hostConformancePath = new URL("host-conformance.epub", fixtures);
const mobyDickPath = new URL("epub3-samples/moby-dick-mo.epub", fixtures);
const mediaOverlayFixtures = new URL("epub3-samples/moby-dick-media-overlays/", fixtures);
const lifecycleOverlay = new URL("./fixtures/alice-lifecycle/", import.meta.url);
const fixtureAgents = new URL("./fixtures/agents/", import.meta.url);
const fontPath = new URL(
  "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  import.meta.url,
);
const contentAgentPath = new URL("../../dist/content-agent.js", import.meta.url);

const contentAgentRoute = "/_epub-navigator/content-agent.js";
const silentAgentRoute = "/_epub-navigator/silent-agent.js";
const readyOnlyAgentRoute = "/_epub-navigator/ready-only-agent.js";
const unsupportedLayoutAgentRoute = "/_epub-navigator/unsupported-layout-agent.js";
const mediaOverlayFixtureRoute = "/media-overlay-fixture/";

const aliceMountBase = `${readerOrigin}/publications/alice/`;
const isolatedMountBase = "http://localhost:4174/";
const narrationMountBase = "http://moby.localhost:4174/";
const readerContentAgentUrl = `${readerOrigin}${contentAgentRoute}`;
const delayedResource = "epub/text/milestone-1-delayed.xhtml";
const aliceAgentRoutes: Readonly<Record<string, string>> = {
  "epub/text/milestone-2-pending-navigation.xhtml": silentAgentRoute,
  [delayedResource]: unsupportedLayoutAgentRoute,
  "epub/text/milestone-2-operation-timeout.xhtml": readyOnlyAgentRoute,
};
const narrationMediaTypes: Readonly<Record<string, string>> = {
  mp4: "audio/mp4",
  smil: "application/smil+xml",
};
const isolatedContentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' ${readerContentAgentUrl}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'self'",
  `frame-ancestors ${readerOrigin}`,
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
const corpusContentSecurityPolicy = fixtureContentSecurityPolicy.replace(
  "frame-ancestors 'self'",
  `frame-ancestors ${readerOrigin}`,
);

interface PublicationHost {
  readonly baseUrl: string;
  readonly resources: Promise<ReadonlyMap<string, Uint8Array>>;
  readonly mediaType: (path: string) => string;
  readonly contentAgentUrl: (path: string) => string;
  readonly contentSecurityPolicy: string;
  readonly instrumentSvg: boolean;
  readonly ranges: boolean;
  readonly cors: boolean;
  readonly resourcePolicy: boolean;
  readonly denyServiceWorkers: boolean;
}

type Next = (error?: unknown) => void;

export function publicationFixtures(): Plugin {
  const alice: PublicationHost = {
    baseUrl: aliceMountBase,
    resources: lifecycleResources(),
    mediaType: contentType,
    contentAgentUrl: (path) => aliceAgentRoutes[path] ?? contentAgentRoute,
    contentSecurityPolicy: fixtureContentSecurityPolicy,
    instrumentSvg: false,
    ranges: false,
    cors: true,
    resourcePolicy: false,
    denyServiceWorkers: false,
  };
  const isolated: PublicationHost = {
    baseUrl: isolatedMountBase,
    resources: archiveResources(hostConformancePath),
    mediaType: contentType,
    contentAgentUrl: () => readerContentAgentUrl,
    contentSecurityPolicy: isolatedContentSecurityPolicy,
    instrumentSvg: false,
    ranges: true,
    cors: false,
    resourcePolicy: false,
    denyServiceWorkers: true,
  };
  const narration: PublicationHost = {
    ...isolated,
    baseUrl: narrationMountBase,
    resources: archiveResources(mobyDickPath),
    mediaType: (path) =>
      narrationMediaTypes[path.split(".").at(-1)!.toLowerCase()] ?? contentType(path),
    resourcePolicy: true,
  };
  const gatedResources = new Map<
    string,
    { readonly kind: GatedKind; readonly response: ServerResponse }
  >();

  return {
    name: "epub-publication-fixtures",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        route(request, response, next).catch(next);
      });
    },
  };

  async function route(request: IncomingMessage, response: ServerResponse, next: Next) {
    const target = request.url;
    const authority = request.headers.host;
    if (target === undefined || authority === undefined) {
      sendError(response, 400, "request target or authority is missing");
      return;
    }
    const url = new URL(target, `http://${authority}`);

    if (target.startsWith("/_hostile-navigation/target/")) {
      sendBytes(response, "<!doctype html><title>External navigation target</title>", {
        "Content-Type": "text/html; charset=utf-8",
      });
      return;
    }
    if (target.startsWith("/_hostile-navigation/attachment/")) {
      sendBytes(response, "hostile navigation attachment", {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="probe.txt"',
      });
      return;
    }
    if (target.startsWith("/publications/alice/_hostile-navigation/redirect/")) {
      const id = target.slice(target.lastIndexOf("/") + 1);
      response.statusCode = 302;
      response.setHeader(
        "Location",
        `http://localhost:4174/_hostile-navigation/target/redirect-${id}`,
      );
      response.end();
      return;
    }
    if (target.startsWith("/_epub-navigator/gated-resource?")) {
      const id = url.searchParams.get("id");
      const kind = url.searchParams.get("kind");
      if (id === null || !isGatedKind(kind) || gatedResources.has(id)) {
        sendError(response, 400, "invalid or duplicate gated resource");
        return;
      }
      gatedResources.set(id, { kind, response });
      response.on("close", () => {
        if (!response.writableEnded) gatedResources.delete(id);
      });
      return;
    }
    if (target.startsWith("/_epub-navigator/release-resource?")) {
      const id = url.searchParams.get("id");
      const pending = id === null ? undefined : gatedResources.get(id);
      if (id === null || pending === undefined) {
        sendError(response, 404, "gated resource not found");
        return;
      }
      gatedResources.delete(id);
      if (url.searchParams.get("failure") === "true") {
        sendError(pending.response, 500, "deterministic fixture failure");
      } else {
        await releaseGatedResource(pending.kind, pending.response);
      }
      sendJson(response, { released: id });
      return;
    }

    if (authority === new URL(isolatedMountBase).host) {
      await servePublication(request, response, isolated);
      return;
    }
    if (authority === new URL(narrationMountBase).host) {
      await servePublication(request, response, narration);
      return;
    }
    const corpusAuthority = /^([a-z0-9-]+)\.localhost:4174$/u.exec(authority);
    if (corpusAuthority !== null) {
      await serveCorpusPublication(request, response, url, corpusAuthority[1]!);
      return;
    }

    if (target === contentAgentRoute) {
      await sendFile(response, contentAgentPath, "text/javascript; charset=utf-8");
      return;
    }
    if (target === silentAgentRoute) {
      await sendFile(
        response,
        new URL("silent-agent.js", fixtureAgents),
        "text/javascript; charset=utf-8",
      );
      return;
    }
    if (target === unsupportedLayoutAgentRoute) {
      await sendFile(
        response,
        new URL("unsupported-layout-agent.js", fixtureAgents),
        "text/javascript; charset=utf-8",
      );
      return;
    }
    if (target === readyOnlyAgentRoute) {
      const [prelude, agent] = await Promise.all([
        readFile(new URL("ready-only-agent-prelude.js", fixtureAgents), "utf8"),
        readFile(contentAgentPath, "utf8"),
      ]);
      sendBytes(response, `${prelude}\n${agent}`, {
        "Content-Type": "text/javascript; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      return;
    }
    if (target === "/alice.epub") {
      await sendFile(response, alicePath, "application/epub+zip");
      return;
    }
    if (target === "/host-conformance.epub") {
      await sendFile(response, hostConformancePath, "application/epub+zip");
      return;
    }
    if (url.pathname.startsWith("/corpus/") && url.pathname.endsWith(".epub")) {
      await serveCorpusArchive(response, url);
      return;
    }
    if (url.pathname.startsWith(mediaOverlayFixtureRoute)) {
      await serveMediaOverlayFixture(response, url);
      return;
    }
    if (target.startsWith("/publications/alice")) {
      await servePublication(request, response, alice);
      return;
    }
    next();
  }
}

async function serveCorpusPublication(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  id: string,
): Promise<void> {
  if (url.pathname === contentAgentRoute) {
    if (url.search.length > 0 || url.hash.length > 0) {
      sendError(response, 400, "invalid content-agent route");
      return;
    }
    await sendFile(response, contentAgentPath, "text/javascript; charset=utf-8");
    return;
  }
  if (corpusPublication(id) === undefined) {
    sendError(response, 404, "unknown corpus host");
    return;
  }
  const archive = await loadCorpusArchive(id);
  await servePublication(request, response, {
    baseUrl: `${url.origin}/`,
    resources: Promise.resolve(archive.resources),
    mediaType: archive.mediaType,
    contentAgentUrl: () => `${url.origin}${contentAgentRoute}`,
    contentSecurityPolicy: corpusContentSecurityPolicy,
    instrumentSvg: true,
    ranges: true,
    cors: false,
    resourcePolicy: true,
    denyServiceWorkers: true,
  });
}

async function serveCorpusArchive(response: ServerResponse, url: URL): Promise<void> {
  if (url.search.length > 0 || url.hash.length > 0) {
    sendError(response, 400, "invalid corpus archive route");
    return;
  }
  const match = /^\/corpus\/([a-z0-9-]+)\.epub$/u.exec(url.pathname);
  const publication = match === null ? undefined : corpusPublication(match[1]!);
  if (publication === undefined) {
    sendError(response, 404, "corpus publication not found");
    return;
  }
  const archive = await loadCorpusArchive(publication.id);
  sendBytes(response, archive.bytes, { "Content-Type": "application/epub+zip" });
}

async function serveMediaOverlayFixture(response: ServerResponse, url: URL): Promise<void> {
  const name = url.pathname.slice(mediaOverlayFixtureRoute.length);
  if (url.search.length > 0 || !/^(?:description|timeline-\d+)\.json$/u.test(name)) {
    sendError(response, 400, "invalid media overlay fixture route");
    return;
  }
  try {
    const bytes = await readFile(new URL(name, mediaOverlayFixtures));
    sendBytes(response, bytes, { "Content-Type": "application/json" });
  } catch {
    sendError(response, 404, "media overlay fixture not found");
  }
}

async function servePublication(
  request: IncomingMessage,
  response: ServerResponse,
  host: PublicationHost,
): Promise<void> {
  if (host.denyServiceWorkers && request.headers["service-worker"] === "script") {
    sendError(response, 403, "publisher service workers are blocked by host policy");
    return;
  }
  let path: string;
  try {
    path = decodePublicationRoute(host.baseUrl, request.url!);
  } catch {
    sendError(response, 400, "invalid publication route");
    return;
  }
  const source = (await host.resources).get(path);
  if (source === undefined) {
    sendError(response, 404, "publication resource not found");
    return;
  }
  const mediaType = host.mediaType(path);
  const essence = mediaTypeEssence(mediaType);
  const instrument =
    essence === "application/xhtml+xml"
      ? instrumentXhtml
      : essence === "image/svg+xml" && host.instrumentSvg
        ? instrumentSvg
        : null;
  let bytes = source;
  if (instrument !== null) {
    try {
      bytes = instrument(source, { contentAgentUrl: host.contentAgentUrl(path) });
    } catch (cause) {
      sendError(
        response,
        422,
        cause instanceof Error ? cause.message : "publication could not be instrumented",
      );
      return;
    }
  }
  const rangeEligible = host.ranges && essence !== "application/xhtml+xml";
  const range = rangeEligible ? byteRange(request.headers.range, bytes.byteLength) : null;
  if (range === "invalid") {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${bytes.byteLength}`);
    response.end();
    return;
  }
  const body = range === null ? bytes : bytes.subarray(range.start, range.end + 1);
  response.statusCode = range === null ? 200 : 206;
  response.setHeader("Content-Type", mediaType);
  response.setHeader("Content-Length", body.byteLength);
  response.setHeader("Content-Security-Policy", host.contentSecurityPolicy);
  response.setHeader("Accept-Ranges", rangeEligible ? "bytes" : "none");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (host.cors) response.setHeader("Access-Control-Allow-Origin", "*");
  if (host.resourcePolicy) {
    const destination = request.headers["sec-fetch-dest"];
    response.setHeader(
      "Cross-Origin-Resource-Policy",
      destination === "audio" || destination === "video" ? "cross-origin" : "same-origin",
    );
  }
  if (range !== null) {
    response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
  }
  if (path === delayedResource) {
    setTimeout(() => response.end(body), 400);
  } else {
    response.end(body);
  }
}

async function lifecycleResources(): Promise<ReadonlyMap<string, Uint8Array>> {
  const [resources, overlay, font] = await Promise.all([
    archiveResources(alicePath),
    readdir(lifecycleOverlay, { recursive: true, withFileTypes: true }),
    readFile(fontPath),
  ]);
  for (const entry of overlay) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const path = relative(fileURLToPath(lifecycleOverlay), file).replaceAll("\\", "/");
    resources.set(path, new Uint8Array(await readFile(file)));
  }
  resources.set(delayedResource, resources.get("epub/text/milestone-1.xhtml")!);
  resources.set("epub/media/milestone-2.mp3", new Uint8Array([73, 68, 51]));
  resources.set("epub/fonts/geist.woff2", new Uint8Array(font));
  return resources;
}

async function archiveResources(path: URL): Promise<Map<string, Uint8Array>> {
  return new Map(Object.entries(unzipSync(new Uint8Array(await readFile(path)))));
}

type GatedKind = "font" | "image" | "stylesheet";

function isGatedKind(kind: string | null): kind is GatedKind {
  return kind === "font" || kind === "image" || kind === "stylesheet";
}

async function releaseGatedResource(kind: GatedKind, response: ServerResponse): Promise<void> {
  if (kind === "font") {
    sendBytes(response, await readFile(fontPath), { "Content-Type": "font/woff2" });
  } else if (kind === "image") {
    sendBytes(
      response,
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="navy"/></svg>',
      { "Content-Type": "image/svg+xml" },
    );
  } else {
    sendBytes(response, "body { letter-spacing: 0.01px; }", { "Content-Type": "text/css" });
  }
}

async function sendFile(response: ServerResponse, path: URL, mediaType: string): Promise<void> {
  sendBytes(response, await readFile(path), {
    "Content-Type": mediaType,
    "X-Content-Type-Options": "nosniff",
  });
}

function sendBytes(
  response: ServerResponse,
  body: Uint8Array | string,
  headers: Readonly<Record<string, string>>,
): void {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  response.statusCode = 200;
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.setHeader("Content-Length", bytes.byteLength);
  response.end(bytes);
}

function sendJson(response: ServerResponse, value: unknown): void {
  sendBytes(response, JSON.stringify(value), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

function sendError(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(message);
}

function mediaTypeEssence(mediaType: string): string {
  return (mediaType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

function byteRange(
  value: string | undefined,
  length: number,
): { readonly start: number; readonly end: number } | "invalid" | null {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (match === null || (match[1] === "" && match[2] === "")) return "invalid";
  const start = match[1] === "" ? Math.max(0, length - Number(match[2])) : Number(match[1]);
  const end =
    match[1] === "" || match[2] === "" ? length - 1 : Math.min(Number(match[2]), length - 1);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= length ||
    end < start
  ) {
    return "invalid";
  }
  return { start, end };
}
