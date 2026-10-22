import type { PublicationTypeface } from "../generated/kernel.js";
import { useAtomValue, useStore } from "jotai";
import type { ComponentProps, CSSProperties, ReactNode, Ref, RefObject } from "react";
import type {
  DocumentAdapter,
  DocumentObservation,
  LayoutIssue,
  OccurrenceUnavailableReason,
  PaginatedLayout,
  ReflowableLayoutMode,
} from "../generated/kernel.js";
import type { TextDirection } from "../generated/publication.js";
import type { MountedPublication } from "../publication.js";
import type { BookPaginationSnapshot } from "../runtime/pagination/index.js";
import { NoteEditorDialog, type NoteEditorDialogProps } from "./annotations/note-editor-dialog.js";
import { noteDraftAtom } from "./annotations/state.js";
import { CompactReaderSurfaces, type CompactSurface } from "./compact/surfaces.js";
import type { DictionaryContentProps } from "./dictionary/content.js";
import { DictionaryPopover, DictionarySheet } from "./dictionary/surfaces.js";
import type { SelectionToolbarRect } from "./selection-toolbar.js";
import { fixedViewAtom } from "./fixed-layout/state.js";
import { ZoomAdjustment } from "./fixed-layout/controls.js";
import { activePublicationFrame } from "./input/focus.js";
import type { FullscreenController } from "./input/fullscreen.js";
import { cn } from "./lib/utils.js";
import { NavigationTitleAction, type NavigationTitleActionProps } from "./navigation/content.js";
import { PublicationStage, type PublicationStageProps } from "./publication/stage.js";
import { CompactBottomRail } from "./progress/rail.js";
import type { ReaderProgressProjection } from "./progress/projection.js";
import type { NavigatorReaderProps, NavigatorReaderWorkspaceState } from "./public-types.js";
import { publicationColorScheme, type PreferencesSetter } from "./runtime/preferences.js";
import type { ReaderStatus } from "./status/ornament.js";
import { MeasuringIndicator, ReaderStatusOrnament } from "./status/ornament.js";
import type { SearchActions } from "./search/actions.js";
import { BookmarkTitleAction, WorkspacePanel } from "./workspace/panel.js";
import { effectiveWorkspacePanels, type WorkspaceSurface } from "./workspace/layout.js";
import { WorkspaceSurfaces } from "./workspace/surfaces.js";
import { WorkspaceToolbar } from "./workspace/toolbar.js";

