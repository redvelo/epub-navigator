import { useEffect, useRef, useState, type RefObject } from "react";
import { Library, MessageSquareText, PanelLeft, X } from "lucide-react";
import type { TextDirection } from "../../generated/publication.js";
import type { FixedViewState } from "../../runtime/navigator/api.js";
import { Button } from "../components/ui/button.js";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../components/ui/popover.js";
import { CompactQuickMenu } from "../preferences/controls.js";
import { MeasuringIndicator, ReaderStatusOrnament } from "../status/ornament.js";
import type { FullscreenController } from "../input/fullscreen.js";
import type { PreferencesSetter } from "../runtime/preferences.js";
import type { ReaderStatus } from "../status/ornament.js";
import type { NavigatorReaderHostControls, NavigatorReaderPreferences } from "../public-types.js";
import { PublicationDetailsTrigger } from "../publication-details-trigger.js";

export function WorkspaceToolbar({
  title,
  titleDirection,
  coverUrl,
  progress,
  progressAccessibleLabel,
  status,
  measuring,
  navigationOpen,
  annotationsOpen,
  root,
  titleTrigger,
  returnFocus,
  onInteraction,
  preferences,
  setPreferences,
  fixedView,
  fullscreen,
  onNavigation,
  onAnnotations,
  onSettings,
  onKeyboardShortcuts,
  onZoomAdjustment,
  onPublicationDetails,
  onLibraryRequest,
  hostControls,
}: {
  readonly title: string;
  readonly titleDirection: TextDirection | null;
  readonly coverUrl: string | null;
  readonly progress: string;
  readonly progressAccessibleLabel?: string | undefined;
  readonly status: ReaderStatus;
  readonly measuring: boolean;
  readonly navigationOpen: boolean;
  readonly annotationsOpen: boolean;
  readonly root: HTMLElement | null;
  readonly titleTrigger: RefObject<HTMLButtonElement | null>;
  readonly returnFocus: () => HTMLElement | null;
  readonly onInteraction: () => void;
  readonly preferences: NavigatorReaderPreferences;
  readonly setPreferences: PreferencesSetter;
  readonly fixedView: FixedViewState | null;
  readonly fullscreen: FullscreenController;
  readonly onNavigation: () => void;
  readonly onAnnotations: () => void;
  readonly onSettings: () => void;
  readonly onKeyboardShortcuts: () => void;
  readonly onZoomAdjustment: () => void;
  readonly onPublicationDetails: () => void;
  readonly onLibraryRequest: (() => void) | undefined;
  readonly hostControls?: NavigatorReaderHostControls | undefined;
}) {
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const appearanceAction = useRef<
    "library" | "publication-details" | "settings" | "shortcuts" | "zoom" | null
  >(null);
  const appearanceAnchor = useRef<{
    readonly contextElement: HTMLButtonElement;
    readonly getBoundingClientRect: () => DOMRect;
  } | null>(null);
  useEffect(() => {
    if (!appearanceOpen || root === null) return;
    const document = root.ownerDocument;
    const view = document.defaultView;
    if (view === null) return;
    const dismissForPublicationFocus = () => {
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active instanceof HTMLIFrameElement && root.contains(active)) setAppearanceOpen(false);
      });
    };
    view.addEventListener("blur", dismissForPublicationFocus);
    return () => view.removeEventListener("blur", dismissForPublicationFocus);
  }, [appearanceOpen, root]);
  return (
    <header
      className="epub-navigator-reader__workspace-toolbar"
      role="toolbar"
      aria-label="Reader controls"
      onPointerDownCapture={onInteraction}
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") onInteraction();
      }}
    >
      <Button
        type="button"
        className="epub-navigator-reader__workspace-navigation"
        variant="ghost"
        size="icon-sm"
        data-rhea-local-action="compact"
        aria-label="Navigation"
        title="Navigation (t)"
        aria-keyshortcuts="t"
        aria-pressed={navigationOpen}
        onClick={onNavigation}
      >
        <PanelLeft aria-hidden="true" />
      </Button>
      <Popover
        open={appearanceOpen}
        onOpenChange={setAppearanceOpen}
        onOpenChangeComplete={(open) => {
          if (open || appearanceAction.current === null) return;
          const action = appearanceAction.current;
          appearanceAction.current = null;
          if (action === "library") onLibraryRequest?.();
          else if (action === "publication-details") onPublicationDetails();
          else if (action === "settings") onSettings();
          else if (action === "shortcuts") onKeyboardShortcuts();
          else onZoomAdjustment();
        }}
      >
        <PopoverTrigger
          render={
            <button
              ref={titleTrigger}
              type="button"
              className="epub-navigator-reader__workspace-title"
              dir="auto"
              aria-label={`Open quick menu for ${title}`}
              title="Quick menu (q)"
              aria-keyshortcuts="q"
              onPointerDown={(event) => {
                const titleBounds = event.currentTarget.getBoundingClientRect();
                const anchorBounds = DOMRect.fromRect({
                  x: event.clientX,
                  y: titleBounds.bottom,
                });
                appearanceAnchor.current = {
                  contextElement: event.currentTarget,
                  getBoundingClientRect: () => anchorBounds,
                };
              }}
              onKeyDown={() => {
                appearanceAnchor.current = null;
              }}
              onClick={(event) => {
                if (event.detail === 0) appearanceAnchor.current = null;
              }}
            />
          }
        >
          <strong dir={titleDirection ?? undefined}>{title}</strong>
        </PopoverTrigger>
        <PopoverContent
          finalFocus={returnFocus}
          portalContainer={root ?? undefined}
          positionerProps={{
            anchor: () => appearanceAnchor.current ?? titleTrigger.current,
            side: "bottom",
            align: "center",
          }}
        >
          <header
            className="grid min-h-16 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center border-b p-1"
            dir="ltr"
          >
            <PopoverTitle className="sr-only">Quick Menu</PopoverTitle>
            {onLibraryRequest === undefined ? (
              <span />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                data-rhea-local-action
                aria-label="Back to library"
                title="Back to library (Shift+B)"
                aria-keyshortcuts="Shift+B"
                onClick={() => {
                  appearanceAction.current = "library";
                  setAppearanceOpen(false);
                }}
              >
                <Library aria-hidden="true" />
              </Button>
            )}
            <PublicationDetailsTrigger
              coverUrl={coverUrl}
              onClick={() => {
                appearanceAction.current = "publication-details";
                setAppearanceOpen(false);
              }}
            />
            <PopoverClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  data-rhea-local-action
                  aria-label="Close quick menu"
                />
              }
            >
              <X aria-hidden="true" />
            </PopoverClose>
          </header>
          <CompactQuickMenu
            preferences={preferences}
            setPreferences={setPreferences}
            fullscreen={fullscreen.active}
            fullscreenAvailable={fullscreen.available}
            onFullscreen={() => {
              fullscreen.toggle();
              setAppearanceOpen(false);
            }}
            additionalControls={hostControls?.quickMenu}
            onZoomAdjustment={
              fixedView === null
                ? undefined
                : () => {
                    appearanceAction.current = "zoom";
                    setAppearanceOpen(false);
                  }
            }
            onSettings={() => {
              appearanceAction.current = "settings";
              setAppearanceOpen(false);
            }}
            onKeyboardShortcuts={() => {
              appearanceAction.current = "shortcuts";
              setAppearanceOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <span className="epub-navigator-reader__workspace-status" aria-live="polite">
        <MeasuringIndicator measuring={measuring} />
        <ReaderStatusOrnament status={status} compact />
        <span aria-label={progressAccessibleLabel}>{progress}</span>
      </span>
      <Button
        type="button"
        className="epub-navigator-reader__workspace-notes"
        variant="ghost"
        size="icon-sm"
        data-rhea-local-action="compact"
        aria-label="Annotations"
        title="Annotations (a)"
        aria-keyshortcuts="a"
        aria-pressed={annotationsOpen}
        onClick={onAnnotations}
      >
        <MessageSquareText aria-hidden="true" />
      </Button>
    </header>
  );
}
