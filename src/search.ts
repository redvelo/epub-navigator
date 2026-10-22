/** Maximum submitted query size accepted by Navigator. */
export const MAX_SEARCH_QUERY_CODE_POINTS = 512;
export const MAX_SEARCH_QUERY_BYTES = 2_048;
export const MAX_SEARCH_CONTINUATION_BYTES = 16_384;
export const MAX_SEARCH_ID_BYTES = 1_024;
export const MAX_SEARCH_RESOURCE_BYTES = 16_384;
export const MAX_SEARCH_SECTION_LABEL_BYTES = 2_048;
export const MAX_SEARCH_EXCERPT_CODE_POINTS = 512;
export const MAX_SEARCH_EXCERPT_BYTES = 2_048;
export const MAX_SEARCH_TARGET_JSON_BYTES = 1_048_576;
export const MAX_SEARCH_RESULTS_PER_BATCH = 100;
export const MAX_SEARCH_BATCH_BYTES = 4 * 1_048_576;
export const MAX_SEARCH_MESSAGE_BYTES = 16_384;

export type NavigatorSearchScope =
  | { readonly type: "publication" }
  | {
      /** Reading-order occurrence captured when the request is submitted. */
      readonly type: "occurrence";
      readonly occurrence: number;
      readonly resource: string;
    };

export interface NavigatorSearchRequest {
  readonly requestId: string;
  readonly query: string;
  readonly scope: NavigatorSearchScope;
  readonly initiator: "query-entry" | "selection";
  readonly continuation: string | null;
  readonly limit: number;
}

/** Stable provider-owned identity for one result group within a request. */
export interface NavigatorSearchSection {
  readonly id: string;
  readonly occurrence: number;
  readonly resource: string;
  readonly label: string | null;
}

/** Plain-text context. These strings are never interpreted as markup. */
export interface NavigatorSearchExcerpt {
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

export interface NavigatorSearchResult {
  /** Opaque provider-owned identity unique within the request. */
  readonly id: string;
  readonly section: NavigatorSearchSection;
  /** JSON serialization of a host-scoped EPUB Annotation target. */
  readonly targetJson: string;
  readonly excerpt: NavigatorSearchExcerpt;
}

export type NavigatorSearchCoverage =
  | {
      readonly state: "complete";
      readonly searchedOccurrences: number;
      readonly totalOccurrences: number;
    }
  | {
      readonly state: "partial";
      readonly searchedOccurrences: number;
      readonly totalOccurrences: number;
      readonly reason: string | null;
    };

export interface NavigatorSearchBatch {
  readonly requestId: string;
  readonly results: readonly NavigatorSearchResult[];
  readonly coverage: NavigatorSearchCoverage;
  /** Opaque token for the next result batch within this exact request. */
  readonly continuation: string | null;
  /** Authoritative total for the searched coverage, when known. */
  readonly totalResultCount: number | null;
}

export type NavigatorSearchProviderOutcome =
  | { readonly status: "completed"; readonly batch: NavigatorSearchBatch }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "index-unavailable"
        | "scope-unavailable"
        | "policy"
        | "snapshot-unavailable";
      readonly message: string | null;
    }
  | { readonly status: "failed"; readonly message: string | null };

export interface NavigatorSearchSession {
  readonly requestId: string;
  readonly query: string;
  readonly scope: NavigatorSearchScope;
  readonly initiator: NavigatorSearchRequest["initiator"];
  readonly results: readonly NavigatorSearchResult[];
  readonly coverage: NavigatorSearchCoverage | null;
  readonly continuation: string | null;
  readonly totalResultCount: number | null;
  readonly selectedResultId: string | null;
}

export type NavigatorSearchSnapshot =
  | { readonly state: "idle" }
  | {
      readonly state: "querying";
      readonly phase: "initial" | "continuation";
      readonly session: NavigatorSearchSession;
    }
  | { readonly state: "ready"; readonly session: NavigatorSearchSession }
  | {
      readonly state: "unavailable";
      readonly reason: Exclude<
        NavigatorSearchProviderOutcome,
        { status: "completed" | "failed" }
      >["reason"];
      readonly message: string | null;
      readonly session: NavigatorSearchSession | null;
    }
  | {
      readonly state: "failed";
      readonly message: string | null;
      readonly session: NavigatorSearchSession;
    };
