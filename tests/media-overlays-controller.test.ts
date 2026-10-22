import { describe, expect, it, vi } from "vitest";
import type {
  KernelTransition,
  NavigatorLocationSnapshot,
  ReadingOrderOccurrence,
} from "../src/generated/kernel.js";
import type {
  NavigatorMediaOverlayDescription,
  NavigatorMediaOverlaySegment,
  NavigatorMediaOverlayTimeline,
} from "../src/media-overlays.js";
import type { NavigatorInteraction } from "../src/runtime/navigator/api.js";
import type { PublicationMediaOverlayCapabilities } from "../src/runtime/media-overlays/capabilities.js";
import {
  createNavigatorMediaOverlayController,
  type NavigatorMediaOverlayAudio,
  type NavigatorMediaOverlayRuntime,
} from "../src/runtime/media-overlays/controller.js";

const mount = {
  baseUrl: "https://publication.test/",
  remoteResources: "blocked",
  contentOrigin: "isolated-publication-origin",
} as const;

function occurrence(ordinal: number, resource: string): ReadingOrderOccurrence {
  return {
    ordinal,
    target: { state: "declaration", declaration: ordinal, resource: ordinal },
    selectedDeclaration: ordinal,
    linear: "yes",
    presentation: {},
    document: { state: "loadable", resource, adapter: "reflowable-xhtml" },
  } as unknown as ReadingOrderOccurrence;
}

function segment(
  segmentIndex: number,
  resource: string,
  fragment: string,
  begin: number,
  end: number,
  types: string[] = [],
): NavigatorMediaOverlaySegment {
  return {
    segmentIndex,
    semanticPath: [
      { kind: "sequence", epubTypes: ["chapter"], textReference: null },
      ...(types.length > 0
        ? [{ kind: "sequence" as const, epubTypes: types, textReference: null }]
        : []),
    ],
    text: {
      reference: {
        state: "local-fragment",
        authoredHref: `${resource}#${fragment}`,
        canonicalPath: resource,
        query: null,
        fragment,
        fragmentExists: { state: "exists" },
      },
      availability: { state: "available" },
    },
    audio: {
      reference: {
        state: "local-resource",
        authoredHref: "audio.mp3",
        canonicalPath: "EPUB/audio.mp3",
        query: null,
      },
      availability: { state: "available" },
    },
    clipBegin: { state: "parsed", milliseconds: String(begin) },
    clipEnd: { state: "parsed", milliseconds: String(end) },
    playability: { state: "playable" },
  };
}

const fixtureResources = ["EPUB/one.xhtml", "EPUB/two.xhtml"];

