import { describe, expect, it } from "vitest";
import type { BookPaginationSnapshot, OccurrencePagination } from "../src/runtime/pagination/index";
import {
  pageStartCoordinate,
  projectReaderProgress,
  type ReaderProgressInput,
} from "../src/react/progress/projection";
import { progressMarkerPoints, type JoinedTocPoint } from "../src/react/navigation/model";

describe("reader progress projection", () => {
  it("requires a coherent foreground basis identity, not matching page counts", () => {
    const input = exactInput();
    const mismatched = projectReaderProgress({
      ...input,
      pagination: snapshot(input.pagination!.occurrences, {
        documentGeneration: 99,
      }),
    });

    expect(mismatched.accuracy).toBe("calibrated");
    expect(mismatched.pages.kind).toBe("calibrated-pages");
  });

  it("does not declare exactness while foreground layout is pending", () => {
    const projection = projectReaderProgress({ ...exactInput(), pendingForegroundLayout: true });

    expect(projection).toMatchObject({ accuracy: "estimated", freshness: "current" });
    expect(projection.accessibleLabel).toMatch(/^Estimated progress,/u);
  });

  it("keeps exact publication markers while the foreground section is pending", () => {
    const toc = [point([0], [0]), point([1], [1])];
    const entries = [
      measured(0, 2, [
        { listIndex: 0, pointPath: [0], result: { state: "located", physicalPage: 0 } },
      ]),
      measured(1, 2, [
        { listIndex: 0, pointPath: [1], result: { state: "located", physicalPage: 0 } },
      ]),
    ];
    const pagination = snapshot(entries);
    const projection = projectReaderProgress({
      ...exactInput(),
      toc,
      committed: { occurrence: 0, resource: "chapter-1.xhtml", generation: 3 },
      committedLayout: null,
      pendingForegroundLayout: true,
      localPagination: null,
      pagination: { ...pagination, activity: "paused", foreground: { state: "pending" } },
    });

    expect(projection.accuracy).toBe("estimated");
    expect(projection.markers.state).toBe("exact");
    expect(projection.markers.markers.map((marker) => marker.coordinate)).toEqual([0, 2 / 3]);
  });

  it("does not project exact markers from a stale pagination basis", () => {
    const toc = [point([1], [0])];
    const entries = [
      measured(0, 2),
      measured(1, 2, [
        { listIndex: 0, pointPath: [0], result: { state: "located", physicalPage: 0 } },
      ]),
    ];
    const pagination = snapshot(entries);
    const projection = projectReaderProgress({
      ...exactInput(),
      toc,
      committedLayout: null,
      localPagination: null,
      pagination: { ...pagination, freshness: "stale", activity: "measuring-pages" },
    });

    expect(projection.markers.state).toBe("estimated");
    expect(projection.markers.markers[0]?.coordinate).toBe(0.5);
  });

  it("retains exact markers through a candidate foreground layout", () => {
    const toc = [point([0], [0]), point([1], [1])];
    const entries = [
      measured(0, 2, [
        { listIndex: 0, pointPath: [0], result: { state: "located", physicalPage: 0 } },
      ]),
      measured(1, 2, [
        { listIndex: 0, pointPath: [1], result: { state: "located", physicalPage: 0 } },
      ]),
    ];
    const currentInput = { ...exactInput(), toc, pagination: snapshot(entries) };
    const exact = projectReaderProgress(currentInput);
    const projection = projectReaderProgress({
      ...currentInput,
      committed: { occurrence: 0, resource: "chapter-1.xhtml", generation: 3 },
      committedLayout: null,
      pendingForegroundLayout: true,
      localPagination: null,
      pagination: {
        ...currentInput.pagination,
        freshness: "candidate-pending",
        activity: "paused",
        foreground: { state: "pending" },
      },
      retained: exact,
    });

    expect(projection).toMatchObject({ accuracy: "exact", freshness: "retained" });
    expect(projection.markers).toMatchObject({ state: "exact", freshness: "retained" });
    expect(projection.markers.markers).toBe(exact.markers.markers);
    expect(projection.coordinate).toBe(exact.coordinate);
    expect(projection.pages).toBe(exact.pages);
  });

  it("retains an entire exact projection atomically", () => {
    const exact = projectReaderProgress(exactInput());
    const retained = projectReaderProgress({
      ...exactInput(),
      localPagination: null,
      renderedProgress: 0.9,
      pagination: {
        ...exactInput().pagination!,
        freshness: "stale",
        activity: "measuring-pages",
      },
      retained: exact,
    });

    expect(retained).toMatchObject({ accuracy: "exact", freshness: "retained" });
    expect(retained.coordinate).toBe(exact.coordinate);
    expect(retained.pages).toBe(exact.pages);
    expect(retained.markers).toMatchObject({ freshness: "retained" });
    expect(retained.markers.markers).toBe(exact.markers.markers);
    expect(retained.label).toBe(exact.label);
    expect(retained.accessibleLabel).toMatch(/^Retained exact progress,/u);
  });

  it.each<[string, (input: ReaderProgressInput) => Partial<ReaderProgressInput>]>([
    [
      "a stale replacement basis is paused",
      (input) => ({
        pagination: {
          ...input.pagination!,
          freshness: "stale",
          activity: "paused",
          foreground: { state: "pending" },
        },
      }),
    ],
    [
      "pagination advances before the kernel snapshot",
      (input) => ({
        pagination: snapshot(input.pagination!.occurrences, {
          occurrence: 1,
          resource: "chapter-2.xhtml",
          documentGeneration: 4,
          layoutGeneration: 8,
        }),
      }),
    ],
    [
      "the kernel advances before pagination",
      () => ({
        committed: { occurrence: 1, resource: "chapter-2.xhtml", generation: 4 },
        committedLayout: { documentGeneration: 4, layoutGeneration: 8 },
        localPagination: { firstVisiblePage: 0, visiblePageCount: 1, pageCount: 2 },
        renderedProgress: 0,
      }),
    ],
  ])("retains exact progress while %s", (_, change) => {
    const input = exactInput();
    const exact = projectReaderProgress(input);
    const projection = projectReaderProgress({ ...input, ...change(input), retained: exact });

    expect(projection).toMatchObject({ accuracy: "exact", freshness: "retained" });
    expect(projection.coordinate).toBe(exact.coordinate);
    expect(projection.pages).toBe(exact.pages);
    expect(projection.markers.markers).toBe(exact.markers.markers);
  });

  it("projects calibrated pages while coverage is incomplete", () => {
    const entries = [measured(0, 4), pendingEntry(1), pendingEntry(2)];
    const projection = projectReaderProgress({
      ...exactInput(),
      committed: { occurrence: 0, resource: "chapter-1.xhtml", generation: 1 },
      committedLayout: { documentGeneration: 1, layoutGeneration: 7 },
      readingOrderLength: 3,
      localPagination: { firstVisiblePage: 2, visiblePageCount: 2, pageCount: 4 },
      pagination: incompleteSnapshot(entries, [4, 12, 2], {
        occurrence: 0,
        resource: "chapter-1.xhtml",
        documentGeneration: 1,
        pageCount: 4,
      }),
    });

    expect(projection).toMatchObject({
      accuracy: "calibrated",
      freshness: "current",
      pages: { kind: "calibrated-pages", visible: { start: 2, end: 4 }, total: 18 },
      label: "3-4 / ~18",
      accessibleLabel: "Estimated progress, pages 3 to 4 of about 18",
      markers: { state: "estimated" },
    });
    expect(projection.coordinate).toBe(pageStartCoordinate(2, 17));
  });

  it("holds calibrated numbers within a chapter and recomputes on a chapter change", () => {
    const foreground = { occurrence: 1, resource: "chapter-2.xhtml", documentGeneration: 2 };
    const base = {
      ...exactInput(),
      committed: { occurrence: 1, resource: "chapter-2.xhtml", generation: 2 },
      committedLayout: { documentGeneration: 2, layoutGeneration: 7 },
      readingOrderLength: 3,
      localPagination: { firstVisiblePage: 0, visiblePageCount: 1, pageCount: 5 },
    };
    const first = projectReaderProgress({
      ...base,
      pagination: incompleteSnapshot(
        [measured(0, 4), pendingEntry(1), pendingEntry(2)],
        [4, 5, 2],
        {
          ...foreground,
          pageCount: 5,
        },
      ),
    });
    expect(first.label).toBe("5 / ~11");

    const refined = incompleteSnapshot(
      [measured(0, 4), measured(1, 5), pendingEntry(2)],
      [4, 5, 9],
      {
        ...foreground,
        pageCount: 5,
      },
    );
    const held = projectReaderProgress({
      ...base,
      localPagination: { firstVisiblePage: 2, visiblePageCount: 1, pageCount: 5 },
      pagination: refined,
      retained: first,
    });
    expect(held.label).toBe("7 / ~11");

    const moved = projectReaderProgress({
      ...base,
      committed: { occurrence: 2, resource: "chapter-3.xhtml", generation: 3 },
      committedLayout: { documentGeneration: 3, layoutGeneration: 7 },
      localPagination: { firstVisiblePage: 0, visiblePageCount: 1, pageCount: 9 },
      pagination: refined,
      retained: held,
    });
    expect(moved.label).toBe("10 / ~18");

    const rebased = projectReaderProgress({
      ...base,
      localPagination: { firstVisiblePage: 2, visiblePageCount: 1, pageCount: 5 },
      pagination: { ...refined, runRevision: 2 },
      retained: first,
    });
    expect(rebased.label).toBe("7 / ~18");
  });

  it("holds calibrated numbers while a section transition is pending", () => {
    const base = {
      ...exactInput(),
      committed: { occurrence: 1, resource: "chapter-2.xhtml", generation: 2 },
      committedLayout: { documentGeneration: 2, layoutGeneration: 7 },
      readingOrderLength: 3,
      localPagination: { firstVisiblePage: 0, visiblePageCount: 1, pageCount: 5 },
      pagination: incompleteSnapshot(
        [measured(0, 4), pendingEntry(1), pendingEntry(2)],
        [4, 5, 2],
        {
          occurrence: 1,
          resource: "chapter-2.xhtml",
          documentGeneration: 2,
          pageCount: 5,
        },
      ),
    };
    const current = projectReaderProgress(base);
    expect(current.label).toBe("5 / ~11");

    const pendingLayout = { ...base, pendingForegroundLayout: true };
    expect(projectReaderProgress(pendingLayout).accuracy).toBe("estimated");
    expect(projectReaderProgress({ ...pendingLayout, retained: current })).toMatchObject({
      accuracy: "calibrated",
      freshness: "retained",
      label: "5 / ~11",
      accessibleLabel: "Retained estimated progress, page 5 of about 11",
      markers: { freshness: "retained" },
    });

    const reconciling = {
      ...base,
      committed: { occurrence: 2, resource: "chapter-3.xhtml", generation: 3 },
      pagination: { ...base.pagination, freshness: "candidate-pending" as const },
    };
    expect(projectReaderProgress({ ...reconciling, retained: current })).toMatchObject({
      accuracy: "calibrated",
      freshness: "retained",
      label: "5 / ~11",
    });
  });

  it("continues calibrated numbering across neighbouring chapters and damps the total", () => {
    const chapter = (occurrence: number, pageCount: number) => ({
      ...exactInput(),
      committed: {
        occurrence,
        resource: `chapter-${occurrence + 1}.xhtml`,
        generation: occurrence + 1,
      },
      committedLayout: { documentGeneration: occurrence + 1, layoutGeneration: 7 },
      readingOrderLength: 3,
      localPagination: { firstVisiblePage: 0, visiblePageCount: 1, pageCount },
    });
    const first = projectReaderProgress({
      ...chapter(0, 40),
      pagination: incompleteSnapshot(
        [measured(0, 40), pendingEntry(1), pendingEntry(2)],
        [40, 30, 30],
      ),
    });
    expect(first.label).toBe("1 / ~100");

    const second = projectReaderProgress({
      ...chapter(1, 30),
      pagination: incompleteSnapshot(
        [measured(0, 40), measured(1, 30), pendingEntry(2)],
        [40, 30, 33],
      ),
      retained: first,
    });
    expect(second.label).toBe("41 / ~100");

    const third = projectReaderProgress({
      ...chapter(2, 40),
      pagination: incompleteSnapshot(
        [measured(0, 40), measured(1, 30), pendingEntry(2)],
        [40, 30, 40],
      ),
      retained: second,
    });
    expect(third.label).toBe("71 / ~110");

    const back = projectReaderProgress({
      ...chapter(1, 30),
      localPagination: { firstVisiblePage: 2, visiblePageCount: 1, pageCount: 30 },
      pagination: incompleteSnapshot(
        [measured(0, 40), measured(1, 30), pendingEntry(2)],
        [40, 30, 40],
      ),
      retained: third,
    });
    expect(back.label).toBe("43 / ~110");
  });

  it("falls back to a percentage before any occurrence is measured", () => {
    const projection = projectReaderProgress({
      ...exactInput(),
      committed: { occurrence: 0, resource: "chapter-1.xhtml", generation: 1 },
      committedLayout: { documentGeneration: 1, layoutGeneration: 7 },
      readingOrderLength: 2,
      localPagination: { firstVisiblePage: 0, visiblePageCount: 1, pageCount: 4 },
      pagination: incompleteSnapshot([pendingEntry(0), pendingEntry(1)], []),
    });

    expect(projection).toMatchObject({ accuracy: "estimated", pages: { kind: "percentage" } });
  });

  it("falls back when incomplete pagination is terminally idle", () => {
    const exact = projectReaderProgress(exactInput());
    const pagination = exactInput().pagination!;
    const projection = projectReaderProgress({
      ...exactInput(),
      localPagination: null,
      renderedProgress: 0.9,
      pagination: {
        ...pagination,
        freshness: "stale",
        activity: "idle",
        pageCountCoverage: { ...pagination.pageCountCoverage, state: "incomplete" },
      },
      retained: exact,
    });

    expect(projection).toMatchObject({ accuracy: "estimated", freshness: "current" });
  });

  it.each([
    [9, 8, "9 / 9", { start: 8, end: 9 }],
    [10, 8, "9-10 / 10", { start: 8, end: 10 }],
  ])("clamps odd and even final spreads for %i pages", (total, first, label, visible) => {
    const entries = [measured(0, total)];
    const projection = projectReaderProgress({
      ...exactInput(),
      committed: { occurrence: 0, resource: "chapter-1.xhtml", generation: 1 },
      committedLayout: { documentGeneration: 1, layoutGeneration: 7 },
      readingOrderLength: 1,
      localPagination: { firstVisiblePage: first, visiblePageCount: 2, pageCount: total },
      pagination: snapshot(entries, {
        occurrence: 0,
        resource: "chapter-1.xhtml",
        documentGeneration: 1,
        pageCount: total,
      }),
    });

    expect(projection.label).toBe(label);
    expect(projection.pages).toMatchObject({
      kind: "physical-pages",
      visible,
      visibleSpread: visible,
    });
  });

  it("keeps a reflowable two-page interval when the occurrence range is a singleton", () => {
    const projection = projectReaderProgress({
      ...exactInput(),
      visibleOccurrenceRange: {
        primaryOccurrence: 1,
        firstOccurrence: 1,
        lastOccurrence: 1,
        companion: null,
      },
    });

    expect(projection.pages).toMatchObject({
      kind: "physical-pages",
      visible: { start: 2, end: 4 },
      visibleSpread: { start: 2, end: 4 },
    });
  });

  it("projects a fixed spread when the primary leads in authored order", () => {
    const projection = projectReaderProgress({
      ...fixedInput(1),
      visibleOccurrenceRange: {
        primaryOccurrence: 1,
        firstOccurrence: 1,
        lastOccurrence: 2,
        companion: { occurrence: 2, placement: "right" },
      },
    });

    expect(projection).toMatchObject({
      accuracy: "exact",
      label: "2-3 / 3",
      accessibleLabel: "Exact progress, pages 2 to 3 of 3",
      pages: {
        kind: "physical-pages",
        visible: { start: 1, end: 3 },
        visibleSpread: { start: 1, end: 3 },
      },
    });
  });

  it("numbers an RTL fixed spread in authored order when the primary trails", () => {
    const projection = projectReaderProgress({
      ...fixedInput(1),
      visibleOccurrenceRange: {
        primaryOccurrence: 1,
        firstOccurrence: 0,
        lastOccurrence: 1,
        companion: { occurrence: 0, placement: "right" },
      },
    });

    expect(projection).toMatchObject({
      accuracy: "exact",
      label: "1-2 / 3",
      accessibleLabel: "Exact progress, pages 1 to 2 of 3",
      pages: {
        visible: { start: 0, end: 2 },
        visibleSpread: { start: 0, end: 2 },
      },
    });
  });

  it("keeps a spread exact when a following reflowable companion has more than one page", () => {
    // An authored spread may pair a fixed page with a reflowable document, which paginates to
    // as many pages as it needs and shows its first in the spread.
    const entries = [measured(0, 1), measured(1, 1), measured(2, 2)];
    const projection = projectReaderProgress({
      ...fixedInput(1),
      readingOrderLength: entries.length,
      pagination: snapshot(entries, {
        occurrence: 1,
        resource: "chapter-2.xhtml",
        documentGeneration: 2,
        pageCount: 1,
      }),
      visibleOccurrenceRange: {
        primaryOccurrence: 1,
        firstOccurrence: 1,
        lastOccurrence: 2,
        companion: { occurrence: 2, placement: "left" },
      },
    });

    expect(projection).toMatchObject({
      accuracy: "exact",
      label: "2-3 / 4",
      accessibleLabel: "Exact progress, pages 2 to 3 of 4",
      pages: {
        kind: "physical-pages",
        visible: { start: 1, end: 3 },
        visibleSpread: { start: 1, end: 3 },
      },
    });
  });

  it("follows a companion that has turned its own pages past the fixed page beside it", () => {
    const entries = [measured(0, 1), measured(1, 1), measured(2, 3)];
    const input = {
      ...fixedInput(1),
      readingOrderLength: entries.length,
      pagination: snapshot(entries, {
        occurrence: 1,
        resource: "chapter-2.xhtml",
        documentGeneration: 2,
        pageCount: 1,
      }),
      visibleOccurrenceRange: {
        primaryOccurrence: 1,
        firstOccurrence: 1,
        lastOccurrence: 2,
        companion: { occurrence: 2, placement: "left" as const },
      },
    };
    expect(
      projectReaderProgress({
        ...input,
        companionPagination: { firstVisiblePage: 1, visiblePageCount: 1, pageCount: 3 },
      }),
    ).toMatchObject({
      accuracy: "exact",
      accessibleLabel: "Exact progress, page 4 of 5",
      pages: { visible: { start: 3, end: 4 }, visibleSpread: { start: 3, end: 4 } },
    });
    expect(
      projectReaderProgress({
        ...input,
        companionPagination: { firstVisiblePage: 1, visiblePageCount: 2, pageCount: 3 },
      }),
    ).toMatchObject({ accessibleLabel: "Exact progress, pages 4 to 5 of 5" });
    // A stale observation from another layout of the companion is not a position.
    expect(
      projectReaderProgress({
        ...input,
        companionPagination: { firstVisiblePage: 1, visiblePageCount: 1, pageCount: 2 },
      }),
    ).toMatchObject({ accessibleLabel: "Exact progress, pages 2 to 3 of 5" });
  });

  it("places the reader in a preceding reflowable companion until it reaches the fixed page", () => {
    // A leading reflowable companion turns its own pages; the fixed primary beside it follows
    // in reading order only after the companion's last page.
    const entries = [measured(0, 2), measured(1, 1), measured(2, 1)];
    const input = {
      ...fixedInput(1),
      readingOrderLength: entries.length,
      pagination: snapshot(entries, {
        occurrence: 1,
        resource: "chapter-2.xhtml",
        documentGeneration: 2,
        pageCount: 1,
      }),
      visibleOccurrenceRange: {
        primaryOccurrence: 1,
        firstOccurrence: 0,
        lastOccurrence: 1,
        companion: { occurrence: 0, placement: "right" as const },
      },
    };
    expect(projectReaderProgress(input)).toMatchObject({
      accuracy: "exact",
      accessibleLabel: "Exact progress, page 1 of 4",
    });
    expect(
      projectReaderProgress({
        ...input,
        companionPagination: { firstVisiblePage: 1, visiblePageCount: 1, pageCount: 2 },
      }),
    ).toMatchObject({
      accuracy: "exact",
      accessibleLabel: "Exact progress, pages 2 to 3 of 4",
    });
  });

  it("does not fabricate an exact spread without companion measurement", () => {
    const input = fixedInput(0);
    const pagination = input.pagination!;
    const projection = projectReaderProgress({
      ...input,
      pagination: {
        ...pagination,
        occurrences: [
          pagination.occurrences[0]!,
          { occurrence: 1, resource: null, state: "pending" },
          pagination.occurrences[2]!,
        ],
        pageStart: (occurrence) =>
          occurrence === 1 ? "pending" : pagination.pageStart(occurrence),
      },
      visibleOccurrenceRange: {
        primaryOccurrence: 0,
        firstOccurrence: 0,
        lastOccurrence: 1,
        companion: { occurrence: 1, placement: "right" },
      },
    });

    expect(projection.accuracy).toBe("calibrated");
    expect(projection.pages.kind).toBe("calibrated-pages");
  });

  it.each([
    {
      primaryOccurrence: 0,
      firstOccurrence: 0,
      lastOccurrence: 2,
      companion: { occurrence: 2, placement: "right" as const },
    },
    {
      primaryOccurrence: 0,
      firstOccurrence: 0,
      lastOccurrence: 1,
      companion: { occurrence: 2, placement: "right" as const },
    },
    {
      primaryOccurrence: 2,
      firstOccurrence: 0,
      lastOccurrence: 1,
      companion: { occurrence: 1, placement: "right" as const },
    },
  ])("rejects a nonadjacent or invalid fixed occurrence range", (visibleOccurrenceRange) => {
    const projection = projectReaderProgress({
      ...fixedInput(0),
      visibleOccurrenceRange,
    });

    expect(projection.accuracy).toBe("calibrated");
    expect(projection.pages.kind).toBe("calibrated-pages");
  });

  it("keeps a single fixed page exact without declaring a spread", () => {
    const projection = projectReaderProgress({
      ...fixedInput(1),
      visibleOccurrenceRange: {
        primaryOccurrence: 1,
        firstOccurrence: 1,
        lastOccurrence: 1,
        companion: null,
      },
    });

    expect(projection).toMatchObject({
      accuracy: "exact",
      label: "2 / 3",
      pages: { visible: { start: 1, end: 2 }, visibleSpread: null },
    });
  });

  it("follows the scroll continuously when several pages are visible at once", () => {
    const scrolling = (renderedProgress: number) =>
      projectReaderProgress({
        ...fixedInput(1),
        scrollFollowing: true,
        renderedProgress,
        visibleOccurrenceRange: {
          primaryOccurrence: 1,
          firstOccurrence: 1,
          lastOccurrence: 2,
          companion: null,
        },
      });

    expect(scrolling(0.5).coordinate).toBeCloseTo((1 + 0.5) / 3, 5);
    expect(scrolling(0.75).coordinate).toBeGreaterThan(scrolling(0.5).coordinate);
  });

  it("reaches the end of the rail on the last page of a scroll-following layout", () => {
    const projection = projectReaderProgress({
      ...fixedInput(2),
      scrollFollowing: true,
      renderedProgress: 1,
      // A single visible page would otherwise take the page-exact path and snap.
      visibleOccurrenceRange: {
        primaryOccurrence: 2,
        firstOccurrence: 2,
        lastOccurrence: 2,
        companion: null,
      },
    });

    expect(projection.coordinate).toBe(1);
    expect(projection.pages).toMatchObject({ kind: "percentage", value: 100 });
  });

  it("declines exact progress when the final occurrence carries no measured count", () => {
    const projection = projectReaderProgress({
      ...exactInput(),
      committed: { occurrence: 0, resource: "chapter-1.xhtml", generation: 1 },
      committedLayout: { documentGeneration: 1, layoutGeneration: 7 },
      localPagination: { firstVisiblePage: 0, visiblePageCount: 2, pageCount: 2 },
      pagination: snapshot([measured(0, 2), pendingEntry(1)], {
        occurrence: 0,
        resource: "chapter-1.xhtml",
        documentGeneration: 1,
        pageCount: 2,
      }),
    });

    expect(projection.accuracy).toBe("calibrated");
    expect(projection.markers.state).toBe("estimated");
  });

  it("reaches the end of the rail on the final fixed spread", () => {
    const spread = {
      primaryOccurrence: 1,
      firstOccurrence: 1,
      lastOccurrence: 2,
      companion: { occurrence: 2, placement: "right" as const },
    };
    const projection = projectReaderProgress({
      ...fixedInput(1),
      visibleOccurrenceRange: spread,
      finalSpreadLeadingOccurrence: 1,
    });

    expect(projection.accuracy).toBe("exact");
    expect(projection.label).toBe("2-3 / 3");
    expect(projection.coordinate).toBe(1);

    // The spread before it keeps its distance from the end.
    const earlier = projectReaderProgress({
      ...fixedInput(0),
      visibleOccurrenceRange: {
        ...spread,
        primaryOccurrence: 0,
        firstOccurrence: 0,
        lastOccurrence: 1,
        companion: { occurrence: 1, placement: "right" as const },
      },
      finalSpreadLeadingOccurrence: 1,
    });

    expect(earlier.coordinate).toBe(0);
  });

  it("keeps the rail on the final page when no spread closes the book", () => {
    const projection = projectReaderProgress({
      ...fixedInput(2),
      visibleOccurrenceRange: {
        primaryOccurrence: 2,
        firstOccurrence: 2,
        lastOccurrence: 2,
        companion: null,
      },
      finalSpreadLeadingOccurrence: null,
    });

    expect(projection.coordinate).toBe(1);
  });

  it("reaches the end of the rail on the final two-column view", () => {
    const entries = [measured(0, 4, [], 2), measured(1, 6, [], 2)];
    const input = {
      ...exactInput(),
      committed: { occurrence: 1, resource: "chapter-2.xhtml", generation: 2 },
      localPagination: { firstVisiblePage: 4, visiblePageCount: 2, pageCount: 6 },
      pagination: snapshot(entries, { pageCount: 6 }),
    };
    const projection = projectReaderProgress(input);

    expect(projection.accuracy).toBe("exact");
    expect(projection.pages).toMatchObject({ visible: { start: 8, end: 10 }, total: 10 });
    expect(projection.label).toBe("9-10 / 10");
    expect(projection.coordinate).toBe(1);

    const previous = projectReaderProgress({
      ...input,
      localPagination: { firstVisiblePage: 2, visiblePageCount: 2, pageCount: 6 },
    });

    expect(previous.coordinate).toBe(6 / 8);
  });

  it("keeps a two-column cursor on the chapter marker it lands on", () => {
    const toc = [point([0], [0]), point([1], [1])];
    const entries = [
      measured(
        0,
        4,
        [{ listIndex: 0, pointPath: [0], result: { state: "located", physicalPage: 0 } }],
        2,
      ),
      measured(
        1,
        6,
        [{ listIndex: 0, pointPath: [1], result: { state: "located", physicalPage: 0 } }],
        2,
      ),
    ];
    const projection = projectReaderProgress({
      ...exactInput(),
      toc,
      committed: { occurrence: 1, resource: "chapter-2.xhtml", generation: 2 },
      localPagination: { firstVisiblePage: 0, visiblePageCount: 2, pageCount: 6 },
      pagination: snapshot(entries, { pageCount: 6 }),
    });

    expect(projection.markers.state).toBe("exact");
    expect(projection.markers.markers.map((marker) => marker.coordinate)).toEqual([0, 0.5]);
    expect(projection.coordinate).toBe(0.5);
  });

  it("reaches the end of the rail on a final partially filled two-column view", () => {
    const entries = [measured(0, 4, [], 2), measured(1, 5, [], 2)];
    const projection = projectReaderProgress({
      ...exactInput(),
      committed: { occurrence: 1, resource: "chapter-2.xhtml", generation: 2 },
      localPagination: { firstVisiblePage: 4, visiblePageCount: 1, pageCount: 5 },
      pagination: snapshot(entries, { pageCount: 5 }),
    });

    expect(projection.pages).toMatchObject({ visible: { start: 8, end: 9 }, total: 9 });
    expect(projection.coordinate).toBe(1);
  });

  it("uses the same page-start coordinate for a second-page target and cursor", () => {
    const toc = [point([0], [0])];
    const entries = [
      measured(0, 5, [
        { listIndex: 0, pointPath: [0], result: { state: "located", physicalPage: 1 } },
      ]),
    ];
    const projection = projectReaderProgress({
      ...exactInput(),
      toc,
      committed: { occurrence: 0, resource: "chapter-1.xhtml", generation: 1 },
      committedLayout: { documentGeneration: 1, layoutGeneration: 7 },
      readingOrderLength: 1,
      localPagination: { firstVisiblePage: 1, visiblePageCount: 1, pageCount: 5 },
      pagination: snapshot(entries, {
        occurrence: 0,
        resource: "chapter-1.xhtml",
        documentGeneration: 1,
        pageCount: 5,
      }),
    });

    expect(projection.coordinate).toBe(pageStartCoordinate(1, 4));
    expect(projection.markers.markers[0]?.coordinate).toBe(projection.coordinate);
  });

  it("projects the duplicate occurrence selected by activation context", () => {
    const toc = [point([0, 1], [0])];
    const complete = snapshot([
      measured(0, 2, [
        { listIndex: 0, pointPath: [0], result: { state: "located", physicalPage: 0 } },
      ]),
      measured(1, 2, [
        { listIndex: 0, pointPath: [0], result: { state: "located", physicalPage: 1 } },
      ]),
    ]);
    const committed = { occurrence: 1, resource: "chapter.xhtml", generation: 2 };
    const projected = projectReaderProgress({
      ...exactInput(),
      toc,
      committed,
      pagination: complete,
    });
    const incomplete = projectReaderProgress({
      ...exactInput(),
      toc,
      committed,
      pagination: {
        ...complete,
        occurrences: [complete.occurrences[0]!, measured(1, 2)],
      },
    });

    expect(projected.markers).toMatchObject({ state: "exact" });
    expect(projected.markers.markers).toMatchObject([{ identity: "0:1" }]);
    expect(incomplete.markers.state).toBe("estimated");
    expect(incomplete.markers.markers).toMatchObject([{ identity: "0:1" }]);
  });

  it("projects document-start markers without measured target records", () => {
    const toc = [point([0], [0], 0, [], false, null), point([1], [1], 0, [], false, null)];
    const projection = projectReaderProgress({
      ...exactInput(),
      toc,
      pagination: snapshot([measured(0, 2), measured(1, 3)]),
    });

    expect(projection.markers).toMatchObject({ state: "exact" });
    expect(projection.markers.markers.map((marker) => marker.coordinate)).toEqual([0, 0.5]);
  });

  it("falls back atomically when a visible TOC point has no usable occurrence", () => {
    const toc = [point([], [0]), point([1], [1])];
    const pagination = snapshot([
      measured(0, 2),
      measured(1, 2, [
        { listIndex: 0, pointPath: [1], result: { state: "located", physicalPage: 1 } },
      ]),
    ]);

    const projection = projectReaderProgress({ ...exactInput(), toc, pagination });

    expect(projection.markers.state).toBe("estimated");
    expect(projection.markers.markers).toMatchObject([
      { identity: "1:1", coordinate: 2 / 3, authoredOrdinal: 1 },
    ]);
  });

  it("keeps a complete estimated marker set until exact targets settle atomically", () => {
    const toc = [point([0], [0]), point([1], [1])];
    const pending = snapshot([
      measured(0, 2, [{ listIndex: 0, pointPath: [0], result: { state: "pending" } }]),
      measured(1, 3, [{ listIndex: 0, pointPath: [1], result: { state: "pending" } }]),
    ]);
    const partial = snapshot([
      measured(0, 2, [
        { listIndex: 0, pointPath: [0], result: { state: "located", physicalPage: 1 } },
      ]),
      measured(1, 3, [{ listIndex: 0, pointPath: [1], result: { state: "pending" } }]),
    ]);
    const complete = snapshot([
      measured(0, 2, [
        { listIndex: 0, pointPath: [0], result: { state: "located", physicalPage: 1 } },
      ]),
      measured(1, 3, [
        { listIndex: 0, pointPath: [1], result: { state: "located", physicalPage: 1 } },
      ]),
    ]);

    const pendingProjection = projectReaderProgress({ ...exactInput(), toc, pagination: pending });
    const partialProjection = projectReaderProgress({ ...exactInput(), toc, pagination: partial });
    const completeProjection = projectReaderProgress({
      ...exactInput(),
      toc,
      pagination: complete,
    });

    expect(pendingProjection.markers.state).toBe("estimated");
    expect(partialProjection.markers).toEqual(pendingProjection.markers);
    expect(completeProjection.markers.state).toBe("exact");
    expect(completeProjection.markers.markers.map((marker) => marker.coordinate)).toEqual([
      0.25, 0.75,
    ]);
  });

  it("retains a coherent exact marker set while replacement targets are enriching", () => {
    const toc = [point([0], [0]), point([1], [1])];
    const complete = snapshot([
      measured(0, 2, [
        { listIndex: 0, pointPath: [0], result: { state: "located", physicalPage: 1 } },
      ]),
      measured(1, 2, [
        { listIndex: 0, pointPath: [1], result: { state: "located", physicalPage: 1 } },
      ]),
    ]);
    const pending = snapshot([
      measured(0, 2, [{ listIndex: 0, pointPath: [0], result: { state: "pending" } }]),
      measured(1, 2, [{ listIndex: 0, pointPath: [1], result: { state: "pending" } }]),
    ]);
    const exact = projectReaderProgress({ ...exactInput(), toc, pagination: complete });
    const enriching = projectReaderProgress({
      ...exactInput(),
      toc,
      pagination: {
        ...pending,
        activity: "enriching-toc",
        tocEnrichment: { state: "pending", measuredTargets: 0, totalTargets: 2 },
      },
      retained: exact,
    });

    expect(enriching).toMatchObject({ accuracy: "exact", freshness: "current" });
    expect(enriching.markers).toMatchObject({ state: "exact", freshness: "retained" });
    expect(enriching.markers.markers).toBe(exact.markers.markers);
  });

  it("uses only the coordinator-measured first TOC list when later lists exist", () => {
    const first = point([0], [0]);
    const later = point([1], [0], 1);
    const points = progressMarkerPoints({
      contents: [
        { listIndex: 0, list: {} as never, points: [first] },
        { listIndex: 1, list: {} as never, points: [later] },
      ],
      pages: [],
      landmarks: [],
    });

    expect(points).toEqual([first]);
  });

  it("resolves marker collisions by shallowest depth then authored ordinal", () => {
    const deep = point([], [0], 0, [point([0], [0, 0])]);
    const shallow = point([0], [1]);
    const projection = projectReaderProgress({
      ...exactInput(),
      toc: [deep, shallow],
      pagination: null,
      railPixelWidth: 320,
    });

    expect(projection.markers.markers).toHaveLength(1);
    expect(projection.markers.markers[0]).toMatchObject({ depth: 1, authoredOrdinal: 2 });
  });

  it.each(["exact", "estimated"] as const)(
    "suppresses a hidden TOC parent's subtree from %s markers",
    (accuracy) => {
      const hidden = point([], [0], 0, [point([0], [0, 0])], true);
      const visible = point([1], [1]);
      const pagination =
        accuracy === "exact"
          ? snapshot([
              measured(0, 2, [
                {
                  listIndex: 0,
                  pointPath: [0, 0],
                  result: { state: "located", physicalPage: 1 },
                },
              ]),
              measured(1, 2, [
                { listIndex: 0, pointPath: [1], result: { state: "located", physicalPage: 0 } },
              ]),
            ])
          : null;

      const projection = projectReaderProgress({
        ...exactInput(),
        toc: [hidden, visible],
        pagination,
      });

      expect(projection.markers.state).toBe(accuracy);
      expect(projection.markers.markers).toMatchObject([
        { identity: "0:1", depth: 1, authoredOrdinal: 0 },
      ]);
    },
  );

  it("provides exact page-range accessibility language", () => {
    const projection = projectReaderProgress(exactInput());
    expect(projection.accessibleLabel).toBe("Exact progress, pages 3 to 4 of 4");
  });
});

