// @vitest-environment jsdom

import { describe, expect, vi } from "vitest";
import type { NavigatorRuntime } from "../../src/runtime/navigator/api.js";
import {
  acceptedTransition,
  automaticMeasurementRuntime,
  facts,
  it,
  measurementRuntime,
  mountContainer,
  mountController,
} from "../support/pagination-harness.js";

describe("pagination scheduler visibility and input", () => {
  it("pauses and requeues active work across visibility changes", async ({ harness }) => {
    const runtime = automaticMeasurementRuntime();
    const container = mountContainer();
    const controller = mountController({
      container,
      createMeasurementRuntime: async () => runtime,
      diagnostics: harness.diagnostics,
    });

    await Promise.resolve();
    await harness.runIdle();
    harness.setHidden(true);
    await harness.advance(500);
    expect(controller.snapshot()).toMatchObject({
      state: "paused",
      occurrences: [{ state: "pending" }],
    });
    expect(harness.events).toContainEqual(
      expect.objectContaining({ type: "controller-task", action: "pause", reason: "hidden" }),
    );

    harness.setHidden(false);
    await harness.runIdle();
    await harness.advance(200);
    expect(controller.snapshot().occurrences[0]).toMatchObject({ state: "measured" });
    controller.close();
    expect(container.querySelector("[data-epub-pagination-session]")).toBeNull();
  });

  it("journals scheduled work before idle and requeues it when hidden", async ({ harness }) => {
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      createMeasurementRuntime: async () => runtime,
      diagnostics: harness.diagnostics,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(harness.idleCount()).toBe(1);
    harness.setHidden(true);
    expect(harness.idleCount()).toBe(0);
    expect(runtime.open).not.toHaveBeenCalled();
    harness.setHidden(false);
    await harness.runIdle();
    await harness.advance(200);
    expect(controller.snapshot().occurrences[0]).toMatchObject({ state: "measured" });
    const taskEvents = harness.events.filter((event) => event.type === "controller-task");
    for (const started of taskEvents.filter((event) => event.action === "start")) {
      expect(taskEvents).toContainEqual(
        expect.objectContaining({
          action: "schedule",
          runRevision: started.runRevision,
          taskGeneration: started.taskGeneration,
        }),
      );
    }
  });

  it("does not start the scheduler while the owner document is hidden", async ({ harness }) => {
    harness.setHidden(true);
    const createMeasurementRuntime = vi.fn(async () => measurementRuntime());
    const controller = mountController({ createMeasurementRuntime });

    await harness.advance(1_000);
    expect(createMeasurementRuntime).not.toHaveBeenCalled();
    expect(controller.snapshot().state).toBe("paused");
  });

  it("starts scheduled work when requestIdleCallback never invokes its callback", async ({
    harness,
  }) => {
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({ createMeasurementRuntime: async () => runtime });

    await harness.advance(149);
    expect(runtime.open).not.toHaveBeenCalled();
    await harness.advance(1);
    expect(runtime.open).toHaveBeenCalledWith(0);
    await harness.advance(200);
    expect(controller.snapshot().pageCountCoverage.state).toBe("exact");
  });

  it("does not force scheduled work while browser input is pending", async ({ harness }) => {
    harness.setInputPending(true);
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({ createMeasurementRuntime: async () => runtime });

    await harness.advance(500);
    expect(runtime.open).not.toHaveBeenCalled();
    harness.setInputPending(false);
    await harness.advance(50);
    expect(runtime.open).toHaveBeenCalledWith(0);
    await harness.advance(200);
    expect(controller.snapshot().pageCountCoverage.state).toBe("exact");
  });
});

