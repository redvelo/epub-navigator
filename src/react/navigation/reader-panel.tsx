import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { ReaderNavigationContent } from "./content.js";
import { authoredNavigationAtom } from "./state.js";
import { navigateToTocPointAtom } from "./navigate-atom.js";
import { currentFrame } from "../../runtime/kernel-view.js";
import { runtimeViewAtom } from "../runtime/projection-state.js";
import { paginationSnapshotAtom } from "../progress/state.js";
import { searchNavigationModeAtom } from "../search/state.js";
import { ReaderSearchPanel } from "../search/reader-panel.js";
import { useSetAtom } from "jotai";
import type { RefObject } from "react";
import type { PhysicalFrame } from "../../generated/kernel.js";

function sameFrame(left: PhysicalFrame | null, right: PhysicalFrame | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.occurrence === right.occurrence &&
    left.generation === right.generation &&
    left.adapter === right.adapter
  );
}

/** The committed frame is republished with every snapshot; compare it once here. */
const committedFrameAtom = selectAtom(
  runtimeViewAtom,
  (view) => (view === null ? null : currentFrame(view.snapshot)),
  sameFrame,
);

/**
 * The pagination snapshot is republished on every kernel tick. Its page-prefix index is updated
 * in lockstep with the occurrence entries it publishes, so an unchanged entry list means nothing
 * this surface reads has moved; any real change produces a new frozen entry.
 */
const navigationPaginationAtom = selectAtom(
  paginationSnapshotAtom,
  (snapshot) => snapshot,
  (left, right) =>
    left === right ||
    (left !== null &&
      right !== null &&
      left.freshness === right.freshness &&
      left.state === right.state &&
      left.pageCountCoverage.state === right.pageCountCoverage.state &&
      left.occurrences.length === right.occurrences.length &&
      left.occurrences.every((entry, index) => entry === right.occurrences[index])),
);

/** Renders navigation from store state so unrelated reader renders cannot reach it. */
export function ReaderNavigationPanel({
  variant,
  searchInput,
  readingOrderLength,
  publicationScopeAvailable,
  occurrenceScopeAvailable,
  occurrenceLabel,
}: {
  readonly variant: "workspace" | "compact";
  readonly searchInput: RefObject<HTMLInputElement | null>;
  readonly readingOrderLength: number;
  readonly publicationScopeAvailable: boolean;
  readonly occurrenceScopeAvailable: boolean;
  readonly occurrenceLabel: string | null;
}) {
  const mode = useAtomValue(searchNavigationModeAtom);
  const projection = useAtomValue(authoredNavigationAtom);
  const current = useAtomValue(committedFrameAtom);
  const pagination = useAtomValue(navigationPaginationAtom);
  const navigate = useSetAtom(navigateToTocPointAtom);
  if (projection === null) return null;
  return (
    <ReaderNavigationContent
      variant={variant}
      mode={mode}
      projection={projection}
      current={current}
      pagination={pagination}
      onNavigate={navigate}
      search={
        <ReaderSearchPanel
          inputRef={searchInput}
          readingOrderLength={readingOrderLength}
          publicationScopeAvailable={publicationScopeAvailable}
          occurrenceScopeAvailable={occurrenceScopeAvailable}
          occurrenceLabel={occurrenceLabel}
          paginated
          queryInHeader={variant === "compact"}
        />
      }
    />
  );
}
