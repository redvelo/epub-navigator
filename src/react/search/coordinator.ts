import { atom, useAtomValue, useStore } from "jotai";
import { atomEffect } from "jotai-effect";
import type { MountedPublication, ReaderSessionId } from "../../publication.js";
import {
  createNavigatorSearchCoordinator,
  type PublicationSearchCapabilities,
} from "../../runtime/search.js";
import { abortOperation } from "../lib/operations.js";
import { usePublishedToStore } from "../lib/publish.js";
import { readerStoreAtom } from "../navigation/navigate-atom.js";
import {
  idleSearchSnapshot,
  searchSnapshotHandlerAtom,
  publishSearchSnapshotHandlerAtom,
  sameSearchCoordinatorInputs,
  searchActivationOperationAtom,
  searchCoordinatorAtom,
  searchCoordinatorInputsAtom,
  searchCoordinatorLeaseAtom,
  searchNavigationModeAtom,
  searchSnapshotAtom,
  type SearchCoordinatorLease,
} from "./state.js";
import type { NavigatorSearchSnapshot } from "../../search.js";
import type { ReadingOrderOccurrence } from "../../generated/kernel.js";

/** Several atoms move together, so one write keeps observers from seeing a half-released lease. */
const releaseSearchCoordinatorAtom = atom(null, (get, set) => {
  get(searchCoordinatorLeaseAtom)?.coordinator.close();
  set(searchCoordinatorLeaseAtom, null);
  set(searchCoordinatorAtom, null);
  set(searchSnapshotAtom, idleSearchSnapshot);
  set(searchNavigationModeAtom, "navigation");
});

const adoptSearchCoordinatorAtom = atom(null, (_get, set, lease: SearchCoordinatorLease) => {
  set(searchCoordinatorLeaseAtom, lease);
  set(searchCoordinatorAtom, lease.coordinator);
});

/**
 * Owns the search coordinator's lease. The coordinator outlives any single mounted component, so
 * the lease belongs to the session's store rather than to a component effect. Inputs are tracked
 * and are the only reason to rebuild; the lease itself is read untracked, because inspecting it
 * must not become a trigger.
 */
const searchCoordinatorEffect = atomEffect((get, set) => {
  const inputs = get(searchCoordinatorInputsAtom);
  const store = get.peek(readerStoreAtom);
  if (inputs === null || store === null) return;
  const { sessionId, facts, capabilities, readingOrder } = inputs;
  if (capabilities === undefined) {
    set(releaseSearchCoordinatorAtom);
    return;
  }
  const existing = get.peek(searchCoordinatorLeaseAtom);
  const reusable =
    existing?.sessionId === sessionId &&
    existing.capabilities === capabilities &&
    existing.facts === facts;
  const coordinator = reusable
    ? existing.coordinator
    : createNavigatorSearchCoordinator({ facts, capabilities, readingOrder });
  if (reusable && existing.readingOrder !== readingOrder) {
    coordinator.setReadingOrder(readingOrder);
  }
  if (existing !== null && existing.coordinator !== coordinator) existing.coordinator.close();
  const token = {};
  set(adoptSearchCoordinatorAtom, {
    sessionId,
    capabilities,
    facts,
    readingOrder,
    coordinator,
    token,
  });
  const unsubscribe = coordinator.subscribe((next) => {
    if (store.get(searchCoordinatorLeaseAtom)?.token !== token) return;
    store.set(searchSnapshotAtom, next);
    store.get(searchSnapshotHandlerAtom)?.handle(next);
    if (next.state === "unavailable" && next.reason === "snapshot-unavailable") {
      store.set(searchNavigationModeAtom, "navigation");
    }
  });
  return () => {
    unsubscribe();
    queueMicrotask(() => {
      if (store.get(searchCoordinatorLeaseAtom)?.token !== token) return;
      abortOperation(store, searchActivationOperationAtom);
      store.set(searchCoordinatorLeaseAtom, null);
      if (store.get(searchCoordinatorAtom) === coordinator) store.set(searchCoordinatorAtom, null);
      coordinator.close();
    });
  };
});

const searchCoordinatorEffects = atom((get) => {
  get(searchCoordinatorEffect);
});

export function useSearchCoordinator(
  onSnapshotChange: ((snapshot: NavigatorSearchSnapshot) => void) | undefined,
  sessionId: ReaderSessionId,
  facts: MountedPublication["facts"],
  capabilities: PublicationSearchCapabilities | undefined,
  readingOrder: readonly ReadingOrderOccurrence[] | undefined,
): void {
  const store = useStore();
  usePublishedToStore(() => {
    store.set(publishSearchSnapshotHandlerAtom, onSnapshotChange);
    const next = { sessionId, facts, capabilities, readingOrder };
    if (!sameSearchCoordinatorInputs(store.get(searchCoordinatorInputsAtom), next)) {
      store.set(searchCoordinatorInputsAtom, next);
    }
  });
  useAtomValue(searchCoordinatorEffects);
}
