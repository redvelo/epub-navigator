// @vitest-environment jsdom

import { describe, expect, vi } from "vitest";
import type { NavigatorRuntime } from "../../src/runtime/navigator/api.js";
import type { NavigatorDiagnosticEvent } from "../../src/runtime/pagination/index.js";
import {
  automaticMeasurementRuntime,
  committedLayout,
  facts,
  it,
  flushMicrotasks,
  measurementRuntime,
  mountController,
  occurrenceSnapshot,
  paginated,
  pendingDocument,
  pendingLayout,
  preferences,
  relayout,
  runtimeSnapshot,
  unresolvedLayoutRepairs,
} from "../support/pagination-harness.js";

describe("foreground quiet period", () => {
  it("waits for a trailing foreground quiet period before starting auxiliary work", async ({
    harness,
  }) => {
    const runtime = measurementRuntime();
    const controller = mountController({
      createMeasurementRuntime: async () => runtime,
      diagnostics: harness.diagnostics,
    });

    controller.noteForegroundActivity();
    await harness.advance(25);
    expect(harness.idleCount()).toBe(0);
    await harness.advance(200);
    controller.noteForegroundActivity();
    await harness.advance(249);
    expect(harness.idleCount()).toBe(0);
    await harness.advance(1);
    expect(harness.idleCount()).toBe(1);
    expect(
      harness.events.filter(
        (event) => event.type === "controller-task" && event.action === "schedule",
      ),
    ).toHaveLength(1);
    await harness.runIdle();
    await flushMicrotasks(5);
    expect(runtime.open).toHaveBeenCalledWith(0);
  });

  it("bounds continuous foreground activity without cancelling active work", async ({
    harness,
  }) => {
    const runtime = measurementRuntime();
    const controller = mountController({
      createMeasurementRuntime: async () => runtime,
      diagnostics: harness.diagnostics,
    });

    controller.noteForegroundActivity();
    await harness.advance(25);
    for (let activity = 0; activity < 5; activity += 1) {
      await harness.advance(200);
      controller.noteForegroundActivity();
    }
    expect(harness.idleCount()).toBe(1);
    for (let activity = 0; activity < 10; activity += 1) controller.noteForegroundActivity();
    expect(harness.idleCount()).toBe(1);
    await harness.runIdle();
    await flushMicrotasks(5);
    expect(runtime.open).toHaveBeenCalledWith(0);

    controller.noteForegroundActivity();
    expect(runtime.close).not.toHaveBeenCalled();
    expect(harness.events).not.toContainEqual(
      expect.objectContaining({ type: "controller-task", action: "pause" }),
    );
  });

  it("starts a fresh quiet period after foreground navigation settles", async ({ harness }) => {
    const controller = mountController({
      facts: facts(2),
      createMeasurementRuntime: async () => measurementRuntime(),
    });

    controller.noteForegroundActivity();
    controller.updateForeground(runtimeSnapshot(true, false));
    await harness.advance(1_000);
    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    expect(harness.idleCount()).toBe(0);
    await harness.advance(249);
    expect(harness.idleCount()).toBe(0);
    await harness.advance(1);
    expect(harness.idleCount()).toBe(1);
  });
});

