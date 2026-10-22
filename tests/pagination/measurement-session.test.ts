// @vitest-environment jsdom

import { describe, expect, vi } from "vitest";
import type { NavigatorRuntime } from "../../src/runtime/navigator/api.js";
import {
  acceptedTransition,
  automaticMeasurementRuntime,
  facts,
  it,
  flushMicrotasks,
  measurementRuntime,
  mountContainer,
  mountController,
  pendingDocument,
  runtimeSnapshot,
} from "../support/pagination-harness.js";

const sessionSelector = "[data-epub-pagination-session]";

describe("pagination measurement session", () => {
  it("cleans up deferred auxiliary starts on close", async ({ harness }) => {
    const runtime = measurementRuntime();
    const controller = mountController({
      createMeasurementRuntime: async () => runtime,
      diagnostics: harness.diagnostics,
    });

    controller.noteForegroundActivity();
    await harness.advance(25);
    controller.close();
    await harness.advance(2_000);
    expect(harness.idleCount()).toBe(0);
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it("journals and discards a superseded deferred runtime deterministically", async ({
    harness,
  }) => {
    const pendingRuntime = Promise.withResolvers<NavigatorRuntime>();
    const container = mountContainer({ width: 100, height: 200 });
    const controller = mountController({
      container,
      createMeasurementRuntime: () => pendingRuntime.promise,
      diagnostics: harness.diagnostics,
    });

    await flushMicrotasks(2);
    await harness.runIdle();
    harness.resize(container, 120, 200);
    pendingRuntime.resolve(measurementRuntime());
    await flushMicrotasks(2);

    expect(controller.snapshot()).toMatchObject({ runRevision: 2, state: "stale" });
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "controller-task",
        action: "discard",
        reason: "basis-change",
        runRevision: 2,
      }),
    );
    expect(container.querySelector(sessionSelector)).toBeNull();
  });

  it("preempts an active auxiliary measurement without publishing its late result", async () => {
    const runtime = measurementRuntime();
    const controller = mountController({ createMeasurementRuntime: async () => runtime });

    await vi.advanceTimersByTimeAsync(75);
    expect(runtime.open).toHaveBeenCalledWith(0);
    controller.updateForeground(runtimeSnapshot(true, false));
    expect(runtime.close).toHaveBeenCalledOnce();
    runtime.publish(runtimeSnapshot(false, true));
    expect(controller.snapshot().occurrences[0]?.state).toBe("pending");
  });

  it("ignores a superseded factory rejection", async () => {
    const factory = Promise.withResolvers<NavigatorRuntime>();
    const createMeasurementRuntime = vi.fn(() => factory.promise);
    const controller = mountController({ createMeasurementRuntime });

    await vi.advanceTimersByTimeAsync(75);
    expect(createMeasurementRuntime).toHaveBeenCalledOnce();
    controller.updateForeground(runtimeSnapshot(true, false));
    factory.reject(new Error("late factory failure"));
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.snapshot().occurrences[0]?.state).toBe("pending");
  });

  it("retries the same occurrence with a fresh runtime after a factory failure", async () => {
    const runtime = automaticMeasurementRuntime();
    const createMeasurementRuntime = vi
      .fn<() => Promise<NavigatorRuntime>>()
      .mockRejectedValueOnce(new Error("factory failed"))
      .mockResolvedValue(runtime);
    const controller = mountController({ facts: facts(2), createMeasurementRuntime });

    await vi.advanceTimersByTimeAsync(325);

    expect(createMeasurementRuntime).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().occurrences[0]?.state).toBe("measured");
    expect(runtime.open).toHaveBeenCalledWith(0);
  });

  it("recovers after runtime.open throws synchronously", async () => {
    const first = measurementRuntime();
    vi.mocked(first.open).mockImplementation(() => {
      throw new Error("open failed");
    });
    const second = automaticMeasurementRuntime();
    const container = mountContainer();
    const controller = mountController({
      facts: facts(2),
      container,
      createMeasurementRuntime: vi
        .fn<() => Promise<NavigatorRuntime>>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(controller.snapshot().occurrences[0]).toMatchObject({ state: "pending" });
    expect(first.close).toHaveBeenCalledOnce();
    expect(container.querySelector(sessionSelector)).toBeNull();

    await vi.advanceTimersByTimeAsync(250);
    expect(second.open).toHaveBeenCalledWith(0);
    expect(controller.snapshot().occurrences[0]).toMatchObject({ state: "measured" });
  });

  it.each(["configure", "subscribe", "subscribe-errors"] as const)(
    "rolls back a runtime when %s fails during construction",
    async (failure) => {
      const unsubscribe = vi.fn();
      const runtime = measurementRuntime();
      if (failure === "configure") {
        runtime.setPresentationPreferences = () => {
          throw new Error("configure failed");
        };
      }
      runtime.subscribe = vi.fn(() => {
        if (failure === "subscribe") throw new Error("subscribe failed");
        return unsubscribe;
      });
      runtime.subscribeErrors = vi.fn(() => {
        if (failure === "subscribe-errors") throw new Error("subscribe-errors failed");
        return vi.fn();
      });
      const container = mountContainer();
      const controller = mountController({
        container,
        createMeasurementRuntime: async () => runtime,
      });

      await vi.advanceTimersByTimeAsync(150);
      expect(runtime.close).toHaveBeenCalledTimes(2);
      expect(runtime.open).not.toHaveBeenCalled();
      expect(container.querySelector(sessionSelector)).toBeNull();
      expect(controller.snapshot().occurrences[0]?.state).toBe("failed");
      if (failure === "subscribe-errors") expect(unsubscribe).toHaveBeenCalledTimes(2);
    },
  );

  it("recovers a synchronous load failure after the runtime snapshot rolls back", async () => {
    const failed = measurementRuntime();
    vi.mocked(failed.open).mockImplementation(() => {
      failed.publish(null, [
        {
          type: "document-pending",
          generation: 7,
          occurrence: 0,
          resource: "EPUB/chapter-1.xhtml",
        },
        { type: "document-load-failed", generation: 7, reason: { reason: "load-error" } },
      ]);
      return acceptedTransition();
    });
    const recovered = automaticMeasurementRuntime();
    const createMeasurementRuntime = vi
      .fn<() => Promise<NavigatorRuntime>>()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(recovered);
    const controller = mountController({ createMeasurementRuntime });

    await vi.advanceTimersByTimeAsync(300);
    expect(createMeasurementRuntime).toHaveBeenCalledTimes(2);
    expect(recovered.open).toHaveBeenCalledWith(0);
    expect(controller.snapshot()).toMatchObject({
      state: "complete",
      pageCountCoverage: { state: "exact" },
      occurrences: [{ state: "measured" }],
    });
  });

  it("recovers page-count work when runtime creation never settles", async ({ harness }) => {
    const runtime = automaticMeasurementRuntime();
    const createMeasurementRuntime = vi
      .fn<() => Promise<NavigatorRuntime>>()
      .mockReturnValueOnce(Promise.withResolvers<NavigatorRuntime>().promise)
      .mockResolvedValueOnce(runtime);
    const controller = mountController({ createMeasurementRuntime });

    await flushMicrotasks(2);
    await harness.runIdle();
    await harness.advance(10_000);
    await harness.runIdle();
    await harness.advance(200);

    expect(createMeasurementRuntime).toHaveBeenCalledTimes(2);
    expect(runtime.open).toHaveBeenCalledWith(0);
    expect(controller.snapshot().pageCountCoverage.state).toBe("exact");
  });

  it("ignores a late terminal event from the previous auxiliary document", async () => {
    const runtime = measurementRuntime();
    vi.mocked(runtime.open).mockImplementation((occurrence) => {
      const current = runtime.snapshot();
      const value = {
        ...current,
        document: { ...current.document, pending: pendingDocument(occurrence + 1, occurrence) },
      };
      runtime.publish(value, [
        {
          type: "document-pending",
          generation: occurrence + 1,
          occurrence,
          resource: `EPUB/chapter-${occurrence + 1}.xhtml`,
        },
      ]);
      return acceptedTransition();
    });
    const controller = mountController({
      facts: facts(2),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(75);
    runtime.publish(runtimeSnapshot(false, true));
    await vi.advanceTimersByTimeAsync(275);
    expect(runtime.open).toHaveBeenCalledWith(1);

    runtime.publish(null, [{ type: "document-invalidated", generation: 1 }]);

    expect(controller.snapshot().occurrences[1]?.state).toBe("measuring");
  });

  it("commits a timed-out settlement as a provisional count without waiting for late resources", async () => {
    const runtime = automaticMeasurementRuntime(async () => [], { resource: "timed-out" });
    const controller = mountController({ createMeasurementRuntime: async () => runtime });
    const provisional = {
      occurrences: [{ state: "measured", pageCount: 3, source: "background" }],
      pageCountCoverage: { state: "exact", measuredOccurrences: 1 },
    };

    await vi.advanceTimersByTimeAsync(50);
    expect(runtime.open).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject(provisional);

    runtime.setSettlement({ resource: "loaded" });
    runtime.relayout(0, 4);
    await vi.advanceTimersByTimeAsync(5_500);

    expect(runtime.open).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject(provisional);
  });
});
