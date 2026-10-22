import { atom } from "jotai";
import type { NavigatorLocationSnapshot } from "../../generated/kernel.js";
import type { BookPaginationSnapshot } from "../../runtime/pagination/index.js";
import type { MeasuredAuthoredPages } from "./authored-pages.js";

export const paginationSnapshotAtom = atom<BookPaginationSnapshot | null>(null);
export const locationSnapshotAtom = atom<NavigatorLocationSnapshot | null>(null);
export const measuredAuthoredPagesAtom = atom<MeasuredAuthoredPages | null>(null);

export const resetPaginationAtom = atom(null, (_get, set) => {
  set(paginationSnapshotAtom, null);
});

export const resetLocationMeasurementAtom = atom(null, (_get, set) => {
  set(locationSnapshotAtom, null);
  set(measuredAuthoredPagesAtom, null);
});
