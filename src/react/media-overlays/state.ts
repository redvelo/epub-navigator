import { atom } from "jotai";
import type {
  NavigatorMediaOverlayController,
  NavigatorMediaOverlaySnapshot,
} from "../../runtime/media-overlays/controller.js";

/** Narration controller for the mounted session; render reads it to drive the transport. */
export const mediaOverlayControllerAtom = atom<NavigatorMediaOverlayController | null>(null);

export const mediaOverlaySnapshotAtom = atom<NavigatorMediaOverlaySnapshot | null>(null);

/** Whether the session can narrate at all, which render knows before the controller exists. */
export const mediaOverlayAvailableAtom = atom(false);

/** The narration snapshot, or null while the session cannot narrate. */
export const effectiveMediaOverlaySnapshotAtom = atom((get) =>
  get(mediaOverlayAvailableAtom) ? get(mediaOverlaySnapshotAtom) : null,
);

/** Drops the store's references. The caller closes the controller, including when superseded. */
export const clearMediaOverlayControllerAtom = atom(null, (_get, set) => {
  set(mediaOverlayControllerAtom, null);
  set(mediaOverlaySnapshotAtom, null);
});
