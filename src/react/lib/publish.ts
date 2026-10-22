import { atom } from "jotai";
import { useLayoutEffect, useState } from "react";

/**
 * Publishes a render-derived value into the reader store.
 *
 * A write from a commit-phase effect lands after the render that reads the atom, so the first
 * publication runs in a state initializer and later renders update it from a layout effect.
 * Publishers must be idempotent, which is what lets this run on every render without a key.
 */
export function usePublishedToStore(publish: () => void): void {
  useState(publish);
  useLayoutEffect(publish);
}

/**
 * A host callback held in the store, so dispatch can reach it without a component prop.
 *
 * Publishing compares identity, which lets a caller that rebuilds its callback on every render
 * publish unconditionally without churning the atom.
 */
export function hostHandlerAtoms<Handle extends (...args: never[]) => unknown>() {
  const handler = atom<{ readonly handle: Handle } | null>(null);
  const publish = atom(null, (get, set, handle: Handle | undefined) => {
    if (get(handler)?.handle === handle) return;
    set(handler, handle === undefined ? null : { handle });
  });
  return { handler, publish };
}