interface ReaderShellProps {
  readonly interactionFeedback: "standard" | "minimal" | undefined;
  readonly readerRoot: Ref<HTMLElement>;
  readonly readerRootElement: HTMLElement | null;
  readonly frameHostElement: HTMLDivElement | null;
  readonly colorPreference: "light" | "dark";
  readonly className: string | undefined;
  readonly diagnostics: {
    readonly state:
      | "terminal-error"
      | "recoverable-error"
      | "replacement-pending"
      | "reading"
      | "initial-loading";
    readonly status: ReaderStatus;
    readonly measuring: boolean;
    readonly pagination: BookPaginationSnapshot | null;
    readonly paginatedLayout: PaginatedLayout | null;
    readonly documentAdapter: DocumentAdapter | undefined;
    readonly presentationMode: ReflowableLayoutMode | "fixed" | "unavailable" | undefined;
    readonly layoutSettlement: ReflowableLayoutMode | "contain" | "unavailable" | undefined;
    readonly layoutIssue: LayoutIssue | OccurrenceUnavailableReason | undefined;
  };
  readonly chrome: {
    readonly onKeyboardShortcuts: () => void;
    readonly compact: boolean;
    readonly fullscreen: FullscreenController;
    readonly progressionDirection: "ltr" | "rtl";
    readonly observation: DocumentObservation | null;
    readonly title: string;
    /** What the publication declares about how its title reads, when it declares
     * anything. Undeclared leaves the surrounding document to decide. */
    readonly titleDirection: TextDirection | null;
    readonly topProgressAccessibleLabel: string | undefined;
    readonly topProgressLabel: string;
    readonly preferences: NonNullable<NavigatorReaderProps["preferences"]>;
    readonly setPreferences: PreferencesSetter;
    readonly readerTypefaces: readonly PublicationTypeface[];
    readonly hostControls: NavigatorReaderProps["hostControls"];
  };
  readonly workspace: {
    readonly fit: ReturnType<typeof effectiveWorkspacePanels>;
    readonly state: NavigatorReaderWorkspaceState;
    readonly setState: (state: NavigatorReaderWorkspaceState) => void;
    readonly surface: WorkspaceSurface;
    readonly setSurface: (surface: WorkspaceSurface) => void;
    readonly canPin: ComponentProps<typeof WorkspaceSurfaces>["canPin"];
    readonly titleTrigger: RefObject<HTMLButtonElement | null>;
    readonly returnFocus: () => HTMLElement | null;
    readonly onToolbarInteraction: () => void;
    readonly setZoom: ComponentProps<typeof ZoomAdjustment>["onZoom"];
  };
  readonly publication: PublicationStageProps;
  readonly navigation: { readonly workspace: ReactNode; readonly compact: ReactNode };
  readonly navigationTitleAction: NavigationTitleActionProps;
  readonly annotations: ReactNode;
  readonly bookmarkAction: ComponentProps<typeof BookmarkTitleAction>;
  readonly progress: {
    readonly book: ReaderProgressProjection;
    readonly sectionLabel: string;
    readonly pageProgress: string | null;
  };
  readonly compact: {
    readonly surface: CompactSurface;
    readonly setSurface: (surface: CompactSurface) => void;
  };
  readonly search: {
    readonly available: boolean;
    readonly busy: boolean;
    readonly input: RefObject<HTMLInputElement | null>;
    readonly scope: ComponentProps<typeof CompactReaderSurfaces>["searchScope"];
    readonly publicationAvailable: boolean;
    readonly occurrenceAvailable: boolean;
    readonly occurrenceLabel: string | null;
    readonly changeScope: SearchActions["changeScope"];
    readonly run: SearchActions["run"];
    readonly open: SearchActions["open"];
    readonly close: SearchActions["close"];
  };
  readonly publicationDetails: {
    readonly onLinkActivation: NavigatorReaderProps["onLinkActivation"];
    readonly facts: MountedPublication["facts"];
    readonly coverUrl: string | null;
    readonly onLibraryRequest: NavigatorReaderProps["onLibraryRequest"];
  };
  readonly dictionary: {
    readonly available: boolean;
    readonly anchor: SelectionToolbarRect | null;
    readonly content: DictionaryContentProps;
    readonly onBack: () => void;
    readonly onClose: () => void;
  };
  readonly noteEditor: Omit<NoteEditorDialogProps, "compact" | "root" | "frameHost">;
  readonly narration: ReactNode;
}

