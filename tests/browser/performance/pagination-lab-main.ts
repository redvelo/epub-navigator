import type { KernelSnapshot, PresentationPreferences } from "epub-navigator";
import {
  createNavigatorRuntime,
  type NavigatorRuntime,
  type NavigatorDiagnosticEvent,
} from "epub-navigator/runtime";
import { currentDocument } from "../../../src/runtime/kernel-view.js";
import {
  aliceMount,
  animationFrames,
  openArchive,
  requiredElement,
  singleColumnPreferences,
} from "../harness.js";

interface PaginationLabResult {
  readonly initial1kMs: number;
  readonly relayout10kMs: number;
  readonly pageTurnP95Ms: number;
  readonly target500Ms: number;
  readonly backgroundOverheadPercent: number;
  readonly cleanupMs: number;
  readonly staleCommits: number;
  readonly remainingFrames: number;
  readonly targetCount: number;
  readonly diagnosticEvents: number;
  readonly geometryScans: number;
  readonly assessment10kParagraphs: number;
  readonly assessment10kRectangles: number;
  readonly assessment10kTextRangeScans: number;
  readonly assessment10kMs: number;
  readonly cooperative10kYields: number;
  readonly unsafeDiagnosticPayload: boolean;
}

interface AssessmentLabResult {
  readonly relayoutMs: number;
  readonly paragraphCount: number;
  readonly rectangleCount: number;
  readonly textRangeScanCount: number;
  readonly durationMs: number;
}

declare global {
  interface Window {
    __EPUB_PAGINATION_LAB__?: {
      run(): Promise<PaginationLabResult>;
      runAssessment(count: number): Promise<AssessmentLabResult>;
    };
  }
}

const publication = await openArchive();
const container = requiredElement("#lab");
const diagnosticJournal: NavigatorDiagnosticEvent[] = [];
const pendingLayouts = new Map<number, { documentGeneration: number; layoutGeneration: number }>();
let staleCommits = 0;
const paginationAbort = new AbortController();
const runtime = await createNavigatorRuntime({
  session: {
    id: "pagination-lab",
    publication: { facts: publication.facts, mount: aliceMount },
  },
  container,
  diagnostics: { level: "trace", record: (event) => diagnosticJournal.push(event) },
});
const preferences = { ...singleColumnPreferences };
runtime.setPresentationPreferences(preferences);
runtime.open(0);
await committed(runtime);
const unsubscribeJournal = runtime.subscribe((transition) => {
  for (const event of transition.events) {
    if (event.type === "layout-pending") {
      pendingLayouts.set(event.operation, {
        documentGeneration: event.generation,
        layoutGeneration: event.layoutGeneration,
      });
    } else if (event.type === "layout-reported") {
      const pending = pendingLayouts.get(event.operation);
      if (
        pending === undefined ||
        pending.documentGeneration !== event.generation ||
        pending.layoutGeneration !== event.layoutGeneration
      ) {
        staleCommits += 1;
      }
      pendingLayouts.delete(event.operation);
    }
  }
});

window.__EPUB_PAGINATION_LAB__ = {
  async run() {
    const initial1kMs = await replaceFixture(runtime, 1_000, preferences);
    const pageTurnP95Ms = await pageTurns(20);
    const targetStarted = performance.now();
    let targetCount = 0;
    for (let offset = 0; offset < 500; offset += 32) {
      const length = Math.min(32, 500 - offset);
      const results = await runtime.measureTocTargets(
        Array.from({ length }, (_, index) => ({
          listIndex: 0,
          pointPath: [offset + index],
          evidence: [{ kind: "html-fragment" as const, value: `lab-${offset + index}` }],
        })),
      );
      targetCount += results.length;
    }
    const target500Ms = performance.now() - targetStarted;
    const baseline = await averageFrameMs(20);
    runtime.setPaginationCapabilities({
      responses: {
        mount: aliceMount,
        eligibleResourcePaths: publication.facts.resources.resources.flatMap((resource) =>
          resource.hasXhtmlDeclaration && resource.address.kind === "local"
            ? [resource.address.value]
            : [],
        ),
      },
      signal: paginationAbort.signal,
      close: () => paginationAbort.abort(),
    });
    await waitForBackgroundStart(runtime);
    const background = await averageFrameMs(20);
    const backgroundOverheadPercent = Math.max(0, ((background - baseline) / baseline) * 100);
    const geometryDiagnostics = enableGeometryDiagnostics();
    const relayout10kMs = await replaceFixture(runtime, 10_000, preferences);
    const assessment10k = geometryDiagnostics.assessment;
    const cleanupStarted = performance.now();
    unsubscribeJournal();
    runtime.close();
    const cleanupMs = performance.now() - cleanupStarted;
    const remainingFrames = container.querySelectorAll("iframe").length;
    publication.close();
    const diagnosticJson = JSON.stringify(diagnosticJournal);
    return {
      initial1kMs,
      relayout10kMs,
      pageTurnP95Ms,
      target500Ms,
      backgroundOverheadPercent,
      cleanupMs,
      staleCommits,
      remainingFrames,
      targetCount,
      diagnosticEvents: diagnosticJournal.length,
      geometryScans: diagnosticJournal.filter(
        (event) => event.type === "layout-phase" && (event.scanCount ?? 0) > 0,
      ).length,
      assessment10kParagraphs: assessment10k?.paragraphCount ?? 0,
      assessment10kRectangles: assessment10k?.rectangleCount ?? 0,
      assessment10kTextRangeScans: assessment10k?.textRangeScanCount ?? 0,
      assessment10kMs: assessment10k?.durationMs ?? 0,
      cooperative10kYields: geometryDiagnostics.cooperativeYieldCount ?? 0,
      unsafeDiagnosticPayload:
        diagnosticJson.includes("Synthetic pagination element") ||
        diagnosticJson.includes("/publications/") ||
        diagnosticJson.includes("http://") ||
        diagnosticJson.includes("https://"),
    };
  },
  async runAssessment(count) {
    const diagnostics = enableGeometryDiagnostics();
    const relayoutMs = await replaceFixture(runtime, count, preferences);
    const assessment = diagnostics.assessment;
    unsubscribeJournal();
    runtime.close();
    publication.close();
    return {
      relayoutMs,
      paragraphCount: assessment?.paragraphCount ?? 0,
      rectangleCount: assessment?.rectangleCount ?? 0,
      textRangeScanCount: assessment?.textRangeScanCount ?? 0,
      durationMs: assessment?.durationMs ?? 0,
    };
  },
};

