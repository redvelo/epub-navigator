import type { PublicationFacts } from "../generated/publication.js";
import {
  MAX_SEARCH_CONTINUATION_BYTES,
  MAX_SEARCH_ID_BYTES,
  MAX_SEARCH_QUERY_BYTES,
  MAX_SEARCH_QUERY_CODE_POINTS,
  MAX_SEARCH_RESOURCE_BYTES,
  MAX_SEARCH_RESULTS_PER_BATCH,
  type NavigatorSearchCoverage,
  type NavigatorSearchExcerpt,
  type NavigatorSearchRequest,
  type NavigatorSearchResult,
  type NavigatorSearchScope,
} from "../search.js";
import type { PublicationSearchCapabilities } from "../runtime/search.js";
import type {
  LocalSearchDocument as LocalSearchDocumentProjection,
  LocalSearchDocumentState,
  LocalSearchEntry,
} from "./publication.js";

interface SearchDocument {
  readonly occurrence: number;
  readonly resource: string;
  readonly source: string;
  readonly entries: readonly LocalSearchEntry[];
}

interface SearchCursor {
  readonly document: number;
  readonly entry: number;
  readonly offset: number;
}

interface ContinuationState {
  readonly key: string;
  readonly cursor: SearchCursor;
}

/** Creates an immutable, publication-scoped search lease over persisted Search entries. */
export function createLocalSearchCapabilities(
  facts: PublicationFacts,
  documentStates: Readonly<Record<string, LocalSearchDocumentState>>,
  documentProjections: readonly LocalSearchDocumentProjection[],
  entries: readonly LocalSearchEntry[],
  controller: AbortController,
  closeLease: () => void,
): PublicationSearchCapabilities {
  const documents = searchDocuments(documentProjections, entries);
  const continuations = new Map<string, ContinuationState>();
  let continuationSequence = 0;
  let closed = false;
  controller.signal.addEventListener(
    "abort",
    () => {
      closed = true;
      continuations.clear();
    },
    { once: true },
  );

  return {
    scopes: ["publication", "occurrence"],
    signal: controller.signal,
    async search(request, context) {
      assertActive(controller.signal, context.signal);
      if (!validRequest(request))
        return { status: "failed", message: "The search request is invalid." };
      const selected = selectedDocuments(documents, request.scope);
      if (selected === null) {
        return { status: "unavailable", reason: "scope-unavailable", message: null };
      }
      const key = requestKey(request);
      let cursor: SearchCursor = { document: 0, entry: 0, offset: 0 };
      if (request.continuation !== null) {
        const continuation = continuations.get(request.continuation);
        continuations.delete(request.continuation);
        if (continuation === undefined || continuation.key !== key) {
          return { status: "failed", message: "The search continuation is invalid." };
        }
        cursor = continuation.cursor;
      } else {
        continuations.clear();
      }

      const results: NavigatorSearchResult[] = [];
      let exhausted = false;
      while (results.length < request.limit) {
        assertActive(controller.signal, context.signal);
        const next = await nextMatch(selected, request.query, cursor, [
          controller.signal,
          context.signal,
        ]);
        if (next === null) {
          exhausted = true;
          break;
        }
        results.push(next.result);
        cursor = next.cursor;
      }
      assertActive(controller.signal, context.signal);
      const hasMore =
        !exhausted &&
        (await nextMatch(selected, request.query, cursor, [controller.signal, context.signal])) !==
          null;
      let continuation: string | null = null;
      if (hasMore) {
        continuationSequence += 1;
        continuation = `${continuationSequence.toString(36)}-${randomToken()}`;
        if (continuations.size >= 64) continuations.delete(continuations.keys().next().value!);
        continuations.set(continuation, { key, cursor });
      }
      return {
        status: "completed",
        batch: {
          requestId: request.requestId,
          results,
          coverage: searchCoverage(facts, documentStates, request.scope, documents),
          continuation,
          totalResultCount: null,
        },
      };
    },
    close() {
      if (closed) return;
      closed = true;
      continuations.clear();
      closeLease();
    },
  };
}

function searchDocuments(
  projections: readonly LocalSearchDocumentProjection[],
  entries: readonly LocalSearchEntry[],
): readonly SearchDocument[] {
  return projections.map((projection) => ({
    occurrence: projection.occurrence,
    resource: projection.resourcePath,
    source: projection.source,
    entries: entries.filter((entry) =>
      entry.readingOrderOccurrenceIndexes.includes(projection.occurrence),
    ),
  }));
}

function selectedDocuments(
  documents: readonly SearchDocument[],
  scope: NavigatorSearchScope,
): readonly SearchDocument[] | null {
  if (scope.type === "publication") return documents;
  const document = documents.find(
    (candidate) =>
      candidate.occurrence === scope.occurrence && candidate.resource === scope.resource,
  );
  return document === undefined ? null : [document];
}

async function nextMatch(
  documents: readonly SearchDocument[],
  query: string,
  initial: SearchCursor,
  signals: readonly AbortSignal[],
): Promise<{ readonly result: NavigatorSearchResult; readonly cursor: SearchCursor } | null> {
  let scanned = 0;
  for (let documentIndex = initial.document; documentIndex < documents.length; documentIndex += 1) {
    const document = documents[documentIndex]!;
    const firstEntry = documentIndex === initial.document ? initial.entry : 0;
    for (let entryIndex = firstEntry; entryIndex < document.entries.length; entryIndex += 1) {
      scanned += 1;
      if (scanned % 256 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        assertActive(...signals);
      }
      const entry = document.entries[entryIndex]!;
      const expression = new RegExp(escapeRegularExpression(query), "giu");
      expression.lastIndex =
        documentIndex === initial.document && entryIndex === initial.entry ? initial.offset : 0;
      const match = expression.exec(entry.text);
      if (match === null) continue;
      const start = match.index;
      const end = expression.lastIndex;
      return {
        result: searchResult(document, entry, entryIndex, start, end),
        cursor: { document: documentIndex, entry: entryIndex, offset: end },
      };
    }
  }
  return null;
}