function exactInput(): ReaderProgressInput {
  const entries = [measured(0, 2), measured(1, 2)];
  return {
    toc: [],
    committed: { occurrence: 1, resource: "chapter-2.xhtml", generation: 2 },
    committedLayout: { documentGeneration: 2, layoutGeneration: 7 },
    pendingForegroundLayout: false,
    foregroundPaginated: true,
    readingOrderLength: 2,
    renderedProgress: 0.5,
    localPagination: { firstVisiblePage: 0, visiblePageCount: 2, pageCount: 2 },
    pagination: snapshot(entries),
    railPixelWidth: 400,
  };
}

function fixedInput(occurrence: number): ReaderProgressInput {
  const entries = [measured(0, 1), measured(1, 1), measured(2, 1)];
  return {
    ...exactInput(),
    committed: {
      occurrence,
      resource: `chapter-${occurrence + 1}.xhtml`,
      generation: occurrence + 1,
    },
    committedLayout: { documentGeneration: occurrence + 1, layoutGeneration: 7 },
    readingOrderLength: entries.length,
    localPagination: { firstVisiblePage: 0, visiblePageCount: 1, pageCount: 1 },
    pagination: snapshot(entries, {
      occurrence,
      resource: `chapter-${occurrence + 1}.xhtml`,
      documentGeneration: occurrence + 1,
      pageCount: 1,
    }),
  };
}

