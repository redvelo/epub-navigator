// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { KernelSnapshot, NavigatorLocation } from "../src/generated/kernel.js";
import { createContentAgentState } from "../src/runtime/content-agent/state.js";
import { installRollController } from "../src/runtime/content-agent/roll.js";
import {
  rollAnchor,
  rollBoxes,
  rollPreviewWindow,
  rollReachableSpan,
  rollWindow,
  ROLL_PREVIEW_BUDGET,
  ROLL_WINDOW_BUDGET,
} from "../src/runtime/fixed-layout/roll-geometry.js";
import { rollKernel } from "../src/runtime/fixed-layout/roll-kernel.js";
import { boundedRollTarget, rollIdentity } from "../src/runtime/fixed-layout/roll-protocol.js";
import {
  parseRollTarget,
  qualifyRollEvidence,
  rollEvidencePosition,
  rollExtensions,
  rollProgressionsAgree,
  ROLL_OCCURRENCE,
  ROLL_X,
  ROLL_Y,
  ROLL_ZOOM,
} from "../src/runtime/fixed-layout/roll-target.js";
import type { NavigatorKernelAccess } from "../src/runtime/kernel.js";
import { sameDurablePoint } from "../src/runtime/selection/location-equivalence.js";

const { resolveTarget } = vi.hoisted(() => ({ resolveTarget: vi.fn() }));
vi.mock("../src/runtime/content-agent/targets/resolver/annotation.js", async (original) => ({
  ...(await original<object>()),
  resolveAnnotationTargetInDocument: resolveTarget,
}));

describe("fixed roll geometry", () => {
  const pages = Array.from({ length: 100 }, (_, occurrence) => ({
    occurrence,
    ratio: occurrence % 2 === 0 ? 0.5 : 2,
  }));
  const boxes = rollBoxes(pages, 640);
  const occurrences = (mounted: readonly { occurrence: number }[]) =>
    mounted.map((box) => box.occurrence);
  const subpixel = rollBoxes(
    Array.from({ length: 10_000 }, (_, occurrence) => ({ occurrence, ratio: 0.0001 })),
    320,
  );
  const short = rollBoxes(
    [
      { occurrence: 0, ratio: 2 },
      { occurrence: 1, ratio: 0.1 },
    ],
    640,
  );

  it("stacks unequal authored aspect ratios without reader gaps", () => {
    expect(boxes.slice(0, 3)).toEqual([
      { occurrence: 0, top: 0, height: 320 },
      { occurrence: 1, top: 320, height: 1280 },
      { occurrence: 2, top: 1600, height: 320 },
    ]);
    for (let i = 1; i < boxes.length; i++)
      expect(boxes[i]!.top).toBe(boxes[i - 1]!.top + boxes[i - 1]!.height);
  });

  it("mounts viewport-local pages led by cheap stand-in images", () => {
    expect(occurrences(rollWindow(boxes, 4000, 480))).toEqual([5, 6]);
    expect(occurrences(rollWindow(boxes, 0, 480))).toEqual([0, 1]);
    expect(occurrences(rollPreviewWindow(boxes, 4000, 480))).toEqual([3, 4, 5, 6, 7]);
    expect(occurrences(rollPreviewWindow(boxes, 0, 480))).toEqual([0, 1]);
  });

  it("bounds mounted pages and stand-ins for thousands of subpixel pages", () => {
    expect(rollWindow(subpixel, 0, 900)).toHaveLength(ROLL_WINDOW_BUDGET);
    expect(rollPreviewWindow(subpixel, 0, 900)).toHaveLength(ROLL_PREVIEW_BUDGET);
  });

  it("bounds a page's span by what the scroller can reach", () => {
    expect(rollReachableSpan(short, short[0]!, 900)).toEqual({ start: 0, end: 444 });
    expect(rollReachableSpan(short, short[1]!, 900)).toEqual({ start: 444, end: 444 });
  });

  it("treats a bottomed-out scroller as the end of the last page", () => {
    const last = boxes.at(-1)!;
    expect(rollAnchor(boxes, last.top + last.height - 480, 480)).toEqual({
      occurrence: last.occurrence,
      fraction: 1,
    });
    expect(rollAnchor(short, 444, 900)).toEqual({ occurrence: 1, fraction: 1 });
  });

  it("keeps the same authored point on zoom and late measurement", () => {
    const anchor = rollAnchor(boxes, 960)!;
    expect(anchor).toEqual({ occurrence: 1, fraction: 0.5 });
    const box = rollBoxes(pages, 1280)[anchor.occurrence]!;
    expect(box.top + box.height * anchor.fraction).toBe(1920);
    expect(rollAnchor([], 0)).toBeNull();
  });
});

describe("fixed roll protocol", () => {
  it("bounds target payloads before decoding and rejects cyclic, deep, or oversized work", () => {
    expect(
      boundedRollTarget({
        locator: { kind: "point", evidence: [{ kind: "html-fragment", value: "probe" }] },
      }),
    ).toBe(true);
    let deep: unknown = null;
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const cycle: Record<string, unknown> = {};
    cycle.child = cycle;
    for (const value of [
      { value: "x".repeat(65_537) },
      Array.from({ length: 4097 }, () => 1),
      deep,
      cycle,
    ])
      expect(boundedRollTarget(value)).toBe(false);
    for (const value of [0, -1, Infinity, NaN, "1", 1.5]) expect(rollIdentity(value)).toBe(false);
  });

  it("namespaces retained and replacement child generations and rejects foreign identities", () => {
    const dispatch = vi.fn(() => ({
      accepted: true,
      failure: null,
      stateRevision: 1,
      effects: [],
      events: [],
    }));
    const raw = {
      stateRevision: 1,
      snapshot: () => ({ document: { committed: { generation: 1 } } }) as KernelSnapshot,
      dispatch,
      projectAnnotationTarget: vi.fn(),
      close: vi.fn(),
    } satisfies NavigatorKernelAccess;
    const first = rollKernel(raw);
    const second = rollKernel(raw);
    const firstId = first.snapshot().document.committed!.generation;
    expect(second.snapshot().document.committed!.generation).not.toBe(firstId);
    expect(first.snapshot().document.committed!.generation).toBe(firstId);
    first.dispatch({ type: "frame", frame: { type: "loaded", generation: firstId } });
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "frame",
      frame: { type: "loaded", generation: 1 },
    });
    second.dispatch({ type: "frame", frame: { type: "loaded", generation: firstId } });
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "frame",
      frame: { type: "loaded", generation: Number.MAX_SAFE_INTEGER },
    });
  });
});