function fixture(
  segments: NavigatorMediaOverlaySegment[],
  extra: Partial<NavigatorMediaOverlayTimeline> = {},
  separateOverlays = false,
) {
  const inResource = (item: NavigatorMediaOverlaySegment, resource: string) =>
    item.text.reference.state === "local-fragment" &&
    item.text.reference.canonicalPath === resource;
  const groups = separateOverlays
    ? fixtureResources.map((resource) => segments.filter((item) => inResource(item, resource)))
    : [segments];
  const timelines = groups.map(
    (items, overlayIndex): NavigatorMediaOverlayTimeline => ({
      overlayIndex,
      canonicalPath: overlayIndex === 0 ? "EPUB/overlay.smil" : `EPUB/overlay-${overlayIndex}.smil`,
      declarations: [],
      skippable: ["pagebreak"],
      escapable: ["table"],
      segmentCount: items.length,
      playableSegmentCount: items.length,
      availability: { state: "available" },
      segments: items,
      ...extra,
    }),
  );
  const timeline = timelines[0]!;
  const summaries = timelines.map(({ segments: _segments, ...summary }) => summary);
  const overlayFor = (resource: string) =>
    separateOverlays ? fixtureResources.indexOf(resource) : 0;
  const entries = (resource: string) =>
    (timelines[overlayFor(resource)]?.segments ?? [])
      .filter((item) => inResource(item, resource))
      .map((item) => item.segmentIndex);
  const association = (occurrenceIndex: number, resource: string) => ({
    occurrenceIndex,
    effectiveLinear: "yes" as const,
    content: {
      state: "resolved" as const,
      declaration: {
        declarationIndex: 0,
        authoredId: { state: "missing" as const },
        authoredHref: null,
        canonicalPath: resource,
        mediaType: null,
      },
      canonicalPath: resource,
      bytes: { state: "present" as const },
    },
    overlay: {
      state: "resolved" as const,
      declaration: {
        declarationIndex: 0,
        authoredId: { state: "missing" as const },
        authoredHref: null,
        canonicalPath: timelines[overlayFor(resource)]?.canonicalPath ?? "EPUB/overlay.smil",
        mediaType: null,
      },
      overlayIndex: overlayFor(resource),
    },
    entrySegmentIndexes: entries(resource),
  });
  const description: NavigatorMediaOverlayDescription = {
    package: {
      state: "available",
      declared: true,
      declarations: [
        {
          declarationIndex: 0,
          authoredId: { state: "missing" },
          authoredHref: null,
          canonicalPath: null,
          mediaType: null,
        },
      ],
      metadata: {
        totalDurations: [],
        itemDurations: [],
        narrators: [],
        activeClasses: ["active"],
        playbackActiveClasses: [],
      },
    },
    coverage: {
      state: "complete",
      packageRelationships: null,
      smilExtraction: [],
      smilRelationships: [],
      fragmentObservations: [],
      mediaInspection: [],
    },
    playback: {
      state: "available",
      overlays: summaries,
      associations: [association(0, "EPUB/one.xhtml"), association(1, "EPUB/two.xhtml")].filter(
        (item) => item.entrySegmentIndexes.length > 0,
      ),
    },
  };
  return { timeline, timelines, description };
}

class FakeAudio implements NavigatorMediaOverlayAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  preservesPitch = false;
  paused = true;
  ended = false;
  error: { code: number } | null = null;
  readonly listeners = new Map<string, Set<() => void>>();
  play = vi.fn(async () => {
    if (this.paused) this.emitLater("play");
    this.paused = false;
  });
  pause = vi.fn(() => {
    if (!this.paused) this.emitLater("pause");
    this.paused = true;
  });
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  emitLater(type: string) {
    setTimeout(() => this.emit(type), 0);
  }
  load = vi.fn();
  removeAttribute = vi.fn(() => {
    this.src = "";
  });
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  advanceTo(seconds: number) {
    this.currentTime = seconds;
    for (const listener of this.listeners.get("timeupdate") ?? []) listener();
  }
}

