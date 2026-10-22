import { atom } from "jotai";
import type { NavigatorLocationSnapshot } from "../../generated/kernel.js";
import type { NavigatorRuntime } from "../../runtime/navigator/api.js";
import { sameDurablePoint } from "../../runtime/selection/location-equivalence.js";
import { sameVisibleOccurrenceRange } from "../input/focus.js";
import {
  annotationActivationAtom,
  bookmarkCreateAtom,
  bookmarkMutationOperationAtom,
  dismissedSelectionRevisionAtom,
  selectionActionAtom,
  selectionActionOperationAtom,
  selectionSnapshotAtom,
} from "../annotations/state.js";
import { compactSurfaceAtom } from "../compact/state.js";
import { navigationIntentAtom } from "../navigation/state.js";
import { locationSnapshotAtom } from "../progress/state.js";
import type { ReaderError } from "../status/errors.js";
import { workspaceSurfaceAtom } from "../workspace/state.js";
import { readerErrorAtom } from "./projection-state.js";

/** The store half of a terminal runtime failure; the caller still owns the runtime itself. */
export const reportRuntimeFailureAtom = atom(null, (_get, set, error: ReaderError) => {
  set(navigationIntentAtom, null);
  set(annotationActivationAtom, null);
  set(compactSurfaceAtom, null);
  set(workspaceSurfaceAtom, null);
  set(readerErrorAtom, error);
});

export const applySelectionSnapshotAtom = atom(
  null,
  (get, set, next: ReturnType<NavigatorRuntime["currentSelection"]>) => {
    get(selectionActionOperationAtom)?.abort();
    set(selectionActionOperationAtom, null);
    set(selectionActionAtom, null);
    set(dismissedSelectionRevisionAtom, null);
    set(selectionSnapshotAtom, next);
  },
);

/**
 * Applies a location snapshot and reports whether it moved durably, which is what the host is
 * told about. A pending bookmark for a superseded location is abandoned.
 */
export const applyLocationSnapshotAtom = atom(
  null,
  (get, set, next: NavigatorLocationSnapshot): boolean => {
    const bookmark = get(bookmarkCreateAtom);
    const previous = get(locationSnapshotAtom);
    const movedDurably = !sameDurablePoint(
      previous?.location ?? null,
      previous?.basis ?? null,
      next.location,
      next.basis,
    );
    const durableLocationChanged =
      movedDurably ||
      !sameVisibleOccurrenceRange(previous?.visibleOccurrences ?? null, next.visibleOccurrences);
    if (bookmark !== null && bookmark.locationRevision !== next.revision && movedDurably) {
      get(bookmarkMutationOperationAtom)?.abort();
      set(bookmarkMutationOperationAtom, null);
      set(bookmarkCreateAtom, null);
    }
    set(locationSnapshotAtom, next);
    return durableLocationChanged;
  },
);
