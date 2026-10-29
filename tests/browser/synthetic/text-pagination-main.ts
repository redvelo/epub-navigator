import type { KernelSnapshot } from "epub-navigator";
import { createNavigatorRuntime, type NavigatorRuntime } from "epub-navigator/runtime";
import {
  aliceMount,
  openArchive,
  requiredElement,
  singleColumnPreferences,
  waitFor,
} from "../harness.js";
import {
  currentDocument,
  currentFrame,
  currentPaginatedLayout,
} from "../../../src/runtime/kernel-view.js";

type Scenario =
  | "safe"
  | "ancestors"
  | "descendants"
  | "multiple"
  | "collision"
  | "starved-margins"
  | "wide-table"
  | "unfit-table"
  | "mixed-margins"
  | "starved-div"
  | "wide-pre"
  | "unfit-pre"
  | "two-column-table";
type ContentEndScenario =
  | "clipped-overflow"
  | "out-of-flow"
  | "generated"
  | "empty"
  | "authored-blank";

interface TextPaginationFixture {
  setScenario(scenario: Scenario): Promise<KernelSnapshot>;
  setColumns(columns: "auto" | "single" | "double"): Promise<KernelSnapshot>;
  setAuthoredBodyMargins(declarations: string): Promise<KernelSnapshot>;
  removeCandidate(id: string): Promise<KernelSnapshot>;
  measureStableGeometry(): Promise<GeometryDiagnostics>;
  setFlow(
    writingMode: "horizontal-tb" | "vertical-rl",
    direction: "ltr" | "rtl",
  ): Promise<KernelSnapshot>;
  installForcedReplacedContent(): Promise<KernelSnapshot>;
  installOddFinalSpread(): Promise<KernelSnapshot>;
  installContentEndScenario(scenario: ContentEndScenario): Promise<KernelSnapshot>;
  goToEnd(): Promise<KernelSnapshot>;
  snapshot(): KernelSnapshot;
}

interface GeometryDiagnostics {
  readonly scanCount: number;
  readonly rectangleCount: number;
  readonly assessment?:
    | {
        readonly paragraphCount: number;
        readonly displayCandidateCount: number;
        readonly rectangleCount: number;
        readonly textRangeScanCount: number;
        readonly durationMs: number;
      }
    | undefined;
  readonly phases: readonly { phase: string; durationMs: number }[];
}

declare global {
  interface Window {
    __EPUB_TEXT_PAGINATION__?: TextPaginationFixture;
  }
}

const publication = await openArchive();
const container = requiredElement("#frame-host");
const runtime = await createNavigatorRuntime({
  session: {
    id: "text-pagination",
    publication: { facts: publication.facts, mount: aliceMount },
  },
  container,
});
const preferences = { ...singleColumnPreferences };
runtime.configure({
  appearance: { rootScrollbar: "hidden" },
  input: {
    keyboardMode: "standard",
    touchZones: false,
    progressionDirection: "ltr",
    selectionMenu: "native",
  },
});
runtime.setPresentationPreferences(preferences);
runtime.open(0);
await waitFor(
  () => currentDocument(runtime.snapshot()) !== null,
  "the text pagination document did not commit",
);

