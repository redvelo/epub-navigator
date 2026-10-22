import type { PublicationFacts } from "../generated/publication.js";
import type { ReadingOrderOccurrence } from "../generated/kernel.js";
import {
  MAX_SEARCH_BATCH_BYTES,
  MAX_SEARCH_CONTINUATION_BYTES,
  MAX_SEARCH_EXCERPT_BYTES,
  MAX_SEARCH_EXCERPT_CODE_POINTS,
  MAX_SEARCH_ID_BYTES,
  MAX_SEARCH_MESSAGE_BYTES,
  MAX_SEARCH_QUERY_BYTES,
  MAX_SEARCH_QUERY_CODE_POINTS,
  MAX_SEARCH_RESOURCE_BYTES,
  MAX_SEARCH_RESULTS_PER_BATCH,
  MAX_SEARCH_SECTION_LABEL_BYTES,
  MAX_SEARCH_TARGET_JSON_BYTES,
  type NavigatorSearchBatch,
  type NavigatorSearchCoverage,
  type NavigatorSearchProviderOutcome,
  type NavigatorSearchRequest,
  type NavigatorSearchResult,
  type NavigatorSearchScope,
  type NavigatorSearchSession,
  type NavigatorSearchSnapshot,
} from "../search.js";

export interface PublicationSearchCapabilities {
  readonly scopes: readonly NavigatorSearchScope["type"][];
  readonly signal: AbortSignal;
  search(
    request: NavigatorSearchRequest,
    context: { readonly signal: AbortSignal },
  ): Promise<NavigatorSearchProviderOutcome>;
  /** Releases the publication-scoped provider. Must be safe to call more than once. */
  close(): void;
}

export interface NavigatorSearchCoordinator {
  snapshot(): NavigatorSearchSnapshot;
  subscribe(listener: (snapshot: NavigatorSearchSnapshot) => void): () => void;
  setReadingOrder(readingOrder: readonly ReadingOrderOccurrence[] | undefined): void;
  submit(
    query: string,
    scope: NavigatorSearchScope,
    initiator?: NavigatorSearchRequest["initiator"],
  ): Promise<NavigatorSearchSnapshot>;
  continue(): Promise<NavigatorSearchSnapshot>;
  select(resultId: string | null): NavigatorSearchSnapshot;
  cancel(): void;
  close(): void;
}

export interface CreateNavigatorSearchCoordinatorOptions {
  readonly facts: PublicationFacts;
  readonly capabilities: PublicationSearchCapabilities;
  readonly readingOrder?: readonly ReadingOrderOccurrence[] | undefined;
  readonly createRequestId?: (() => string) | undefined;
  readonly batchSize?: number | undefined;
}

export class NavigatorSearchContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavigatorSearchContractError";
  }
}

type ReadingOrderIdentity = readonly (string | null)[];

let requestSequence = 0;

export function createNavigatorSearchCoordinator(
  options: CreateNavigatorSearchCoordinatorOptions,
): NavigatorSearchCoordinator {
  return new SearchCoordinator(options);
}

