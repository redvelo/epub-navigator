import { atom, type PrimitiveAtom } from "jotai";
import type { ReaderStore } from "./store.js";

/** Slot holding at most one in-flight abortable operation. */
export type OperationAtom = PrimitiveAtom<AbortController | null>;

export function operationAtom(): OperationAtom {
  return atom<AbortController | null>(null);
}

/** Aborts any operation still in flight and installs a fresh controller for the new one. */
export function beginOperation(store: ReaderStore, slot: OperationAtom): AbortController {
  store.get(slot)?.abort();
  const controller = new AbortController();
  store.set(slot, controller);
  return controller;
}

/** Clears the slot when `controller` still holds it, leaving a superseding operation alone. */
export function releaseOperation(
  store: ReaderStore,
  slot: OperationAtom,
  controller: AbortController,
): void {
  if (store.get(slot) === controller) store.set(slot, null);
}

/** Aborts and clears any operation in flight, reporting whether one was running. */
export function abortOperation(store: ReaderStore, slot: OperationAtom): boolean {
  const running = store.get(slot);
  if (running === null) return false;
  running.abort();
  store.set(slot, null);
  return true;
}
