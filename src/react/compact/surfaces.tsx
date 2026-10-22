import type { PublicationTypeface } from "../../generated/kernel.js";
import { useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Compass, MessageSquareText, Search as SearchIcon, X } from "lucide-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { Metadata, TextDirection } from "../../generated/publication.js";
import type { FixedViewState } from "../../runtime/navigator/api.js";
import type { NavigatorSearchScope } from "../../search.js";
import { Button } from "../components/ui/button.js";
import { Drawer, DrawerContent, DrawerTitle } from "../components/ui/drawer.js";
import { cn } from "../lib/utils.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { compactPanelAtom, compactSurfaceOriginAtom, dismissCompactSurfaceAtom } from "./state.js";
import { PaginatedOverflow } from "../paginated-overflow.js";
import { PaginationFooterContext } from "../pagination-footer-context.js";
import { SearchQueryForm } from "../search/panel.js";
import { CompactQuickMenu, ReadingSettings } from "../preferences/controls.js";
import { PublicationDetails } from "../workspace/surfaces.js";
import type { FullscreenController } from "../input/fullscreen.js";
import type { PreferencesSetter } from "../runtime/preferences.js";
import { panelLabel } from "../workspace/layout.js";
import type {
  NavigatorReaderHostControls,
  NavigatorReaderPreferences,
  NavigatorReaderProps,
} from "../public-types.js";

// The compact surfaces are full-bleed: they replace the reader's chrome rather than float over it.
// The bleed exists to cover an inset drawer's rubber band. A full-bleed surface has no inset,
// and the overhang would otherwise grow the reader's scroll height and shift the page under it.
const edgeToEdgeDrawer = "[--bleed:0px] [--drawer-inset:0px] rounded-none shadow-none";
const fullExtentDrawer = `${edgeToEdgeDrawer} [--drawer-content-height:100%] data-[swipe-axis=y]:[--drawer-content-max-height:none] border-0`;

const surfaceLabels: Record<NonNullable<CompactSurface>, string> = {
  "quick-menu": "quick menu",
  navigation: "navigation",
  settings: "reading settings",
  "publication-details": "publication details",
  zoom: "zoom",
  dictionary: "dictionary",
};

/**
 * A surface says how it leaves: back to the one it was opened from, or closed when it was
 * reached from the publication. The glyph is the promise, so the two are never interchangeable.
 */
export function SurfaceDismissal({
  origin,
  label,
  onDismiss,
}: {
  readonly origin: CompactSurface;
  readonly label: string;
  readonly onDismiss: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      data-rhea-local-action
      aria-label={origin === null ? `Close ${label}` : `Back to ${surfaceLabels[origin]}`}
      onClick={onDismiss}
    >
      {origin === null ? <X aria-hidden="true" /> : <ArrowLeft aria-hidden="true" />}
    </Button>
  );
}

export type CompactSurface =
  | "quick-menu"
  | "navigation"
  | "settings"
  | "publication-details"
  | "zoom"
  | "dictionary"
  | null;