function snapshot(
  occurrences: readonly OccurrencePagination[],
  foreground: Partial<Extract<BookPaginationSnapshot["foreground"], { state: "current" }>> = {},
): BookPaginationSnapshot {
  const starts = occurrences.map((_, occurrence) =>
    occurrences
      .slice(0, occurrence)
      .reduce((sum, entry) => sum + (entry.state === "measured" ? entry.pageCount : 0), 0),
  );
  const total = occurrences.reduce(
    (sum, entry) => sum + (entry.state === "measured" ? entry.pageCount : 0),
    0,
  );
  return {
    runRevision: 1,
    basis: {
      viewport: { width: 400, height: 600 },
      preferences: {} as BookPaginationSnapshot["basis"]["preferences"],
      userAgent: "test",
      devicePixelRatio: 1,
    },
    freshness: "current",
    activity: "idle",
    foreground: {
      state: "current",
      occurrence: 1,
      resource: "chapter-2.xhtml",
      documentGeneration: 2,
      layoutGeneration: 7,
      pageCount: 2,
      ...foreground,
    },
    pageCountCoverage: {
      state: "exact",
      measuredOccurrences: occurrences.length,
      totalOccurrences: occurrences.length,
      measuredPageCount: total,
      totalPageCount: total,
    },
    tocEnrichment: { state: "complete", measuredTargets: 0, totalTargets: 0 },
    state: "complete",
    cachePersistence: "idle",
    occurrences,
    pageStart: (occurrence) => starts[occurrence] ?? null,
    measuredPageCount: total,
    totalPageCount: total,
    estimatedTotalPageCount: total,
    estimatedPageStart: (occurrence) => starts[occurrence] ?? null,
    estimatedPageCount: (occurrence) => {
      const entry = occurrences[occurrence];
      return entry?.state === "measured" ? entry.pageCount : null;
    },
  };
}

