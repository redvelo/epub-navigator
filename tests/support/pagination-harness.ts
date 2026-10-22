import { it as base, onTestFinished, vi, type Mock, type MockInstance } from "vitest";
import type {
  AdapterLayoutSettlement,
  CommittedLayout,
  FixedSettlement,
  KernelSnapshot,
  KernelTransition,
  PendingDocument,
  PendingLayoutOperation,
  PresentationPreferences,
  ReadingOrderOccurrence,
  ReflowableSettlement,
} from "../../src/generated/kernel.js";
import type { PublicationFacts } from "../../src/generated/publication.js";
import type {
  NavigatorRuntime,
  NavigatorTransitionListener,
} from "../../src/runtime/navigator/api.js";
import type {
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
} from "../../src/runtime/agent-protocol/index.js";
import {
  BookPaginationController,
  type NavigatorDiagnosticEvent,
  type NavigatorDiagnostics,
  type PaginationMeasurementCache,
} from "../../src/runtime/pagination/index.js";

class PaginationControllerHarness {
  readonly view: Window;
  readonly events: NavigatorDiagnosticEvent[] = [];
  readonly diagnostics: NavigatorDiagnostics;
  #now = 0;
  #hidden = false;
  #idleSequence = 0;
  readonly #idle = new Map<number, () => void>();
  #resize: ResizeObserverCallback | null = null;
  #restoreResizeObserver: (() => void) | null = null;
  #restoreIdle: (() => void) | null = null;
  #restoreScheduling: (() => void) | null = null;
  #hiddenSpy: MockInstance | null = null;
  #inputPending = false;

  constructor(view: Window = window) {
    this.view = view;
    this.diagnostics = {
      level: "trace",
      now: () => this.#now,
      record: (event) => this.events.push(event),
    };
  }

