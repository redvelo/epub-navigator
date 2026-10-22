import { describe, expect, it, vi } from "vitest";

const resource = (kind: string, value: string, presence: string) => ({
  address: { kind, value },
  presence: { state: presence, sizeBytes: null },
  declarations: [],
  hasXhtmlDeclaration: false,
  hasStylesheetDeclaration: false,
  hasSvgDeclaration: false,
  scripted: false,
});

const facts = (resources: unknown[] = []) => ({
  package: { manifest: { items: [] as unknown[] } },
  navigation: null,
  resources: {
    packagePath: "EPUB/package.opf",
    resources,
    declarations: [] as unknown[] | undefined,
    readingOrder: [] as unknown[],
    selections: {},
  },
  navigationLoading: {},
  navigationTargets: [],
});

const analysis = (fields: object) =>
  vi.fn(() =>
    JSON.stringify({
      searchDocuments: [],
      searchEntries: [],
      searchDocumentStates: {},
      ...fields,
    }),
  );

async function open(publication: Record<string, unknown> | (() => never)) {
  vi.resetModules();
  const { initializeWasm, openWasmPublication } = await import("./fixtures/epub-navigator");
  initializeWasm.mockResolvedValue(undefined);
  if (typeof publication === "function") openWasmPublication.mockImplementation(publication);
  else
    openWasmPublication.mockReturnValue(
      Object.create(
        { readResource: vi.fn(), free: vi.fn() },
        Object.getOwnPropertyDescriptors(publication),
      ),
    );
  const { openLocalPublication } = await import("../src/local/publication");
  return openLocalPublication(new Uint8Array());
}

