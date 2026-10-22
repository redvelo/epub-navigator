// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicationTheme } from "../src/generated/kernel.js";
import { buildAgentInitialize } from "../src/runtime/agent-protocol/index.js";
import {
  adjustCommittedDecorationRange,
  applyDecorationProjection,
  decorationApiAvailable,
  decorationMutationIsRuntimeOwned,
  decorationsAtPoint,
  decorationStyleAttribute,
  decorationStyleIsRuntimeOwned,
  reconcileDecorationProjection,
  setActiveDecoration,
  setDecorationPalette,
} from "../src/runtime/content-agent/decorations.js";
import { postReaderSerifFontEvidence } from "../src/runtime/content-agent/layout/font-evidence.js";
import {
  recordPaginationGeometryScan,
  recordTextAssessmentDiagnostics,
} from "../src/runtime/content-agent/layout/pagination-geometry.js";
import { settleLayoutEffects } from "../src/runtime/content-agent/layout/reflow-transaction.js";
import {
  layoutEffectSettlementTimedOut,
  mergeLayoutEffectSettlements,
  reconcileLayoutEffectSettlements,
  type LayoutEffectSettlement,
} from "../src/runtime/content-agent/layout-settlement.js";
import {
  findMediaOverlayEntry,
  mediaOverlayMutationIsRuntimeOwned,
  setMediaOverlayActive,
} from "../src/runtime/content-agent/media-overlays.js";
import {
  installNestedPublicationProjection,
  projectLocalEmbedUrl,
  validateNestedPublicationBaseUrl,
} from "../src/runtime/content-agent/nested-publication.js";
import {
  createOperationQueue,
  ensureActive,
  OperationCancelled,
} from "../src/runtime/content-agent/operation-queue.js";
import { activateFootnote } from "../src/runtime/content-agent/activation/controller.js";
import { tableScaleFloor } from "../src/runtime/content-agent/layout/fragmentation-repair.js";
import { installRequestDispatch } from "../src/runtime/content-agent/request-dispatch.js";
import { observeDocument } from "../src/runtime/content-agent/document-observation.js";
import {
  createContentAgentState,
  type ContentAgentState,
} from "../src/runtime/content-agent/state.js";

class TestHighlight extends Set<AbstractRange> {
  priority = 0;
  type: HighlightType = "highlight";

  constructor(...ranges: AbstractRange[]) {
    super(ranges);
  }
}

function installHighlights(): void {
  Object.defineProperty(window, "CSS", {
    configurable: true,
    value: { highlights: new Map<string, Highlight>() },
  });
  Object.defineProperty(window, "Highlight", {
    configurable: true,
    value: TestHighlight,
  });
}

function bodyRange(): Range {
  const range = document.createRange();
  range.selectNodeContents(document.body);
  return range;
}

function reportingState(fields: object = {}) {
  const postMessage = vi.fn();
  const state = {
    lifecycle: { diagnosticsEnabled: true, agentRole: "foreground" },
    transport: {
      reader: { postMessage },
      readerOrigin: "https://reader.example",
      protocolSession: "session",
    },
    ...fields,
  } as unknown as ContentAgentState;
  return { state, postMessage };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("content-agent initialization", () => {
  it("initializes without changing keyboard policy", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    const state = createContentAgentState();
    installRequestDispatch(state);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: buildAgentInitialize("0123456789abcdef0123456789abcdef", "fixed-svg"),
        origin: "https://reader.example",
        source: window,
      }),
    );

    expect(state.lifecycle.configuration.input.keyboardMode).toBe("off");
    vi.unstubAllGlobals();
  });
});

describe("content-agent operation queue", () => {
  it("serializes work and cancels an operation before it starts", async () => {
    const queue = createOperationQueue();
    const first = queue.begin("layout", 1)!;
    const second = queue.begin("layout", 2)!;
    const events: string[] = [];
    let releaseFirst = () => {};
    const finished = new Promise<void>((finish) => {
      queue.enqueue(async () => {
        events.push("first-started");
        await new Promise<void>((release) => (releaseFirst = release));
        queue.complete(first);
      });
      queue.enqueue(() => {
        expect(() => ensureActive(second)).toThrow(OperationCancelled);
        events.push("second-cancelled");
        queue.complete(second);
        finish();
      });
    });

    queue.cancel("layout", 2);
    await Promise.resolve();
    expect(events).toEqual(["first-started"]);
    releaseFirst();
    await finished;
    expect(events).toEqual(["first-started", "second-cancelled"]);
  });

  it("rejects active and recently completed duplicate operation keys", () => {
    const queue = createOperationQueue(1);
    const first = queue.begin("relocate", 3)!;
    expect(queue.begin("relocate", 3)).toBeNull();
    queue.complete(first);
    expect(queue.begin("relocate", 3)).toBeNull();

    queue.complete(queue.begin("relocate", 4)!);
    expect(queue.begin("relocate", 3)).not.toBeNull();
  });
});