function enableGeometryDiagnostics(): {
  enabled: boolean;
  assessment?: {
    paragraphCount: number;
    displayCandidateCount: number;
    rectangleCount: number;
    textRangeScanCount: number;
    durationMs: number;
  };
  cooperativeYieldCount?: number;
} {
  const frame = document.querySelector<HTMLIFrameElement>('iframe:not([aria-hidden="true"])');
  const view = frame?.contentWindow as
    | (Window & {
        __EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__?: {
          enabled: boolean;
          assessment?: {
            paragraphCount: number;
            displayCandidateCount: number;
            rectangleCount: number;
            textRangeScanCount: number;
            durationMs: number;
          };
          cooperativeYieldCount?: number;
        };
      })
    | null;
  if (view === null) throw new Error("pagination lab frame is unavailable");
  const diagnostics = { enabled: true };
  view.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__ = diagnostics;
  return diagnostics;
}

async function replaceFixture(
  runtime: NavigatorRuntime,
  count: number,
  preferences: PresentationPreferences,
): Promise<number> {
  const frame = document.querySelector<HTMLIFrameElement>('iframe:not([aria-hidden="true"])');
  const content = frame?.contentDocument;
  if (content?.body === null || content?.body === undefined)
    throw new Error("lab frame is unavailable");
  const before = currentDocument(runtime.snapshot())?.layout.layout.layoutGeneration ?? 0;
  const fragment = content.createDocumentFragment();
  for (let index = 0; index < count; index += 1) {
    const paragraph = content.createElement("p");
    paragraph.id = `lab-${index}`;
    paragraph.textContent = `Synthetic pagination element ${index}`;
    fragment.append(paragraph);
  }
  const started = performance.now();
  content.body.replaceChildren(fragment);
  void content.body.getBoundingClientRect();
  preferences.alignment = preferences.alignment === "start" ? "original" : "start";
  runtime.setPresentationPreferences(preferences);
  await layoutAfter(runtime, before);
  return performance.now() - started;
}

async function pageTurns(count: number): Promise<number> {
  const frame = document.querySelector<HTMLIFrameElement>('iframe:not([aria-hidden="true"])');
  const content = frame?.contentDocument;
  if (content === null || content === undefined) throw new Error("lab frame is unavailable");
  const durations: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    content.documentElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  return durations[Math.ceil(durations.length * 0.95) - 1] ?? 0;
}

async function averageFrameMs(count: number): Promise<number> {
  const started = performance.now();
  await animationFrames(window, count);
  return (performance.now() - started) / count;
}

async function waitForBackgroundStart(runtime: NavigatorRuntime): Promise<void> {
  await waitPagination(
    runtime,
    (snapshot) => snapshot.activity !== "idle" || snapshot.state === "complete",
  );
}

function waitPagination(
  runtime: NavigatorRuntime,
  predicate: (snapshot: ReturnType<NavigatorRuntime["paginationSnapshot"]>) => boolean,
): Promise<void> {
  if (predicate(runtime.paginationSnapshot())) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = runtime.subscribePagination((snapshot) => {
      if (!predicate(snapshot)) return;
      unsubscribe();
      resolve();
    });
  });
}

async function committed(runtime: NavigatorRuntime): Promise<KernelSnapshot> {
  return wait(runtime, (snapshot) => currentDocument(snapshot) !== null);
}

async function layoutAfter(runtime: NavigatorRuntime, generation: number): Promise<KernelSnapshot> {
  return wait(
    runtime,
    (snapshot) =>
      snapshot.layout.pending === null &&
      (currentDocument(snapshot)?.layout.layout.layoutGeneration ?? 0) > generation,
  );
}

function wait(
  runtime: NavigatorRuntime,
  predicate: (snapshot: KernelSnapshot) => boolean,
): Promise<KernelSnapshot> {
  const current = runtime.snapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = runtime.subscribe(() => {
      const snapshot = runtime.snapshot();
      if (!predicate(snapshot)) return;
      unsubscribe();
      resolve(snapshot);
    });
  });
}