describe("pagination scheduler bursts", () => {
  it("continues successful auxiliary work without waiting for another idle callback", async ({
    harness,
  }) => {
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      facts: facts(2),
      createMeasurementRuntime: async () => runtime,
    });

    await harness.advance(0);
    expect(harness.idleCount()).toBe(1);
    await harness.runIdle();
    expect(harness.idleCount()).toBe(0);
    await harness.advance(0);
    expect(runtime.open).toHaveBeenCalledTimes(2);
    await harness.advance(200);
    expect(controller.snapshot().pageCountCoverage.state).toBe("exact");
  });

  it("reports exhausted page-count work as unavailable rather than complete", async () => {
    const controller = mountController({
      createMeasurementRuntime: vi
        .fn<() => Promise<NavigatorRuntime>>()
        .mockRejectedValue(new Error("offline")),
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(controller.snapshot()).toMatchObject({
      state: "idle",
      activity: "idle",
      pageCountCoverage: { state: "unavailable", measuredOccurrences: 0 },
      occurrences: [{ state: "failed", message: "offline" }],
    });
  });

  it("measures a whole normal burst without releasing the runtime", async () => {
    const runtime = automaticMeasurementRuntime();
    mountController({ facts: facts(34), createMeasurementRuntime: async () => runtime });

    await vi.advanceTimersByTimeAsync(150);
    expect(runtime.open).toHaveBeenCalledTimes(32);
    expect(runtime.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(runtime.open).toHaveBeenCalledTimes(34);
  });

  it("rests between bursts under conservative pacing", async () => {
    const runtime = automaticMeasurementRuntime();
    const createMeasurementRuntime = vi.fn(async () => runtime);
    const controller = mountController({
      facts: facts(8),
      pacing: "conservative",
      createMeasurementRuntime,
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(runtime.open).toHaveBeenCalledTimes(6);
    expect(runtime.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(runtime.open).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(600);
    expect(runtime.open).toHaveBeenCalledTimes(8);
    expect(createMeasurementRuntime).toHaveBeenCalledOnce();
    expect(controller.snapshot().pageCountCoverage).toMatchObject({
      state: "exact",
      measuredOccurrences: 8,
    });
  });

  it("yields a burst to the quiet period after foreground activity", async () => {
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      facts: facts(4),
      createMeasurementRuntime: async () => runtime,
    });
    const open = vi.mocked(runtime.open);
    const measure = open.getMockImplementation()!;
    open.mockImplementation((occurrence) => {
      if (occurrence === 1) controller.noteForegroundActivity();
      return measure(occurrence);
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(150);
    expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(open).toHaveBeenCalledTimes(4);
  });

  it("holds measurement through a flip-through and resumes at reading pace", async ({
    harness,
  }) => {
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      facts: facts(4),
      createMeasurementRuntime: async () => runtime,
      diagnostics: harness.diagnostics,
    });
    const open = vi.mocked(runtime.open);
    const measure = open.getMockImplementation()!;
    let settleFirst: (() => void) | null = null;
    open.mockImplementation((occurrence) => {
      if (occurrence !== 0) return measure(occurrence);
      settleFirst = () => measure(occurrence);
      return acceptedTransition();
    });

    await Promise.resolve();
    controller.noteForegroundActivity("presentation");
    await harness.advance(260);
    await harness.runIdle();
    expect(open).toHaveBeenCalledTimes(1);
    await harness.advance(100);
    controller.noteForegroundActivity("presentation");
    expect(controller.foregroundFlipping()).toBe(true);
    await harness.advance(40);
    settleFirst!();
    await harness.advance(1_800);
    await harness.runIdle();
    expect(open).toHaveBeenCalledTimes(1);
    await harness.advance(300);
    expect(controller.foregroundFlipping()).toBe(false);
    await harness.runIdle();
    await harness.advance(50);
    expect(open.mock.calls.length).toBeGreaterThan(1);
  });

  it("counts one turn for a tap, its command echo and pointer noise", async ({ harness }) => {
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      facts: facts(4),
      createMeasurementRuntime: async () => runtime,
      diagnostics: harness.diagnostics,
    });

    await Promise.resolve();
    controller.noteForegroundActivity();
    controller.noteForegroundActivity("presentation");
    await harness.advance(40);
    controller.noteForegroundActivity("command");
    await harness.advance(40);
    controller.noteForegroundActivity();
    expect(controller.foregroundFlipping()).toBe(false);
    await harness.runIdle();
    await harness.advance(300);
    await harness.runIdle();
    await harness.advance(50);
    expect(runtime.open).toHaveBeenCalled();
  });
});
