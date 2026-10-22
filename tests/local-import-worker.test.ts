import { readFileSync } from "node:fs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportWorkerRequest, ImportWorkerResponse } from "../src/local/import-protocol.js";
import { openLocalPublication } from "../src/local/publication.js";
import {
  localCacheName,
  localPaginationCacheName,
  localResourceManifestRevision,
  manifestCacheRequest,
  readCommittedPublicationSnapshot,
  readCommittedResourceManifest,
  resourceCacheRequest,
  sourceCacheRequest,
} from "../src/local/storage.js";
import type * as NavigatorWasm from "../.generated/epub-navigator/epub_navigator.js";
import { MemoryCacheStorage } from "./support/memory-cache-storage.js";

vi.mock("../src/wasm.js", async () => {
  const wasm = await vi.importActual<typeof NavigatorWasm>(
    new URL("../.generated/epub-navigator/epub_navigator.js", import.meta.url).pathname,
  );
  return {
    ...wasm,
    initializeNavigatorWasm: async () =>
      wasm.initSync({
        module: readFileSync(
          new URL("../.generated/epub-navigator/epub_navigator_bg.wasm", import.meta.url),
        ),
      }),
  };
});

const root = "https://example.test/publications/";
const css = "p { -epub-hyphens: auto; }";
const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Test</title><style>${css}</style></head><body style="-epub-hyphens: auto">Test</body></html>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style></svg>`;
const entries = {
  mimetype: strToU8("application/epub+zip"),
  "META-INF/container.xml": strToU8(
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  ),
  "EPUB/package.opf": strToU8(
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test</dc:identifier><dc:title>Test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="css" href="styles" media-type="text/css"/><item id="svg" href="image.svg" media-type="image/svg+xml"/><item id="not-css" href="data.css" media-type="application/octet-stream"/></manifest><spine><itemref idref="chapter"/></spine></package>',
  ),
  "EPUB/chapter.xhtml": strToU8(xhtml),
  "EPUB/styles": strToU8(css),
  "EPUB/image.svg": strToU8(svg),
  "EPUB/data.css": strToU8(css),
  "EPUB/fallback.css": strToU8(css),
};

let listener: (event: MessageEvent<ImportWorkerRequest>) => void;
let complete: (message: ImportWorkerResponse) => void;
let storage: MemoryCacheStorage;

beforeEach(async () => {
  storage = new MemoryCacheStorage();
  vi.stubGlobal("caches", storage);
  vi.stubGlobal("addEventListener", (_type: string, callback: typeof listener) => {
    listener = callback;
  });
  vi.stubGlobal("postMessage", (message: ImportWorkerResponse) => {
    if (message.type === "done" || message.type === "error") complete(message);
  });
  // Re-register the worker for each isolated cache without replacing its WASM facade.
  vi.resetModules();
  await import("../src/local/import-worker.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const pixel = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

function shrunkFixture(name: string): Uint8Array {
  const files = unzipSync(readFileSync(new URL(`./fixtures/epub34/${name}.epub`, import.meta.url)));
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [path, path.endsWith(".png") ? pixel : bytes]),
    ),
  );
}

async function importArchive(source: Uint8Array): Promise<ImportWorkerResponse> {
  const result = new Promise<ImportWorkerResponse>((resolve) => {
    complete = resolve;
  });
  listener({
    data: { type: "import", source: source.slice().buffer },
  } as MessageEvent<ImportWorkerRequest>);
  const message = await result;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return message;
}

describe("local raw resource import", () => {
  it.each([
    ["lay-roll-images-in-spine", ["A", "B", "C", "D", "E", "F", "G", "H", "Title"]],
    ["lay-roll-images-mixed", ["C", "D"]],
  ])(
    "marks effective raster wrappers without changing cached bytes: %s",
    async (fixture, names) => {
      const result = await importArchive(shrunkFixture(fixture));
      if (result.type !== "done") throw new Error(`import ${result.type}`);
      const images = (await readCommittedResourceManifest(result.id))!.resources.filter(
        (resource) => resource.responseInstrumentation === "fixed-image",
      );
      expect(images.map((resource) => resource.path)).toEqual(
        names.map((name) => `EPUB/images/${name}.png`),
      );
      const cache = await caches.open(localCacheName(result.id));
      for (const resource of images) {
        const response = (await cache.match(resourceCacheRequest(result.id, resource.path)))!;
        expect(response.headers.get("Content-Type")).toBe("image/png");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(pixel);
      }
    },
  );

  it("preserves archive and raw resource bytes, declared MIME, and byte lengths", async () => {
    const source = zipSync(entries);
    const original = source.slice();
    const result = await importArchive(source);
    expect(result.type).toBe("done");
    if (result.type !== "done") return;
    const cache = await caches.open(localCacheName(result.id));
    expect(
      new Uint8Array(await (await cache.match(sourceCacheRequest(result.id)))!.arrayBuffer()),
    ).toEqual(original);
    expect(source).toEqual(original);
    const publication = await openLocalPublication(source);
    try {
      const manifest = await readCommittedResourceManifest(result.id);
      expect(manifest?.revision).toBe(localResourceManifestRevision);
      for (const [path, mediaType] of [
        ["EPUB/styles", "text/css"],
        ["EPUB/fallback.css", "text/css"],
        ["EPUB/chapter.xhtml", "application/xhtml+xml"],
        ["EPUB/image.svg", "image/svg+xml"],
        ["EPUB/data.css", "application/octet-stream"],
      ] as const) {
        const raw = publication.readResource(path);
        expect(raw).toEqual(entries[path]);
        const response = (await cache.match(resourceCacheRequest(result.id, path)))!;
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(raw);
        expect(response.headers.get("Content-Type")?.split(";")[0]).toBe(mediaType);
        expect(response.headers.get("Content-Length")).toBe(String(raw.byteLength));
        expect(manifest?.resources.find((resource) => resource.path === path)?.sizeBytes).toBe(
          raw.byteLength,
        );
      }
      expect(
        manifest?.resources.find((resource) => resource.path === "EPUB/image.svg")
          ?.responseInstrumentation,
      ).toBe("none");
      expect(
        await (await cache.match(resourceCacheRequest(result.id, "EPUB/data.css")))!.text(),
      ).toBe(css);
      const first = await (await cache.match(
        resourceCacheRequest(result.id, "EPUB/styles"),
      ))!.text();
      expect(await importArchive(source)).toEqual(result);
      expect(
        await (await cache.match(resourceCacheRequest(result.id, "EPUB/styles")))!.text(),
      ).toBe(first);
    } finally {
      publication.close();
    }
  });

  it.each([
    ["response-instrumentation-v2", false],
    ["response-instrumentation-v2", true],
    ["static-css-v1-response-instrumentation-v2", false],
    ["static-css-v1-response-instrumentation-v2", true],
  ] as const)(
    "rejects %s snapshots and rebuilds raw bytes on explicit reimport (failed first attempt: %s)",
    async (revision, failFirst) => {
      const source = zipSync(entries);
      const imported = await importArchive(source);
      expect(imported.type).toBe("done");
      if (imported.type !== "done") return;
      const id = imported.id;
      const cache = await caches.open(localCacheName(id));
      const manifest = await readCommittedResourceManifest(id);
      await cache.put(
        manifestCacheRequest(id),
        new Response(JSON.stringify({ ...manifest, revision })),
      );
      await cache.put(
        resourceCacheRequest(id, "EPUB/styles"),
        new Response("p { hyphens: auto; -epub-hyphens: auto; }"),
      );
      await caches.open(localPaginationCacheName(id));
      expect(await readCommittedPublicationSnapshot(root, id)).toBeUndefined();
      expect(await readCommittedResourceManifest(id)).toBeUndefined();
      expect(
        new Uint8Array(await (await cache.match(sourceCacheRequest(id)))!.arrayBuffer()),
      ).toEqual(source);
      if (failFirst) {
        storage.failPut = (url) => url.includes("/resources/");
        expect(await importArchive(source)).toEqual({
          type: "error",
          message: "injected write failure",
        });
        expect(await caches.has(localCacheName(id))).toBe(false);
        expect(await caches.has(localPaginationCacheName(id))).toBe(false);
        storage.failPut = () => false;
      }
      expect(await importArchive(source)).toEqual(imported);
      expect(await caches.has(localPaginationCacheName(id))).toBe(false);
      expect(await readCommittedPublicationSnapshot(root, id)).toBeDefined();
      expect((await readCommittedResourceManifest(id))?.revision).toBe(
        localResourceManifestRevision,
      );
      const rebuilt = await caches.open(localCacheName(id));
      expect(await (await rebuilt.match(resourceCacheRequest(id, "EPUB/styles")))!.text()).toBe(
        css,
      );
    },
  );
});
