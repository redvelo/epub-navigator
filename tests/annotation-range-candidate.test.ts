// @vitest-environment jsdom

import { describe, expect, it, onTestFinished } from "vitest";
import {
  createAnnotationAuthoredProvenanceTracker,
  generateVerifiedAnnotationPointCandidate,
  generateVerifiedAnnotationRangeCandidate,
} from "../src/runtime/content-agent/targets/annotation-range-candidate.js";
import {
  documentTextGeneration,
  invalidateDocumentTextIndex,
} from "../src/runtime/content-agent/targets/resolver/text-index.js";
import { setMediaOverlayActive } from "../src/runtime/content-agent/media-overlays.js";

function authoredDocument(markup: string): {
  document: Document;
  tracker: ReturnType<typeof createAnnotationAuthoredProvenanceTracker>;
} {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  const tracker = createAnnotationAuthoredProvenanceTracker(document);
  onTestFinished(() => tracker.disconnect());
  document.body.innerHTML = markup;
  tracker.finalize();
  return { document, tracker };
}

function textRange(content: Document, selector: string, start: number, end: number): Range {
  const text = content.querySelector(selector)?.firstChild;
  if (text === null || text === undefined) throw new Error("missing test text");
  const range = content.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  return range;
}

function generateRange(
  content: Document,
  target: Parameters<typeof generateVerifiedAnnotationRangeCandidate>[1],
  tracker: ReturnType<typeof createAnnotationAuthoredProvenanceTracker>,
  includeTextFragment = false,
) {
  return generateVerifiedAnnotationRangeCandidate(
    content,
    target,
    tracker,
    basis(content),
    includeTextFragment,
  );
}

function basis(content: Document) {
  return {
    expectedDocumentTextGeneration: documentTextGeneration(content),
    isCurrent: () => true,
  };
}