  install(): void {
    const setResize = (callback: ResizeObserverCallback) => {
      this.#resize = callback;
    };
    const resizeDescriptor = Object.getOwnPropertyDescriptor(this.view, "ResizeObserver");
    Object.defineProperty(this.view, "ResizeObserver", {
      configurable: true,
      value: class implements ResizeObserver {
        readonly #callback: ResizeObserverCallback;
        readonly #targets = new Set<Element>();

        constructor(callback: ResizeObserverCallback) {
          this.#callback = callback;
          setResize(callback);
        }

        observe(target: Element): void {
          this.#targets.add(target);
          queueMicrotask(() => {
            if (!this.#targets.has(target)) return;
            const rectangle = target.getBoundingClientRect();
            this.#callback(
              [
                {
                  target,
                  contentRect: { width: rectangle.width, height: rectangle.height },
                } as unknown as ResizeObserverEntry,
              ],
              this,
            );
          });
        }

        unobserve(target: Element): void {
          this.#targets.delete(target);
        }

        disconnect(): void {
          this.#targets.clear();
        }
      },
    });
    this.#restoreResizeObserver = () => {
      if (resizeDescriptor === undefined)
        delete (this.view as { ResizeObserver?: unknown }).ResizeObserver;
      else Object.defineProperty(this.view, "ResizeObserver", resizeDescriptor);
    };
    const idle = this.view as unknown as {
      requestIdleCallback?: ((callback: () => void) => number) | undefined;
      cancelIdleCallback?: ((handle: number) => void) | undefined;
    };
    const requestIdleCallback = idle.requestIdleCallback;
    const cancelIdleCallback = idle.cancelIdleCallback;
    idle.requestIdleCallback = (callback) => {
      const handle = ++this.#idleSequence;
      this.#idle.set(handle, callback);
      return handle;
    };
    idle.cancelIdleCallback = (handle) => this.#idle.delete(handle);
    this.#restoreIdle = () => {
      if (requestIdleCallback === undefined) delete idle.requestIdleCallback;
      else idle.requestIdleCallback = requestIdleCallback;
      if (cancelIdleCallback === undefined) delete idle.cancelIdleCallback;
      else idle.cancelIdleCallback = cancelIdleCallback;
    };
    const navigator = this.view.navigator as Navigator & { scheduling?: unknown };
    const schedulingDescriptor = Object.getOwnPropertyDescriptor(navigator, "scheduling");
    Object.defineProperty(navigator, "scheduling", {
      configurable: true,
      value: { isInputPending: () => this.#inputPending },
    });
    this.#restoreScheduling = () => {
      if (schedulingDescriptor === undefined) delete navigator.scheduling;
      else Object.defineProperty(navigator, "scheduling", schedulingDescriptor);
    };
    this.#hiddenSpy = vi
      .spyOn(this.view.document, "hidden", "get")
      .mockImplementation(() => this.#hidden);
  }

  async advance(milliseconds: number): Promise<void> {
    this.#now += milliseconds;
    await vi.advanceTimersByTimeAsync(milliseconds);
  }

  async runIdle(): Promise<void> {
    const callbacks = [...this.#idle.values()];
    this.#idle.clear();
    for (const callback of callbacks) callback();
    await Promise.resolve();
  }

  idleCount(): number {
    return this.#idle.size;
  }

  resize(target: Element, width: number, height: number): void {
    this.#resize?.(
      [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  }

  setHidden(hidden: boolean): void {
    this.#hidden = hidden;
    this.view.document.dispatchEvent(new Event("visibilitychange"));
  }

  setInputPending(pending: boolean): void {
    this.#inputPending = pending;
  }

  close(): void {
    this.#hiddenSpy?.mockRestore();
    this.#restoreIdle?.();
    this.#restoreScheduling?.();
    this.#restoreResizeObserver?.();
  }
}

export const it = base
  .extend("fakeTimers", { auto: true }, ({}, { onCleanup }) => {
    vi.useFakeTimers();
    onCleanup(() => {
      vi.useRealTimers();
    });
  })
  .extend("harness", ({}, { onCleanup }) => {
    const harness = new PaginationControllerHarness();
    harness.install();
    onCleanup(() => harness.close());
    return harness;
  });

export async function flushMicrotasks(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

export const preferences: PresentationPreferences = {
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
};

type ControllerOptions = ConstructorParameters<typeof BookPaginationController>[0];

export function mountContainer(rectangle?: { width: number; height: number }): HTMLDivElement {
  const container = document.createElement("div");
  if (rectangle !== undefined) container.getBoundingClientRect = () => rectangle as DOMRect;
  document.body.append(container);
  onTestFinished(() => container.remove());
  return container;
}

export function mountController(
  options: Partial<ControllerOptions> = {},
): BookPaginationController {
  const publication = options.facts ?? facts();
  const controller = new BookPaginationController({
    facts: publication,
    container: options.container ?? mountContainer(),
    preferences,
    createMeasurementRuntime: null,
    eligibleResourcePaths: publication.resources.resources.map(
      (resource) => resource.address.value,
    ),
    cacheIdentity: { measurementArtifactDigest: "a".repeat(64) },
    ...options,
  });
  onTestFinished(() => controller.close());
  return controller;
}

export function runtimeSnapshot(pending: boolean, committedLayout: boolean): KernelSnapshot {
  const snapshot = occurrenceSnapshot(0, committedLayout, 3);
  snapshot.document.pending = pending ? pendingDocument(2, 0) : null;
  return snapshot;
}

export function occurrenceSnapshot(
  occurrence: number,
  committedLayout: boolean,
  pageCount = 3,
): KernelSnapshot {
  const frame = {
    generation: occurrence + 1,
    occurrence,
    resource: `EPUB/chapter-${occurrence + 1}.xhtml`,
    adapter: "reflowable-xhtml" as const,
  };
  const observation = documentObservation();
  return {
    stateRevision: 1,
    session: "open",
    publicationLayout: "ordinary",
    packagePath: "EPUB/package.opf",
    readingOrderLength: occurrence + 1,
    readingOrder: kernelReadingOrder(occurrence + 1),
    document: {
      pending: null,
      fixedCompanion: null,
      committed: committedLayout
        ? {
            generation: occurrence + 1,
            frame,
            supportedOperations: [],
            layout: {
              state: "settled",
              layout: {
                documentGeneration: occurrence + 1,
                layoutGeneration: occurrence + 1,
                settlement: reflowableAdapterSettlement(pageCount, observation),
              },
              observation,
            },
          }
        : null,
    },
    preparedFrames: [],
    pendingAgentOperations: [],
    decorations: {
      projection: { revision: 0, records: [] },
      participantOutcomes: [],
      recordPositions: [],
    },
    layout: {
      preferences,
      layoutGeneration: occurrence + 1,
      pending: null,
    },
  } satisfies KernelSnapshot;
}

export function fixedOccurrenceSnapshot(
  occurrence: number,
  adapter: "fixed-xhtml" | "fixed-svg" = "fixed-xhtml",
): KernelSnapshot {
  const snapshot = occurrenceSnapshot(occurrence, true, 1);
  const committed = snapshot.document.committed!;
  const observation = documentObservation();
  const resource = `EPUB/chapter-${occurrence + 1}.${adapter === "fixed-svg" ? "svg" : "xhtml"}`;
  committed.frame.resource = resource;
  committed.frame.adapter = adapter;
  snapshot.readingOrder[occurrence]!.document = { state: "loadable", resource, adapter };
  const settlement: FixedSettlement = {
    mode: "contain",
    measurement: {
      observation,
      logicalViewport: { inline: 800, block: 600 },
      logicalContentExtent: { inline: 800, block: 600 },
      normalizedPosition: 0,
      physicalMovement: { x: 0, y: 0 },
      requiredFonts: "timed-out",
      requiredResources: "failed",
    },
    geometry: {
      intrinsicViewport: observation.viewport,
      containingViewport: observation.viewport,
      scale: 1,
      renderedWidth: observation.viewport.width,
      renderedHeight: observation.viewport.height,
      offsetX: 0,
      offsetY: 0,
    },
  };
  committed.layout.layout.settlement =
    adapter === "fixed-svg"
      ? { adapter: "fixed-svg", settlement }
      : { adapter: "fixed-xhtml", settlement };
  return snapshot;
}

function documentObservation() {
  return {
    writingMode: "horizontal-tb" as const,
    direction: "ltr" as const,
    language: "en",
    viewport: { width: 800, height: 600 },
    canvas: { state: "unavailable" as const },
    visibleStart: { state: "unavailable" as const },
    visibleEnd: { state: "unavailable" as const },
    renderedTextProgression: 0,
    pagination: null,
  };
}

function reflowableAdapterSettlement(
  pageCount: number,
  observation: ReturnType<typeof documentObservation>,
): AdapterLayoutSettlement {
  return {
    adapter: "reflowable-xhtml",
    requested: preferences,
    mode: "paginated",
    notice: null,
    alignXCenter: false,
    position: { kind: "progression", normalizedProgression: 0 },
    settlement: {
      mode: "paginated",
      measurement: {
        observation,
        logicalViewport: { inline: 800, block: 600 },
        logicalContentExtent: { inline: 800 * pageCount, block: 600 },
        normalizedPosition: 0,
        physicalMovement: { x: 1, y: 0 },
        requiredFonts: "loaded",
        requiredResources: "loaded",
      },
      pages: {
        spreadStride: 800,
        columnOrigin: 0,
        columnWidth: 800,
        columnGap: 0,
        columnPitch: 800,
        firstVisiblePage: 0,
        pageCount,
        visiblePageCount: 1,
        columnsPerView: 1,
        layoutRepairs: { status: "no-issues-detected" },
      },
    },
  };
}

export function pendingDocument(generation: number, occurrence: number): PendingDocument {
  return {
    generation,
    state: {
      state: "loading",
      frame: {
        generation,
        occurrence,
        resource: `EPUB/chapter-${occurrence + 1}.xhtml`,
        adapter: "reflowable-xhtml",
      },
    },
  };
}

export function pendingLayout(
  documentGeneration: number,
  layoutGeneration: number,
): PendingLayoutOperation {
  return {
    operation: layoutGeneration,
    frameGeneration: documentGeneration,
    layoutGeneration,
    owner: { kind: "document", documentGeneration, phase: "update" },
    adapter: {
      adapter: "reflowable-xhtml",
      requested: preferences,
      mode: "paginated",
      notice: null,
      alignXCenter: false,
      position: { kind: "progression", normalizedProgression: 0 },
    },
  };
}

export function committedLayout(snapshot: KernelSnapshot): CommittedLayout {
  const layout = snapshot.document.committed?.layout.layout;
  if (layout === undefined) throw new Error("expected committed layout");
  return layout;
}

export function paginated(
  source: KernelSnapshot | CommittedLayout,
): Extract<ReflowableSettlement, { mode: "paginated" }> {
  const layout = "settlement" in source ? source : committedLayout(source);
  if (layout.settlement.adapter !== "reflowable-xhtml") {
    throw new Error("expected reflowable settlement");
  }
  const settlement = layout.settlement.settlement;
  if (settlement.mode !== "paginated") throw new Error("expected paginated settlement");
  return settlement;
}

export function unresolvedLayoutRepairs(snapshot: KernelSnapshot): KernelSnapshot {
  paginated(snapshot).pages.layoutRepairs = {
    status: "unresolved",
    repairedElements: 0,
    unresolvedElements: 1,
  };
  return snapshot;
}

export function relayout(snapshot: KernelSnapshot, layoutGeneration = 2): KernelSnapshot {
  committedLayout(snapshot).layoutGeneration = layoutGeneration;
  return snapshot;
}

function kernelReadingOrder(count: number): ReadingOrderOccurrence[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    ordinal,
    target: { state: "declaration", declaration: ordinal, resource: ordinal },
    selectedDeclaration: ordinal,
    linear: "yes",
    presentation: unspecifiedPresentation(),
    document: {
      state: "loadable",
      resource: `EPUB/chapter-${ordinal + 1}.xhtml`,
      adapter: "reflowable-xhtml",
    },
  }));
}

