import { useEffect, useLayoutEffect, useRef } from "react";
import { Drawer, DrawerContent, DrawerTitle } from "../components/ui/drawer.js";
import { Popover, PopoverContent } from "../components/ui/popover.js";
import { PaginatedOverflow } from "../paginated-overflow.js";
import { PublicationDescription } from "../publication-description.js";
import type { NavigatorNote } from "../public-types.js";

/** Where the note surface sits: the reference's box, already in the reader's own coordinates. */
export interface NoteAnchor {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type NoteState =
  | { readonly state: "reading" }
  | { readonly state: "ready"; readonly note: NavigatorNote }
  | { readonly state: "unavailable" };

export interface NoteSurfaceProps {
  readonly note: NoteState;
  /** The reference's own marker, as the publication printed it. */
  readonly label: string | null;
  readonly root: HTMLElement | null;
  readonly finalFocus: () => HTMLElement | null;
  readonly onClose: () => void;
}

/** What the reference itself was marked with, which is the only thing a title can usefully add. */
function noteTitle(label: string | null): string {
  return label === null || label === "" ? "Note" : `Note ${label}`;
}

function NoteBody({ note, label }: { readonly note: NoteState; readonly label: string | null }) {
  if (note.state !== "ready") {
    return (
      <div
        className="epub-navigator-reader__note-body"
        role="status"
        aria-busy={note.state === "reading" || undefined}
      >
        {note.state === "reading" ? "Reading the note…" : "This note could not be read."}
      </div>
    );
  }
  return (
    <PaginatedOverflow pageLabel={noteTitle(label)}>
      <div
        className="epub-navigator-reader__note-body"
        dir={note.note.direction ?? "auto"}
        lang={note.note.language ?? undefined}
      >
        {/* The note is the publication's own markup, so it is rendered the way every other
            publication-authored passage is: through the sanitizer, never as a document. */}
        <PublicationDescription
          markup={note.note.markup}
          direction={note.note.direction === "auto" ? null : note.note.direction}
          onLinkActivation={undefined}
        />
      </div>
    </PaginatedOverflow>
  );
}

/**
 * The note on a compact reader: a sheet that rises from the bottom edge and takes only the
 * height the note needs, so the reference stays in view above it. It carries no chrome of its
 * own. A note is a glance away from the text, not a destination, and leaves the way the quick
 * menu does: a press on the page behind it, a swipe, or Escape.
 */
export function NoteSheet(props: NoteSurfaceProps) {
  return (
    <Drawer modal="trap-focus" open onOpenChange={(open) => !open && props.onClose()}>
      <DrawerContent
        contained
        // Transparent, but present: the publication stays visible behind a sheet that hugs its
        // note, which means no fill to dither on a low-refresh display, and a press on it still
        // lands on something of the reader's rather than in the publication's own frame.
        backdropClassName="bg-transparent"
        onBackdropPress={props.onClose}
        portalContainer={props.root ?? undefined}
        finalFocus={props.finalFocus}
        className="epub-navigator-reader__compact-sheet epub-navigator-reader__note-sheet [--bleed:0px] [--drawer-inset:0px] rounded-none border-x-0 border-t-2 border-b-0 border-border shadow-none"
      >
        <DrawerTitle className="sr-only">{noteTitle(props.label)}</DrawerTitle>
        <NoteBody note={props.note} label={props.label} />
      </DrawerContent>
    </Drawer>
  );
}

export function NotePopover({
  anchor,
  ...props
}: NoteSurfaceProps & { readonly anchor: NoteAnchor }) {
  const onClose = useRef(props.onClose);
  useLayoutEffect(() => {
    onClose.current = props.onClose;
  });
  const root = props.root;
  useEffect(() => {
    const view = root?.ownerDocument.defaultView;
    if (root === null || view === null || view === undefined) return;
    // A press on the publication behind the note lands in its own frame, so it never reaches the
    // reader as an outside press. Losing focus to that frame is what says the reader pressed it.
    const dismissForPublicationFocus = () => {
      queueMicrotask(() => {
        const active = root.ownerDocument.activeElement;
        if (active instanceof HTMLIFrameElement && root.contains(active)) onClose.current();
      });
    };
    view.addEventListener("blur", dismissForPublicationFocus);
    return () => view.removeEventListener("blur", dismissForPublicationFocus);
  }, [root]);
  const virtualAnchor = {
    getBoundingClientRect: () =>
      DOMRect.fromRect({
        x: anchor.left,
        y: anchor.top,
        width: anchor.right - anchor.left,
        height: anchor.bottom - anchor.top,
      }),
  };
  return (
    <Popover open onOpenChange={(open) => !open && props.onClose()}>
      <PopoverContent
        portalContainer={props.root ?? undefined}
        finalFocus={props.finalFocus}
        backdrop
        aria-label={noteTitle(props.label)}
        className="epub-navigator-reader__note-popover flex w-[min(26rem,calc(100cqw-1rem))] flex-col"
        positionerProps={{ anchor: virtualAnchor, side: "bottom", align: "center" }}
        initialFocus={(interaction) => (interaction === "mouse" ? false : undefined)}
      >
        <NoteBody note={props.note} label={props.label} />
      </PopoverContent>
    </Popover>
  );
}
