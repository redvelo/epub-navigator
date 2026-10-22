import type { PublicationTypeface } from "../generated/kernel.js";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Provider, createStore, useAtomValue, useSetAtom, useStore } from "jotai";
import type { KernelSnapshot, ReadingOrderOccurrence } from "../generated/kernel.js";
import type { NavigatorRuntime } from "../runtime/navigator/api.js";
import { fixedCompanionDocument } from "../runtime/kernel-view.js";

import {} from "./progress/projection.js";
import { publicationCoverUrl } from "./publication-details.js";
import {
  currentSectionLabel,
  projectAuthoredNavigation,
  progressMarkerPoints,
} from "./navigation/model.js";

import type { NavigatorLinkActivation, NavigatorReaderProps } from "./public-types.js";
import { useContainedVisualViewportStyle } from "./compact/visual-viewport.js";
import { useCornerClearance } from "./compact/corner-clearance.js";
import { workspacePanelPinAvailability } from "./workspace/layout.js";
import { useCompactReader, useContainerWidth } from "./workspace/responsive.js";
import { hostFullscreen, useReaderFullscreen } from "./input/fullscreen.js";
import { usePublicationFocusRestoration } from "./input/focus-restoration.js";
import { useReaderInput } from "./input/reader-input.js";
import { turnPaginatedSurface } from "./surface-pager.js";
import type { ReaderCommand } from "../runtime/reader-commands.js";
import { ShortcutHelp } from "./input/shortcut-help.js";
import { visiblePrimaryPublicationFrame } from "./input/focus.js";
import { useNoteSurface } from "./notes/controller.js";
import { NotePopover, NoteSheet } from "./notes/surfaces.js";
import { selectionExcerpt } from "./annotations/helpers.js";
import { captureReadingPosition } from "./runtime/reading-position.js";
import { useRuntimePreferences } from "./runtime/preferences.js";
import { useRuntimeSession } from "./runtime/session.js";
import { useControlledAnnotationProjection } from "./annotations/controlled-projection.js";
import { resolvedMetadataDirection } from "./lib/metadata-direction.js";
import { usePublishedToStore } from "./lib/publish.js";
import {
  annotationProjectionAtom,
  annotationSectionLabelAtom,
  publicationFactsAtom,
  publishAnnotationMutationHandlerAtom,
  sameAnnotationProjection,
  useAnnotationState,
} from "./annotations/state.js";
import { useAuthoredPageMeasurement } from "./progress/authored-pages.js";
import { useDecorationProjection } from "./decorations/use-decoration-projection.js";
import { useReaderSearchState } from "./search/state.js";
import { useSearchCoordinator } from "./search/coordinator.js";
import { searchScopeAtom } from "./search/state.js";
import { useSearchActions } from "./search/actions.js";
import { useDictionaryCoordinator } from "./dictionary/coordinator.js";
import { effectiveDictionaryAnchorAtom } from "./dictionary/state.js";
import {
  backDictionaryAtom,
  dismissReaderSurfaceAtom,
  loadDictionarySectionAtom,
  lookUpDictionaryAtom,
  playDictionaryAtom,
  stopDictionaryAtom,
} from "./dictionary/dispatch.js";
import {
  dismissedSelectionRevisionAtom,
  noteDraftAtom,
  selectionActionAtom,
} from "./annotations/state.js";
import {
  narrationControlsVisible,
  useMediaOverlayController,
} from "./media-overlays/use-media-overlay-controller.js";
import { NarrationControls } from "./media-overlays/controls.js";
import {
  effectiveMediaOverlaySnapshotAtom,
  mediaOverlayControllerAtom,
} from "./media-overlays/state.js";
import {
  nextNarrationSegmentAtom,
  pauseNarrationAtom,
  playNarrationAtom,
  previousNarrationSegmentAtom,
} from "./media-overlays/dispatch.js";
import { useNavigationController } from "./navigation/controller.js";
import {
  useAnnotationOverlayAnchors,
  useAnnotationSurfaceState,
} from "./annotations/surface-state.js";
import { useDictionaryInteraction } from "./dictionary/interaction.js";
import { useImmutableSession, useReaderElements } from "./runtime/reader-setup.js";
import { useReaderPreferencesBinding } from "./runtime/preferences-binding.js";
import { ReaderAnnotationsPanel } from "./annotations/reader-panel.js";
import {
  adjustAnnotationRangeAtom,
  createAnnotationBookmarkAtom,
  deleteAnnotationAtom,
  editAnnotationNoteAtom,
} from "./annotations/dispatch.js";
import {
  beginSelectionAnnotationAtom,
  annotateSelectionAtom,
  cancelNoteEditorAtom,
  convertHighlightToNoteAtom,
  copySelectionAtom,
  dismissAnnotationToolbarAtom,
  dismissSelectionToolbarAtom,
  saveNoteAtom,
  selectContextualAnnotationAtom,
} from "./annotations/editing.js";
import { ReaderNavigationPanel } from "./navigation/reader-panel.js";
import { navigateToNoteAtom, readerStoreAtom } from "./navigation/navigate-atom.js";
import { searchScopeSupportAtom } from "./search/dispatch.js";
import { authoredNavigationAtom } from "./navigation/state.js";
import { ReaderShell } from "./reader-shell.js";
import { useReaderRenderStatus } from "./status/reader-state.js";
import type { PublicationStageProps } from "./publication/stage.js";
import { useTransientReaderActions } from "./runtime/transient-actions.js";
import { useReaderProgress } from "./progress/use-reader-progress.js";
import {
  compactPanelAtom,
  effectiveCompactSurfaceAtom,
  readerCompactAtom,
  setCompactSurfaceAtom,
} from "./compact/state.js";
import {
  locationSnapshotAtom,
  measuredAuthoredPagesAtom,
  paginationSnapshotAtom,
} from "./progress/state.js";
import {
  configurationErrorAtom,
  documentErrorAtom,
  readerErrorAtom,
  resetPublicationSessionAtom,
  runtimeViewAtom,
} from "./runtime/projection-state.js";
import { useDocumentView } from "./runtime/document-view.js";
import {
  effectiveWorkspaceSurfaceAtom,
  setWorkspaceSurfaceAtom,
  controlledWorkspaceStateAtom,
  publishWorkspaceStateChangeAtom,
  setWorkspaceStateAtom,
  workspaceFitAtom,
  workspaceStateAtom,
  workspaceWidthAtom,
  sameWorkspaceState,
} from "./workspace/state.js";

