import { describe, expect, it, vi } from "vitest";
import type { PublicationFacts } from "../src/generated/publication.js";
import type {
  NavigatorSearchProviderOutcome,
  NavigatorSearchRequest,
  NavigatorSearchResult,
} from "../src/search.js";
import {
  createNavigatorSearchCoordinator,
  type PublicationSearchCapabilities,
} from "../src/runtime/search.js";

describe("publication search host contract", () => {
  it("loads stable publication-ordered continuation batches and selects a result", async () => {
    const requests: NavigatorSearchRequest[] = [];
    const capability = capabilities(async (request) => {
      requests.push(request);
      return completed(
        request,
        request.continuation === null ? [result("r1", 0)] : [result("r2", 1)],
        request.continuation === null ? "next" : null,
        2,
      );
    });
    const coordinator = coordinate(capability, "request-1");

    await expect(coordinator.submit("  rabbit  ", { type: "publication" })).resolves.toMatchObject({
      state: "ready",
      session: {
        requestId: "request-1",
        query: "rabbit",
        continuation: "next",
        totalResultCount: 2,
        results: [{ id: "r1" }],
      },
    });
    await expect(coordinator.continue()).resolves.toMatchObject({
      state: "ready",
      session: {
        continuation: null,
        results: [{ id: "r1" }, { id: "r2" }],
      },
    });
    expect(coordinator.select("r2")).toMatchObject({
      state: "ready",
      session: { selectedResultId: "r2" },
    });
    expect(requests).toEqual([
      {
        requestId: "request-1",
        query: "rabbit",
        scope: { type: "publication" },
        initiator: "query-entry",
        continuation: null,
        limit: 100,
      },
      {
        requestId: "request-1",
        query: "rabbit",
        scope: { type: "publication" },
        initiator: "query-entry",
        continuation: "next",
        limit: 100,
      },
    ]);

    coordinator.close();
    coordinator.close();
    expect(capability.close).toHaveBeenCalledTimes(1);
  });

  it("binds occurrence scope to the canonical reading-order resource", async () => {
    const search = vi.fn(async (request: NavigatorSearchRequest) =>
      completed(request, [result("r2", 1)], null, 1, 1),
    );
    const capability = capabilities(search);
    const coordinator = coordinate(capability, "request-section");

    await coordinator.submit(
      "rabbit",
      { type: "occurrence", occurrence: 1, resource: "EPUB/two.xhtml" },
      "selection",
    );
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: "selection",
        scope: {
          type: "occurrence",
          occurrence: 1,
          resource: "EPUB/two.xhtml",
        },
      }),
      { signal: expect.any(AbortSignal) },
    );
    await expect(
      coordinator.submit("rabbit", {
        type: "occurrence",
        occurrence: 1,
        resource: "EPUB/one.xhtml",
      }),
    ).rejects.toThrow("occurrence search scope is invalid");
    coordinator.close();
  });

  it("aborts a superseded request and ignores its late response", async () => {
    const first = Promise.withResolvers<NavigatorSearchProviderOutcome>();
    const signals: AbortSignal[] = [];
    let call = 0;
    const capability = capabilities((request, context) => {
      signals.push(context.signal);
      call += 1;
      return call === 1
        ? first.promise
        : Promise.resolve(completed(request, [result("new", 0)], null, 1));
    });
    const ids = ["old-request", "new-request"];
    const coordinator = createNavigatorSearchCoordinator({
      facts: facts(),
      capabilities: capability.value,
      createRequestId: () => ids.shift() ?? "unexpected",
    });

    const oldSearch = coordinator.submit("old", { type: "publication" });
    const newSearch = coordinator.submit("new", { type: "publication" });
    expect(signals[0]?.aborted).toBe(true);
    await newSearch;
    first.resolve(completed({ requestId: "old-request" }, [result("late", 0)], null, 1));
    await oldSearch;
    expect(coordinator.snapshot()).toMatchObject({
      state: "ready",
      session: {
        requestId: "new-request",
        query: "new",
        results: [{ id: "new" }],
      },
    });
    coordinator.close();
  });

  it("validates an in-flight search against its immutable pre-projection reading order", async () => {
    const response = Promise.withResolvers<NavigatorSearchProviderOutcome>();
    const capability = capabilities(() => response.promise);
    const coordinator = coordinate(capability, "pre-projection");

    const search = coordinator.submit("rabbit", { type: "publication" });
    coordinator.setReadingOrder([
      {
        ordinal: 0,
        target: { state: "declaration", declaration: 0, resource: 0 },
        selectedDeclaration: 2,
        linear: "yes",
        presentation: {} as never,
        document: {
          state: "loadable",
          resource: "EPUB/fallback.xhtml",
          adapter: "reflowable-xhtml",
        },
      },
      {
        ordinal: 1,
        target: { state: "declaration", declaration: 1, resource: 1 },
        selectedDeclaration: 1,
        linear: "yes",
        presentation: {} as never,
        document: {
          state: "loadable",
          resource: "EPUB/two.xhtml",
          adapter: "reflowable-xhtml",
        },
      },
    ]);
    response.resolve(
      completed({ requestId: "pre-projection" }, [result("authored-result", 0)], null, 1),
    );

    await expect(search).resolves.toMatchObject({
      state: "ready",
      session: {
        results: [{ id: "authored-result", section: { resource: "EPUB/one.xhtml" } }],
      },
    });
    coordinator.close();
  });

  it("retains active selection changed while a continuation is pending", async () => {
    const next = Promise.withResolvers<NavigatorSearchProviderOutcome>();
    let call = 0;
    const capability = capabilities((request) => {
      call += 1;
      return call === 1
        ? Promise.resolve(completed(request, [result("r1", 0)], "next", 2))
        : next.promise;
    });
    const coordinator = coordinate(capability, "request-selection");

    await coordinator.submit("rabbit", { type: "publication" });
    const continuation = coordinator.continue();
    coordinator.select("r1");
    next.resolve(completed({ requestId: "request-selection" }, [result("r2", 1)], null, 2));
    await continuation;
    expect(coordinator.snapshot()).toMatchObject({
      state: "ready",
      session: {
        selectedResultId: "r1",
        results: [{ id: "r1" }, { id: "r2" }],
      },
    });
    coordinator.close();
  });

  it.each([
    [
      "a duplicate result ID",
      [
        [["same", 0], "next"],
        [["same", 1], null],
      ],
      "the search response contains a duplicate result ID",
    ],
    [
      "a repeated continuation",
      [
        [["r1", 0], "a"],
        [["r2", 1], "b"],
        [["r3", 1], "a"],
      ],
      "the search continuation repeated",
    ],
    [
      "an empty non-final batch",
      [
        [["r1", 0], "a"],
        [null, "b"],
      ],
      "the search continuation did not add results",
    ],
  ] as const)(
    "retains accepted results when a continuation returns %s",
    async (_, batches, message) => {
      const responses = [...batches];
      const capability = capabilities(async (request) => {
        const [item, continuation] = responses.shift()!;
        return completed(request, item === null ? [] : [result(item[0], item[1])], continuation, 3);
      });
      const coordinator = coordinate(capability, "request-invalid");

      await coordinator.submit("rabbit", { type: "publication" });
      for (let batch = 2; batch < batches.length; batch += 1) await coordinator.continue();
      const accepted = batches.slice(0, -1);
      await expect(coordinator.continue()).resolves.toMatchObject({
        state: "failed",
        message,
        session: {
          results: accepted.map(([item]) => ({ id: item![0] })),
          continuation: accepted.at(-1)![1],
        },
      });
      coordinator.close();
    },
  );

  it("publishes capability revocation without discarding the accepted session", async () => {
    const capability = capabilities(async (request) =>
      completed(request, [result("r1", 0)], null, 1),
    );
    const coordinator = coordinate(capability, "request-revoked");
    const snapshots: string[] = [];
    coordinator.subscribe((snapshot) => snapshots.push(snapshot.state));

    await coordinator.submit("rabbit", { type: "publication" });
    capability.controller.abort();
    expect(coordinator.snapshot()).toMatchObject({
      state: "unavailable",
      reason: "snapshot-unavailable",
      session: { results: [{ id: "r1" }] },
    });
    expect(snapshots).toEqual(["idle", "querying", "ready", "unavailable"]);
    coordinator.close();
  });

  it("preserves partial coverage independently from result continuation", async () => {
    const capability = capabilities(async (request) => ({
      status: "completed",
      batch: {
        requestId: request.requestId,
        results: [],
        coverage: {
          state: "partial",
          searchedOccurrences: 1,
          totalOccurrences: 2,
          reason: "one resource was not indexed",
        },
        continuation: null,
        totalResultCount: 0,
      },
    }));
    const coordinator = coordinate(capability, "request-partial");

    await expect(coordinator.submit("rabbit", { type: "publication" })).resolves.toMatchObject({
      state: "ready",
      session: {
        results: [],
        continuation: null,
        coverage: {
          state: "partial",
          searchedOccurrences: 1,
          totalOccurrences: 2,
        },
      },
    });
    coordinator.close();
  });

  it.each([
    [
      "a malformed authored target",
      { ...result("bad", 0), targetJson: "not json" },
      completeCoverage(2),
      "a search result target is not a JSON object",
    ],
    [
      "inconsistent complete coverage",
      null,
      {
        state: "complete",
        searchedOccurrences: 1,
        totalOccurrences: 2,
      } as const,
      "complete search coverage is inconsistent",
    ],
  ])("rejects %s atomically", async (_, item, coverage, message) => {
    const capability = capabilities(async (request) => ({
      status: "completed",
      batch: {
        requestId: request.requestId,
        results: item === null ? [] : [item],
        coverage,
        continuation: null,
        totalResultCount: item === null ? 0 : 1,
      },
    }));
    const coordinator = coordinate(capability, "request-malformed");
    await expect(coordinator.submit("rabbit", { type: "publication" })).resolves.toMatchObject({
      state: "failed",
      message,
      session: { results: [] },
    });
    coordinator.close();
  });
});

