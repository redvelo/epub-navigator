// @vitest-environment jsdom

import { describe, expect, vi } from "vitest";
import type { PublicationFacts } from "../../src/generated/publication.js";
import type { TocTargetMeasurementResult } from "../../src/runtime/agent-protocol/index.js";
import type { TocTargetMeasurementOptions } from "../../src/runtime/navigator/api.js";
import { BookPaginationController } from "../../src/runtime/pagination/index.js";
import { indexTocTargetRequests } from "../../src/runtime/pagination/catalog.js";
import {
  acceptedTransition,
  automaticMeasurementRuntime,
  facts,
  factsWithToc,
  it,
  fixedOccurrenceSnapshot,
  locateTargets,
  measurementRuntime,
  mountController,
  occurrenceSnapshot,
  preferences,
  runtimeSnapshot,
  tocTarget,
  unresolvedLayoutRepairs,
} from "../support/pagination-harness.js";

type MutableToc = {
  navigation: { lists: { semantic?: string; points: unknown[] }[] };
  navigationTargets: ReturnType<typeof tocTarget>[];
};

function mutableToc(value: PublicationFacts): MutableToc {
  return value as unknown as MutableToc;
}

const located = (physicalPage: number): TocTargetMeasurementResult[] => [
  { listIndex: 0, pointPath: [0], result: { state: "located", physicalPage } },
];

function abortingMeasurement() {
  const signals: AbortSignal[] = [];
  const measure = vi.fn(
    (_targets: unknown, options?: TocTargetMeasurementOptions) =>
      new Promise<readonly TocTargetMeasurementResult[]>((_resolve, reject) => {
        signals.push(options!.signal!);
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }),
  );
  return { measure, signals };
}

describe("TOC target catalog", () => {
  it("opens a physical fallback at its start instead of measuring an authored fragment", () => {
    const value = factsWithToc({ count: 2 });
    mutableToc(value).navigation.lists[0]!.points.push({ hidden: false, children: [] });
    mutableToc(value).navigationTargets.push(tocTarget(0, [1], 1, "section"));

    const requests = indexTocTargetRequests(value, [
      { state: "loadable", resource: "EPUB/chapter-2.xhtml", adapter: "reflowable-xhtml" },
      { state: "unresolved" },
    ]);

    expect(requests[0]).toEqual([
      expect.objectContaining({
        pointPath: [1],
        evidence: [{ kind: "html-fragment", value: "section" }],
      }),
    ]);
  });

  it("retains authored TOC fragments when fallback selection keeps the physical resource", () => {
    const requests = indexTocTargetRequests(factsWithToc(), [
      { state: "loadable", resource: "EPUB/chapter-1.xhtml", adapter: "reflowable-xhtml" },
    ]);

    expect(requests[0]).toEqual([
      expect.objectContaining({ evidence: [{ kind: "html-fragment", value: "section" }] }),
    ]);
  });

  it("rejects explicit document targets that do not align with reading order", () => {
    expect(
      () =>
        new BookPaginationController({
          facts: facts(2),
          documents: [{ state: "unresolved" }],
          container: document.createElement("div"),
          preferences,
          createMeasurementRuntime: null,
        }),
    ).toThrow("pagination documents must align with the reading order");
  });

  it("pre-indexes large-book TOC targets once rather than rescanning per occurrence", () => {
    const value = factsWithToc({ count: 2_000 });
    const targets = mutableToc(value).navigationTargets;
    let reads = 0;
    Object.defineProperty(value, "navigationTargets", {
      configurable: true,
      get() {
        reads += 1;
        return targets;
      },
    });
    const controller = mountController({ facts: value });

    expect(reads).toBe(1);
    for (let index = 0; index < 2_000; index += 1) controller.snapshot().pageStart(index);
    expect(reads).toBe(1);
  });

  it.each([
    [
      "document-start",
      (toc: MutableToc) => {
        toc.navigationTargets[0]!.target.fragment = null;
      },
    ],
    [
      "hidden",
      (toc: MutableToc) => {
        toc.navigation.lists[0]!.points = [
          { hidden: true, children: [{ hidden: false, children: [] }] },
        ];
        toc.navigationTargets[0]!.pointPath = [0, 0];
      },
    ],
  ] as const)("does not schedule agent target work for a %s TOC point", async (_kind, mutate) => {
    const value = factsWithToc({ count: 2 });
    mutate(mutableToc(value));
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      facts: value,
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(750);
    expect(runtime.measureTocTargets).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      pageCountCoverage: { state: "exact" },
      tocEnrichment: { state: "complete", measuredTargets: 0, totalTargets: 0 },
    });
  });
});

