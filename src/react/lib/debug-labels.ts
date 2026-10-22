import * as annotationsDispatch from "../annotations/dispatch.js";
import * as annotationsPanelState from "../annotations/panel-state.js";
import * as annotationsState from "../annotations/state.js";
import * as compactState from "../compact/state.js";
import * as dictionaryState from "../dictionary/state.js";
import * as fixedLayoutState from "../fixed-layout/state.js";
import * as mediaOverlayState from "../media-overlays/state.js";
import * as navigateAtom from "../navigation/navigate-atom.js";
import * as navigationState from "../navigation/state.js";
import * as progressState from "../progress/state.js";
import * as preferencesState from "../runtime/preferences-state.js";
import * as projectionState from "../runtime/projection-state.js";
import * as searchDispatch from "../search/dispatch.js";
import * as searchState from "../search/state.js";
import * as workspaceState from "../workspace/state.js";

const modules: readonly Record<string, unknown>[] = [
  annotationsDispatch,
  annotationsPanelState,
  annotationsState,
  compactState,
  dictionaryState,
  fixedLayoutState,
  mediaOverlayState,
  navigateAtom,
  navigationState,
  progressState,
  preferencesState,
  projectionState,
  searchDispatch,
  searchState,
  workspaceState,
];

function labelled(value: unknown): value is { debugLabel?: string } {
  return typeof value === "object" && value !== null && "read" in value;
}

/**
 * Names the reader's atoms after their exports for an atom inspector. jotai 3 no longer ships a
 * debug-label transform, and export names only survive unminified, so call this from a
 * development entry point rather than shipping it.
 */
export function applyReaderAtomDebugLabels(): void {
  for (const module of modules) {
    for (const [name, value] of Object.entries(module)) {
      if (labelled(value) && value.debugLabel === undefined) value.debugLabel = name;
    }
  }
}