describe("foreground and auxiliary ownership", () => {
  it("records foreground updates and coherent publication sequences", () => {
    const events: NavigatorDiagnosticEvent[] = [];
    const controller = mountController({
      diagnostics: { level: "trace", record: (event) => events.push(event) },
    });

    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "controller-update", sequence: 1, stateRevision: 1 }),
    );
    expect(events.filter((event) => event.type === "controller-publish").at(-1)).toMatchObject({
      foreground: "current",
      coverage: "exact",
      totalPageCount: 3,
    });
  });

  it("continues scheduling when foreground settlement supersedes deferred runtime work", async ({
    harness,
  }) => {
    const pendingRuntime = Promise.withResolvers<NavigatorRuntime>();
    const runtime = measurementRuntime();
    const controller = mountController({
      facts: facts(2),
      createMeasurementRuntime: () => pendingRuntime.promise,
    });

    await flushMicrotasks(2);
    await harness.runIdle();
    controller.updateForeground(occurrenceSnapshot(0, true));
    await harness.advance(200);
    pendingRuntime.resolve(runtime);
    await flushMicrotasks(5);
    expect(harness.idleCount()).toBe(1);
    await harness.runIdle();

    expect(runtime.open).toHaveBeenCalledWith(1);
  });

  it("continues with the next occurrence after foreground settlement", async () => {
    const runtime = measurementRuntime();
    const controller = mountController({
      facts: facts(2),
      createMeasurementRuntime: async () => runtime,
    });

    controller.updateForeground(runtimeSnapshot(false, true));
    await vi.advanceTimersByTimeAsync(300);

    expect(vi.mocked(runtime.open).mock.calls).toEqual([[1]]);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      source: "foreground",
    });
  });

  it("does not consume stabilization attempts when foreground work preempts measurement", async () => {
    const runtimes: NavigatorRuntime[] = [];
    const createMeasurementRuntime = vi.fn(async () => {
      const runtime = measurementRuntime();
      runtimes.push(runtime);
      return runtime;
    });
    const controller = mountController({ createMeasurementRuntime });

    for (let preemption = 0; preemption < 4; preemption += 1) {
      await vi.advanceTimersByTimeAsync(50);
      expect(runtimes[preemption]?.open).toHaveBeenCalledWith(0);
      controller.updateForeground(runtimeSnapshot(true, false));
      expect(controller.snapshot().occurrences[0]?.state).toBe("pending");
      controller.updateForeground(runtimeSnapshot(false, false));
    }
    expect(createMeasurementRuntime).toHaveBeenCalledTimes(4);
    expect(controller.snapshot().occurrences[0]?.state).toBe("pending");
  });

  it("prioritizes current, next, previous, then outward after foreground movement", async () => {
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      facts: facts(7),
      createMeasurementRuntime: async () => runtime,
    });
    controller.updateForeground(occurrenceSnapshot(3, true));

    await vi.advanceTimersByTimeAsync(1_800);
    expect(vi.mocked(runtime.open).mock.calls.flat()).toEqual([4, 2, 5, 1, 6, 0]);
  });
});

