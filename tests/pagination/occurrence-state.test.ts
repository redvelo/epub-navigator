// @vitest-environment jsdom

import { describe, expect, vi } from "vitest";
import type { NavigatorDiagnosticEvent } from "../../src/runtime/pagination/index.js";
import {
  automaticMeasurementRuntime,
  facts,
  it,
  fixedOccurrenceSnapshot,
  measurementRuntime,
  mountContainer,
  mountController,
  occurrenceSnapshot,
  preferences,
  runtimeSnapshot,
  unresolvedLayoutRepairs,
} from "../support/pagination-harness.js";

describe("pagination run diagnostics", () => {
  it("emits one terminal summary for a cancelled pagination run", () => {
    const events: NavigatorDiagnosticEvent[] = [];
    const controller = mountController({
      diagnostics: { level: "summary", record: (event) => events.push(event) },
    });

    controller.close();
    controller.close();

    expect(events.filter((event) => event.type === "pagination-run")).toMatchObject([
      { action: "start", runRevision: 1, outcome: "running" },
      { action: "terminal", runRevision: 1, outcome: "cancelled" },
    ]);
  });

  it("times TOC indexing from before the catalog is built", () => {
    const events: NavigatorDiagnosticEvent[] = [];
    const times = [10, 25, 100, 110];
    mountController({
      diagnostics: {
        level: "trace",
        now: () => times.shift() ?? 110,
        record: (event) => events.push(event),
      },
    });

    expect(events).toContainEqual({
      type: "derived-build",
      build: "toc-index",
      durationMs: 15,
      itemCount: 0,
    });
  });

  it("keeps pagination operational and diagnostic durations valid with a hostile clock", () => {
    const events: NavigatorDiagnosticEvent[] = [];
    const values: (number | Error)[] = [100, Number.NaN, 90, new Error("clock failed"), Infinity];

    const controller = mountController({
      diagnostics: {
        level: "trace",
        now: () => {
          const value = values.shift();
          if (value instanceof Error) throw value;
          return value ?? 120;
        },
        record: (event) => events.push(event),
      },
    });
    expect(controller.snapshot().pageCountCoverage.totalOccurrences).toBe(1);
    controller.close();

    const durations = events.flatMap((event) =>
      "durationMs" in event && event.durationMs !== undefined ? [event.durationMs] : [],
    );
    expect(durations.every((duration) => Number.isFinite(duration) && duration >= 0)).toBe(true);
  });
});

describe("pagination basis", () => {
  it("ignores duplicate ResizeObserver dimensions against the effective basis", async ({
    harness,
  }) => {
    const container = mountContainer({ width: 100, height: 200 });
    const controller = mountController({ container });

    await Promise.resolve();
    harness.resize(container, 100, 200);
    expect(controller.snapshot().runRevision).toBe(1);
    harness.resize(container, 120, 200);
    expect(controller.snapshot()).toMatchObject({ runRevision: 2, state: "stale" });
    await vi.advanceTimersByTimeAsync(200);
    harness.resize(container, 120, 200);
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.snapshot()).toMatchObject({
      runRevision: 2,
      state: "idle",
      basis: { viewport: { width: 120, height: 200 } },
    });
  });

  it("keeps paint-only system color out of the basis but invalidates for DPR changes", async () => {
    const queries = new Map<string, Set<() => void>>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => {
        const listeners = queries.get(query) ?? new Set<() => void>();
        queries.set(query, listeners);
        return {
          media: query,
          matches: false,
          addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
          removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        };
      }),
    );
    try {
      const controller = mountController();
      expect(queries.has("(prefers-color-scheme: dark)")).toBe(false);
      expect(controller.snapshot().runRevision).toBe(1);

      vi.stubGlobal("devicePixelRatio", 2);
      for (const listener of [...queries.get("(resolution: 1dppx)")!]) listener();
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.snapshot().basis.devicePixelRatio).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains whole-book measurements when only the publication theme changes", async () => {
    const controller = mountController();
    controller.updateForeground(runtimeSnapshot(false, true));
    await vi.advanceTimersByTimeAsync(225);
    const before = controller.snapshot();

    controller.setPreferences({ ...preferences, theme: "light" });

    expect(controller.snapshot()).toMatchObject({
      runRevision: before.runRevision,
      freshness: "current",
      occurrences: [{ state: "measured", pageCount: 3 }],
    });
    expect(controller.snapshot().basis.preferences).not.toHaveProperty("theme");
  });

  it("invalidates whole-book measurements when the effective color scheme changes", async () => {
    const controller = mountController();
    controller.updateForeground(runtimeSnapshot(false, true));
    await vi.advanceTimersByTimeAsync(225);
    const before = controller.snapshot();

    controller.setPreferences({ ...preferences, colorScheme: "dark" });

    expect(controller.snapshot().runRevision).toBeGreaterThan(before.runRevision);
    await vi.advanceTimersByTimeAsync(425);
    expect(controller.snapshot().basis.preferences.colorScheme).toBe("dark");
  });
});