class SearchCoordinator implements NavigatorSearchCoordinator {
  readonly #facts: PublicationFacts;
  #readingOrder: readonly ReadingOrderOccurrence[] | undefined;
  readonly #capabilities: PublicationSearchCapabilities;
  readonly #createRequestId: () => string;
  readonly #batchSize: number;
  readonly #listeners = new Set<(snapshot: NavigatorSearchSnapshot) => void>();
  readonly #onCapabilityAbort = () => {
    this.#active?.abort("capability-aborted");
    this.#active = null;
    this.#publish({
      state: "unavailable",
      reason: "snapshot-unavailable",
      message: null,
      session: sessionOf(this.#snapshot),
    });
  };
  #snapshot: NavigatorSearchSnapshot = { state: "idle" };
  #active: AbortController | null = null;
  #seenContinuations = new Map<string, Set<string>>();
  #requestReadingOrders = new Map<string, ReadingOrderIdentity | undefined>();
  #closed = false;

  constructor(options: CreateNavigatorSearchCoordinatorOptions) {
    this.#facts = options.facts;
    this.#readingOrder = options.readingOrder;
    this.#capabilities = options.capabilities;
    this.#createRequestId = options.createRequestId ?? defaultRequestId;
    this.#batchSize = options.batchSize ?? MAX_SEARCH_RESULTS_PER_BATCH;
    if (
      !safeInteger(this.#batchSize) ||
      this.#batchSize < 1 ||
      this.#batchSize > MAX_SEARCH_RESULTS_PER_BATCH
    ) {
      throw new RangeError("the search batch size is invalid");
    }
    const scopes = new Set(this.#capabilities.scopes);
    if (
      scopes.size === 0 ||
      scopes.size !== this.#capabilities.scopes.length ||
      [...scopes].some((scope) => scope !== "publication" && scope !== "occurrence")
    ) {
      throw new NavigatorSearchContractError("the search capability scopes are invalid");
    }
    if (this.#capabilities.signal.aborted) this.#onCapabilityAbort();
    else
      this.#capabilities.signal.addEventListener("abort", this.#onCapabilityAbort, { once: true });
  }

  snapshot(): NavigatorSearchSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: NavigatorSearchSnapshot) => void): () => void {
    this.#ensureOpen();
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  setReadingOrder(readingOrder: readonly ReadingOrderOccurrence[] | undefined): void {
    this.#ensureOpen();
    this.#readingOrder = readingOrder;
  }

  async submit(
    query: string,
    scope: NavigatorSearchScope,
    initiator: NavigatorSearchRequest["initiator"] = "query-entry",
  ): Promise<NavigatorSearchSnapshot> {
    this.#ensureOpen();
    const normalizedQuery = query.trim();
    validateQuery(normalizedQuery);
    const readingOrder = readingOrderIdentity(this.#readingOrder);
    validateScope(this.#facts, readingOrder, this.#capabilities, scope);
    if (initiator !== "query-entry" && initiator !== "selection") {
      throw new TypeError("the search initiator is invalid");
    }
    const requestId = this.#createRequestId();
    validateBoundedNonemptyString(requestId, MAX_SEARCH_ID_BYTES, "request ID");
    this.#active?.abort("superseded");
    const session: NavigatorSearchSession = {
      requestId,
      query: normalizedQuery,
      scope,
      initiator,
      results: [],
      coverage: null,
      continuation: null,
      totalResultCount: null,
      selectedResultId: null,
    };
    this.#seenContinuations.clear();
    this.#seenContinuations.set(requestId, new Set());
    this.#requestReadingOrders.clear();
    this.#requestReadingOrders.set(requestId, readingOrder);
    return this.#request(session, null, "initial");
  }

  async continue(): Promise<NavigatorSearchSnapshot> {
    this.#ensureOpen();
    const session = sessionOf(this.#snapshot);
    if (session === null || session.continuation === null || this.#snapshot.state === "querying") {
      return this.#snapshot;
    }
    return this.#request(session, session.continuation, "continuation");
  }

  select(resultId: string | null): NavigatorSearchSnapshot {
    this.#ensureOpen();
    const session = sessionOf(this.#snapshot);
    if (session === null) return this.#snapshot;
    if (resultId !== null && !session.results.some((result) => result.id === resultId)) {
      throw new RangeError("the selected search result is not loaded");
    }
    const next = { ...session, selectedResultId: resultId };
    if (this.#snapshot.state === "querying") {
      this.#publish({ ...this.#snapshot, session: next });
    } else if (this.#snapshot.state === "ready") {
      this.#publish({ state: "ready", session: next });
    } else if (this.#snapshot.state === "failed") {
      this.#publish({ ...this.#snapshot, session: next });
    } else if (this.#snapshot.state === "unavailable") {
      this.#publish({ ...this.#snapshot, session: next });
    }
    return this.#snapshot;
  }

  cancel(): void {
    if (this.#closed) return;
    this.#active?.abort("cancelled");
    this.#active = null;
    this.#seenContinuations.clear();
    this.#requestReadingOrders.clear();
    this.#publish({ state: "idle" });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#active?.abort("close");
    this.#active = null;
    this.#seenContinuations.clear();
    this.#requestReadingOrders.clear();
    this.#capabilities.signal.removeEventListener("abort", this.#onCapabilityAbort);
    this.#listeners.clear();
    try {
      this.#capabilities.close();
    } catch {
      // Closing an already unusable host capability cannot change reader teardown.
    }
  }

  async #request(
    session: NavigatorSearchSession,
    continuation: string | null,
    phase: "initial" | "continuation",
  ): Promise<NavigatorSearchSnapshot> {
    validateContinuation(continuation);
    this.#active?.abort("superseded");
    const controller = new AbortController();
    this.#active = controller;
    const request: NavigatorSearchRequest = {
      requestId: session.requestId,
      query: session.query,
      scope: session.scope,
      initiator: session.initiator,
      continuation,
      limit: this.#batchSize,
    };
    this.#publish({ state: "querying", phase, session });
    try {
      const outcome = await this.#capabilities.search(request, { signal: controller.signal });
      if (this.#closed || controller.signal.aborted || this.#active !== controller)
        return this.#snapshot;
      if (outcome.status === "completed") {
        const seenContinuations = this.#seenContinuations.get(request.requestId);
        if (seenContinuations === undefined) return this.#snapshot;
        if (
          outcome.batch.continuation !== null &&
          seenContinuations.has(outcome.batch.continuation)
        ) {
          throw new NavigatorSearchContractError("the search continuation repeated");
        }
        const currentSession = this.#currentSession(request.requestId, session);
        const next = validatedSession(
          this.#facts,
          this.#requestReadingOrders.get(request.requestId),
          request,
          currentSession,
          outcome.batch,
        );
        if (outcome.batch.continuation !== null) {
          seenContinuations.add(outcome.batch.continuation);
        }
        this.#active = null;
        this.#publish({ state: "ready", session: next });
      } else if (outcome.status === "unavailable") {
        validateUnavailableReason(outcome.reason);
        validateMessage(outcome.message);
        this.#active = null;
        this.#publish({
          state: "unavailable",
          reason: outcome.reason,
          message: outcome.message,
          session: this.#currentSession(request.requestId, session),
        });
      } else {
        validateMessage(outcome.message);
        this.#active = null;
        this.#publish({
          state: "failed",
          message: outcome.message,
          session: this.#currentSession(request.requestId, session),
        });
      }
    } catch (cause) {
      if (
        this.#closed ||
        controller.signal.aborted ||
        this.#active !== controller ||
        isAbortError(cause)
      ) {
        return this.#snapshot;
      }
      this.#active = null;
      this.#publish({
        state: "failed",
        message:
          cause instanceof Error && cause.message.length > 0 ? boundedMessage(cause.message) : null,
        session: this.#currentSession(request.requestId, session),
      });
    }
    return this.#snapshot;
  }

  #publish(snapshot: NavigatorSearchSnapshot): void {
    if (this.#closed) return;
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("the search coordinator is closed");
  }

  #currentSession(requestId: string, fallback: NavigatorSearchSession): NavigatorSearchSession {
    const current = sessionOf(this.#snapshot);
    return current?.requestId === requestId ? current : fallback;
  }
}