describe("fixed roll target extensions", () => {
  it("allows only machine round-off in the legacy native sidecar", () => {
    expect(rollProgressionsAgree(0.22313801721743962, 0.2231380172174396)).toBe(true);
    for (const [left, right] of [
      [0.22313801721743962, 0.223138017218],
      [0.2, 0.9],
      [Infinity, Infinity],
      [-1, -1],
    ] as const)
      expect(rollProgressionsAgree(left, right)).toBe(false);
  });

  it("preserves the source, selectors, and unrelated extension data", () => {
    const target = {
      type: "SpecificResource",
      source: "plates/A.svg",
      selector: { type: "CssSelector", value: "#real-authored-id" },
      "urn:example:note": "kept",
      ...rollExtensions({ x: 0.25, y: 0.4, zoom: 2, occurrence: 3 }),
    };
    expect(parseRollTarget(JSON.stringify(target))).toEqual({
      target,
      position: { x: 0.25, y: 0.4, zoom: 2, occurrence: 3 },
    });
    expect(parseRollTarget('{"source":"page.xhtml"}').position).toBeNull();
  });

  it("rejects invalid bounds, partial/conflicting data, and duplicate root members", () => {
    for (const fields of [
      { [ROLL_Y]: -0.1 },
      { [ROLL_Y]: 1.1 },
      { [ROLL_Y]: "0.5" },
      { [ROLL_X]: 0.2 },
      { [ROLL_Y]: 0.2, [ROLL_ZOOM]: 5 },
      { [ROLL_Y]: 0.2, [ROLL_OCCURRENCE]: 1.5 },
      { [ROLL_Y]: 0.2, [ROLL_X]: 2 },
    ])
      expect(() => parseRollTarget(JSON.stringify({ source: "page.xhtml", ...fields }))).toThrow();
    for (const json of [
      `{"source":"a","source":"b","${ROLL_Y}":0.2}`,
      `{"source":"a","${ROLL_Y}":0.2,"urn:epub-navigator:roll-progre\\u0073sion":0.3}`,
      JSON.stringify({ source: "x".repeat(65_536) }),
    ])
      expect(() => parseRollTarget(json)).toThrow();
  });

  it("qualifies durable point evidence without inventing a standard selector", () => {
    const point = (y: number) =>
      ({
        kind: "point",
        occurrence: 2,
        resource: "EPUB/page.xhtml",
        evidence: qualifyRollEvidence([{ kind: "document-boundary", boundary: "start" }], {
          y,
          x: 0,
          zoom: 1,
          occurrence: 2,
        }),
        observation: { layoutProgression: y, renderedTextProgression: null },
      }) satisfies Extract<NavigatorLocation, { kind: "point" }>;
    const basis = { documentGeneration: 1, frameGeneration: 1, layoutGeneration: 1 };
    expect(sameDurablePoint(point(0.2), basis, point(0.2), basis)).toBe(true);
    expect(sameDurablePoint(point(0.2), basis, point(0.4), basis)).toBe(false);
    expect(rollEvidencePosition(point(0.2).evidence)).toMatchObject({ y: 0.2, occurrence: 2 });
  });
});

describe("fixed roll content agent", () => {
  it("runs one resolver with one latest queued target and aborts on supersession, cancel, and pagehide", async () => {
    const state = createContentAgentState();
    state.lifecycle.initialized = true;
    state.lifecycle.documentAdapter = "fixed-xhtml";
    state.transport.reader = window;
    state.transport.readerOrigin = location.origin;
    state.transport.protocolSession = "roll-agent-test";
    const signals: AbortSignal[] = [];
    const releases: (() => void)[] = [];
    resolveTarget.mockImplementation(
      (_document: Document, _plan: unknown, work: { signal: AbortSignal }) => {
        signals.push(work.signal);
        return new Promise((resolve) => releases.push(() => resolve({ range: null })));
      },
    );
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    installRollController(state);
    const send = (value: object) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: location.origin,
          data: {
            namespace: "epub-navigator-roll",
            session: "roll-agent-test",
            layoutGeneration: 7,
            ...value,
          },
        }),
      );
    const target = (operation: number) =>
      send({
        type: "target",
        operation,
        plan: {
          resource: "page.xhtml",
          selectors: [{ kind: "css", path: [0], values: { value: "p" }, refinements: [] }],
        },
      });
    send({ type: "enable" });
    target(1);
    target(2);
    target(3);
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(signals[0]!.aborted).toBe(true);
    releases[0]!();
    await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalledTimes(2));
    expect(signals[1]!.aborted).toBe(false);
    send({ type: "cancel", operation: 3 });
    expect(signals[1]!.aborted).toBe(true);
    releases[1]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    target(4);
    await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalledTimes(3));
    window.dispatchEvent(new Event("pagehide"));
    expect(signals[2]!.aborted).toBe(true);
    releases[2]!();
    post.mockRestore();
  });
});
