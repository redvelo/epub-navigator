// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { resolveAnnotationTargetInDocument } from "../src/runtime/content-agent/targets/resolver/annotation.js";
import { invalidateDocumentTextIndex } from "../src/runtime/content-agent/targets/resolver/text-index.js";
import type { PublicationFacts } from "../src/generated/publication.js";
import { createLocalSearchCapabilities } from "../src/local/search.js";
import {
  isLocalSearchEntries,
  isLocalSearchProjection,
  type LocalSearchEntry,
} from "../src/local/publication.js";

describe("browser-local search", () => {
  it.each([
    ["<p><span hidden>Hidden</span>Visible</p>", "HiddenVisible", "Visible", "resolved"],
    ["<p><span hidden>Hidden</span>Visible Visible</p>", "HiddenVisible", "Visible", "ambiguous"],
    ["<p>first cat second cat</p>", "first cat second cat", "cat", "resolved"],
  ])(
    "resolves source search evidence against rendered text: %s",
    async (html, text, query, expected) => {
      document.body.innerHTML = html;
      invalidateDocumentTextIndex(document);
      const lease = capabilities([{ ...entries()[0]!, text, fragment: null }]);
      const outcome = await lease.search(
        request(query, { type: "occurrence", occurrence: 0, resource: "EPUB/one.xhtml" }, 10),
        context(),
      );
      if (outcome.status !== "completed") throw new Error("search did not complete");
      expect(outcome.batch.results.length).toBeGreaterThan(0);
      for (const result of outcome.batch.results) {
        const target = JSON.parse(result.targetJson) as { selector: { value: string }[] };
        const resolved = await resolveAnnotationTargetInDocument(
          document,
          {
            selectors: target.selector.map((selector, index) => ({
              path: [index],
              kind: "text-fragment" as const,
              values: { value: selector.value },
              refinements: [],
            })),
          },
          {
            signal: new AbortController().signal,
            maximumWorkUnits: 100_000,
            yieldEveryWorkUnits: 64,
          },
        );
        expect(resolved.outcome).toBe(expected);
        if (expected === "resolved") expect(resolved.range?.toString()).toBe(query);
      }
      lease.close();
    },
  );

  it("returns every match in duplicate reading-order occurrence order", async () => {
    const lease = capabilities();
    const first = await lease.search(request("ÉCOLE", { type: "publication" }, 1), context());
    expect(first.status).toBe("completed");
    if (first.status !== "completed") return;
    expect(first.batch.results.map((result) => result.section.occurrence)).toEqual([0]);
    expect(first.batch.coverage).toEqual({
      state: "partial",
      searchedOccurrences: 2,
      totalOccurrences: 3,
      reason: "Some reading-order documents were not completely analyzed.",
    });
    expect(JSON.parse(first.batch.results[0]?.targetJson ?? "null")).toEqual({
      source: "one.xhtml",
      selector: [
        {
          type: "FragmentSelector",
          value: "first",
          refinedBy: {
            type: "FragmentSelector",
            value: "text=A%20cat%20-,%C3%89cole,-%20cat",
            conformsTo: "https://wicg.github.io/scroll-to-text-fragment/",
          },
        },
        {
          type: "FragmentSelector",
          value: "first",
          refinedBy: {
            type: "FragmentSelector",
            value: "text=%C3%89cole",
            conformsTo: "https://wicg.github.io/scroll-to-text-fragment/",
          },
        },
      ],
    });

    const second = await lease.search(
      request("ÉCOLE", { type: "publication" }, 10, first.batch.continuation),
      context(),
    );
    expect(second.status).toBe("completed");
    if (second.status === "completed") {
      expect(second.batch.results.map((result) => result.section.occurrence)).toEqual([1]);
      expect(second.batch.continuation).toBeNull();
    }
  });

  it("gives repeated matches distinct surrounding text evidence", async () => {
    const lease = capabilities();
    const outcome = await lease.search(
      request("cat", { type: "occurrence", occurrence: 0, resource: "EPUB/one.xhtml" }, 10),
      context(),
    );
    if (outcome.status !== "completed") throw new Error("search did not complete");
    expect(
      outcome.batch.results.map(
        (result) => JSON.parse(result.targetJson).selector[0].refinedBy.value,
      ),
    ).toEqual(["text=A%20-,cat,-%20%C3%89cole%20cat", "text=A%20cat%20%C3%89cole%20-,cat"]);
    lease.close();
  });

  it("binds continuations to the exact query and scope", async () => {
    const lease = capabilities();
    const first = await lease.search(request("cat", { type: "publication" }, 1), context());
    if (first.status !== "completed") throw new Error("search did not complete");

    const changed = await lease.search(
      request("dog", { type: "publication" }, 1, first.batch.continuation),
      context(),
    );
    expect(changed).toEqual({ status: "failed", message: "The search continuation is invalid." });
  });

  it("supports occurrence scope, browser text reconciliation, and aborts", async () => {
    const lease = capabilities();
    const outcome = await lease.search(
      request("cat", { type: "occurrence", occurrence: 2, resource: "EPUB/two.xhtml" }, 10),
      context(),
    );
    if (outcome.status !== "completed") throw new Error("search did not complete");
    expect(outcome.batch.results).toHaveLength(1);
    expect(JSON.parse(outcome.batch.results[0]?.targetJson ?? "null")).toMatchObject({
      source: "two.xhtml",
      selector: [
        {
          type: "FragmentSelector",
          value: "second",
          refinedBy: {
            type: "FragmentSelector",
            value: "text=another%20-,cat",
            conformsTo: "https://wicg.github.io/scroll-to-text-fragment/",
          },
        },
        {
          type: "FragmentSelector",
          value: "second",
          refinedBy: {
            type: "FragmentSelector",
            value: "text=cat",
            conformsTo: "https://wicg.github.io/scroll-to-text-fragment/",
          },
        },
      ],
    });
    expect(outcome.batch.coverage).toMatchObject({
      state: "partial",
      searchedOccurrences: 0,
      totalOccurrences: 1,
    });

    const operation = new AbortController();
    operation.abort();
    await expect(
      lease.search(request("cat", { type: "publication" }, 10), { signal: operation.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    lease.close();
    expect(lease.signal.aborted).toBe(true);
  });

  it.each([
    ["resource path", { resourcePath: "EPUB/two.xhtml", source: "one.xhtml" }],
    ["source", { resourcePath: "EPUB/one.xhtml", source: "two.xhtml" }],
  ])("rejects conflicting cached %s identities for one occurrence", (_, identity) => {
    const conflicting = [
      entries()[0]!,
      {
        ...entries()[1]!,
        ...identity,
        readingOrderOccurrenceIndexes: [0],
      },
    ];

    expect(isLocalSearchEntries(entries(), facts())).toBe(true);
    expect(isLocalSearchEntries(conflicting, facts())).toBe(false);
  });

  it("reports complete occurrence coverage for an ordinary analyzed empty document", async () => {
    const controller = new AbortController();
    const lease = createLocalSearchCapabilities(
      facts(),
      { ...documentStates(), "EPUB/two.xhtml": "complete" },
      [{ occurrence: 2, resourcePath: "EPUB/two.xhtml", source: "two.xhtml" }],
      [],
      controller,
      () => controller.abort(),
    );

    const outcome = await lease.search(
      request("absent", { type: "occurrence", occurrence: 2, resource: "EPUB/two.xhtml" }, 10),
      context(),
    );

    expect(outcome).toMatchObject({
      status: "completed",
      batch: {
        results: [],
        coverage: { state: "complete", searchedOccurrences: 1, totalOccurrences: 1 },
      },
    });
  });

  it("keeps an analyzed empty effective fallback available for occurrence search", async () => {
    const fallbackFacts = effectiveFallbackFacts();
    const documents = [
      { occurrence: 0, resourcePath: "EPUB/fallback.xhtml", source: "fallback.xhtml" },
    ] as const;
    expect(isLocalSearchProjection(documents, [], fallbackFacts)).toBe(true);
    const controller = new AbortController();
    const lease = createLocalSearchCapabilities(
      fallbackFacts,
      { "EPUB/chapter.mp3": "inapplicable", "EPUB/fallback.xhtml": "complete" },
      documents,
      [],
      controller,
      () => controller.abort(),
    );

    const outcome = await lease.search(
      request("absent", { type: "occurrence", occurrence: 0, resource: "EPUB/fallback.xhtml" }, 10),
      context(),
    );

    expect(outcome).toMatchObject({
      status: "completed",
      batch: {
        results: [],
        coverage: { state: "complete", searchedOccurrences: 1, totalOccurrences: 1 },
      },
    });
  });
});

function capabilities(searchEntries: readonly LocalSearchEntry[] = entries()) {
  const controller = new AbortController();
  return createLocalSearchCapabilities(
    facts(),
    documentStates(),
    searchDocuments(),
    searchEntries,
    controller,
    () => controller.abort(),
  );
}

function searchDocuments() {
  return [
    { occurrence: 0, resourcePath: "EPUB/one.xhtml", source: "one.xhtml" },
    { occurrence: 1, resourcePath: "EPUB/one.xhtml", source: "one.xhtml" },
    { occurrence: 2, resourcePath: "EPUB/two.xhtml", source: "two.xhtml" },
  ] as const;
}

function request(
  query: string,
  scope:
    | { readonly type: "publication" }
    | {
        readonly type: "occurrence";
        readonly occurrence: number;
        readonly resource: string;
      },
  limit: number,
  continuation: string | null = null,
) {
  return {
    requestId: "request",
    query,
    scope,
    initiator: "query-entry" as const,
    continuation,
    limit,
  };
}

function context() {
  return { signal: new AbortController().signal };
}

function entries(): readonly LocalSearchEntry[] {
  return [
    {
      id: "one",
      resourcePath: "EPUB/one.xhtml",
      fragment: "first",
      text: "A cat École cat",
      source: "one.xhtml",
      readingOrderOccurrenceIndexes: [0, 1],
    },
    {
      id: "two",
      resourcePath: "EPUB/two.xhtml",
      fragment: "second",
      text: "another cat",
      source: "two.xhtml",
      readingOrderOccurrenceIndexes: [2],
    },
  ];
}

function documentStates() {
  return {
    "EPUB/one.xhtml": "complete",
    "EPUB/two.xhtml": "partial",
  } as const;
}

function facts(): PublicationFacts {
  const resources = ["one", "two"].map((name, ordinal) => ({
    address: { kind: "local" as const, value: `EPUB/${name}.xhtml` },
    presence: "present" as const,
    providerMetadata: { sizeBytes: null, fileExtension: "xhtml" },
    declarations: [ordinal],
    hasXhtmlDeclaration: true,
    hasStylesheetDeclaration: false,
    hasSvgDeclaration: false,
    hasSmilDeclaration: false,
    scripted: false,
  }));
  return {
    package: {
      manifest: {
        items: [{ href: "one.xhtml" }, { href: "two.xhtml" }],
      },
    } as PublicationFacts["package"],
    navigation: null,
    resources: {
      packagePath: "EPUB/package.opf",
      resources,
      declarations: [0, 1].map((resource) => ({
        id: { state: "valid" as const, value: `item-${resource}` },
        href: `${resource === 0 ? "one" : "two"}.xhtml`,
        target: { state: "resource" as const, resource },
        mediaType: "application/xhtml+xml",
        fallback: null,
        fallbackTarget: null,
      })),
      readingOrder: [0, 0, 1].map((resource, ordinal) => ({
        ordinal,
        linear: true,
        properties: [],
        target: { state: "declaration" as const, declaration: resource, resource },
      })),
      selections: {},
    },
    navigationLoading: { state: "unavailable", reason: "not-declared" },
    navigationTargets: [],
  } as unknown as PublicationFacts;
}

function effectiveFallbackFacts(): PublicationFacts {
  const value = facts() as unknown as {
    package: { manifest: { items: { href: string }[] } };
    resources: {
      resources: Array<{
        address: { kind: "local"; value: string };
        presence: "present";
      }>;
      readingOrder: Array<{
        ordinal: number;
        target: { state: "declaration"; declaration: number; resource: number };
      }>;
    };
  };
  value.package.manifest.items = [{ href: "chapter.mp3" }, { href: "fallback.xhtml" }];
  value.resources.resources = [
    { address: { kind: "local", value: "EPUB/chapter.mp3" }, presence: "present" },
    { address: { kind: "local", value: "EPUB/fallback.xhtml" }, presence: "present" },
  ];
  value.resources.readingOrder = [
    { ordinal: 0, target: { state: "declaration", declaration: 0, resource: 0 } },
  ];
  (value.resources as { manifestTargets?: unknown }).manifestTargets = [
    { state: "resource", resource: 0 },
    { state: "resource", resource: 1 },
  ];
  return value as unknown as PublicationFacts;
}