window.__EPUB_TEXT_PAGINATION__ = {
  async setScenario(scenario) {
    const before = committedLayoutGeneration(runtime.snapshot());
    installScenario(committedDocument(), scenario);
    return waitForLayoutAfter(runtime, before);
  },
  async setColumns(columns) {
    const before = committedLayoutGeneration(runtime.snapshot());
    preferences.paginationColumns = columns;
    runtime.setPresentationPreferences(preferences);
    return waitForLayoutAfter(runtime, before);
  },
  async setAuthoredBodyMargins(declarations) {
    const before = committedLayoutGeneration(runtime.snapshot());
    const content = committedDocument();
    content.getElementById("authored-body-margins")?.remove();
    const style = content.createElement("style");
    style.id = "authored-body-margins";
    style.textContent = `body { ${declarations} }`;
    content.head.append(style);
    return waitForLayoutAfter(runtime, before);
  },
  async removeCandidate(id) {
    const before = committedLayoutGeneration(runtime.snapshot());
    const candidate = committedDocument().querySelector(`[data-candidate="${id}"]`);
    candidate?.closest("[data-candidate-parent]")?.remove();
    return waitForLayoutAfter(runtime, before);
  },
  async measureStableGeometry() {
    const frameWindow = committedDocument().defaultView as Window & {
      __EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__?: {
        enabled: boolean;
        scanCount?: number;
        rectangleCount?: number;
        assessment?: {
          paragraphCount: number;
          displayCandidateCount: number;
          rectangleCount: number;
          textRangeScanCount: number;
          durationMs: number;
        };
        phases?: { phase: string; durationMs: number }[];
      };
    };
    frameWindow.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__ = { enabled: true };
    const before = committedLayoutGeneration(runtime.snapshot());
    preferences.alignment = preferences.alignment === "start" ? "original" : "start";
    runtime.setPresentationPreferences(preferences);
    await waitForLayoutAfter(runtime, before);
    const diagnostics = frameWindow.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__;
    if (diagnostics === undefined) throw new Error("geometry diagnostics are unavailable");
    return {
      scanCount: diagnostics.scanCount ?? 0,
      rectangleCount: diagnostics.rectangleCount ?? 0,
      assessment: diagnostics.assessment,
      phases: diagnostics.phases ?? [],
    };
  },
  async setFlow(writingMode, direction) {
    const before = committedLayoutGeneration(runtime.snapshot());
    const content = committedDocument();
    content.documentElement.style.writingMode = writingMode;
    content.documentElement.style.direction = direction;
    if (content.body !== null) {
      content.body.style.writingMode = writingMode;
      content.body.style.direction = direction;
    }
    return waitForLayoutAfter(runtime, before);
  },
  async installForcedReplacedContent() {
    const before = committedLayoutGeneration(runtime.snapshot());
    const content = committedDocument();
    const section = content.createElement("section");
    section.style.breakBefore = "column";
    const image = content.createElement("img");
    image.alt = "";
    image.width = 80;
    image.height = 60;
    image.src =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='60'/%3E";
    section.append(image);
    content.body?.append(section);
    await image.decode();
    return waitForLayoutAfter(runtime, before);
  },
  async installOddFinalSpread() {
    preferences.paginationColumns = "double";
    runtime.setPresentationPreferences(preferences);
    let snapshot = await waitForLayoutAfter(runtime, committedLayoutGeneration(runtime.snapshot()));
    for (let index = 0; index < 12; index += 1) {
      const pages = currentPaginatedLayout(snapshot);
      if (pages !== null && pages.pageCount % 2 === 1) return snapshot;
      const before = committedLayoutGeneration(snapshot);
      const paragraph = committedDocument().createElement("p");
      paragraph.textContent = `Odd final spread probe ${index} `.repeat(80);
      committedDocument().body?.append(paragraph);
      snapshot = await waitForLayoutAfter(runtime, before);
    }
    return snapshot;
  },
  async installContentEndScenario(scenario) {
    const before = committedLayoutGeneration(runtime.snapshot());
    installContentEndScenario(committedDocument(), scenario);
    return waitForLayoutAfter(runtime, before);
  },
  async goToEnd() {
    const frame = currentFrame(runtime.snapshot());
    if (frame === null) throw new Error("the text pagination document is not committed");
    const outcome = await runtime.relocate({
      kind: "point",
      occurrence: frame.occurrence,
      resource: frame.resource,
      evidence: [{ kind: "document-boundary", boundary: "end" }],
      observation: { layoutProgression: null, renderedTextProgression: null },
    });
    if (outcome.outcome !== "completed" || outcome.status.status !== "resolved") {
      throw new Error("the final spread could not be reached");
    }
    await waitFor(() => {
      const pages = currentPaginatedLayout(runtime.snapshot());
      return (
        pages !== null &&
        pages.firstVisiblePage ===
          Math.floor((pages.pageCount - 1) / pages.columnsPerView) * pages.columnsPerView
      );
    }, "the final spread observation did not settle");
    return runtime.snapshot();
  },
  snapshot: () => runtime.snapshot(),
};

addEventListener(
  "pagehide",
  () => {
    runtime.close();
    publication.close();
  },
  { once: true },
);

function committedDocument(): Document {
  const frame = container.querySelector<HTMLIFrameElement>('iframe:not([aria-hidden="true"])');
  if (frame?.contentDocument === null || frame?.contentDocument === undefined) {
    throw new Error("the committed text pagination document is unavailable");
  }
  return frame.contentDocument;
}