function harness(
  segments: NavigatorMediaOverlaySegment[],
  extra: Partial<NavigatorMediaOverlayTimeline> = {},
  separateOverlays = false,
) {
  const { timelines, description } = fixture(segments, extra, separateOverlays);
  const audio = new FakeAudio();
  let primary = 0;
  const locationListeners = new Set<(snapshot: NavigatorLocationSnapshot) => void>();
  const transitionListeners = new Set<(transition: KernelTransition) => void>();
  const interactionListeners = new Set<(interaction: NavigatorInteraction) => void>();
  const presentationListeners = new Set<() => void>();
  const runtime = {
    open: vi.fn((target: number) => {
      primary = target;
      const transition = {
        accepted: true,
        stateRevision: 1,
        events: [{ type: "document-committed", generation: 1, occurrence: target, resource: "" }],
        effects: [],
        failure: null,
      } as KernelTransition;
      return transition;
    }),
    relocate: vi.fn(async () => ({ outcome: "completed" }) as never),
    visibleOccurrenceRange: () => ({
      primaryOccurrence: primary,
      firstOccurrence: primary,
      lastOccurrence: primary,
      companion: null,
    }),
    subscribe: (listener: (transition: KernelTransition) => void) => {
      transitionListeners.add(listener);
      return () => transitionListeners.delete(listener);
    },
    subscribeLocations: (listener: (snapshot: NavigatorLocationSnapshot) => void) => {
      locationListeners.add(listener);
      return () => locationListeners.delete(listener);
    },
    subscribeInteractions: (listener: () => void) => {
      interactionListeners.add(listener);
      return () => interactionListeners.delete(listener);
    },
    subscribePresentationActivity: (listener: () => void) => {
      presentationListeners.add(listener);
      return () => presentationListeners.delete(listener);
    },
    setMediaOverlayActive: vi.fn(async (target: { occurrence: number } | null) =>
      target === null
        ? { status: "cleared" as const }
        : { status: "applied" as const, visible: true, occurrence: target.occurrence },
    ),
    findMediaOverlayEntry: vi.fn(async () => ({ status: "found" as const, index: 0 })),
  };
  const abort = new AbortController();
  const capabilities: PublicationMediaOverlayCapabilities = {
    availability: {
      status: "available",
      playableOccurrenceIndexes:
        description.playback.state === "available"
          ? description.playback.associations.map((item) => item.occurrenceIndex)
          : [],
      unavailableOccurrenceCount: 0,
    },
    signal: abort.signal,
    description: vi.fn(async () => ({ status: "ok" as const, description })),
    timeline: vi.fn(async (overlayIndex: number) => ({
      status: "ok" as const,
      result: { state: "available" as const, timeline: timelines[overlayIndex]! },
    })),
    close: vi.fn(),
  };
  const controller = createNavigatorMediaOverlayController({
    runtime: runtime as unknown as NavigatorMediaOverlayRuntime,
    capabilities,
    mount,
    readingOrder: [
      occurrence(0, "EPUB/one.xhtml"),
      occurrence(1, "EPUB/two.xhtml"),
      occurrence(2, "EPUB/three.xhtml"),
    ],
    createAudio: () => audio,
  });
  const moveTo = (target: number) => {
    primary = target;
    for (const listener of locationListeners) {
      listener({
        revision: 1,
        location: null,
        basis: null,
        visibleOccurrences: runtime.visibleOccurrenceRange(),
      });
    }
  };
  return {
    controller,
    runtime,
    audio,
    abort,
    capabilities,
    moveTo,
    interact: (command = "next") =>
      interactionListeners.forEach((listener) =>
        listener({ command, source: "keyboard" } as unknown as NavigatorInteraction),
      ),
    turnPage: () => presentationListeners.forEach((listener) => listener()),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("media overlay playback controller", () => {
  it("starts from the rendered entry, schedules contiguous clips, and applies authored classes", async () => {
    const { controller, runtime, audio } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/one.xhtml", "b", 1000, 2000),
      segment(2, "EPUB/one.xhtml", "c", 2000, 3000),
    ]);
    runtime.findMediaOverlayEntry.mockResolvedValueOnce({ status: "found", index: 1 });
    expect(controller.snapshot()).toMatchObject({ state: "idle", playableHere: true });

    await controller.play();
    expect(runtime.findMediaOverlayEntry).toHaveBeenCalledWith(0, ["a", "b", "c"]);
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 1 });
    expect(audio.src).toBe("https://publication.test/EPUB/audio.mp3");
    expect(audio.currentTime).toBe(1);
    expect(audio.preservesPitch).toBe(true);
    expect(runtime.setMediaOverlayActive).toHaveBeenLastCalledWith({
      occurrence: 0,
      fragment: "b",
      activeClasses: ["active"],
      playbackActiveClasses: [],
    });

    audio.advanceTo(2.01);
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 2 });
    expect(audio.currentTime).toBe(2.01);
    expect(audio.pause).not.toHaveBeenCalled();
  });

  it("follows hidden targets without treating the relocation as reader navigation", async () => {
    const { controller, runtime } = harness([segment(0, "EPUB/one.xhtml", "a", 0, 1000)]);
    runtime.setMediaOverlayActive.mockResolvedValueOnce({
      status: "applied",
      visible: false,
      occurrence: 0,
    });
    await controller.play();
    expect(runtime.relocate).toHaveBeenCalledWith(
      expect.objectContaining({ occurrence: 0, evidence: [{ kind: "html-fragment", value: "a" }] }),
    );
    expect(controller.snapshot().state).toBe("playing");
  });

  it("continues into the next narrated occurrence and ends after the last one", async () => {
    const { controller, runtime, audio } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/two.xhtml", "b", 1000, 2000),
    ]);
    await controller.play();
    audio.advanceTo(1);
    await flush();
    expect(runtime.open).toHaveBeenCalledWith(1);
    expect(controller.snapshot()).toMatchObject({
      state: "playing",
      occurrence: 1,
      segmentIndex: 1,
    });
    audio.advanceTo(2);
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "ended", occurrence: null });
    expect(runtime.setMediaOverlayActive).toHaveBeenLastCalledWith(null);
  });

  it("steps back into the previous document within one timeline", async () => {
    const { controller, runtime, audio } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/two.xhtml", "b", 1000, 2000),
    ]);
    await controller.play();
    audio.advanceTo(1);
    await flush();
    expect(controller.snapshot()).toMatchObject({ occurrence: 1, segmentIndex: 1 });
    await controller.previousSegment();
    expect(runtime.open).toHaveBeenLastCalledWith(0);
    expect(controller.snapshot()).toMatchObject({
      state: "playing",
      occurrence: 0,
      segmentIndex: 0,
    });
    expect(audio.currentTime).toBe(0);
  });

  it("steps back into the previous narrated section's last playable segment", async () => {
    const { controller, runtime, audio, moveTo } = harness(
      [
        segment(0, "EPUB/one.xhtml", "a", 0, 1000),
        segment(1, "EPUB/one.xhtml", "b", 1000, 2000),
        segment(2, "EPUB/one.xhtml", "page", 2000, 2100, ["pagebreak"]),
        segment(0, "EPUB/two.xhtml", "c", 0, 1000),
      ],
      {},
      true,
    );
    controller.setSkippedTypes(["pagebreak"]);
    moveTo(1);
    await controller.play();
    expect(controller.snapshot()).toMatchObject({
      occurrence: 1,
      overlayIndex: 1,
      segmentIndex: 0,
    });
    await controller.previousSegment();
    expect(runtime.open).toHaveBeenLastCalledWith(0);
    expect(controller.snapshot()).toMatchObject({
      state: "playing",
      occurrence: 0,
      overlayIndex: 0,
      segmentIndex: 1,
    });
    expect(audio.currentTime).toBe(1);
  });

  it("restarts the first segment when no earlier narrated section exists", async () => {
    const { controller, audio } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/one.xhtml", "b", 1000, 2000),
    ]);
    await controller.play();
    audio.currentTime = 0.5;
    await controller.previousSegment();
    expect(controller.snapshot()).toMatchObject({
      state: "playing",
      occurrence: 0,
      segmentIndex: 0,
    });
    expect(audio.currentTime).toBe(0);
  });

  it("pauses on a page turn and resumes the same segment", async () => {
    const { controller, interact, turnPage } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/two.xhtml", "b", 1000, 2000),
    ]);
    await controller.play();
    interact();
    expect(controller.snapshot().state).toBe("paused");
    await controller.play();
    turnPage();
    expect(controller.snapshot().state).toBe("paused");
    await controller.play();
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 0 });
  });

  it("starts narration from a standstill on the command that asks for it", async () => {
    const { controller, interact } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/one.xhtml", "b", 1000, 2000),
    ]);
    expect(controller.snapshot()).toMatchObject({ state: "idle", playableHere: true });

    // Both run from the one keypress: the reader acts on the command, and the controller sees
    // the same interaction straight after. `play` reaches its loading state synchronously, so
    // treating the narration command as reader movement pauses what the keypress just started.
    const started = controller.play();
    interact("narration");
    await started;
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 0 });
  });

  it("narrates where navigation lands instead of stopping at the section left behind", async () => {
    const { controller, audio, moveTo } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/two.xhtml", "b", 1000, 2000),
    ]);
    await controller.play();
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 0 });

    moveTo(1);
    await flush();
    expect(controller.snapshot()).toMatchObject({
      state: "playing",
      occurrence: 1,
      segmentIndex: 1,
    });
    expect(audio.currentTime).toBe(1);
  });

  it("stops with a reason when navigation lands where nothing is narrated", async () => {
    const { controller, moveTo } = harness([segment(0, "EPUB/one.xhtml", "a", 0, 1000)]);
    await controller.play();
    moveTo(2);
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "idle", reason: "no-narration-here" });
  });

  it("starts from the rendered page when the paused segment was paged away", async () => {
    const { controller, runtime, audio, turnPage } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/one.xhtml", "b", 1000, 2000),
      segment(2, "EPUB/one.xhtml", "c", 2000, 3000),
    ]);
    await controller.play();
    audio.advanceTo(0.5);
    turnPage();
    expect(controller.snapshot()).toMatchObject({ state: "paused", segmentIndex: 0 });
    runtime.setMediaOverlayActive.mockResolvedValueOnce({
      status: "applied",
      visible: false,
      occurrence: 0,
    });
    runtime.findMediaOverlayEntry.mockResolvedValueOnce({ status: "found", index: 2 });
    await controller.play();
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 2 });
    expect(audio.currentTime).toBe(2);
    expect(runtime.relocate).not.toHaveBeenCalled();
  });

  it("follows pauses and resumes made outside the controller", async () => {
    const { controller, audio } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/two.xhtml", "b", 0, 1000),
    ]);
    await controller.play();
    audio.advanceTo(0.4);
    audio.paused = true;
    audio.emit("pause");
    expect(controller.snapshot()).toMatchObject({ state: "paused", segmentIndex: 0 });
    audio.paused = false;
    audio.emit("play");
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 0 });
    expect(audio.currentTime).toBe(0.4);

    audio.advanceTo(1);
    await flush();
    await flush();
    expect(controller.snapshot()).toMatchObject({
      state: "playing",
      occurrence: 1,
      segmentIndex: 1,
    });

    audio.paused = true;
    audio.ended = true;
    audio.emit("pause");
    expect(controller.snapshot().state).toBe("playing");
  });

  it("skips user-selected skippable structures and escapes escapable containers", async () => {
    const { controller, audio } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/one.xhtml", "page", 1000, 1100, ["pagebreak"]),
      segment(2, "EPUB/one.xhtml", "cell1", 1100, 2000, ["table"]),
      segment(3, "EPUB/one.xhtml", "cell2", 2000, 3000, ["table"]),
      segment(4, "EPUB/one.xhtml", "after", 3000, 4000),
    ]);
    controller.setSkippedTypes(["pagebreak"]);
    await controller.play();
    audio.advanceTo(1);
    await flush();
    expect(controller.snapshot()).toMatchObject({ segmentIndex: 2, escapable: true });
    await controller.escape();
    expect(controller.snapshot()).toMatchObject({
      state: "playing",
      segmentIndex: 4,
      escapable: false,
    });
    expect(audio.currentTime).toBe(3);
  });

  it("applies pitch-preserving rate changes to active audio", async () => {
    const { controller, audio } = harness([segment(0, "EPUB/one.xhtml", "a", 0, 1000)]);
    await controller.play();
    controller.setRate("1.5");
    expect(audio.playbackRate).toBe(1.5);
    expect(controller.snapshot().rate).toBe("1.5");
    expect(() => controller.setRate("1.1" as never)).toThrow(RangeError);
  });

  it("stops with an explicit reason when continuation cannot be mapped", async () => {
    const { controller, audio } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/elsewhere.xhtml", "b", 1000, 2000),
    ]);
    await controller.play();
    audio.advanceTo(1);
    await flush();
    expect(controller.snapshot()).toMatchObject({
      state: "ended",
      reason: "ambiguous-continuation",
    });
  });

  it.each([
    ["audio-failed", new Error("decode")],
    ["audio-unsupported", new DOMException("no supported source", "NotSupportedError")],
  ])("reports a rejected play as %s, releases the source, and retries", async (reason, cause) => {
    const { controller, audio } = harness([segment(0, "EPUB/one.xhtml", "a", 0, 1000)]);
    audio.play.mockRejectedValueOnce(cause);
    await controller.play();
    expect(controller.snapshot()).toMatchObject({ state: "failed", reason });
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalled();
    await controller.play();
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 0 });
    expect(audio.src).toBe("https://publication.test/EPUB/audio.mp3");
  });

  it("reports a media error event as an unsupported format", async () => {
    const { controller, audio } = harness([segment(0, "EPUB/one.xhtml", "a", 0, 1000)]);
    await controller.play();
    audio.error = { code: 4 };
    audio.emit("error");
    expect(controller.snapshot()).toMatchObject({ state: "failed", reason: "audio-unsupported" });
    expect(audio.load).toHaveBeenCalled();
  });

  it("reports host revocation as unavailable", async () => {
    const { controller, audio, abort } = harness([segment(0, "EPUB/one.xhtml", "a", 0, 1000)]);
    await controller.play();
    abort.abort();
    expect(controller.snapshot()).toMatchObject({
      state: "unavailable",
      reason: "session-replaced",
      playableHere: false,
    });
    expect(audio.pause).toHaveBeenCalled();
  });

  it("reports section narration time from clip clocks and audio position", async () => {
    const { controller, audio } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/one.xhtml", "b", 1000, 3000),
    ]);
    expect(controller.timing()).toBeNull();
    await controller.play();
    audio.currentTime = 0.4;
    expect(controller.timing()).toEqual({ elapsedMs: 400, totalMs: 3000 });
    audio.advanceTo(1.5);
    await flush();
    expect(controller.timing()).toEqual({ elapsedMs: 1500, totalMs: 3000 });
    controller.stop();
    expect(controller.timing()).toEqual({ elapsedMs: 1500, totalMs: 3000 });
    await controller.play();
    audio.currentTime = 0.2;
    expect(controller.timing()).toEqual({ elapsedMs: 200, totalMs: 3000 });
  });

  it("resumes inside the current clip without seeking back", async () => {
    const { controller, audio } = harness([segment(0, "EPUB/one.xhtml", "a", 0, 1000)]);
    await controller.play();
    audio.advanceTo(0.6);
    controller.pause();
    await controller.play();
    expect(controller.snapshot().state).toBe("playing");
    expect(audio.currentTime).toBe(0.6);
  });

  it("pauses before seeking across a gap between clips", async () => {
    const { controller, audio } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/one.xhtml", "b", 3000, 4000),
    ]);
    await controller.play();
    const pausedAt: number[] = [];
    audio.pause.mockImplementation(() => {
      pausedAt.push(audio.currentTime);
      audio.paused = true;
    });
    audio.advanceTo(1.1);
    await flush();
    expect(pausedAt).toEqual([1.1]);
    expect(audio.currentTime).toBe(3);
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 1 });
  });

  it("ends a clip on time without waiting for timeupdate", async () => {
    vi.useFakeTimers();
    const { controller, audio } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
      segment(1, "EPUB/one.xhtml", "b", 1000, 2000),
    ]);
    try {
      await controller.play();
      audio.currentTime = 1;
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 1 });
    controller.close();
  });

  it("starts an absent clipBegin at the resource start and runs an absent clipEnd to its end", async () => {
    const { controller, audio } = harness([
      { ...segment(0, "EPUB/one.xhtml", "a", 0, 1000), clipBegin: { state: "absent" } },
      { ...segment(1, "EPUB/one.xhtml", "b", 1000, 2000), clipEnd: { state: "absent" } },
    ]);
    await controller.play();
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 0 });
    expect(audio.currentTime).toBe(0);

    audio.advanceTo(1.01);
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 1 });

    audio.advanceTo(30);
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "playing", segmentIndex: 1 });

    audio.emit("ended");
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "ended", occurrence: null });
  });

  it("does not start where no narration is associated", async () => {
    const { controller, moveTo, capabilities } = harness([
      segment(0, "EPUB/one.xhtml", "a", 0, 1000),
    ]);
    moveTo(2);
    expect(controller.snapshot().playableHere).toBe(false);
    await controller.play();
    expect(controller.snapshot()).toMatchObject({ state: "idle", reason: "no-narration-here" });
    expect(capabilities.description).not.toHaveBeenCalled();
  });
});
