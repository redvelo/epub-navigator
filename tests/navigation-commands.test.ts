import { describe, expect, it, vi } from "vitest";
import type { KernelSnapshot, KernelTransition } from "../src/generated/kernel.js";
import type { PresentationAdvanceResult } from "../src/runtime/navigator/api.js";
import { NavigationCommandsRuntime } from "../src/runtime/navigation/commands.js";

type Layout = "settled" | "dirty" | "updating";
type Adapter = "reflowable-xhtml" | "fixed-xhtml";

function snapshot(options: {
  readonly primary: Layout;
  readonly companion: { readonly layout: Layout; readonly generation: number } | null;
  readonly pending?: boolean;
}): KernelSnapshot {
  return {
    document: {
      pending: options.pending === true ? {} : null,
      committed: { generation: 1, layout: { state: options.primary } },
      fixedCompanion:
        options.companion === null
          ? null
          : {
              frame: { generation: options.companion.generation },
              layout: { state: options.companion.layout },
            },
    },
  } as unknown as KernelSnapshot;
}

function frame(occurrence: number, adapter: Adapter, frameGeneration: number) {
  return { occurrence, adapter, frameGeneration, phase: "committed" as const };
}

function result(status: "advanced" | "boundary"): PresentationAdvanceResult {
  return {
    outcome: "completed",
    status: { status },
    operation: 1,
    generation: 1,
    occurrence: 0,
    resource: "EPUB/a.xhtml",
  };
}

function createHarness(options: {
  readonly primary: ReturnType<typeof frame>;
  readonly companion: ReturnType<typeof frame> | null;
  readonly snapshot: KernelSnapshot;
  readonly results: readonly PresentationAdvanceResult[];
  readonly onOperation?: (fields: { _companion: ReturnType<typeof frame> | null }) => void;
}) {
  let current = options.snapshot;
  const listeners = new Set<(next: KernelTransition) => void>();
  const targets: string[] = [];
  const queue = [...options.results];
  const fields = {
    _closed: false,
    _committed: options.primary,
    _companion: options.companion,
    _kernel: { snapshot: () => current },
    _noteForegroundActivity: vi.fn(),
    _cancelRestore: vi.fn(),
    _runPresentationOperation: vi.fn(async (request: { target: string }) => {
      targets.push(request.target);
      options.onOperation?.(runtime as unknown as { _companion: ReturnType<typeof frame> | null });
      return queue.shift() ?? result("boundary");
    }),
    subscribe: (listener: (next: KernelTransition) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const runtime = Object.assign(
    Object.create(NavigationCommandsRuntime.prototype),
    fields,
  ) as NavigationCommandsRuntime;
  return {
    runtime,
    targets,
    settle(next: KernelSnapshot) {
      current = next;
      const transition: KernelTransition = {
        accepted: true,
        stateRevision: 1,
        events: [],
        effects: [],
        failure: null,
      };
      for (const listener of [...listeners]) listener(transition);
    },
    listenerCount: () => listeners.size,
  };
}

const fixedPrimary = frame(11, "fixed-xhtml", 30);
const trailingReflowable = frame(12, "reflowable-xhtml", 31);
const leadingReflowable = frame(10, "reflowable-xhtml", 31);
const settledSpread = snapshot({
  primary: "settled",
  companion: { layout: "settled", generation: 31 },
});

describe("spread-aware presentation advance", () => {
  it("addresses only the primary without a companion", async () => {
    const harness = createHarness({
      primary: fixedPrimary,
      companion: null,
      snapshot: snapshot({ primary: "settled", companion: null }),
      results: [result("boundary")],
    });
    await expect(harness.runtime.advancePresentation("forward")).resolves.toMatchObject({
      status: { status: "boundary" },
    });
    expect(harness.targets).toEqual(["primary"]);
  });

  it("reads a trailing reflowable companion after the primary going forward and before it going back", async () => {
    const forward = createHarness({
      primary: fixedPrimary,
      companion: trailingReflowable,
      snapshot: settledSpread,
      results: [result("boundary"), result("advanced")],
    });
    await expect(forward.runtime.advancePresentation("forward")).resolves.toMatchObject({
      status: { status: "advanced" },
    });
    expect(forward.targets).toEqual(["primary", "fixed-companion"]);

    const backward = createHarness({
      primary: fixedPrimary,
      companion: trailingReflowable,
      snapshot: settledSpread,
      results: [result("boundary"), result("boundary")],
    });
    await expect(backward.runtime.advancePresentation("backward")).resolves.toMatchObject({
      status: { status: "boundary" },
    });
    expect(backward.targets).toEqual(["fixed-companion", "primary"]);
  });

  it("reads a leading reflowable companion first going forward", async () => {
    const harness = createHarness({
      primary: fixedPrimary,
      companion: leadingReflowable,
      snapshot: settledSpread,
      results: [result("boundary"), result("boundary")],
    });
    await harness.runtime.advancePresentation("forward");
    expect(harness.targets).toEqual(["fixed-companion", "primary"]);
  });

  it("stops at the first member that turns a page", async () => {
    const harness = createHarness({
      primary: fixedPrimary,
      companion: trailingReflowable,
      snapshot: settledSpread,
      results: [result("advanced")],
    });
    await harness.runtime.advancePresentation("forward");
    expect(harness.targets).toEqual(["primary"]);
  });

  it("never addresses a fixed companion or one still laying out", async () => {
    const fixedCompanion = createHarness({
      primary: fixedPrimary,
      companion: frame(12, "fixed-xhtml", 31),
      snapshot: settledSpread,
      results: [result("boundary")],
    });
    await fixedCompanion.runtime.advancePresentation("forward");
    expect(fixedCompanion.targets).toEqual(["primary"]);

    const updating = createHarness({
      primary: fixedPrimary,
      companion: trailingReflowable,
      snapshot: snapshot({ primary: "settled", companion: { layout: "updating", generation: 31 } }),
      results: [result("boundary")],
    });
    const advanced = updating.runtime.advancePresentation("forward");
    // The companion's layout never settles within the wait, so the turn reaches the primary only.
    await vi.waitFor(() => expect(updating.targets).toEqual(["primary"]), { timeout: 4_000 });
    await advanced;
  }, 10_000);

  it("waits for a relayout to settle before turning, and gives up after the wait", async () => {
    const harness = createHarness({
      primary: fixedPrimary,
      companion: trailingReflowable,
      snapshot: snapshot({ primary: "dirty", companion: { layout: "settled", generation: 31 } }),
      results: [result("boundary"), result("advanced")],
    });
    const advanced = harness.runtime.advancePresentation("forward");
    await Promise.resolve();
    expect(harness.targets).toEqual([]);
    expect(harness.listenerCount()).toBe(1);
    harness.settle(settledSpread);
    await expect(advanced).resolves.toMatchObject({ status: { status: "advanced" } });
    expect(harness.targets).toEqual(["primary", "fixed-companion"]);
    expect(harness.listenerCount()).toBe(0);
  });

  it("does not address a companion that left while the primary was answering", async () => {
    const harness = createHarness({
      primary: fixedPrimary,
      companion: trailingReflowable,
      snapshot: settledSpread,
      results: [result("boundary"), result("advanced")],
      onOperation: (fields) => {
        fields._companion = null;
      },
    });
    await expect(harness.runtime.advancePresentation("forward")).resolves.toMatchObject({
      status: { status: "boundary" },
    });
    expect(harness.targets).toEqual(["primary"]);
  });
});
