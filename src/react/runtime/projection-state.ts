import { atom } from "jotai";
import { resetAnnotationSessionAtom } from "../annotations/state.js";
import { resetCompactSurfaceAtom } from "../compact/state.js";
import { resetDictionarySessionAtom } from "../dictionary/state.js";
import { resetFixedViewAtom } from "../fixed-layout/state.js";
import { resetAuthoredNavigationAtom } from "../navigation/state.js";
import { resetLocationMeasurementAtom, resetPaginationAtom } from "../progress/state.js";
import { resetSearchSessionAtom } from "../search/state.js";
import type { ReaderError } from "../status/errors.js";
import { resetWorkspaceSurfaceAtom } from "../workspace/state.js";
import type { ReaderSessionId } from "../../publication.js";
import type { NavigatorRuntime } from "../../runtime/navigator/api.js";
import type { KernelSnapshot } from "../../generated/kernel.js";
import type { VisibleOccurrenceRange } from "../../runtime/navigator/api.js";

export interface RuntimeView {
  readonly snapshot: KernelSnapshot;
  readonly visibleOccurrenceRange: VisibleOccurrenceRange | null;
  readonly finalSpreadLeadingOccurrence: number | null;
}

export const runtimeViewAtom = atom<RuntimeView | null>(null);
/** Runtime the reader is currently mounted on, so render can recognise its own intents. */
export const activeRuntimeAtom = atom<NavigatorRuntime | null>(null);
export const readerRootElementAtom = atom<HTMLElement | null>(null);
export const frameHostElementAtom = atom<HTMLDivElement | null>(null);
export const readerErrorAtom = atom<ReaderError | null>(null);
export const documentErrorAtom = atom<ReaderError | null>(null);
export const configurationErrorAtom = atom<ReaderError | null>(null);
export const sessionOwnerAtom = atom<ReaderSessionId | null>(null);

export const resetPublicationSessionAtom = atom(null, (_get, set, sessionId: ReaderSessionId) => {
  set(runtimeViewAtom, null);
  set(activeRuntimeAtom, null);
  set(resetAuthoredNavigationAtom);
  set(resetPaginationAtom);
  set(resetFixedViewAtom);
  set(resetAnnotationSessionAtom);
  set(resetLocationMeasurementAtom);
  set(resetSearchSessionAtom);
  set(resetDictionarySessionAtom);
  set(resetCompactSurfaceAtom);
  set(resetWorkspaceSurfaceAtom);
  set(documentErrorAtom, null);
  set(configurationErrorAtom, null);
  set(readerErrorAtom, null);
  set(sessionOwnerAtom, sessionId);
});
