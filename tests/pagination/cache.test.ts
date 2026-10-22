// @vitest-environment jsdom

import { describe, expect, vi } from "vitest";
import type {
  NavigatorDiagnosticEvent,
  PaginationMeasurementCache,
} from "../../src/runtime/pagination/index.js";
import {
  automaticMeasurementRuntime,
  cacheStub,
  committedLayout,
  decodeRecord,
  encodeRecord,
  facts,
  factsWithToc,
  it,
  flushMicrotasks,
  measurementRuntime,
  memoryPaginationCache,
  mountContainer,
  mountController,
  occurrenceSnapshot,
  pageRecord,
  paginated,
  preferences,
  relayout,
  unresolvedLayoutRepairs,
} from "../support/pagination-harness.js";

type Cache = PaginationMeasurementCache;

function lifecycle(events: readonly NavigatorDiagnosticEvent[], type: string, action?: string) {
  return events.filter(
    (event) =>
      event.type === type &&
      (action === undefined || ("action" in event && event.action === action)),
  );
}

describe("pagination cache restore", () => {
  it("starts one restore from the initial observed basis and restarts on a later resize", async ({
    harness,
  }) => {
    const basisRestarted = vi.fn();
    let width = 0;
    const container = mountContainer();
    container.getBoundingClientRect = () => ({ width, height: 200 }) as DOMRect;
    const controller = mountController({
      container,
      cache: cacheStub({ read: vi.fn(() => Promise.withResolvers<Uint8Array | null>().promise) }),
      diagnostics: harness.diagnostics,
      basisRestarted,
    });

    expect(controller.snapshot().basis.viewport.width).toBe(0);
    expect(lifecycle(harness.events, "cache-restore")).toEqual([]);
    width = 100;
    await Promise.resolve();

    expect(controller.snapshot()).toMatchObject({
      runRevision: 1,
      basis: { viewport: { width: 100, height: 200 } },
    });
    expect(lifecycle(harness.events, "cache-restore")).toMatchObject([{ action: "start" }]);
    expect(basisRestarted).not.toHaveBeenCalled();

    harness.resize(container, 120, 200);
    expect(controller.snapshot()).toMatchObject({ runRevision: 2, state: "stale" });
    expect(harness.events).toContainEqual(
      expect.objectContaining({ type: "cache-restore", action: "cancelled", runRevision: 1 }),
    );
    await harness.advance(400);

    expect(controller.snapshot()).toMatchObject({
      runRevision: 2,
      basis: { viewport: { width: 120, height: 200 } },
    });
    expect(lifecycle(harness.events, "cache-restore", "start")).toHaveLength(2);
    expect(basisRestarted).toHaveBeenCalledOnce();
  });

  it("restores immediately when ResizeObserver is unavailable", () => {
    const events: NavigatorDiagnosticEvent[] = [];
    mountController({
      cache: cacheStub({ read: vi.fn(() => Promise.withResolvers<Uint8Array | null>().promise) }),
      diagnostics: { level: "trace", record: (event) => events.push(event) },
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: "cache-restore", action: "start", runRevision: 1 }),
    );
  });

  it("does not restore when closed before the initial ResizeObserver delivery", async ({
    harness,
  }) => {
    const controller = mountController({ cache: cacheStub(), diagnostics: harness.diagnostics });

    controller.close();
    await Promise.resolve();

    expect(lifecycle(harness.events, "cache-restore", "start")).toEqual([]);
  });

  it("does not let a stalled cache read block auxiliary measurement", async ({ harness }) => {
    const cacheRead = Promise.withResolvers<Uint8Array | null>();
    const runtime = measurementRuntime();
    let readSignal: AbortSignal | null = null;
    mountController({
      cache: cacheStub({
        read: (_basis, _record, { signal }) => {
          readSignal = signal;
          signal.addEventListener("abort", () => cacheRead.reject(signal.reason), { once: true });
          return cacheRead.promise;
        },
      }),
      diagnostics: harness.diagnostics,
      createMeasurementRuntime: async () => runtime,
    });

    await vi.waitFor(() => expect(readSignal).not.toBeNull());
    await harness.advance(2_000);
    expect(readSignal!.aborted).toBe(false);
    expect(runtime.open).not.toHaveBeenCalled();
    await harness.advance(1_000);
    await harness.runIdle();
    await flushMicrotasks(5);
    expect(readSignal!.aborted).toBe(true);
    expect(runtime.open).toHaveBeenCalledWith(0);
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "cache-restore",
        action: "stalled",
        claimedOccurrences: 1,
        remainingOccurrences: 1,
      }),
    );
  });

  it("keeps restoring with bounded concurrency while reads make progress", async ({ harness }) => {
    const reads: PromiseWithResolvers<Uint8Array | null>[] = [];
    const read = vi.fn(() => {
      const operation = Promise.withResolvers<Uint8Array | null>();
      reads.push(operation);
      return operation.promise;
    });
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      facts: facts(9),
      cache: cacheStub({ read }),
      diagnostics: harness.diagnostics,
      createMeasurementRuntime: async () => runtime,
    });

    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(8));
    await harness.advance(2_500);
    reads[0]!.resolve(pageRecord(2));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(9));
    await harness.advance(600);

    expect(runtime.open).not.toHaveBeenCalled();
    expect(lifecycle(harness.events, "cache-restore", "stalled")).toEqual([]);

    for (const operation of reads.slice(1)) operation.resolve(pageRecord(2));
    await vi.waitFor(() =>
      expect(controller.snapshot().pageCountCoverage).toMatchObject({
        state: "exact",
        measuredOccurrences: 9,
      }),
    );
    expect(runtime.open).not.toHaveBeenCalled();
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "cache-restore",
        action: "complete",
        claimedOccurrences: 9,
        remainingOccurrences: 0,
      }),
    );
  });

  it("does not let an old restore release a new restore claim", async ({ harness }) => {
    const oldRead = Promise.withResolvers<Uint8Array | null>();
    const newRead = Promise.withResolvers<Uint8Array | null>();
    const read = vi
      .fn<Cache["read"]>()
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementationOnce(() => newRead.promise);
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      cache: cacheStub({ read }),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    controller.setPreferences({ ...preferences, fontScale: "125" });
    await harness.advance(400);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    oldRead.resolve(null);
    await flushMicrotasks();
    expect(runtime.open).not.toHaveBeenCalled();

    newRead.resolve(pageRecord(4));
    await vi.waitFor(() =>
      expect(controller.snapshot().occurrences[0]).toMatchObject({
        state: "measured",
        pageCount: 4,
      }),
    );
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it("does not measure an occurrence when its delayed cache read hits", async ({ harness }) => {
    const pageRead = Promise.withResolvers<Uint8Array | null>();
    const runtime = automaticMeasurementRuntime();
    const cache = cacheStub({ read: vi.fn(() => pageRead.promise) });
    const controller = mountController({
      cache,
      diagnostics: harness.diagnostics,
      createMeasurementRuntime: async () => runtime,
    });

    await vi.waitFor(() => expect(cache.read).toHaveBeenCalled());
    await harness.advance(1_500);
    expect(harness.idleCount()).toBe(0);
    pageRead.resolve(pageRecord(2));
    await flushMicrotasks();

    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      source: "background",
      pageCount: 2,
    });
    expect(harness.idleCount()).toBe(0);
    expect(runtime.open).not.toHaveBeenCalled();
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "cache",
        action: "read",
        recordType: "page",
        outcome: "hit",
      }),
    );
  });

  it("restores an unsettled record as a provisional count that a settled foreground replaces", async ({
    harness,
  }) => {
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      cache: cacheStub({ read: vi.fn(async () => pageRecord(2, false)) }),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.waitFor(() =>
      expect(controller.snapshot().occurrences[0]).toMatchObject({
        state: "measured",
        source: "background",
        pageCount: 2,
      }),
    );
    await harness.advance(1_500);
    expect(runtime.open).not.toHaveBeenCalled();
    expect(controller.snapshot().pageCountCoverage).toMatchObject({ state: "exact" });

    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    expect(controller.snapshot()).toMatchObject({
      runRevision: 1,
      occurrences: [{ state: "measured", source: "foreground", pageCount: 3 }],
    });
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("ignores page records without a settled flag", async ({ harness }) => {
    const runtime = automaticMeasurementRuntime();
    const cache = cacheStub({
      read: vi.fn(async () => encodeRecord({ type: "page-count", revision: 1, pageCount: 2 })),
    });
    const controller = mountController({ cache, createMeasurementRuntime: async () => runtime });

    await vi.waitFor(() => expect(cache.read).toHaveBeenCalled());
    await harness.advance(1_500);
    expect(runtime.open).toHaveBeenCalledWith(0);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      source: "background",
      pageCount: 3,
    });
  });

  it("restores a deterministic inapplicable occurrence without opening a runtime", async () => {
    const createMeasurementRuntime = vi.fn(async () => automaticMeasurementRuntime());
    const record = encodeRecord({
      type: "inapplicable",
      revision: 1,
      reason: "effective-presentation-not-paginated",
    });
    const controller = mountController({
      cache: cacheStub({ read: vi.fn(async () => record) }),
      createMeasurementRuntime,
    });

    await vi.waitFor(() =>
      expect(controller.snapshot().occurrences[0]).toMatchObject({
        state: "inapplicable",
        reason: "effective-presentation-not-paginated",
      }),
    );
    expect(createMeasurementRuntime).not.toHaveBeenCalled();
  });

  it("restores measured occurrences independently without remeasuring them", async () => {
    const cache = memoryPaginationCache();
    const first = mountController({ facts: facts(2), cache });
    first.updateForeground(occurrenceSnapshot(0, true));
    await vi.waitFor(() => expect(cache.records.size).toBe(1));
    first.close();

    const runtime = automaticMeasurementRuntime();
    const restored = mountController({
      facts: facts(2),
      cache,
      createMeasurementRuntime: async () => runtime,
    });
    await vi.waitFor(() => expect(restored.snapshot().occurrences[0]?.state).toBe("measured"));
    await vi.advanceTimersByTimeAsync(500);
    expect(restored.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      source: "background",
    });
    expect(vi.mocked(runtime.open).mock.calls).toEqual([[1]]);
  });

  it("removes one corrupt occurrence record without discarding valid siblings", async () => {
    const cache = memoryPaginationCache();
    const first = mountController({ facts: facts(2), cache });
    first.updateForeground(occurrenceSnapshot(0, true, 3));
    await vi.waitFor(() => expect(cache.records.size).toBe(1));
    const [corruptKey] = cache.records.keys();
    first.updateForeground(occurrenceSnapshot(1, true, 4));
    await vi.waitFor(() => expect(cache.records.size).toBe(2));
    first.close();
    cache.records.set(corruptKey!, new TextEncoder().encode("not json"));

    const restored = mountController({ facts: facts(2), cache });
    await vi.waitFor(() => expect(restored.snapshot().occurrences[1]?.state).toBe("measured"));
    expect(restored.snapshot().occurrences).toMatchObject([
      { state: "pending" },
      { state: "measured", pageCount: 4 },
    ]);
    expect(cache.remove).toHaveBeenCalledOnce();
  });

  it("restores page count while absent TOC target records remain pending", async () => {
    const cache = memoryPaginationCache();
    const first = mountController({ facts: factsWithToc(), cache });
    first.updateForeground(occurrenceSnapshot(0, true));
    await vi.waitFor(() => expect(cache.records.size).toBe(1));
    first.close();

    const restored = mountController({ facts: factsWithToc(), cache });
    await vi.waitFor(() => expect(restored.snapshot().occurrences[0]?.state).toBe("measured"));
    expect(restored.snapshot()).toMatchObject({
      occurrences: [
        { state: "measured", pageCount: 3, tocTargets: [{ result: { state: "pending" } }] },
      ],
      tocEnrichment: { state: "pending" },
    });
  });

  it.each(["read", "readMany"] as const)(
    "does not let a delayed %s restore overwrite a foreground measurement",
    async (method) => {
      const pending = Promise.withResolvers<Uint8Array | null>();
      const restore = {
        read: vi.fn(() => pending.promise),
        readMany: vi.fn(async () => [await pending.promise]),
      };
      const controller = mountController({ cache: { ...cacheStub(), [method]: restore[method] } });

      await vi.waitFor(() => expect(restore[method]).toHaveBeenCalledOnce());
      controller.updateForeground(occurrenceSnapshot(0, true, 5));
      pending.resolve(pageRecord(2));
      await vi.advanceTimersByTimeAsync(200);
      expect(controller.snapshot().occurrences[0]).toMatchObject({
        state: "measured",
        source: "foreground",
        pageCount: 5,
      });
    },
  );

  it("defers cached-page TOC misses until page cache restoration finishes", async ({ harness }) => {
    const secondPage = Promise.withResolvers<Uint8Array | null>();
    const read = vi
      .fn<Cache["read"]>(async () => null)
      .mockResolvedValueOnce(pageRecord(2))
      .mockReturnValueOnce(secondPage.promise);
    const runtime = automaticMeasurementRuntime();
    mountController({
      facts: factsWithToc({ count: 2 }),
      cache: cacheStub({ read }),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(harness.idleCount()).toBe(0);
    expect(runtime.open).not.toHaveBeenCalled();

    secondPage.resolve(pageRecord(2));
    await vi.waitFor(() => expect(harness.idleCount()).toBe(1));
    await harness.runIdle();
    await flushMicrotasks();

    expect(runtime.open).toHaveBeenCalledWith(0);
  });
});

