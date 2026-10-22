import { readFile } from "node:fs/promises";
import { strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { PublicationFacts } from "../src/index.js";
import { openLocalPublication, type PublicationAccess } from "../src/local/publication.js";
import {
  currentAuthoredPageRange,
  projectAuthoredNavigation,
} from "../src/react/navigation/model.js";
import { createNavigatorKernel } from "../src/runtime/kernel.js";
import { instrumentSvg } from "../src/svg-instrumentation.js";
import { initializeNavigatorWasm, WasmPublication } from "../src/wasm.js";
import { instrumentXhtml } from "../src/xhtml-instrumentation.js";
import { corpusPublications } from "./fixtures/epub3-samples/catalog.js";
import { loadCorpusArchive } from "./support/corpus-archive.js";

beforeAll(async () => {
  const wasm = await readFile(
    new URL("../.generated/epub-navigator/epub_navigator_bg.wasm", import.meta.url),
  );
  await initializeNavigatorWasm(wasm);
});

describe("EPUB 3 Samples real-WASM projection", () => {
  it.each(corpusPublications)("opens and closes $title", async (publication) => {
    const archive = await loadCorpusArchive(publication.id);
    const book = await openLocalPublication(archive.bytes);
    try {
      expect(book.facts.resources.packagePath).toBe(publication.packagePath);
      expect(WasmPublication.hashBlake3(archive.bytes)).toBe(publication.blake3);
      expect(book.facts.resources.readingOrder).toHaveLength(publication.readingOrderLength);
      expect(JSON.parse(JSON.stringify(book.facts)) as PublicationFacts).toEqual(book.facts);
      expect(book.availableResourcePaths).toContain(publication.exactResource.path);
      const expectedResource = archive.resources.get(publication.exactResource.path);
      expect(expectedResource).toBeDefined();
      expect(book.readResource(publication.exactResource.path)).toEqual(expectedResource);
      expect(new TextDecoder().decode(expectedResource)).toContain(
        publication.exactResource.includes,
      );

      const readingOrderPaths = new Set(
        book.facts.resources.readingOrder
          .map((entry) => readingOrderPath(book.facts, entry))
          .filter((path): path is string => path !== null),
      );
      for (const resource of book.facts.resources.resources) {
        if (resource.address.kind !== "local" || resource.presence.state !== "present") continue;
        const declaredMediaTypes = resource.declarations
          .map((ordinal) => book.facts.package.manifest.items[ordinal]?.mediaType)
          .filter((value): value is string => value !== null && value !== undefined);
        const declaredEssences = [...new Set(declaredMediaTypes.map(mediaTypeEssence))];
        expect(declaredEssences.length, resource.address.value).toBeLessThanOrEqual(1);
        if (declaredEssences[0] !== undefined) {
          expect(mediaTypeEssence(archive.mediaType(resource.address.value))).toBe(
            declaredEssences[0],
          );
        }
        if (declaredEssences[0] === "application/xhtml+xml") {
          const source = archive.resources.get(resource.address.value);
          expect(source, resource.address.value).toBeDefined();
          const before = source?.slice() as Uint8Array;
          const transformed = instrumentXhtml(source!, {
            contentAgentUrl: "/_epub-navigator/content-agent.js",
          });
          expect(source).toEqual(before);
          expect(transformed.byteLength).toBeGreaterThan(source!.byteLength);
        } else if (
          declaredEssences[0] === "image/svg+xml" &&
          readingOrderPaths.has(resource.address.value)
        ) {
          expect(declaredMediaTypes).toEqual(["image/svg+xml"]);
          expect(archive.mediaType(resource.address.value)).toBe("image/svg+xml");
          expect(resource).toMatchObject({
            hasXhtmlDeclaration: false,
            hasSvgDeclaration: true,
          });
          const source = archive.resources.get(resource.address.value);
          expect(source, resource.address.value).toBeDefined();
          const before = source?.slice() as Uint8Array;
          const transformed = instrumentSvg(source!, {
            contentAgentUrl: "/_epub-navigator/content-agent.js",
          });
          expect(source).toEqual(before);
          expect(transformed.byteLength).toBeGreaterThan(source!.byteLength);
        }
      }

      const kernel = await createNavigatorKernel({
        facts: book.facts,
        mount: {
          baseUrl: `https://reader.example/publications/${publication.id}/`,
          remoteResources: "blocked",
          contentOrigin: "shared-reader-origin",
        },
      });
      try {
        const snapshot = kernel.snapshot();
        expect(snapshot.packagePath).toBe(publication.packagePath);
        expect(snapshot.readingOrder).toHaveLength(publication.readingOrderLength);
        for (const scenario of publication.scenarios) {
          expect(snapshot.readingOrder[scenario.occurrence]).toMatchObject({
            ordinal: scenario.occurrence,
          });
          expect(snapshot.readingOrder[scenario.occurrence]?.document).toMatchObject(
            scenario.kind === "fixed-svg"
              ? {
                  state: "loadable",
                  resource: scenario.resource,
                  adapter: "fixed-svg",
                }
              : {
                  state: "loadable",
                  resource: scenario.resource,
                  adapter: scenario.kind === "fixed-xhtml" ? "fixed-xhtml" : "reflowable-xhtml",
                },
          );
        }
      } finally {
        kernel.close();
      }
    } finally {
      book.close();
    }
    expect(() => book.readResource(publication.exactResource.path)).toThrow(
      "the EPUB publication is closed",
    );
  });

  it("preserves accessibility metadata, navigation hierarchy, and a non-linear cover", async () => {
    await withFacts("accessible-epub-3", (facts) => {
      expect(facts.package.spine.itemrefs[0]).toMatchObject({ idref: "cover", linear: "no" });
      expect(facts.package.metadata.meta).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: expect.objectContaining({ raw: "schema:accessMode" }),
            content: "textual",
          }),
          expect.objectContaining({
            property: expect.objectContaining({ raw: "schema:accessibilityHazard" }),
            content: "none",
          }),
          expect.objectContaining({
            property: expect.objectContaining({ raw: "schema:accessibilityFeature" }),
            content: "tableOfContents",
          }),
        ]),
      );
      expect(facts.package.metadata.link).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            href: "http://www.idpf.org/epub/a11y/accessibility-20170105.html#wcag-aa",
            rel: expect.objectContaining({ raw: "dcterms:conformsTo" }),
          }),
        ]),
      );
      expect(facts.navigation?.lists.map((list) => list.semantic)).toEqual(["toc", "landmarks"]);
      expect(facts.navigation?.lists[0]?.points[2]?.children[0]?.children[0]?.label).toBe(
        "Data Integrity",
      );
    });
  });

  it("distinguishes reflowable and pre-paginated Voyage occurrences", async () => {
    await withFacts("voyage-of-life", (facts) => {
      expect(facts.resources.readingOrder[1]?.presentation.layout.state).toBe("unspecified");
      expect(facts.resources.readingOrder[2]?.presentation.layout).toMatchObject({
        state: "specified",
        value: { value: "pre-paginated", source: "item-ref-property" },
      });
      for (const ordinal of [2, 4, 6, 8]) {
        expect(facts.resources.readingOrder[ordinal]?.presentation).toMatchObject({
          layout: { state: "specified", value: { value: "pre-paginated" } },
          orientation: { state: "specified", value: { value: "landscape" } },
          spread: { state: "specified", value: { value: "none" } },
        });
      }
    });
  });

  it("retains CFI page-list targets as package fragments", async () => {
    await withFacts("georgia-cfi", (facts) => {
      const pageList = facts.navigation?.lists.find((list) => list.semantic === "page-list");
      expect(pageList?.points).toHaveLength(7);
      expect(pageList?.points[0]?.authoredHref).toContain("package.opf#epubcfi(");
      expect(facts.navigationTargets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            listIndex: 2,
            pointPath: [0],
            target: expect.objectContaining({
              state: "resource",
              resource: resourceIndex(facts, "EPUB/package.opf"),
              fragment: expect.stringContaining("epubcfi("),
            }),
          }),
        ]),
      );
    });
  });

  it("preserves distinct Haruko pages, RTL progression, and page spreads", async () => {
    await withFacts("haruko", (facts) => {
      expect(facts.package.spine.pageProgressionDirection).toBe("rtl");
      expect(
        facts.resources.readingOrder.slice(0, 12).map((entry) => readingOrderPath(facts, entry)),
      ).toEqual(
        Array.from(
          { length: 12 },
          (_, index) => `OPS/xhtml/p${String(index + 1).padStart(2, "0")}.xhtml`,
        ),
      );
      expect(pageSpreads(facts).slice(0, 12)).toEqual(alternating(12, "left"));
      expect(facts.resources.readingOrder[12]?.presentation.layout).toMatchObject({
        state: "specified",
        value: { value: "reflowable", source: "item-ref-property" },
      });
    });
  });

  it("retains Unicode internal navigation targets", async () => {
    await withFacts("internal-links", (facts) => {
      expect(facts.navigation?.lists[0]?.points[0]?.children[0]?.authoredHref).toContain(
        "iBooks3_2e0による表示例",
      );
      expect(facts.navigationTargets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: expect.objectContaining({
              state: "resource",
              resource: resourceIndex(facts, "OEBPS/0001.xhtml"),
              fragment: "h.0001.iBooks3_2e0による表示例",
            }),
          }),
        ]),
      );
    });
  });

  it("retains Moby-Dick media-overlay declarations and selected resources", async () => {
    await withFacts("moby-dick-media-overlays", (facts) => {
      expect(manifestItem(facts, "xchapter_001")).toMatchObject({
        href: "chapter_001.xhtml",
        mediaOverlay: "chapter_001_overlay",
      });
      expect(manifestItem(facts, "chapter_001_overlay")).toMatchObject({
        href: "chapter_001_overlay.smil",
        mediaType: "application/smil+xml",
      });
      expect(facts.package.manifest.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            href: "audio/mobydick_001_002_melville.mp4",
            mediaType: "audio/mp4",
          }),
        ]),
      );
      expect(facts.package.metadata.meta).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: expect.objectContaining({ raw: "media:narrator" }),
            content: "Stuart Wills",
          }),
          expect.objectContaining({
            property: expect.objectContaining({ raw: "media:duration" }),
            content: "0:23:23.500",
          }),
          expect.objectContaining({
            property: expect.objectContaining({ raw: "media:duration" }),
            refines: "#chapter_001_overlay",
            content: "0:14:20.500",
          }),
          expect.objectContaining({
            property: expect.objectContaining({ raw: "media:duration" }),
            refines: "#chapter_002_overlay",
            content: "0:09:03.000",
          }),
        ]),
      );
    });
  });

  it("retains vertical and Arabic RTL source evidence", async () => {
    await withFacts("vertical-writing", (facts) => {
      expect(facts.package.spine.pageProgressionDirection).toBe("rtl");
    });
    await withFacts("arabic", (facts) => {
      expect(facts.package.metadata.language[0]?.content).toBe("ar");
      expect(facts.package.spine.pageProgressionDirection).toBe("rtl");
      expect(facts.package.metadata.meta).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: expect.objectContaining({ raw: "alternate-script" }),
            xmlLang: "ar",
          }),
        ]),
      );
    });
  });

  it("retains fixed XHTML and fixed SVG adapter evidence", async () => {
    await withFacts("page-blanche", (facts) => {
      expect(facts.resources.readingOrder[0]?.presentation.layout).toMatchObject({
        state: "specified",
        value: { value: "pre-paginated" },
      });
      expect(pageSpreads(facts)).toEqual(alternating(10, "right"));
      const authoredNavigation = projectAuthoredNavigation(facts);
      expect(authoredNavigation.pages).toHaveLength(1);
      expect(
        authoredNavigation.pages[0]?.points.map((point) => [point.point.label, point.occurrences]),
      ).toEqual(Array.from({ length: 8 }, (_, index) => [String(index + 1), [index + 2]]));
      expect(currentAuthoredPageRange(authoredNavigation, 2, null)).toEqual({
        first: "1",
        last: "1",
      });
    });
    await withFacts("svg-in-spine", async (facts, book) => {
      const expectedSvgPaths = [
        "OPS/Images/cover.svg",
        "OPS/Images/p002.svg",
        "OPS/Images/Tsuru_wiki-1b.svg",
        "OPS/Images/Tsuru_wiki-2b.svg",
        "OPS/Images/p005.svg",
        "OPS/Images/p006.svg",
      ];
      const svgResourceOrdinals = new Map(
        expectedSvgPaths.map((path) => [path, resourceOrdinal(facts, path)]),
      );
      expect([...svgResourceOrdinals.values()]).not.toContain(-1);
      expect(new Set(svgResourceOrdinals.values())).toHaveLength(expectedSvgPaths.length);

      const analysis = book.analysis();
      const executableContent = analysis.executableContent;
      const foregroundPreparation = analysis.foregroundPreparation;
      for (const [path, ordinal] of svgResourceOrdinals) {
        expect(executableContent[ordinal], path).toBe("analyzed-absent");
        expect(foregroundPreparation[ordinal], path).toBe("eligible");
        expect(analysis.searchDocumentStates[path], path).toBe("inapplicable");
      }

      expect(pageSpreads(facts)).toEqual(["right", "right", "left", "right", "left", "right"]);
      await withKernel("svg-in-spine", facts, (snapshot) => {
        expect(snapshot.readingOrder.map((entry) => entry.document)).toEqual(
          expectedSvgPaths.map((resource) => ({
            state: "loadable",
            resource,
            adapter: "fixed-svg",
          })),
        );
      });
    });
  });

  it.each([
    { label: "declared", declaredScripted: true },
    { label: "undeclared", declaredScripted: false },
  ])(
    "keeps $label SVG script declaration and detection evidence separate",
    async ({ declaredScripted }) => {
      const archive = await loadCorpusArchive("svg-in-spine");
      const variant = scriptedSvgVariant(archive.bytes, declaredScripted);

      const book = await openLocalPublication(variant.bytes);
      try {
        const coverOrdinal = resourceOrdinal(book.facts, variant.path);
        expect(coverOrdinal).toBeGreaterThanOrEqual(0);
        expect(book.facts.resources.resources[coverOrdinal]).toMatchObject({
          address: { kind: "local", value: variant.path },
          hasSvgDeclaration: true,
          scripted: declaredScripted,
        });
        const analysis = book.analysis();
        expect(analysis.executableContent[coverOrdinal]).toBe("detected");
        expect(analysis.foregroundPreparation[coverOrdinal]).toBe("ineligible");
        expect(book.readResource(variant.path)).toEqual(variant.source);

        await withKernel("svg-in-spine-scripted", book.facts, (snapshot) => {
          expect(snapshot.readingOrder[0]?.document).toEqual({
            state: "loadable",
            resource: variant.path,
            adapter: "fixed-svg",
          });
        });
      } finally {
        book.close();
      }
    },
  );

  it("retains Trees scripted declarations", async () => {
    await withFacts("trees", (facts) => {
      for (const id of ["ttl", "c1", "c2"]) {
        expect(manifestItem(facts, id)?.properties).toEqual(
          expect.arrayContaining([expect.objectContaining({ raw: "scripted", known: "scripted" })]),
        );
      }
    });
  });
});

