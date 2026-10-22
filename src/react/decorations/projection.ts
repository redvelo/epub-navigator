import type { DecorationProjection } from "../../generated/kernel.js";
import type { NavigatorAnnotationProjection } from "../../annotations.js";
import type { NavigatorSearchResult, NavigatorSearchSnapshot } from "../../search.js";

const maxDecorationRecords = 500;
const searchDecorationWindow = 100;

export function decorationProjection(
  annotations: NavigatorAnnotationProjection | undefined,
  search: NavigatorSearchSnapshot,
  occurrence: number | null,
  revision: number,
): {
  readonly projection: DecorationProjection;
  readonly searchResults: Map<string, NavigatorSearchResult>;
} {
  let annotationRecords = (annotations?.records ?? []).flatMap((record) =>
    record.type === "bookmark"
      ? []
      : [
          {
            id: record.id,
            targetJson: record.targetJson,
            occurrence: record.occurrence,
            appearance:
              record.type === "highlight"
                ? ("annotation-highlight" as const)
                : ("annotation-note" as const),
          },
        ],
  );
  const session = search.state === "idle" ? null : search.session;
  const occurrenceResults =
    occurrence === null || session === null
      ? []
      : session.results.filter((result) => result.section.occurrence === occurrence);
  const activeIndex = occurrenceResults.findIndex(
    (result) => result.id === session?.selectedResultId,
  );
  const activeRequired = activeIndex >= 0;
  if (activeRequired && annotationRecords.length === maxDecorationRecords) {
    // Preserve live-document annotations when one off-document slot must yield to the active match.
    const removable = annotationRecords.findIndex((record) => record.occurrence !== occurrence);
    annotationRecords = annotationRecords.filter(
      (_, index) => index !== (removable >= 0 ? removable : annotationRecords.length - 1),
    );
  }
  const capacity = Math.min(
    searchDecorationWindow,
    Math.max(0, maxDecorationRecords - annotationRecords.length),
  );
  const start =
    occurrenceResults.length <= capacity
      ? 0
      : activeIndex < 0
        ? 0
        : Math.min(
            occurrenceResults.length - capacity,
            Math.max(0, activeIndex - Math.floor(capacity / 2)),
          );
  const visibleResults = occurrenceResults.slice(start, start + capacity);
  const usedIds = new Set(annotationRecords.map((record) => record.id));
  const searchResults = new Map<string, NavigatorSearchResult>();
  const projectedSearch = visibleResults.map((result, index) => {
    let id = `__epub-navigator-search-${revision}-${start + index}`;
    while (usedIds.has(id)) id += "_";
    usedIds.add(id);
    searchResults.set(id, result);
    return {
      id,
      targetJson: result.targetJson,
      occurrence: result.section.occurrence,
      appearance:
        result.id === session?.selectedResultId
          ? ("active-search-result" as const)
          : ("search-result" as const),
    };
  });
  return {
    projection: { revision, records: [...annotationRecords, ...projectedSearch] },
    searchResults,
  };
}
