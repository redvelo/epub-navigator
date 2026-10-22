import {
  type AdapterLayoutPlan,
  type FixedLayoutIssue,
  type KernelEvent,
  type KernelSnapshot,
  type LayoutIssue,
  type NavigatorLocation,
  isNavigatorMediaOverlayDescription,
  isNavigatorMediaOverlayTimelineResult,
} from "epub-navigator";
import { openLocalPublication } from "epub-navigator/local";
import {
  createNavigatorMediaOverlayController,
  createNavigatorRuntime,
} from "epub-navigator/runtime";
import { BookPaginationController } from "../../../src/runtime/pagination/controller.js";
import { currentDocument } from "../../../src/runtime/kernel-view.js";
import {
  corpusScenario,
  type CatalogPublication,
  type CatalogScenario,
} from "../../fixtures/epub3-samples/catalog.js";
import { replacementGeneration, waitForCommitted, waitForObservation } from "../harness.js";

type CorpusRuntime = Awaited<ReturnType<typeof createNavigatorRuntime>>;
type PresentationIssue = {
  readonly status: "conflict" | "unavailable";
  readonly issue: LayoutIssue | FixedLayoutIssue;
};

export type ScenarioReport = Awaited<ReturnType<typeof openScenario>>["report"];
export type CorpusApi = Awaited<ReturnType<typeof openScenario>>["api"];

declare global {
  interface Window {
    __corpusTest: CorpusApi;
  }
}

const output = document.querySelector<HTMLPreElement>("#result")!;
const frameHost = document.querySelector<HTMLElement>("#frame-host")!;

try {
  const selection = corpusScenario(new URLSearchParams(location.search).get("scenario") ?? "");
  if (selection === undefined) throw new Error("unknown corpus scenario");
  const { report, api } = await openScenario(selection.publication, selection.scenario);
  window.__corpusTest = api;
  output.textContent = JSON.stringify(report);
  output.dataset.state = "ready";
} catch (cause) {
  output.textContent = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  output.dataset.state = "failed";
}

async function openScenario(catalog: CatalogPublication, scenario: CatalogScenario) {
  const archive = await fetch(`/corpus/${catalog.id}.epub`);
  if (!archive.ok) throw new Error(`corpus archive request failed: ${archive.status}`);
  const publication = await openLocalPublication(await archive.arrayBuffer());
  const mount = {
    baseUrl: `http://${catalog.id}.localhost:${location.port}/`,
    remoteResources: "blocked" as const,
    contentOrigin: "isolated-publication-origin" as const,
  };
  const runtime = await createNavigatorRuntime({
    session: { id: `corpus-${scenario.id}`, publication: { facts: publication.facts, mount } },
    container: frameHost,
    frameTitle: catalog.title,
  });
  const { readingOrder } = runtime.snapshot();
  const pagination = new BookPaginationController({
    facts: publication.facts,
    documents: readingOrder.map((item) => item.document),
    container: document.createElement("div"),
    preferences: {
      mode: "paginated",
      paginationColumns: "single",
      theme: "original",
      colorScheme: "light",
      typeface: "original",
      fontScale: "100",
      lineHeight: "original",
      letterSpacing: "0",
      wordSpacing: "0",
      paragraphSpacing: "original",
      textIndent: "original",
      measure: "full-width",
      alignment: "original",
      hyphenation: "original",
      rootScrollbar: "publisher",
    },
    createMeasurementRuntime: null,
  });
  const narration =
    catalog.id === "moby-dick-media-overlays"
      ? await corpusNarration(runtime, mount, readingOrder)
      : null;
  if (scenario.id === "haruko.fixed-spread") {
    runtime.configure({
      appearance: { rootScrollbar: "publisher" },
      input: {
        keyboardMode: "standard",
        touchZones: true,
        progressionDirection: "rtl",
        selectionMenu: "native",
      },
    });
  }

  const events: KernelEvent[] = [];
  const activations: string[] = [];
  const interactions: unknown[] = [];
  const plans = new Map<number, AdapterLayoutPlan>();
  const issues = new Map<number, PresentationIssue>();
  runtime.subscribe((transition) => {
    events.push(...transition.events);
    const pending = runtime.snapshot().document.pending;
    if (pending?.state.state === "layout-initializing") {
      plans.set(pending.generation, pending.state.plan);
    }
    for (const event of transition.events) {
      if (event.type === "layout-reported" && event.result.outcome.status !== "settled") {
        issues.set(event.generation, event.result.outcome);
      }
    }
  });
  runtime.subscribeActivations((activation) => activations.push(activation.href));
  runtime.subscribeInteractions((interaction) => {
    interactions.push(interaction);
    if (interaction.command === "fixed-zoom") {
      const state = runtime.fixedViewState();
      if (state !== null) runtime.setFixedZoom(state.zoom * interaction.factor, interaction.focal);
    } else if (interaction.command === "fixed-pan") {
      runtime.panFixedBy(interaction.delta);
    } else if (interaction.command === "fixed-reset") {
      runtime.setFixedZoom(1);
    } else if (interaction.command === "next") {
      runtime.next();
    } else if (interaction.command === "previous") {
      runtime.previous();
    }
  });
  const presentation = (snapshot: KernelSnapshot) => {
    const document = currentDocument(snapshot);
    const generation = document?.generation ?? snapshot.document.pending?.generation ?? null;
    return {
      plan: generation === null ? null : (plans.get(generation) ?? null),
      settlement: document?.layout.layout.settlement ?? null,
      issue: generation === null ? null : (issues.get(generation) ?? null),
    };
  };
  const openOccurrence = async (occurrence: number) =>
    waitForCommitted(runtime, replacementGeneration(runtime.open(occurrence)), 30_000);
  const point = (value: string): NavigatorLocation => ({
    kind: "point",
    occurrence: scenario.occurrence,
    resource: scenario.resource,
    evidence: [{ kind: "html-fragment", value }],
    observation: { layoutProgression: null, renderedTextProgression: null },
  });

  const opened = runtime.open(scenario.occurrence);
  if (!opened.accepted) throw new Error(`open was rejected: ${JSON.stringify(opened.failure)}`);
  let snapshot = await waitForCommitted(runtime, replacementGeneration(opened), 30_000);
  const observation = await waitForObservation(runtime, 30_000);
  if (scenario.kind !== "reflowable") pagination.updateForeground(snapshot);
  snapshot = runtime.snapshot();

  const report = {
    lifecycle: snapshot.document,
    presentation: presentation(snapshot),
    pagination: pagination.snapshot().occurrences[scenario.occurrence] ?? null,
    observation,
    events: [...events],
    cfiTargets: publication.facts.navigationTargets.some(
      (target) =>
        target.target.state === "resource" &&
        target.target.fragment?.startsWith("epubcfi(") === true,
    ),
  };
  const api = {
    snapshot: () => runtime.snapshot(),
    events: () => [...events],
    activations: () => [...activations],
    interactions: () => [...interactions],
    visibleOccurrenceRange: () => runtime.visibleOccurrenceRange(),
    participantFrames: () => inspectParticipantFrames(),
    fixedViewState: () => runtime.fixedViewState(),
    setFixedZoom: (zoom: number) => void runtime.setFixedZoom(zoom),
    next: () => void runtime.next(),
    previous: () => void runtime.previous(),
    captureSelection: () => runtime.captureSelection(),
    open: async (occurrence: number) => {
      const committed = await openOccurrence(occurrence);
      return {
        generation: committed.document.committed?.generation ?? null,
        presentation: presentation(committed),
      };
    },
    resolveFragment: async (fragment: string) =>
      locatorResult(await runtime.resolve(point(fragment))),
    relocateFragment: async (fragment: string) =>
      locatorResult(await runtime.relocate(point(fragment))),
    readingPosition: async () => {
      let passive = runtime.currentLocation();
      const deadline = performance.now() + 2_000;
      while (passive.location?.kind !== "point" && performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
        passive = runtime.currentLocation();
      }
      const capture = await runtime.captureCurrentLocation();
      const exact = runtime.currentLocation();
      const generated =
        capture.status === "captured"
          ? await runtime.generateCurrentLocationAnnotationTarget(exact.revision)
          : null;
      const restoration =
        generated?.outcome === "completed" && generated.result.status === "generated"
          ? await runtime.restoreAnnotationTarget({
              targetJson: generated.result.targetJson,
              occurrenceHint: { occurrence: generated.occurrence, resource: generated.resource },
            })
          : null;
      return { passive, capture, exact, generated, restoration };
    },
    narrate: () => narration?.controller.play(),
    narration: () => narration?.state() ?? null,
    close: () => {
      narration?.controller.close();
      pagination.close();
      runtime.close();
      publication.close();
      return frameHost.querySelectorAll("iframe").length;
    },
  };
  return { report, api };
}