describe("content-agent layout settlement", () => {
  const settlement = (
    value: LayoutEffectSettlement["requiredResources"],
  ): LayoutEffectSettlement => ({
    requiredFonts: value,
    requiredResources: value,
  });

  it("merges attempts by strength and reconciles retries while retaining failures", () => {
    expect(mergeLayoutEffectSettlements(settlement("loaded"), settlement("timed-out"))).toEqual(
      settlement("timed-out"),
    );
    expect(mergeLayoutEffectSettlements(settlement("timed-out"), settlement("failed"))).toEqual(
      settlement("failed"),
    );
    expect(reconcileLayoutEffectSettlements(settlement("timed-out"), settlement("loaded"))).toEqual(
      settlement("loaded"),
    );
    expect(reconcileLayoutEffectSettlements(settlement("failed"), settlement("loaded"))).toEqual(
      settlement("failed"),
    );
    expect(layoutEffectSettlementTimedOut(settlement("timed-out"))).toBe(true);
  });
});

describe("content-agent pagination diagnostics", () => {
  afterEach(() => {
    delete window.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__;
  });

  it("emits one counted content-end phase with a finite nonnegative duration", () => {
    const { state, postMessage } = reportingState();
    window.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__ = { enabled: true };

    recordPaginationGeometryScan(state, 7, performance.now());

    expect(postMessage).toHaveBeenCalledOnce();
    const [message] = postMessage.mock.calls[0]!;
    expect(message).toMatchObject({
      type: "pagination-diagnostic",
      phase: "content-end-scan",
      scanCount: 1,
      rectangleCount: 7,
    });
    expect(Number.isFinite(message.durationMs) && message.durationMs >= 0).toBe(true);
    expect(window.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__).toMatchObject({
      scanCount: 1,
      rectangleCount: 7,
      phases: [{ phase: "content-end-scan" }],
    });
  });

  it("emits bounded text-assessment and settlement phases", async () => {
    const settle = vi.fn(async () => ({
      requiredFonts: "loaded" as const,
      requiredResources: "loaded" as const,
    }));
    const { state, postMessage } = reportingState({
      layout: { layoutSettlement: { settleLayoutEffects: settle } },
    });

    recordTextAssessmentDiagnostics(
      state,
      {
        paragraphCount: 5,
        displayCandidateCount: 2,
        rectangleCount: 3,
        textRangeScanCount: 1,
      },
      performance.now(),
    );
    await settleLayoutEffects(state);

    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      expect.objectContaining({
        phase: "text-assessment",
        scanCount: 1,
        rectangleCount: 3,
      }),
      expect.objectContaining({
        phase: "settlement",
        scanCount: 0,
        rectangleCount: 0,
      }),
    ]);
  });
});

describe("content-agent font evidence", () => {
  afterEach(() => {
    Reflect.deleteProperty(document, "fonts");
  });

  it("computes and emits Reader Serif evidence against rendered prose", async () => {
    document.body.innerHTML = "<p id='prose'>Reading</p>";
    vi.spyOn(document.querySelector("#prose")!, "getClientRects").mockReturnValue([
      {} as DOMRect,
    ] as unknown as DOMRectList);
    const face = {
      family: '"Navigator Reader Serif"',
      status: "loaded",
    } as FontFace;
    const fonts = {
      [Symbol.iterator]: () => [face][Symbol.iterator](),
      load: vi.fn(async () => [face]),
      check: vi.fn(() => true),
    };
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      display: "block",
      visibility: "visible",
      fontFamily: '"Navigator Reader Serif", serif',
    } as CSSStyleDeclaration);
    const { state, postMessage } = reportingState({
      layout: { layoutToken: 3 },
    });

    await postReaderSerifFontEvidence(state, { typeface: "reader-serif" } as never, 3);

    expect(fonts.load).toHaveBeenCalledWith('400 16px "Navigator Reader Serif"', "Reading");
    expect(fonts.check).toHaveBeenCalledWith('400 16px "Navigator Reader Serif"', "Reading");
    expect(postMessage).toHaveBeenCalledWith(
      {
        namespace: "epub-navigator",
        session: "session",
        type: "font-evidence",
        target: "publication",
        family: "navigator-reader-serif",
        configured: true,
        declared: true,
        loaded: true,
        check: true,
      },
      "https://reader.example",
    );
  });

  it("emits false evidence when font inspection fails", async () => {
    document.body.textContent = "Reading";
    vi.spyOn(document.body, "getClientRects").mockReturnValue([
      {} as DOMRect,
    ] as unknown as DOMRectList);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      get: () => {
        throw new Error("font API unavailable");
      },
    });
    const { state, postMessage } = reportingState({
      layout: { layoutToken: 8 },
    });

    await postReaderSerifFontEvidence(state, { typeface: "reader-serif" } as never, 8);

    expect(postMessage.mock.calls[0]![0]).toMatchObject({
      type: "font-evidence",
      configured: false,
      declared: false,
      loaded: false,
      check: false,
    });
  });
});