function validateUnavailableReason(
  value: Exclude<NavigatorSearchProviderOutcome, { status: "completed" | "failed" }>["reason"],
): void {
  if (
    value !== "index-unavailable" &&
    value !== "scope-unavailable" &&
    value !== "policy" &&
    value !== "snapshot-unavailable"
  ) {
    throw new NavigatorSearchContractError("the search unavailability reason is invalid");
  }
}

function validatedSession(
  facts: PublicationFacts,
  readingOrder: ReadingOrderIdentity | undefined,
  request: NavigatorSearchRequest,
  previous: NavigatorSearchSession,
  batch: NavigatorSearchBatch,
): NavigatorSearchSession {
  if (batch.requestId !== request.requestId) {
    throw new NavigatorSearchContractError("the search response request ID does not match");
  }
  if (!Array.isArray(batch.results) || batch.results.length > request.limit) {
    throw new NavigatorSearchContractError("the search response result count is invalid");
  }
  validateContinuation(batch.continuation);
  if (batch.continuation !== null && batch.results.length === 0) {
    throw new NavigatorSearchContractError("the search continuation did not add results");
  }
  if (batch.continuation !== null && batch.continuation === request.continuation) {
    throw new NavigatorSearchContractError("the search continuation did not advance");
  }
  const expectedOccurrences =
    request.scope.type === "publication" ? facts.resources.readingOrder.length : 1;
  validateCoverage(batch.coverage, previous.coverage, expectedOccurrences);
  validateTotalResultCount(batch.totalResultCount, previous.totalResultCount);

  const resultIds = new Set(previous.results.map((result) => result.id));
  const sections = new Map<string, NavigatorSearchResult["section"]>();
  for (const result of previous.results) sections.set(result.section.id, result.section);
  let last = previous.results.at(-1) ?? null;
  let aggregateBytes = byteLength(batch.continuation ?? "");
  const results: NavigatorSearchResult[] = [];
  for (const result of batch.results) {
    validateResult(facts, readingOrder, result);
    aggregateBytes += resultBytes(result);
    if (aggregateBytes > MAX_SEARCH_BATCH_BYTES) {
      throw new NavigatorSearchContractError("the search response is too large");
    }
    if (resultIds.has(result.id)) {
      throw new NavigatorSearchContractError("the search response contains a duplicate result ID");
    }
    resultIds.add(result.id);
    const knownSection = sections.get(result.section.id);
    if (knownSection !== undefined && !sameSection(knownSection, result.section)) {
      throw new NavigatorSearchContractError("the search response changed a section identity");
    }
    if (last !== null) {
      if (result.section.occurrence < last.section.occurrence) {
        throw new NavigatorSearchContractError("the search response is not in publication order");
      }
      if (knownSection !== undefined && result.section.id !== last.section.id) {
        throw new NavigatorSearchContractError("a search section is not contiguous");
      }
    }
    sections.set(result.section.id, result.section);
    results.push(result);
    last = result;
  }
  const merged = [...previous.results, ...results];
  if (batch.totalResultCount !== null && batch.totalResultCount < merged.length) {
    throw new NavigatorSearchContractError(
      "the search result total is smaller than the loaded results",
    );
  }
  if (
    batch.continuation === null &&
    batch.totalResultCount !== null &&
    batch.totalResultCount !== merged.length
  ) {
    throw new NavigatorSearchContractError(
      "the final search result total does not match the loaded results",
    );
  }
  return {
    ...previous,
    results: merged,
    coverage: batch.coverage,
    continuation: batch.continuation,
    totalResultCount: batch.totalResultCount,
  };
}

