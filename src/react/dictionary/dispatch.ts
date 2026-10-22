import { atom } from "jotai";
import { dispatchCommand } from "../lib/dispatch.js";
import {
  dictionaryAnchorAtom,
  dictionaryCoordinatorAtom,
  effectiveDictionaryAnchorAtom,
} from "./state.js";
import {
  compactSurfaceAtom,
  dismissCompactSurfaceAtom,
  setCompactSurfaceAtom,
} from "../compact/state.js";
import type {
  NavigatorDictionaryLookupRequest,
  NavigatorDictionarySectionRef,
} from "../../dictionary.js";

export const lookUpDictionaryAtom = atom(
  null,
  (
    get,
    _set,
    request: {
      readonly text: string;
      readonly language: string | null;
      readonly initiator: NavigatorDictionaryLookupRequest["initiator"];
    },
  ) => {
    dispatchCommand(
      get(dictionaryCoordinatorAtom)?.lookup(request.text, request.language, request.initiator),
    );
  },
);

export const loadDictionarySectionAtom = atom(
  null,
  (
    get,
    _set,
    request: { readonly handle: string; readonly section: NavigatorDictionarySectionRef },
  ) => {
    dispatchCommand(get(dictionaryCoordinatorAtom)?.loadSection(request.handle, request.section));
  },
);

export const playDictionaryAtom = atom(null, (get, _set, handle: string) => {
  dispatchCommand(get(dictionaryCoordinatorAtom)?.play(handle));
});

export const stopDictionaryAtom = atom(null, (get) => {
  get(dictionaryCoordinatorAtom)?.stop();
});

export const backDictionaryAtom = atom(null, (get) => {
  get(dictionaryCoordinatorAtom)?.back();
});

/**
 * Leaves the reader's topmost surface: a dictionary lookup first, then whatever compact surface
 * is open. Reports whether there was one, so a host's Back can fall through to its own handling.
 */
export const dismissReaderSurfaceAtom = atom(null, (get, set): boolean => {
  if (get(effectiveDictionaryAnchorAtom) !== null) {
    set(stopDictionaryAtom);
    set(dictionaryAnchorAtom, null);
    if (get(compactSurfaceAtom) === "dictionary") set(setCompactSurfaceAtom, null);
    return true;
  }
  return set(dismissCompactSurfaceAtom);
});