describe("openLocalPublication", () => {
  const missingDeclarations = facts();
  missingDeclarations.resources.declarations = undefined;

  it.each([
    ["null", "publication-facts-invalid"],
    ["{}", "publication-facts-invalid"],
    ['{"resources":null}', "publication-facts-invalid"],
    [JSON.stringify(facts([null])), "publication-facts-invalid"],
    [JSON.stringify(missingDeclarations), "publication-facts-invalid"],
    ["not JSON", "publication-facts-parse-failed"],
  ])("rejects publication facts %s and frees the allocation", async (json, code) => {
    const free = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    await expect(open({ publicationFactsJson: json, free })).rejects.toMatchObject({
      name: "NavigatorError",
      failure: { code },
    });
    expect(free).toHaveBeenCalledOnce();
  });

  it("normalizes publication open and facts acquisition failures", async () => {
    await expect(
      open(() => {
        throw new Error("archive rejected");
      }),
    ).rejects.toMatchObject({
      failure: { code: "publication-open-failed", message: "archive rejected" },
    });

    const free = vi.fn();
    await expect(
      open({
        get publicationFactsJson() {
          throw new Error("facts unavailable");
        },
        free,
      }),
    ).rejects.toMatchObject({
      failure: { code: "publication-facts-read-failed", message: "facts unavailable" },
    });
    expect(free).toHaveBeenCalledOnce();
  });

  it("normalizes resource read failures with exact caller input", async () => {
    const publication = await open({
      publicationFactsJson: JSON.stringify(facts()),
      readResource: vi.fn(() => {
        throw new Error("provider failed");
      }),
    });

    expect(() => publication.readResource("../invalid")).toThrowError(
      expect.objectContaining({
        failure: { code: "resource-read-failed", message: "provider failed", path: "../invalid" },
      }),
    );
  });

  it("snapshots only provider-present local resource paths", async () => {
    const publication = await open({
      publicationFactsJson: JSON.stringify(
        facts([
          resource("local", "EPUB/package.opf", "present"),
          resource("local", "EPUB/provider-only.bin", "present"),
          resource("local", "EPUB/missing.xhtml", "missing"),
          resource("remote", "https://example.com/remote.css", "not-applicable"),
          resource("data", "data:text/plain,hello", "not-applicable"),
          resource("external", "mailto:reader@example.com", "not-applicable"),
          resource("invalid", "not a URL", "not-applicable"),
        ]),
      ),
    });
    const present = ["EPUB/package.opf", "EPUB/provider-only.bin"];

    expect(publication.availableResourcePaths).toEqual(present);
    expect(Object.isFrozen(publication.availableResourcePaths)).toBe(true);
    publication.facts.resources.resources.length = 0;
    expect(publication.availableResourcePaths).toEqual(present);
    publication.close();
    expect(publication.availableResourcePaths).toEqual(present);
    expect(() => publication.readResource("EPUB/package.opf")).toThrowError(
      expect.objectContaining({
        failure: { code: "publication-closed", message: "the EPUB publication is closed" },
      }),
    );
  });

  it("drops oversized search products instead of failing the analysis", async () => {
    const { MAX_LOCAL_SEARCH_ENTRIES_BYTES } = await import("../src/local/publication");
    const text = "a".repeat(8_192);
    const value = facts([
      resource("local", "EPUB/chapter.xhtml", "present"),
      resource("local", "EPUB/image.png", "present"),
    ]);
    value.package.manifest.items = [{ href: "chapter.xhtml" }];
    value.resources.declarations = [
      {
        id: { state: "valid", value: "chapter" },
        href: "chapter.xhtml",
        target: { state: "resource", resource: 0 },
        mediaType: "application/xhtml+xml",
        fallback: null,
        fallbackTarget: null,
      },
    ];
    value.resources.readingOrder = [
      { idref: "chapter", target: { state: "declaration", value: 0 }, resource: 0, linear: "yes" },
    ];
    const publication = await open({
      publicationFactsJson: JSON.stringify(value),
      analysisJson: analysis({
        executableContent: ["analyzed-absent", "analyzed-absent"],
        foregroundPreparation: ["eligible", "ineligible"],
        searchDocuments: [
          { occurrence: 0, resourcePath: "EPUB/chapter.xhtml", source: "chapter.xhtml" },
        ],
        searchEntries: Array.from(
          { length: MAX_LOCAL_SEARCH_ENTRIES_BYTES / text.length + 8 },
          (_, index) => ({
            id: `EPUB/chapter.xhtml#${index}`,
            resourcePath: "EPUB/chapter.xhtml",
            fragment: null,
            text,
            source: "chapter.xhtml",
            readingOrderOccurrenceIndexes: [0],
          }),
        ),
        searchDocumentStates: {
          "EPUB/chapter.xhtml": "complete",
          "EPUB/image.png": "inapplicable",
        },
      }),
    });

    expect(publication.analysis()).toMatchObject({
      executableContent: ["analyzed-absent", "analyzed-absent"],
      searchEntries: [],
      searchDocuments: [],
      searchDocumentStates: {
        "EPUB/chapter.xhtml": "unavailable",
        "EPUB/image.png": "inapplicable",
      },
    });
  });

  it("parses and validates one aligned combined analysis snapshot", async () => {
    const aligned = await open({
      publicationFactsJson: JSON.stringify(
        facts([
          resource("local", "EPUB/chapter.xhtml", "present"),
          resource("local", "EPUB/active.xhtml", "present"),
          resource("local", "EPUB/unknown.xhtml", "present"),
        ]),
      ),
      analysisJson: analysis({
        executableContent: ["analyzed-absent", "detected", "unknown"],
        foregroundPreparation: ["eligible", "ineligible", "unknown"],
        searchDocumentStates: {
          "EPUB/chapter.xhtml": "complete",
          "EPUB/active.xhtml": "complete",
          "EPUB/unknown.xhtml": "unavailable",
        },
      }),
    });
    const value = aligned.analysis();
    expect(value).toMatchObject({
      foregroundPreparation: ["eligible", "ineligible", "unknown"],
      executableContent: ["analyzed-absent", "detected", "unknown"],
      searchDocumentStates: { "EPUB/chapter.xhtml": "complete" },
    });
    expect(Object.isFrozen(value.foregroundPreparation)).toBe(true);

    const misaligned = await open({
      publicationFactsJson: JSON.stringify(
        facts([resource("local", "EPUB/chapter.xhtml", "present")]),
      ),
      analysisJson: analysis({
        executableContent: ["analyzed-absent"],
        foregroundPreparation: ["eligible"],
        searchDocumentStates: { "EPUB/other.xhtml": "complete" },
      }),
    });
    expect(() => misaligned.analysis()).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: "publication-facts-read-failed",
          message: "publication analysis is invalid or not aligned with publication facts",
        }),
      }),
    );
  });

  it("normalizes allocation cleanup failure and remains closed", async () => {
    const free = vi.fn(() => {
      throw new Error("destructor trapped");
    });
    const publication = await open({ publicationFactsJson: JSON.stringify(facts()), free });

    expect(() => publication.close()).toThrowError(
      expect.objectContaining({
        failure: { code: "publication-close-failed", message: "destructor trapped" },
      }),
    );
    publication.close();
    expect(free).toHaveBeenCalledOnce();
    expect(() => publication.readResource("EPUB/package.opf")).toThrowError(
      expect.objectContaining({ failure: expect.objectContaining({ code: "publication-closed" }) }),
    );
  });
});
