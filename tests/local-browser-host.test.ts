// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  readPublication: vi.fn(),
  readManifest: vi.fn(),
  readSearch: vi.fn(),
  deletePublication: vi.fn(async () => true),
}));

vi.mock("../src/local/storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/local/storage.js")>();
  return {
    ...original,
    createLocalPaginationCache: vi.fn(() => ({
      read: vi.fn(async () => null),
      write: vi.fn(async () => {}),
      removeBasis: vi.fn(async () => {}),
    })),
    readCommittedPublication: storage.readPublication,
    readCommittedResourceManifest: storage.readManifest,
    readCommittedPublicationSnapshot: vi.fn(async (...args: unknown[]) => {
      const publication = await storage.readPublication(...args);
      const searchEntries = await storage.readSearch();
      return publication === undefined || searchEntries === undefined
        ? undefined
        : {
            publication,
            searchDocuments: [
              {
                occurrence: 0,
                resourcePath: "EPUB/chapter.xhtml",
                source: "chapter.xhtml",
              },
            ],
            searchEntries,
          };
    }),
    deletePublicationCache: storage.deletePublication,
    withPublicationLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
  };
});

import { createBrowserLocalHost } from "../src/local/browser-host.js";

const publicationId = "a".repeat(64);

beforeEach(() => {
  vi.restoreAllMocks();
  storage.readPublication.mockReset().mockResolvedValue({
    id: publicationId,
    mount: { remoteResources: "blocked" },
    facts: {
      package: { manifest: { items: [{ href: "chapter.xhtml" }] } },
      resources: {
        resources: [localXhtmlResource("EPUB/chapter.xhtml")],
        readingOrder: [
          {
            ordinal: 0,
            target: { state: "declaration", declaration: 0, resource: 0 },
          },
        ],
      },
    },
    searchDocumentStates: { "EPUB/chapter.xhtml": "complete" },
  });
  storage.readManifest.mockReset().mockResolvedValue({
    resources: [
      {
        path: "EPUB/chapter.xhtml",
        executableContent: "analyzed-absent",
        foregroundPreparation: "eligible",
      },
    ],
  });
  storage.readSearch.mockReset().mockResolvedValue([
    {
      id: "chapter",
      resourcePath: "EPUB/chapter.xhtml",
      fragment: null,
      text: "A searchable chapter",
      source: "chapter.xhtml",
      readingOrderOccurrenceIndexes: [0],
    },
  ]);
  storage.deletePublication.mockReset().mockResolvedValue(true);
  const worker = {
    postMessage: vi.fn((_message: unknown, ports: readonly MessagePort[]) => {
      ports[0]?.postMessage({ type: "configured" });
    }),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller: worker,
      ready: Promise.resolve(),
      register: vi.fn(async () => ({ active: worker })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("agent")),
  );
});

describe("browser-local search capability leases", () => {
  it.each(["close", "remove", "dispose"] as const)("revokes a lease on %s", async (action) => {
    const host = createHost();
    const lease = await host.searchCapabilities(publicationId);
    expect(lease.signal.aborted).toBe(false);

    if (action === "close") lease.close();
    else if (action === "remove") await host.removePublication(publicationId);
    else host.dispose();

    expect(lease.signal.aborted).toBe(true);
    host.dispose();
  });
});

