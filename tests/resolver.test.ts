// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePointAtElementStartInDocument,
  relocateLocatorInDocument,
  resolveLocatorInDocument,
  resolvePointEvidenceBatchInDocument,
  resolvePointEvidenceBatchCooperativelyInDocument,
} from "../src/runtime/content-agent/targets/resolver/locator.js";
import {
  captureNativeSelectionInDocument,
  createDocumentTextSnapshot,
  documentTextIndexBuildCount,
  documentTextSnapshotIsCurrent,
  invalidateDocumentTextIndex,
} from "../src/runtime/content-agent/targets/resolver/text-index.js";
import {
  observeDocument,
  observeDocumentWithRanges,
} from "../src/runtime/content-agent/targets/resolver/observation.js";
import {
  type AnnotationSelectorNode,
  physicalPageForRange,
  ResolverWorkLimitExceeded,
} from "../src/runtime/content-agent/targets/resolver/types.js";
import {
  findTextQuoteMatches,
  normalizeHtmlWhitespace,
  resolveAnnotationTargetInDocument,
} from "../src/runtime/content-agent/targets/resolver/annotation.js";
import { createUniqueTextContext } from "../src/runtime/content-agent/targets/resolver/viewport.js";

const emptyRect = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 } as DOMRect;

const nativeSelection = (
  range: Range,
  anchorNode = range.startContainer,
  anchorOffset = range.startOffset,
  focusNode = range.endContainer,
  focusOffset = range.endOffset,
): Selection =>
  ({
    rangeCount: 1,
    getRangeAt: () => range,
    anchorNode,
    anchorOffset,
    focusNode,
    focusOffset,
  }) as unknown as Selection;

const installRenderedRangeGeometry = (onRead?: () => void) => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => {
      onRead?.();
      return [
        {
          x: 10,
          y: 20,
          top: 20,
          right: 40,
          bottom: 35,
          left: 10,
          width: 30,
          height: 15,
        },
      ];
    },
  });
};

const installBoxlessRangeGeometry = () => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => emptyRect },
  });
};

const stubCaret = (caret: (x: number, y: number) => { offsetNode: Node; offset: number }) =>
  Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: caret });

const scrollingViewport = (scroll: PropertyDescriptorMap) => {
  Object.defineProperties(window, {
    innerHeight: { configurable: true, value: 600 },
    innerWidth: { configurable: true, value: 800 },
  });
  Object.defineProperties(document.documentElement, scroll);
  Object.defineProperty(document, "scrollingElement", {
    configurable: true,
    value: document.documentElement,
  });
};

afterEach(() => {
  Reflect.deleteProperty(document, "caretPositionFromPoint");
  document.body.removeAttribute("style");
});

const selector = (
  path: number[],
  kind: AnnotationSelectorNode["kind"],
  values: AnnotationSelectorNode["values"],
  refinements: AnnotationSelectorNode[] = [],
): AnnotationSelectorNode => ({ path, kind, values, refinements }) as AnnotationSelectorNode;

const annotationWork = (signal = new AbortController().signal, maximumWorkUnits = 100_000) => ({
  signal,
  maximumWorkUnits,
  yieldEveryWorkUnits: 64,
});

describe("rendered text matching", () => {
  it("keeps the final text boundary inside authored block scopes", () => {
    document.body.innerHTML = '<p id="first">Same sentence.</p><p id="second">Same sentence.</p>';
    invalidateDocumentTextIndex(document);
    const map = createDocumentTextSnapshot(document).index;
    for (const element of document.querySelectorAll("p")) {
      const span = map.spans.get(element);
      expect(span).toBeDefined();
      expect(map.text.slice(span!.start, span!.end)).toBe("Same sentence.");
    }
  });

  it("normalizes only runs of HTML whitespace", () => {
    expect(normalizeHtmlWhitespace("one\n \t two\u00a0three")).toBe("one two\u00a0three");
  });

  it("uses context and preserves repeated matches as ambiguity", () => {
    const text = "before target after; before target after";
    expect(findTextQuoteMatches(text, "target", "before ", " after")).toEqual([
      { start: 7, end: 13 },
      { start: 28, end: 34 },
    ]);
    expect(findTextQuoteMatches(text, "target", "; before ", " after")).toEqual([
      { start: 28, end: 34 },
    ]);
  });

  it("expands point context only until it is unique and gives up at the internal cap", () => {
    const first = `A${"x".repeat(40)}|${"y".repeat(40)}`;
    const second = `B${"x".repeat(40)}|${"y".repeat(40)}`;
    const context = createUniqueTextContext(`${first} ${second}`, first.indexOf("|"));
    expect(context).not.toBeNull();
    expect(context?.before.startsWith("A")).toBe(true);

    const repeated = `${"x".repeat(300)}|${"y".repeat(300)}`;
    expect(createUniqueTextContext(`${repeated} ${repeated}`, repeated.indexOf("|"))).toBeNull();
  });
});