function unspecifiedPresentation() {
  return {
    layout: { state: "unspecified" },
    flow: { state: "unspecified" },
    orientation: { state: "unspecified" },
    spread: { state: "unspecified" },
    pageSpread: { state: "unspecified" },
    pageProgressionDirection: null,
    alignXCenter: false,
  } as const;
}

export function pageRecord(pageCount: number, settled = true): Uint8Array {
  return encodeRecord({ type: "page-count", revision: 1, pageCount, columnsPerView: 1, settled });
}

export function encodeRecord(value: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeRecord(bytes: Uint8Array | undefined): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

type CacheMocks = {
  [K in keyof PaginationMeasurementCache]-?: Mock<NonNullable<PaginationMeasurementCache[K]>>;
};

export function cacheStub<K extends keyof CacheMocks = never>(
  overrides?: Pick<Required<PaginationMeasurementCache>, K>,
): Pick<CacheMocks, "read" | "write" | "removeBasis" | K> {
  const methods: Partial<PaginationMeasurementCache> = {
    read: async () => null,
    write: async () => {},
    removeBasis: async () => {},
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [name, vi.fn(method)]),
  ) as unknown as Pick<CacheMocks, "read" | "write" | "removeBasis" | K>;
}

export function memoryPaginationCache() {
  const records = new Map<string, Uint8Array>();
  return {
    records,
    pageRecords: () =>
      [...records.values()].map(decodeRecord).filter((record) => record.type === "page-count"),
    read: vi.fn<PaginationMeasurementCache["read"]>(
      async (basis, record) => records.get(`${basis}:${record}`) ?? null,
    ),
    write: vi.fn<PaginationMeasurementCache["write"]>(async (basis, record, value) => {
      records.set(`${basis}:${record}`, value.slice());
    }),
    remove: vi.fn<NonNullable<PaginationMeasurementCache["remove"]>>(async (basis, record) => {
      records.delete(`${basis}:${record}`);
    }),
    removeBasis: vi.fn<PaginationMeasurementCache["removeBasis"]>(async (basis) => {
      for (const key of records.keys()) if (key.startsWith(`${basis}:`)) records.delete(key);
    }),
  };
}