export function CompactReaderSurfaces({
  surface,
  setSurface,
  root,
  finalFocus,
  title,
  metadata,
  packageDirection,
  coverUrl,
  fullscreen,
  tocContent,
  annotationsContent,
  annotationsTitleAction,
  navigationMode,
  searchAvailable,
  searchBusy,
  searchInput,
  searchScope,
  publicationSearchAvailable,
  occurrenceSearchAvailable,
  searchOccurrenceLabel,
  onSearchScopeChange,
  onSearchSubmit,
  onOpenSearch,
  onCloseSearch,
  preferences,
  setPreferences,
  readerTypefaces,
  onLibraryRequest,
  onLinkActivation,
  fixedView,
  hostControls,
}: {
  readonly surface: CompactSurface;
  readonly setSurface: (surface: CompactSurface) => void;
  readonly root: HTMLElement | null;
  readonly finalFocus: () => HTMLElement | null;
  readonly title: string;
  readonly metadata: Metadata;
  readonly packageDirection: TextDirection | null;
  readonly coverUrl: string | null;
  readonly fullscreen: FullscreenController;
  readonly tocContent: ReactNode;
  readonly annotationsContent: ReactNode;
  readonly annotationsTitleAction: ReactNode;
  readonly navigationMode: "navigation" | "search";
  readonly searchAvailable: boolean;
  readonly searchBusy: boolean;
  readonly searchInput: RefObject<HTMLInputElement | null>;
  readonly searchScope: NavigatorSearchScope["type"];
  readonly publicationSearchAvailable: boolean;
  readonly occurrenceSearchAvailable: boolean;
  readonly searchOccurrenceLabel: string | null;
  readonly onSearchScopeChange: (scope: NavigatorSearchScope["type"]) => void;
  readonly onSearchSubmit: () => void;
  readonly onOpenSearch: () => void;
  readonly onCloseSearch: () => void;
  readonly preferences: NavigatorReaderPreferences;
  readonly setPreferences: PreferencesSetter;
  readonly readerTypefaces: readonly PublicationTypeface[];
  readonly onLibraryRequest: (() => void) | undefined;
  readonly onLinkActivation: NavigatorReaderProps["onLinkActivation"];
  readonly fixedView: FixedViewState | null;
  readonly hostControls?: NavigatorReaderHostControls | undefined;
}) {
  const settingsOrigin = useAtomValue(compactSurfaceOriginAtom);
  const dismissSettings = useSetAtom(dismissCompactSurfaceAtom);
  if (surface === "settings") {
    return (
      <Drawer modal="trap-focus" open onOpenChange={(open) => !open && setSurface(null)}>
        <DrawerContent
          contained
          backdropClassName="epub-navigator-reader__surface-backdrop"
          portalContainer={root ?? undefined}
          finalFocus={finalFocus}
          className={cn("epub-navigator-reader__compact-sheet", fullExtentDrawer)}
        >
          <header className="epub-navigator-reader__compact-titled-header grid min-h-12 grid-cols-[2.75rem_minmax(0,1fr)_minmax(2.75rem,auto)] items-center border-b p-1">
            <SurfaceDismissal
              origin={settingsOrigin}
              label="reading settings"
              onDismiss={() => {
                dismissSettings();
              }}
            />
            <DrawerTitle
              aria-label="Reading settings"
              className="min-w-0 truncate text-center font-medium"
            >
              Settings
            </DrawerTitle>
            <span />
          </header>
          <PaginatedOverflow pageLabel="Settings">
            <ReadingSettings
              preferences={preferences}
              setPreferences={setPreferences}
              readerTypefaces={readerTypefaces}
              deviceControls={hostControls?.deviceSettings}
              paginated
            />
          </PaginatedOverflow>
        </DrawerContent>
      </Drawer>
    );
  }
  if (surface === "zoom" || surface === "dictionary") return null;
  return (
    <CompactDrawerSurface
      surface={surface}
      setSurface={setSurface}
      root={root}
      finalFocus={finalFocus}
      title={title}
      metadata={metadata}
      packageDirection={packageDirection}
      coverUrl={coverUrl}
      tocContent={tocContent}
      annotationsContent={annotationsContent}
      annotationsTitleAction={annotationsTitleAction}
      navigationMode={navigationMode}
      searchAvailable={searchAvailable}
      searchBusy={searchBusy}
      searchInput={searchInput}
      searchScope={searchScope}
      publicationSearchAvailable={publicationSearchAvailable}
      occurrenceSearchAvailable={occurrenceSearchAvailable}
      searchOccurrenceLabel={searchOccurrenceLabel}
      onSearchScopeChange={onSearchScopeChange}
      onSearchSubmit={onSearchSubmit}
      onOpenSearch={onOpenSearch}
      onCloseSearch={onCloseSearch}
      preferences={preferences}
      setPreferences={setPreferences}
      onLibraryRequest={onLibraryRequest}
      onLinkActivation={onLinkActivation}
      fullscreen={fullscreen.active}
      fullscreenAvailable={fullscreen.available}
      onFullscreen={fullscreen.toggle}
      onZoomAdjustment={fixedView === null ? undefined : () => setSurface("zoom")}
      hostControls={hostControls}
    />
  );
}

