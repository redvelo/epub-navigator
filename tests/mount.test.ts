import { describe, expect, it } from "vitest";
import { decodePublicationRoute, publicationResourceUrl } from "../src/index.js";

const baseUrl = "https://reader.example/publications/alice/";
const mount = {
  baseUrl,
  remoteResources: "blocked",
  contentOrigin: "shared-reader-origin",
} as const;
const failure = (code: string) =>
  expect.objectContaining({ failure: expect.objectContaining({ code }) });

describe("publication mount paths", () => {
  it("encodes canonical paths segment by segment and decodes them exactly once", () => {
    expect(publicationResourceUrl(mount, "EPUB/text/Alice's tea % party.xhtml")).toBe(
      "https://reader.example/publications/alice/EPUB/text/Alice's%20tea%20%25%20party.xhtml",
    );
    expect(
      decodePublicationRoute(
        baseUrl,
        "/publications/alice/EPUB/text/Alice's%20tea%20%25%20party.xhtml",
      ),
    ).toBe("EPUB/text/Alice's tea % party.xhtml");
  });

  it("rejects unsafe raw routes", () => {
    for (const route of [
      "/publications/alice/",
      "/publications/other/EPUB/chapter.xhtml",
      "/publications/alice//EPUB/chapter.xhtml",
      "/publications/alice/EPUB/../secret",
      "/publications/alice/EPUB/%2e%2e/secret",
      "/publications/alice/EPUB/%2Fsecret",
      "/publications/alice/EPUB/%5csecret",
      "/publications/alice/EPUB/%252fsecret",
      "/publications/alice/EPUB/%252e%252e/secret",
      "/publications/alice/EPUB/%zz",
      "/publications/alice/EPUB/chapter.xhtml?download=1",
      "/publications/alice/EPUB/chapter.xhtml#fragment",
      "publications/alice/EPUB/chapter.xhtml",
    ]) {
      expect(() => decodePublicationRoute(baseUrl, route), route).toThrowError(
        failure("invalid-publication-route"),
      );
    }
  });

  it("rejects noncanonical resource paths", () => {
    for (const path of [
      "",
      "/EPUB/chapter.xhtml",
      "EPUB//chapter.xhtml",
      "EPUB/./chapter.xhtml",
      "EPUB/../chapter.xhtml",
      "EPUB\\chapter.xhtml",
      "https:chapter.xhtml",
      "EPUB/chapter.xhtml?query",
      "EPUB/chapter.xhtml#fragment",
    ]) {
      expect(() => publicationResourceUrl(mount, path), path).toThrowError(
        failure("invalid-publication-route"),
      );
    }
  });

  it("rejects an absolute URL that cannot serve as a hierarchical mount", () => {
    expect(() =>
      publicationResourceUrl({ ...mount, baseUrl: "mailto:publication/" }, "EPUB/chapter.xhtml"),
    ).toThrowError(failure("invalid-mount"));
  });
});
