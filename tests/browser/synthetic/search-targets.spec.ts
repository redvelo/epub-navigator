import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import type { PublicationFacts } from "../../../src/generated/publication.js";
import type { AnnotationSelectorNode } from "../../../src/runtime/content-agent/targets/resolver/types.js";

const cases = [
  {
    name: "identical unscoped blocks remain ambiguous",
    html: "<p>Same sentence.</p><p>Same sentence.</p>",
    entries: [
      { text: "Same sentence.", fragment: null },
      { text: "Same sentence.", fragment: null },
    ],
    query: "Same sentence.",
    outcomes: ["ambiguous", "ambiguous"],
  },
  {
    name: "authored scopes distinguish identical blocks",
    html: '<p id="first">Same sentence.</p><p id="second" style="margin-top:1500px">Same sentence.</p>',
    entries: [
      { text: "Same sentence.", fragment: "first" },
      { text: "Same sentence.", fragment: "second" },
    ],
    query: "Same sentence.",
    outcomes: ["resolved", "resolved"],
  },
  {
    name: "context distinguishes repeated matches within a block",
    html: "<p>Before cat between cat after</p>",
    entries: [{ text: "Before cat between cat after", fragment: null }],
    query: "cat",
    outcomes: ["resolved", "resolved"],
  },
  {
    name: "hidden neighboring source text does not prevent a unique match",
    html: "<p><span hidden>Hidden</span>Visible</p>",
    entries: [{ text: "HiddenVisible", fragment: null }],
    query: "Visible",
    outcomes: ["resolved"],
  },
  {
    name: "collapsed CSS whitespace resolves normalized source text",
    html: '<p style="white-space:normal">Alpha\n   beta</p>',
    entries: [{ text: "Alpha beta", fragment: null }],
    query: "Alpha beta",
    outcomes: ["resolved"],
  },
  {
    name: "preserved whitespace does not produce a fabricated phrase range",
    html: "<pre>Alpha\n   beta</pre>",
    entries: [{ text: "Alpha beta", fragment: null }],
    query: "Alpha beta",
    outcomes: ["broken"],
  },
  {
    name: "pre-wrap whitespace does not produce a fabricated phrase range",
    html: '<p style="white-space:pre-wrap">Alpha\n   beta</p>',
    entries: [{ text: "Alpha beta", fragment: null }],
    query: "Alpha beta",
    outcomes: ["broken"],
  },
  {
    name: "a unique word in preserved whitespace remains reachable",
    html: "<pre>Alpha\n   beta</pre>",
    entries: [{ text: "Alpha beta", fragment: null }],
    query: "beta",
    outcomes: ["resolved"],
  },
  {
    name: "CSS text transformation preserves authored text targeting",
    html: '<p style="text-transform:uppercase">Mixed case</p>',
    entries: [{ text: "Mixed case", fragment: null }],
    query: "Mixed case",
    outcomes: ["resolved"],
  },
];

for (const fixture of cases) {
  test(fixture.name, async ({ page }) => {
    await page.route("**/search-target-review", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head></head><body></body></html>",
      }),
    );
    await page.goto("/search-target-review");
    const results = await page.evaluate(
      async ({ fixture, searchModule, resolverModule }) => {
        const { createLocalSearchCapabilities } = (await import(
          /* @vite-ignore */ searchModule
        )) as typeof import("../../../src/local/search.js");
        const { relocateAnnotationTargetInDocument } = (await import(
          /* @vite-ignore */ resolverModule
        )) as typeof import("../../../src/runtime/content-agent/targets/resolver/locator.js");
        document.body.innerHTML = fixture.html;
        document.body.style.minHeight = "3000px";
        const facts = {
          packagePath: "EPUB/package.opf",
          package: { manifest: { items: [{ href: "chapter.xhtml" }] } },
          resources: {
            resources: [
              {
                ordinal: 0,
                address: { kind: "local", value: "EPUB/chapter.xhtml" },
                presence: "present",
              },
            ],
            manifestTargets: [{ state: "resource", resource: 0 }],
            manifestFallbacks: [],
            readingOrder: [
              {
                ordinal: 0,
                linear: true,
                properties: [],
                target: { state: "declaration", declaration: 0, resource: 0 },
              },
            ],
            selections: {},
          },
        } as unknown as PublicationFacts;
        const controller = new AbortController();
        const search = createLocalSearchCapabilities(
          facts,
          { "EPUB/chapter.xhtml": "complete" },
          [{ occurrence: 0, resourcePath: "EPUB/chapter.xhtml", source: "chapter.xhtml" }],
          fixture.entries.map((entry, index) => ({
            ...entry,
            id: String(index),
            resourcePath: "EPUB/chapter.xhtml",
            source: "chapter.xhtml",
            readingOrderOccurrenceIndexes: [0],
          })),
          controller,
          () => controller.abort(),
        );
        const response = await search.search(
          {
            requestId: "review",
            query: fixture.query,
            scope: { type: "publication" },
            initiator: "query-entry",
            continuation: null,
            limit: 10,
          },
          { signal: controller.signal },
        );
        if (response.status !== "completed") throw new Error("search did not complete");
        type Selector = { value: string; conformsTo?: string; refinedBy?: Selector };
        const node = (selector: Selector, path: number[]): AnnotationSelectorNode => ({
          path,
          kind: selector.conformsTo ? "text-fragment" : "html-fragment",
          values: { value: selector.value },
          refinements: selector.refinedBy ? [node(selector.refinedBy, [...path, 0])] : [],
        });
        const results = [];
        for (const result of response.batch.results) {
          const target = JSON.parse(result.targetJson) as { selector: Selector[] };
          window.scrollTo(0, 500);
          const before = window.scrollY;
          let activated = false;
          const resolution = await relocateAnnotationTargetInDocument(
            document,
            { selectors: target.selector.map((selector, index) => node(selector, [index])) },
            { signal: controller.signal, maximumWorkUnits: 100_000, yieldEveryWorkUnits: 64 },
            { mode: "document-scroll" },
            () => {
              activated = true;
            },
          );
          results.push({
            outcome: resolution.outcome,
            activated,
            before,
            after: window.scrollY,
            start: resolution.range?.startOffset ?? null,
            element: resolution.range?.startContainer.parentElement?.id ?? null,
          });
        }
        search.close();
        return results;
      },
      {
        fixture,
        searchModule: `/@fs${fileURLToPath(new URL("../../../src/local/search.ts", import.meta.url))}`,
        resolverModule: `/@fs${fileURLToPath(new URL("../../../src/runtime/content-agent/targets/resolver/locator.ts", import.meta.url))}`,
      },
    );
    expect(results.map((result) => result.outcome)).toEqual(fixture.outcomes);
    for (const result of results) {
      expect(result.activated).toBe(result.outcome === "resolved");
      if (result.outcome !== "resolved") expect(result.after).toBe(result.before);
    }
    if (fixture.name === "authored scopes distinguish identical blocks") {
      expect(results.map((result) => result.element)).toEqual(["first", "second"]);
      expect(results[1]!.after).toBeGreaterThan(results[0]!.after);
    }
    if (fixture.name === "context distinguishes repeated matches within a block") {
      expect(results.map((result) => result.start)).toEqual([7, 19]);
    }
  });
}
