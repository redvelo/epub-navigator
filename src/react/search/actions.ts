import { useSetAtom, useStore } from "jotai";
import type {
  NavigatorSearchRequest,
  NavigatorSearchResult,
  NavigatorSearchScope,
} from "../../search.js";
import { abortOperation } from "../lib/operations.js";
import { activateSearchResultAtom, changeSearchScopeAtom, runSearchAtom } from "./dispatch.js";
import {
  searchActivationAtom,
  searchActivationOperationAtom,
  searchCoordinatorAtom,
  searchNavigationModeAtom,
  searchQueryAtom,
  type ReaderSearchState,
} from "./state.js";

interface SearchActionsOptions {
  readonly state: ReaderSearchState;
  readonly searchAvailable: boolean;
  readonly selectionQuery: string | null;
  readonly onOpen: () => void;
  readonly onDismissSelection: () => void;
}

export interface SearchActions {
  readonly focusInput: () => void;
  readonly open: () => void;
  readonly close: () => void;
  readonly run: (
    initiator?: NavigatorSearchRequest["initiator"],
    scope?: NavigatorSearchScope["type"],
    query?: string,
  ) => Promise<void>;
  readonly searchSelection: (event: MouseEvent) => void;
  readonly changeScope: (scope: NavigatorSearchScope["type"]) => void;
  readonly activateResult: (result: NavigatorSearchResult) => Promise<void>;
}

export function useSearchActions({
  state,
  searchAvailable,
  selectionQuery,
  onOpen,
  onDismissSelection,
}: SearchActionsOptions): SearchActions {
  const store = useStore();
  const setActivation = useSetAtom(searchActivationAtom);
  const setNavigationMode = useSetAtom(searchNavigationModeAtom);
  const setQuery = useSetAtom(searchQueryAtom);
  const focusInput = () => {
    requestAnimationFrame(() => {
      state.input.current?.focus();
      state.input.current?.select();
    });
  };

  const open = () => {
    if (!searchAvailable) return;
    setNavigationMode("search");
    onOpen();
    focusInput();
  };

  const close = () => {
    abortOperation(store, searchActivationOperationAtom);
    store.get(searchCoordinatorAtom)?.cancel();
    setActivation(null);
    setQuery("");
    setNavigationMode("navigation");
  };

  const run = async (
    initiator: NavigatorSearchRequest["initiator"] = "query-entry",
    requestedScope?: NavigatorSearchScope["type"],
    requestedQuery?: string,
  ) => {
    const scope = requestedScope ?? state.scope;
    const query = requestedQuery ?? store.get(searchQueryAtom);
    await store.set(runSearchAtom, { initiator, scope, query });
  };

  const searchSelection = (event: MouseEvent) => {
    if (!event.isTrusted || selectionQuery === null || !searchAvailable) return;
    setQuery(selectionQuery);
    onDismissSelection();
    open();
    void run("selection", state.scope, selectionQuery);
  };

  const changeScope = (scope: NavigatorSearchScope["type"]) => {
    store.set(changeSearchScopeAtom, scope);
  };

  const activateResult = async (result: NavigatorSearchResult): Promise<void> => {
    await store.set(activateSearchResultAtom, result);
  };

  return { focusInput, open, close, run, searchSelection, changeScope, activateResult };
}