describe("annotation points", () => {
  it("projects collapsed document and CSS-refined TextPosition selectors as a point", async () => {
    document.body.innerHTML = '<p id="chapter">A😀BC</p>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      {
        selectors: [
          selector([0], "css", { value: "#chapter" }, [
            selector([0, 0], "text-position", { start: "2", end: "2" }),
          ]),
          selector([1], "text-position", { start: "2", end: "2" }),
        ],
      },
      annotationWork(),
    );

    expect(result.outcome).toBe("resolved");
    expect(result.segmentKind).toBe("point");
    expect(result.range?.collapsed).toBe(true);
  });
});

describe("document text index", () => {
  it("captures a resolvable point at a connected element start", () => {
    document.body.innerHTML = '<p>Before <a id="note-ref" href="#note">😀note</a> after</p>';
    const anchor = document.querySelector("a")!;

    const evidence = capturePointAtElementStartInDocument(document, anchor);

    expect(evidence).not.toBeNull();
    expect(
      resolveLocatorInDocument(document, { kind: "point", evidence: evidence! }).status,
    ).toEqual({ status: "resolved" });
    anchor.remove();
    expect(capturePointAtElementStartInDocument(document, anchor)).toBeNull();
  });

  it("resolves browser text positions as Unicode code-point offsets", () => {
    document.body.innerHTML = "<p>A😀BC</p>";
    const text = document.querySelector("p")?.firstChild;

    const point = resolveLocatorInDocument(document, {
      kind: "point",
      evidence: [{ kind: "browser-text-position", offset: "2" }],
    });
    const range = resolveLocatorInDocument(document, {
      kind: "range",
      evidence: [{ kind: "browser-text-position", start: "1", end: "3" }],
    });

    expect(point.status).toEqual({ status: "resolved" });
    expect(point.range).toMatchObject({ startContainer: text, startOffset: 3, endOffset: 3 });
    expect(range.status).toEqual({ status: "resolved" });
    expect(range.range?.toString()).toBe("😀B");
    expect(range.range).toMatchObject({ startOffset: 1, endOffset: 4 });
  });

  it("rejects malformed positions and does not match valid out-of-range u64 positions", () => {
    document.body.innerHTML = "<p>short</p>";

    expect(
      resolveLocatorInDocument(document, {
        kind: "point",
        evidence: [{ kind: "browser-text-position", offset: "01" }],
      }).status.status,
    ).toBe("failed");
    expect(
      resolveLocatorInDocument(document, {
        kind: "point",
        evidence: [{ kind: "browser-text-position", offset: "18446744073709551616" }],
      }).status.status,
    ).toBe("failed");
    expect(
      resolveLocatorInDocument(document, {
        kind: "point",
        evidence: [{ kind: "browser-text-position", offset: "18446744073709551615" }],
      }).status.status,
    ).toBe("not-found");
  });

  it("builds at most one rendered-text index for a point-evidence batch", () => {
    document.body.innerHTML = '<p id="target">alpha unique target omega</p>';
    invalidateDocumentTextIndex(document);
    const before = documentTextIndexBuildCount(document);

    const resolutions = resolvePointEvidenceBatchInDocument(document, [
      [{ kind: "html-fragment", value: "target" }],
      [{ kind: "rendered-text-context", before: "alpha ", after: "unique" }],
      [{ kind: "rendered-text-context", before: "target ", after: "omega" }],
    ]);

    expect(resolutions.map(({ status }) => status.status)).toEqual([
      "resolved",
      "resolved",
      "resolved",
    ]);
    expect(documentTextIndexBuildCount(document) - before).toBe(1);
  });

  it("resolves fragment evidence without building rendered text", () => {
    document.body.innerHTML = '<p id="first">First</p><p id="second">Second</p>';
    invalidateDocumentTextIndex(document);
    const before = documentTextIndexBuildCount(document);

    expect(
      resolveLocatorInDocument(document, {
        kind: "point",
        evidence: [{ kind: "html-fragment", value: "first" }],
      }).status,
    ).toEqual({ status: "resolved" });
    const resolutions = resolvePointEvidenceBatchInDocument(document, [
      [{ kind: "html-fragment", value: "first" }],
      [{ kind: "html-fragment", value: "second" }],
      [{ kind: "document-boundary", boundary: "start" }],
    ]);

    expect(resolutions.map(({ status }) => status.status)).toEqual([
      "resolved",
      "resolved",
      "resolved",
    ]);
    expect(documentTextIndexBuildCount(document)).toBe(before);
  });

  it("reuses one rendered-text snapshot across target batches", () => {
    document.body.innerHTML = "<p>alpha beta gamma delta</p>";
    invalidateDocumentTextIndex(document);
    const before = documentTextIndexBuildCount(document);
    const snapshot = createDocumentTextSnapshot(document);

    resolvePointEvidenceBatchInDocument(
      document,
      [[{ kind: "rendered-text-context", before: "alpha ", after: "beta" }]],
      snapshot,
    );
    resolvePointEvidenceBatchInDocument(
      document,
      [[{ kind: "rendered-text-context", before: "gamma ", after: "delta" }]],
      snapshot,
    );

    expect(documentTextIndexBuildCount(document) - before).toBe(1);
    expect(documentTextSnapshotIsCurrent(snapshot)).toBe(true);
    invalidateDocumentTextIndex(document);
    expect(documentTextSnapshotIsCurrent(snapshot)).toBe(false);
  });

  it("cancels cooperative rendered-text resolution without changing authored DOM", async () => {
    document.body.innerHTML = `<p>${"alpha beta ".repeat(2_000)}</p>`;
    invalidateDocumentTextIndex(document);
    const authored = document.body.innerHTML;
    const controller = new AbortController();
    const operation = resolvePointEvidenceBatchCooperativelyInDocument(
      document,
      [[{ kind: "rendered-text-context", before: "alpha ", after: "beta" }]],
      undefined,
      { signal: controller.signal, maximumWorkUnits: 1_000_000, yieldEveryWorkUnits: 64 },
    );
    setTimeout(() => controller.abort(), 0);

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(document.body.innerHTML).toBe(authored);
  });

  it("enforces one aggregate cooperative resolver work limit", async () => {
    document.body.innerHTML = `<p>${"target ".repeat(100)}</p>`;
    invalidateDocumentTextIndex(document);

    await expect(
      resolvePointEvidenceBatchCooperativelyInDocument(
        document,
        [[{ kind: "rendered-text-context", before: "target", after: " " }]],
        undefined,
        { signal: new AbortController().signal, maximumWorkUnits: 10, yieldEveryWorkUnits: 5 },
      ),
    ).rejects.toBeInstanceOf(ResolverWorkLimitExceeded);
  });

  it("resolves rendered-text TOC evidence within the cooperative work budget", async () => {
    document.body.innerHTML = "<p>alpha unique omega</p>";
    invalidateDocumentTextIndex(document);
    const result = await resolvePointEvidenceBatchCooperativelyInDocument(
      document,
      [[{ kind: "rendered-text-context", before: "alpha ", after: "unique" }]],
      undefined,
      {
        signal: new AbortController().signal,
        maximumWorkUnits: 10_000,
        yieldEveryWorkUnits: 64,
      },
    );

    expect(result.resolutions.map(({ status }) => status.status)).toEqual(["resolved"]);
    expect(result.snapshot).toBeDefined();
  });

  it("uses fresh default snapshots and permits explicit snapshot reuse", () => {
    document.body.innerHTML = "<p>alpha beta gamma</p>";
    invalidateDocumentTextIndex(document);
    const before = documentTextIndexBuildCount(document);

    observeDocument(document);
    observeDocument(document);
    expect(documentTextIndexBuildCount(document) - before).toBe(2);

    const snapshot = createDocumentTextSnapshot(document);
    const locator = {
      kind: "point" as const,
      evidence: [{ kind: "rendered-text-context" as const, before: "alpha ", after: "beta" }],
    };
    resolveLocatorInDocument(document, locator, snapshot);
    resolveLocatorInDocument(document, locator, snapshot);
    expect(documentTextIndexBuildCount(document) - before).toBe(3);

    document.body.firstElementChild?.append(" delta");
    invalidateDocumentTextIndex(document);
    observeDocument(document);
    expect(documentTextIndexBuildCount(document) - before).toBe(4);
  });

  it("adds Unicode code-point evidence to visible boundaries", () => {
    document.body.innerHTML = "<p>A😀BC</p>";
    const text = document.querySelector("p")!.firstChild!;
    stubCaret(() => ({ offsetNode: text, offset: 3 }));

    const observation = observeDocument(document);

    expect(observation.visibleStart).toMatchObject({
      state: "located",
      evidence: expect.arrayContaining([{ kind: "browser-text-position", offset: "2" }]),
    });
  });

  it("uses document boundaries for visible image-only content", () => {
    document.body.innerHTML = '<img src="cover.jpg" alt="Cover">';
    invalidateDocumentTextIndex(document);
    const image = document.querySelector("img")!;
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 600,
      height: 800,
      top: 0,
      right: 600,
      bottom: 800,
      left: 0,
      toJSON: () => ({}),
    });

    const observation = observeDocument(document);

    expect(observation.visibleStart).toEqual({
      state: "located",
      evidence: [{ kind: "document-boundary", boundary: "start" }],
    });
    expect(observation.visibleEnd).toEqual({
      state: "located",
      evidence: [{ kind: "document-boundary", boundary: "end" }],
    });
    expect(observation.renderedTextProgression).toBeNull();
  });

  it("does not invent a location for an empty document", () => {
    document.body.replaceChildren();
    invalidateDocumentTextIndex(document);

    const observation = observeDocument(document);

    expect(observation.visibleStart).toEqual({ state: "unavailable" });
    expect(observation.visibleEnd).toEqual({ state: "unavailable" });
  });

  it("retains live visible ranges without requiring a second text snapshot", () => {
    document.body.innerHTML = '<p><span id="page-1">alpha</span> beta</p>';
    const text = document.querySelector("span")!.firstChild!;
    stubCaret(() => ({ offsetNode: text, offset: 2 }));
    const before = documentTextIndexBuildCount(document);

    const capture = observeDocumentWithRanges(document);
    expect(capture.visibleStartRange).toMatchObject({
      startContainer: text,
      startOffset: 2,
      collapsed: true,
    });
    expect(documentTextIndexBuildCount(document) - before).toBe(1);

    const repeated = observeDocumentWithRanges(document, undefined, {
      textSnapshot: capture.textSnapshot,
      includeRenderedTextContext: false,
    });
    expect(repeated.observation.visibleStart).toEqual({
      state: "located",
      evidence: [{ kind: "browser-text-position", offset: "2" }],
    });
    expect(documentTextIndexBuildCount(document) - before).toBe(1);

    const [fragment] = resolvePointEvidenceBatchInDocument(document, [
      [{ kind: "html-fragment", value: "page-1" }],
    ]);
    expect(fragment?.status.status).toBe("resolved");
    expect(documentTextIndexBuildCount(document) - before).toBe(1);

    invalidateDocumentTextIndex(document);
    observeDocumentWithRanges(document, undefined, { textSnapshot: capture.textSnapshot });
    expect(documentTextIndexBuildCount(document) - before).toBe(2);
  });

  it("probes settled pagination column centers instead of the spread gutter", () => {
    document.body.innerHTML = "<p>alpha beta</p>";
    const text = document.querySelector("p")!.firstChild!;
    const points: Array<{ x: number; y: number }> = [];
    stubCaret((x: number, y: number) => {
      points.push({ x, y });
      return { offsetNode: text, offset: 0 };
    });

    observeDocument(document, { logicalInlineStart: 120, logicalInlineEnd: 360 });

    expect(points).toEqual([
      { x: 120, y: 0 },
      { x: 360, y: window.innerHeight - 1 },
    ]);

    points.length = 0;
    document.body.style.direction = "rtl";
    observeDocument(document, { logicalInlineStart: 120, logicalInlineEnd: 360 });
    expect(points).toEqual([
      { x: window.innerWidth - 120, y: 0 },
      { x: window.innerWidth - 360, y: window.innerHeight - 1 },
    ]);

    points.length = 0;
    document.body.style.direction = "ltr";
    document.body.style.writingMode = "vertical-rl";
    observeDocument(document, { logicalInlineStart: 120, logicalInlineEnd: 360 });
    expect(points).toEqual([
      { x: window.innerWidth - 1, y: 120 },
      { x: 0, y: 360 },
    ]);
  });

  it("continues inward past caret boundaries without exact location evidence", () => {
    document.body.innerHTML = "<header><img alt=''></header><p>alpha beta</p>";
    const header = document.querySelector("header")!;
    const text = document.querySelector("p")!.firstChild!;
    stubCaret((_x: number, y: number) =>
      y === 0 ? { offsetNode: header, offset: 1 } : { offsetNode: text, offset: 2 },
    );

    const observation = observeDocument(document, {
      logicalInlineStart: 120,
      logicalInlineEnd: 360,
    });

    expect(observation.visibleStart).toMatchObject({
      state: "located",
      evidence: expect.arrayContaining([{ kind: "browser-text-position", offset: "2" }]),
    });
  });

  it("observes CSSOM visibility changes without explicit invalidation", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = '<p class="target">alpha visible omega</p>';
    const locator = {
      kind: "point" as const,
      evidence: [{ kind: "rendered-text-context" as const, before: "alpha ", after: "visible" }],
    };
    expect(resolveLocatorInDocument(document, locator).status.status).toBe("resolved");

    const style = document.createElement("style");
    document.head.append(style);
    style.sheet?.insertRule(".target { display: none; }");

    expect(resolveLocatorInDocument(document, locator).status.status).toBe("not-found");
  });
});

