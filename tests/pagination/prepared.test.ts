// @vitest-environment jsdom

import { describe, expect, vi } from "vitest";
import type { TocTargetMeasurementResult } from "../../src/runtime/agent-protocol/index.js";
import type {
  BookPaginationController,
  ForegroundPreparationClaim,
} from "../../src/runtime/pagination/index.js";
import type { PreparedTocMeasurement } from "../../src/runtime/pagination/capabilities.js";
import {
  committedLayout,
  facts,
  factsWithToc,
  it,
  flushMicrotasks,
  locateTargets,
  measurementRuntime,
  mountContainer,
  mountController,
  occurrenceSnapshot,
  paginated,
  pendingLayout,
  runtimeSnapshot,
} from "../support/pagination-harness.js";

function acceptPrepared(
  controller: BookPaginationController,
  claim: ForegroundPreparationClaim,
  occurrence: number,
  pageCount: number,
  frameGeneration = 7,
  settle?: (layout: ReturnType<typeof committedLayout>) => void,
): boolean {
  const prepared = committedLayout(occurrenceSnapshot(occurrence, true, pageCount));
  settle?.(prepared);
  return controller.acceptPreparedLayout(
    claim,
    `EPUB/chapter-${occurrence + 1}.xhtml`,
    frameGeneration,
    prepared.layoutGeneration,
    prepared.settlement,
  );
}

describe("foreground preparation claims", () => {
  it("claims foreground preparation before auxiliary open and requeues on release", async ({
    harness,
  }) => {
    const runtime = measurementRuntime();
    const controller = mountController({ createMeasurementRuntime: async () => runtime });

    const claim = controller.claimForegroundPreparation(0)!;
    expect(claim).not.toBeNull();
    await Promise.resolve();
    await harness.runIdle();
    await flushMicrotasks(5);
    expect(runtime.open).not.toHaveBeenCalledWith(0);

    controller.releaseForegroundPreparation(claim);
    await harness.runIdle();
    await flushMicrotasks(5);
    expect(runtime.open).toHaveBeenCalledWith(0);
  });

  it("accepts a prepared count without changing foreground and preserves it on promotion", () => {
    let foreground = occurrenceSnapshot(0, true, 2);
    const controller = mountController({
      facts: facts(2),
      foregroundSnapshot: () => foreground,
      measureForegroundTocTargets: async () => [],
    });

    controller.updateForeground(foreground);
    const claim = controller.claimForegroundPreparation(1)!;
    expect(acceptPrepared(controller, claim, 1, 5)).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      foreground: { state: "current", occurrence: 0, pageCount: 2 },
      occurrences: [
        { state: "measured", pageCount: 2 },
        { state: "measured", pageCount: 5, source: "foreground" },
      ],
      measuredPageCount: 7,
    });

    foreground = occurrenceSnapshot(1, true, 5);
    controller.updateForeground(foreground);
    controller.releaseForegroundPreparation(claim, true);
    expect(controller.snapshot()).toMatchObject({
      foreground: { state: "current", occurrence: 1, pageCount: 5 },
      occurrences: [{ pageCount: 2 }, { pageCount: 5 }],
      measuredPageCount: 7,
    });
  });

  it("does not treat prepared-frame layout as foreground busy", () => {
    const foreground = occurrenceSnapshot(0, true, 3);
    foreground.layout.pending = { ...pendingLayout(2, 2), owner: { kind: "prepared-frame" } };
    const controller = mountController({ foregroundSnapshot: () => foreground });

    controller.updateForeground(foreground);
    expect(controller.snapshot()).toMatchObject({
      freshness: "current",
      foreground: { state: "current", occurrence: 0, pageCount: 3 },
      occurrences: [{ state: "measured", pageCount: 3 }],
    });
  });

  it("keeps unrelated auxiliary work active when a prepared layout settles", async () => {
    const runtime = measurementRuntime();
    const controller = mountController({
      facts: facts(2),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(75);
    expect(runtime.open).toHaveBeenCalledWith(0);

    const claim = controller.claimForegroundPreparation(1)!;
    expect(acceptPrepared(controller, claim, 1, 5)).toBe(true);

    runtime.publish(runtimeSnapshot(false, true));
    expect(controller.snapshot().occurrences).toMatchObject([
      { state: "measured" },
      { state: "measured", pageCount: 5, source: "foreground" },
    ]);
  });

  it("commits a timed-out prepared layout as a provisional count", async ({ harness }) => {
    const runtime = measurementRuntime();
    const controller = mountController({ createMeasurementRuntime: async () => runtime });

    const claim = controller.claimForegroundPreparation(0)!;
    expect(
      acceptPrepared(controller, claim, 0, 5, 7, (layout) => {
        paginated(layout).measurement.requiredResources = "timed-out";
      }),
    ).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      occurrences: [{ state: "measured", pageCount: 5, source: "foreground" }],
      pageCountCoverage: { state: "exact", measuredOccurrences: 1 },
    });
    controller.releaseForegroundPreparation(claim, true);
    await harness.runIdle();
    await flushMicrotasks(5);
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it("revokes preparation claims on basis change and ignores late prepared results", async ({
    harness,
  }) => {
    const preparationClaimsInvalidated = vi.fn();
    const container = mountContainer({ width: 100, height: 200 });
    const controller = mountController({
      facts: facts(2),
      container,
      preparationClaimsInvalidated,
    });

    await Promise.resolve();
    const claim = controller.claimForegroundPreparation(1)!;
    harness.resize(container, 120, 200);
    expect(preparationClaimsInvalidated).toHaveBeenCalledOnce();
    expect(acceptPrepared(controller, claim, 1, 5)).toBe(false);
  });
});

