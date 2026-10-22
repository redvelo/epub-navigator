import { atom, useAtomValue } from "jotai";
import { hostHandlerAtoms } from "../lib/publish.js";
import { useRef, type RefObject } from "react";
import { operationAtom } from "../lib/operations.js";
import type {
  NavigatorSearchResult,
  NavigatorSearchScope,
  NavigatorSearchSnapshot,
} from "../../search.js";
import type {
  NavigatorSearchCoordinator,
  PublicationSearchCapabilities,
} from "../../runtime/search.js";
import type { MountedPublication, ReaderSessionId } from "../../publication.js";
import type { ReadingOrderOccurrence } from "../../generated/kernel.js";

export type SearchActivation =
  | { readonly resultId: string; readonly status: "activating" }
  | { readonly resultId: string; readonly status: "failed"; readonly message: string }
  | null;

export interface SearchCoordinatorLease {
  readonly capabilities: PublicationSearchCapabilities;
  readonly facts: MountedPublication["facts"];
  readonly sessionId: ReaderSessionId;
  readonly readingOrder: readonly ReadingOrderOccurrence[] | undefined;
  readonly coordinator: NavigatorSearchCoordinator;
  readonly token: object;
}

export interface ReaderSearchState {
  readonly input: RefObject<HTMLInputElement | null>;
  readonly snapshot: NavigatorSearchSnapshot;
  readonly scope: NavigatorSearchScope["type"];
  readonly activation: SearchActivation;
  readonly navigationMode: "navigation" | "search";
}

/** One idle value, so republishing idle does not change the atom's identity. */
export const idleSearchSnapshot: NavigatorSearchSnapshot = { state: "idle" };
export const searchSnapshotAtom = atom<NavigatorSearchSnapshot>(idleSearchSnapshot);
export const searchQueryAtom = atom("");
export const searchScopeAtom = atom<NavigatorSearchScope["type"]>("publication");
export const searchActivationAtom = atom<SearchActivation>(null);
export const searchNavigationModeAtom = atom<"navigation" | "search">("navigation");
export const searchCoordinatorAtom = atom<NavigatorSearchCoordinator | null>(null);
export const searchCoordinatorLeaseAtom = atom<SearchCoordinatorLease | null>(null);
export const searchDecorationResultsAtom = atom(new Map<string, NavigatorSearchResult>());
export const searchActivationOperationAtom = operationAtom();

export const resetSearchSessionAtom = atom(null, (get, set) => {
  get(searchActivationOperationAtom)?.abort();
  set(searchActivationOperationAtom, null);
  set(searchSnapshotAtom, idleSearchSnapshot);
  set(searchQueryAtom, "");
  set(searchScopeAtom, "publication");
  set(searchActivationAtom, null);
  set(searchNavigationModeAtom, "navigation");
});

export function useReaderSearchState(): ReaderSearchState {
  const input = useRef<HTMLInputElement>(null);
  const snapshot = useAtomValue(searchSnapshotAtom);
  const scope = useAtomValue(searchScopeAtom);
  const activation = useAtomValue(searchActivationAtom);
  const navigationMode = useAtomValue(searchNavigationModeAtom);
  return {
    input,
    snapshot,
    scope,
    activation,
    navigationMode,
  };
}

export interface SearchCoordinatorInputs {
  readonly sessionId: ReaderSessionId;
  readonly facts: MountedPublication["facts"];
  readonly capabilities: PublicationSearchCapabilities | undefined;
  readonly readingOrder: readonly ReadingOrderOccurrence[] | undefined;
}

/** The coordinator's inputs, published as one value so the store effect has a single trigger. */
export const searchCoordinatorInputsAtom = atom<SearchCoordinatorInputs | null>(null);

export function sameSearchCoordinatorInputs(
  left: SearchCoordinatorInputs | null,
  right: SearchCoordinatorInputs,
): boolean {
  return (
    left !== null &&
    left.sessionId === right.sessionId &&
    left.facts === right.facts &&
    left.capabilities === right.capabilities &&
    left.readingOrder === right.readingOrder
  );
}

export const { handler: searchSnapshotHandlerAtom, publish: publishSearchSnapshotHandlerAtom } =
  hostHandlerAtoms<(snapshot: NavigatorSearchSnapshot) => void>();