describe("native selection capture", () => {
  it("reads a selection against an offered current snapshot and builds none of its own", () => {
    document.body.innerHTML = "<p>alpha beta gamma delta</p>";
    installRenderedRangeGeometry();
    invalidateDocumentTextIndex(document);
    const snapshot = createDocumentTextSnapshot(document);
    const before = documentTextIndexBuildCount(document);
    const text = document.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const capture = captureNativeSelectionInDocument(
      document,
      nativeSelection(range),
      undefined,
      snapshot,
    );
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") return;
    expect(capture.textSnapshot).toBe(snapshot);
    expect(documentTextIndexBuildCount(document)).toBe(before);
    invalidateDocumentTextIndex(document);
    const fresh = captureNativeSelectionInDocument(
      document,
      nativeSelection(range),
      undefined,
      snapshot,
    );
    expect(fresh.status).toBe("captured");
    if (fresh.status !== "captured") return;
    expect(fresh.textSnapshot).not.toBe(snapshot);
    expect(documentTextIndexBuildCount(document) - before).toBe(1);
  });

  it("captures a cross-node Unicode selection and roundtrips its primary evidence", () => {
    document.body.innerHTML = '<p>A😀<em style="display: inline">BC</em>D</p>';
    installRenderedRangeGeometry();
    const first = document.querySelector("p")?.firstChild as Text;
    const second = document.querySelector("em")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(first, 1);
    range.setEnd(second, 1);

    const capture = captureNativeSelectionInDocument(document, nativeSelection(range));

    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") return;
    expect(capture.selection.direction).toBe("forward");
    expect(capture.selection.evidence[0]).toEqual({
      kind: "browser-text-position",
      start: "1",
      end: "3",
    });
    expect(capture.selection.evidence).toContainEqual(
      expect.objectContaining({ kind: "rendered-text-quote", exact: "😀B" }),
    );
    expect(capture.selection.anchor.rect).toEqual({ x: 10, y: 20, width: 30, height: 15 });

    const roundtrip = resolveLocatorInDocument(document, {
      kind: "range",
      evidence: [capture.selection.evidence[0]!],
    });
    expect(roundtrip.status).toEqual({ status: "resolved" });
    expect(roundtrip.range?.toString()).toBe("😀B");
  });

  it("preserves backward direction from anchor and focus ordering", () => {
    document.body.innerHTML = "<p>alpha beta</p>";
    installRenderedRangeGeometry();
    const text = document.querySelector("p")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);

    const capture = captureNativeSelectionInDocument(
      document,
      nativeSelection(range, text, 5, text, 0),
    );

    expect(capture.status).toBe("captured");
    if (capture.status === "captured") expect(capture.selection.direction).toBe("backward");
  });

  it("reports the authored language of the selection start", () => {
    document.documentElement.setAttribute("lang", "en");
    document.body.innerHTML =
      '<p>He said <q xml:lang="ignored" lang="fr-FR">bonjour</q> and <span lang=" ">left</span></p>';
    document
      .querySelector("q")
      ?.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:lang", "fr");
    installRenderedRangeGeometry();
    const capture = (node: Node) => {
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 2);
      const outcome = captureNativeSelectionInDocument(document, nativeSelection(range));
      return outcome.status === "captured" ? outcome.selection.language : undefined;
    };
    try {
      expect(capture(document.querySelector("q")!.firstChild!)).toBe("fr");
      expect(capture(document.querySelector("p")!.firstChild!)).toBe("en");
      expect(capture(document.querySelector("span")!.firstChild!)).toBeNull();
    } finally {
      document.documentElement.removeAttribute("lang");
    }
  });

  it("distinguishes a collapsed selection", () => {
    document.body.innerHTML = "<p>alpha</p>";
    const text = document.querySelector("p")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);

    expect(captureNativeSelectionInDocument(document, nativeSelection(range)).status).toBe(
      "collapsed",
    );
  });

  it("reports disconnected and foreign selections as conflicts", () => {
    const detached = document.createTextNode("detached");
    const detachedRange = document.createRange();
    detachedRange.selectNodeContents(detached);
    expect(captureNativeSelectionInDocument(document, nativeSelection(detachedRange)).status).toBe(
      "conflict",
    );

    const foreignDocument = document.implementation.createHTMLDocument();
    foreignDocument.body.textContent = "foreign";
    const foreignText = foreignDocument.body.firstChild as Text;
    const foreignRange = foreignDocument.createRange();
    foreignRange.selectNodeContents(foreignText);
    expect(captureNativeSelectionInDocument(document, nativeSelection(foreignRange)).status).toBe(
      "conflict",
    );
  });

  it("omits rather than truncates oversized quote evidence", () => {
    document.body.textContent = "x".repeat(17 * 1_024);
    installRenderedRangeGeometry();
    const text = document.body.firstChild as Text;
    const range = document.createRange();
    range.selectNodeContents(text);

    const capture = captureNativeSelectionInDocument(document, nativeSelection(range));

    expect(capture.status).toBe("captured");
    if (capture.status === "captured") {
      expect(capture.selection.evidence[0]).toEqual({
        kind: "browser-text-position",
        start: "0",
        end: String(17 * 1_024),
      });
      expect(capture.selection.evidence.some(({ kind }) => kind === "rendered-text-quote")).toBe(
        false,
      );
    }
  });

  it("returns stale when the text generation changes during geometry capture", () => {
    document.body.innerHTML = "<p>alpha</p>";
    installRenderedRangeGeometry(() => invalidateDocumentTextIndex(document));
    const text = document.querySelector("p")?.firstChild as Text;
    const range = document.createRange();
    range.selectNodeContents(text);

    expect(captureNativeSelectionInDocument(document, nativeSelection(range)).status).toBe("stale");
  });
});