function searchResult(
  document: SearchDocument,
  entry: LocalSearchEntry,
  entryIndex: number,
  start: number,
  end: number,
): NavigatorSearchResult {
  const excerpt = boundedExcerpt(entry.text, start, end);
  return {
    id: `${document.occurrence}:${entryIndex}:${start}`,
    section: {
      id: `occurrence-${document.occurrence}`,
      occurrence: document.occurrence,
      resource: document.resource,
      label: null,
    },
    targetJson: JSON.stringify(searchTarget(document, entry, excerpt)),
    excerpt,
  };
}

function searchTarget(
  document: SearchDocument,
  entry: LocalSearchEntry,
  excerpt: NavigatorSearchExcerpt,
): object {
  const prefix = Array.from(excerpt.before).slice(-32).join("");
  const suffix = Array.from(excerpt.after).slice(0, 32).join("");
  const value = [
    prefix === "" ? null : `${encodeURIComponent(prefix)}-`,
    encodeURIComponent(excerpt.match),
    suffix === "" ? null : `-${encodeURIComponent(suffix)}`,
  ]
    .filter((part) => part !== null)
    .join(",");
  const exact = {
    type: "FragmentSelector",
    value: `text=${value}`,
    conformsTo: "https://wicg.github.io/scroll-to-text-fragment/",
  };
  const selectors = [exact];
  if (prefix !== "" || suffix !== "") {
    selectors.push({ ...exact, value: `text=${encodeURIComponent(excerpt.match)}` });
  }
  return {
    source: document.source,
    selector: selectors.map((selector) =>
      entry.fragment === null
        ? selector
        : { type: "FragmentSelector", value: entry.fragment, refinedBy: selector },
    ),
  };
}

function boundedExcerpt(text: string, start: number, end: number): NavigatorSearchExcerpt {
  const match = text.slice(start, end);
  let before = Array.from(text.slice(0, start)).slice(-128).join("");
  let after = Array.from(text.slice(end)).slice(0, 128).join("");
  while (
    codePointLength(before + match + after) > 512 ||
    utf8Length(before + match + after) > 2_048
  ) {
    if (before.length >= after.length && before.length > 0)
      before = Array.from(before).slice(1).join("");
    else if (after.length > 0) after = Array.from(after).slice(0, -1).join("");
    else break;
  }
  return { before, match, after };
}

function searchCoverage(
  facts: PublicationFacts,
  documentStates: Readonly<Record<string, LocalSearchDocumentState>>,
  scope: NavigatorSearchScope,
  documents: readonly SearchDocument[],
): NavigatorSearchCoverage {
  const indexes =
    scope.type === "publication"
      ? facts.resources.readingOrder.map((_, index) => index)
      : facts.resources.readingOrder.flatMap((_, index) =>
          index === scope.occurrence ? [index] : [],
        );
  const searchedOccurrences = indexes.filter((index) => {
    const resource = documents.find((document) => document.occurrence === index)?.resource ?? null;
    if (resource === null) return false;
    const state = documentStates[resource];
    return state === "complete" || state === "inapplicable";
  }).length;
  if (searchedOccurrences === indexes.length) {
    return { state: "complete", searchedOccurrences, totalOccurrences: indexes.length };
  }
  return {
    state: "partial",
    searchedOccurrences,
    totalOccurrences: indexes.length,
    reason: "Some reading-order documents were not completely analyzed.",
  };
}

function validRequest(request: NavigatorSearchRequest): boolean {
  return (
    typeof request === "object" &&
    request !== null &&
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    utf8Length(request.requestId) <= MAX_SEARCH_ID_BYTES &&
    typeof request.query === "string" &&
    request.query.length > 0 &&
    codePointLength(request.query) <= MAX_SEARCH_QUERY_CODE_POINTS &&
    utf8Length(request.query) <= MAX_SEARCH_QUERY_BYTES &&
    (request.initiator === "query-entry" || request.initiator === "selection") &&
    (request.continuation === null ||
      (typeof request.continuation === "string" &&
        request.continuation.length > 0 &&
        utf8Length(request.continuation) <= MAX_SEARCH_CONTINUATION_BYTES)) &&
    validScope(request.scope) &&
    Number.isSafeInteger(request.limit) &&
    request.limit >= 1 &&
    request.limit <= MAX_SEARCH_RESULTS_PER_BATCH
  );
}

function validScope(scope: NavigatorSearchScope): boolean {
  if (typeof scope !== "object" || scope === null) return false;
  if (scope.type === "publication") return Object.keys(scope).length === 1;
  return (
    scope.type === "occurrence" &&
    Object.keys(scope).length === 3 &&
    Number.isSafeInteger(scope.occurrence) &&
    scope.occurrence >= 0 &&
    typeof scope.resource === "string" &&
    scope.resource.length > 0 &&
    utf8Length(scope.resource) <= MAX_SEARCH_RESOURCE_BYTES
  );
}

function requestKey(request: NavigatorSearchRequest): string {
  return JSON.stringify(
    request.scope.type === "publication"
      ? [request.requestId, request.initiator, request.query, "publication"]
      : [
          request.requestId,
          request.initiator,
          request.query,
          "occurrence",
          request.scope.occurrence,
          request.scope.resource,
        ],
  );
}

function assertActive(...signals: readonly AbortSignal[]): void {
  if (signals.some((signal) => signal.aborted)) {
    throw new DOMException("search aborted", "AbortError");
  }
}

function randomToken(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