function validateResult(
  facts: PublicationFacts,
  readingOrder: ReadingOrderIdentity | undefined,
  result: NavigatorSearchResult,
): void {
  if (typeof result !== "object" || result === null)
    throw new NavigatorSearchContractError("a search result is invalid");
  validateBoundedNonemptyString(result.id, MAX_SEARCH_ID_BYTES, "result ID");
  if (typeof result.section !== "object" || result.section === null)
    throw new NavigatorSearchContractError("a search section is invalid");
  validateBoundedNonemptyString(result.section.id, MAX_SEARCH_ID_BYTES, "section ID");
  validateBoundedNonemptyString(
    result.section.resource,
    MAX_SEARCH_RESOURCE_BYTES,
    "section resource",
  );
  if (result.section.label !== null)
    validateBoundedString(result.section.label, MAX_SEARCH_SECTION_LABEL_BYTES, "section label");
  if (
    !validOccurrenceResource(
      facts,
      readingOrder,
      result.section.occurrence,
      result.section.resource,
    )
  ) {
    throw new NavigatorSearchContractError(
      "a search result does not match its reading-order occurrence",
    );
  }
  validateBoundedNonemptyString(result.targetJson, MAX_SEARCH_TARGET_JSON_BYTES, "target JSON");
  try {
    const target = JSON.parse(result.targetJson) as unknown;
    if (typeof target !== "object" || target === null || Array.isArray(target)) throw new Error();
  } catch {
    throw new NavigatorSearchContractError("a search result target is not a JSON object");
  }
  const excerpt = result.excerpt;
  if (typeof excerpt !== "object" || excerpt === null)
    throw new NavigatorSearchContractError("a search excerpt is invalid");
  if (
    typeof excerpt.before !== "string" ||
    typeof excerpt.match !== "string" ||
    typeof excerpt.after !== "string" ||
    excerpt.match.length === 0
  ) {
    throw new NavigatorSearchContractError("a search excerpt is invalid");
  }
  const text = excerpt.before + excerpt.match + excerpt.after;
  if (
    codePointLength(text) > MAX_SEARCH_EXCERPT_CODE_POINTS ||
    byteLength(text) > MAX_SEARCH_EXCERPT_BYTES
  ) {
    throw new NavigatorSearchContractError("a search excerpt is too large");
  }
}

function validateCoverage(
  coverage: NavigatorSearchCoverage,
  previous: NavigatorSearchCoverage | null,
  expectedOccurrences: number,
): void {
  if (
    typeof coverage !== "object" ||
    coverage === null ||
    !safeInteger(coverage.searchedOccurrences) ||
    !safeInteger(coverage.totalOccurrences) ||
    coverage.searchedOccurrences < 0 ||
    coverage.totalOccurrences !== expectedOccurrences ||
    coverage.searchedOccurrences > coverage.totalOccurrences
  ) {
    throw new NavigatorSearchContractError("the search coverage is invalid");
  }
  if (coverage.state === "complete") {
    if (coverage.searchedOccurrences !== coverage.totalOccurrences)
      throw new NavigatorSearchContractError("complete search coverage is inconsistent");
  } else if (coverage.state === "partial") {
    if (coverage.searchedOccurrences >= coverage.totalOccurrences)
      throw new NavigatorSearchContractError("partial search coverage is inconsistent");
    validateMessage(coverage.reason);
  } else {
    throw new NavigatorSearchContractError("the search coverage state is invalid");
  }
  if (
    previous !== null &&
    (coverage.totalOccurrences !== previous.totalOccurrences ||
      coverage.searchedOccurrences < previous.searchedOccurrences ||
      (previous.state === "complete" && coverage.state !== "complete"))
  ) {
    throw new NavigatorSearchContractError("the search coverage regressed");
  }
}