describe("browser-local pagination capability leases", () => {
  it.each([
    ["uses the deployment digest", "b".repeat(64), { measurementArtifactDigest: "b".repeat(64) }],
    ["requires a host digest", undefined, undefined],
  ])("%s for durable pagination reuse without fetching", async (_, digest, cacheIdentity) => {
    const host = createHost({ measurementArtifactDigest: digest });
    const lease = await host.paginationCapabilities(publicationId);

    expect(lease.responses).toBeDefined();
    expect(lease.cacheIdentity).toEqual(cacheIdentity);
    expect(fetch).not.toHaveBeenCalled();
    lease.close();
    host.dispose();
  });

  it("rejects an invalid host measurement digest", () => {
    expect(() => createHost({ measurementArtifactDigest: "invalid" })).toThrowError(
      expect.objectContaining({ code: "local-host-configuration-invalid" }),
    );
  });

  it("owns an abort signal and tolerates repeated cleanup", async () => {
    const host = createHost();
    const lease = await host.paginationCapabilities(publicationId);
    expect(lease.signal.aborted).toBe(false);
    lease.close();
    lease.close();
    expect(lease.signal.aborted).toBe(true);

    const next = await host.paginationCapabilities(publicationId);
    expect(next.signal.aborted).toBe(false);
    host.dispose();
    host.dispose();
    expect(next.signal.aborted).toBe(true);
  });

  it.each(["remove", "dispose"] as const)(
    "prevents late lease registration when acquisition races with %s",
    async (action) => {
      let release: (() => void) | undefined;
      storage.readManifest.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                resources: [{ path: "EPUB/chapter.xhtml", executableContent: "analyzed-absent" }],
              });
          }),
      );
      const host = createHost();
      const pending = host.paginationCapabilities(publicationId);
      await vi.waitFor(() => expect(storage.readManifest).toHaveBeenCalled());
      if (action === "remove") await host.removePublication(publicationId);
      else host.dispose();
      release?.();

      await expect(pending).rejects.toMatchObject({
        code: action === "remove" ? "local-publication-unavailable" : "local-host-unavailable",
      });
    },
  );

  it("keeps measurement and exact foreground preparation filtering distinct", async () => {
    storage.readPublication.mockResolvedValueOnce({
      id: publicationId,
      mount: { remoteResources: "blocked" },
      facts: {
        resources: {
          resources: [
            localXhtmlResource("EPUB/static.xhtml"),
            localXhtmlResource("EPUB/scripted.xhtml", true),
            { ...localXhtmlResource("EPUB/not-xhtml.bin"), hasXhtmlDeclaration: false },
            localXhtmlResource("EPUB/legacy.xhtml"),
          ],
        },
      },
    });
    storage.readManifest.mockResolvedValueOnce({
      resources: [
        {
          path: "EPUB/static.xhtml",
          executableContent: "analyzed-absent",
          foregroundPreparation: "eligible",
        },
        {
          path: "EPUB/scripted.xhtml",
          executableContent: "analyzed-absent",
          foregroundPreparation: "eligible",
        },
        {
          path: "EPUB/not-xhtml.bin",
          executableContent: "analyzed-absent",
          foregroundPreparation: "eligible",
        },
        { path: "EPUB/legacy.xhtml", executableContent: "analyzed-absent" },
      ],
    });
    const host = createHost();
    const lease = await host.paginationCapabilities(publicationId);

    expect(lease.responses?.eligibleResourcePaths).toEqual([
      "EPUB/static.xhtml",
      "EPUB/not-xhtml.bin",
      "EPUB/legacy.xhtml",
    ]);
    expect(lease.foregroundPreparation?.eligibleResourcePaths).toEqual(["EPUB/static.xhtml"]);
    lease.close();
    host.dispose();
  });
});

function localXhtmlResource(path: string, scripted = false) {
  return {
    address: { kind: "local", value: path },
    presence: { state: "present", sizeBytes: null },
    hasXhtmlDeclaration: true,
    scripted,
  };
}

function createHost(overrides: { readonly measurementArtifactDigest?: string | undefined } = {}) {
  return createBrowserLocalHost({
    importWorkerUrl: `${location.origin}/import-worker.js`,
    serviceWorkerUrl: `${location.origin}/service-worker.js`,
    serviceWorkerScope: `${location.origin}/`,
    mountBaseUrl: `${location.origin}/publications/`,
    measurementMountBaseUrl: `${location.origin}/measurements/`,
    contentAgentUrl: `${location.origin}/content-agent.js`,
    measurementArtifactDigest: "b".repeat(64),
    ...overrides,
  });
}
