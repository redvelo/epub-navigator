import type { SelectionGesture } from "../../src/generated/kernel";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, vi } from "vitest";
import type {
  AdapterLayoutSettlement,
  DecorationProjection,
  DocumentAdapter,
  DocumentObservation,
  KernelSnapshot,
  KernelTransition,
  LayoutMeasurement,
  NavigatorLocationSnapshot,
  ReflowableLayoutMode,
  LayoutRepairReport,
} from "../../src/generated/kernel";
import type { MountedPublication, NavigatorReaderSession } from "../../src/publication";
import {
  NavigatorReader,
  type NavigatorReaderPreferences,
  type NavigatorReaderProps,
} from "../../src/react/index.js";
import type {
  FixedViewState,
  MediaOverlayActiveResult,
  MediaOverlayActiveTarget,
  MediaOverlayEntryResult,
  NavigatorActivationListener,
  NavigatorDecorationActivationListener,
  NavigatorDecorationListener,
  NavigatorErrorListener,
  NavigatorExternalFormAttemptListener,
  NavigatorFootnoteListener,
  NavigatorInteractionListener,
  NavigatorLocationListener,
  NavigatorRuntime,
  NavigatorSelectionListener,
  NavigatorSelectionSnapshot,
  NavigatorTransitionListener,
  PresentationAdvanceResult,
  VisibleOccurrenceRange,
} from "../../src/runtime/navigator/api.js";
import type {
  BookPaginationSnapshot,
  OccurrencePagination,
  PaginationSnapshotListener,
  PublicationPaginationCapabilities,
} from "../../src/runtime/pagination/index";
import type { PublicationSearchCapabilities } from "../../src/runtime/search";

// Mocks registered here only apply to modules loaded after this one, so test files import this
// harness before anything that loads the reader.
const mocks = vi.hoisted(() => ({ createNavigatorRuntime: vi.fn() }));
vi.mock("../../src/runtime/navigator/browser-runtime", async (importOriginal) => ({
  ...(await importOriginal()),
  createNavigatorRuntime: mocks.createNavigatorRuntime,
}));
export const createNavigatorRuntime = mocks.createNavigatorRuntime;

if (window.PointerEvent === undefined) {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  });
}

const pointerQueries = new Set<PointerQueryList>();
let touchPrimary = false;

class PointerQueryList extends EventTarget {
  readonly media: string;
  constructor(media: string) {
    super();
    this.media = media;
    pointerQueries.add(this);
  }
  get matches(): boolean {
    if (this.media === "(any-hover: hover)") return !touchPrimary;
    return (
      (this.media === "(pointer: coarse)" || this.media === "(any-pointer: coarse)") && touchPrimary
    );
  }
  addListener(): void {}
  removeListener(): void {}
}

window.matchMedia = ((media: string) =>
  new PointerQueryList(media)) as unknown as typeof window.matchMedia;

/** Selects the reader layout profile the way a browser does, through the primary pointer. */
export function setReaderProfile(profile: "compact" | "workspace" | undefined): void {
  if (profile === undefined) return;
  touchPrimary = profile === "compact";
  for (const query of pointerQueries) query.dispatchEvent(new Event("change"));
}