async function corpusNarration(
  runtime: CorpusRuntime,
  mount: Parameters<typeof createNavigatorMediaOverlayController>[0]["mount"],
  readingOrder: KernelSnapshot["readingOrder"],
) {
  const fixture = async (name: string): Promise<unknown> =>
    (await fetch(`/media-overlay-fixture/${name}`)).json();
  const description = await fixture("description.json");
  if (
    !isNavigatorMediaOverlayDescription(description) ||
    description.playback.state !== "available"
  ) {
    throw new Error("the Moby-Dick playback description fixture is invalid");
  }
  const playableOccurrenceIndexes = description.playback.associations
    .filter((association) => association.overlay.state === "resolved")
    .map((association) => association.occurrenceIndex);
  const audio = new Audio();
  const controller = createNavigatorMediaOverlayController({
    runtime,
    mount,
    readingOrder,
    capabilities: {
      availability: {
        status: "available",
        playableOccurrenceIndexes,
        unavailableOccurrenceCount:
          description.playback.associations.length - playableOccurrenceIndexes.length,
      },
      signal: new AbortController().signal,
      description: async () => ({ status: "ok", description }),
      async timeline(overlayIndex) {
        const value = await fixture(`timeline-${overlayIndex}.json`);
        return isNavigatorMediaOverlayTimelineResult(value)
          ? { status: "ok", result: value }
          : { status: "unavailable", reason: "not-found" };
      },
      close() {},
    },
    createAudio: () => audio,
  });
  return {
    controller,
    state: () => ({
      state: controller.snapshot().state,
      source: audio.currentSrc,
      currentTime: audio.currentTime,
      error: audio.error?.code ?? null,
    }),
  };
}

function locatorResult(result: Awaited<ReturnType<CorpusRuntime["resolve"]>>) {
  return result.outcome === "completed"
    ? { outcome: result.outcome, status: result.status }
    : { outcome: result.outcome, failure: result.failure };
}

function inspectParticipantFrames() {
  return [...frameHost.querySelectorAll<HTMLIFrameElement>("iframe")]
    .filter((frame) =>
      ["primary", "fixed-companion"].includes(frame.dataset.epubNavigatorParticipant ?? ""),
    )
    .map((frame) => ({
      participant: frame.dataset.epubNavigatorParticipant ?? null,
      placement: frame.dataset.epubNavigatorPlacement ?? null,
      occurrence: Number(frame.dataset.epubNavigatorOccurrence),
      src: frame.src,
      inert: frame.inert,
      ariaHidden: frame.getAttribute("aria-hidden"),
      computedPointerEvents: getComputedStyle(frame).pointerEvents,
      transform: frame.style.transform,
    }));
}