describe("annotation selector execution", () => {
  it("distinguishes unique, invalid, missing, and multiple CSS matches", async () => {
    document.body.innerHTML = '<p class="many" id="one">One</p><p class="many">Two</p>';
    invalidateDocumentTextIndex(document);
    const before = documentTextIndexBuildCount(document);

    const outcomes = await Promise.all(
      ["#one", "[", ".missing", ".many"].map((value, index) =>
        resolveAnnotationTargetInDocument(
          document,
          { selectors: [selector([index], "css", { value })] },
          annotationWork(),
        ),
      ),
    );

    expect(outcomes.map(({ outcome }) => outcome)).toEqual([
      "resolved",
      "invalid",
      "broken",
      "ambiguous",
    ]);
    expect(outcomes.map(({ reports }) => reports[0]?.matchCount)).toEqual([1, 0, 0, 2]);
    expect(documentTextIndexBuildCount(document)).toBe(before);
  });

  it("uses a scoped text position refinement to disambiguate CSS matches", async () => {
    document.body.innerHTML =
      '<p class="annotation-choice">x</p><p class="annotation-choice">okay</p>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      {
        selectors: [
          selector([0], "css", { value: ".annotation-choice" }, [
            selector([0, 0], "text-position", { start: "0", end: "2" }),
          ]),
        ],
      },
      annotationWork(),
    );

    expect(result.outcome).toBe("resolved");
    expect(result.segmentKind).toBe("range");
    expect(result.range?.toString()).toBe("ok");
    expect(result.reports.map(({ path, outcome }) => ({ path, outcome }))).toEqual([
      { path: [0], outcome: "ambiguous" },
      { path: [0, 0], outcome: "resolved" },
    ]);
  });

  it("converts external Unicode code-point positions to DOM UTF-16 boundaries", async () => {
    document.body.innerHTML = "<p>A😀BC</p>";
    const text = document.querySelector("p")?.firstChild;
    const result = await resolveAnnotationTargetInDocument(
      document,
      { selectors: [selector([0], "text-position", { start: "1", end: "2" })] },
      annotationWork(),
    );

    expect(result.outcome).toBe("resolved");
    expect(result.range?.toString()).toBe("😀");
    expect(result.range?.startContainer).toBe(text);
    expect(result.range?.startOffset).toBe(1);
    expect(result.range?.endOffset).toBe(3);
  });

  it("reports duplicate HTML fragment identifiers as ambiguous", async () => {
    document.body.innerHTML = '<p id="same">One</p><p id="same">Two</p>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      { selectors: [selector([0], "html-fragment", { value: "same" })] },
      annotationWork(),
    );

    expect(result.outcome).toBe("ambiguous");
    expect(result.reports[0]).toMatchObject({ outcome: "ambiguous", matchCount: 2 });
  });

  it("resolves exact text with context and classifies range and malformed Text Fragments", async () => {
    document.body.innerHTML = "<p>alpha beta alpha</p>";
    const values = [
      "text=beta",
      "text=alpha,beta",
      "text=alpha%20-,beta,-%20alpha",
      "text=beta,-%20alpha",
      "text=%ZZ",
      "text=alpha,,beta",
      "text=missing",
      "text=alpha",
    ];
    const outcomes = await Promise.all(
      values.map((value, index) =>
        resolveAnnotationTargetInDocument(
          document,
          { selectors: [selector([index], "text-fragment", { value })] },
          annotationWork(),
        ),
      ),
    );

    expect(outcomes.map(({ outcome }) => outcome)).toEqual([
      "resolved",
      "unsupported",
      "resolved",
      "resolved",
      "invalid",
      "invalid",
      "broken",
      "ambiguous",
    ]);
    expect(outcomes[0]?.range?.toString()).toBe("beta");
    expect(outcomes[2]?.range?.toString()).toBe("beta");
    expect(outcomes[3]?.range?.toString()).toBe("beta");
  });

  it("keeps a successful sibling refinement when another sibling fails", async () => {
    document.body.innerHTML = '<main><p id="one">One</p></main>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      {
        selectors: [
          selector([0], "css", { value: "main" }, [
            selector([0, 0], "unsupported", { selectorType: "FutureSelector" }),
            selector([0, 1], "css", { value: "#one" }),
          ]),
        ],
      },
      annotationWork(),
    );

    expect(result.outcome).toBe("resolved");
    expect(result.segmentKind).toBe("element");
    expect(result.reports.map(({ path, outcome }) => ({ path, outcome }))).toEqual([
      { path: [0], outcome: "resolved" },
      { path: [0, 0], outcome: "unsupported" },
      { path: [0, 1], outcome: "resolved" },
    ]);
  });

  it("reports conflict when unique successful alternatives identify different segments", async () => {
    document.body.innerHTML = '<p id="one">One</p><p id="two">Two</p>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      {
        selectors: [
          selector([0], "css", { value: "#one" }),
          selector([1], "css", { value: "#two" }),
        ],
      },
      annotationWork(),
    );

    expect(result.outcome).toBe("conflict");
    expect(result.range).toBeNull();
    expect(result.reports.map(({ outcome }) => outcome)).toEqual(["resolved", "resolved"]);
  });

  it("does not resolve while another alternative is operationally unavailable", async () => {
    document.body.innerHTML = '<p id="one">One</p>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      {
        selectors: [
          selector([0], "css", { value: "#one" }),
          selector([1], "css", { value: "#missing" }),
        ],
      },
      annotationWork(new AbortController().signal, 4),
    );

    expect(result.outcome).toBe("unavailable");
    expect(result.segmentKind).toBeNull();
    expect(result.reports.map(({ outcome }) => outcome)).toEqual(["resolved", "unavailable"]);
  });

  it("normalizes partially successful refinement diagnostics to unavailable", async () => {
    document.body.innerHTML =
      '<section class="parent"><i>One</i></section><section class="parent"><i>Two</i></section>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      {
        selectors: [
          selector([0], "css", { value: ".parent" }, [selector([0, 0], "css", { value: "i" })]),
        ],
      },
      annotationWork(new AbortController().signal, 8),
    );

    expect(result.outcome).toBe("unavailable");
    expect(result.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: [0, 0],
          outcome: "unavailable",
          matchCount: 0,
          segmentKind: null,
        }),
      ]),
    );
  });

  it("rejects non-finite cooperative work limits", async () => {
    const plan = { selectors: [selector([0], "resource", {})] };
    await expect(
      resolveAnnotationTargetInDocument(document, plan, {
        ...annotationWork(),
        maximumWorkUnits: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("positive finite integers");
    await expect(
      resolveAnnotationTargetInDocument(document, plan, {
        ...annotationWork(),
        yieldEveryWorkUnits: Number.NaN,
      }),
    ).rejects.toThrow("positive finite integers");
  });

  it("reports a stale result when the cooperative content basis changes", async () => {
    const result = await resolveAnnotationTargetInDocument(
      document,
      { selectors: [selector([0], "resource", {})] },
      { ...annotationWork(), yieldEveryWorkUnits: 1, isCurrent: () => false },
    );

    expect(result.outcome).toBe("stale");
    expect(result.segmentKind).toBeNull();
    expect(result.reports).toEqual([
      expect.objectContaining({ path: [0], outcome: "stale", matchCount: 0 }),
    ]);
  });

  it("preserves candidate identity while reconciling recursive parent branches", async () => {
    document.body.innerHTML =
      '<section class="parent"><span class="choice"><i>A</i></span></section><section class="parent"><span class="choice"><b>B</b></span></section>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      {
        selectors: [
          selector([0], "css", { value: ".parent" }, [
            selector([0, 0], "css", { value: ".choice" }, [
              selector([0, 0, 0], "css", { value: "i" }),
              selector([0, 0, 1], "css", { value: "b" }),
            ]),
          ]),
        ],
      },
      annotationWork(),
    );

    expect(result.outcome).toBe("conflict");
    expect(result.reports.map((report) => report.path)).toEqual([
      [0],
      [0, 0],
      [0, 0, 0],
      [0, 0, 1],
    ]);
    expect(result.reports.filter((report) => report.path.length === 3)).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "resolved", matchCount: 1 })]),
    );
  });

  it("resolves when ambiguous parent branches converge on one segment", async () => {
    document.body.innerHTML =
      '<section class="scope"><section class="scope"><i id="target">A</i></section></section>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      {
        selectors: [
          selector([0], "css", { value: ".scope" }, [
            selector([0, 0], "css", { value: "#target" }),
          ]),
        ],
      },
      annotationWork(),
    );

    expect(result).toMatchObject({ outcome: "resolved", segmentKind: "element" });
    expect(result.reports).toEqual([
      expect.objectContaining({ path: [0], outcome: "ambiguous", matchCount: 2 }),
      expect.objectContaining({ path: [0, 0], outcome: "ambiguous", matchCount: 2 }),
    ]);
  });

  it("keeps element refinements within a parent text range", async () => {
    document.body.innerHTML = '<p><span id="inside">alpha</span><span id="outside">beta</span></p>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      {
        selectors: [
          selector([0], "text-position", { start: "0", end: "5" }, [
            selector([0, 0], "css", { value: "#outside" }),
          ]),
        ],
      },
      annotationWork(),
    );

    expect(result.outcome).toBe("broken");
    expect(result.reports[1]).toMatchObject({ path: [0, 0], outcome: "broken", matchCount: 0 });
  });

  it("does not resolve runtime-owned elements", async () => {
    document.body.innerHTML =
      '<style id="runtime" data-epub-navigator-configuration="m3">p { color: red; }</style>';
    const result = await resolveAnnotationTargetInDocument(
      document,
      { selectors: [selector([0], "css", { value: "#runtime" })] },
      annotationWork(),
    );

    expect(result).toMatchObject({ outcome: "broken", segmentKind: null });
  });

  it("does not fabricate descendant reports for a failed parent", async () => {
    const result = await resolveAnnotationTargetInDocument(
      document,
      {
        selectors: [
          selector([0], "css", { value: ".missing" }, [selector([0, 0], "css", { value: "p" })]),
          selector([1], "css", { value: "[" }, [selector([1, 0], "css", { value: "p" })]),
        ],
      },
      annotationWork(),
    );

    expect(result.reports.map((report) => report.path)).toEqual([[0], [1]]);
  });

  it("returns unavailable on annotation work exhaustion and supports cancellation", async () => {
    document.body.innerHTML = `<p>${"long text ".repeat(100)}</p>`;
    const exhausted = await resolveAnnotationTargetInDocument(
      document,
      { selectors: [selector([0], "text-fragment", { value: "text=long" })] },
      annotationWork(undefined, 5),
    );
    expect(exhausted).toMatchObject({ outcome: "unavailable", range: null });
    expect(exhausted.reports[0]).toMatchObject({ outcome: "unavailable" });

    const controller = new AbortController();
    const operation = resolveAnnotationTargetInDocument(
      document,
      { selectors: [selector([0], "text-fragment", { value: "text=long" })] },
      annotationWork(controller.signal, 100_000),
    );
    setTimeout(() => controller.abort(), 0);
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns unavailable instead of carrying an unbounded candidate set", async () => {
    document.body.innerHTML = "<i></i>".repeat(4_097);
    const result = await resolveAnnotationTargetInDocument(
      document,
      { selectors: [selector([0], "css", { value: "i" })] },
      annotationWork(),
    );

    expect(result).toMatchObject({ outcome: "unavailable", range: null });
    expect(result.reports[0]).toMatchObject({
      outcome: "unavailable",
      message: "annotation selector matched too many candidates",
    });
  });
});