describe("content-agent decorations", () => {
  const style = () => document.querySelector(`style[${decorationStyleAttribute}]`);

  beforeEach(() => {
    document.documentElement.innerHTML = "<head></head><body>decorated text</body>";
    installHighlights();
  });

  afterEach(() => {
    setDecorationPalette(document, "standard");
  });

  it("replaces only runtime-owned highlights and never exposes the host ID", () => {
    const hostHighlight = new TestHighlight();
    window.CSS.highlights.set("host-owned", hostHighlight as unknown as Highlight);

    expect(decorationApiAvailable(document)).toBe(true);
    applyDecorationProjection(document, [
      { id: "host-id", appearance: "annotation-highlight", range: bodyRange() },
    ]);

    const names = [...window.CSS.highlights.keys()].filter((name) => name !== "host-owned");
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain("host-id");
    expect(style()?.textContent).toContain(`::highlight(${names[0]})`);
    expect(style()?.getAttribute("data-epub-navigator-configuration")).toBe("decorations");

    applyDecorationProjection(document, [{ appearance: "annotation-note", range: bodyRange() }]);
    expect(window.CSS.highlights.has(names[0]!)).toBe(false);
    expect(window.CSS.highlights.get("host-owned")).toBe(hostHighlight);
    expect(style()?.textContent).toContain("background-color: rgb(190 85 70 / 24%)");
    expect(style()?.textContent).not.toContain("text-decoration");

    applyDecorationProjection(document, []);
    expect([...window.CSS.highlights.keys()]).toEqual(["host-owned"]);
    expect(style()).toBeNull();
  });

  it("moves either edge by exact word-like boundaries without mutating committed state", () => {
    document.body.textContent = "alpha beta gamma";
    const range = document.createRange();
    range.setStart(document.body.firstChild!, 6);
    range.setEnd(document.body.firstChild!, 10);
    applyDecorationProjection(
      document,
      [{ id: "annotation-1", appearance: "annotation-highlight", range }],
      7,
    );

    const adjusted = (edge: "start" | "end", movement: "backward" | "forward") => {
      const outcome = adjustCommittedDecorationRange(document, 7, "annotation-1", edge, movement);
      return outcome.status === "adjusted" ? outcome.range.toString() : outcome;
    };
    expect(adjusted("start", "backward")).toBe("alpha beta");
    expect(adjusted("end", "forward")).toBe("beta gamma");
    expect(range.toString()).toBe("beta");
    expect(document.getSelection()?.rangeCount).toBe(0);
  });

  it("normalizes element boundaries and returns explicit stale and unavailable outcomes", () => {
    document.body.innerHTML = "<span>alpha</span> beta";
    applyDecorationProjection(
      document,
      [
        {
          id: "annotation-1",
          appearance: "annotation-highlight",
          range: bodyRange(),
        },
      ],
      3,
    );

    expect(
      adjustCommittedDecorationRange(document, 2, "annotation-1", "start", "backward"),
    ).toEqual({ status: "stale" });
    expect(adjustCommittedDecorationRange(document, 3, "missing", "start", "backward")).toEqual({
      status: "unavailable",
    });
    const contracted = adjustCommittedDecorationRange(
      document,
      3,
      "annotation-1",
      "start",
      "forward",
    );
    expect(contracted.status === "adjusted" && contracted.range.toString()).toBe("beta");
  });

  it("does not change the committed projection when work is cancelled", async () => {
    applyDecorationProjection(document, [{ appearance: "search-result", range: bodyRange() }]);
    const names = [...window.CSS.highlights.keys()];

    await expect(
      reconcileDecorationProjection(document, 0, [], {
        signal: AbortSignal.abort(),
        maximumWorkUnits: 1,
        yieldEveryWorkUnits: 1,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect([...window.CSS.highlights.keys()]).toEqual(names);
  });

  it("uses exact node identity and detects publisher interference", async () => {
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    const owned = () =>
      records.splice(0).map((record) => decorationMutationIsRuntimeOwned(document, record));

    applyDecorationProjection(document, [
      { appearance: "annotation-highlight", range: bodyRange() },
    ]);
    await Promise.resolve();
    const projected = owned();
    expect(projected).not.toHaveLength(0);
    expect(projected).not.toContain(false);

    const authored = document.createElement("div");
    authored.setAttribute(decorationStyleAttribute, "");
    document.body.append(authored);
    authored.append("publisher text");
    await Promise.resolve();
    expect(owned()).toContain(false);

    const runtimeStyle = style();
    expect(decorationStyleIsRuntimeOwned(document, runtimeStyle)).toBe(true);
    runtimeStyle?.remove();
    await Promise.resolve();
    expect(owned()).toContain(false);
    expect(decorationStyleIsRuntimeOwned(document, runtimeStyle)).toBe(false);
    observer.disconnect();
  });

  it("carries one quiet tone and one strong tone on a monochrome display", () => {
    const declarationsFor = (name: string | undefined) =>
      style()
        ?.textContent?.split("\n")
        .find((rule) => rule.startsWith(`::highlight(${name})`))
        ?.replace(/^[^{]*/u, "");

    setDecorationPalette(document, "monochrome");
    applyDecorationProjection(
      document,
      [
        { id: "highlight", appearance: "annotation-highlight", range: bodyRange() },
        { id: "note", appearance: "annotation-note", range: bodyRange() },
        { id: "match", appearance: "search-result", range: bodyRange() },
        { id: "active", appearance: "active-search-result", range: bodyRange() },
      ],
      5,
    );

    const names = [...window.CSS.highlights.keys()];
    const quiet = names.slice(0, 3).map(declarationsFor);
    expect(new Set(quiet).size).toBe(1);
    expect(quiet[0]).toContain("light-dark(rgb(245 170 0 / 70%), rgb(245 170 0 / 30%))");
    expect(declarationsFor(names[3])).toContain(
      "light-dark(rgb(240 145 0 / 95%), rgb(255 170 30 / 50%))",
    );
    expect(style()?.textContent).not.toContain("text-decoration");

    // The one the reader is on carries the strong tone, whichever appearance it started as.
    expect(setActiveDecoration(document, 5, "highlight")).toBe(true);
    expect(style()?.textContent).toContain(
      "light-dark(rgb(240 145 0 / 95%), rgb(255 170 30 / 50%))",
    );

    // The palette follows the display, so a live projection restyles without being reprojected.
    setDecorationPalette(document, "standard");
    expect(declarationsFor(names[0])).toContain("rgb(255 214 10 / 45%)");
    expect(declarationsFor(names[1])).toContain("rgb(190 85 70 / 24%)");
  });

  it("hit-tests only private annotation ranges in reverse paint order", () => {
    const first = bodyRange();
    const second = bodyRange();
    const rect = new DOMRect(10, 20, 80, 16);
    Object.defineProperty(first, "getClientRects", { value: () => [rect] });
    Object.defineProperty(second, "getClientRects", { value: () => [rect] });

    applyDecorationProjection(
      document,
      [
        { id: "first", appearance: "annotation-highlight", range: first },
        { id: "search", appearance: "search-result", range: first },
        { id: "second", appearance: "annotation-note", range: second },
      ],
      7,
    );

    expect(decorationsAtPoint(document, 20, 25)).toMatchObject({
      ids: ["second", "first"],
      projectionRevision: 7,
    });
    expect(decorationsAtPoint(document, 2, 2)).toBeNull();
    expect(document.documentElement.innerHTML).not.toMatch(/first|second/u);
  });

  it("applies and clears selected appearance only for the exact revision", () => {
    applyDecorationProjection(
      document,
      [
        {
          id: "record",
          appearance: "annotation-highlight",
          range: bodyRange(),
        },
      ],
      3,
    );
    expect(setActiveDecoration(document, 2, "record")).toBe(false);
    expect(setActiveDecoration(document, 3, "record")).toBe(true);
    expect(style()?.textContent).toContain("rgb(255 164 0 / 70%)");
    expect(setActiveDecoration(document, 3, null)).toBe(true);
    expect(style()?.textContent).not.toContain("rgb(255 164 0 / 70%)");
  });
});

describe("content-agent media overlays", () => {
  const clear = {
    fragment: null,
    activeClasses: [],
    playbackActiveClasses: [],
  };
  const activate = (
    fragment: string,
    activeClasses: string[],
    playbackActiveClasses: string[] = [],
    theme: PublicationTheme = "original",
  ) => setMediaOverlayActive(document, { fragment, activeClasses, playbackActiveClasses }, theme);
  const classRecord = (target: Element, oldValue: string | null) =>
    ({
      type: "attributes",
      attributeName: "class",
      target,
      oldValue,
    }) as unknown as MutationRecord;
  const headRecord = (addedNodes: Node[], removedNodes: Node[]) =>
    ({
      type: "childList",
      target: document.head,
      addedNodes,
      removedNodes,
    }) as unknown as MutationRecord;
  const owned = (record: MutationRecord) => mediaOverlayMutationIsRuntimeOwned(document, record);
  const element = (id: string) => document.getElementById(id)!;

  function place(id: string, rect: Partial<DOMRect> | null, grownWidth?: number): void {
    const target = element(id);
    target.getClientRects = () =>
      (rect === null
        ? []
        : [
            {
              left: 0,
              top: 0,
              right: 10,
              bottom: 10,
              height: 10,
              ...rect,
              width:
                grownWidth !== undefined && target.classList.contains("grow")
                  ? grownWidth
                  : (rect.width ?? 10),
            },
          ]) as unknown as DOMRectList;
  }

  beforeEach(() => {
    document.documentElement.removeAttribute("class");
    document.documentElement.innerHTML =
      '<head></head><body><p id="s1" class="authored">One</p><p id="s2">Two</p><p id="s3">Three</p></body>';
    installHighlights();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });
    for (const id of ["s1", "s2", "s3"]) place(id, {});
  });

  afterEach(() => {
    setMediaOverlayActive(document, clear, "original");
  });

  it("applies authored classes and restores exactly the prior class state", () => {
    expect(activate("s1", ["authored", "-epub-media-overlay-active"], ["playing"])).toEqual({
      status: "applied",
      visible: true,
    });
    expect(element("s1").className).toBe("authored -epub-media-overlay-active");
    expect(document.documentElement.classList.contains("playing")).toBe(true);

    activate("s2", ["-epub-media-overlay-active"], ["playing"]);
    expect(element("s1").className).toBe("authored");
    expect(element("s2").className).toBe("-epub-media-overlay-active");

    expect(setMediaOverlayActive(document, clear, "original")).toEqual({
      status: "cleared",
      visible: false,
    });
    expect(element("s2").className).toBe("");
    expect(document.documentElement.classList.contains("playing")).toBe(false);
  });

  it("owns geometry-neutral class changes once per recorded transition, not publisher changes", () => {
    activate("s1", ["active"]);
    expect(owned(classRecord(element("s1"), "authored"))).toBe(true);
    expect(owned(classRecord(element("s1"), "authored"))).toBe(false);
    setMediaOverlayActive(document, clear, "original");
    expect(owned(classRecord(element("s1"), "authored active"))).toBe(true);
    element("s3").classList.add("publisher");
    expect(owned(classRecord(element("s3"), null))).toBe(false);
  });

  it.each([
    [40, false],
    [10.4, true],
  ])(
    "treats a class change that resizes the target to %spx as runtime-owned: %s",
    (width, expected) => {
      place("s2", {}, width);
      activate("s2", ["grow"]);
      expect(element("s2").className).toBe("grow");
      expect(owned(classRecord(element("s2"), null))).toBe(expected);
    },
  );

  it("falls back to a runtime-owned highlight without authored active classes", () => {
    expect(activate("s3", [])).toEqual({ status: "applied", visible: true });
    expect(window.CSS.highlights.size).toBe(1);
    const style = document.head.querySelector("style")!;
    expect(style.textContent).toContain("::highlight(");
    expect(owned(headRecord([style], []))).toBe(true);
    setMediaOverlayActive(document, clear, "original");
    expect(window.CSS.highlights.size).toBe(0);
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("paints a translucent reader highlight over authored active classes under a theme", () => {
    activate("s1", ["-epub-media-overlay-active", "2x"], [], "dark");
    const style = document.head.querySelector(
      'style[data-epub-navigator-configuration="media-overlays"]',
    )!;
    expect(style.textContent).toContain(
      ".-epub-media-overlay-active, .\\32 x { background-color: color-mix(in srgb, CanvasText 20%, transparent) !important; }",
    );
    expect(style.textContent).not.toContain("rgb(64 156 255");

    setMediaOverlayActive(document, clear, "original");
    const removal = headRecord([], [style]);
    expect(owned(removal)).toBe(true);
    expect(owned(removal)).toBe(false);
  });

  it("leaves the authored highlight alone in the original theme", () => {
    activate("s1", ["-epub-media-overlay-active", "2x"]);
    const style = document.head.querySelector(
      'style[data-epub-navigator-configuration="media-overlays"]',
    )!;
    expect(style.textContent).not.toContain("!important");
    expect(element("s1").className).toContain("-epub-media-overlay-active 2x");
  });

  it("reports missing fragments and off-screen targets", () => {
    expect(activate("absent", ["a"])).toEqual({
      status: "missing",
      visible: false,
    });
    place("s2", { left: 150, right: 160 });
    expect(activate("s2", ["a"])).toEqual({
      status: "applied",
      visible: false,
    });
  });

  it("selects the first visible entry, then the first following entry", () => {
    place("s1", { left: -60, right: -50 });
    expect(findMediaOverlayEntry(document, ["missing", "s1", "s2", "s3"])).toEqual({
      state: "found",
      index: 2,
    });
    place("s2", { left: 150, right: 160 });
    place("s3", { left: 250, right: 260 });
    expect(findMediaOverlayEntry(document, ["s1", "s2", "s3"])).toEqual({
      state: "found",
      index: 1,
    });
    place("s2", { left: -60, right: -50 });
    place("s3", null);
    expect(findMediaOverlayEntry(document, ["s1", "s2", "s3"])).toEqual({
      state: "none",
    });
  });
});

describe("content-agent nested publications", () => {
  const documentUrl = new URL("https://publication.example/EPUB/chapter.xhtml");
  const nestedBaseUrl = new URL("https://nested.example/");
  const bootstrap = (baseUrl: string | null) => {
    let script: HTMLScriptElement | null = null;
    if (baseUrl !== null) {
      script = document.createElement("script");
      script.setAttribute("data-epub-navigator-nested-publication-base-url", baseUrl);
      document.head.append(script);
    }
    Object.defineProperty(document, "currentScript", {
      configurable: true,
      value: script,
    });
  };

  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it("accepts only a distinct absolute HTTP(S) origin-root URL", () => {
    expect(validateNestedPublicationBaseUrl("https://nested.example", documentUrl)?.href).toBe(
      "https://nested.example/",
    );
    expect(validateNestedPublicationBaseUrl("http://localhost:8080/", documentUrl)?.href).toBe(
      "http://localhost:8080/",
    );
    expect(
      validateNestedPublicationBaseUrl(
        "https://nested.example/",
        new URL("https://nested.example/EPUB/nested.xhtml"),
      ),
    ).toBeNull();
    for (const value of [
      null,
      "",
      "/nested/",
      "ftp://nested.example/",
      "https://publication.example/",
      "https://nested.example/path/",
      "https://nested.example/?query",
      "https://nested.example/#hash",
      "https://user@nested.example/",
      "not a URL",
    ]) {
      expect(validateNestedPublicationBaseUrl(value, documentUrl), String(value)).toBeNull();
    }
  });

  it("preserves the resolved canonical path, query, and fragment", () => {
    const base = document.createElement("base");
    base.href = documentUrl.href;
    document.head.append(base);
    const iframe = document.createElement("iframe");
    iframe.setAttribute("src", "../notes/note.xhtml?mode=full#target");

    projectLocalEmbedUrl(iframe, documentUrl, nestedBaseUrl);

    expect(iframe.getAttribute("src")).toBe(
      "https://nested.example/notes/note.xhtml?mode=full#target",
    );
  });

  it("does not project empty, non-local, remote, or srcdoc frames", () => {
    for (const [src, srcdoc] of [
      ["", false],
      ["  ", false],
      ["about:blank", false],
      ["data:text/html,content", false],
      ["blob:https://publication.example/id", false],
      ["https://remote.example/frame.xhtml", false],
      ["child.xhtml", true],
    ] as const) {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("src", src);
      if (srcdoc) iframe.setAttribute("srcdoc", "<p>inline</p>");
      projectLocalEmbedUrl(iframe, documentUrl, nestedBaseUrl);
      expect(iframe.getAttribute("src")).toBe(src);
    }
  });

  it("projects object and embed elements only when they embed a document", () => {
    const base = document.createElement("base");
    base.href = documentUrl.href;
    document.head.append(base);
    for (const [markup, expected] of [
      [
        '<object data="figure.svg" type="image/svg+xml"></object>',
        "https://nested.example/EPUB/figure.svg",
      ],
      ['<object data="../notes/note.xhtml"></object>', "https://nested.example/notes/note.xhtml"],
      [
        '<object data="page.html" type="text/html; charset=utf-8"></object>',
        "https://nested.example/EPUB/page.html",
      ],
      ['<embed src="figure.svg"/>', "https://nested.example/EPUB/figure.svg"],
      ['<object data="figure.svg" type="image/png"></object>', "figure.svg"],
      ['<object data="photo.png"></object>', "photo.png"],
      ['<embed src="clip.mp4" type="video/mp4"/>', "clip.mp4"],
      [
        '<object data="https://remote.example/figure.svg"></object>',
        "https://remote.example/figure.svg",
      ],
    ] as const) {
      document.body.innerHTML = markup;
      const element = document.body.firstElementChild as HTMLObjectElement | HTMLEmbedElement;
      projectLocalEmbedUrl(element, documentUrl, nestedBaseUrl);
      const attribute = element instanceof HTMLObjectElement ? "data" : "src";
      expect(element.getAttribute(attribute), markup).toBe(expected);
    }
  });

  it("projects existing and parser-added embedding elements", async () => {
    document.body.innerHTML =
      '<iframe src="/EPUB/static.xhtml"></iframe><object data="/EPUB/figure.svg"></object>';
    bootstrap("https://nested.example/");

    const observer = installNestedPublicationProjection();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<section><iframe src="dynamic.xhtml?x=1#y"></iframe><embed src="late.svg"/></section>',
    );
    await Promise.resolve();

    expect(
      [...document.querySelectorAll("iframe, object, embed")].map((element) =>
        element.getAttribute(element instanceof HTMLObjectElement ? "data" : "src"),
      ),
    ).toEqual([
      "https://nested.example/EPUB/static.xhtml",
      "https://nested.example/EPUB/figure.svg",
      "https://nested.example/dynamic.xhtml?x=1#y",
      "https://nested.example/late.svg",
    ]);
    observer?.disconnect();
  });

  it("does nothing when bootstrap configuration is absent or invalid", () => {
    bootstrap(null);
    expect(installNestedPublicationProjection()).toBeNull();
    bootstrap("about:blank");
    expect(installNestedPublicationProjection()).toBeNull();
  });
});

describe("content-agent document observation", () => {
  it("reports what the first match of each query presents, inside same-origin frames too", () => {
    document.documentElement.setAttribute("lang", "en");
    document.title = "scr-support";
    document.body.innerHTML =
      '<p id="scripting_support" style="display:block">This reading system supports scripting.</p>' +
      '<img src="figure.png"/><iframe id="child"></iframe>';
    const frame = document.getElementById("child") as HTMLIFrameElement;
    frame.contentDocument!.body.innerHTML = '<p lang="fr">Nested</p>';

    const observed = observeDocument(document, {
      queries: [
        {
          id: "marker",
          selector: "#scripting_support",
          text: true,
          styles: ["display"],
          rect: true,
        },
        {
          id: "nested",
          selector: "p",
          within: ["#child"],
          text: true,
          attributes: ["lang", "dir"],
        },
        { id: "missing", selector: "#absent", text: true },
        { id: "no-frame", selector: "p", within: ["#absent"] },
        { id: "bad", selector: "p[", text: true },
      ],
      resources: true,
      fonts: true,
    });

    expect(observed.document).toMatchObject({
      title: "scr-support",
      lang: "en",
      svgRoot: false,
    });
    expect(observed.queries[0]).toEqual({
      id: "marker",
      matches: 1,
      first: {
        text: "This reading system supports scripting.",
        styles: { display: "block" },
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
    });
    expect(observed.queries[1]).toEqual({
      id: "nested",
      matches: 1,
      first: { text: "Nested", attributes: { lang: "fr", dir: null } },
    });
    expect(observed.queries[2]).toEqual({
      id: "missing",
      matches: 0,
      first: null,
    });
    expect(observed.queries[3]).toEqual({
      id: "no-frame",
      inaccessible: "no-frame",
    });
    expect(observed.queries[4]).toEqual({ id: "bad", matches: 0, first: null });
    expect(observed.resources).toEqual([
      {
        kind: "image",
        source: "figure.png",
        state: "pending",
        naturalWidth: 0,
        naturalHeight: 0,
      },
    ]);
    expect(observed.fonts).toEqual({ status: "loaded", loaded: [] });
    document.body.innerHTML = "";
  });

  it("advertises narration entry for every adapter that can carry an active class", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    const posted: unknown[] = [];
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation((message) => {
      posted.push(message);
    });
    const advertised = (
      adapter: "reflowable-xhtml" | "fixed-xhtml" | "fixed-svg" | "fixed-image",
    ) => {
      posted.length = 0;
      const state = createContentAgentState();
      installRequestDispatch(state);
      window.dispatchEvent(
        new MessageEvent("message", {
          data: buildAgentInitialize(
            "0123456789abcdef0123456789abcdef",
            adapter,
            undefined,
            false,
            "foreground",
            undefined,
          ),
          origin: "https://reader.example",
          source: window,
        }),
      );
      const ready = posted.find((message) => (message as { type?: string }).type === "ready") as {
        supportedOperations: string[];
      };
      return ready.supportedOperations.includes("find-media-overlay-entry");
    };
    // Anything with elements a class can be put on; an image page has none.
    expect(advertised("reflowable-xhtml")).toBe(true);
    expect(advertised("fixed-xhtml")).toBe(true);
    expect(advertised("fixed-svg")).toBe(true);
    expect(advertised("fixed-image")).toBe(false);
    postMessage.mockRestore();
    vi.unstubAllGlobals();
  });

  it("advertises the observation operation only when the reader enabled it", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    const posted: unknown[] = [];
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation((message) => {
      posted.push(message);
    });
    for (const observation of [false, true]) {
      posted.length = 0;
      const state = createContentAgentState();
      installRequestDispatch(state);
      window.dispatchEvent(
        new MessageEvent("message", {
          data: buildAgentInitialize(
            "0123456789abcdef0123456789abcdef",
            "reflowable-xhtml",
            undefined,
            false,
            "foreground",
            observation,
          ),
          origin: "https://reader.example",
          source: window,
        }),
      );
      const ready = posted.find((message) => (message as { type?: string }).type === "ready") as {
        supportedOperations: string[];
      };
      expect(ready.supportedOperations.includes("observe-document")).toBe(observation);
      expect(state.lifecycle.observationEnabled).toBe(observation);
    }
    postMessage.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("content-agent note references", () => {
  function noteState(notes: "navigate" | "show"): ContentAgentState {
    const state = createContentAgentState();
    state.lifecycle.configuration = {
      ...state.lifecycle.configuration,
      input: { ...state.lifecycle.configuration.input, notes },
    };
    return state;
  }

  function reference(markup: string): HTMLAnchorElement {
    document.body.innerHTML = `<p>Prose with ${markup} in it.</p>`;
    const anchor = document.querySelector("a");
    if (anchor === null) throw new Error("the fixture has no reference");
    return anchor;
  }

  function activate(state: ContentAgentState, anchor: HTMLAnchorElement) {
    return activateFootnote(
      state,
      anchor,
      new URL(anchor.getAttribute("href") ?? "", document.baseURI),
    );
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows a note another document holds behind a raised marker, in either wrapping", () => {
    for (const markup of [
      `<a href="notes.xhtml#n1"><sup>1</sup></a>`,
      `<sup><a href="notes.xhtml#n1">1</a></sup>`,
      `<a href="notes.xhtml#n1" style="vertical-align: super">1</a>`,
    ]) {
      const state = noteState("show");
      const activation = activate(state, reference(markup));
      expect(activation?.disposition).toBe("reported");
      expect(activation?.referenceLabel).toBe("1");
      expect(activation?.referenceRect).not.toBeNull();
    }
  });

  it("takes the page to that note instead when the reader has nowhere to show it", () => {
    const state = noteState("navigate");
    const activation = activate(state, reference(`<sup><a href="notes.xhtml#n1">1</a></sup>`));
    expect(activation?.disposition).toBe("navigated");
  });

  it("leaves an ordinary cross-reference to the browser", () => {
    for (const markup of [
      // A page cross-reference: a marker, but printed on the line.
      `<a href="chapter002.xhtml#page_99">99</a>`,
      // A raised marker that names no place in particular.
      `<sup><a href="chapter002.xhtml">1</a></sup>`,
      // A contents entry: raised, but worded rather than marked.
      `<sup><a href="chapter002.xhtml#start">Chapter Two</a></sup>`,
      // The marker at the head of a note, linking back to the text. A publication prints these
      // on the baseline exactly as it prints an unraised reference, so neither is taken.
      `<a href="chapter002.xhtml#ref">*</a>`,
    ]) {
      const state = noteState("show");
      expect(activate(state, reference(markup))).toBeNull();
    }
  });

  it("still shows a note the publication declared, however it printed the reference", () => {
    const state = noteState("show");
    const anchor = reference(`<a href="notes.xhtml#n1">see the note</a>`);
    anchor.setAttributeNS("http://www.idpf.org/2007/ops", "epub:type", "noteref");
    expect(activate(state, anchor)?.disposition).toBe("reported");
  });
});

describe("content-agent table scale floor", () => {
  it("allows down to the smallest size, and always at least one step", () => {
    const state = createContentAgentState();
    expect(tableScaleFloor(state, 100)).toBeCloseTo(0.8);
    expect(tableScaleFloor(state, 200)).toBeCloseTo(0.4);
    expect(tableScaleFloor(state, 90)).toBeCloseTo(80 / 90);
    expect(tableScaleFloor(state, 80)).toBeCloseTo(80 / 90);
  });
});

describe("deferred layout interactions", () => {
  it("replays a turn parked behind a layout and drops one that has gone stale", async () => {
    const {
      deferLayoutInteraction,
      replayDeferredLayoutInteraction,
      DEFERRED_INTERACTION_LIFETIME_MS,
    } = await import("../src/runtime/content-agent/layout/deferred-interaction.js");
    const state = createContentAgentState();
    const clock = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const replay = vi.fn();
    try {
      deferLayoutInteraction(state, replay);
      clock.mockReturnValue(10_000 + DEFERRED_INTERACTION_LIFETIME_MS);
      replayDeferredLayoutInteraction(state);
      expect(replay).toHaveBeenCalledOnce();
      expect(state.layout.deferredLayoutInteraction).toBeNull();

      clock.mockReturnValue(20_000);
      deferLayoutInteraction(state, replay);
      clock.mockReturnValue(20_001 + DEFERRED_INTERACTION_LIFETIME_MS);
      replayDeferredLayoutInteraction(state);
      expect(replay).toHaveBeenCalledOnce();
      expect(state.layout.deferredLayoutInteraction).toBeNull();

      replayDeferredLayoutInteraction(state);
      expect(replay).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });
});
