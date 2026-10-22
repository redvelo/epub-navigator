import { useAtomValue, useSetAtom } from "jotai";
import { SearchPanel } from "./panel.js";
import { searchActivationAtom, searchScopeAtom, searchSnapshotAtom } from "./state.js";
import {
  activateSearchResultAtom,
  changeSearchScopeAtom,
  continueSearchAtom,
  runSearchAtom,
} from "./dispatch.js";
import { authoredNavigationAtom } from "../navigation/state.js";
import { readerRootElementAtom } from "../runtime/projection-state.js";
import type { RefObject } from "react";

/** Renders the search surface from store state; only value-typed props cross the boundary. */
export function ReaderSearchPanel({
  inputRef,
  readingOrderLength,
  publicationScopeAvailable,
  occurrenceScopeAvailable,
  occurrenceLabel,
  queryInHeader = false,
  paginated = false,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly readingOrderLength: number;
  readonly publicationScopeAvailable: boolean;
  readonly occurrenceScopeAvailable: boolean;
  readonly occurrenceLabel: string | null;
  readonly queryInHeader?: boolean;
  readonly paginated?: boolean;
}) {
  const snapshot = useAtomValue(searchSnapshotAtom);
  const scope = useAtomValue(searchScopeAtom);
  const activation = useAtomValue(searchActivationAtom);
  const authoredNavigation = useAtomValue(authoredNavigationAtom);
  const portalContainer = useAtomValue(readerRootElementAtom);
  const changeScope = useSetAtom(changeSearchScopeAtom);
  const run = useSetAtom(runSearchAtom);
  const loadMore = useSetAtom(continueSearchAtom);
  const activate = useSetAtom(activateSearchResultAtom);
  if (authoredNavigation === null) return null;
  return (
    <SearchPanel
      snapshot={snapshot}
      authoredNavigation={authoredNavigation}
      readingOrderLength={readingOrderLength}
      scope={scope}
      publicationScopeAvailable={publicationScopeAvailable}
      occurrenceScopeAvailable={occurrenceScopeAvailable}
      occurrenceLabel={occurrenceLabel}
      inputRef={inputRef}
      portalContainer={portalContainer}
      queryInHeader={queryInHeader}
      paginated={paginated}
      activation={activation}
      onScopeChange={changeScope}
      onSubmit={() => void run()}
      onContinue={loadMore}
      onActivate={(result) => void activate(result)}
    />
  );
}
