import { describe, expect, it } from "vitest";
import type { NavigatorLocation, NavigatorLocationBasis } from "../src/generated/kernel.js";
import { sameDurablePoint } from "../src/runtime/selection/location-equivalence.js";

const basis: NavigatorLocationBasis = {
  documentGeneration: 3,
  frameGeneration: 4,
  layoutGeneration: 5,
};

const point: NavigatorLocation = {
  kind: "point",
  occurrence: 2,
  resource: "chapter.xhtml",
  evidence: [{ kind: "browser-text-position", offset: "12" }],
  observation: { layoutProgression: 0.4, renderedTextProgression: 0.25 },
};

describe("durable point equivalence", () => {
  it("ignores additive rendered-text context and layout progression", () => {
    const exact: NavigatorLocation = {
      ...point,
      evidence: [
        ...point.evidence,
        { kind: "rendered-text-context", before: "before", after: "after" },
      ],
      observation: { layoutProgression: null, renderedTextProgression: 0.25 },
    };

    expect(sameDurablePoint(point, basis, exact, basis)).toBe(true);
  });

  it("rejects movement and generation changes", () => {
    expect(
      sameDurablePoint(
        point,
        basis,
        { ...point, observation: { ...point.observation, renderedTextProgression: 0.5 } },
        basis,
      ),
    ).toBe(false);
    expect(
      sameDurablePoint(point, basis, point, {
        ...basis,
        layoutGeneration: basis.layoutGeneration + 1,
      }),
    ).toBe(false);
  });
});