function installScenario(document: Document, scenario: Scenario): void {
  document.getElementById("text-pagination-scenario")?.remove();
  const root = document.createElement("section");
  root.id = "text-pagination-scenario";
  root.style.breakBefore = "column";
  if (scenario === "safe") root.append(centeredCandidate(document, "safe"));
  else if (scenario === "ancestors") installAncestorMatrix(document, root);
  else if (scenario === "descendants") installDescendantMatrix(document, root);
  else if (scenario === "multiple") {
    root.append(centeredCandidate(document, "safe-a"), centeredCandidate(document, "safe-b"));
    root.append(unsafeAncestor(document, "unsafe-a", "avoid"));
    root.append(unsafeDescendant(document, "unsafe-b", "scroll"));
  } else if (scenario === "starved-margins") root.append(starvedParagraph(document, "starved"));
  else if (scenario === "mixed-margins") {
    const fixed = starvedParagraph(document, "fixed-width");
    fixed.style.marginInlineStart = "70%";
    fixed.style.width = "30%";
    root.append(starvedParagraph(document, "starved"), fixed);
  } else if (scenario === "starved-div") {
    const division = document.createElement("div");
    division.dataset.candidate = "starved-div";
    division.style.marginInlineStart = "80%";
    division.textContent = "An epigraph set in a division rather than a paragraph.";
    root.append(division);
  } else if (scenario === "wide-pre") root.append(widePre(document, "wide-pre", 1.05));
  else if (scenario === "unfit-pre") root.append(widePre(document, "unfit-pre", 2));
  else if (scenario === "two-column-table") root.append(wideTable(document, "spanning", 0.7));
  else if (scenario === "wide-table") root.append(wideTable(document, "wide", 1.05));
  else if (scenario === "unfit-table") root.append(wideTable(document, "unfit", 2));
  else installCollisionScenario(document, root);
  document.body?.append(root);
  if (document.body instanceof HTMLElement) {
    document.body.tabIndex = -1;
    document.body.focus();
  }
}

function installContentEndScenario(document: Document, scenario: ContentEndScenario): void {
  const body = document.body;
  if (body === null) throw new Error("the content body is unavailable");
  body.replaceChildren();
  body.removeAttribute("style");
  if (scenario === "empty") return;

  if (scenario === "generated") {
    const style = document.createElement("style");
    style.textContent =
      "#content-end-generated::after { content: 'generated'; display: block; block-size: 250vh; }";
    const probe = document.createElement("div");
    probe.id = "content-end-generated";
    body.append(style, probe);
    return;
  }

  if (scenario === "authored-blank") {
    const start = document.createElement("div");
    start.dataset.contentEndProbe = "start";
    start.textContent = "start";
    const blank = document.createElement("div");
    blank.style.breakBefore = "column";
    blank.style.breakAfter = "column";
    const end = document.createElement("div");
    end.dataset.contentEndProbe = "end";
    end.textContent = "end";
    body.append(start, blank, end);
    return;
  }

  const container = document.createElement("div");
  container.style.position = "relative";
  container.style.inlineSize = "100px";
  container.style.blockSize = "100px";
  if (scenario === "clipped-overflow") container.style.overflow = "hidden";
  const probe = document.createElement("span");
  probe.dataset.contentEndProbe = "overflow";
  probe.style.position = "absolute";
  probe.style.insetInlineStart = "3000px";
  probe.style.insetBlockStart = "0";
  probe.style.inlineSize = "10px";
  probe.style.blockSize = "10px";
  container.append(probe);
  body.append(container);
}

/** An epigraph attribution as a print stylesheet sets it: pushed four fifths across the page. */
function starvedParagraph(document: Document, id: string): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  paragraph.dataset.candidate = id;
  paragraph.style.marginInlineStart = "80%";
  paragraph.style.marginInlineEnd = "0";
  paragraph.textContent = "—Petition of the inhabitants of Wesley, 13 December 1893";
  return paragraph;
}

/**
 * A table wider than its column the way real ones are: by content that cannot wrap. Each cell
 * holds a box of a fixed pixel size, so the table's minimum width is a known share of the column.
 */
function wideTable(document: Document, id: string, share: number): HTMLTableElement {
  const column = document.body?.getBoundingClientRect().width ?? 0;
  const table = document.createElement("table");
  table.dataset.candidate = id;
  table.dataset.candidateParent = id;
  table.style.width = "100%";
  for (let row = 0; row < 3; row += 1) {
    const tr = table.insertRow();
    for (let cell = 0; cell < 4; cell += 1) {
      const content = document.createElement("span");
      content.style.display = "inline-block";
      content.style.width = `${(column * share) / 4}px`;
      content.textContent = `${row}.${cell}`;
      tr.insertCell().append(content);
    }
  }
  return table;
}

/**
 * A block of code with one line a known share of the column wide. A line a little too wide is a
 * box of exact width, so the scale it needs is exact too; a line far too wide is text, the one
 * thing a block of code can still do when it cannot be scaled: wrap.
 */
function widePre(document: Document, id: string, share: number): HTMLPreElement {
  const column = document.body?.getBoundingClientRect().width ?? 0;
  const pre = document.createElement("pre");
  pre.dataset.candidate = id;
  const line = document.createElement("span");
  if (share <= 1.2) {
    line.style.display = "inline-block";
    line.style.width = `${column * share}px`;
    line.textContent = "let width = measure();";
  } else {
    line.textContent = "x".repeat(Math.ceil((column * share) / 8));
  }
  pre.append("fn main() {\n    ", line, "\n}");
  return pre;
}