describe("pagination cache bulk reads", () => {
  it("coalesces bulk cache reads in batches of at most 32 records", async ({ harness }) => {
    const readMany = vi.fn<NonNullable<Cache["readMany"]>>(async (_basis, records) =>
      records.map(() => pageRecord(2)),
    );
    const cache = cacheStub({ readMany });
    const controller = mountController({
      facts: facts(65),
      cache,
      diagnostics: harness.diagnostics,
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    await vi.waitFor(() =>
      expect(controller.snapshot().pageCountCoverage).toMatchObject({
        state: "exact",
        measuredOccurrences: 65,
      }),
    );
    expect(cache.read).not.toHaveBeenCalled();
    expect(readMany.mock.calls.map((call) => call[1].length).toSorted((a, b) => a - b)).toEqual([
      1, 32, 32,
    ]);
    expect(readMany.mock.calls[0]?.[2]).toMatchObject({ maxBytes: expect.any(Number) });
    const publications = lifecycle(harness.events, "controller-publish");
    expect(publications.length).toBeLessThan(10);
    expect(listener).toHaveBeenCalledTimes(publications.length);
  });

  it("schedules bulk cache misses after their settled wave", async ({ harness }) => {
    const readMany = vi
      .fn<NonNullable<Cache["readMany"]>>()
      .mockImplementationOnce(async (_basis, records) =>
        records.map((_, index) => (index === 0 ? null : pageRecord(2))),
      )
      .mockImplementationOnce(
        () => Promise.withResolvers<readonly (Uint8Array | null)[]>().promise,
      );
    const runtime = automaticMeasurementRuntime();
    mountController({
      facts: facts(33),
      cache: cacheStub({ readMany }),
      diagnostics: harness.diagnostics,
      createMeasurementRuntime: async () => runtime,
    });

    await vi.waitFor(() => expect(readMany).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.idleCount()).toBe(1));
    expect(lifecycle(harness.events, "cache-restore", "complete")).toEqual([]);

    await harness.runIdle();
    await vi.waitFor(() => expect(runtime.open).toHaveBeenCalledWith(0));
  });

  it("validates and removes corrupt records returned by a mixed bulk read", async ({ harness }) => {
    const cache = cacheStub({
      readMany: vi.fn(async () => [pageRecord(3), null, new TextEncoder().encode("not json")]),
      remove: vi.fn(async () => {}),
    });
    const controller = mountController({
      facts: facts(3),
      cache,
      diagnostics: harness.diagnostics,
    });

    await vi.waitFor(() => expect(cache.remove).toHaveBeenCalledOnce());
    expect(controller.snapshot().occurrences).toMatchObject([
      { state: "measured", pageCount: 3 },
      { state: "pending" },
      { state: "pending" },
    ]);
    expect(
      lifecycle(harness.events, "cache").map((event) => "outcome" in event && event.outcome),
    ).toEqual(expect.arrayContaining(["hit", "miss", "invalid"]));
  });

  it("does not remove records when a bulk cache request fails", async ({ harness }) => {
    const cache = cacheStub({
      readMany: vi.fn(async () => {
        throw new Error("cache unavailable");
      }),
      remove: vi.fn(async () => {}),
    });
    mountController({ facts: facts(2), cache, diagnostics: harness.diagnostics });

    await vi.waitFor(() => expect(lifecycle(harness.events, "cache")).toHaveLength(2));
    expect(harness.events).toContainEqual(
      expect.objectContaining({ type: "cache", recordType: "page", outcome: "failed" }),
    );
    expect(cache.remove).not.toHaveBeenCalled();
  });
});

describe("pagination cache writes", () => {
  it("does not persist foreground results without analyzed-absent eligibility", async () => {
    const cache = cacheStub();
    const controller = mountController({ eligibleResourcePaths: [], cache });

    controller.updateForeground(occurrenceSnapshot(0, true));
    await vi.advanceTimersByTimeAsync(750);

    expect(controller.snapshot().occurrences[0]?.state).toBe("measured");
    expect(cache.write).not.toHaveBeenCalled();
  });

  it("disables durable reuse when cryptographic hashing is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    const cache = cacheStub();
    try {
      const controller = mountController({ cache });
      controller.updateForeground(occurrenceSnapshot(0, true));
      await vi.advanceTimersByTimeAsync(750);
      expect(controller.snapshot().occurrences[0]?.state).toBe("measured");
      expect(cache.write).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("includes the measurement artifact digest in the content-derived basis", async () => {
    const cache = memoryPaginationCache();
    for (const [index, digest] of ["a", "b"].entries()) {
      const controller = mountController({
        cacheIdentity: { measurementArtifactDigest: digest.repeat(64) },
        cache,
      });
      controller.updateForeground(occurrenceSnapshot(0, true));
      await vi.waitFor(() => expect(cache.records.size).toBe(index + 1));
      controller.close();
    }
    expect(new Set([...cache.records.keys()].map((key) => key.split(":")[0])).size).toBe(2);
  });

  it("removes an unresolved cache entry and caches foreground recovery", async () => {
    const cache = cacheStub({ remove: vi.fn(async () => {}) });
    const controller = mountController({ cache });

    controller.updateForeground(unresolvedLayoutRepairs(occurrenceSnapshot(0, true)));
    await vi.waitFor(() => expect(cache.remove).toHaveBeenCalledOnce());

    const repaired = relayout(occurrenceSnapshot(0, true));
    paginated(repaired).pages.layoutRepairs = { status: "repaired", repairedElements: 1 };
    controller.updateForeground(repaired);
    await vi.waitFor(() => expect(cache.write).toHaveBeenCalled());

    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      source: "foreground",
    });
    expect(decodeRecord(cache.write.mock.lastCall![2])).toMatchObject({
      type: "page-count",
      pageCount: 3,
    });
  });

  it("flushes the final measured occurrence without waiting for the cache debounce", async () => {
    const cache = cacheStub();
    const controller = mountController({ cache });

    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(cache.write).toHaveBeenCalled());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports cache persistence as pending until the write queue drains", async () => {
    const cache = cacheStub();
    const controller = mountController({ cache });

    const published: string[] = [];
    controller.subscribe((snapshot) => published.push(snapshot.cachePersistence));

    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    expect(controller.snapshot().cachePersistence).toBe("pending");

    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(cache.write).toHaveBeenCalled());
    await vi.waitFor(() => expect(controller.snapshot().cachePersistence).toBe("idle"));
    // The drained state has to reach subscribers, not only a direct snapshot read.
    expect(published).toContain("pending");
    expect(published.at(-1)).toBe("idle");
  });

  it("reports cache persistence as unavailable without a cache", () => {
    const controller = mountController();

    expect(controller.snapshot().cachePersistence).toBe("unavailable");
  });

  it("does not postpone cache writes while measurements keep arriving", async () => {
    const cache = cacheStub();
    const controller = mountController({ facts: facts(2), cache });

    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    await vi.advanceTimersByTimeAsync(400);
    controller.updateForeground(occurrenceSnapshot(1, true, 2));
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(cache.write).toHaveBeenCalled());
  });

  it.each(["requiredFonts", "requiredResources"] as const)(
    "keeps a failed %s layout live without persisting it",
    async (field) => {
      const cache = cacheStub();
      const controller = mountController({ cache });
      const foreground = occurrenceSnapshot(0, true, 3);
      paginated(foreground).measurement[field] = "failed";

      controller.updateForeground(foreground);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(controller.snapshot().occurrences[0]).toMatchObject({
        state: "measured",
        pageCount: 3,
      });
      expect(cache.write).not.toHaveBeenCalled();
    },
  );

  it("keeps a settled record when a later foreground layout has failed resources", async () => {
    const cache = cacheStub({ remove: vi.fn(async () => {}) });
    const controller = mountController({ cache });

    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    await vi.waitFor(() => expect(cache.write).toHaveBeenCalledOnce());

    const failed = relayout(occurrenceSnapshot(0, true, 3));
    paginated(failed).measurement.requiredResources = "failed";
    controller.updateForeground(failed);
    await vi.advanceTimersByTimeAsync(750);

    expect(cache.write).toHaveBeenCalledOnce();
    expect(cache.remove).not.toHaveBeenCalled();
    expect(decodeRecord(cache.write.mock.calls[0]?.[2])).toMatchObject({ settled: true });
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      pageCount: 3,
    });
  });

  it.each(["requiredFonts", "requiredResources"] as const)(
    "commits a timed-out background %s settlement once as an unsettled cached count",
    async (field) => {
      const runtime = automaticMeasurementRuntime(async () => [], {
        [field === "requiredFonts" ? "font" : "resource"]: "timed-out",
      });
      const cache = memoryPaginationCache();
      const controller = mountController({ cache, createMeasurementRuntime: async () => runtime });

      await vi.advanceTimersByTimeAsync(15_500);
      expect(runtime.open).toHaveBeenCalledOnce();
      expect(controller.snapshot()).toMatchObject({
        occurrences: [{ state: "measured", pageCount: 3, source: "background" }],
        pageCountCoverage: { state: "exact", measuredOccurrences: 1 },
      });
      await vi.waitFor(() =>
        expect(cache.pageRecords()).toEqual([
          {
            type: "page-count",
            revision: expect.any(Number),
            pageCount: 3,
            columnsPerView: 1,
            settled: false,
          },
        ]),
      );
    },
  );

  it.each(["requiredFonts", "requiredResources"] as const)(
    "adds a timed-out foreground %s layout to the catalog as an unsettled count",
    async (field) => {
      const cache = cacheStub();
      const controller = mountController({ cache });
      const foreground = occurrenceSnapshot(0, true, 3);
      paginated(foreground).measurement[field] = "timed-out";

      controller.updateForeground(foreground);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(controller.snapshot()).toMatchObject({
        foreground: { state: "current", pageCount: 3 },
        occurrences: [{ state: "measured", pageCount: 3, source: "foreground" }],
        pageCountCoverage: { state: "exact", measuredOccurrences: 1 },
      });
      await vi.waitFor(() => expect(cache.write).toHaveBeenCalledOnce());
      expect(decodeRecord(cache.write.mock.calls[0]?.[2])).toMatchObject({
        type: "page-count",
        pageCount: 3,
        settled: false,
      });
    },
  );

  it("disables writes for a cache basis when disagreement reset fails", async () => {
    const cache = cacheStub({
      read: vi.fn(async () => pageRecord(2)),
      removeBasis: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    });
    const controller = mountController({ cache });

    await vi.waitFor(() =>
      expect(controller.snapshot().occurrences[0]).toMatchObject({
        state: "measured",
        source: "background",
        pageCount: 2,
      }),
    );
    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    await vi.waitFor(() => expect(cache.removeBasis).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      source: "foreground",
      pageCount: 3,
    });
    expect(cache.write).not.toHaveBeenCalled();
  });

  it("deletes a stale located target before committing pending target state", async () => {
    const operations: string[] = [];
    const foreground = occurrenceSnapshot(0, true, 3);
    const controller = mountController({
      facts: factsWithToc(),
      cache: cacheStub({
        write: vi.fn(async (_basis, _record, value) => {
          operations.push(`write:${String(decodeRecord(value).type)}`);
        }),
        remove: vi.fn(async () => {
          operations.push("remove");
        }),
      }),
      foregroundSnapshot: () => foreground,
      measureForegroundTocTargets: async () => {
        throw new Error("target unavailable");
      },
    });

    controller.updateForeground(foreground);
    await vi.advanceTimersByTimeAsync(1_600);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      pageCount: 3,
      tocTargets: [{ result: { state: "failed" } }],
    });
    await vi.waitFor(() => expect(operations).toContain("write:page-count"));
    expect(operations.indexOf("remove")).toBeGreaterThanOrEqual(0);
    expect(operations.indexOf("remove")).toBeLessThan(operations.lastIndexOf("write:page-count"));
  });

  it("orders scalar writes so a stale completion cannot overwrite a newer revision", async () => {
    const cache = memoryPaginationCache();
    const firstWrite = Promise.withResolvers<void>();
    const store = cache.write.getMockImplementation()!;
    cache.write.mockImplementationOnce(async (...args) => {
      await firstWrite.promise;
      await store(...args);
    });
    const controller = mountController({ cache });

    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    await vi.waitFor(() => expect(cache.write).toHaveBeenCalledOnce());
    controller.updateForeground(relayout(occurrenceSnapshot(0, true, 4)));
    await vi.advanceTimersByTimeAsync(750);
    firstWrite.resolve();
    await vi.waitFor(() => expect(cache.write).toHaveBeenCalledTimes(2));

    expect(cache.pageRecords()).toMatchObject([{ pageCount: 4 }]);
  });

  it("correlates scalar writes with monotonic controller-lifetime IDs", async ({ harness }) => {
    const cache = cacheStub();
    const controller = mountController({
      facts: facts(2),
      cache,
      diagnostics: harness.diagnostics,
    });

    controller.updateForeground(occurrenceSnapshot(0, true));
    controller.updateForeground(occurrenceSnapshot(1, true));
    await vi.waitFor(() =>
      expect(harness.events).toContainEqual(
        expect.objectContaining({ type: "cache-drain", outcome: "durable" }),
      ),
    );
    expect(cache.write).toHaveBeenCalledTimes(2);
    expect(lifecycle(harness.events, "cache-write")).toMatchObject([
      { action: "start", operationId: 1, runRevision: 1 },
      { action: "complete", operationId: 1, runRevision: 1 },
      { action: "start", operationId: 2, runRevision: 1 },
      { action: "complete", operationId: 2, runRevision: 1 },
    ]);
  });
});