afterEach(() => {
  cleanup();
  pointerQueries.clear();
  touchPrimary = false;
  createNavigatorRuntime.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const presentationPreferences = {
  mode: "auto",
  paginationColumns: "auto",
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
} as const;

export const readerPreferences = (
  overrides: Partial<NavigatorReaderPreferences> = {},
): NavigatorReaderPreferences => ({
  colorScheme: "light",
  presentationMode: "paginated",
  paginationColumns: "auto",
  publicationTheme: "original",
  publicationTypeface: "original",
  fontScale: "100",
  lineHeight: "original",
  letterSpacing: "0",
  wordSpacing: "0",
  paragraphSpacing: "original",
  textIndent: "original",
  measure: "full-width",
  alignment: "original",
  hyphenation: "original",
  keyboardMode: "standard",
  touchZones: true,
  narrationRate: "1",
  narrationSkippedTypes: [],
  ...overrides,
});

const paginationBasis: BookPaginationSnapshot["basis"] = {
  viewport: { width: 800, height: 600 },
  preferences: presentationPreferences,
  userAgent: "test",
  devicePixelRatio: 1,
};

export const readerSession = (mounted = publication()): NavigatorReaderSession => ({
  id: crypto.randomUUID(),
  publication: mounted,
});

export const readerRegion = (title = "A Small Book") =>
  screen.getByRole("region", { name: `${title} reader` });

export const publicationHost = () =>
  screen.getByRole("main", { name: "Publication reading area" }).firstElementChild as HTMLElement;

/** Reader props plus the layout profile, which the browser reports through the primary pointer. */
export type RenderReaderProps = Partial<NavigatorReaderProps> & {
  readonly profile?: "compact" | "workspace";
};

export async function renderReader(props: RenderReaderProps = {}, runtime = new FakeRuntime()) {
  createNavigatorRuntime.mockResolvedValue(runtime);
  const { profile, ...readerProps } = props;
  setReaderProfile(profile);
  const session = props.session ?? readerSession();
  const view = render(<NavigatorReader {...readerProps} session={session} />);
  await waitFor(() => expect(runtime.open).toHaveBeenCalledWith(0));
  return {
    ...view,
    runtime,
    session,
    rerender: ({ profile: next, ...nextProps }: RenderReaderProps = {}) =>
      act(() => {
        setReaderProfile(next);
        view.rerender(<NavigatorReader session={session} {...nextProps} />);
      }),
  };
}

export async function openQuickMenu() {
  await userEvent.click(screen.getByRole("button", { name: /^Open quick menu/u }));
  return screen.findByRole("dialog", { name: "Quick Menu" });
}

export async function openReadingSettings() {
  await openQuickMenu();
  await userEvent.click(await screen.findByRole("button", { name: /^Settings$/u }));
  return screen.findByRole("dialog", { name: "Reading settings" });
}

export async function openNavigation() {
  await userEvent.click(screen.getByRole("button", { name: /^(Open navigation|Navigation)$/u }));
  return screen.findByRole("dialog", { name: "Navigation" });
}

export function measurement(observation: DocumentObservation): LayoutMeasurement {
  return {
    observation,
    logicalViewport: { inline: 600, block: 800 },
    logicalContentExtent: { inline: 600, block: 2400 },
    normalizedPosition: 0,
    physicalMovement: { x: 1, y: 0 },
    requiredFonts: "loaded",
    requiredResources: "loaded",
  };
}

function reflowableSettlement(
  observation: DocumentObservation,
  layoutRepairs: LayoutRepairReport,
  mode: ReflowableLayoutMode,
  pageCount: number,
  firstVisiblePage = 0,
  visiblePageCount = 1,
): Extract<AdapterLayoutSettlement, { adapter: "reflowable-xhtml" }> {
  return {
    adapter: "reflowable-xhtml",
    requested: presentationPreferences,
    mode,
    notice: null,
    alignXCenter: false,
    position: { kind: "progression", normalizedProgression: 0 },
    settlement:
      mode === "paginated"
        ? {
            mode,
            measurement: measurement(observation),
            pages: {
              spreadStride: 600,
              columnOrigin: 0,
              columnWidth: 600,
              columnGap: 0,
              columnPitch: 600,
              firstVisiblePage,
              pageCount,
              visiblePageCount,
              columnsPerView: visiblePageCount,
              layoutRepairs,
            },
          }
        : { mode, measurement: measurement(observation) },
  };
}

function fixedAdapterSettlement(
  adapter: Exclude<DocumentAdapter, "reflowable-xhtml">,
  observation: DocumentObservation,
): Extract<AdapterLayoutSettlement, { adapter: "fixed-xhtml" | "fixed-svg" }> {
  const settlement = {
    mode: "contain" as const,
    measurement: measurement(observation),
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
  return adapter === "fixed-svg"
    ? { adapter: "fixed-svg", settlement }
    : { adapter: "fixed-xhtml", settlement };
}

export function paginationCapabilities(): PublicationPaginationCapabilities {
  return {
    responses: {
      mount: {
        baseUrl: "https://reader.invalid/measurements/book/",
        remoteResources: "blocked",
        contentOrigin: "shared-reader-origin",
      },
      eligibleResourcePaths: ["EPUB/chapter-1.xhtml"],
    },
    signal: new AbortController().signal,
    close: vi.fn(),
  };
}

export function exactPagination(
  pageCounts: readonly number[],
  foreground?: number,
): BookPaginationSnapshot {
  const starts = pageCounts.map((_, index) =>
    pageCounts.slice(0, index).reduce((sum, count) => sum + count, 0),
  );
  const total = pageCounts.reduce((sum, count) => sum + count, 0);
  const pageStart = (occurrence: number) => starts[occurrence] ?? null;
  return {
    runRevision: 1,
    basis: paginationBasis,
    freshness: "current",
    activity: "idle",
    foreground:
      foreground === undefined
        ? { state: "unavailable" }
        : {
            state: "current",
            occurrence: foreground,
            resource: `EPUB/chapter-${foreground + 1}.xhtml`,
            documentGeneration: foreground + 1,
            layoutGeneration: 1,
            pageCount: pageCounts[foreground]!,
          },
    pageCountCoverage: {
      state: "exact",
      measuredOccurrences: pageCounts.length,
      totalOccurrences: pageCounts.length,
      measuredPageCount: total,
      totalPageCount: total,
    },
    tocEnrichment: { state: "complete", measuredTargets: 0, totalTargets: 0 },
    state: "complete",
    cachePersistence: "idle",
    occurrences: pageCounts.map(
      (pageCount, occurrence): OccurrencePagination => ({
        occurrence,
        resource: `EPUB/chapter-${occurrence + 1}.xhtml`,
        state: "measured",
        pageCount,
        columnsPerView: 1,
        tocTargets: [],
        source: occurrence === foreground ? "foreground" : "background",
      }),
    ),
    measuredPageCount: total,
    totalPageCount: total,
    pageStart,
    estimatedTotalPageCount: total,
    estimatedPageStart: pageStart,
    estimatedPageCount: () => null,
  };
}

export function searchCapabilities(
  scopes: PublicationSearchCapabilities["scopes"] = ["publication", "occurrence"],
): PublicationSearchCapabilities {
  const search = vi.fn(async (request: Parameters<PublicationSearchCapabilities["search"]>[0]) => ({
    status: "completed" as const,
    batch: {
      requestId: request.requestId,
      results: [
        {
          id: "result-1",
          section: {
            id: "section-1",
            occurrence: 0,
            resource: "EPUB/chapter-1.xhtml",
            label: "Chapter one",
          },
          targetJson: JSON.stringify({ type: "Annotation", target: "match" }),
          excerpt: {
            before: "Before ",
            match: request.query,
            after: " after",
          },
        },
      ],
      coverage: {
        state: "complete" as const,
        searchedOccurrences: 2,
        totalOccurrences: 2,
      },
      continuation: null,
      totalResultCount: 1,
    },
  }));
  return {
    scopes,
    signal: new AbortController().signal,
    search,
    close: vi.fn(),
  };
}

export function transition(events: KernelTransition["events"]): KernelTransition {
  return {
    accepted: true,
    stateRevision: 1,
    events,
    effects: [],
    failure: null,
  };
}

const unspecifiedPresentation = {
  layout: { state: "unspecified" },
  flow: { state: "unspecified" },
  orientation: { state: "unspecified" },
  spread: { state: "unspecified" },
  pageSpread: { state: "unspecified" },
  pageProgressionDirection: null,
  alignXCenter: false,
} as const;

function snapshot(): KernelSnapshot {
  return {
    stateRevision: 0,
    session: "open",
    publicationLayout: "ordinary",
    packagePath: "EPUB/package.opf",
    readingOrderLength: 2,
    readingOrder: [0, 1].map((ordinal) => ({
      ordinal,
      target: {
        state: "declaration" as const,
        declaration: ordinal,
        resource: ordinal,
      },
      selectedDeclaration: ordinal,
      linear: "yes" as const,
      presentation: unspecifiedPresentation,
      document: {
        state: "loadable" as const,
        resource: `EPUB/chapter-${ordinal + 1}.xhtml`,
        adapter: "reflowable-xhtml" as const,
      },
    })),
    document: { pending: null, committed: null, fixedCompanion: null },
    preparedFrames: [],
    pendingAgentOperations: [],
    decorations: {
      projection: { revision: 0, records: [] },
      participantOutcomes: [],
      recordPositions: [],
    },
    layout: {
      preferences: presentationPreferences,
      layoutGeneration: 0,
      pending: null,
    },
  };
}

type NavPoint = NonNullable<
  MountedPublication["facts"]["navigation"]
>["lists"][number]["points"][number];

const navPoint = (label: string, authoredHref: string | null, children: NavPoint[] = []) => ({
  label,
  authoredHref,
  children,
  hidden: false,
  semantic: null,
  authoredSemanticTokens: [],
});

const localTarget = (resource: number, fragment: string | null = null) => ({
  state: "resource" as const,
  resource,
  fragment,
});

export function publication(flatToc = false): MountedPublication {
  const chapters = [
    navPoint("Chapter one", "chapter-1.xhtml"),
    navPoint("Chapter two", "chapter-2.xhtml"),
  ];
  const chapterTargets = (parent: number[]) =>
    [0, 1].map((index) => ({
      listIndex: 0,
      pointPath: [...parent, index],
      authoredHref: `chapter-${index + 1}.xhtml`,
      target: localTarget(index),
    }));
  const missing = (index: number) => ({
    listIndex: 0,
    pointPath: [index],
    authoredHref: null,
    target: { state: "missing-href" as const },
  });
  return {
    mount: {
      baseUrl: "https://reader.invalid/books/book/",
      remoteResources: "blocked",
      contentOrigin: "shared-reader-origin",
    },
    facts: {
      package: {
        metadata: {
          title: [{ content: "A Small Book" }],
          creator: [{ content: "Ada Reader" }],
          identifier: [{ content: "urn:book:small" }],
          description: [{ content: "A compact test publication." }],
          coverage: [{ content: "Not shown in curated details" }],
          language: [],
          contributor: [],
          date: [],
          format: [],
          publisher: [],
          relation: [],
          rights: [],
          source: [],
          subject: [],
          dcType: [],
          meta: [],
          opf2meta: [],
          link: [],
        },
      } as unknown as MountedPublication["facts"]["package"],
      navigation: {
        source: "epub-nav",
        authoredBase: null,
        path: "EPUB/nav.xhtml",
        lists: [
          {
            semantic: "toc",
            heading: null,
            hidden: false,
            points: flatToc
              ? chapters
              : [navPoint("Part one", null, chapters), navPoint("Unavailable", null)],
            authoredSemanticTokens: [],
          },
        ],
      },
      resources: {
        coverPath: "EPUB/images/front cover.svg",
        resources: [
          "EPUB/chapter-1.xhtml",
          "EPUB/chapter-2.xhtml",
          "EPUB/images/front cover.svg",
        ].map((value) => ({
          address: { kind: "local", value },
          presence: { state: "present", sizeBytes: null },
          declarations: [],
          hasXhtmlDeclaration: value.endsWith(".xhtml"),
          hasStylesheetDeclaration: false,
          hasSvgDeclaration: false,
          scripted: false,
        })),
        readingOrder: [0, 1].map((ordinal) => ({
          idref: `chapter-${ordinal}`,
          target: { state: "declaration", value: ordinal },
          resource: ordinal,
          linear: "yes",
          presentation: { ...unspecifiedPresentation },
        })),
        packagePath: "EPUB/package.opf",
        declarations: [],
        selections: {
          package: { state: "absent" },
          cover: {
            state: "selected",
            source: "cover-image-property",
            declaration: 2,
            resource: 2,
          },
          epubNav: { state: "absent" },
          ncx: { state: "absent" },
        },
      },
      navigationLoading: {} as MountedPublication["facts"]["navigationLoading"],
      navigationTargets: flatToc
        ? chapterTargets([])
        : [missing(0), ...chapterTargets([0]), missing(1)],
    },
  };
}

export function publicationWithPageList(
  pages: readonly {
    readonly label: string;
    readonly chapter: number;
    readonly fragment?: string;
  }[],
): MountedPublication {
  const mounted = publication(true);
  const href = ({ chapter, fragment }: (typeof pages)[number]) =>
    `chapter-${chapter}.xhtml${fragment === undefined ? "" : `#${fragment}`}`;
  mounted.facts.navigation?.lists.push({
    semantic: "page-list",
    heading: { level: 2, text: "Pages" },
    hidden: false,
    points: pages.map((page) => navPoint(page.label, href(page))),
    authoredSemanticTokens: [],
  });
  pages.forEach((page, point) => {
    mounted.facts.navigationTargets.push({
      listIndex: 1,
      pointPath: [point],
      authoredHref: href(page),
      target: localTarget(page.chapter - 1, page.fragment ?? null),
    });
  });
  return mounted;
}

const primary = { kind: "primary", documentGeneration: 1 } as const;
const anchor = {
  rect: { x: 40, y: 80, width: 60, height: 20 },
  clippingRect: { x: 0, y: 0, width: 320, height: 480 },
};

function channel<Listener extends (value: never) => void>() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit: (value: Parameters<Listener>[0]) => {
      for (const listener of listeners)
        (listener as (value: Parameters<Listener>[0]) => void)(value);
    },
  };
}

export class FakeRuntime implements NavigatorRuntime {
  private readonly transitions = channel<NavigatorTransitionListener>();
  readonly errors = channel<NavigatorErrorListener>();
  readonly locations = channel<NavigatorLocationListener>();
  private readonly interactions = channel<NavigatorInteractionListener>();
  private readonly selections = channel<NavigatorSelectionListener>();
  private readonly decorations = channel<NavigatorDecorationListener>();
  private readonly decorationActivations = channel<NavigatorDecorationActivationListener>();
  private readonly activations = channel<NavigatorActivationListener>();
  private readonly externalFormAttempts = channel<NavigatorExternalFormAttemptListener>();
  private readonly footnotes = channel<NavigatorFootnoteListener>();
  private readonly pagination = channel<PaginationSnapshotListener>();

  readonly subscribe = this.transitions.subscribe;
  readonly subscribeErrors = this.errors.subscribe;
  readonly subscribeLocations = this.locations.subscribe;
  readonly subscribeInteractions = this.interactions.subscribe;
  readonly subscribeSelections = this.selections.subscribe;
  readonly subscribeDecorations = this.decorations.subscribe;
  readonly subscribeDecorationActivations = this.decorationActivations.subscribe;
  readonly subscribeActivations = this.activations.subscribe;
  readonly subscribeExternalFormAttempts = this.externalFormAttempts.subscribe;
  readonly subscribeFootnotes = this.footnotes.subscribe;
  readonly subscribePagination = this.pagination.subscribe;
  readonly subscribePresentationActivity = () => () => {};

  value: KernelSnapshot = snapshot();
  private fixedViewValue: FixedViewState | null = null;
  visibleRangeValue: VisibleOccurrenceRange | null = null;
  private selectionValue: NavigatorSelectionSnapshot = {
    revision: 0,
    selection: null,
  };
  locationValue: NavigatorLocationSnapshot = {
    revision: 0,
    location: null,
    basis: null,
    visibleOccurrences: null,
  };
  paginationValue: BookPaginationSnapshot = {
    ...exactPagination([]),
    pageCountCoverage: {
      state: "incomplete",
      measuredOccurrences: 0,
      totalOccurrences: 0,
      measuredPageCount: 0,
      totalPageCount: null,
    },
    state: "idle",
    totalPageCount: null,
    estimatedTotalPageCount: null,
    pageStart: () => null,
    estimatedPageStart: () => null,
  };

  readonly open = vi.fn((occurrence: number) => {
    this.footnotes.emit(null);
    const generation = this.value.stateRevision + 1;
    const resource = `EPUB/chapter-${occurrence + 1}.xhtml`;
    this.value = {
      ...this.value,
      document: {
        ...this.value.document,
        pending: {
          generation,
          state: {
            state: "loading",
            frame: {
              generation,
              occurrence,
              resource,
              adapter: "reflowable-xhtml",
            },
          },
        },
      },
    };
    return this.publish({
      type: "document-pending",
      generation,
      occurrence,
      resource,
    });
  });
  readonly previousOccurrence = vi.fn(() => {
    const committed = this.value.document.committed;
    if (committed === null) return null;
    const occurrence = (this.visibleRangeValue?.firstOccurrence ?? committed.frame.occurrence) - 1;
    return occurrence >= 0 ? occurrence : null;
  });
  readonly nextOccurrence = vi.fn(() => {
    const committed = this.value.document.committed;
    if (committed === null) return null;
    const occurrence = (this.visibleRangeValue?.lastOccurrence ?? committed.frame.occurrence) + 1;
    return occurrence < this.value.readingOrderLength ? occurrence : null;
  });
  readonly previous = vi.fn(() =>
    this.open((this.value.document.committed?.frame.occurrence ?? 1) - 1),
  );
  readonly next = vi.fn(() =>
    this.open((this.value.document.committed?.frame.occurrence ?? -1) + 1),
  );
  readonly reload = vi.fn(() => this.open(this.value.document.committed?.frame.occurrence ?? 0));
  readonly evictPreparedFrames = vi.fn(() => transition([]));
  readonly cancel = vi.fn(() => transition([]));
  readonly close = vi.fn(() => transition([{ type: "closed" }]));
  readonly attachFixedCompanion = vi.fn(
    (
      ownerDocumentGeneration: number,
      frameGeneration: number,
      placement: "left" | "right" | "center",
    ) => {
      const primaryOccurrence = this.value.document.committed?.frame.occurrence;
      if (
        primaryOccurrence === undefined ||
        ownerDocumentGeneration !== this.value.document.committed?.generation
      ) {
        return transition([]);
      }
      const companion = frameGeneration - 1;
      this.visibleRangeValue = {
        primaryOccurrence,
        firstOccurrence: Math.min(primaryOccurrence, companion),
        lastOccurrence: Math.max(primaryOccurrence, companion),
        companion: { occurrence: companion, placement },
      };
      return this.publish();
    },
  );
  readonly detachFixedCompanion = vi.fn(
    (_ownerDocumentGeneration: number, _frameGeneration: number) => {
      const occurrence = this.value.document.committed?.frame.occurrence;
      this.visibleRangeValue = occurrence === undefined ? null : singleOccurrence(occurrence);
      return this.publish();
    },
  );
  readonly resolve = vi.fn();
  readonly relocate = vi.fn(async (locator) => ({
    outcome: "completed" as const,
    status: { status: "resolved" as const },
    operation: 1,
    generation: this.value.document.committed?.generation ?? 0,
    occurrence: locator.occurrence,
    resource: locator.resource,
  }));
  readonly resolveAnnotationTarget = vi.fn(async () => ({
    outcome: "completed" as const,
    result: { outcome: "unsupported" as const, reports: [], segment: null },
    operation: 1,
    ...this.committedIdentity(),
  }));
  readonly relocateAnnotationTarget = this.resolveAnnotationTarget;
  readonly restoreAnnotationTarget = vi.fn<NavigatorRuntime["restoreAnnotationTarget"]>(
    async () => ({
      status: "failed",
      reason: "unavailable",
      message: "not implemented by test runtime",
    }),
  );
  readonly adjustAnnotationRange = vi.fn(async () => ({
    status: "unsupported" as const,
  }));
  readonly returnFromFootnote = vi.fn(async () => ({
    status: "returned" as const,
  }));
  readonly clearSelection = vi.fn();
  readonly advancePresentation = vi.fn<
    (direction: "forward" | "backward") => Promise<PresentationAdvanceResult>
  >(async () => ({
    outcome: "completed" as const,
    status: { status: "advanced" as const },
    operation: 2,
    ...this.committedIdentity(),
  }));
  readonly captureSelection = vi.fn(async () => ({
    outcome: "failed" as const,
    failure: {
      code: "operation-cancelled" as const,
      reason: "replacement" as const,
    },
    operation: 3,
    ...this.committedIdentity(),
  }));
  readonly generateSelectionAnnotationTarget = vi.fn(async () => ({
    outcome: "completed" as const,
    result: { status: "unsupported" as const },
    operation: 4,
    ...this.committedIdentity(),
  }));
  readonly generateCurrentLocationAnnotationTarget = vi.fn<
    NavigatorRuntime["generateCurrentLocationAnnotationTarget"]
  >(async () => ({
    outcome: "completed",
    result: { status: "unsupported" },
    operation: 4,
    ...this.committedIdentity(),
  }));
  readonly cancelSelectionAnnotationTargetGeneration = vi.fn(() => transition([]));
  readonly captureCurrentLocation = vi.fn<NavigatorRuntime["captureCurrentLocation"]>(async () => ({
    status: "unavailable",
    basis: null,
  }));
  readonly setDecorationProjection = vi.fn((projection: DecorationProjection) => {
    this.value = {
      ...this.value,
      decorations: {
        projection,
        participantOutcomes: [],
        recordPositions: [],
      },
    };
    this.decorations.emit(this.value.decorations);
  });
  readonly setActiveDecoration = vi.fn();
  readonly activateDecorationLink = vi.fn();
  readonly setMediaOverlayActive = vi.fn<
    (target: MediaOverlayActiveTarget | null) => Promise<MediaOverlayActiveResult>
  >(async (target) =>
    target === null
      ? { status: "cleared" as const }
      : {
          status: "applied" as const,
          visible: true,
          occurrence: target.occurrence,
        },
  );
  readonly findMediaOverlayEntry = vi.fn<
    (occurrence: number, fragments: readonly string[]) => Promise<MediaOverlayEntryResult>
  >(async () => ({ status: "found" as const, index: 0 }));
  readonly measureTocTargets = vi.fn<NavigatorRuntime["measureTocTargets"]>(async () => []);
  readonly observeDocument = vi.fn<NavigatorRuntime["observeDocument"]>(async () => ({
    document: {
      title: "",
      lang: "",
      dir: "",
      readyState: "complete",
      contentType: "application/xhtml+xml",
      svgRoot: false,
    },
    queries: [],
  }));
  readonly configure = vi.fn();
  readonly setPresentationPreferences = vi.fn(() => transition([]));
  readonly setPaginationCapabilities = vi.fn();
  readonly fixedViewState = vi.fn(() => this.fixedViewValue);
  readonly visibleOccurrenceRange = vi.fn(() => this.visibleRangeValue);
  finalSpreadLeadingOccurrenceValue: number | null = null;
  readonly finalSpreadLeadingOccurrence = vi.fn(() => this.finalSpreadLeadingOccurrenceValue);
  readonly setFixedZoom = vi.fn((zoom: number) => {
    if (this.fixedViewValue === null) return null;
    this.fixedViewValue = {
      ...this.fixedViewValue,
      zoom: Math.min(4, Math.max(1, zoom)),
    };
    return this.fixedViewValue;
  });
  readonly panFixedBy = vi.fn(() => this.fixedViewValue);

  snapshot() {
    return this.value;
  }

  currentSelection() {
    return this.selectionValue;
  }

  currentLocation() {
    return this.locationValue;
  }

  decorationSnapshot() {
    return this.value.decorations;
  }

  paginationSnapshot() {
    return this.paginationValue;
  }

  locate(occurrence: number, revision = this.locationValue.revision + 1) {
    this.emitLocation({
      revision,
      location: {
        kind: "point",
        occurrence,
        resource: `EPUB/chapter-${occurrence + 1}.xhtml`,
        evidence: [],
        observation: { layoutProgression: 0.25, renderedTextProgression: 0.25 },
      },
      basis: {
        documentGeneration: occurrence + 1,
        frameGeneration: occurrence + 1,
        layoutGeneration: 1,
      },
      visibleOccurrences: singleOccurrence(occurrence),
    });
  }

  emitLocation(value: NavigatorLocationSnapshot) {
    this.locationValue = value;
    this.locations.emit(value);
  }

  selectRange(exactText: string | null = null, gesture: SelectionGesture | null = null) {
    this.selectionValue = {
      revision: this.selectionValue.revision + 1,
      selection: {
        status: "captured",
        location: {
          kind: "range",
          occurrence: 0,
          resource: "EPUB/chapter-1.xhtml",
          evidence: [
            { kind: "browser-text-position", start: "0", end: "4" },
            ...(exactText === null
              ? []
              : [
                  {
                    kind: "rendered-text-quote" as const,
                    exact: exactText,
                    prefix: "",
                    suffix: "",
                  },
                ]),
          ],
          startObservation: {
            layoutProgression: 0,
            renderedTextProgression: 0,
          },
          endObservation: {
            layoutProgression: 0.1,
            renderedTextProgression: 0.1,
          },
        },
        direction: "forward",
        language: "en",
        anchor,
        gesture,
        basis: {
          participant: primary,
          frameGeneration: 1,
          layoutGeneration: 1,
          localContentBasis: 1,
          localGeometryBasis: 1,
        },
      },
    };
    this.selections.emit(this.selectionValue);
  }

  attemptExternalForm() {
    this.externalFormAttempts.emit({
      participant: primary,
      action: "https://forms.invalid/submit",
      resolvedUrl: "https://forms.invalid/submit",
      method: "post",
      target: null,
    });
  }

  paginate(value: BookPaginationSnapshot) {
    this.paginationValue = value;
    this.pagination.emit(value);
  }

  interact(command: "previous" | "next") {
    this.interactions.emit({
      participant: primary,
      command,
      source: "keyboard",
    });
  }

  activate(internal: boolean, footnoteActivationId: number | null = null) {
    const footnote =
      footnoteActivationId === null
        ? null
        : {
            activationId: footnoteActivationId,
            occurrence: 0,
            resource: "EPUB/chapter-1.xhtml",
          };
    this.activations.emit({
      participant: primary,
      href: internal ? "chapter-2.xhtml" : "https://example.com/",
      resolvedUrl: internal
        ? "https://reader.invalid/books/book/EPUB/chapter-2.xhtml"
        : "https://example.com/",
      target: null,
      download: null,
      internal,
      noteReference: null,
      footnote,
    });
    this.footnotes.emit(footnote);
  }

  /** A reference to a note the reader is to show where the page is, the agent having measured it. */
  activateNoteReference(label: string | null = "1") {
    this.activations.emit({
      participant: primary,
      href: "notes.xhtml#n1",
      resolvedUrl: "https://reader.invalid/books/book/EPUB/notes.xhtml#n1",
      target: null,
      download: null,
      internal: true,
      noteReference: {
        referenceRect: { x: 40, y: 80, width: 8, height: 12 },
        referenceLabel: label,
      },
      footnote: null,
    });
  }

  activateDecoration(ids: readonly string[], link = false) {
    this.decorationActivations.emit({
      participant: primary,
      projectionRevision: this.value.decorations.projection.revision,
      ids,
      anchor,
      link: link
        ? {
            href: "chapter-2.xhtml",
            resolvedUrl: "https://reader.invalid/books/book/EPUB/chapter-2.xhtml",
            target: null,
            download: null,
          }
        : null,
    });
  }

  makeFirstOccurrenceUnavailable(
    document: Extract<KernelSnapshot["readingOrder"][number]["document"], { state: "unavailable" }>,
  ) {
    this.value = {
      ...this.value,
      readingOrder: this.value.readingOrder.map((occurrence, ordinal) =>
        ordinal === 0 ? { ...occurrence, document } : occurrence,
      ),
      document: { committed: null, pending: null, fixedCompanion: null },
    };
    this.publish();
  }

  commit(occurrence: number, adapter: DocumentAdapter = "reflowable-xhtml") {
    const resource = `EPUB/chapter-${occurrence + 1}.${adapter === "fixed-svg" ? "svg" : "xhtml"}`;
    const observation = {
      writingMode: "horizontal-tb" as const,
      direction: "ltr" as const,
      language: "en",
      viewport: { width: 600, height: 800 },
      canvas: { state: "solid-color" as const, cssColor: "rgb(255, 255, 255)" },
      visibleStart: { state: "unavailable" as const },
      visibleEnd: { state: "unavailable" as const },
      renderedTextProgression: 0.42,
      pagination: null,
    };
    const settlement =
      adapter === "reflowable-xhtml"
        ? reflowableSettlement(observation, { status: "no-issues-detected" }, "paginated", 1)
        : fixedAdapterSettlement(adapter, observation);
    this.value = {
      ...this.value,
      document: {
        pending: null,
        fixedCompanion: null,
        committed: {
          generation: occurrence + 1,
          frame: { generation: occurrence + 1, occurrence, resource, adapter },
          supportedOperations: ["resolve-locator", "relocate"],
          layout: {
            state: "settled",
            layout: {
              documentGeneration: occurrence + 1,
              layoutGeneration: this.value.layout.layoutGeneration + 1,
              settlement,
            },
            observation,
          },
        },
      },
    };
    const fixed = adapter === "fixed-xhtml" || adapter === "fixed-svg";
    this.fixedViewValue = fixed
      ? { zoom: 1, minimumZoom: 1, maximumZoom: 4, panX: 0, panY: 0 }
      : null;
    this.visibleRangeValue = fixed ? singleOccurrence(occurrence) : null;
    this.publish({
      type: "document-committed",
      generation: occurrence + 1,
      occurrence,
      resource,
    });
  }

  setPreparedLayoutPending() {
    this.value = {
      ...this.value,
      layout: {
        ...this.value.layout,
        pending: {
          operation: 17,
          frameGeneration: 2,
          layoutGeneration: this.value.layout.layoutGeneration + 1,
          owner: { kind: "prepared-frame" },
          adapter: {} as never,
        },
      },
    };
    this.publish();
  }

  observePagination(firstVisiblePage: number, pageCount: number, visiblePageCount: number) {
    const committed = this.value.document.committed!;
    const current = committed.layout.layout.settlement;
    if (current.adapter !== "reflowable-xhtml") throw new Error("reflowable layout required");
    const observation = committed.layout.observation;
    const settlement = reflowableSettlement(
      observation,
      current.settlement.mode === "paginated"
        ? current.settlement.pages.layoutRepairs
        : { status: "no-issues-detected" },
      "paginated",
      pageCount,
      firstVisiblePage,
      visiblePageCount,
    );
    this.value = {
      ...this.value,
      document: {
        ...this.value.document,
        committed: {
          ...committed,
          layout: {
            ...committed.layout,
            layout: { ...committed.layout.layout, settlement },
          },
        },
      },
    };
    this.publish({
      type: "document-observed",
      participant: {
        kind: "primary",
        documentGeneration: committed.generation,
      },
      generation: committed.generation,
      observation,
    });
  }

  settleLayout(
    layoutRepairs: LayoutRepairReport,
    mode: ReflowableLayoutMode = "paginated",
    pageCount = 3,
  ) {
    const committed = this.value.document.committed!;
    const previous = committed.layout.layout.settlement;
    const previousPages =
      previous.adapter === "reflowable-xhtml" && previous.settlement.mode === "paginated"
        ? previous.settlement.pages
        : null;
    const layoutGeneration = this.value.layout.layoutGeneration + 1;
    const settlement = reflowableSettlement(
      committed.layout.observation,
      layoutRepairs,
      mode,
      pageCount,
      previousPages?.firstVisiblePage ?? 0,
      previousPages?.visiblePageCount ?? 1,
    );
    this.value = {
      ...this.value,
      layout: { ...this.value.layout, layoutGeneration },
      document: {
        ...this.value.document,
        committed: {
          ...committed,
          layout: {
            state: "settled",
            observation: committed.layout.observation,
            layout: {
              documentGeneration: committed.generation,
              layoutGeneration,
              settlement,
            },
          },
        },
      },
    };
    this.publish({
      type: "layout-reported",
      participant: {
        kind: "primary",
        documentGeneration: committed.generation,
      },
      operation: 1,
      generation: committed.generation,
      layoutGeneration,
      result: {
        adapter: "reflowable-xhtml",
        outcome: { status: "settled", settlement: settlement.settlement },
      },
    });
  }

  fail(reason: "load-error" | "readiness-timeout" | "unexpected-navigation") {
    const generation = this.value.document.pending?.generation ?? 1;
    this.value = {
      ...this.value,
      document: { ...this.value.document, pending: null },
    };
    this.publish({
      type: "document-load-failed",
      generation,
      reason: { reason },
    });
  }

  invalidate() {
    const generation = this.value.document.committed!.generation;
    this.value = {
      ...this.value,
      document: { ...this.value.document, committed: null, pending: null },
    };
    this.publish({
      type: "document-invalidated",
      participant: { kind: "primary", documentGeneration: generation },
      generation,
      reason: "unexpected-navigation",
    });
  }

  publish(...events: KernelTransition["events"]) {
    const value = transition(events);
    this.transitions.emit(value);
    return value;
  }

  private committedIdentity() {
    const committed = this.value.document.committed;
    return {
      generation: committed?.generation ?? 0,
      occurrence: committed?.frame.occurrence ?? 0,
      resource: committed?.frame.resource ?? "EPUB/chapter-1.xhtml",
    };
  }
}

function singleOccurrence(occurrence: number): VisibleOccurrenceRange {
  return {
    primaryOccurrence: occurrence,
    firstOccurrence: occurrence,
    lastOccurrence: occurrence,
    companion: null,
  };
}
