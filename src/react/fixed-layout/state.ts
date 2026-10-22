import { atom } from "jotai";
import type { FixedViewState } from "../../runtime/navigator/api.js";

export const fixedViewAtom = atom<FixedViewState | null>(null);

export const resetFixedViewAtom = atom(null, (_get, set) => {
  set(fixedViewAtom, null);
});
