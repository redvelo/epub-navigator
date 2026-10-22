import { atom } from "jotai";
import type { CompactSurface } from "./surfaces.js";

export const compactSurfaceAtom = atom<CompactSurface>(null);
export const compactPanelAtom = atom<"navigation" | "annotations">("navigation");
/** Layout profile that the open reader surfaces belong to; they do not survive a profile change. */
export const surfaceProfileAtom = atom<boolean | null>(null);
/** Layout profile the reader is currently rendering in. */
export const readerCompactAtom = atom(false);

/** The open compact surface, or null when it belongs to the other layout profile. */
export const effectiveCompactSurfaceAtom = atom((get) =>
  get(surfaceProfileAtom) === get(readerCompactAtom) ? get(compactSurfaceAtom) : null,
);

/** The surfaces a reader opened on the way here, innermost last. */
export const compactSurfaceOriginsAtom = atom<readonly CompactSurface[]>([]);

/** The surface to return to, or null when the one open was reached from the publication. */
export const compactSurfaceOriginAtom = atom((get) =>
  get(effectiveCompactSurfaceAtom) === null
    ? null
    : (get(compactSurfaceOriginsAtom).at(-1) ?? null),
);

export const setCompactSurfaceAtom = atom(null, (get, set, surface: CompactSurface) => {
  const current = get(compactSurfaceAtom);
  set(surfaceProfileAtom, get(readerCompactAtom));
  if (surface === null) set(compactSurfaceOriginsAtom, []);
  else if (current !== null && current !== surface)
    set(compactSurfaceOriginsAtom, [...get(compactSurfaceOriginsAtom), current]);
  set(compactSurfaceAtom, surface);
});

/** Returns to the surface this one was opened from, or dismisses it when there is none. */
export const dismissCompactSurfaceAtom = atom(null, (get, set): boolean => {
  if (get(effectiveCompactSurfaceAtom) === null) return false;
  const origins = get(compactSurfaceOriginsAtom);
  const origin = origins.at(-1) ?? null;
  set(compactSurfaceOriginsAtom, origins.slice(0, -1));
  set(compactSurfaceAtom, origin);
  if (origin === null) set(surfaceProfileAtom, null);
  return true;
});

export const resetCompactSurfaceAtom = atom(null, (_get, set) => {
  set(compactSurfaceAtom, null);
  set(compactSurfaceOriginsAtom, []);
  set(compactPanelAtom, "navigation");
  set(surfaceProfileAtom, null);
});

/** Opens the compact surface on the annotations panel. */
export const openCompactAnnotationsAtom = atom(null, (_get, set) => {
  set(compactPanelAtom, "annotations");
  set(setCompactSurfaceAtom, "navigation");
});