describe("occurrence classification", () => {
  it.each(["fixed-xhtml", "fixed-svg"] as const)(
    "keeps managed %s pending until browser settlement, then counts one durable page",
    (adapter) => {
      const controller = mountController({
        facts: facts(1, adapter),
        createMeasurementRuntime: async () => measurementRuntime(),
      });

      expect(controller.snapshot()).toMatchObject({
        measuredPageCount: 0,
        totalPageCount: null,
        pageCountCoverage: { state: "incomplete", measuredOccurrences: 0 },
        occurrences: [{ state: "pending" }],
      });
      expect(controller.snapshot().occurrences[0]).not.toHaveProperty("pageCount");

      controller.updateForeground(fixedOccurrenceSnapshot(0, adapter));

      expect(controller.snapshot()).toMatchObject({
        measuredPageCount: 1,
        totalPageCount: 1,
        pageCountCoverage: { state: "exact", measuredOccurrences: 1 },
        foreground: { state: "current", occurrence: 0, pageCount: 1 },
        occurrences: [{ state: "measured", pageCount: 1, source: "foreground" }],
      });
    },
  );

  it("fails closed for fixed-svg executable content", () => {
    const declaredScripted = facts(1, "fixed-svg");
    declaredScripted.resources.resources[0]!.scripted = true;
    const declared = mountController({ facts: declaredScripted });
    const ungranted = mountController({ facts: facts(1, "fixed-svg"), eligibleResourcePaths: [] });

    expect(declared.snapshot().occurrences[0]).toMatchObject({
      state: "unavailable",
      reason: "declared-scripted",
    });
    expect(ungranted.snapshot().occurrences[0]).toMatchObject({
      state: "unavailable",
      reason: "executable-content-detected-or-unknown",
    });
  });

  it("publishes fixed-svg unavailable only for a terminally unavailable occurrence", () => {
    const controller = mountController({
      facts: facts(1, "fixed-svg"),
      documents: [
        {
          state: "unavailable",
          resource: "EPUB/chapter-1.svg",
          adapter: "fixed-svg",
          reason: "document-adapter-unavailable",
        },
      ],
    });

    expect(controller.snapshot()).toMatchObject({
      measuredPageCount: 0,
      totalPageCount: null,
      pageCountCoverage: { state: "unavailable", measuredOccurrences: 0 },
      occurrences: [{ state: "unavailable", reason: "document-adapter-unavailable" }],
    });
  });

  it("classifies the adapter from occurrence.document rather than declaration flags", () => {
    const value = facts();
    value.resources.resources[0]!.hasXhtmlDeclaration = false;
    const controller = mountController({ facts: value });

    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "pending",
      resource: "EPUB/chapter-1.xhtml",
    });
  });

  it("marks unresolved background text pagination unavailable", async () => {
    const runtime = measurementRuntime();
    const controller = mountController({ createMeasurementRuntime: async () => runtime });

    await vi.advanceTimersByTimeAsync(75);
    runtime.publish(unresolvedLayoutRepairs(runtimeSnapshot(false, true)));

    expect(controller.snapshot().occurrences[0]).toMatchObject({
      state: "unavailable",
      reason: "unresolved-text-pagination",
    });
  });
});

describe("occurrence projections", () => {
  it("shares unchanged occurrence records between publications", async () => {
    const controller = mountController({ facts: facts(2) });
    const before = controller.snapshot();
    controller.updateForeground(occurrenceSnapshot(0, true));

    await vi.advanceTimersByTimeAsync(200);
    const after = controller.snapshot();
    expect(after).not.toBe(before);
    expect(after.occurrences).not.toBe(before.occurrences);
    expect(after.occurrences[1]).toBe(before.occurrences[1]);
    expect(controller.snapshot()).toBe(after);
  });

  it("provides incremental prefix lookup as occurrences are measured", async () => {
    const controller = mountController({ facts: facts(2) });

    controller.updateForeground(occurrenceSnapshot(1, true, 4));
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.snapshot().pageStart(1)).toBe("pending");

    controller.updateForeground(occurrenceSnapshot(0, true, 3));
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.snapshot()).toMatchObject({ totalPageCount: 7 });
    expect(controller.snapshot().pageStart(1)).toBe(3);
  });

  it("schedules every occurrence in a large book", async () => {
    const count = 2_000;
    const runtime = automaticMeasurementRuntime();
    const controller = mountController({
      facts: facts(count),
      createMeasurementRuntime: async () => runtime,
    });

    await vi.advanceTimersByTimeAsync(count * 50 + 50);
    expect(runtime.open).toHaveBeenCalledTimes(count);
    expect(controller.snapshot().pageCountCoverage).toMatchObject({
      state: "exact",
      measuredOccurrences: count,
      totalOccurrences: count,
    });
  });
});