function centeredCandidate(document: Document, id: string): HTMLElement {
  const parent = document.createElement("div");
  parent.dataset.candidateParent = id;
  parent.style.textAlign = "center";
  const paragraph = atomicParagraph(document, id);
  parent.append(paragraph);
  return parent;
}

function atomicParagraph(document: Document, id: string): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  paragraph.dataset.candidate = id;
  paragraph.style.display = "inline-block";
  paragraph.style.lineHeight = "24px";
  paragraph.style.marginInline = "0";
  for (let line = 0; line < 64; line += 1) {
    const span = document.createElement("span");
    span.dataset.sourceLine = `${id}-${line}`;
    span.style.display = "block";
    span.textContent = `Line ${line}`;
    paragraph.append(span);
  }
  return paragraph;
}

function installAncestorMatrix(document: Document, root: HTMLElement): void {
  for (const kind of ["figure", "inline-block", "flex", "grid", "contain", "scroll", "avoid"]) {
    root.append(unsafeAncestor(document, `ancestor-${kind}`, kind));
  }
}

function unsafeAncestor(document: Document, id: string, kind: string): HTMLElement {
  const outer = document.createElement(kind === "figure" ? "figure" : "div");
  outer.dataset.unsafeAncestor = kind;
  if (kind === "inline-block") outer.style.display = "inline-block";
  else if (kind === "flex") outer.style.display = "flex";
  else if (kind === "grid") outer.style.display = "grid";
  else if (kind === "contain") outer.style.contain = "layout";
  else if (kind === "scroll") outer.style.overflow = "auto";
  else if (kind === "avoid") outer.style.breakInside = "avoid";
  outer.append(centeredCandidate(document, id));
  return outer;
}

function installDescendantMatrix(document: Document, root: HTMLElement): void {
  for (const kind of [
    "inline-block",
    "flex",
    "grid",
    "table",
    "contain",
    "scroll",
    "columns",
    "avoid",
    "media",
  ]) {
    root.append(unsafeDescendant(document, `descendant-${kind}`, kind));
  }
}

function unsafeDescendant(document: Document, id: string, kind: string): HTMLElement {
  const parent = centeredCandidate(document, id);
  const paragraph = parent.querySelector("p")!;
  const descendant =
    kind === "media" ? document.createElement("img") : document.createElement("span");
  descendant.dataset.unsafeDescendant = kind;
  if (descendant instanceof HTMLImageElement) {
    descendant.alt = "";
    descendant.src = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  } else if (kind === "inline-block") descendant.style.display = "inline-block";
  else if (kind === "flex") descendant.style.display = "flex";
  else if (kind === "grid") descendant.style.display = "grid";
  else if (kind === "table") descendant.style.display = "table";
  else if (kind === "contain") descendant.style.contain = "layout";
  else if (kind === "scroll") descendant.style.overflow = "auto";
  else if (kind === "columns") descendant.style.columnCount = "2";
  else if (kind === "avoid") descendant.style.breakInside = "avoid";
  paragraph.prepend(descendant);
  return parent;
}

function installCollisionScenario(document: Document, root: HTMLElement): void {
  const authored = document.createElement("div");
  authored.id = "authored-marker";
  authored.setAttribute("data-epub-navigator-fragmentation", "m3-1");
  authored.style.display = "inline";
  authored.textContent = "Publisher marker";
  const specificityA = document.createElement("div");
  specificityA.id = "epub-navigator-fragmentation-a";
  specificityA.style.display = "inline";
  const specificityB = document.createElement("div");
  specificityB.id = "epub-navigator-fragmentation-b";
  specificityB.style.display = "inline";
  const safe = centeredCandidate(document, "collision-safe");
  const owned = centeredCandidate(document, "collision-owned");
  owned.querySelector("p")!.setAttribute("data-epub-navigator-fragmentation", "publisher-value");
  root.append(authored, specificityA, specificityB, safe, owned);
}

async function waitForLayoutAfter(
  runtime: NavigatorRuntime,
  generation: number,
): Promise<KernelSnapshot> {
  await waitFor(() => {
    const snapshot = runtime.snapshot();
    return snapshot.layout.pending === null && committedLayoutGeneration(snapshot) > generation;
  }, "the text pagination layout did not settle");
  return runtime.snapshot();
}

function committedLayoutGeneration(snapshot: KernelSnapshot): number {
  return currentDocument(snapshot)?.layout.layout.layoutGeneration ?? 0;
}