describe("verified annotation range candidates", () => {
  it("generates same-basis CSS-refined and document collapsed points in code points", async () => {
    const { document: content, tracker } = authoredDocument(
      '<main><p id="chapter">A😀BC</p></main>',
    );
    const result = await generateVerifiedAnnotationPointCandidate(
      content,
      [{ kind: "browser-text-position", offset: "2" }],
      tracker,
      basis(content),
    );

    expect(result).toEqual({
      status: "generated",
      candidate: {
        css: { value: "#chapter", offset: "2" },
        document: { offset: "2" },
      },
    });
  });

  it("prefers a unique authored ID and emits relative and document code-point positions", async () => {
    const { document: content, tracker } = authoredDocument(
      '<main><p id="chapter">A😀BC target</p></main>',
    );
    const range = textRange(content, "p", 1, 4);

    const result = await generateRange(content, { range }, tracker, true);

    expect(result).toEqual({
      status: "generated",
      candidate: {
        css: { value: "#chapter", start: "1", end: "3" },
        document: { start: "1", end: "3" },
        textFragment: `text=${encodeURIComponent("😀B")}`,
      },
    });
  });

  it("uses a deterministic nth-of-type path and omits a non-unique exact text fragment", async () => {
    const { document: content, tracker } = authoredDocument(
      "<main><p>same</p><p>same and more</p></main>",
    );
    const range = textRange(content, "p:nth-of-type(2)", 0, 4);

    const result = await generateRange(content, { range }, tracker, true);

    expect(result.status).toBe("generated");
    if (result.status !== "generated") return;
    expect(result.candidate.css?.value).toBe(
      "html:nth-of-type(1) > body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(2)",
    );
    expect(result.candidate).not.toHaveProperty("textFragment");
  });

  it("omits a dirty document position while retaining a verified authored-ID scope", async () => {
    const { document: content, tracker } = authoredDocument(
      '<main><p id="target">authored target</p></main>',
    );
    const authored = content.querySelector("p");
    if (authored === null) throw new Error("missing authored paragraph");
    const inserted = content.createElement("p");
    inserted.textContent = "inserted sibling";
    authored.before(inserted);

    const result = await generateRange(
      content,
      { range: textRange(content, "p:nth-of-type(2)", 0, 8) },
      tracker,
    );

    expect(result).toMatchObject({
      status: "generated",
      candidate: {
        css: { value: "#target", start: "0", end: "8" },
        document: null,
      },
    });
  });

  it("escapes unique authored IDs as CSS identifiers", async () => {
    const { document: content, tracker } = authoredDocument('<p id="1 odd:id">text</p>');
    const result = await generateRange(content, { range: textRange(content, "p", 0, 3) }, tracker);

    expect(result).toMatchObject({
      status: "generated",
      candidate: { css: { value: "#\\31 \\ odd\\:id" } },
    });
  });

  it("resolves supplied locator evidence before generating", async () => {
    const { document: content, tracker } = authoredDocument('<p id="p">alpha beta</p>');
    const result = await generateRange(
      content,
      { evidence: [{ kind: "browser-text-position", start: "6", end: "9" }] },
      tracker,
    );

    expect(result).toMatchObject({
      status: "generated",
      candidate: { css: { value: "#p", start: "6", end: "9" } },
    });
  });

  it("rejects selected content changed or inserted after provenance finalization", async () => {
    const { document: content, tracker } = authoredDocument('<p id="p">authored</p>');
    const text = content.querySelector("p")?.firstChild;
    if (text === null || text === undefined) throw new Error("missing test text");
    text.nodeValue = "modified";
    const range = textRange(content, "p", 0, 8);

    await expect(generateRange(content, { range }, tracker)).resolves.toEqual({
      status: "unavailable",
      reason: "not-authored",
    });

    const inserted = content.createElement("p");
    inserted.textContent = "inserted";
    content.body.append(inserted);
    const insertedRange = textRange(content, "p:nth-of-type(2)", 0, 8);
    await expect(generateRange(content, { range: insertedRange }, tracker)).resolves.toEqual({
      status: "unavailable",
      reason: "not-authored",
    });
  });

  it("keeps narrated content authored across media overlay class changes", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const content = frame.contentDocument!;
    const tracker = createAnnotationAuthoredProvenanceTracker(content);
    onTestFinished(() => {
      tracker.disconnect();
      frame.remove();
    });
    content.body.innerHTML = '<p id="p">authored</p>';
    tracker.finalize();
    setMediaOverlayActive(
      content,
      {
        fragment: "p",
        activeClasses: ["-epub-media-overlay-active"],
        playbackActiveClasses: ["-epub-media-overlay-playing"],
      },
      "original",
    );
    setMediaOverlayActive(
      content,
      { fragment: null, activeClasses: [], playbackActiveClasses: [] },
      "original",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      generateRange(content, { range: textRange(content, "p", 0, 8) }, tracker),
    ).resolves.toMatchObject({ status: "generated" });
  });

  it("rejects executable authored documents and runtime-owned selected nodes", async () => {
    const executable = authoredDocument('<script>void 0</script><p id="p">text</p>');
    await expect(
      generateRange(
        executable.document,
        { range: textRange(executable.document, "p", 0, 4) },
        executable.tracker,
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "not-authored" });

    const runtime = authoredDocument('<p data-epub-navigator-configuration="runtime">runtime</p>');
    await expect(
      generateRange(
        runtime.document,
        { range: textRange(runtime.document, "p", 0, 7) },
        runtime.tracker,
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "not-authored" });
  });

  it("rejects stale local content bases", async () => {
    const { document: content, tracker } = authoredDocument('<p id="p">text</p>');
    const expectedDocumentTextGeneration = documentTextGeneration(content);
    invalidateDocumentTextIndex(content);

    await expect(
      generateVerifiedAnnotationRangeCandidate(
        content,
        { range: textRange(content, "p", 0, 4) },
        tracker,
        { expectedDocumentTextGeneration, isCurrent: () => true },
        false,
      ),
    ).resolves.toEqual({ status: "stale" });
  });
});