export function facts(
  count = 1,
  adapter: "reflowable-xhtml" | "fixed-xhtml" | "fixed-svg" = "reflowable-xhtml",
): PublicationFacts {
  const extension = adapter === "fixed-svg" ? "svg" : "xhtml";
  return {
    navigation: null,
    navigationTargets: [],
    resources: {
      resources: Array.from({ length: count }, (_, ordinal) => ({
        address: { kind: "local", value: `EPUB/chapter-${ordinal + 1}.${extension}` },
        presence: { state: "present", sizeBytes: null },
        declarations: [ordinal],
        hasXhtmlDeclaration: adapter !== "fixed-svg",
        hasStylesheetDeclaration: false,
        hasSvgDeclaration: adapter === "fixed-svg",
        scripted: false,
      })),
      readingOrder: Array.from({ length: count }, (_, ordinal) => ({
        idref: `chapter-${ordinal + 1}`,
        target: { state: "declaration", value: ordinal },
        resource: ordinal,
        linear: "yes",
        presentation: unspecifiedPresentation(),
        document: {
          state: "loadable",
          resource: `EPUB/chapter-${ordinal + 1}.${extension}`,
          adapter,
        },
      })),
    },
  } as unknown as PublicationFacts;
}

interface TocFixture {
  readonly count?: number;
  readonly resource?: number;
  readonly targets?: number;
  readonly adapter?: "reflowable-xhtml" | "fixed-xhtml";
}