function validateTotalResultCount(value: number | null, previous: number | null): void {
  if (value !== null && (!safeInteger(value) || value < 0))
    throw new NavigatorSearchContractError("the search result total is invalid");
  if (previous !== null && value !== previous)
    throw new NavigatorSearchContractError("the search result total changed");
}

function validateScope(
  facts: PublicationFacts,
  readingOrder: ReadingOrderIdentity | undefined,
  capabilities: PublicationSearchCapabilities,
  scope: NavigatorSearchScope,
): void {
  if (!capabilities.scopes.includes(scope.type))
    throw new RangeError("the requested search scope is unavailable");
  if (scope.type === "publication") return;
  if (
    !safeInteger(scope.occurrence) ||
    scope.occurrence < 0 ||
    !validOccurrenceResource(facts, readingOrder, scope.occurrence, scope.resource)
  ) {
    throw new RangeError("the occurrence search scope is invalid");
  }
}

function validOccurrenceResource(
  facts: PublicationFacts,
  readingOrder: ReadingOrderIdentity | undefined,
  ordinal: number,
  resourcePath: string,
): boolean {
  if (readingOrder !== undefined) return readingOrder[ordinal] === resourcePath;
  const occurrence = facts.resources.readingOrder[ordinal];
  if (occurrence === undefined || occurrence.resource === null) {
    return false;
  }
  const resource = facts.resources.resources[occurrence.resource];
  return resource?.address.kind === "local" && resource.address.value === resourcePath;
}

function readingOrderIdentity(
  readingOrder: readonly ReadingOrderOccurrence[] | undefined,
): ReadingOrderIdentity | undefined {
  return readingOrder?.map((occurrence, ordinal) =>
    occurrence.ordinal === ordinal && occurrence.document.state === "loadable"
      ? occurrence.document.resource
      : null,
  );
}

function validateQuery(query: string): void {
  if (
    query.length === 0 ||
    codePointLength(query) > MAX_SEARCH_QUERY_CODE_POINTS ||
    byteLength(query) > MAX_SEARCH_QUERY_BYTES
  ) {
    throw new RangeError("the search query is invalid");
  }
}

function validateContinuation(value: string | null): void {
  if (
    value !== null &&
    (typeof value !== "string" ||
      value.length === 0 ||
      byteLength(value) > MAX_SEARCH_CONTINUATION_BYTES)
  ) {
    throw new NavigatorSearchContractError("the search continuation is invalid");
  }
}

function validateMessage(value: string | null): void {
  if (value !== null) validateBoundedString(value, MAX_SEARCH_MESSAGE_BYTES, "search message");
}

function boundedMessage(value: string): string | null {
  return byteLength(value) <= MAX_SEARCH_MESSAGE_BYTES ? value : null;
}

function validateBoundedNonemptyString(value: string, maxBytes: number, label: string): void {
  if (typeof value !== "string" || value.length === 0)
    throw new NavigatorSearchContractError(`the search ${label} is invalid`);
  validateBoundedString(value, maxBytes, label);
}

function validateBoundedString(value: string, maxBytes: number, label: string): void {
  if (typeof value !== "string" || byteLength(value) > maxBytes)
    throw new NavigatorSearchContractError(`the search ${label} is invalid`);
}

function resultBytes(result: NavigatorSearchResult): number {
  return (
    byteLength(result.id) +
    byteLength(result.section.id) +
    byteLength(result.section.resource) +
    byteLength(result.section.label ?? "") +
    byteLength(result.targetJson) +
    byteLength(result.excerpt.before) +
    byteLength(result.excerpt.match) +
    byteLength(result.excerpt.after)
  );
}

function sameSection(
  left: NavigatorSearchResult["section"],
  right: NavigatorSearchResult["section"],
): boolean {
  return (
    left.id === right.id &&
    left.occurrence === right.occurrence &&
    left.resource === right.resource &&
    left.label === right.label
  );
}

function sessionOf(snapshot: NavigatorSearchSnapshot): NavigatorSearchSession | null {
  return snapshot.state === "idle" ? null : snapshot.session;
}

function safeInteger(value: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}

function defaultRequestId(): string {
  requestSequence += 1;
  return `search-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}
