import { afterEach, expect, it, vi } from "vitest";
import {
  factsCacheRequest,
  manifestCacheRequest,
  markerCacheRequest,
  resourceCacheRequest,
  sourceCacheRequest,
  localCacheName,
  localResourceManifestRevision,
} from "../src/local/storage.js";
import {
  localServiceWorkerCacheName,
  localServiceWorkerConfigurationRequest,
} from "../src/local/service-worker-protocol.js";

afterEach(() => vi.unstubAllGlobals());

it("serves only explicit foreground image wrappers, retaining raw bytes and HEAD lengths", async () => {
  const id = "a".repeat(64);
  const base = "https://reader.test/publications/";
  const rawUrl = `${base}${id}/EPUB/image.png`;
  const query = "?epub-navigator-image-document=1";
  const config = {
    type: "configure",
    mountBaseUrl: base,
    measurementMountBaseUrl: "https://reader.test/measurement/",
    contentAgentUrl: "https://reader.test/agent.js",
    readerFontStylesheetUrl: null,
  };
  const resources = new Map<string, Response>([
    [markerCacheRequest(id).url, Response.json({ id, sourceSizeBytes: 3, importedAt: 1 })],
    [factsCacheRequest(id).url, Response.json({})],
    [sourceCacheRequest(id).url, new Response("archive")],
    [
      manifestCacheRequest(id).url,
      Response.json({
        revision: localResourceManifestRevision,
        resources: [
          {
            path: "EPUB/image.png",
            mediaType: "image/png",
            sizeBytes: 3,
            responseInstrumentation: "fixed-image",
            executableContent: "inapplicable",
          },
          {
            path: "EPUB/dependency.png",
            mediaType: "image/png",
            sizeBytes: 3,
            responseInstrumentation: "none",
            executableContent: "inapplicable",
          },
        ],
      }),
    ],
    [
      resourceCacheRequest(id, "EPUB/image.png").url,
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/png", "Content-Length": "3" },
      }),
    ],
  ]);
  const configuration = new Map([
    [localServiceWorkerConfigurationRequest().url, Response.json(config)],
  ]);
  vi.stubGlobal("caches", {
    has: async (name: string) => name === localCacheName(id),
    open: async (name: string) => ({
      match: async (request: Request) =>
        (name === localServiceWorkerCacheName ? configuration : resources)
          .get(request.url)
          ?.clone(),
    }),
  });
  let fetchListener: (event: {
    request: Request;
    respondWith(response: Promise<Response>): void;
  }) => void;
  vi.stubGlobal("addEventListener", (type: string, listener: typeof fetchListener) => {
    if (type === "fetch") fetchListener = listener;
  });
  vi.resetModules();
  await import("../src/local/service-worker.js");
  const request = (url: string, method = "GET", headers?: HeadersInit) =>
    new Promise<Response>((resolve) => {
      fetchListener({
        request: new Request(url, headers === undefined ? { method } : { method, headers }),
        respondWith: (response) => {
          void response.then(resolve);
        },
      });
    });
  const raw = await request(rawUrl);
  expect(raw.headers.get("Content-Type")).toBe("image/png");
  expect(new Uint8Array(await raw.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  const wrapper = await request(rawUrl + query, "GET", { range: "bytes=0-1" });
  expect(wrapper.status).toBe(200);
  expect(wrapper.headers.get("Accept-Ranges")).toBe("none");
  expect(wrapper.headers.get("Content-Type")).toBe("application/xhtml+xml; charset=utf-8");
  const text = await wrapper.text();
  expect(text).toContain(`src="${rawUrl}"`);
  expect(text).toContain("https://reader.test/agent.js");
  expect(text).not.toContain(query);
  const head = await request(rawUrl + query, "HEAD");
  expect(head.headers.get("Content-Length")).toBe(String(new TextEncoder().encode(text).length));
  expect(await head.text()).toBe("");
  for (const suffix of ["?other=1", "?epub-navigator-image-document=%31", query + "&other=1"])
    expect((await request(rawUrl + suffix)).status).toBe(400);
  expect((await request(rawUrl.replace("image.png", "dependency.png") + query)).status).toBe(403);
  expect((await request(rawUrl.replace("/publications/", "/measurement/") + query)).status).toBe(
    403,
  );
});