function bulkCache(writeMany: NonNullable<Cache["writeMany"]> = async () => {}) {
  return cacheStub({ writeMany });
}

describe("pagination cache bulk writes", () => {
  it("coalesces many page writes into batches of at most 32 mutations", async () => {
    const cache = bulkCache();
    const controller = mountController({ facts: facts(65), cache });

    for (let occurrence = 0; occurrence < 65; occurrence += 1) {
      controller.updateForeground(occurrenceSnapshot(occurrence, true));
    }
    await vi.waitFor(() => expect(cache.writeMany).toHaveBeenCalledTimes(3));
    expect(cache.write).not.toHaveBeenCalled();
    expect(cache.writeMany.mock.calls.map((call) => call[1].length)).toEqual([32, 32, 1]);
    expect(
      cache.writeMany.mock.calls.flatMap((call) => call[1]).every(({ type }) => type === "write"),
    ).toBe(true);
  });

  it("defers partial-run writes until full-book measurement completes", async ({ harness }) => {
    const cache = bulkCache();
    const controller = mountController({
      facts: facts(2),
      cache,
      createMeasurementRuntime: async () => measurementRuntime(),
    });

    controller.updateForeground(occurrenceSnapshot(0, true));
    await harness.advance(1_000);
    expect(cache.writeMany).not.toHaveBeenCalled();

    controller.updateForeground(occurrenceSnapshot(1, true));
    await vi.waitFor(() => expect(cache.writeMany).toHaveBeenCalledOnce());
    expect(cache.writeMany.mock.calls[0]![1]).toHaveLength(2);
  });

  it("orders target removals before the page mutation in a bulk write", async () => {
    const cache = bulkCache();
    const controller = mountController({ facts: factsWithToc(), cache });
    const scroll = occurrenceSnapshot(0, true);
    const settlement = committedLayout(scroll).settlement;
    if (settlement.adapter !== "reflowable-xhtml") throw new Error("expected reflowable layout");
    settlement.mode = "document-scroll";
    settlement.settlement = {
      mode: "document-scroll",
      measurement: settlement.settlement.measurement,
    };

    controller.updateForeground(scroll);
    await vi.waitFor(() => expect(cache.writeMany).toHaveBeenCalledOnce());
    const operations = cache.writeMany.mock.calls[0]![1];
    expect(operations.map(({ type }) => type)).toEqual(["remove", "write"]);
    const page = operations[1]!;
    expect(page.type === "write" && decodeRecord(page.value)).toMatchObject({
      type: "inapplicable",
    });
  });

  it("serializes bulk revisions so stale writes cannot overwrite a newer occurrence", async () => {
    const first = Promise.withResolvers<void>();
    const records = new Map<string, Uint8Array>();
    let calls = 0;
    const cache = bulkCache(async (basis, operations) => {
      calls += 1;
      if (calls === 1) await first.promise;
      for (const operation of operations) {
        const key = `${basis}:${operation.record}`;
        if (operation.type === "write") records.set(key, operation.value.slice());
        else records.delete(key);
      }
    });
    const controller = mountController({ cache });

    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    await vi.waitFor(() => expect(cache.writeMany).toHaveBeenCalledOnce());
    controller.updateForeground(relayout(occurrenceSnapshot(0, true, 4)));
    expect(cache.writeMany).toHaveBeenCalledOnce();
    first.resolve();
    await vi.waitFor(() => expect(cache.writeMany).toHaveBeenCalledTimes(2));
    const revisions = cache.writeMany.mock.calls.map((call) => {
      const page = call[1].find((operation) => operation.type === "write");
      return page?.type === "write" ? Number(decodeRecord(page.value).revision) : Number.NaN;
    });
    expect(revisions[1]).toBeGreaterThan(revisions[0] ?? Infinity);
    expect(decodeRecord([...records.values()][0])).toMatchObject({
      type: "page-count",
      pageCount: 4,
    });
  });

  it("reports a bulk cache write as drained only after persistence settles", async ({
    harness,
  }) => {
    const persistence = Promise.withResolvers<void>();
    const cache = bulkCache(() => persistence.promise);
    const controller = mountController({ cache, diagnostics: harness.diagnostics });

    controller.updateForeground(occurrenceSnapshot(0, true));
    await vi.waitFor(() => expect(cache.writeMany).toHaveBeenCalledOnce());
    expect(lifecycle(harness.events, "cache-write")).toMatchObject([
      { action: "start", operationId: 1, runRevision: 1, operationCount: 1 },
    ]);
    persistence.resolve();
    await vi.waitFor(() =>
      expect(lifecycle(harness.events, "cache-write", "complete")).toMatchObject([
        { operationId: 1, runRevision: 1, operationCount: 1, completedOperationCount: 1 },
      ]),
    );
    expect(harness.events).toContainEqual(
      expect.objectContaining({ type: "cache-drain", runRevision: 1, outcome: "durable" }),
    );
  });

  it("reports failed cache persistence only after the write terminal", async ({ harness }) => {
    const cache = bulkCache(async () => {
      throw new Error("storage unavailable");
    });
    const controller = mountController({ cache, diagnostics: harness.diagnostics });

    controller.updateForeground(occurrenceSnapshot(0, true));
    await vi.waitFor(() =>
      expect(harness.events).toContainEqual(
        expect.objectContaining({ type: "cache-drain", outcome: "failed" }),
      ),
    );
    const terminal = harness.events.filter(
      (event) => event.type === "cache-drain" || event.type === "cache-write",
    );
    expect(terminal).toMatchObject([
      { type: "cache-write", action: "start", operationId: 1 },
      { type: "cache-write", action: "failed", operationId: 1 },
      { type: "cache-drain", outcome: "failed" },
    ]);
  });

  it("terminalizes an active cache write exactly once when the controller closes", async ({
    harness,
  }) => {
    const persistence = Promise.withResolvers<void>();
    const controller = mountController({
      cache: bulkCache(() => persistence.promise),
      diagnostics: harness.diagnostics,
    });

    controller.updateForeground(occurrenceSnapshot(0, true));
    await vi.waitFor(() => expect(lifecycle(harness.events, "cache-write")).toHaveLength(1));
    controller.close();
    persistence.resolve();
    await flushMicrotasks(2);

    expect(lifecycle(harness.events, "cache-write")).toMatchObject([
      { action: "start", operationId: 1 },
      { action: "cancelled", operationId: 1 },
    ]);
    expect(harness.events).toContainEqual(
      expect.objectContaining({ type: "cache-drain", runRevision: 1, outcome: "cancelled" }),
    );
  });

  it("cancels cache-write ownership at a basis revision boundary", async ({ harness }) => {
    const persistence = Promise.withResolvers<void>();
    const container = mountContainer({ width: 100, height: 200 });
    const controller = mountController({
      container,
      cache: bulkCache(() => persistence.promise),
      diagnostics: harness.diagnostics,
    });

    await Promise.resolve();
    controller.updateForeground(occurrenceSnapshot(0, true));
    await vi.waitFor(() =>
      expect(lifecycle(harness.events, "cache-write", "start")).toMatchObject([
        { operationId: 1, runRevision: 1 },
      ]),
    );
    harness.resize(container, 700, 900);

    expect(controller.snapshot().runRevision).toBe(2);
    expect(lifecycle(harness.events, "cache-write", "cancelled")).toMatchObject([
      { operationId: 1, runRevision: 1 },
    ]);
    expect(harness.events).toContainEqual(
      expect.objectContaining({ type: "cache-drain", runRevision: 1, outcome: "cancelled" }),
    );
  });
});
