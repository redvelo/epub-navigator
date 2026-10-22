import { atom } from "jotai";
import { hostHandlerAtoms } from "../lib/publish.js";
import type { NavigatorDictionarySnapshot } from "../../dictionary.js";
import type { ReaderSessionId } from "../../publication.js";
import type {
  NavigatorDictionaryCoordinator,
  PublicationDictionaryCapabilities,
} from "../../runtime/dictionary.js";
import type { SelectionToolbarRect } from "../selection-toolbar.js";
import { readerCompactAtom, surfaceProfileAtom } from "../compact/state.js";

export const idleDictionarySnapshot: NavigatorDictionarySnapshot = {
  lookup: { state: "idle" },
  history: [],
  playback: null,
};

export const dictionarySnapshotAtom = atom<NavigatorDictionarySnapshot>(idleDictionarySnapshot);
/** Viewport rectangle of the looked-up selection while the workspace popover is open. */
export const dictionaryAnchorAtom = atom<SelectionToolbarRect | null>(null);

/** The dictionary anchor, or null when it belongs to the other layout profile. */
export const effectiveDictionaryAnchorAtom = atom((get) =>
  get(surfaceProfileAtom) === get(readerCompactAtom) ? get(dictionaryAnchorAtom) : null,
);

export const setDictionaryAnchorAtom = atom(
  null,
  (get, set, anchor: SelectionToolbarRect | null) => {
    set(surfaceProfileAtom, get(readerCompactAtom));
    set(dictionaryAnchorAtom, anchor);
  },
);

export const resetDictionarySessionAtom = atom(null, (_get, set) => {
  set(dictionarySnapshotAtom, idleDictionarySnapshot);
  set(dictionaryAnchorAtom, null);
});

export interface DictionaryCoordinatorLease {
  readonly sessionId: ReaderSessionId;
  readonly capabilities: PublicationDictionaryCapabilities;
  readonly coordinator: NavigatorDictionaryCoordinator;
  readonly token: object;
}

export const dictionaryCoordinatorAtom = atom<NavigatorDictionaryCoordinator | null>(null);
export const dictionaryCoordinatorLeaseAtom = atom<DictionaryCoordinatorLease | null>(null);

export interface DictionaryCoordinatorInputs {
  readonly sessionId: ReaderSessionId;
  readonly capabilities: PublicationDictionaryCapabilities | undefined;
}

/** The coordinator's inputs, published as one value so the store effect has a single trigger. */
export const dictionaryCoordinatorInputsAtom = atom<DictionaryCoordinatorInputs | null>(null);

export function sameDictionaryCoordinatorInputs(
  left: DictionaryCoordinatorInputs | null,
  right: DictionaryCoordinatorInputs,
): boolean {
  return (
    left !== null && left.sessionId === right.sessionId && left.capabilities === right.capabilities
  );
}

export const {
  handler: dictionarySnapshotHandlerAtom,
  publish: publishDictionarySnapshotHandlerAtom,
} = hostHandlerAtoms<(snapshot: NavigatorDictionarySnapshot) => void>();
