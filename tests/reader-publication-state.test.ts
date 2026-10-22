import { describe, expect, it } from "vitest";
import {
  annotationProjectionFamily,
  annotationsFamily,
  paginationCapabilitiesFamily,
  readingPositionFamily,
  releasePublicationState,
  searchCapabilitiesFamily,
} from "../reader/src/publication-state.js";

const families = [
  paginationCapabilitiesFamily,
  searchCapabilitiesFamily,
  annotationsFamily,
  readingPositionFamily,
  annotationProjectionFamily,
];

describe("publication-scoped atom families", () => {
  it("drops every family's entry when a publication is released", () => {
    for (const family of families) family("book-to-release");
    for (const family of families) family("book-to-keep");
    expect(families.map((family) => [...family.getParams()].includes("book-to-release"))).toEqual(
      families.map(() => true),
    );

    releasePublicationState("book-to-release");

    expect(families.map((family) => [...family.getParams()].includes("book-to-release"))).toEqual(
      families.map(() => false),
    );
    expect(families.map((family) => [...family.getParams()].includes("book-to-keep"))).toEqual(
      families.map(() => true),
    );
  });
});