async function withFacts(
  id: string,
  run: (facts: PublicationFacts, book: PublicationAccess) => void | Promise<void>,
): Promise<void> {
  const archive = await loadCorpusArchive(id);
  const book = await openLocalPublication(archive.bytes);
  try {
    await run(book.facts, book);
  } finally {
    book.close();
  }
}

async function withKernel(
  id: string,
  facts: PublicationFacts,
  run: (
    snapshot: ReturnType<Awaited<ReturnType<typeof createNavigatorKernel>>["snapshot"]>,
  ) => void,
): Promise<void> {
  const kernel = await createNavigatorKernel({
    facts,
    mount: {
      baseUrl: `https://reader.example/publications/${id}/`,
      remoteResources: "blocked",
      contentOrigin: "shared-reader-origin",
    },
  });
  try {
    run(kernel.snapshot());
  } finally {
    kernel.close();
  }
}

function resourceIndex(facts: PublicationFacts, path: string): number {
  const index = facts.resources.resources.findIndex(
    (resource) => resource.address.kind === "local" && resource.address.value === path,
  );
  expect(index, path).toBeGreaterThanOrEqual(0);
  return index;
}

function readingOrderPath(
  facts: PublicationFacts,
  entry: PublicationFacts["resources"]["readingOrder"][number],
): string | null {
  if (entry.resource === null) return null;
  const address = facts.resources.resources[entry.resource]?.address;
  return address?.kind === "local" ? address.value : null;
}

