import type { ContentAgentState } from "../state.js";

/**
 * How long a page turn that arrived during a layout stays worth performing. Measured on the
 * ONYX BOOX Go6 (2026-10-13, 572 CSS px wide): a text-size change re-lays out a two-page
 * document in about 0.35 s, an eleven-page chapter in about 0.6 s and a twenty-five-page
 * chapter in about 1.0 s, while a colour change takes a third of that. Two seconds keeps the
 * turn for chapters longer than those; past it the reader has moved on and a turn would arrive
 * as if from nowhere.
 */
export const DEFERRED_INTERACTION_LIFETIME_MS = 2_000;

export interface DeferredLayoutInteraction {
  readonly replay: () => void;
  readonly deferredAt: number;
}

/** Parks an interaction that the current layout transaction stands in the way of. */
export function deferLayoutInteraction(state: ContentAgentState, replay: () => void): void {
  state.layout.deferredLayoutInteraction = { replay, deferredAt: performance.now() };
}

/** Performs the parked interaction once a layout has settled, unless it has gone stale. */
export function replayDeferredLayoutInteraction(state: ContentAgentState): void {
  const deferred = state.layout.deferredLayoutInteraction;
  state.layout.deferredLayoutInteraction = null;
  if (deferred === null) return;
  if (performance.now() - deferred.deferredAt > DEFERRED_INTERACTION_LIFETIME_MS) return;
  deferred.replay();
}
