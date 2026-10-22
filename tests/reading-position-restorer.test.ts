import { describe, expect, it, vi } from "vitest";
import type { KernelInput, KernelSnapshot, KernelTransition } from "../src/generated/kernel.js";
import type {
  AnnotationTargetOperationResult,
  NavigatorReadingPosition,
} from "../src/runtime/navigator/api.js";
import { ReadingPositionRestorerRuntime } from "../src/runtime/navigation/reading-position-restorer.js";

const resource = "EPUB/chapter.xhtml";
const occurrence = 7;
const position: NavigatorReadingPosition = {
  targetJson: "{}",
  occurrenceHint: { occurrence, resource },
};

function snapshot(layout: "absent" | "dirty" | "settled", pending = false): KernelSnapshot {
  return {
    readingOrder: [
      {
        ordinal: occurrence,
        document: { state: "loadable", resource, adapter: "reflowable-xhtml" },
      },
    ],
    document: {
      pending: pending ? {} : null,
      committed:
        layout === "absent"
          ? null
          : {
              generation: 3,
              frame: {
                generation: 4,
                occurrence,
                resource,
                adapter: "reflowable-xhtml",
              },
              layout: {
                state: layout,
                layout: {
                  settlement: { adapter: "reflowable-xhtml", mode: "paginated" },
                },
              },
            },
    },
  } as unknown as KernelSnapshot;
}

function transition(events: KernelTransition["events"]): KernelTransition {
  return { accepted: true, stateRevision: 1, events, effects: [], failure: null };
}