function pageSpreads(facts: PublicationFacts): (string | null)[] {
  return facts.resources.readingOrder.map((entry) =>
    entry.presentation.pageSpread.state === "specified"
      ? entry.presentation.pageSpread.value.value
      : null,
  );
}

function alternating(length: number, first: "left" | "right"): string[] {
  const second = first === "left" ? "right" : "left";
  return Array.from({ length }, (_, index) => (index % 2 === 0 ? first : second));
}

function manifestItem(facts: PublicationFacts, id: string) {
  return facts.package.manifest.items.find((item) => item.id === id);
}

function resourceOrdinal(facts: PublicationFacts, path: string): number {
  return facts.resources.resources.findIndex(
    (resource) => resource.address.kind === "local" && resource.address.value === path,
  );
}

function scriptedSvgVariant(
  archive: Uint8Array,
  declaredScripted: boolean,
): { readonly bytes: Uint8Array; readonly path: string; readonly source: Uint8Array } {
  const path = "OPS/Images/cover.svg";
  const entries = unzipSync(archive);
  const decoder = new TextDecoder();
  const opfPath = "OPS/content.opf";
  const opf = decoder.decode(entries[opfPath]);
  if (declaredScripted) {
    entries[opfPath] = strToU8(
      opf.replace('properties="cover-image"', 'properties="cover-image scripted"'),
    );
  }

  const executableSvg = `
  <script type="application/ecmascript"><![CDATA[globalThis.inlineSvgRan = true;]]></script>
  <script href="cover-script.js" />
  <g onload="globalThis.svgHandlerRan = true" />
  <foreignObject x="0" y="0" width="1" height="1">
    <body xmlns="http://www.w3.org/1999/xhtml"><script>globalThis.foreignScriptRan = true;</script></body>
  </foreignObject>
`;
  const source = strToU8(decoder.decode(entries[path]).replace("</svg>", `${executableSvg}</svg>`));
  entries[path] = source;
  entries["OPS/Images/cover-script.js"] = strToU8("globalThis.externalSvgRan = true;\n");

  return {
    bytes: zipSync(entries, { level: 0, mtime: new Date("1990-01-01T12:00:00.000Z") }),
    path,
    source,
  };
}

function mediaTypeEssence(mediaType: string): string {
  return (mediaType.split(";", 1)[0] ?? "").trim().toLowerCase();
}