describe("foreground TOC enrichment", () => {
  it("publishes pending foreground TOC targets and completes them in place", async () => {
    let finish: (results: readonly TocTargetMeasurementResult[]) => void = () => {};
    const measure = vi.fn(
      () =>
        new Promise<readonly TocTargetMeasurementResult[]>((resolve) => {
          finish = resolve;
        }),
    );
    const foreground = runtimeSnapshot(false, true);
    const controller = mountController({
      facts: factsWithToc(),
      foregroundSnapshot: () => foreground,
      measureForegroundTocTargets: measure,
    });

    controller.updateForeground(foreground);
    await vi.advanceTimersByTimeAsync(225);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      tocTargets: [{ result: { state: "pending" } }],
    });
    expect(measure).toHaveBeenCalledOnce();

    finish(located(1));
    await vi.advanceTimersByTimeAsync(10);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      tocTargets: [{ result: { state: "located", physicalPage: 1 } }],
    });
  });

  it("aborts foreground TOC enrichment at the occurrence deadline", async () => {
    const foreground = runtimeSnapshot(false, true);
    const { measure, signals } = abortingMeasurement();
    const controller = mountController({
      facts: factsWithToc(),
      foregroundSnapshot: () => foreground,
      measureForegroundTocTargets: measure,
    });

    controller.updateForeground(foreground);
    await vi.advanceTimersByTimeAsync(200);
    expect(signals).toMatchObject([{ aborted: false }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signals).toMatchObject([{ aborted: true }]);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      tocTargets: [{ result: { state: "failed" } }],
    });
  });

  it("terminalizes TOC work owned by an initially unavailable occurrence", () => {
    const controller = mountController({ facts: factsWithToc(), eligibleResourcePaths: [] });

    expect(controller.snapshot()).toMatchObject({
      occurrences: [{ state: "unavailable" }],
      tocEnrichment: { state: "complete", measuredTargets: 0, totalTargets: 1 },
    });
  });

  it("terminalizes pending TOC work when a measured occurrence becomes unavailable", () => {
    const controller = mountController({ facts: factsWithToc() });
    controller.updateForeground(occurrenceSnapshot(0, true));
    expect(controller.snapshot().tocEnrichment.state).toBe("pending");

    controller.updateForeground(unresolvedLayoutRepairs(occurrenceSnapshot(0, true)));

    expect(controller.snapshot()).toMatchObject({
      occurrences: [{ state: "unavailable", reason: "unresolved-text-pagination" }],
      tocEnrichment: { state: "complete", measuredTargets: 0, totalTargets: 1 },
    });
  });
});

