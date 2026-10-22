import { useCallback, useRef, useState } from "react";
import { decodePublicationRoute } from "../../mount.js";
import type { NavigatorLinkActivation, ReadNote } from "../public-types.js";
import type { NoteAnchor, NoteState } from "./surfaces.js";

export interface OpenNote {
  readonly note: NoteState;
  readonly anchor: NoteAnchor | null;
  readonly label: string | null;
}

/**
 * Shows the note a reference names, where the reader is.
 *
 * The agent leaves the page alone for a reference it reports, so everything here happens beside
 * the reading position rather than by moving it: one note at a time, the previous read abandoned
 * the moment another reference is taken.
 */
export function useNoteSurface({
  readNote,
  baseUrl,
  frameHost,
  takeTheReference,
}: {
  readonly readNote: ReadNote | undefined;
  readonly baseUrl: string;
  readonly frameHost: HTMLElement | null;
  /**
   * Takes the reading position to a note that could not be shown, and says whether it could.
   * A reference classified as a note leaves the page where it is, so without this a note the
   * host cannot read would be a note the reader cannot reach.
   */
  readonly takeTheReference: (target: {
    readonly resource: string;
    readonly fragment: string;
  }) => boolean;
}): {
  readonly open: OpenNote | null;
  readonly show: (activation: NavigatorLinkActivation) => boolean;
  readonly close: () => void;
} {
  const [open, setOpen] = useState<OpenNote | null>(null);
  const reading = useRef<AbortController | null>(null);
  const close = useCallback(() => {
    reading.current?.abort();
    reading.current = null;
    setOpen(null);
  }, []);
  const show = useCallback(
    (activation: NavigatorLinkActivation): boolean => {
      if (readNote === undefined || activation.note === null) return false;
      const target = noteTarget(baseUrl, activation.resolvedUrl);
      if (target === null) return false;
      reading.current?.abort();
      const owner = new AbortController();
      reading.current = owner;
      setOpen({
        note: { state: "reading" },
        anchor: anchorIn(frameHost, activation.note.referenceRect),
        label: activation.note.referenceLabel,
      });
      const unreadable = () => {
        if (reading.current !== owner) return;
        if (takeTheReference(target)) {
          close();
          return;
        }
        setOpen((current) =>
          current === null ? current : { ...current, note: { state: "unavailable" } },
        );
      };
      void readNote(target, owner.signal)
        .then((note) => {
          if (reading.current !== owner) return;
          if (note === null) {
            unreadable();
            return;
          }
          setOpen((current) =>
            current === null ? current : { ...current, note: { state: "ready", note } },
          );
        })
        .catch(unreadable);
      return true;
    },
    [baseUrl, close, frameHost, readNote, takeTheReference],
  );
  return { open, show, close };
}

/** The resource and fragment a reference names, or nothing when it names no note in this book. */
function noteTarget(
  baseUrl: string,
  resolvedUrl: string,
): { readonly resource: string; readonly fragment: string } | null {
  try {
    const target = new URL(resolvedUrl);
    if (target.hash.length <= 1) return null;
    return {
      resource: decodePublicationRoute(baseUrl, target.pathname),
      fragment: decodeURIComponent(target.hash.slice(1)),
    };
  } catch {
    return null;
  }
}

/**
 * Puts the reference's box into the reader's coordinates. The agent measured it inside the
 * publication frame, which sits wherever the reader put it.
 */
function anchorIn(
  frameHost: HTMLElement | null,
  rect: { x: number; y: number; width: number; height: number } | null,
): NoteAnchor | null {
  if (frameHost === null || rect === null) return null;
  const view = frameHost.ownerDocument.defaultView;
  if (view === null) return null;
  const host = frameHost.getBoundingClientRect();
  const left = host.left + rect.x - (view.visualViewport?.offsetLeft ?? 0);
  const top = host.top + rect.y - (view.visualViewport?.offsetTop ?? 0);
  return { left, top, right: left + rect.width, bottom: top + rect.height };
}