describe("prepared TOC measurement", () => {
  it("completes claimed prepared TOC targets without changing foreground or opening auxiliary", async () => {
    const runtime = measurementRuntime();
    const foreground = occurrenceSnapshot(0, true, 2);
    const locate = locateTargets(1);
    const measurePreparedTocTargets = vi.fn<PreparedTocMeasurement>(
      async (_occurrence, _frame, _layout, _pageCount, targets) => locate(targets),
    );
    const controller = mountController({
      facts: factsWithToc({ count: 2, resource: 1 }),
      createMeasurementRuntime: async () => runtime,
      foregroundSnapshot: () => foreground,
      measureForegroundTocTargets: async () => [],
      measurePreparedTocTargets,
    });

    controller.updateForeground(foreground);
    acceptPrepared(controller, controller.claimForegroundPreparation(1)!, 1, 3);
    await vi.waitFor(() => expect(controller.snapshot().tocEnrichment.state).toBe("complete"));

    expect(measurePreparedTocTargets).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject({
      foreground: { state: "current", occurrence: 0 },
      occurrences: [
        { state: "measured", pageCount: 2 },
        {
          state: "measured",
          pageCount: 3,
          tocTargets: [{ result: { state: "located", physicalPage: 1 } }],
        },
      ],
    });
    expect(runtime.open).not.toHaveBeenCalledWith(1);
  });

  it("publishes partial prepared TOC chunks and ignores cancelled late results", async () => {
    const second = Promise.withResolvers<readonly TocTargetMeasurementResult[]>();
    const locate = locateTargets(0);
    const measure: PreparedTocMeasurement = async (_occurrence, _frame, _layout, _pages, targets) =>
      locate(targets);
    const measurePreparedTocTargets = vi
      .fn(measure)
      .mockImplementationOnce(measure)
      .mockReturnValueOnce(second.promise);
    const controller = mountController({
      facts: factsWithToc({ count: 2, resource: 1, targets: 40 }),
      measurePreparedTocTargets,
    });

    const claim = controller.claimForegroundPreparation(1)!;
    acceptPrepared(controller, claim, 1, 4, 8);
    await vi.waitFor(() => expect(measurePreparedTocTargets).toHaveBeenCalledTimes(2));
    const partial = controller.snapshot().occurrences[1];
    expect(partial).toMatchObject({ state: "measured", pageCount: 4 });
    expect(
      partial?.state === "measured" && partial.tocTargets.map(({ result }) => result.state),
    ).toEqual([
      ...Array.from({ length: 32 }, () => "located"),
      ...Array.from({ length: 8 }, () => "pending"),
    ]);
    expect(controller.snapshot().tocEnrichment.state).toBe("pending");

    controller.releaseForegroundPreparation(claim);
    second.resolve(
      Array.from({ length: 8 }, (_, index) => ({
        listIndex: 0,
        pointPath: [index + 32],
        result: { state: "located" as const, physicalPage: 1 },
      })),
    );
    await flushMicrotasks(2);
    expect(controller.snapshot().occurrences[1]).toMatchObject({ state: "pending" });
  });
});