describe("background TOC enrichment", () => {
  function pendingTargetsRuntime() {
    const resolvers: ((results: readonly TocTargetMeasurementResult[]) => void)[] = [];
    const runtime = automaticMeasurementRuntime(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    return { runtime, resolvers };
  }

  it("enriches visible fragment targets from every authored TOC list", async () => {
    const value = factsWithToc();
    mutableToc(value).navigation.lists.push({
      semantic: "toc",
      points: [{ hidden: false, children: [] }],
    });
    mutableToc(value).navigationTargets.push(tocTarget(1, [0], 0, "alternate-section"));
    const runtime = automaticMeasurementRuntime(locateTargets());
    const controller = mountController({
      facts: value,
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(800);
    expect(runtime.measureTocTargets).toHaveBeenCalledWith(
      [
        expect.objectContaining({ listIndex: 0, pointPath: [0] }),
        expect.objectContaining({ listIndex: 1, pointPath: [0] }),
      ],
      expect.anything(),
    );
    expect(controller.snapshot().tocEnrichment).toMatchObject({
      state: "complete",
      measuredTargets: 2,
      totalTargets: 2,
    });
  });

  it("publishes a page count before delayed same-visit TOC enrichment completes", async () => {
    const { runtime, resolvers } = pendingTargetsRuntime();
    const controller = mountController({
      facts: factsWithToc({ count: 2 }),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(controller.snapshot()).toMatchObject({
      pageCountCoverage: { state: "incomplete", measuredOccurrences: 1, measuredPageCount: 3 },
      tocEnrichment: { state: "pending" },
      occurrences: [{ state: "measured", tocTargets: [{ result: { state: "pending" } }] }, {}],
    });
    expect(runtime.measureTocTargets).toHaveBeenCalledOnce();
    expect(runtime.open).toHaveBeenCalledOnce();

    resolvers[0]!(located(1));
    await vi.advanceTimersByTimeAsync(300);
    expect(controller.snapshot()).toMatchObject({
      pageCountCoverage: { state: "exact", totalPageCount: 6 },
      tocEnrichment: { state: "complete" },
    });
    expect(vi.mocked(runtime.open).mock.calls).toEqual([[0], [1]]);
  });

  it("retains a page count when foreground work interrupts same-visit TOC enrichment", async () => {
    const { runtime, resolvers } = pendingTargetsRuntime();
    const controller = mountController({
      facts: factsWithToc(),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      pageCount: 3,
      tocTargets: [{ result: { state: "pending" } }],
    });
    controller.updateForeground(runtimeSnapshot(true, false));
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(controller.snapshot().occurrences[0]).toMatchObject({ state: "measured", pageCount: 3 });

    controller.updateForeground(runtimeSnapshot(false, false));
    await vi.advanceTimersByTimeAsync(300);
    expect(resolvers).toHaveLength(2);
    resolvers[0]!(located(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      tocTargets: [{ result: { state: "pending" } }],
    });
    resolvers[1]!(located(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      pageCount: 3,
      tocTargets: [{ result: { state: "located", physicalPage: 1 } }],
    });
    expect(vi.mocked(runtime.open).mock.calls).toEqual([[0], [0]]);
  });

  it("remeasures a page count when the same-visit layout changes during TOC enrichment", async () => {
    const { runtime, resolvers } = pendingTargetsRuntime();
    const controller = mountController({
      facts: factsWithToc(),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(controller.snapshot().occurrences[0]).toMatchObject({ state: "measured", pageCount: 3 });

    runtime.relayout(0, 4);
    resolvers[0]!(located(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().occurrences[0]).toMatchObject({ state: "pending" });
    expect(runtime.close).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(300);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      pageCount: 4,
      tocTargets: [{ result: { state: "pending" } }],
    });
    resolvers[1]!(located(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      pageCount: 4,
      tocTargets: [{ result: { state: "located", physicalPage: 1 } }],
    });
    expect(vi.mocked(runtime.open).mock.calls).toEqual([[0], [0]]);
  });

  it("enriches TOC targets without reopening a measured occurrence", async () => {
    const runtime = automaticMeasurementRuntime(locateTargets());
    const controller = mountController({
      facts: factsWithToc({ count: 8, resource: 3 }),
      createMeasurementRuntime: async () => runtime,
    });
    controller.updateForeground(occurrenceSnapshot(3, true));

    await vi.advanceTimersByTimeAsync(1_400);
    const opened = vi.mocked(runtime.open).mock.calls.map(([occurrence]) => occurrence);
    expect(opened.slice(0, 6)).toEqual([4, 2, 5, 1, 3, 6]);
    expect(opened.filter((occurrence) => occurrence === 3)).toHaveLength(1);
    expect(runtime.measureTocTargets).toHaveBeenCalled();
  });

  it("accepts background TOC targets from a stable fixed-xhtml page", async () => {
    const runtime = measurementRuntime();
    vi.mocked(runtime.open).mockImplementation((occurrence) => {
      runtime.publish(fixedOccurrenceSnapshot(occurrence));
      return acceptedTransition();
    });
    runtime.measureTocTargets = vi.fn(locateTargets());
    const controller = mountController({
      facts: factsWithToc({ adapter: "fixed-xhtml" }),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(controller.snapshot()).toMatchObject({
      totalPageCount: 1,
      pageCountCoverage: { state: "exact", measuredOccurrences: 1 },
      tocEnrichment: { state: "complete", measuredTargets: 1, totalTargets: 1 },
      occurrences: [
        {
          state: "measured",
          pageCount: 1,
          tocTargets: [{ result: { state: "located", physicalPage: 0 } }],
        },
      ],
    });
  });

  it("bounds TOC enrichment across target chunks for one occurrence", async () => {
    const runtime = automaticMeasurementRuntime();
    const { measure, signals } = abortingMeasurement();
    runtime.measureTocTargets = measure;
    const controller = mountController({
      facts: factsWithToc({ targets: 64 }),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(signals).toMatchObject([{ aborted: false }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signals).toMatchObject([{ aborted: true }]);
    const entry = controller.snapshot().occurrences[0];
    expect(
      entry?.state === "measured" && entry.tocTargets.map(({ result }) => result.state),
    ).toEqual(Array.from({ length: 64 }, () => "failed"));
  });
});
