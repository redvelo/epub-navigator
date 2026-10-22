import { atom } from "jotai";
import { hostHandlerAtoms } from "../lib/publish.js";
import type {
  NavigatorReaderWorkspacePanelState,
  NavigatorReaderWorkspaceState,
} from "../public-types.js";
import { readerCompactAtom, surfaceProfileAtom } from "../compact/state.js";
import {
  defaultWorkspaceState,
  effectiveWorkspacePanels,
  normalizeWorkspaceState,
  type WorkspaceSurface,
} from "./layout.js";

export const workspaceSurfaceAtom = atom<WorkspaceSurface>(null);
export const effectiveWorkspaceSurfaceAtom = atom((get) =>
  get(surfaceProfileAtom) === get(readerCompactAtom) ? get(workspaceSurfaceAtom) : null,
);

export const setWorkspaceSurfaceAtom = atom(null, (get, set, surface: WorkspaceSurface) => {
  set(surfaceProfileAtom, get(readerCompactAtom));
  set(workspaceSurfaceAtom, surface);
});

export const uncontrolledWorkspaceStateAtom =
  atom<NavigatorReaderWorkspaceState>(defaultWorkspaceState);

export const resetWorkspaceSurfaceAtom = atom(null, (_get, set) => {
  set(workspaceSurfaceAtom, null);
});

export const controlledWorkspaceStateAtom = atom<NavigatorReaderWorkspaceState | undefined>(
  undefined,
);
export const workspaceWidthAtom = atom<number | null>(null);

const workspaceStateChange = hostHandlerAtoms<(state: NavigatorReaderWorkspaceState) => void>();
export const publishWorkspaceStateChangeAtom = workspaceStateChange.publish;

function samePanel(
  left: NavigatorReaderWorkspacePanelState,
  right: NavigatorReaderWorkspacePanelState,
): boolean {
  return left.open === right.open && left.pinned === right.pinned && left.width === right.width;
}

export function sameWorkspaceState(
  left: NavigatorReaderWorkspaceState | undefined,
  right: NavigatorReaderWorkspaceState | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    samePanel(left.navigation, right.navigation) && samePanel(left.annotations, right.annotations)
  );
}

export const workspaceStateAtom = atom((get) =>
  normalizeWorkspaceState(get(controlledWorkspaceStateAtom) ?? get(uncontrolledWorkspaceStateAtom)),
);

export const setWorkspaceStateAtom = atom(null, (get, set, next: NavigatorReaderWorkspaceState) => {
  const normalized = normalizeWorkspaceState(next);
  if (get(controlledWorkspaceStateAtom) === undefined) {
    set(uncontrolledWorkspaceStateAtom, normalized);
  }
  get(workspaceStateChange.handler)?.handle(normalized);
});

export const workspaceFitAtom = atom((get) =>
  effectiveWorkspacePanels(get(workspaceStateAtom), get(workspaceWidthAtom)),
);

/** Closes a workspace panel that is only overlaying the reading surface. */
export const closeWorkspaceOverlayAtom = atom(
  null,
  (get, set, side: "navigation" | "annotations") => {
    const fit = get(workspaceFitAtom);
    if (fit[side] !== "overlay") return;
    const state = get(workspaceStateAtom);
    set(setWorkspaceStateAtom, { ...state, [side]: { ...state[side], open: false } });
  },
);