export function factsWithToc({
  count = 1,
  resource = 0,
  targets = 1,
  adapter = "reflowable-xhtml",
}: TocFixture = {}): PublicationFacts {
  const value = facts(count, adapter) as unknown as {
    navigation: unknown;
    navigationTargets: unknown[];
  };
  value.navigation = {
    lists: [
      {
        semantic: "toc",
        points: Array.from({ length: targets }, () => ({ hidden: false, children: [] })),
      },
    ],
  };
  value.navigationTargets = Array.from({ length: targets }, (_, index) =>
    tocTarget(0, [index], resource, targets === 1 ? "section" : `section-${index}`),
  );
  return value as unknown as PublicationFacts;
}

export function tocTarget(
  listIndex: number,
  pointPath: number[],
  resource: number,
  fragment: string | null,
) {
  return {
    listIndex,
    pointPath,
    target: { state: "resource", resource, fragment },
  };
}

export function locateTargets(physicalPage = 0) {
  return async (
    targets: readonly TocTargetMeasurementRequest[],
  ): Promise<readonly TocTargetMeasurementResult[]> =>
    targets.map((target) => ({
      listIndex: target.listIndex,
      pointPath: target.pointPath,
      result: { state: "located", physicalPage },
    }));
}

export const acceptedTransition = (): KernelTransition =>
  ({ accepted: true, effects: [], events: [] }) as unknown as KernelTransition;

type TestMeasurementRuntime = NavigatorRuntime & {
  publish(snapshot: KernelSnapshot | null, events?: readonly unknown[]): void;
};

export function measurementRuntime(): TestMeasurementRuntime {
  const listeners = new Set<NavigatorTransitionListener>();
  let value = runtimeSnapshot(false, false);
  const runtime = {
    open: vi.fn(acceptedTransition),
    close: vi.fn(),
    snapshot: () => value,
    subscribe: (listener: NavigatorTransitionListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeErrors: () => () => {},
    setPresentationPreferences: vi.fn(),
    measureTocTargets: vi.fn(async () => []),
    publish(snapshot: KernelSnapshot | null, events: readonly unknown[] = []) {
      if (snapshot !== null) value = snapshot;
      for (const listener of [...listeners]) listener({ events } as never);
    },
  };
  return runtime as unknown as TestMeasurementRuntime;
}

interface TestResourceSettlement {
  readonly font?: "loaded" | "failed" | "timed-out";
  readonly resource?: "loaded" | "failed" | "timed-out";
}

export function automaticMeasurementRuntime(
  measureTargets: (
    targets: readonly TocTargetMeasurementRequest[],
  ) => Promise<readonly TocTargetMeasurementResult[]> = async () => [],
  settlement: TestResourceSettlement = {},
): TestMeasurementRuntime & {
  relayout(occurrence: number, pageCount: number): void;
  setSettlement(settlement: TestResourceSettlement): void;
} {
  const runtime = measurementRuntime();
  let current = settlement;
  const pageCounts = new Map<number, number>();
  const settled = (occurrence: number, pageCount: number) => {
    const value = occurrenceSnapshot(occurrence, true, pageCount);
    paginated(value).measurement.requiredFonts = current.font ?? "loaded";
    paginated(value).measurement.requiredResources = current.resource ?? "loaded";
    return value;
  };
  vi.mocked(runtime.open).mockImplementation((occurrence: number) => {
    runtime.publish(settled(occurrence, pageCounts.get(occurrence) ?? 3));
    return acceptedTransition();
  });
  runtime.measureTocTargets = vi.fn(measureTargets);
  return Object.assign(runtime, {
    relayout(occurrence: number, pageCount: number) {
      pageCounts.set(occurrence, pageCount);
      runtime.publish(relayout(settled(occurrence, pageCount), occurrence + 2));
    },
    setSettlement(next: TestResourceSettlement) {
      current = { ...current, ...next };
    },
  });
}