function coordinate(capability: ReturnType<typeof capabilities>, requestId: string) {
  return createNavigatorSearchCoordinator({
    facts: facts(),
    capabilities: capability.value,
    createRequestId: () => requestId,
  });
}

function capabilities(
  search: PublicationSearchCapabilities["search"],
  scopes: PublicationSearchCapabilities["scopes"] = ["publication", "occurrence"],
): {
  readonly value: PublicationSearchCapabilities;
  readonly controller: AbortController;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const controller = new AbortController();
  const close = vi.fn();
  return {
    controller,
    close,
    value: { scopes, signal: controller.signal, search, close },
  };
}

function completed(
  request: Pick<NavigatorSearchRequest, "requestId">,
  results: readonly NavigatorSearchResult[],
  continuation: string | null,
  totalResultCount: number,
  coverageOccurrences = 2,
): NavigatorSearchProviderOutcome {
  return {
    status: "completed",
    batch: {
      requestId: request.requestId,
      results,
      coverage: completeCoverage(coverageOccurrences),
      continuation,
      totalResultCount,
    },
  };
}

function completeCoverage(totalOccurrences: number) {
  return {
    state: "complete" as const,
    searchedOccurrences: totalOccurrences,
    totalOccurrences,
  };
}

function result(id: string, occurrence: number): NavigatorSearchResult {
  const resource = occurrence === 0 ? "EPUB/one.xhtml" : "EPUB/two.xhtml";
  return {
    id,
    section: {
      id: `section-${occurrence}`,
      occurrence,
      resource,
      label: `Section ${occurrence + 1}`,
    },
    targetJson: JSON.stringify({
      source: resource,
      selector: { type: "TextPositionSelector", start: 1, end: 7 },
    }),
    excerpt: { before: "the ", match: "rabbit", after: " ran" },
  };
}

function facts(): PublicationFacts {
  return {
    package: {} as PublicationFacts["package"],
    navigation: null,
    resources: {
      packagePath: "EPUB/package.opf",
      coverPath: null,
      resources: ["one", "two"].map((name, ordinal) => ({
        address: { kind: "local" as const, value: `EPUB/${name}.xhtml` },
        presence: { state: "present" as const, sizeBytes: null },
        declarations: [ordinal],
        hasXhtmlDeclaration: true,
        hasStylesheetDeclaration: false,
        hasSvgDeclaration: false,
        scripted: false,
      })),
      declarations: [],
      readingOrder: [0, 1].map((ordinal) => ({
        idref: `chapter-${ordinal}`,
        target: { state: "declaration" as const, value: ordinal },
        resource: ordinal,
        linear: "yes" as const,
        presentation: {} as PublicationFacts["resources"]["readingOrder"][number]["presentation"],
      })),
      selections: {},
    },
    navigationLoading: {} as PublicationFacts["navigationLoading"],
    navigationTargets: [],
  };
}