export function ReaderShell({
  readerRoot,
  readerRootElement,
  frameHostElement,
  colorPreference,
  interactionFeedback,
  className,
  diagnostics,
  chrome,
  workspace,
  publication,
  navigation,
  navigationTitleAction,
  annotations,
  bookmarkAction,
  progress,
  compact,
  search,
  publicationDetails,
  dictionary,
  noteEditor,
  narration,
}: ReaderShellProps) {
  const store = useStore();
  const noteDraft = useAtomValue(noteDraftAtom);
  const fixedView = useAtomValue(fixedViewAtom);
  const navigationContent = navigation.workspace;
  const compactNavigationContent = navigation.compact;
  const annotationsContent = annotations;
  const navigationAction = <NavigationTitleAction {...navigationTitleAction} />;
  const bookmark = <BookmarkTitleAction {...bookmarkAction} />;

  return (
    <section
      ref={readerRoot}
      className={cn(
        "epub-navigator-reader epub-navigator-theme relative isolate h-full min-h-0 overflow-hidden bg-background text-foreground [container-type:size]",
        colorPreference,
        colorPreference === "dark" ? "[color-scheme:dark]" : "[color-scheme:light]",
        className,
      )}
      data-reader-state={diagnostics.state}
      data-interaction-feedback={interactionFeedback ?? "standard"}
      data-reader-status={diagnostics.status}
      data-reader-measuring={diagnostics.measuring || undefined}
      data-pagination-publication-sequence={diagnostics.pagination?.publicationSequence}
      data-pagination-coverage={diagnostics.pagination?.pageCountCoverage.state}
      data-pagination-activity={diagnostics.pagination?.activity}
      data-pagination-page-count={diagnostics.pagination?.totalPageCount ?? undefined}
      data-pagination-measured={diagnostics.pagination?.pageCountCoverage.measuredOccurrences}
      data-pagination-total={diagnostics.pagination?.pageCountCoverage.totalOccurrences}
      data-pagination-toc={diagnostics.pagination?.tocEnrichment.state}
      data-pagination-cache={diagnostics.pagination?.cachePersistence}
      data-pagination-targets-measured={diagnostics.pagination?.tocEnrichment.measuredTargets}
      data-pagination-targets-total={diagnostics.pagination?.tocEnrichment.totalTargets}
      data-section-first-visible-page={diagnostics.paginatedLayout?.firstVisiblePage}
      data-section-page-count={diagnostics.paginatedLayout?.pageCount}
      data-document-adapter={diagnostics.documentAdapter}
      data-presentation-mode={diagnostics.presentationMode}
      data-layout-settlement={diagnostics.layoutSettlement}
      data-layout-issue={diagnostics.layoutIssue}
      data-display-profile={chrome.compact ? "compact" : "workspace"}
      data-reader-fullscreen={
        (chrome.fullscreen.active && chrome.fullscreen.fillsViewport) || undefined
      }
      data-page-progression={chrome.progressionDirection}
      data-writing-mode={chrome.observation?.writingMode}
      aria-label={`${chrome.title} reader`}
    >
      <aside
        className="epub-navigator-reader__workspace-slot epub-navigator-reader__workspace-slot--navigation"
        data-effective={workspace.fit.navigation}
        aria-label={`${navigationTitleAction.mode === "search" ? "Search" : "Navigation"} sidebar`}
        style={{
          inlineSize: workspace.fit.navigation === "pinned" ? workspace.state.navigation.width : 0,
        }}
        aria-hidden={chrome.compact || workspace.fit.navigation !== "pinned"}
      >
        {!chrome.compact && workspace.fit.navigation === "pinned" ? (
          <WorkspacePanel
            side="navigation"
            state={workspace.state.navigation}
            direction={chrome.progressionDirection}
            onChange={(next) => workspace.setState({ ...workspace.state, navigation: next })}
            label={navigationTitleAction.mode === "search" ? "Search" : "Navigation"}
            titleAction={navigationAction}
          >
            {navigationContent}
          </WorkspacePanel>
        ) : null}
      </aside>

      <div
        className="epub-navigator-reader__book-region"
        style={
          {
            "--reader-publication-color-scheme": publicationColorScheme(
              publication.preferences.publicationTheme,
              publication.colorPreference,
            ),
            "--reader-publication-surround": publication.surround,
          } as CSSProperties
        }
      >
        {chrome.compact ? (
          <header
            className="epub-navigator-reader__compact-top-rail"
            role="presentation"
            onClick={() => compact.setSurface("quick-menu")}
          >
            <button
              type="button"
              className="epub-navigator-reader__compact-menu-trigger"
              aria-label="Open quick menu"
            >
              <span dir={chrome.titleDirection ?? undefined}>{chrome.title}</span>
            </button>
            <span className="epub-navigator-reader__compact-status">
              <ReaderStatusOrnament status={diagnostics.status} compact />
              <MeasuringIndicator measuring={diagnostics.measuring} />
            </span>
            <span
              className="epub-navigator-reader__compact-book-progress"
              aria-label={chrome.topProgressAccessibleLabel}
            >
              {chrome.topProgressLabel}
            </span>
          </header>
        ) : (
          <WorkspaceToolbar
            title={chrome.title}
            titleDirection={chrome.titleDirection}
            coverUrl={publicationDetails.coverUrl}
            progress={chrome.topProgressLabel}
            progressAccessibleLabel={chrome.topProgressAccessibleLabel}
            status={diagnostics.status}
            measuring={diagnostics.measuring}
            navigationOpen={workspace.state.navigation.open}
            annotationsOpen={workspace.state.annotations.open}
            root={readerRootElement}
            titleTrigger={workspace.titleTrigger}
            returnFocus={workspace.returnFocus}
            onInteraction={workspace.onToolbarInteraction}
            preferences={chrome.preferences}
            setPreferences={chrome.setPreferences}
            fixedView={fixedView}
            fullscreen={chrome.fullscreen}
            hostControls={chrome.hostControls}
            onNavigation={() =>
              workspace.setState({
                ...workspace.state,
                annotations:
                  !workspace.state.navigation.open && workspace.fit.annotations === "overlay"
                    ? { ...workspace.state.annotations, open: false }
                    : workspace.state.annotations,
                navigation: {
                  ...workspace.state.navigation,
                  open: !workspace.state.navigation.open,
                },
              })
            }
            onAnnotations={() =>
              workspace.setState({
                ...workspace.state,
                navigation:
                  !workspace.state.annotations.open && workspace.fit.navigation === "overlay"
                    ? { ...workspace.state.navigation, open: false }
                    : workspace.state.navigation,
                annotations: {
                  ...workspace.state.annotations,
                  open: !workspace.state.annotations.open,
                },
              })
            }
            onSettings={() => workspace.setSurface("settings")}
            onKeyboardShortcuts={chrome.onKeyboardShortcuts}
            onZoomAdjustment={() => workspace.setSurface("zoom")}
            onPublicationDetails={() => workspace.setSurface("publication-details")}
            onLibraryRequest={publicationDetails.onLibraryRequest}
          />
        )}
        <PublicationStage {...publication} />

        {(chrome.compact ? compact.surface === "zoom" : workspace.surface === "zoom") &&
        fixedView !== null ? (
          <ZoomAdjustment
            state={fixedView}
            onZoom={workspace.setZoom}
            onClose={() => (chrome.compact ? compact.setSurface(null) : workspace.setSurface(null))}
          />
        ) : null}

        <CompactBottomRail
          className={chrome.compact ? undefined : "epub-navigator-reader__workspace-bottom-rail"}
          projection={progress.book}
          progression={chrome.progressionDirection}
          section={progress.sectionLabel}
          sectionPages={progress.pageProgress}
          narration={narration}
          narrationCovered={
            chrome.compact && compact.surface !== null && compact.surface !== "zoom"
          }
          onOpen={chrome.compact ? () => compact.setSurface("navigation") : undefined}
          onSectionOpen={
            chrome.compact
              ? undefined
              : () =>
                  workspace.setState({
                    ...workspace.state,
                    navigation: {
                      ...workspace.state.navigation,
                      open: !workspace.state.navigation.open,
                    },
                  })
          }
        />
      </div>

      <aside
        className="epub-navigator-reader__workspace-slot epub-navigator-reader__workspace-slot--annotations"
        data-effective={workspace.fit.annotations}
        aria-label="Annotations sidebar"
        style={{
          inlineSize:
            workspace.fit.annotations === "pinned" ? workspace.state.annotations.width : 0,
        }}
        aria-hidden={chrome.compact || workspace.fit.annotations !== "pinned"}
      >
        {!chrome.compact && workspace.fit.annotations === "pinned" ? (
          <WorkspacePanel
            side="annotations"
            state={workspace.state.annotations}
            direction={chrome.progressionDirection}
            onChange={(next) => workspace.setState({ ...workspace.state, annotations: next })}
            titleAction={bookmark}
          >
            {annotationsContent}
          </WorkspacePanel>
        ) : null}
      </aside>

      {chrome.compact && noteDraft === null ? (
        <CompactReaderSurfaces
          surface={compact.surface}
          setSurface={compact.setSurface}
          root={readerRootElement}
          finalFocus={() =>
            store.get(noteDraftAtom) === null ? activePublicationFrame(frameHostElement) : null
          }
          title={chrome.title}
          tocContent={compactNavigationContent}
          annotationsContent={annotationsContent}
          annotationsTitleAction={bookmark}
          navigationMode={navigationTitleAction.mode}
          searchAvailable={search.available}
          searchBusy={search.busy}
          searchInput={search.input}
          searchScope={search.scope}
          publicationSearchAvailable={search.publicationAvailable}
          occurrenceSearchAvailable={search.occurrenceAvailable}
          searchOccurrenceLabel={search.occurrenceLabel}
          onSearchScopeChange={search.changeScope}
          onSearchSubmit={() => void search.run()}
          onOpenSearch={search.open}
          onCloseSearch={search.close}
          preferences={chrome.preferences}
          setPreferences={chrome.setPreferences}
          readerTypefaces={chrome.readerTypefaces}
          hostControls={chrome.hostControls}
          onLibraryRequest={publicationDetails.onLibraryRequest}
          onLinkActivation={publicationDetails.onLinkActivation}
          metadata={publicationDetails.facts.package.metadata}
          packageDirection={publicationDetails.facts.package.dir}
          coverUrl={publicationDetails.coverUrl}
          fullscreen={chrome.fullscreen}
          fixedView={fixedView}
        />
      ) : null}

      {!chrome.compact ? (
        <WorkspaceSurfaces
          onLinkActivation={publicationDetails.onLinkActivation}
          surface={workspace.surface}
          setSurface={workspace.setSurface}
          root={readerRootElement}
          frameHost={frameHostElement}
          title={chrome.title}
          metadata={publicationDetails.facts.package.metadata}
          packageDirection={publicationDetails.facts.package.dir}
          coverUrl={publicationDetails.coverUrl}
          preferences={chrome.preferences}
          setPreferences={chrome.setPreferences}
          readerTypefaces={chrome.readerTypefaces}
          hostControls={chrome.hostControls}
          navigationOverlay={workspace.fit.navigation === "overlay"}
          annotationsOverlay={workspace.fit.annotations === "overlay"}
          workspaceState={workspace.state}
          setWorkspaceState={workspace.setState}
          navigationContent={navigationContent}
          navigationLabel={navigationTitleAction.mode === "search" ? "Search" : "Navigation"}
          navigationInitialFocus={
            navigationTitleAction.mode === "search" ? search.input : undefined
          }
          navigationTitleAction={navigationAction}
          annotationsContent={annotationsContent}
          annotationsTitleAction={bookmark}
          canPin={workspace.canPin}
          titleTrigger={workspace.titleTrigger}
          returnFocus={workspace.returnFocus}
        />
      ) : null}

      {dictionary.available && chrome.compact && compact.surface === "dictionary" ? (
        <DictionarySheet
          {...dictionary.content}
          root={readerRootElement}
          finalFocus={() => activePublicationFrame(frameHostElement)}
          onBack={dictionary.onBack}
          onClose={dictionary.onClose}
        />
      ) : null}
      {dictionary.available && !chrome.compact && dictionary.anchor !== null ? (
        <DictionaryPopover
          {...dictionary.content}
          anchor={dictionary.anchor}
          root={readerRootElement}
          finalFocus={() => activePublicationFrame(frameHostElement)}
          onBack={dictionary.onBack}
          onClose={dictionary.onClose}
        />
      ) : null}

      <NoteEditorDialog
        {...noteEditor}
        compact={chrome.compact}
        root={readerRootElement}
        frameHost={frameHostElement}
      />
    </section>
  );
}