function createHarness() {
  let current = snapshot("absent");
  const listeners = new Set<(next: KernelTransition) => void>();
  const resolved: AnnotationTargetOperationResult = {
    operation: 1,
    generation: 3,
    occurrence,
    resource,
    outcome: "completed" as const,
    result: { outcome: "resolved" as const, reports: [], segment: null },
  };
  const relocate = vi.fn(async (): Promise<AnnotationTargetOperationResult> => resolved);
  const dispatch = vi.fn((input: KernelInput) => {
    expect(input).toEqual({
      type: "command",
      command: { type: "open-occurrence", occurrence },
    });
    current = snapshot("absent", true);
    return transition([{ type: "document-pending", generation: 3, occurrence, resource }]);
  });
  const runtime = Object.assign(Object.create(ReadingPositionRestorerRuntime.prototype), {
    _closed: false,
    _restoreController: null,
    _kernel: {
      snapshot: () => current,
      projectAnnotationTarget: () => ({
        resource,
        selectors: [
          {
            kind: "html-fragment",
            path: [],
            values: { value: "target" },
            refinements: [],
          },
        ],
      }),
    },
    _accepted: (value: KernelTransition) => value,
    _dispatchAndApply: dispatch,
    _runAnnotationTargetOperation: relocate,
    _noteForegroundActivity: vi.fn(),
    _runPresentationOperation: vi.fn(async () => ({
      outcome: "completed" as const,
      status: { status: "boundary" as const },
      operation: 2,
      generation: 3,
      occurrence,
      resource,
    })),
    _runLocatorOperation: vi.fn(),
    subscribe: (listener: (next: KernelTransition) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }) as ReadingPositionRestorerRuntime;

  return {
    runtime,
    dispatch,
    relocate,
    resolved,
    commitDirty() {
      current = snapshot("dirty");
      const committed = transition([
        { type: "document-committed", generation: 3, occurrence, resource },
      ]);
      for (const listener of [...listeners]) listener(committed);
    },
    settle() {
      current = snapshot("settled");
      const settled = transition([]);
      for (const listener of [...listeners]) listener(settled);
    },
  };
}

describe("reading position restoration", () => {
  it.each(["ambiguous", "broken", "conflict"] as const)(
    "reports %s search destinations as failed restoration",
    async (outcome) => {
      const harness = createHarness();
      harness.settle();
      harness.relocate.mockResolvedValueOnce({
        ...harness.resolved,
        result: { outcome, reports: [], segment: null },
      });
      await expect(harness.runtime.restoreAnnotationTarget(position)).resolves.toMatchObject({
        status: "failed",
        reason: "unavailable",
        message: `annotation target relocation was ${outcome}`,
      });
      expect(harness.relocate).toHaveBeenCalledOnce();
    },
  );

  it("waits for a dirty current document without reopening it", async () => {
    const harness = createHarness();
    harness.commitDirty();
    const restoration = harness.runtime.restoreAnnotationTarget(position);
    await Promise.resolve();
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.relocate).not.toHaveBeenCalled();
    harness.settle();
    await expect(restoration).resolves.toMatchObject({ status: "restored" });
    expect(harness.relocate).toHaveBeenCalledOnce();
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it.each(["stale", "layout-invalidated", "preference-changed"] as const)(
    "retries %s only after layout settles again",
    async (reason) => {
      const harness = createHarness();
      harness.settle();
      harness.relocate.mockImplementationOnce(async () => {
        harness.commitDirty();
        return reason === "stale"
          ? { ...harness.resolved, result: { outcome: "stale", reports: [], segment: null } }
          : {
              ...harness.resolved,
              outcome: "failed",
              failure: { code: "operation-cancelled", reason },
            };
      });
      const restoration = harness.runtime.restoreAnnotationTarget(position);
      await vi.waitFor(() => expect(harness.relocate).toHaveBeenCalledOnce());
      expect(harness.dispatch).not.toHaveBeenCalled();
      harness.settle();
      await expect(restoration).resolves.toMatchObject({ status: "restored" });
      expect(harness.relocate).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["page", "locator", "annotation"] as const)(
    "lets newer %s navigation supersede a dirty-document wait",
    async (navigation) => {
      const harness = createHarness();
      harness.commitDirty();
      const restoration = harness.runtime.restoreAnnotationTarget(position);
      // A page turn on a dirty document waits for the layout, but supersedes the restoration
      // at once.
      const advanced =
        navigation === "page" ? harness.runtime.advancePresentation("forward") : null;
      if (navigation === "locator") {
        await harness.runtime.relocate({
          kind: "point",
          occurrence,
          resource,
          evidence: [],
          observation: { layoutProgression: null, renderedTextProgression: null },
        });
      } else if (navigation === "annotation") {
        await harness.runtime.relocateAnnotationTarget("new target");
      }
      await expect(restoration).resolves.toEqual({ status: "cancelled", reason: "superseded" });
      harness.settle();
      if (advanced !== null) await advanced;
      expect(harness.relocate).toHaveBeenCalledTimes(navigation === "annotation" ? 1 : 0);
      expect(harness.dispatch).not.toHaveBeenCalled();
    },
  );

  it("only relocates the newer restoration when activations overlap", async () => {
    const harness = createHarness();
    harness.commitDirty();
    const first = harness.runtime.restoreAnnotationTarget(position);
    const second = harness.runtime.restoreAnnotationTarget({
      ...position,
      targetJson: '{"new":true}',
    });
    await expect(first).resolves.toEqual({ status: "cancelled", reason: "superseded" });
    harness.settle();
    await expect(second).resolves.toMatchObject({ status: "restored" });
    expect(harness.relocate).toHaveBeenCalledExactlyOnceWith(
      "relocate-annotation-target",
      '{"new":true}',
    );
  });

  it("does not retry if navigation supersedes the just-settled layout", async () => {
    const harness = createHarness();
    harness.settle();
    harness.relocate.mockImplementationOnce(async () => {
      harness.commitDirty();
      return { ...harness.resolved, result: { outcome: "stale", reports: [], segment: null } };
    });
    const restoration = harness.runtime.restoreAnnotationTarget(position);
    await vi.waitFor(() => expect(harness.relocate).toHaveBeenCalledOnce());
    harness.settle();
    await harness.runtime.advancePresentation("forward");
    await expect(restoration).resolves.toEqual({ status: "cancelled", reason: "superseded" });
    expect(harness.relocate).toHaveBeenCalledOnce();
  });

  it("bounds repeated stale results even when the layout remains settled", async () => {
    const harness = createHarness();
    harness.settle();
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    harness.relocate.mockImplementation(async () => {
      now += 50;
      return { ...harness.resolved, result: { outcome: "stale", reports: [], segment: null } };
    });
    try {
      await expect(
        harness.runtime.restoreAnnotationTarget(position, { timeoutMs: 100 }),
      ).resolves.toMatchObject({ status: "failed", reason: "timeout" });
      expect(harness.relocate).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("looks up occurrence hints by ordinal and waits for post-commit paginated layout", async () => {
    const harness = createHarness();
    const restoration = harness.runtime.restoreAnnotationTarget(position);

    expect(harness.dispatch).toHaveBeenCalledOnce();
    harness.commitDirty();
    await Promise.resolve();

    expect(harness.dispatch).toHaveBeenCalledOnce();
    expect(harness.relocate).not.toHaveBeenCalled();

    harness.settle();

    await expect(restoration).resolves.toMatchObject({
      status: "restored",
      occurrence,
      resource,
      relocation: { outcome: "resolved" },
    });
    expect(harness.relocate).toHaveBeenCalledOnce();
    expect(harness.dispatch).toHaveBeenCalledOnce();
  });

  it("preserves replacement cancellation while waiting for post-commit layout", async () => {
    const harness = createHarness();
    const restoration = harness.runtime.restoreAnnotationTarget(position);

    harness.commitDirty();
    await Promise.resolve();
    (
      harness.runtime as unknown as {
        _cancelRestore(reason: "replacement"): void;
      }
    )._cancelRestore("replacement");

    await expect(restoration).resolves.toEqual({ status: "cancelled", reason: "replacement" });
    expect(harness.relocate).not.toHaveBeenCalled();
    expect(harness.dispatch).toHaveBeenCalledOnce();
  });

  it("preserves the deadline while waiting for post-commit layout", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const restoration = harness.runtime.restoreAnnotationTarget(position, { timeoutMs: 100 });

      harness.commitDirty();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);

      await expect(restoration).resolves.toEqual({
        status: "failed",
        reason: "timeout",
        message: "annotation restoration timed out",
      });
      expect(harness.relocate).not.toHaveBeenCalled();
      expect(harness.dispatch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
