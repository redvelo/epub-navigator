import { describe, expect, it } from "vitest";
import type { Metadata } from "../src/generated/publication";
import type { MountedPublication } from "../src/publication";
import { publicationCoverUrl, publicationDetails } from "../src/react/publication-details";

const element = (content: string | null) => ({
  id: null,
  dir: null,
  xmlLang: null,
  content,
  opf2Scheme: null,
  opf2Role: null,
  opf2FileAs: null,
});

function metadata(): Metadata {
  return {
    identifier: [],
    title: [],
    language: [],
    contributor: [],
    coverage: [],
    creator: [],
    date: [],
    description: [],
    format: [],
    publisher: [],
    relation: [],
    rights: [],
    source: [],
    subject: [],
    dcType: [],
    meta: [],
    opf2meta: [],
    link: [],
  };
}

describe("publicationDetails", () => {
  it("projects curated authored metadata and omits missing values", () => {
    const value = metadata();
    value.title = [element("A Book")];
    value.creator = [element("First Author"), element("Second Author")];
    value.description = [element(" "), element("A description")];

    expect(publicationDetails(value, null)).toEqual([
      { label: "Title", values: [{ content: "A Book", direction: null }] },
      {
        label: "Creator",
        values: [
          { content: "First Author", direction: null },
          { content: "Second Author", direction: null },
        ],
      },
      { label: "Description", values: [{ content: "A description", direction: null }] },
    ]);
  });

  it("carries the direction each value declares, and the package's when it declares none", () => {
    const value = metadata();
    value.title = [{ ...element("CSS: הרפתקה חדשה!"), dir: "rtl" }];
    value.creator = [{ ...element("Dave Cramer"), dir: null }];

    // The title declares right-to-left against a left-to-right package, and the creator
    // declares nothing, so it inherits. Neither can be inferred from the text: both begin
    // with a Latin letter.
    expect(publicationDetails(value, "ltr")).toEqual([
      { label: "Title", values: [{ content: "CSS: הרפתקה חדשה!", direction: "rtl" }] },
      { label: "Creator", values: [{ content: "Dave Cramer", direction: "ltr" }] },
    ]);
  });

  const publication = (coverPath: string | null) =>
    ({
      mount: {
        baseUrl: "https://reader.invalid/publications/book/",
        remoteResources: "blocked",
        contentOrigin: "shared-reader-origin",
      },
      facts: { resources: { coverPath } },
    }) as unknown as MountedPublication;

  it("builds a mounted URL for a readable cover path", () => {
    expect(publicationCoverUrl(publication("EPUB/images/front cover.svg"))).toBe(
      "https://reader.invalid/publications/book/EPUB/images/front%20cover.svg",
    );
  });

  // Stack reports no cover path when the selection is absent, ambiguous, unresolved, non-local,
  // or missing provider bytes, so the reader has one case to handle rather than five.
  it("omits a publication without a readable cover path", () => {
    expect(publicationCoverUrl(publication(null))).toBeNull();
  });
});