function CompactDrawerSurface({
  surface,
  setSurface,
  root,
  finalFocus,
  title,
  metadata,
  packageDirection,
  coverUrl,
  tocContent,
  annotationsContent,
  annotationsTitleAction,
  navigationMode,
  searchAvailable,
  searchBusy,
  searchInput,
  searchScope,
  publicationSearchAvailable,
  occurrenceSearchAvailable,
  searchOccurrenceLabel,
  onSearchScopeChange,
  onSearchSubmit,
  onOpenSearch,
  onCloseSearch,
  preferences,
  setPreferences,
  onLibraryRequest,
  onLinkActivation,
  fullscreen,
  fullscreenAvailable,
  onFullscreen,
  onZoomAdjustment,
  hostControls,
}: {
  readonly surface: Exclude<CompactSurface, "settings" | "zoom" | "dictionary">;
  readonly setSurface: (surface: CompactSurface) => void;
  readonly root: HTMLElement | null;
  readonly finalFocus: () => HTMLElement | null;
  readonly title: string;
  readonly metadata: Metadata;
  readonly packageDirection: TextDirection | null;
  readonly coverUrl: string | null;
  readonly tocContent: ReactNode;
  readonly annotationsContent: ReactNode;
  readonly annotationsTitleAction: ReactNode;
  readonly navigationMode: "navigation" | "search";
  readonly searchAvailable: boolean;
  readonly searchBusy: boolean;
  readonly searchInput: RefObject<HTMLInputElement | null>;
  readonly searchScope: NavigatorSearchScope["type"];
  readonly publicationSearchAvailable: boolean;
  readonly occurrenceSearchAvailable: boolean;
  readonly searchOccurrenceLabel: string | null;
  readonly onSearchScopeChange: (scope: NavigatorSearchScope["type"]) => void;
  readonly onSearchSubmit: () => void;
  readonly onOpenSearch: () => void;
  readonly onCloseSearch: () => void;
  readonly preferences: NavigatorReaderPreferences;
  readonly setPreferences: PreferencesSetter;
  readonly onLibraryRequest: (() => void) | undefined;
  readonly onLinkActivation: NavigatorReaderProps["onLinkActivation"];
  readonly fullscreen: boolean;
  readonly fullscreenAvailable: boolean;
  readonly onFullscreen: () => void;
  readonly onZoomAdjustment: (() => void) | undefined;
  readonly hostControls?: NavigatorReaderHostControls | undefined;
}) {
  const [compactPanel, setCompactPanel] = useAtom(compactPanelAtom);
  const origin = useAtomValue(compactSurfaceOriginAtom);
  const dismiss = useSetAtom(dismissCompactSurfaceAtom);
  const onDismiss = () => {
    dismiss();
  };
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);
  // A drawer is still on screen while it slides out, so it keeps showing the surface it held.
  const [held, setHeld] = useState(surface);
  if (surface !== null && surface !== held) setHeld(surface);
  const shown = surface ?? held;
  const heading =
    shown === "navigation"
      ? compactPanel === "navigation"
        ? navigationMode === "search"
          ? "Search"
          : "Navigation"
        : "Annotations"
      : shown === "publication-details"
        ? "Publication details"
        : "Quick Menu";
  // Quick menu is a menu reached from the top rail, so it arrives from that edge and takes
  // only the height it needs. The panels are destinations and take the whole surface.
  const quickMenu = shown === "quick-menu";
  return (
    <Drawer
      modal="trap-focus"
      open={surface !== null}
      swipeDirection={quickMenu ? "up" : "down"}
      onOpenChange={(open) => {
        if (!open) setSurface(null);
      }}
    >
      <DrawerContent
        contained
        // A surface that only takes the height it needs leaves the publication visible behind
        // it; no fill means no dither on low-refresh displays. It still takes the presses meant
        // for it, which the publication's own frame would otherwise swallow.
        backdropClassName={quickMenu ? "bg-transparent" : "epub-navigator-reader__surface-backdrop"}
        onBackdropPress={() => setSurface(null)}
        portalContainer={root ?? undefined}
        initialFocus={
          shown === "navigation" && compactPanel === "navigation" && navigationMode === "search"
            ? searchInput
            : undefined
        }
        finalFocus={finalFocus}
        className={cn(
          "epub-navigator-reader__compact-sheet",
          quickMenu
            ? `${edgeToEdgeDrawer} data-[swipe-axis=y]:[--drawer-content-max-height:100%] border-x-0 border-t-0 border-b-2 border-border`
            : fullExtentDrawer,
        )}
      >
        {shown === "navigation" && compactPanel === "navigation" && navigationMode === "search" ? (
          <header className="epub-navigator-reader__compact-search-header grid min-h-12 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center border-b p-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-rhea-local-action
              aria-label="Back to navigation"
              onClick={onCloseSearch}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
            <DrawerTitle className="sr-only">Search</DrawerTitle>
            <SearchQueryForm
              inputRef={searchInput}
              portalContainer={root}
              compact
              busy={searchBusy}
              scope={searchScope}
              publicationScopeAvailable={publicationSearchAvailable}
              occurrenceScopeAvailable={occurrenceSearchAvailable}
              occurrenceLabel={searchOccurrenceLabel}
              onScopeChange={onSearchScopeChange}
              onSubmit={onSearchSubmit}
            />
            <span />
          </header>
        ) : shown === "quick-menu" ? (
          <header
            className="epub-navigator-reader__compact-menu-header grid min-h-12 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center border-b p-1"
            dir="ltr"
          >
            <SurfaceDismissal origin={origin} label="quick menu" onDismiss={onDismiss} />
            <DrawerTitle className="min-w-0 truncate text-center font-medium">
              {heading}
            </DrawerTitle>
            <span />
          </header>
        ) : (
          <header className="epub-navigator-reader__compact-titled-header grid min-h-12 grid-cols-[2.75rem_minmax(0,1fr)_minmax(2.75rem,auto)] items-center border-b p-1">
            <SurfaceDismissal
              origin={origin}
              label={heading.toLocaleLowerCase()}
              onDismiss={onDismiss}
            />
            <DrawerTitle aria-label={heading} className="min-w-0 truncate text-center font-medium">
              {shown === "publication-details" ? "Publication" : heading}
            </DrawerTitle>
            <div className="epub-navigator-reader__compact-header-actions flex items-center justify-end">
              {shown === "navigation" && compactPanel === "navigation" && searchAvailable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  data-rhea-local-action
                  aria-label="Search publication"
                  onClick={onOpenSearch}
                >
                  <SearchIcon aria-hidden="true" />
                </Button>
              ) : null}
              {shown === "navigation" && compactPanel === "annotations"
                ? annotationsTitleAction
                : null}
            </div>
          </header>
        )}
        {shown === "quick-menu" ? (
          // The quick menu is a short list of controls on a sheet that hugs it. Paginating it
          // put a page footer under content that never filled a page, and the sheet took that
          // empty row into its own height. It scrolls instead, on the rare window too short.
          <div className="min-h-0 flex-1 overflow-y-auto">
            <CompactQuickMenu
              paginated
              preferences={preferences}
              setPreferences={setPreferences}
              fullscreen={fullscreen}
              fullscreenAvailable={fullscreenAvailable}
              onFullscreen={() => {
                onFullscreen();
                onDismiss();
              }}
              additionalControls={hostControls?.quickMenu}
              onSettings={() => setSurface("settings")}
              onPublicationDetails={() => setSurface("publication-details")}
              onLibraryRequest={onLibraryRequest}
              onZoomAdjustment={onZoomAdjustment}
            />
          </div>
        ) : shown === "navigation" &&
          compactPanel === "navigation" &&
          navigationMode === "search" ? (
          <nav className="min-h-0 flex-1 overflow-hidden" aria-label="Publication search">
            {tocContent}
          </nav>
        ) : shown === "navigation" ? (
          <PaginationFooterContext value={footerHost}>
            <Tabs
              value={compactPanel}
              onValueChange={(value) => {
                if (value !== "navigation" && value !== "annotations") return;
                setCompactPanel(value);
              }}
              className="min-h-0 flex-1 gap-0"
            >
              <TabsContent value="navigation" className="min-h-0">
                <nav className="h-full overflow-hidden" aria-label="Publication navigation">
                  {tocContent}
                </nav>
              </TabsContent>
              <TabsContent value="annotations" className="min-h-0">
                {annotationsContent}
              </TabsContent>
              <div ref={setFooterHost} className="shrink-0" />
              <TabsList
                className="m-2 mt-0 grid h-auto min-h-11 w-auto grid-cols-2"
                aria-label="Reader panels"
              >
                {(["navigation", "annotations"] as const).map((panel) => (
                  <TabsTrigger
                    key={panel}
                    value={panel}
                    className="min-h-11"
                    aria-label={panelLabel(panel)}
                  >
                    {panel === "navigation" ? (
                      <Compass className="size-5" aria-hidden="true" />
                    ) : (
                      <MessageSquareText className="size-5" aria-hidden="true" />
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </PaginationFooterContext>
        ) : shown === "publication-details" ? (
          <PublicationDetails
            title={title}
            metadata={metadata}
            packageDirection={packageDirection}
            coverUrl={coverUrl}
            onLinkActivation={onLinkActivation}
            paginated
          />
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
