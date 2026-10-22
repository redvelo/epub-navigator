import type { PublicationTypeface } from "../../generated/kernel.js";
import type { ReactNode, RefObject } from "react";
import { Pin, PinOff, X } from "lucide-react";
import type { Metadata, TextDirection } from "../../generated/publication.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../components/ui/dialog.js";
import { PaginatedOverflow } from "../paginated-overflow.js";
import { publicationDetails } from "../publication-details.js";
import { resolvedMetadataDirection } from "../lib/metadata-direction.js";
import { PublicationDescription } from "../publication-description.js";
import type { NavigatorReaderProps } from "../public-types.js";
import { ReadingSettings } from "../preferences/controls.js";
import { activePublicationFrame } from "../input/focus.js";
import { cn } from "../lib/utils.js";
import type { PreferencesSetter } from "../runtime/preferences.js";
import { panelLabel, type WorkspaceSurface } from "./layout.js";
import type {
  NavigatorReaderHostControls,
  NavigatorReaderPreferences,
  NavigatorReaderWorkspaceState,
} from "../public-types.js";

export function WorkspaceSurfaces({
  surface,
  setSurface,
  root,
  frameHost,
  title,
  metadata,
  packageDirection,
  coverUrl,
  onLinkActivation,
  preferences,
  setPreferences,
  readerTypefaces,
  navigationOverlay,
  annotationsOverlay,
  workspaceState,
  setWorkspaceState,
  navigationContent,
  navigationLabel,
  navigationInitialFocus,
  navigationTitleAction,
  annotationsContent,
  annotationsTitleAction,
  canPin,
  titleTrigger,
  returnFocus,
  hostControls,
}: {
  readonly surface: WorkspaceSurface;
  readonly setSurface: (surface: WorkspaceSurface) => void;
  readonly root: HTMLElement | null;
  readonly frameHost: HTMLElement | null;
  readonly title: string;
  readonly metadata: Metadata;
  readonly packageDirection: TextDirection | null;
  readonly coverUrl: string | null;
  readonly onLinkActivation: NavigatorReaderProps["onLinkActivation"];
  readonly preferences: NavigatorReaderPreferences;
  readonly setPreferences: PreferencesSetter;
  readonly readerTypefaces: readonly PublicationTypeface[];
  readonly navigationOverlay: boolean;
  readonly annotationsOverlay: boolean;
  readonly workspaceState: NavigatorReaderWorkspaceState;
  readonly setWorkspaceState: (state: NavigatorReaderWorkspaceState) => void;
  readonly navigationContent: ReactNode;
  readonly navigationLabel: string;
  readonly navigationInitialFocus?: RefObject<HTMLInputElement | null> | undefined;
  readonly navigationTitleAction: ReactNode;
  readonly annotationsContent: ReactNode;
  readonly annotationsTitleAction: ReactNode;
  readonly canPin: { readonly navigation: boolean; readonly annotations: boolean };
  readonly titleTrigger: RefObject<HTMLButtonElement | null>;
  readonly returnFocus: () => HTMLElement | null;
  readonly hostControls?: NavigatorReaderHostControls | undefined;
}) {
  if (surface === "zoom") return null;
  const finalFocus = () => activePublicationFrame(frameHost);
  const modal = (side: "navigation" | "annotations", open: boolean, content: ReactNode) => {
    const panel = workspaceState[side];
    const close = () => setWorkspaceState({ ...workspaceState, [side]: { ...panel, open: false } });
    const label = side === "navigation" ? navigationLabel : panelLabel(side);
    const header = (closeControl: ReactNode) => (
      <header className="epub-navigator-reader__workspace-panel-header">
        <strong>{label}</strong>
        {side === "annotations" ? annotationsTitleAction : navigationTitleAction}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-rhea-local-action="compact"
          aria-label={
            panel.pinned
              ? `Cancel pinning ${label.toLocaleLowerCase()} panel`
              : `Pin ${label.toLocaleLowerCase()} panel`
          }
          aria-description={
            !panel.pinned && !canPin[side]
              ? "More window space is required to pin this panel."
              : panel.pinned
                ? "This panel will pin automatically when enough space is available."
                : undefined
          }
          disabled={!panel.pinned && !canPin[side]}
          onClick={() =>
            setWorkspaceState({
              ...workspaceState,
              [side]: { ...panel, pinned: !panel.pinned },
            })
          }
        >
          {panel.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
        </Button>
        {closeControl}
      </header>
    );
    return (
      <Dialog modal="trap-focus" open={open} onOpenChange={(next) => !next && close()}>
        <DialogContent
          contained
          backdropClassName="bg-transparent transition-none"
          viewportClassName="p-0"
          portalContainer={root ?? undefined}
          initialFocus={side === "navigation" ? navigationInitialFocus : undefined}
          finalFocus={finalFocus}
          className={cn(
            "epub-navigator-reader__workspace-overlay absolute inset-block-0 m-0 h-full max-h-none max-w-none rounded-none",
            side === "navigation"
              ? "epub-navigator-reader__workspace-overlay--navigation start-0"
              : "epub-navigator-reader__workspace-overlay--annotations end-0",
            "shadow-none transition-none",
          )}
          style={{ inlineSize: panel.width, maxInlineSize: "100%" }}
        >
          <DialogTitle className="sr-only">{label}</DialogTitle>
          {header(
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-rhea-local-action="compact"
                  aria-label={`Close ${label.toLocaleLowerCase()} panel`}
                />
              }
            >
              <X aria-hidden="true" />
            </DialogClose>,
          )}
          <div className="min-h-0 flex-1">{content}</div>
        </DialogContent>
      </Dialog>
    );
  };
  const overlaySide =
    surface !== null
      ? null
      : navigationOverlay
        ? "navigation"
        : annotationsOverlay
          ? "annotations"
          : null;
  return (
    <>
      {modal("navigation", overlaySide === "navigation", navigationContent)}
      {modal("annotations", overlaySide === "annotations", annotationsContent)}
      <Dialog
        modal="trap-focus"
        open={surface === "settings"}
        onOpenChange={(open) => !open && setSurface(null)}
      >
        <DialogContent
          contained
          backdropClassName="bg-transparent transition-none"
          portalContainer={root ?? undefined}
          finalFocus={returnFocus}
          className="transition-none"
        >
          <header className="flex min-h-11 items-center border-b p-1 ps-4">
            <DialogTitle className="min-w-0 flex-1 font-medium">Reading settings</DialogTitle>
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-rhea-local-action="compact"
                  aria-label="Close reading settings"
                />
              }
            >
              <X aria-hidden="true" />
            </DialogClose>
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
        </DialogContent>
      </Dialog>
      <Dialog
        modal="trap-focus"
        open={surface === "publication-details"}
        onOpenChange={(open) => !open && setSurface(null)}
      >
        <DialogContent
          contained
          backdropClassName="bg-transparent transition-none"
          portalContainer={root ?? undefined}
          finalFocus={titleTrigger}
          className="transition-none"
        >
          <header className="flex min-h-11 items-center border-b p-1 ps-4">
            <DialogTitle className="min-w-0 flex-1 font-medium">Publication details</DialogTitle>
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-rhea-local-action="compact"
                  aria-label="Close publication details"
                />
              }
            >
              <X aria-hidden="true" />
            </DialogClose>
          </header>
          <PublicationDetails
            title={title}
            metadata={metadata}
            packageDirection={packageDirection}
            coverUrl={coverUrl}
            onLinkActivation={onLinkActivation}
            paginated
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function PublicationDetails({
  title,
  metadata,
  packageDirection,
  coverUrl,
  paginated,
  onLinkActivation,
}: {
  readonly title: string;
  readonly metadata: Metadata;
  readonly packageDirection: TextDirection | null;
  readonly coverUrl: string | null;
  readonly paginated: boolean;
  readonly onLinkActivation: NavigatorReaderProps["onLinkActivation"];
}) {
  const details = publicationDetails(metadata, packageDirection);
  const titleDirection = resolvedMetadataDirection(metadata.title[0]?.dir, packageDirection);
  const values = (label: string) => details.find((detail) => detail.label === label)?.values ?? [];
  const secondary = details.filter(
    (detail) => !["Title", "Creator", "Description", "Subject"].includes(detail.label),
  );
  const content = (
    <div className="epub-navigator-reader__publication-details">
      <header className="epub-navigator-reader__book-heading">
        {coverUrl === null ? null : (
          <img
            className="epub-navigator-reader__publication-cover"
            src={coverUrl}
            crossOrigin="anonymous"
            alt={`${title} cover`}
            decoding="async"
            referrerPolicy="no-referrer"
          />
        )}
        <div className="epub-navigator-reader__book-title">
          <h3 dir={titleDirection ?? "auto"}>{title}</h3>
          {values("Creator").map((creator, index) => (
            <p key={index} dir={creator.direction ?? "auto"}>
              {creator.content}
            </p>
          ))}
          {values("Title")
            .filter((value) => value.content !== title)
            .map((value, index) => (
              <p className="text-sm" key={`title-${index}`} dir={value.direction ?? "auto"}>
                {value.content}
              </p>
            ))}
        </div>
      </header>
      {values("Subject").length === 0 ? null : (
        <ul className="epub-navigator-reader__book-subjects" aria-label="Subjects">
          {values("Subject").map((subject, index) => (
            <li key={index} dir={subject.direction ?? "auto"}>
              {subject.content}
            </li>
          ))}
        </ul>
      )}
      {values("Description").length === 0 ? null : (
        <section aria-label="Description">
          {values("Description").map((description, index) => (
            <PublicationDescription
              key={index}
              markup={description.content}
              direction={description.direction}
              onLinkActivation={onLinkActivation}
            />
          ))}
        </section>
      )}
      {secondary.length === 0 ? null : (
        <section className="epub-navigator-reader__book-metadata" aria-label="Book details">
          <h3>Book details</h3>
          <dl>
            {secondary.map((detail) => (
              <div key={detail.label}>
                <dt>{detail.label}</dt>
                {detail.values.map((value, index) => (
                  <dd key={`${detail.label}-${index}`} dir={value.direction ?? "auto"}>
                    {value.content}
                  </dd>
                ))}
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
  return paginated ? (
    <PaginatedOverflow pageLabel="Publication details">{content}</PaginatedOverflow>
  ) : (
    <div className="min-h-0 overflow-y-auto">{content}</div>
  );
}