describe("foreground disagreement", () => {
  it("replaces a provisional background count with a disagreeing settled foreground count in place", async () => {
    const runtime = automaticMeasurementRuntime(async () => [], { resource: "timed-out" });
    const controller = mountController({
      facts: facts(2),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.snapshot()).toMatchObject({
      occurrences: [
        { state: "measured", pageCount: 3, source: "background" },
        { state: "measured", pageCount: 3, source: "background" },
      ],
      pageCountCoverage: { state: "exact", measuredOccurrences: 2 },
    });

    controller.updateForeground(occurrenceSnapshot(0, true, 4));

    expect(controller.snapshot()).toMatchObject({
      runRevision: 1,
      occurrences: [
        { state: "measured", pageCount: 4, source: "foreground" },
        { state: "measured", pageCount: 3, source: "background" },
      ],
      pageCountCoverage: { state: "exact", measuredOccurrences: 2 },
    });
  });

  it("fully resets the owned epoch before accepting a disagreeing foreground result", async () => {
    const runtime = measurementRuntime();
    const controller = mountController({
      facts: facts(2),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(50);
    runtime.publish(runtimeSnapshot(false, true));
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.open).toHaveBeenCalledWith(1);
    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "measured",
      pageCount: 3,
      source: "background",
    });

    controller.updateForeground(occurrenceSnapshot(0, true, 4));

    expect(controller.snapshot()).toMatchObject({
      runRevision: 2,
      occurrences: [
        { state: "measured", pageCount: 4, source: "foreground" },
        { state: "pending" },
      ],
    });
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("does not mix a settled foreground result into a stale basis", async () => {
    const foreground = runtimeSnapshot(false, true);
    const controller = mountController({ foregroundSnapshot: () => foreground });

    controller.updateForeground(foreground);
    await vi.advanceTimersByTimeAsync(225);
    expect(controller.snapshot().occurrences[0]).toMatchObject({ state: "measured", pageCount: 3 });

    controller.setPreferences({ ...preferences, fontScale: "125" });
    relayout(foreground);
    paginated(foreground).pages.pageCount = 4;
    controller.updateForeground(foreground);
    await vi.advanceTimersByTimeAsync(250);

    expect(controller.snapshot()).toMatchObject({
      state: "stale",
      occurrences: [{ state: "measured", pageCount: 3 }],
    });
  });
});

describe("foreground layout transitions", () => {
  it("keeps the outgoing chapter measurement during an incoming initial layout", async () => {
    const controller = mountController();
    const settled = runtimeSnapshot(false, true);
    controller.updateForeground(settled);
    await vi.advanceTimersByTimeAsync(225);
    expect(controller.snapshot().occurrences[0]).toMatchObject({ state: "measured", pageCount: 3 });

    controller.updateForeground({
      ...settled,
      document: { ...settled.document, pending: pendingDocument(2, 1) },
      layout: { ...settled.layout, pending: pendingLayout(2, 2) },
    });

    expect(controller.snapshot()).toMatchObject({
      state: "complete",
      foreground: { state: "pending" },
      occurrences: [{ state: "measured", pageCount: 3 }],
    });
  });

  it("retains a committed count when a same-basis candidate relayout fails", async () => {
    const controller = mountController();
    const settled = occurrenceSnapshot(0, true, 3);

    controller.updateForeground(settled);
    await vi.advanceTimersByTimeAsync(200);
    controller.updateForeground({
      ...settled,
      layout: { ...settled.layout, pending: pendingLayout(1, 2) },
    });
    expect(controller.snapshot()).toMatchObject({
      freshness: "candidate-pending",
      foreground: { state: "pending" },
      occurrences: [{ state: "measured", pageCount: 3 }],
    });

    controller.updateForeground(settled);
    expect(controller.snapshot()).toMatchObject({
      freshness: "current",
      foreground: { state: "current", occurrence: 0, pageCount: 3 },
      occurrences: [{ state: "measured", pageCount: 3 }],
    });
  });

  it("does not seed an old committed layout while relayout is pending", async () => {
    const controller = mountController();
    const snapshot = runtimeSnapshot(false, true);
    controller.updateForeground({
      ...snapshot,
      layout: { ...snapshot.layout, pending: pendingLayout(1, 2) },
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(controller.snapshot().occurrences[0]?.state).toBe("pending");
  });

  it("publishes and terminalizes a foreground document-scroll occurrence", () => {
    const controller = mountController();
    const listener = vi.fn();
    controller.subscribe(listener);
    const scroll = runtimeSnapshot(false, true);
    const settlement = committedLayout(scroll).settlement;
    if (settlement.adapter !== "reflowable-xhtml") throw new Error("expected reflowable layout");
    settlement.mode = "document-scroll";
    settlement.settlement = {
      mode: "document-scroll",
      measurement: settlement.settlement.measurement,
    };

    controller.updateForeground(scroll);

    expect(listener).toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      foreground: { state: "unavailable" },
      pageCountCoverage: { state: "unavailable" },
      occurrences: [{ state: "inapplicable", reason: "effective-presentation-not-paginated" }],
    });
  });

  it("preserves a durable count when the matching foreground settlement times out", () => {
    const controller = mountController();

    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    const timedOut = relayout(occurrenceSnapshot(0, true, 3));
    paginated(timedOut).measurement.requiredResources = "timed-out";
    controller.updateForeground(timedOut);

    expect(controller.snapshot()).toMatchObject({
      foreground: { state: "current", pageCount: 3 },
      occurrences: [{ state: "measured", pageCount: 3 }],
      pageCountCoverage: { state: "exact", measuredOccurrences: 1 },
    });
  });

  it("removes measured aggregates when an occurrence becomes unavailable", async () => {
    const controller = mountController();

    controller.updateForeground(runtimeSnapshot(false, true));
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.snapshot().pageCountCoverage).toMatchObject({
      measuredOccurrences: 1,
      measuredPageCount: 3,
    });
    controller.updateForeground(unresolvedLayoutRepairs(relayout(runtimeSnapshot(false, true))));
    expect(controller.snapshot()).toMatchObject({
      measuredPageCount: 0,
      pageCountCoverage: { measuredOccurrences: 0, measuredPageCount: 0 },
      occurrences: [{ state: "unavailable", reason: "unresolved-text-pagination" }],
    });
  });
});
