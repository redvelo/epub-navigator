import { atom, useAtomValue, useStore } from "jotai";
import { atomEffect } from "jotai-effect";
import type { NavigatorDictionarySnapshot } from "../../dictionary.js";
import type { ReaderSessionId } from "../../publication.js";
import {
  createNavigatorDictionaryCoordinator,
  type PublicationDictionaryCapabilities,
} from "../../runtime/dictionary.js";
import { usePublishedToStore } from "../lib/publish.js";
import { readerStoreAtom } from "../navigation/navigate-atom.js";
import {
  dictionaryCoordinatorAtom,
  dictionaryCoordinatorInputsAtom,
  dictionaryCoordinatorLeaseAtom,
  dictionarySnapshotAtom,
  idleDictionarySnapshot,
  dictionarySnapshotHandlerAtom,
  publishDictionarySnapshotHandlerAtom,
  sameDictionaryCoordinatorInputs,
  type DictionaryCoordinatorLease,
} from "./state.js";

/** Several atoms move together, so one write keeps observers from seeing a half-released lease. */
const releaseDictionaryCoordinatorAtom = atom(null, (get, set) => {
  get(dictionaryCoordinatorLeaseAtom)?.coordinator.close();
  set(dictionaryCoordinatorLeaseAtom, null);
  set(dictionaryCoordinatorAtom, null);
  set(dictionarySnapshotAtom, idleDictionarySnapshot);
});

const adoptDictionaryCoordinatorAtom = atom(
  null,
  (_get, set, lease: DictionaryCoordinatorLease) => {
    set(dictionaryCoordinatorLeaseAtom, lease);
    set(dictionaryCoordinatorAtom, lease.coordinator);
  },
);

/**
 * Owns the dictionary coordinator's lease. The coordinator outlives any single mounted component,
 * so the lease belongs to the session's store rather than to a component effect. Inputs are
 * tracked and are the only reason to rebuild; the lease is read untracked, because inspecting it
 * must not become a trigger.
 */
const dictionaryCoordinatorEffect = atomEffect((get, set) => {
  const inputs = get(dictionaryCoordinatorInputsAtom);
  const store = get.peek(readerStoreAtom);
  if (inputs === null || store === null) return;
  const { sessionId, capabilities } = inputs;
  if (capabilities === undefined) {
    set(releaseDictionaryCoordinatorAtom);
    return;
  }
  const existing = get.peek(dictionaryCoordinatorLeaseAtom);
  const reusable = existing?.sessionId === sessionId && existing.capabilities === capabilities;
  const coordinator = reusable
    ? existing.coordinator
    : createNavigatorDictionaryCoordinator({ capabilities });
  if (existing !== null && existing.coordinator !== coordinator) existing.coordinator.close();
  const token = {};
  set(adoptDictionaryCoordinatorAtom, { sessionId, capabilities, coordinator, token });
  const unsubscribe = coordinator.subscribe((next) => {
    if (store.get(dictionaryCoordinatorLeaseAtom)?.token !== token) return;
    store.set(dictionarySnapshotAtom, next);
    store.get(dictionarySnapshotHandlerAtom)?.handle(next);
  });
  return () => {
    unsubscribe();
    queueMicrotask(() => {
      if (store.get(dictionaryCoordinatorLeaseAtom)?.token !== token) return;
      store.set(dictionaryCoordinatorLeaseAtom, null);
      if (store.get(dictionaryCoordinatorAtom) === coordinator) {
        store.set(dictionaryCoordinatorAtom, null);
      }
      coordinator.close();
    });
  };
});

const dictionaryCoordinatorEffects = atom((get) => {
  get(dictionaryCoordinatorEffect);
});

export function useDictionaryCoordinator(
  sessionId: ReaderSessionId,
  capabilities: PublicationDictionaryCapabilities | undefined,
  onSnapshotChange: ((snapshot: NavigatorDictionarySnapshot) => void) | undefined,
): NavigatorDictionarySnapshot {
  const store = useStore();
  usePublishedToStore(() => {
    store.set(publishDictionarySnapshotHandlerAtom, onSnapshotChange);
    const next = { sessionId, capabilities };
    if (!sameDictionaryCoordinatorInputs(store.get(dictionaryCoordinatorInputsAtom), next)) {
      store.set(dictionaryCoordinatorInputsAtom, next);
    }
  });
  useAtomValue(dictionaryCoordinatorEffects);
  return useAtomValue(dictionarySnapshotAtom);
}