/** A complete document-scrolling EPUB reader for an existing mounted publication. */
/** A host that serves no reader face. Stable so the default does not change identity. */
const noReaderTypefaces: readonly PublicationTypeface[] = [];

export function NavigatorReader(props: NavigatorReaderProps) {
  const [ownStore] = useState(createStore);
  const store = props.store ?? ownStore;
  return (
    <Provider store={store}>
      <SessionOwner key={props.session.id} sessionId={props.session.id}>
        <NavigatorReaderInstance {...props} />
      </SessionOwner>
    </Provider>
  );
}

function SessionOwner({
  sessionId,
  children,
}: {
  readonly sessionId: string;
  readonly children: React.ReactNode;
}) {
  const store = useStore();
  useState(() => store.set(readerStoreAtom, store));
  // Claiming before the first child render keeps a replaced session from observing the
  // previous one's atoms. The component is keyed by session, so this runs once per session.
  useState(() => {
    store.set(resetPublicationSessionAtom, sessionId);
    return sessionId;
  });
  return children;
}

function NavigatorReaderInstance({
  ref,
  session,
  initialReadingPosition = null,
  onLocationChange,
  onReadingSummaryChange,
  onReadingActivityChange,
  onInitialRestoration,
  className,
  interactionFeedback,
  readerTypefaces = noReaderTypefaces,
  selectionMenu = "auto",
  preferences: controlledPreferences,
  onPreferencesChange,
  workspaceState: controlledWorkspaceState,
  onWorkspaceStateChange,
  onLinkActivation,
  onExternalFormAttempt,
  frameSandbox,
  onLibraryRequest,
  hostControls,
  networkActivity,
  pagination,
  diagnostics,
  paginationAvailability,
  annotations,
  onAnnotationMutation,
  annotationAvailability,
  annotationActions,
  search,
  onSearchSnapshotChange,
  dictionary,
  onDictionarySnapshotChange,
  mediaOverlays,
  onNarrationChange,
}: NavigatorReaderProps) {
  const store = useStore();
  const { publication, frameSandbox: initialFrameSandbox } = useImmutableSession(
    session,
    frameSandbox,
  );
  const {
    readerRoot,
    readerRootElement,
    attachReaderRoot,
    frameHost,
    frameHostElement,
    attachFrameHost,
  } = useReaderElements();
  useCornerClearance(readerRootElement);
  const workspaceTitleTrigger = useRef<HTMLButtonElement>(null);
  const runtime = useRef<NavigatorRuntime | null>(null);
  // The device page mover, held so the handle a host was given always reaches the current one.
  const turnDevicePage = useRef<((direction: "forward" | "backward") => void) | null>(null);
  const initialReadingPositionRef = useRef(initialReadingPosition);
  const locationChangeHandler = useRef(onLocationChange);
  const initialRestorationHandler = useRef(onInitialRestoration);
  const [initialRestorationPending, setInitialRestorationPending] = useState(
    initialReadingPosition !== null,
  );
  const readerRenderSequence = useRef(0);
  useEffect(() => {
    readerRenderSequence.current += 1;
  });
  const paginationRef = useRef(pagination);
  const linkActivationHandler = useRef(onLinkActivation);
  const externalFormAttemptHandler = useRef(onExternalFormAttempt);
  const annotationProjectionRef = useRef(annotations);
  const annotationMutationHandler = useRef(onAnnotationMutation);
  const narrationListener = useRef(onNarrationChange);
  const [controlledness] = useState(() => ({
    preferences: controlledPreferences !== undefined,
    workspace: controlledWorkspaceState !== undefined,
  }));
  if (
    controlledness.preferences !== (controlledPreferences !== undefined) ||
    controlledness.workspace !== (controlledWorkspaceState !== undefined)
  ) {
    throw new Error(
      "NavigatorReader preferences and workspaceState must not switch controlledness within a session.",
    );
  }
  const searchState = useReaderSearchState();
  const setSearchScope = useSetAtom(searchScopeAtom);
  const {
    input: searchInput,
    snapshot: searchSnapshot,
    scope: searchScope,
    navigationMode,
  } = searchState;
  const annotationState = useAnnotationState();
  const setDismissedSelectionRevision = useSetAtom(dismissedSelectionRevisionAtom);
  const setNoteDraft = useSetAtom(noteDraftAtom);
  const setSelectionAction = useSetAtom(selectionActionAtom);
  const {
    selectionSnapshot,
    selectionAction,
    noteDraft,
    bookmarkedLocationRevision,
    contextualAnnotation,
    contextualAnnotationId,
    footnoteReturn,
  } = annotationState;
  const runtimeView = useAtomValue(runtimeViewAtom);
  const snapshot = runtimeView?.snapshot ?? null;
  const visibleOccurrenceRange = runtimeView?.visibleOccurrenceRange ?? null;
  const finalSpreadLeadingOccurrence = runtimeView?.finalSpreadLeadingOccurrence ?? null;
  const companionPagination =
    snapshot === null
      ? null
      : (fixedCompanionDocument(snapshot)?.layout.observation.document.pagination ?? null);
  const paginationSnapshot = useAtomValue(paginationSnapshotAtom);
  const readerError = useAtomValue(readerErrorAtom);
  const configurationError = useAtomValue(configurationErrorAtom);
  const documentError = useAtomValue(documentErrorAtom);
  const error = readerError ?? configurationError ?? documentError;
  const locationSnapshot = useAtomValue(locationSnapshotAtom);
  const scrollFollowing = snapshot?.publicationLayout === "roll";
  const measuredAuthoredPages = useAtomValue(measuredAuthoredPagesAtom);
  usePublishedToStore(() => {
    if (!sameWorkspaceState(store.get(controlledWorkspaceStateAtom), controlledWorkspaceState)) {
      store.set(controlledWorkspaceStateAtom, controlledWorkspaceState);
    }
    store.set(publishWorkspaceStateChangeAtom, onWorkspaceStateChange);
  });
  const workspaceState = useAtomValue(workspaceStateAtom);
  const setWorkspaceState = useSetAtom(setWorkspaceStateAtom);
  const { preferences, setPreferences, colorPreference, colorPreferenceRef } =
    useReaderPreferencesBinding({ controlledPreferences, onPreferencesChange });
  const takeNoteReference = useCallback(
    (target: { readonly resource: string; readonly fragment: string }) =>
      store.set(navigateToNoteAtom, target),
    [store],
  );
  const notes = useNoteSurface({
    readNote: hostControls?.readNote,
    baseUrl: publication.mount.baseUrl,
    frameHost: frameHostElement,
    takeTheReference: takeNoteReference,
  });
  const handleLinkActivation = (activation: NavigatorLinkActivation) => {
    // A reference the reader can show is the reader's to answer; anything else is the host's.
    if (notes.show(activation)) return;
    onLinkActivation?.(activation);
  };
  useLayoutEffect(() => {
    initialReadingPositionRef.current = initialReadingPosition;
    locationChangeHandler.current = onLocationChange;
    initialRestorationHandler.current = onInitialRestoration;
    paginationRef.current = pagination;
    linkActivationHandler.current = handleLinkActivation;
    externalFormAttemptHandler.current = onExternalFormAttempt;
    annotationProjectionRef.current = annotations;
    annotationMutationHandler.current = onAnnotationMutation;
    colorPreferenceRef.current = colorPreference;
    narrationListener.current = onNarrationChange;
  });
  usePublishedToStore(() => {
    if (sameAnnotationProjection(store.get(annotationProjectionAtom), annotations)) return;
    store.set(annotationProjectionAtom, annotations);
  });
  const compact = useCompactReader();
  useLayoutEffect(() => {
    store.set(readerCompactAtom, compact);
  }, [compact, store]);
  const setCompactPanel = useSetAtom(compactPanelAtom);
  const compactSurface = useAtomValue(effectiveCompactSurfaceAtom);
  const effectiveCompactSurface = compactSurface;
  const effectiveWorkspaceSurface = useAtomValue(effectiveWorkspaceSurfaceAtom);
  const dictionaryAnchor = useAtomValue(effectiveDictionaryAnchorAtom);
  const setCompactSurface = useSetAtom(setCompactSurfaceAtom);
  const setWorkspaceSurface = useSetAtom(setWorkspaceSurfaceAtom);
  const hostFullscreenController = hostFullscreen(hostControls?.fullscreen);
  const browserFullscreen = useReaderFullscreen(
    hostFullscreenController === null ? readerRootElement : null,
  );
  const fullscreen = hostFullscreenController ?? browserFullscreen;
  const noteEditorViewportStyle = useContainedVisualViewportStyle(
    readerRootElement,
    compact && noteDraft !== null,
  );
  const facts = publication.facts;
  const title = facts.package.metadata.title[0]?.content ?? "Untitled publication";
  const titleDirection = resolvedMetadataDirection(
    facts.package.metadata.title[0]?.dir,
    facts.package.dir,
  );
  const coverUrl = publicationCoverUrl(publication);
  const [authoredNavigation] = useState(() => projectAuthoredNavigation(facts));
  const publishAuthoredNavigation = useSetAtom(authoredNavigationAtom);
  useLayoutEffect(() => {
    publishAuthoredNavigation(authoredNavigation);
    return () => publishAuthoredNavigation(null);
  }, [authoredNavigation, publishAuthoredNavigation]);
  const tocPoints = progressMarkerPoints(authoredNavigation);
  const workspaceWidth = useContainerWidth(readerRoot);
  usePublishedToStore(() => store.set(workspaceWidthAtom, workspaceWidth));
  const workspaceFit = useAtomValue(workspaceFitAtom);
  const bookRegionWidth =
    workspaceWidth === null
      ? null
      : Math.max(
          0,
          workspaceWidth -
            (!compact && workspaceFit.navigation === "pinned"
              ? workspaceState.navigation.width
              : 0) -
            (!compact && workspaceFit.annotations === "pinned"
              ? workspaceState.annotations.width
              : 0),
        );
  const workspaceCanPin = workspacePanelPinAvailability(
    workspaceState,
    workspaceFit,
    workspaceWidth,
  );

  useRuntimeSession({
    session,
    frameSandbox: initialFrameSandbox,
    frameHost,
    runtime,
    paginationRef,
    initialReadingPositionRef,
    locationChangeHandler,
    initialRestorationHandler,
    initialRestorationReady: () => setInitialRestorationPending(false),
    linkActivationHandler,
    externalFormAttemptHandler,
    annotationProjectionRef,
    title,
    diagnostics,
  });

  useEffect(() => {
    const current = runtime.current;
    if (current !== null) current.setPaginationCapabilities(pagination);
  }, [pagination]);

  const [effectiveSearchReadingOrder, setEffectiveSearchReadingOrder] = useState<{
    readonly sessionId: string;
    readonly readingOrder: KernelSnapshot["readingOrder"];
  } | null>(null);
  if (
    snapshot !== null &&
    (effectiveSearchReadingOrder?.sessionId !== session.id ||
      !sameSearchReadingOrder(effectiveSearchReadingOrder.readingOrder, snapshot.readingOrder))
  ) {
    setEffectiveSearchReadingOrder({
      sessionId: session.id,
      readingOrder: snapshot.readingOrder,
    });
  }
  useSearchCoordinator(
    onSearchSnapshotChange,
    session.id,
    facts,
    search,
    effectiveSearchReadingOrder?.sessionId === session.id
      ? effectiveSearchReadingOrder.readingOrder
      : undefined,
  );
  const dictionarySnapshot = useDictionaryCoordinator(
    session.id,
    dictionary,
    onDictionarySnapshotChange,
  );
  const dictionaryAvailable = dictionary !== undefined && !dictionary.signal.aborted;
  useMediaOverlayController({
    runtime,
    runtimeReady: snapshot !== null,
    sessionId: session.id,
    mount: publication.mount,
    capabilities: mediaOverlays,
    readingOrder:
      effectiveSearchReadingOrder?.sessionId === session.id
        ? effectiveSearchReadingOrder.readingOrder
        : undefined,
    rate: preferences.narrationRate,
    skippedTypes: preferences.narrationSkippedTypes,
  });

  useImperativeHandle(
    ref,
    () => ({
      dismissSurface: () => store.set(dismissReaderSurfaceAtom),
      turnPage: (direction) => turnDevicePage.current?.(direction),
      captureReadingPosition: (options) => captureReadingPosition(runtime, options),
      pauseNarration: () => store.set(pauseNarrationAtom),
      playNarration: () => store.set(playNarrationAtom),
      nextNarrationSegment: () => store.set(nextNarrationSegmentAtom),
      previousNarrationSegment: () => store.set(previousNarrationSegmentAtom),
    }),
    [store],
  );

  useControlledAnnotationProjection();

  const {
    committedDocument,
    committed,
    pageContextLayoutGeneration,
    pageContextTargets,
    pageContextPredecessorLabel,
  } = useAuthoredPageMeasurement({
    snapshot,
    authoredNavigation,
    runtime,
    sessionId: session.id,
  });
  useDecorationProjection({
    runtime,
    annotations,
    searchSnapshot,
    occurrence: committed?.occurrence ?? null,
  });
  const searchCapabilityLive = search !== undefined && !search.signal.aborted;
  const publicationSearchAvailable = searchCapabilityLive && search.scopes.includes("publication");
  const occurrenceSearchAvailable =
    searchCapabilityLive && search.scopes.includes("occurrence") && committed !== null;
  const searchAvailable = publicationSearchAvailable || occurrenceSearchAvailable;
  useEffect(() => {
    if (!searchAvailable) return;
    if (searchScope === "publication" && !publicationSearchAvailable) {
      setSearchScope("occurrence");
    } else if (searchScope === "occurrence" && !occurrenceSearchAvailable) {
      setSearchScope("publication");
    }
  }, [
    occurrenceSearchAvailable,
    publicationSearchAvailable,
    searchAvailable,
    searchScope,
    setSearchScope,
  ]);
  const {
    pending,
    committedLayout,
    readingOrderLength,
    observation,
    paginatedLayout,
    localPagination,
    pendingForegroundLayout,
    documentAdapter,
    layoutSettlement,
    layoutIssue,
    presentationMode,
    publicationSurround,
    publicationCanvasUnavailable,
    progressionDirection,
  } = useDocumentView({ snapshot, committed, committedDocument, facts, preferences });
  const readerSelectionMenuAvailable =
    (annotations !== undefined && onAnnotationMutation !== undefined) ||
    searchAvailable ||
    dictionaryAvailable;
  const readerSelectionMenuEnabled =
    selectionMenu === "reader" || (selectionMenu === "auto" && readerSelectionMenuAvailable);
  const retryPreferences = useRuntimePreferences({
    preferences,
    colorPreference,
    progressionDirection,
    readerSelectionMenuAvailable,
    selectionMenu,
    showsNotes: hostControls?.readNote !== undefined,
    interactionFeedback,
  });
  const layoutRepairsUnresolved = paginatedLayout?.layoutRepairs.status === "unresolved";
  const renderedProgress = observation?.renderedTextProgression;
  // A scroll-following layout reports its fraction on the published location; the committed
  // document's own observation does not move while the outer scroller does.
  const scrollProgression =
    scrollFollowing && locationSnapshot?.location?.kind === "point"
      ? locationSnapshot.location.observation.layoutProgression
      : null;
  const sectionLabel = currentSectionLabel(authoredNavigation, committed, readingOrderLength);
  const narrationController = useAtomValue(mediaOverlayControllerAtom);
  const narrationSnapshot = useAtomValue(effectiveMediaOverlaySnapshotAtom);
  useEffect(() => {
    if (narrationSnapshot === null) return;
    narrationListener.current?.({
      state: narrationSnapshot.state,
      section: sectionLabel,
      timing: narrationController?.timing() ?? null,
      rate: narrationSnapshot.rate,
    });
  }, [narrationSnapshot, sectionLabel, narrationController]);
  const progress = useReaderProgress({
    sessionId: session.id,
    authoredNavigation,
    tocPoints,
    committed:
      committed === null || committedDocument === null
        ? null
        : {
            occurrence: committed.occurrence,
            resource: committed.resource,
            generation: committedDocument.generation,
          },
    committedLayout,
    localPagination,
    pendingForegroundLayout,
    readingOrderLength,
    renderedProgress: renderedProgress ?? scrollProgression ?? 0,
    visibleOccurrenceRange,
    finalSpreadLeadingOccurrence,
    companionPagination,
    scrollFollowing,
    paginationSnapshot,
    railPixelWidth: bookRegionWidth !== null && bookRegionWidth > 0 ? bookRegionWidth : null,
    measuredAuthoredPages,
    pageContextTargets,
    pageContextPredecessorLabel,
    pageContextLayoutGeneration,
    committedOccurrence: committed?.occurrence,
    committedFrameGeneration: committed?.generation,
    committedDocumentGeneration: committedDocument?.generation,
  });
  const bookProgress = progress.book;
  useEffect(() => {
    if (
      committed === null ||
      initialRestorationPending ||
      pendingForegroundLayout ||
      bookProgress.freshness !== "current"
    )
      return;
    const pages = bookProgress.pages;
    onReadingSummaryChange?.({
      chapter: sectionLabel,
      pages:
        pages.kind === "percentage"
          ? null
          : {
              current: pages.visible.start + 1,
              total: pages.total,
              accuracy: pages.kind === "physical-pages" ? "exact" : "calibrated",
            },
    });
  }, [
    committed,
    initialRestorationPending,
    pendingForegroundLayout,
    bookProgress,
    sectionLabel,
    onReadingSummaryChange,
  ]);
  const {
    status: readerStatus,
    state,
    measuringPages,
    hasCommittedDocument,
    readingSurfaceRetained,
  } = useReaderRenderStatus({
    sessionId: session.id,
    networkActivity,
    diagnostics,
    readerRoot,
    renderSequence: readerRenderSequence,
    snapshot,
    paginationSnapshot,
    paginationAvailability,
    committed,
    pending,
    pendingForegroundLayout,
    initialRestorationPending,
    layoutRepairsUnresolved,
    error,
    bookProgress,
  });

  const activityLocation = JSON.stringify([
    committed?.occurrence,
    localPagination?.firstVisiblePage ?? scrollProgression,
  ]);
  const activityLayout = JSON.stringify([preferences, bookRegionWidth]);
  const activityAvailable =
    hasCommittedDocument &&
    !initialRestorationPending &&
    !pendingForegroundLayout &&
    pending === null &&
    error === null &&
    effectiveCompactSurface === null &&
    effectiveWorkspaceSurface === null &&
    !workspaceState.navigation.open &&
    !workspaceState.annotations.open &&
    noteDraft === null;
  const activityPages = JSON.stringify(
    localPagination === null
      ? []
      : Array.from(
          { length: localPagination.visiblePageCount },
          (_, index) => `${committed?.occurrence}:${localPagination.firstVisiblePage + index}`,
        ),
  );
  useEffect(() => {
    onReadingActivityChange?.({
      available: activityAvailable,
      location: activityLocation,
      layout: activityLayout,
      pages: JSON.parse(activityPages) as string[],
    });
  }, [activityAvailable, activityLocation, activityLayout, activityPages, onReadingActivityChange]);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  usePublicationFocusRestoration({
    readerRoot,
    frameHost,
    hasCommittedDocument,
    compactSurfaceOpen: compact && effectiveCompactSurface !== null,
    workspaceSurfaceOpen: shortcutsOpen || (!compact && effectiveWorkspaceSurface !== null),
    navigationOverlayOpen:
      !compact && workspaceState.navigation.open && workspaceFit.navigation === "overlay",
    annotationsOverlayOpen:
      !compact && workspaceState.annotations.open && workspaceFit.annotations === "overlay",
    noteEditorOpen: noteDraft !== null,
  });

  const dismissAnnotationToolbar = useSetAtom(dismissAnnotationToolbarAtom);
  const selectContextualAnnotation = useSetAtom(selectContextualAnnotationAtom);
  const dismissSelectionToolbar = useSetAtom(dismissSelectionToolbarAtom);
  const beginSelectionAnnotation = useSetAtom(beginSelectionAnnotationAtom);
  const copySelection = useSetAtom(copySelectionAtom);
  const convertHighlightToNote = useSetAtom(convertHighlightToNoteAtom);
  const cancelNoteEditor = useSetAtom(cancelNoteEditorAtom);
  const saveNote = useSetAtom(saveNoteAtom);
  const adjustAnnotationRange = useSetAtom(adjustAnnotationRangeAtom);

  const capturedSelection =
    selectionSnapshot?.selection?.status === "captured" ? selectionSnapshot.selection : null;
  const searchActions = useSearchActions({
    state: searchState,
    searchAvailable,
    selectionQuery:
      capturedSelection === null ? null : selectionExcerpt(capturedSelection.location),
    onOpen: () => {
      setCompactPanel("navigation");
      if (compact) {
        setCompactSurface("navigation");
      } else {
        setWorkspaceState({
          ...workspaceState,
          annotations:
            workspaceFit.annotations === "overlay"
              ? { ...workspaceState.annotations, open: false }
              : workspaceState.annotations,
          navigation: { ...workspaceState.navigation, open: true },
        });
      }
    },
    onDismissSelection: () => {
      if (selectionSnapshot !== null) setDismissedSelectionRevision(selectionSnapshot.revision);
      setSelectionAction(null);
    },
  });
  const {
    open: openSearchMode,
    close: closeSearchMode,
    run: runSearch,
    searchSelection,
    changeScope: changeSearchScope,
  } = searchActions;

  // Anything laid over the publication — a dialog, a menu, a reader surface, a note being
  // written — takes the publication's own navigation with it while it is there.
  const publicationCovered = (): boolean => {
    const root = readerRoot.current;
    return (
      root === null ||
      root.ownerDocument.querySelector(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
      ) !== null ||
      effectiveCompactSurface !== null ||
      effectiveWorkspaceSurface !== null ||
      noteDraft !== null
    );
  };

  const shortcutReturnFocus = useRef(false);
  const handleReaderCommand = (command: ReaderCommand) => {
    if (readerRoot.current === null) return;
    if (command === "dismiss") {
      if (shortcutsOpen) {
        setShortcutsOpen(false);
        return;
      }
      if (store.set(dismissReaderSurfaceAtom)) return;
      if (capturedSelection !== null) {
        dismissSelectionToolbar();
        runtime.current?.clearSelection();
      } else if (contextualAnnotation !== null) dismissAnnotationToolbar();
      return;
    }
    if (publicationCovered()) return;
    if (command === "page-backward" || command === "page-forward") {
      advanceReaderPresentation(command === "page-forward" ? "forward" : "backward");
    } else if (command === "search") {
      if (searchAvailable) openSearchMode();
    } else if (command === "highlight" || command === "note") {
      if (selectionAction === null || selectionAction.status === "failed")
        void store.set(annotateSelectionAtom, command);
    } else if (command === "navigation" || command === "annotations") {
      if (compact) {
        setCompactPanel(command);
        setCompactSurface("navigation");
      } else {
        const other = command === "navigation" ? "annotations" : "navigation";
        setWorkspaceState({
          ...workspaceState,
          [other]:
            !workspaceState[command].open && workspaceFit[other] === "overlay"
              ? { ...workspaceState[other], open: false }
              : workspaceState[other],
          [command]: { ...workspaceState[command], open: !workspaceState[command].open },
        });
      }
    } else if (command === "quick-menu") {
      shortcutReturnFocus.current = !compact;
      if (compact) setCompactSurface("quick-menu");
      else workspaceTitleTrigger.current?.click();
    } else if (command === "settings") {
      shortcutReturnFocus.current = !compact;
      if (compact) setCompactSurface("settings");
      else setWorkspaceSurface("settings");
    } else if (command === "library") onLibraryRequest?.();
    else if (command === "help") setShortcutsOpen(true);
    else if (command === "narration" && narrationControlsVisible(narrationSnapshot)) {
      const controller = store.get(mediaOverlayControllerAtom);
      if (narrationSnapshot?.state === "playing" || narrationSnapshot?.state === "loading")
        controller?.pause();
      else void controller?.play();
    }
  };

  const {
    advancePresentation: advanceShellPresentation,
    command: sectionCommand,
    moveBoundary,
    retry,
  } = useNavigationController({
    onReaderCommand: handleReaderCommand,
    runtime,
    frameHost,
    committed,
    committedDocument,
    pending,
    closeNavigationSurfaces: () => {
      setCompactSurface(null);
      setWorkspaceSurface(null);
    },
    closeNavigationOverlay: () => {
      if (workspaceFit.navigation === "overlay") {
        setWorkspaceState({
          ...workspaceState,
          navigation: { ...workspaceState.navigation, open: false },
        });
      }
    },
    error: documentError,
  });

  // One way to move a page, whether the reader's own input asked for it or a host did.
  const advanceReaderPresentation = (direction: "forward" | "backward") => {
    store.get(mediaOverlayControllerAtom)?.noteReaderNavigation();
    advanceShellPresentation(direction);
  };
  // A device's page buttons reach no focused element, so a surface laid over the publication is
  // found rather than told: while one is open the publication behind it stays where it is, and
  // the turn belongs to the surface's own pages when it has them.
  const turnPageForDevice = (direction: "forward" | "backward") => {
    if (turnPaginatedSurface(direction === "forward" ? 1 : -1)) return;
    if (publicationCovered()) return;
    advanceReaderPresentation(direction);
  };
  useEffect(() => {
    turnDevicePage.current = turnPageForDevice;
  });

  const {
    handlePointerDown: handlePublicationPointerDown,
    handlePointerUp: handlePublicationPointerUp,
    cancelPointer: cancelPublicationPointer,
  } = useReaderInput({
    readerRoot,
    frameHost,
    keyboardMode: preferences.keyboardMode,
    selectionActive: capturedSelection !== null,
    touchZones: preferences.touchZones,
    clickZones: preferences.clickZones ?? false,
    onCommand: handleReaderCommand,
    moveBoundary,
    changeSection: (direction) => {
      if (committed === null) return;
      const occurrence =
        (direction === "next"
          ? runtime.current?.nextOccurrence()
          : runtime.current?.previousOccurrence()) ?? null;
      if (occurrence !== null) sectionCommand(direction, occurrence);
    },
    writingMode: observation?.writingMode,
    progressionDirection,
    advancePresentation: advanceReaderPresentation,
    presentationMode,
  });

  const { setZoom, returnFromFootnote, dismissFootnoteReturn } = useTransientReaderActions(
    runtime,
    annotationState,
  );

  const { lookUpSelection, closeDictionary } = useDictionaryInteraction({
    frameHost,
    compact,
    observation,
  });

  usePublishedToStore(() => {
    const current = store.get(searchScopeSupportAtom);
    if (
      current.publication === publicationSearchAvailable &&
      current.occurrence === occurrenceSearchAvailable
    ) {
      return;
    }
    store.set(searchScopeSupportAtom, {
      publication: publicationSearchAvailable,
      occurrence: occurrenceSearchAvailable,
    });
  });
  const searchSurface = {
    searchInput,
    readingOrderLength,
    publicationScopeAvailable: publicationSearchAvailable,
    occurrenceScopeAvailable: occurrenceSearchAvailable,
    occurrenceLabel: sectionLabel === null ? null : `This section: ${sectionLabel}`,
  };

  usePublishedToStore(() => {
    store.set(publicationFactsAtom, facts);
    store.set(annotationSectionLabelAtom, sectionLabel);
    store.set(publishAnnotationMutationHandlerAtom, onAnnotationMutation);
  });
  const { bookmarkAvailable, bookmarkBusy } = useAnnotationSurfaceState({
    annotations,
    onAnnotationMutation,
    locationSnapshot,
  });
  const {
    selectionCopyAvailable,
    selectionAnchor: selectionToolbarAnchor,
    selectionPlacement: selectionToolbarPlacement,
    selectionVisible: selectionToolbarVisible,
    contextualRecords: contextualAnnotationRecords,
    contextualAnchor: contextualToolbarAnchor,
    contextualOperation: contextualToolbarOperation,
    contextualRetargetOperation,
  } = useAnnotationOverlayAnchors({
    frameHostElement,
    annotations,
    selectionMenuEnabled: readerSelectionMenuEnabled,
    selectionMenuAvailable: readerSelectionMenuAvailable,
  });

  const navigationProps = {
    workspace: <ReaderNavigationPanel variant="workspace" {...searchSurface} />,
    compact: <ReaderNavigationPanel variant="compact" {...searchSurface} />,
  };
  const publicationProps = {
    frameHost: attachFrameHost,
    surround: publicationSurround,
    canvasUnavailable: publicationCanvasUnavailable,
    initialRestorationPending,
    preferences,
    colorPreference,
    onPointerDown: handlePublicationPointerDown,
    onPointerUp: handlePublicationPointerUp,
    onPointerCancel: cancelPublicationPointer,
    overlays: {
      selection: {
        visible: selectionToolbarVisible,
        anchor: selectionToolbarAnchor,
        placement: selectionToolbarPlacement,
        action: selectionAction,
        copyAvailable: selectionCopyAvailable,
        annotationAvailable: annotations !== undefined && onAnnotationMutation !== undefined,
        searchAvailable,
        lookupAvailable: dictionaryAvailable && selectionCopyAvailable,
        onCopy: (event) => void copySelection(event),
        onHighlight: (event) => void beginSelectionAnnotation("highlight", event),
        onAddNote: (event) => void beginSelectionAnnotation("note", event),
        onSearch: searchSelection,
        onLookup: lookUpSelection,
        onDismiss: dismissSelectionToolbar,
      },
      contextual: {
        anchor: contextualToolbarAnchor,
        records: contextualAnnotationRecords,
        selectedId: contextualAnnotationId,
        activation: contextualAnnotation,
        operation: contextualToolbarOperation,
        retargetOperation: contextualRetargetOperation,
        direction: observation?.direction ?? "ltr",
        writingMode: observation?.writingMode ?? "horizontal-tb",
        onSelect: selectContextualAnnotation,
        onAddNote: convertHighlightToNote,
        onEditNote: (record, trigger) => store.set(editAnnotationNoteAtom, record, trigger),
        onOpenLink: (activation) => runtime.current?.activateDecorationLink(activation),
        onDelete: (record, event) => void store.set(deleteAnnotationAtom, record, event),
        onAdjust: (record, adjustment, event) =>
          void adjustAnnotationRange(record, adjustment, event),
        onDismiss: dismissAnnotationToolbar,
      },
    },
    status: {
      committed,
      initialRestorationPending,
      readingSurfaceRetained,
      error,
      retry: configurationError !== null && error === configurationError ? retryPreferences : retry,
      layoutRepairsUnresolved,
      footnoteReturn,
      onReturnFromFootnote: (event) => void returnFromFootnote(event),
      onDismissFootnoteReturn: dismissFootnoteReturn,
    },
  } satisfies PublicationStageProps;

  const noteSurface =
    notes.open === null ? null : compact || notes.open.anchor === null ? (
      <NoteSheet
        note={notes.open.note}
        label={notes.open.label}
        root={readerRootElement}
        finalFocus={() => visiblePrimaryPublicationFrame(frameHost.current)}
        onClose={notes.close}
      />
    ) : (
      <NotePopover
        anchor={notes.open.anchor}
        note={notes.open.note}
        label={notes.open.label}
        root={readerRootElement}
        finalFocus={() => visiblePrimaryPublicationFrame(frameHost.current)}
        onClose={notes.close}
      />
    );
  return (
    <>
      {noteSurface}
      <ShortcutHelp
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        root={readerRootElement}
        frameHost={frameHostElement}
        keyboardMode={preferences.keyboardMode}
        presentationMode={presentationMode}
      />
      <ReaderShell
        narration={
          <NarrationControls
            snapshot={narrationSnapshot}
            setPreferences={setPreferences}
            root={readerRootElement}
          />
        }
        readerRoot={attachReaderRoot}
        readerRootElement={readerRootElement}
        frameHostElement={frameHostElement}
        colorPreference={colorPreference}
        className={className}
        interactionFeedback={interactionFeedback}
        diagnostics={{
          state,
          status: readerStatus,
          measuring: measuringPages,
          pagination: paginationSnapshot,
          paginatedLayout,
          documentAdapter,
          presentationMode,
          layoutSettlement,
          layoutIssue,
        }}
        chrome={{
          onKeyboardShortcuts: () => setShortcutsOpen(true),
          compact,
          fullscreen,
          progressionDirection,
          observation,
          title,
          titleDirection,
          topProgressAccessibleLabel: progress.topProgressAccessibleLabel,
          topProgressLabel: progress.topProgressLabel,
          preferences,
          setPreferences,
          readerTypefaces,
          hostControls,
        }}
        workspace={{
          fit: workspaceFit,
          state: workspaceState,
          setState: setWorkspaceState,
          surface: effectiveWorkspaceSurface,
          setSurface: setWorkspaceSurface,
          canPin: workspaceCanPin,
          titleTrigger: workspaceTitleTrigger,
          returnFocus: () => {
            if (shortcutReturnFocus.current) {
              return visiblePrimaryPublicationFrame(frameHost.current);
            }
            return workspaceTitleTrigger.current;
          },
          onToolbarInteraction: () => {
            shortcutReturnFocus.current = false;
          },
          setZoom,
        }}
        publication={publicationProps}
        navigation={navigationProps}
        navigationTitleAction={{
          mode: navigationMode,
          searchAvailable,
          onOpenSearch: openSearchMode,
          onCloseSearch: closeSearchMode,
        }}
        annotations={
          <ReaderAnnotationsPanel
            availability={annotationAvailability}
            hostActions={annotationActions}
            diagnostics={diagnostics}
          />
        }
        bookmarkAction={{
          disabled:
            !bookmarkAvailable ||
            bookmarkBusy ||
            bookmarkedLocationRevision === locationSnapshot?.revision,
          busy: bookmarkBusy,
          onActivate: (event) => void store.set(createAnnotationBookmarkAtom, event),
        }}
        progress={{ book: bookProgress, sectionLabel, pageProgress: progress.pageProgress }}
        compact={{
          surface: effectiveCompactSurface,
          setSurface: setCompactSurface,
        }}
        search={{
          available: searchAvailable,
          busy: searchSnapshot.state === "querying",
          input: searchInput,
          scope: searchScope,
          publicationAvailable: publicationSearchAvailable,
          occurrenceAvailable: occurrenceSearchAvailable,
          occurrenceLabel: searchSurface.occurrenceLabel,
          changeScope: changeSearchScope,
          run: runSearch,
          open: openSearchMode,
          close: closeSearchMode,
        }}
        publicationDetails={{ facts, coverUrl, onLibraryRequest, onLinkActivation }}
        dictionary={{
          available: dictionaryAvailable,
          anchor: dictionaryAnchor,
          content: {
            snapshot: dictionarySnapshot,
            views: dictionary?.views ?? [],
            onLookup: (text, language) =>
              store.set(lookUpDictionaryAtom, { text, language, initiator: "cross-reference" }),
            onLoadSection: (handle, section) =>
              store.set(loadDictionarySectionAtom, { handle, section }),
            onPlay: (handle) => store.set(playDictionaryAtom, handle),
            onStop: () => store.set(stopDictionaryAtom),
          },
          onBack: () => store.set(backDictionaryAtom),
          onClose: closeDictionary,
        }}
        noteEditor={{
          viewportStyle: noteEditorViewportStyle,
          onTextChange: (text) =>
            setNoteDraft((current) =>
              current === null
                ? null
                : {
                    ...current,
                    text,
                    status: current.status === "submitting" ? current.status : "idle",
                    error: null,
                    requestId: current.status === "submitting" ? current.requestId : null,
                    projectionRevision:
                      current.status === "submitting" ? current.projectionRevision : null,
                  },
            ),
          onSave: (event) => void saveNote(event),
          onCancel: cancelNoteEditor,
        }}
      />
    </>
  );
}

function sameSearchReadingOrder(
  left: readonly ReadingOrderOccurrence[],
  right: readonly ReadingOrderOccurrence[],
): boolean {
  return (
    left.length === right.length &&
    left.every((occurrence, index) => {
      const candidate = right[index];
      return (
        candidate?.ordinal === occurrence.ordinal &&
        candidate.document.state === occurrence.document.state &&
        (occurrence.document.state !== "loadable" ||
          (candidate.document.state === "loadable" &&
            candidate.document.resource === occurrence.document.resource))
      );
    })
  );
}
