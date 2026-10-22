import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalPaginationCache,
  factsCacheRequest,
  searchDocumentStatesCacheRequest,
  isResourceManifest,
  localCacheName,
  localPaginationCacheName,
  localResourceManifestRevision,
  resourceManifestFromFacts,
  readCommittedPublication,
  writePublicationCache,
} from "../src/local/storage.js";
import type { PublicationFacts } from "../src/generated/publication.js";
import { MemoryCacheStorage, type MemoryCache } from "./support/memory-cache-storage.js";

const publicationId = "a".repeat(64);
const basis = "b".repeat(64);
const record = "c".repeat(64);
const mountBase = "https://example.test/publications/";
const signal = new AbortController().signal;

let cacheStorage: MemoryCacheStorage;

beforeEach(() => {
  cacheStorage = new MemoryCacheStorage();
  vi.stubGlobal("caches", cacheStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function manifestResource(overrides: Record<string, unknown> = {}) {
  return {
    path: "EPUB/chapter.xhtml",
    mediaType: "application/xhtml+xml",
    sizeBytes: 1,
    responseInstrumentation: "xhtml",
    executableContent: "analyzed-absent",
    ...overrides,
  };
}

function manifestFacts(
  resources: readonly {
    readonly path: string;
    readonly declarations: readonly number[];
    readonly xhtml?: boolean;
    readonly svg?: boolean;
  }[],
  mediaTypes: readonly string[],
  readingOrder: readonly (readonly [declaration: number, resource: number])[],
): PublicationFacts {
  return {
    package: { manifest: { items: mediaTypes.map((mediaType) => ({ mediaType })) } },
    resources: {
      readingOrder: readingOrder.map(([declaration, resource]) => ({
        target: { state: "declaration", value: declaration },
        resource,
      })),
      resources: resources.map((resource, ordinal) => ({
        address: { kind: "local", value: resource.path },
        presence: { state: "present", sizeBytes: String((ordinal + 1) * 10) },
        declarations: resource.declarations,
        hasXhtmlDeclaration: resource.xhtml === true,
        hasSvgDeclaration: resource.svg === true,
      })),
    },
  } as unknown as PublicationFacts;
}

function searchableFacts(): PublicationFacts {
  return {
    package: {
      manifest: { items: [{ href: "chapter.xhtml", mediaType: "application/xhtml+xml" }] },
    },
    navigation: null,
    resources: {
      packagePath: "EPUB/package.opf",
      resources: [
        {
          address: { kind: "local", value: "EPUB/chapter.xhtml" },
          presence: { state: "present", sizeBytes: "1" },
          declarations: [0],
          hasXhtmlDeclaration: true,
          hasSvgDeclaration: false,
        },
      ],
      declarations: [
        {
          id: { state: "valid", value: "chapter" },
          href: "chapter.xhtml",
          target: { state: "resource", resource: 0 },
          mediaType: "application/xhtml+xml",
          fallback: null,
          fallbackTarget: null,
        },
      ],
      readingOrder: [
        {
          idref: "chapter",
          target: { state: "declaration", value: 0 },
          resource: 0,
          linear: "yes",
        },
      ],
      selections: {},
    },
    navigationLoading: { state: "unavailable" },
    navigationTargets: [],
  } as unknown as PublicationFacts;
}

async function writeSearchablePublication(): Promise<Cache> {
  const facts = searchableFacts();
  const cache = await cacheStorage.open(localCacheName(publicationId));
  await writePublicationCache(cache, {
    id: publicationId,
    source: new Uint8Array([1]),
    facts,
    searchDocumentStates: { "EPUB/chapter.xhtml": "complete" },
    searchDocuments: [
      { occurrence: 0, resourcePath: "EPUB/chapter.xhtml", source: "chapter.xhtml" },
    ],
    searchEntries: [],
    manifest: resourceManifestFromFacts(facts),
    resources: { "EPUB/chapter.xhtml": new Uint8Array([2]) },
    importedAt: 1,
  });
  return cache;
}

describe("local publication metadata", () => {
  it("requires persisted search document states for a committed publication", async () => {
    const cache = await writeSearchablePublication();

    expect(
      (await readCommittedPublication(mountBase, publicationId))?.searchDocumentStates,
    ).toEqual({ "EPUB/chapter.xhtml": "complete" });
    await cache.delete(searchDocumentStatesCacheRequest(publicationId));
    expect(await readCommittedPublication(mountBase, publicationId)).toBeUndefined();
  });

  it("rejects stale cached facts without manifest declaration facts", async () => {
    const cache = await writeSearchablePublication();
    const stale = structuredClone(searchableFacts()) as unknown as {
      resources: { declarations?: unknown };
    };
    delete stale.resources.declarations;
    await cache.put(factsCacheRequest(publicationId), new Response(JSON.stringify(stale)));

    expect(await readCommittedPublication(mountBase, publicationId)).toBeUndefined();
  });

  it("rejects malformed, stale, and unknown manifest shapes without throwing", () => {
    const manifest = (resource: Record<string, unknown>) => ({
      revision: localResourceManifestRevision,
      resources: [manifestResource(resource)],
    });
    expect(
      [
        null,
        { revision: localResourceManifestRevision, resources: [null] },
        { revision: "response-instrumentation-v1", resources: [] },
        manifest({ path: "../chapter.xhtml" }),
        manifest({ injectAgent: true }),
        manifest({ responseInstrumentation: "unknown" }),
        manifest({ foregroundPreparation: "eligible-by-media-type" }),
      ].map(isResourceManifest),
    ).toEqual(Array(7).fill(false));
    expect(isResourceManifest(manifest({}))).toBe(true);
  });

  it("stores aligned preparation and explicit instrumentation profiles for new imports", () => {
    const facts = manifestFacts(
      [
        { path: "EPUB/chapter.xhtml", declarations: [0], xhtml: true },
        { path: "EPUB/cover.svg", declarations: [1], svg: true },
      ],
      ["application/xhtml+xml", "image/svg+xml"],
      [
        [0, 0],
        [1, 1],
      ],
    );

    expect(
      resourceManifestFromFacts(
        facts,
        ["analyzed-absent", "inapplicable"],
        ["eligible", "eligible"],
      ).resources,
    ).toEqual([
      {
        path: "EPUB/chapter.xhtml",
        mediaType: "application/xhtml+xml",
        sizeBytes: 10,
        responseInstrumentation: "xhtml",
        executableContent: "analyzed-absent",
        foregroundPreparation: "eligible",
      },
      {
        path: "EPUB/cover.svg",
        mediaType: "image/svg+xml",
        sizeBytes: 20,
        responseInstrumentation: "svg",
        executableContent: "inapplicable",
        foregroundPreparation: "eligible",
      },
    ]);
    expect(() => resourceManifestFromFacts(facts, ["analyzed-absent", "inapplicable"], [])).toThrow(
      "foreground-preparation analysis is not aligned with publication resources",
    );
  });

  it("instruments only SVG resources with reading-order evidence", () => {
    const resources = resourceManifestFromFacts(
      manifestFacts(
        [
          { path: "EPUB/image.svg", declarations: [0], svg: true },
          { path: "EPUB/spine-and-image.svg", declarations: [1], svg: true },
        ],
        ["image/svg+xml", "image/svg+xml"],
        [[1, 1]],
      ),
    ).resources;

    expect(resources.map((resource) => [resource.path, resource.responseInstrumentation])).toEqual([
      ["EPUB/image.svg", "none"],
      ["EPUB/spine-and-image.svg", "svg"],
    ]);
    expect(isResourceManifest({ revision: localResourceManifestRevision, resources })).toBe(true);
  });

  it("uses Stack declaration facts for instrumentation and the first declaration for MIME", () => {
    const facts = manifestFacts(
      [
        { path: "EPUB/chapter.bin", declarations: [0, 1], xhtml: true },
        { path: "EPUB/drawing.bin", declarations: [0, 2], svg: true },
        { path: "EPUB/not-xhtml.xhtml", declarations: [1] },
      ],
      ["application/octet-stream", "application/xhtml+xml", "image/svg+xml"],
      [
        [0, 0],
        [2, 1],
        [1, 2],
      ],
    );

    expect(resourceManifestFromFacts(facts).resources).toMatchObject([
      { mediaType: "application/octet-stream", responseInstrumentation: "xhtml" },
      { mediaType: "application/octet-stream", responseInstrumentation: "svg" },
      { mediaType: "application/xhtml+xml", responseInstrumentation: "none" },
    ]);
  });
});

describe("local pagination cache", () => {
  const entryUrl = (entryBasis: string, entryRecord = record) =>
    `https://epub-navigator.invalid/pagination/${publicationId}/entries/${entryBasis}/${entryRecord}`;
  const indexUrl = `https://epub-navigator.invalid/pagination/${publicationId}/index.json`;

  async function openPaginationCache(hostSignal = new AbortController().signal) {
    await cacheStorage.open(localCacheName(publicationId));
    return createLocalPaginationCache(publicationId, hostSignal);
  }

  function derivedCache(): MemoryCache {
    const derived = cacheStorage.stores.get(localPaginationCacheName(publicationId));
    if (derived === undefined) throw new Error("the derived cache is missing");
    return derived;
  }

  async function derivedIndex(): Promise<unknown> {
    return derivedCache().responses.get(indexUrl)?.clone().json();
  }

  function read(
    cache: ReturnType<typeof createLocalPaginationCache>,
    readBasis: string,
    maxBytes: number,
    readRecord = record,
    readSignal = signal,
  ): Promise<Uint8Array | null> {
    return cache.read(readBasis, readRecord, { signal: readSignal, maxBytes });
  }

  it("does not create derived storage after the authored cache is gone", async () => {
    const cache = createLocalPaginationCache(publicationId, signal);

    await cache.write(basis, record, new Uint8Array([1]), { signal });

    expect(cacheStorage.stores.has(localPaginationCacheName(publicationId))).toBe(false);
  });

  it("evicts every record of the least recently used basis", async () => {
    const cache = await openPaginationCache();
    const bases = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    for (const key of bases) {
      await cache.write(key, record, new TextEncoder().encode(key), { signal });
    }
    const derived = derivedCache();
    derived.responses.set(entryUrl("4".repeat(64)), new Response("orphan"));
    derived.responses.set(entryUrl("invalid!"), new Response("invalid"));

    await read(cache, bases[0]!, 64);
    const fourth = "5".repeat(64);
    await cache.write(fourth, record, new TextEncoder().encode("four"), { signal });

    expect([...derived.responses.keys()].filter((url) => url.includes("/entries/"))).toHaveLength(
      5,
    );
    expect(derived.keyCalls).toBe(1);
    expect(await read(cache, bases[1]!, 64)).toBeNull();
    expect(await read(cache, bases[0]!, 64)).not.toBeNull();
    expect(await read(cache, fourth, 16)).toEqual(new TextEncoder().encode("four"));
    expect(await derivedIndex()).toEqual([
      { basis: fourth, totalBytes: 4 },
      { basis: bases[0], totalBytes: 64 },
      { basis: bases[2], totalBytes: 64 },
    ]);
  });

  it("does not rewrite metadata when reading the current MRU basis", async () => {
    const cache = await openPaginationCache();
    const olderBasis = "1".repeat(64);
    await cache.write(olderBasis, record, new Uint8Array([1]), { signal });
    await cache.write(basis, record, new Uint8Array([2]), { signal });
    const derived = derivedCache();
    const writesBeforeMruRead = derived.indexPutCalls;

    expect(await read(cache, basis, 1)).toEqual(new Uint8Array([2]));
    expect(derived.indexPutCalls).toBe(writesBeforeMruRead);
    await read(cache, olderBasis, 1);
    await read(cache, olderBasis, 1);
    expect(derived.indexPutCalls).toBe(writesBeforeMruRead + 1);
  });

  it("accounts for replacement and removal from target Content-Length", async () => {
    const cache = await openPaginationCache();
    const secondRecord = "d".repeat(64);
    await cache.write(basis, record, new Uint8Array(10), { signal });
    await cache.write(basis, secondRecord, new Uint8Array(7), { signal });
    await cache.write(basis, record, new Uint8Array(3), { signal });

    expect(await derivedIndex()).toEqual([{ basis, totalBytes: 10 }]);
    await cache.remove?.(basis, secondRecord, { signal });
    expect(await derivedIndex()).toEqual([{ basis, totalBytes: 3 }]);
  });

  it("enforces the aggregate quota after replacements and removals", async () => {
    const cache = await openPaginationCache();
    const recordBytes = 64 * 1024;
    for (let index = 0; index < 64; index += 1) {
      await cache.write(basis, index.toString(16).padStart(64, "0"), new Uint8Array(recordBytes), {
        signal,
      });
    }

    const replacement = "0".repeat(64);
    const removed = "1".padStart(64, "0");
    const additional = "f".repeat(64);
    await expect(cache.write(basis, additional, new Uint8Array(1), { signal })).rejects.toThrow(
      "pagination cache aggregate is oversized",
    );
    await cache.write(basis, replacement, new Uint8Array(1), { signal });
    await expect(
      cache.write(basis, additional, new Uint8Array(recordBytes), { signal }),
    ).rejects.toThrow("pagination cache aggregate is oversized");
    await cache.remove?.(basis, removed, { signal });
    await cache.write(basis, additional, new Uint8Array(recordBytes), { signal });

    expect(await derivedIndex()).toEqual([
      { basis, totalBytes: 4 * 1024 * 1024 - (recordBytes - 1) },
    ]);
  });

  it("bounds response streaming and observes abort signals", async () => {
    const host = new AbortController();
    const cache = await openPaginationCache(host.signal);
    await cache.write(basis, record, new Uint8Array([1, 2, 3, 4]), { signal });

    expect(await read(cache, basis, 3)).toBeNull();
    host.abort();
    await expect(read(cache, basis, 4)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a bounded read when its operation aborts in flight", async () => {
    const cache = await openPaginationCache();
    await cache.write(basis, record, new Uint8Array([1]), { signal });
    let cancelRead: (() => void) | undefined;
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>((resolve) => (cancelRead = resolve)),
      cancel: () => cancelRead?.(),
    });
    await derivedCache().put(
      entryUrl(basis),
      new Response(stalled, { headers: { "Content-Length": "1" } }),
    );
    const operation = new AbortController();

    const pending = read(cache, basis, 16, record, operation.signal);
    await Promise.resolve();
    operation.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects oversized writes and removes oversized stored records", async () => {
    const cache = await openPaginationCache();
    await expect(
      cache.write(basis, record, new Uint8Array(64 * 1024 + 1), { signal }),
    ).rejects.toThrow("pagination cache record is oversized");

    const derived = await cacheStorage.open(localPaginationCacheName(publicationId));
    await derived.put(entryUrl(basis), new Response(new Uint8Array(64 * 1024 + 1)));
    expect(await read(cache, basis, 64 * 1024)).toBeNull();
    expect(await derived.match(entryUrl(basis))).toBeUndefined();
  });

  it("rejects unindexed entries and discards a basis with invalid size accounting", async () => {
    const cache = await openPaginationCache();
    await cache.write(basis, record, new Uint8Array([1]), { signal });
    const derived = derivedCache();
    const orphanBasis = "e".repeat(64);
    await derived.put(
      entryUrl(orphanBasis),
      new Response(new Uint8Array([2]), { headers: { "Content-Length": "1" } }),
    );
    expect(await read(cache, orphanBasis, 1)).toBeNull();
    expect(await derived.match(entryUrl(orphanBasis))).toBeUndefined();

    await derived.put(entryUrl(basis), new Response(new Uint8Array([3])));
    expect(await read(cache, basis, 1)).toBeNull();
    expect(await derivedIndex()).toEqual([]);
  });

  it("clears every derived entry when metadata uses an incompatible shape", async () => {
    const cache = await openPaginationCache();
    const derived = await cacheStorage.open(localPaginationCacheName(publicationId));
    await derived.put(
      indexUrl,
      new Response(JSON.stringify({ schema: 2, bases: [{ basis, totalBytes: 1 }] })),
    );
    await derived.put(
      entryUrl(basis),
      new Response(new Uint8Array([1]), { headers: { "Content-Length": "1" } }),
    );

    expect(await read(cache, basis, 1)).toBeNull();
    expect(await derived.keys()).toEqual([]);
  });

  it("recovers by clearing the cache after an interrupted metadata commit", async () => {
    const cache = await openPaginationCache();
    await cache.write(basis, record, new Uint8Array(10), { signal });
    const derived = derivedCache();
    derived.failBeforeIndexPut = derived.indexPutCalls + 2;

    await expect(cache.write(basis, record, new Uint8Array(3), { signal })).rejects.toThrow(
      "injected index failure",
    );
    derived.failBeforeIndexPut = null;

    expect(await read(createLocalPaginationCache(publicationId, signal), basis, 16)).toBeNull();
    expect(await derived.keys()).toEqual([]);
  });

  it("marks an update before deleting a malformed existing basis", async () => {
    const cache = await openPaginationCache();
    await cache.write(basis, record, new Uint8Array([1]), { signal });
    const derived = derivedCache();
    derived.responses.set(entryUrl(basis), new Response(new Uint8Array([2])));
    derived.failBeforeDelete = derived.deleteCalls + 1;

    await expect(cache.write(basis, record, new Uint8Array([3]), { signal })).rejects.toThrow(
      "injected delete failure",
    );
    expect(await derivedIndex()).toEqual({ state: "updating" });

    derived.failBeforeDelete = null;
    expect(await read(createLocalPaginationCache(publicationId, signal), basis, 16)).toBeNull();
    expect(await derived.keys()).toEqual([]);
  });

  it("keeps bounded metadata without enumerating or streaming sibling records", async () => {
    const cache = await openPaginationCache();
    const count = 500;
    const recordKey = (index: number) => index.toString(16).padStart(64, "0");
    for (let index = 0; index < count; index += 1) {
      await cache.write(basis, recordKey(index), new Uint8Array([index % 256]), { signal });
    }
    const derived = derivedCache();
    expect(derived.keyCalls).toBe(0);
    expect(derived.entryMatchCalls).toBe(count);
    const index = derived.responses.get(indexUrl)!;
    expect((await index.clone().text()).length).toBeLessThan(512);
    expect(await index.clone().json()).toEqual([{ basis, totalBytes: count }]);

    for (let entry = 0; entry < count; entry += 1) await read(cache, basis, 1, recordKey(entry));
    expect(derived.keyCalls).toBe(0);
    expect(derived.entryMatchCalls).toBe(2 * count);
  });
});