describe("paginated range geometry", () => {
  it("snaps a boxless element fragment from its rendered geometry", () => {
    document.body.innerHTML = '<figure id="target">Target</figure>';
    scrollingViewport({
      scrollWidth: { configurable: true, value: 3200 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    installBoxlessRangeGeometry();
    const target = document.getElementById("target")!;
    target.getBoundingClientRect = () =>
      ({ top: 0, right: 1800, bottom: 100, left: 1700, width: 100, height: 100 }) as DOMRect;
    const scrollIntoView = vi.fn();
    Object.defineProperty(target, "scrollIntoView", { configurable: true, value: scrollIntoView });

    expect(
      relocateLocatorInDocument(
        document,
        { kind: "point", evidence: [{ kind: "html-fragment", value: "target" }] },
        { mode: "paginated", spreadStride: 800 },
      ),
    ).toEqual({ status: "resolved" });
    expect(document.documentElement.scrollLeft).toBe(1600);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("snaps a boxless element fragment on the reversed vertical axis", () => {
    document.body.innerHTML = '<figure id="target">Target</figure>';
    document.body.style.writingMode = "vertical-rl";
    document.body.style.direction = "rtl";
    scrollingViewport({
      scrollHeight: { configurable: true, value: 3000 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    installBoxlessRangeGeometry();
    const target = document.getElementById("target")!;
    target.getBoundingClientRect = () =>
      ({
        top: -1200,
        right: 100,
        bottom: -1100,
        left: 0,
        width: 100,
        height: 100,
      }) as DOMRect;

    expect(
      relocateLocatorInDocument(
        document,
        { kind: "point", evidence: [{ kind: "html-fragment", value: "target" }] },
        { mode: "paginated", spreadStride: 600 },
      ),
    ).toEqual({ status: "resolved" });
    expect(document.documentElement.scrollTop).toBe(-1200);
  });

  it("fails a boxless paginated fragment instead of leaving the viewport between spreads", () => {
    document.body.innerHTML = '<div id="boxless"></div>';
    scrollingViewport({
      scrollWidth: { configurable: true, value: 1600 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    installBoxlessRangeGeometry();
    const target = document.getElementById("boxless")!;
    target.getBoundingClientRect = () => emptyRect;
    const scrollIntoView = vi.fn();
    Object.defineProperty(target, "scrollIntoView", { configurable: true, value: scrollIntoView });

    expect(
      relocateLocatorInDocument(
        document,
        { kind: "point", evidence: [{ kind: "html-fragment", value: "boxless" }] },
        { mode: "paginated", spreadStride: 800 },
      ),
    ).toEqual({ status: "failed", message: "the paginated location has no rendered geometry" });
    expect(document.documentElement.scrollLeft).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not map a boxless collapsed target to page zero", () => {
    document.body.innerHTML = '<div id="boxless"></div>';
    scrollingViewport({
      scrollWidth: { configurable: true, value: 1600 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    const target = document.getElementById("boxless")!;
    const range = document.createRange();
    range.setStart(target, 0);
    range.collapse(true);
    Object.defineProperty(range, "getClientRects", { value: () => [] });
    Object.defineProperty(range, "getBoundingClientRect", { value: () => emptyRect });
    target.getBoundingClientRect = () => emptyRect;

    expect(
      physicalPageForRange(document, range, {
        spreadStride: 800,
        columnOrigin: 0,
        columnWidth: 800,
        columnGap: 0,
        columnPitch: 800,
        firstVisiblePage: 0,
        pageCount: 2,
        visiblePageCount: 1,
        columnsPerView: 1,
        layoutRepairs: { status: "no-issues-detected" },
      }),
    ).toBeNull();
  });

  it("maps vertical RTL rectangles through the reversed logical axis", () => {
    document.body.style.writingMode = "vertical-rl";
    document.body.style.direction = "rtl";
    scrollingViewport({
      scrollHeight: { configurable: true, value: 1800 },
      scrollTop: { configurable: true, value: -400, writable: true },
    });
    const range = document.createRange();
    range.selectNodeContents(document.body);
    const rectangle = {
      top: 100,
      right: 500,
      bottom: 150,
      left: 400,
      width: 100,
      height: 50,
    } as DOMRect;
    Object.defineProperty(range, "getClientRects", {
      value: () => [rectangle],
    });

    expect(
      physicalPageForRange(document, range, {
        spreadStride: 200,
        columnOrigin: 20,
        columnWidth: 80,
        columnGap: 20,
        columnPitch: 100,
        firstVisiblePage: 4,
        pageCount: 10,
        visiblePageCount: 2,
        columnsPerView: 2,
        layoutRepairs: { status: "no-issues-detected" },
      }),
    ).toBe(8);
  });
});
