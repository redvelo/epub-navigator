import { atom } from "jotai";
import type { NavigatorLocation } from "../../generated/kernel.js";
import type { NavigatorInteraction, NavigatorRuntime } from "../../runtime/navigator/api.js";
import type { ReaderStore } from "../lib/store.js";
import type { AuthoredNavigationProjection } from "./model.js";

/** A navigation the reader has committed to but the kernel has not yet produced a frame for. */
export interface NavigationIntent {
  readonly runtime: NavigatorRuntime;
  readonly occurrence: number;
  readonly locator: NavigatorLocation | null;
  readonly annotationTargetJson: string | null;
  readonly annotationRecordId: string | null;
  readonly annotationActivationToken: number | null;
  readonly focusAfterCompletion: boolean;
  readonly generation: number | null;
  readonly focusCancelled: boolean;
}

export const navigationIntentAtom = atom<NavigationIntent | null>(null);

/** Authored-navigation list the reader is showing, shared by the workspace and compact panels. */
export const authoredNavigationViewAtom = atom<"contents" | "pages" | "landmarks">("contents");
/** Expanded table-of-contents nodes, shared so a profile change keeps the reader's place. */
export const authoredNavigationExpandedAtom = atom<ReadonlySet<string>>(new Set<string>());

/** Serializes presentation advances so a queued turn cannot overtake the one before it. */
export const presentationAdvanceAtom = atom<Promise<void>>(Promise.resolve());

/** Latest reader interaction handler, published for the runtime subscription to call. */
export const readerInteractionHandlerAtom = atom<{
  readonly handle: (interaction: NavigatorInteraction) => void;
}>({ handle: () => {} });

export const resetAuthoredNavigationAtom = atom(null, (_get, set) => {
  set(authoredNavigationViewAtom, "contents");
  set(authoredNavigationExpandedAtom, new Set<string>());
});

/** Clears the intent only while `intent` still holds it, leaving a superseding navigation alone. */
export function releaseNavigationIntent(store: ReaderStore, intent: NavigationIntent): void {
  if (store.get(navigationIntentAtom) === intent) store.set(navigationIntentAtom, null);
}

/** The authored navigation projection is computed once per session and never changes after. */
export const authoredNavigationAtom = atom<AuthoredNavigationProjection | null>(null);
