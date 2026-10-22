// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { calibratedPageEstimate } from "../../src/runtime/pagination/estimate.js";
import type { OccurrencePagination } from "../../src/runtime/pagination/index.js";
import { facts, mountController, occurrenceSnapshot } from "../support/pagination-harness.js";

function measured(occurrence: number, pageCount: number): OccurrencePagination {
  return {
    occurrence,
    resource: `EPUB/chapter-${occurrence + 1}.xhtml`,
    state: "measured",
    pageCount,
    columnsPerView: 1,
    tocTargets: [],
    source: "background",
  };
}

function pending(occurrence: number): OccurrencePagination {
  return { occurrence, resource: `EPUB/chapter-${occurrence + 1}.xhtml`, state: "pending" };
}

describe("calibrated page estimate", () => {
  it("is unavailable until a weighted occurrence has been measured", () => {
    expect(calibratedPageEstimate([pending(0), pending(1)], [1000, 2000])).toBeNull();
    expect(calibratedPageEstimate([measured(0, 3), pending(1)], [0, 2000])).toBeNull();
  });

  it("calibrates only from multi-page documents once a few pages are measured", () => {
    const weights = [300, 20_000, 30_000, 25_000];
    expect(
      calibratedPageEstimate([measured(0, 1), pending(1), pending(2), pending(3)], weights),
    ).toBeNull();
    expect(
      calibratedPageEstimate([measured(0, 1), pending(1), measured(2, 3), pending(3)], weights),
    ).toBeNull();
    expect(
      calibratedPageEstimate([measured(0, 1), pending(1), measured(2, 12), pending(3)], weights),
    ).toMatchObject({ total: 1 + 8 + 12 + 10, counts: [1, 8, 12, 10] });
  });

  it("scales unmeasured occurrences by bytes at the measured rate", () => {
    const estimate = calibratedPageEstimate(
      [measured(0, 4), pending(1), measured(2, 2), pending(3)],
      [1000, 3000, 500, 100],
    );

    expect(estimate).toEqual({
      total: 4 + 12 + 2 + 1,
      counts: [4, 12, 2, 1],
      starts: [0, 4, 16, 18],
    });
  });

  it("estimates one page for unweighted occurrences and none for inapplicable ones", () => {
    const estimate = calibratedPageEstimate(
      [
        measured(0, 4),
        pending(1),
        { occurrence: 2, resource: null, state: "inapplicable", reason: "not-paginated" },
        { occurrence: 3, resource: "EPUB/x.xhtml", state: "unavailable", reason: "scripted" },
      ],
      [2000, 0, 0, 1000],
    );

    expect(estimate).toMatchObject({ total: 4 + 1 + 0 + 2, counts: [4, 1, 0, 2] });
  });

  it("exposes the estimate on the controller snapshot from resource sizes", () => {
    const publication = facts(3);
    for (const [ordinal, sizeBytes] of ["3000", "1000", "500"].entries()) {
      (publication.resources.resources[ordinal]!.presence as { sizeBytes: string }).sizeBytes =
        sizeBytes;
    }
    const controller = mountController({ facts: publication });

    expect(controller.snapshot().estimatedTotalPageCount).toBeNull();
    controller.updateForeground(occurrenceSnapshot(0, true, 4));
    const snapshot = controller.snapshot();
    expect(snapshot.estimatedTotalPageCount).toBe(4 + 1 + 1);
    expect([0, 1, 2, 3].map((occurrence) => snapshot.estimatedPageStart(occurrence))).toEqual([
      0,
      4,
      5,
      null,
    ]);
    expect(snapshot.estimatedPageCount(1)).toBe(1);
  });
});
