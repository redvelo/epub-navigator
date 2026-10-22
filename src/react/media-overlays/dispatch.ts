import { atom } from "jotai";
import { dispatchCommand } from "../lib/dispatch.js";
import { mediaOverlayControllerAtom } from "./state.js";

export const playNarrationAtom = atom(null, (get) => {
  dispatchCommand(get(mediaOverlayControllerAtom)?.play());
});

export const pauseNarrationAtom = atom(null, (get) => {
  get(mediaOverlayControllerAtom)?.pause();
});

export const nextNarrationSegmentAtom = atom(null, (get) => {
  dispatchCommand(get(mediaOverlayControllerAtom)?.nextSegment());
});

export const previousNarrationSegmentAtom = atom(null, (get) => {
  dispatchCommand(get(mediaOverlayControllerAtom)?.previousSegment());
});

export const stopNarrationAtom = atom(null, (get) => {
  get(mediaOverlayControllerAtom)?.stop();
});

export const escapeNarrationAtom = atom(null, (get) => {
  dispatchCommand(get(mediaOverlayControllerAtom)?.escape());
});