function pendingEntry(occurrence: number): OccurrencePagination {
  return { occurrence, resource: `chapter-${occurrence + 1}.xhtml`, state: "pending" };
}

function incompleteSnapshot(
  occurrences: readonly OccurrencePagination[],
  estimatedCounts: readonly number[],
  foreground: Partial<Extract<BookPaginationSnapshot["foreground"], { state: "current" }>> = {},
): BookPaginationSnapshot {
  const base = snapshot(occurrences, foreground);
  const measuredOccurrences = occurrences.filter((entry) => entry.state === "measured").length;
  const starts = estimatedCounts.map((_, occurrence) =>
    estimatedCounts.slice(0, occurrence).reduce((sum, count) => sum + count, 0),
  );
  const total = estimatedCounts.reduce((sum, count) => sum + count, 0);
  return {
    ...base,
    activity: "measuring-pages",
    state: "measuring",
    pageCountCoverage: {
      ...base.pageCountCoverage,
      state: "incomplete",
      measuredOccurrences,
      totalPageCount: null,
    },
    totalPageCount: null,
    estimatedTotalPageCount: estimatedCounts.length === 0 ? null : total,
    estimatedPageStart: (occurrence) => starts[occurrence] ?? null,
    estimatedPageCount: (occurrence) => estimatedCounts[occurrence] ?? null,
  };
}

function measured(
  occurrence: number,
  pageCount: number,
  tocTargets: Extract<OccurrencePagination, { state: "measured" }>["tocTargets"] = [],
  columnsPerView: 1 | 2 = 1,
): OccurrencePagination {
  return {
    occurrence,
    resource: `chapter-${occurrence + 1}.xhtml`,
    state: "measured",
    pageCount,
    columnsPerView,
    tocTargets,
    source: "background",
  };
}

function point(
  occurrences: readonly number[],
  pointPath: readonly number[],
  listIndex = 0,
  children: readonly JoinedTocPoint[] = [],
  hidden = false,
  fragment: string | null = "section",
): JoinedTocPoint {
  return {
    listIndex,
    pointPath,
    point: {
      label: "Chapter",
      authoredHref: "chapter.xhtml",
      hidden,
      semantic: null,
      authoredSemanticTokens: [],
      children: [],
    },
    target: {
      state: "resource",
      resource: 0,
      fragment,
    },
    resource: "chapter.xhtml",
    occurrences,
    navigationOccurrence: occurrences[0] ?? null,
    children,
  };
}
