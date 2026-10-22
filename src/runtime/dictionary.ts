import {
  DICTIONARY_SECTION_PAGE_SIZE,
  MAX_DICTIONARY_QUERY_BYTES,
  NAVIGATOR_DICTIONARY_RELATION_KINDS,
  navigatorDictionarySectionKey,
  type NavigatorDictionaryBounded,
  type NavigatorDictionaryEntry,
  type NavigatorDictionaryLemmaReference,
  type NavigatorDictionaryLookup,
  type NavigatorDictionaryLookupRequest,
  type NavigatorDictionaryProviderOutcome,
  type NavigatorDictionaryRelationGroup,
  type NavigatorDictionaryResult,
  type NavigatorDictionarySectionPage,
  type NavigatorDictionarySectionRef,
  type NavigatorDictionarySense,
  type NavigatorDictionarySnapshot,
  type NavigatorDictionaryUnavailableReason,
  type NavigatorDictionaryView,
} from "../dictionary.js";

export interface PublicationDictionaryCapabilities {
  readonly views: readonly NavigatorDictionaryView[];
  readonly signal: AbortSignal;
  lookup(
    request: NavigatorDictionaryLookupRequest,
    context: { readonly signal: AbortSignal },
  ): Promise<
    NavigatorDictionaryProviderOutcome<{
      readonly lookup: NavigatorDictionaryLookup;
    }>
  >;
  entry(
    handle: string,
    context: { readonly signal: AbortSignal },
  ): Promise<
    NavigatorDictionaryProviderOutcome<{
      readonly entry: NavigatorDictionaryEntry;
    }>
  >;
  section(
    handle: string,
    section: NavigatorDictionarySectionRef,
    page: { readonly offset: number; readonly limit: number },
    context: { readonly signal: AbortSignal },
  ): Promise<
    NavigatorDictionaryProviderOutcome<{
      readonly section: NavigatorDictionarySectionPage;
    }>
  >;
  audio(
    handle: string,
    context: { readonly signal: AbortSignal },
  ): Promise<NavigatorDictionaryProviderOutcome<{ readonly blob: Blob }>>;
  /** Releases the reader-scoped provider. Must be safe to call more than once. */
  close(): void;
}

export interface NavigatorDictionaryAudioElement {
  src: string;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  addEventListener(type: "ended" | "error", listener: () => void): void;
  removeEventListener(type: "ended" | "error", listener: () => void): void;
}

export interface NavigatorDictionaryCoordinator {
  snapshot(): NavigatorDictionarySnapshot;
  subscribe(listener: (snapshot: NavigatorDictionarySnapshot) => void): () => void;
  /** A selection lookup starts a new history; a cross-reference keeps the current result. */
  lookup(
    text: string,
    language: string | null,
    initiator: NavigatorDictionaryLookupRequest["initiator"],
  ): Promise<NavigatorDictionarySnapshot>;
  back(): NavigatorDictionarySnapshot;
  /** Loads the next page of one section of a loaded entry. */
  loadSection(handle: string, section: NavigatorDictionarySectionRef): Promise<void>;
  /** Plays a pronunciation recording. Requires a user action. */
  play(handle: string): Promise<void>;
  stop(): void;
  clear(): void;
  close(): void;
}

export interface CreateNavigatorDictionaryCoordinatorOptions {
  readonly capabilities: PublicationDictionaryCapabilities;
  readonly createAudio?: (() => NavigatorDictionaryAudioElement) | undefined;
  readonly createObjectUrl?: ((blob: Blob) => string) | undefined;
  readonly revokeObjectUrl?: ((url: string) => void) | undefined;
  readonly createRequestId?: (() => string) | undefined;
}

export class NavigatorDictionaryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavigatorDictionaryContractError";
  }
}

const DETAIL_CONCURRENCY = 3;
let requestSequence = 0;

export function createNavigatorDictionaryCoordinator(
  options: CreateNavigatorDictionaryCoordinatorOptions,
): NavigatorDictionaryCoordinator {
  return new DictionaryCoordinator(options);
}

class DictionaryCoordinator implements NavigatorDictionaryCoordinator {
  readonly #capabilities: PublicationDictionaryCapabilities;
  readonly #views: ReadonlyMap<string, NavigatorDictionaryView>;
  readonly #createAudio: () => NavigatorDictionaryAudioElement;
  readonly #createObjectUrl: (blob: Blob) => string;
  readonly #revokeObjectUrl: (url: string) => void;
  readonly #createRequestId: () => string;
  readonly #listeners = new Set<(snapshot: NavigatorDictionarySnapshot) => void>();
  readonly #onCapabilityAbort = () => {
    this.#abortWork("capability-aborted");
    this.stop();
    this.#publish({
      lookup: {
        state: "unavailable",
        reason: "snapshot-unavailable",
        request: null,
      },
      history: [],
      playback: null,
    });
  };
  #snapshot: NavigatorDictionarySnapshot = {
    lookup: { state: "idle" },
    history: [],
    playback: null,
  };
  #work = new AbortController();
  #audio: NavigatorDictionaryAudioElement | null = null;
  #audioUrl: string | null = null;
  #playback: AbortController | null = null;
  #closed = false;

  constructor(options: CreateNavigatorDictionaryCoordinatorOptions) {
    this.#capabilities = options.capabilities;
    this.#createAudio = options.createAudio ?? (() => new Audio());
    this.#createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.#revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.#createRequestId = options.createRequestId ?? defaultRequestId;
    this.#views = validateViews(this.#capabilities.views);
    if (this.#capabilities.signal.aborted) this.#onCapabilityAbort();
    else
      this.#capabilities.signal.addEventListener("abort", this.#onCapabilityAbort, { once: true });
  }

  snapshot(): NavigatorDictionarySnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: NavigatorDictionarySnapshot) => void): () => void {
    this.#ensureOpen();
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  async lookup(
    text: string,
    language: string | null,
    initiator: NavigatorDictionaryLookupRequest["initiator"],
  ): Promise<NavigatorDictionarySnapshot> {
    this.#ensureOpen();
    if (this.#capabilities.signal.aborted) return this.#snapshot;
    const query = text.trim();
    if (query.length === 0) throw new RangeError("the dictionary query is empty");
    if (initiator !== "selection" && initiator !== "cross-reference") {
      throw new TypeError("the dictionary lookup initiator is invalid");
    }
    const request: NavigatorDictionaryLookupRequest = {
      requestId: this.#createRequestId(),
      text: query,
      language: validLanguage(language) ? language : null,
      initiator,
    };
    if (typeof request.requestId !== "string" || request.requestId.length === 0) {
      throw new RangeError("the dictionary request ID is invalid");
    }
    const current = this.#snapshot.lookup;
    const history =
      initiator === "selection"
        ? []
        : current.state === "ready"
          ? [...this.#snapshot.history, current.result]
          : this.#snapshot.history;
    const signal = this.#abortWork("superseded");
    this.#publish({
      ...this.#snapshot,
      lookup: { state: "looking-up", request },
      history,
    });
    if (byteLength(query) > MAX_DICTIONARY_QUERY_BYTES) {
      const lookup: NavigatorDictionaryLookup = {
        requestId: request.requestId,
        query,
        views: [...this.#views.keys()].map((viewId) => ({
          viewId,
          outcome: { type: "no-entry" },
        })),
      };
      this.#publish({
        ...this.#snapshot,
        lookup: {
          state: "ready",
          result: { request, lookup, details: {}, sections: {} },
        },
      });
      return this.#snapshot;
    }
    try {
      const outcome = await this.#capabilities.lookup(request, { signal });
      if (signal.aborted || this.#closed) return this.#snapshot;
      if (outcome.status === "completed") {
        const lookup = parseLookup(outcome.lookup, request, this.#views);
        const result: NavigatorDictionaryResult = {
          request,
          lookup,
          details: Object.fromEntries(
            entriesOf(lookup).map((entry) => [entry.handle, { state: "loading" }] as const),
          ),
          sections: {},
        };
        this.#publish({
          ...this.#snapshot,
          lookup: { state: "ready", result },
        });
        void this.#loadDetails(request.requestId, signal);
      } else if (outcome.status === "unavailable") {
        this.#publish({
          ...this.#snapshot,
          lookup: {
            state: "unavailable",
            reason: parseReason(outcome.reason),
            request,
          },
        });
      } else {
        this.#publish({
          ...this.#snapshot,
          lookup: {
            state: "failed",
            message: parseMessage(outcome.message),
            request,
          },
        });
      }
    } catch (cause) {
      if (signal.aborted || this.#closed || isAbortError(cause)) return this.#snapshot;
      this.#publish({
        ...this.#snapshot,
        lookup: { state: "failed", message: errorMessage(cause), request },
      });
    }
    return this.#snapshot;
  }

  back(): NavigatorDictionarySnapshot {
    this.#ensureOpen();
    const previous = this.#snapshot.history.at(-1);
    if (previous === undefined) return this.#snapshot;
    const signal = this.#abortWork("back");
    this.#publish({
      ...this.#snapshot,
      lookup: { state: "ready", result: previous },
      history: this.#snapshot.history.slice(0, -1),
    });
    if (Object.values(previous.details).some((detail) => detail.state === "loading")) {
      void this.#loadDetails(previous.request.requestId, signal);
    }
    return this.#snapshot;
  }

  async loadSection(handle: string, section: NavigatorDictionarySectionRef): Promise<void> {
    this.#ensureOpen();
    const result = this.#currentResult();
    if (result === null) return;
    const entry = entriesOf(result.lookup).find((candidate) => candidate.handle === handle);
    if (entry === undefined) throw new RangeError("the dictionary entry is not loaded");
    const key = navigatorDictionarySectionKey(handle, section);
    if (result.sections[key]?.state === "loading") return;
    const window = sectionWindow(entry, section);
    if (window === null || window.offset + window.items.length >= window.total) return;
    const offset = window.offset + window.items.length;
    const limit = Math.min(DICTIONARY_SECTION_PAGE_SIZE, window.total - offset);
    const requestId = result.request.requestId;
    const signal = this.#work.signal;
    this.#updateResult(requestId, (current) => ({
      ...current,
      sections: { ...current.sections, [key]: { state: "loading" } },
    }));
    try {
      const outcome = await this.#capabilities.section(
        handle,
        section,
        { offset, limit },
        { signal },
      );
      if (signal.aborted || this.#closed) return;
      if (outcome.status === "completed") {
        const page = parseSectionPage(outcome.section, section, offset, limit, window.total);
        this.#updateResult(requestId, (current) => {
          const { [key]: _loaded, ...sections } = current.sections;
          return {
            ...current,
            lookup: replaceEntry(current.lookup, handle, (existing) =>
              appendSection(existing, section, page),
            ),
            sections,
          };
        });
      } else {
        const message =
          outcome.status === "failed"
            ? parseMessage(outcome.message)
            : unavailableMessage(outcome.reason);
        this.#updateResult(requestId, (current) => ({
          ...current,
          sections: {
            ...current.sections,
            [key]: { state: "failed", message },
          },
        }));
      }
    } catch (cause) {
      if (signal.aborted || this.#closed || isAbortError(cause)) return;
      this.#updateResult(requestId, (current) => ({
        ...current,
        sections: {
          ...current.sections,
          [key]: { state: "failed", message: errorMessage(cause) },
        },
      }));
    }
  }

  async play(handle: string): Promise<void> {
    this.#ensureOpen();
    if (!availableAudioHandles(this.#currentResult()).has(handle)) {
      throw new RangeError("the dictionary recording is not loaded");
    }
    this.stop();
    const controller = new AbortController();
    this.#playback = controller;
    const abort = () => controller.abort("work-aborted");
    this.#work.signal.addEventListener("abort", abort, { once: true });
    this.#publish({
      ...this.#snapshot,
      playback: { handle, state: "loading" },
    });
    try {
      const outcome = await this.#capabilities.audio(handle, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || this.#closed) return;
      if (outcome.status !== "completed") throw new Error("the recording is unavailable");
      const blob = outcome.blob;
      if (!(blob instanceof Blob) || blob.size === 0 || !blob.type.startsWith("audio/")) {
        throw new NavigatorDictionaryContractError("the dictionary recording is invalid");
      }
      const audio = this.#audio ?? this.#createAudio();
      this.#audio = audio;
      const url = this.#createObjectUrl(blob);
      this.#audioUrl = url;
      const finish = (state: "ended" | "failed") => {
        audio.removeEventListener("ended", ended);
        audio.removeEventListener("error", failed);
        if (this.#playback !== controller) return;
        this.#releaseAudio();
        this.#playback = null;
        this.#publish({
          ...this.#snapshot,
          playback: state === "failed" ? { handle, state: "failed" } : null,
        });
      };
      const ended = () => finish("ended");
      const failed = () => finish("failed");
      audio.addEventListener("ended", ended);
      audio.addEventListener("error", failed);
      controller.signal.addEventListener(
        "abort",
        () => {
          audio.removeEventListener("ended", ended);
          audio.removeEventListener("error", failed);
        },
        { once: true },
      );
      audio.src = url;
      this.#publish({
        ...this.#snapshot,
        playback: { handle, state: "playing" },
      });
      await audio.play();
    } catch (cause) {
      if (controller.signal.aborted || this.#closed || this.#playback !== controller) return;
      if (isAbortError(cause)) return;
      this.#releaseAudio();
      this.#playback = null;
      this.#publish({
        ...this.#snapshot,
        playback: { handle, state: "failed" },
      });
    } finally {
      this.#work.signal.removeEventListener("abort", abort);
    }
  }

  stop(): void {
    if (this.#closed) return;
    const playback = this.#playback;
    this.#playback = null;
    playback?.abort("stopped");
    this.#releaseAudio();
    if (this.#snapshot.playback !== null) this.#publish({ ...this.#snapshot, playback: null });
  }

  clear(): void {
    if (this.#closed) return;
    this.#abortWork("cleared");
    this.stop();
    this.#publish({ lookup: { state: "idle" }, history: [], playback: null });
  }

  close(): void {
    if (this.#closed) return;
    this.stop();
    this.#closed = true;
    this.#work.abort("close");
    this.#capabilities.signal.removeEventListener("abort", this.#onCapabilityAbort);
    this.#listeners.clear();
    try {
      this.#capabilities.close();
    } catch {
      // Closing an already unusable host capability cannot change reader teardown.
    }
  }

  async #loadDetails(requestId: string, signal: AbortSignal): Promise<void> {
    const pending = (): string[] => {
      const result = this.#currentResult();
      if (result?.request.requestId !== requestId) return [];
      return Object.entries(result.details)
        .filter(([, detail]) => detail.state === "loading")
        .map(([handle]) => handle);
    };
    const queue = pending();
    const worker = async () => {
      for (let handle = queue.shift(); handle !== undefined; handle = queue.shift()) {
        if (signal.aborted || this.#closed) return;
        await this.#loadDetail(requestId, handle, signal);
      }
    };
    await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
  }

  async #loadDetail(requestId: string, handle: string, signal: AbortSignal): Promise<void> {
    try {
      const outcome = await this.#capabilities.entry(handle, { signal });
      if (signal.aborted || this.#closed) return;
      if (outcome.status === "completed") {
        const detail = parseEntry(outcome.entry, "entry");
        if (detail.handle !== handle) {
          throw new NavigatorDictionaryContractError("the dictionary entry handle does not match");
        }
        this.#updateResult(requestId, (current) => ({
          ...current,
          lookup: replaceEntry(current.lookup, handle, () => detail),
          details: { ...current.details, [handle]: { state: "loaded" } },
        }));
      } else {
        const message =
          outcome.status === "failed"
            ? parseMessage(outcome.message)
            : unavailableMessage(outcome.reason);
        this.#updateResult(requestId, (current) => ({
          ...current,
          details: {
            ...current.details,
            [handle]: { state: "failed", message },
          },
        }));
      }
    } catch (cause) {
      if (signal.aborted || this.#closed || isAbortError(cause)) return;
      this.#updateResult(requestId, (current) => ({
        ...current,
        details: {
          ...current.details,
          [handle]: { state: "failed", message: errorMessage(cause) },
        },
      }));
    }
  }

  #currentResult(): NavigatorDictionaryResult | null {
    return this.#snapshot.lookup.state === "ready" ? this.#snapshot.lookup.result : null;
  }

  #updateResult(
    requestId: string,
    update: (result: NavigatorDictionaryResult) => NavigatorDictionaryResult,
  ): void {
    const result = this.#currentResult();
    if (result?.request.requestId !== requestId) return;
    this.#publish({
      ...this.#snapshot,
      lookup: { state: "ready", result: update(result) },
    });
  }

  #abortWork(reason: string): AbortSignal {
    this.#work.abort(reason);
    this.#work = new AbortController();
    return this.#work.signal;
  }

  #releaseAudio(): void {
    const audio = this.#audio;
    if (audio !== null) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (this.#audioUrl !== null) this.#revokeObjectUrl(this.#audioUrl);
    this.#audioUrl = null;
  }

  #publish(snapshot: NavigatorDictionarySnapshot): void {
    if (this.#closed) return;
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("the dictionary coordinator is closed");
  }
}

export function navigatorDictionaryEntries(
  lookup: NavigatorDictionaryLookup,
): readonly NavigatorDictionaryEntry[] {
  return entriesOf(lookup);
}

function entriesOf(lookup: NavigatorDictionaryLookup): NavigatorDictionaryEntry[] {
  return lookup.views.flatMap((view) =>
    view.outcome.type === "completed" || view.outcome.type === "no-translation"
      ? view.outcome.entries.map((match) => match.entry)
      : [],
  );
}

function replaceEntry(
  lookup: NavigatorDictionaryLookup,
  handle: string,
  replace: (entry: NavigatorDictionaryEntry) => NavigatorDictionaryEntry,
): NavigatorDictionaryLookup {
  return {
    ...lookup,
    views: lookup.views.map((view) =>
      view.outcome.type === "completed" || view.outcome.type === "no-translation"
        ? {
            ...view,
            outcome: {
              ...view.outcome,
              entries: view.outcome.entries.map((match) =>
                match.entry.handle === handle ? { ...match, entry: replace(match.entry) } : match,
              ),
            },
          }
        : view,
    ),
  };
}

function availableAudioHandles(result: NavigatorDictionaryResult | null): Set<string> {
  const handles = new Set<string>();
  if (result === null) return handles;
  for (const entry of entriesOf(result.lookup)) {
    for (const pronunciation of entry.pronunciations.items) {
      const audio = pronunciation.audio;
      if (audio?.status === "available" || audio?.status === "remote") handles.add(audio.handle);
    }
  }
  return handles;
}

type AnyBounded = NavigatorDictionaryBounded<unknown>;

function sectionWindow(
  entry: NavigatorDictionaryEntry,
  section: NavigatorDictionarySectionRef,
): AnyBounded | null {
  switch (section.type) {
    case "etymology":
    case "pronunciations":
    case "hyphenations":
    case "forms":
    case "senses":
    case "translations":
    case "descendants":
    case "notes":
    case "categories":
      return entry[section.type];
    case "relations":
      return relationWindow(entry.relations, section.kind);
    case "sense-examples":
      return senseOf(entry, section.sense)?.examples ?? null;
    case "sense-translations":
      return senseOf(entry, section.sense)?.translations ?? null;
    case "sense-relations": {
      const sense = senseOf(entry, section.sense);
      return sense === null ? null : relationWindow(sense.relations, section.kind);
    }
  }
}

function senseOf(entry: NavigatorDictionaryEntry, sense: number): NavigatorDictionarySense | null {
  if (!Number.isSafeInteger(sense) || sense < entry.senses.offset) return null;
  return entry.senses.items[sense - entry.senses.offset] ?? null;
}

function relationWindow(
  groups: readonly NavigatorDictionaryRelationGroup[],
  kind: string,
): AnyBounded | null {
  return groups.find((group) => group.kind === kind)?.relations ?? null;
}

function appended<T>(
  window: NavigatorDictionaryBounded<T>,
  page: AnyBounded,
): NavigatorDictionaryBounded<T> {
  return {
    ...window,
    items: [...window.items, ...(page.items as readonly T[])],
  };
}

function appendRelations(
  groups: readonly NavigatorDictionaryRelationGroup[],
  kind: string,
  page: AnyBounded,
): NavigatorDictionaryRelationGroup[] {
  return groups.map((group) =>
    group.kind === kind ? { ...group, relations: appended(group.relations, page) } : group,
  );
}

function appendSection(
  entry: NavigatorDictionaryEntry,
  section: NavigatorDictionarySectionRef,
  page: AnyBounded,
): NavigatorDictionaryEntry {
  const updateSense = (
    sense: number,
    update: (value: NavigatorDictionarySense) => NavigatorDictionarySense,
  ) => ({
    ...entry,
    senses: {
      ...entry.senses,
      items: entry.senses.items.map((value, index) =>
        index + entry.senses.offset === sense ? update(value) : value,
      ),
    },
  });
  switch (section.type) {
    case "etymology":
    case "notes":
    case "categories":
      return { ...entry, [section.type]: appended(entry[section.type], page) };
    case "pronunciations":
      return { ...entry, pronunciations: appended(entry.pronunciations, page) };
    case "hyphenations":
      return { ...entry, hyphenations: appended(entry.hyphenations, page) };
    case "forms":
      return { ...entry, forms: appended(entry.forms, page) };
    case "senses":
      return { ...entry, senses: appended(entry.senses, page) };
    case "translations":
      return { ...entry, translations: appended(entry.translations, page) };
    case "descendants":
      return { ...entry, descendants: appended(entry.descendants, page) };
    case "relations":
      return {
        ...entry,
        relations: appendRelations(entry.relations, section.kind, page),
      };
    case "sense-examples":
      return updateSense(section.sense, (sense) => ({
        ...sense,
        examples: appended(sense.examples, page),
      }));
    case "sense-translations":
      return updateSense(section.sense, (sense) => ({
        ...sense,
        translations: appended(sense.translations, page),
      }));
    case "sense-relations":
      return updateSense(section.sense, (sense) => ({
        ...sense,
        relations: appendRelations(sense.relations, section.kind, page),
      }));
  }
}

// Validation. Parsers copy only known fields from untrusted provider values.

type Parser<T> = (value: unknown, path: string) => T;

function fail(path: string): never {
  throw new NavigatorDictionaryContractError(`the dictionary value ${path} is invalid`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(path);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str: Parser<string> = (value, path) => (typeof value === "string" ? value : fail(path));

const nonempty: Parser<string> = (value, path) =>
  typeof value === "string" && value.length > 0 ? value : fail(path);

const bool: Parser<boolean> = (value, path) => (typeof value === "boolean" ? value : fail(path));

const count: Parser<number> = (value, path) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(path);

function optional<T>(parser: Parser<T>): Parser<T | null> {
  return (value, path) => (value === null || value === undefined ? null : parser(value, path));
}

function list<T>(parser: Parser<T>): Parser<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path);
    return value.map((item, index) => parser(item, `${path}[${index}]`));
  };
}

function oneOf<T extends string>(values: readonly T[]): Parser<T> {
  return (value, path) => values.find((candidate) => candidate === value) ?? fail(path);
}

type Shape<T> = { readonly [K in keyof T]-?: Parser<T[K]> };

function object<T>(shape: Shape<T>): Parser<T> {
  return (value, path) => {
    const source = record(value, path);
    const parsed = {} as Record<string, unknown>;
    for (const [key, parser] of Object.entries(shape) as [string, Parser<unknown>][]) {
      parsed[key] = parser(source[key], `${path}.${key}`);
    }
    return parsed as T;
  };
}

function bounded<T>(item: Parser<T>): Parser<NavigatorDictionaryBounded<T>> {
  return (value, path) => {
    const window = object({ offset: count, total: count, items: list(item) })(value, path);
    if (window.offset + window.items.length > window.total) fail(path);
    return window;
  };
}

const strings = list(str);
const tagged = { tags: strings, rawTags: strings, truncated: bool };
const ruby = list(object({ base: str, text: str }));
const emphasis = list(object({ start: count, end: count }));
const relationKind = oneOf(NAVIGATOR_DICTIONARY_RELATION_KINDS);

const lemma = object<NavigatorDictionaryLemmaReference>({
  word: str,
  extra: optional(str),
  romanization: optional(str),
  tags: strings,
  truncated: bool,
});
const classifier = object({ ...tagged, classifier: str });

const credit = object({
  author: optional(str),
  authorUrls: strings,
  license: object({ shortName: nonempty, url: optional(str) }),
  sourceUrl: optional(str),
  attributionRequired: optional(bool),
  modification: optional(str),
});

const audio: Parser<NavigatorDictionaryPronunciationAudio> = (value, path) => {
  const source = record(value, path);
  const status = oneOf([
    "available",
    "remote",
    "unqualified",
    "missing",
    "failed",
    "not-in-collection",
    "collection-not-installed",
  ] as const)(source.status, `${path}.status`);
  if (status === "remote") {
    return {
      status,
      handle: nonempty(source.handle, `${path}.handle`),
      credit: credit(source.credit, `${path}.credit`),
    };
  }
  if (status !== "available") return { status };
  return {
    status,
    handle: nonempty(source.handle, `${path}.handle`),
    durationMs: count(source.durationMs, `${path}.durationMs`),
    credit: credit(source.credit, `${path}.credit`),
  };
};

type NavigatorDictionaryPronunciationAudio = NonNullable<
  NavigatorDictionaryEntry["pronunciations"]["items"][number]["audio"]
>;

const pronunciation = object<NavigatorDictionaryEntry["pronunciations"]["items"][number]>({
  ...tagged,
  ipa: optional(str),
  enpr: optional(str),
  zhPronunciation: optional(str),
  hangeul: optional(str),
  homophone: optional(str),
  romanization: optional(str),
  form: optional(str),
  rhymes: optional(str),
  text: optional(str),
  note: optional(str),
  other: optional(str),
  sense: optional(str),
  alternative: optional(str),
  notSamePronunciation: optional(bool),
  audioIpa: optional(str),
  homophones: strings,
  hyphenation: strings,
  topics: strings,
  audio: optional(audio),
});

const hyphenation = object({ ...tagged, parts: strings, sense: optional(str) });

const form = object({
  ...tagged,
  form: str,
  romanization: optional(str),
  ipa: strings,
  hiragana: optional(str),
  article: optional(str),
  literalMeaning: optional(str),
  source: optional(str),
  sense: optional(str),
  senseIndex: optional(str),
  pronouns: strings,
  ruby,
  topics: strings,
});

const translation = object({
  ...tagged,
  word: optional(str),
  languageName: optional(str),
  languageCode: optional(str),
  alt: optional(str),
  translation: optional(str),
  note: optional(str),
  sense: optional(str),
  senseIndex: optional(str),
  taxonomic: optional(str),
  romanization: optional(str),
  traditionalWriting: optional(str),
  other: optional(str),
  source: optional(str),
  uncertain: optional(bool),
  ruby,
  topics: strings,
});

const example = object({
  ...tagged,
  text: optional(str),
  textEmphasis: emphasis,
  translation: optional(str),
  translationEmphasis: emphasis,
  romanization: optional(str),
  romanizationEmphasis: emphasis,
  literalMeaning: optional(str),
  reference: optional(str),
  note: optional(str),
  exampleType: optional(str),
  ruby,
});

const relation = object({
  ...tagged,
  word: optional(str),
  alt: optional(str),
  translation: optional(str),
  extra: optional(str),
  qualifier: optional(str),
  romanization: optional(str),
  sense: optional(str),
  senseIndex: optional(str),
  note: optional(str),
  alternativeSpelling: optional(str),
  literalMeaning: optional(str),
  taxonomic: optional(str),
  source: optional(str),
  languageName: optional(str),
  languageCode: optional(str),
  ruby,
  topics: strings,
});

const relationGroups = list(object({ kind: relationKind, relations: bounded(relation) }));

const descendant = object({
  ...tagged,
  depth: count,
  word: optional(str),
  languageName: optional(str),
  languageCode: optional(str),
  romanization: optional(str),
  sense: optional(str),
  senseIndex: optional(str),
  ruby,
});

const sense = object({
  ...tagged,
  glosses: strings,
  rawGlosses: strings,
  qualifier: optional(str),
  taxonomic: optional(str),
  senseIndex: optional(str),
  notes: strings,
  topics: strings,
  categories: strings,
  formOf: list(lemma),
  altOf: list(lemma),
  compoundOf: list(lemma),
  classifiers: list(classifier),
  examples: bounded(example),
  translations: bounded(translation),
  relations: relationGroups,
});

const entryParser = object<NavigatorDictionaryEntry>({
  ...tagged,
  handle: nonempty,
  headword: nonempty,
  languageName: optional(str),
  languageCode: nonempty,
  partOfSpeech: optional(str),
  partOfSpeechTitle: optional(str),
  literalMeaning: optional(str),
  etymologyNumber: optional(str),
  formOf: list(lemma),
  altOf: list(lemma),
  classifiers: list(classifier),
  etymology: bounded(str),
  pronunciations: bounded(pronunciation),
  hyphenations: bounded(hyphenation),
  forms: bounded(form),
  senses: bounded(sense),
  translations: bounded(translation),
  senseTranslationTotal: count,
  relations: relationGroups,
  descendants: bounded(descendant),
  notes: bounded(str),
  categories: bounded(str),
});

const parseEntry = entryParser;

const matchClass = oneOf([
  "authored-headword",
  "nfc-headword",
  "folded-headword",
  "authored-form",
  "nfc-form",
  "folded-form",
] as const);

function parseLookup(
  value: unknown,
  request: NavigatorDictionaryLookupRequest,
  views: ReadonlyMap<string, NavigatorDictionaryView>,
): NavigatorDictionaryLookup {
  const source = record(value, "lookup");
  if (source.requestId !== request.requestId) {
    throw new NavigatorDictionaryContractError("the dictionary response request ID does not match");
  }
  const query = nonempty(source.query, "lookup.query");
  if (!Array.isArray(source.views) || source.views.length !== views.size) fail("lookup.views");
  const seenViews = new Set<string>();
  const handles = new Set<string>();
  const matches = (value: unknown, path: string) => {
    if (!Array.isArray(value)) fail(path);
    return value.map((item, index) => {
      const match = record(item, `${path}[${index}]`);
      const entry = parseEntry(match.entry, `${path}[${index}].entry`);
      if (handles.has(entry.handle)) fail(`${path}[${index}].entry.handle`);
      handles.add(entry.handle);
      return {
        matchClass: matchClass(match.matchClass, `${path}[${index}]`),
        entry,
      };
    });
  };
  const parsedViews = source.views.map((item, index) => {
    const path = `lookup.views[${index}]`;
    const view = record(item, path);
    if (typeof view.viewId !== "string" || !views.has(view.viewId) || seenViews.has(view.viewId)) {
      fail(`${path}.viewId`);
    }
    seenViews.add(view.viewId);
    const outcome = record(view.outcome, `${path}.outcome`);
    switch (outcome.type) {
      case "completed":
        return {
          viewId: view.viewId,
          outcome: {
            type: "completed" as const,
            entries: matches(outcome.entries, `${path}.outcome.entries`),
            truncated: bool(outcome.truncated, `${path}.outcome.truncated`),
          },
        };
      case "no-translation":
        return {
          viewId: view.viewId,
          outcome: {
            type: "no-translation" as const,
            entries: matches(outcome.entries, `${path}.outcome.entries`),
          },
        };
      case "no-entry":
      case "failed":
        return { viewId: view.viewId, outcome: { type: outcome.type } };
      default:
        return fail(`${path}.outcome.type`);
    }
  });
  return { requestId: request.requestId, query, views: parsedViews };
}

const sectionPageTypes = {
  etymology: bounded(str),
  notes: bounded(str),
  categories: bounded(str),
  pronunciations: bounded(pronunciation),
  hyphenations: bounded(hyphenation),
  forms: bounded(form),
  senses: bounded(sense),
  translations: bounded(translation),
  relations: bounded(relation),
  descendants: bounded(descendant),
  examples: bounded(example),
} as const;

function parseSectionPage(
  value: unknown,
  section: NavigatorDictionarySectionRef,
  offset: number,
  limit: number,
  total: number,
): AnyBounded {
  const source = record(value, "section");
  const expected =
    section.type === "sense-examples"
      ? "examples"
      : section.type === "sense-translations"
        ? "translations"
        : section.type === "sense-relations"
          ? "relations"
          : section.type;
  if (source.type !== expected) fail("section.type");
  const page = sectionPageTypes[expected](source.page, "section.page");
  if (
    page.offset !== offset ||
    page.total !== total ||
    page.items.length === 0 ||
    page.items.length > limit
  ) {
    fail("section.page");
  }
  return page;
}

function validateViews(
  views: readonly NavigatorDictionaryView[],
): Map<string, NavigatorDictionaryView> {
  if (!Array.isArray(views) || views.length === 0) {
    throw new NavigatorDictionaryContractError("the dictionary capability views are invalid");
  }
  const parsed = new Map<string, NavigatorDictionaryView>();
  for (const [index, value] of views.entries()) {
    const view = object<NavigatorDictionaryView>({
      viewId: nonempty,
      viewType: oneOf(["monolingual", "bilingual"] as const),
      sourceName: nonempty,
      editionLanguage: optional(nonempty),
      sourceLanguage: nonempty,
      targetLanguage: optional(nonempty),
    })(value, `views[${index}]`);
    if (
      parsed.has(view.viewId) ||
      !validLanguage(view.sourceLanguage) ||
      (view.editionLanguage !== null && !validLanguage(view.editionLanguage)) ||
      (view.viewType === "bilingual") !== (view.targetLanguage !== null) ||
      (view.targetLanguage !== null && !validLanguage(view.targetLanguage))
    ) {
      throw new NavigatorDictionaryContractError("the dictionary capability views are invalid");
    }
    parsed.set(view.viewId, view);
  }
  return parsed;
}

function parseReason(
  value: NavigatorDictionaryUnavailableReason,
): NavigatorDictionaryUnavailableReason {
  if (
    value !== "snapshot-unavailable" &&
    value !== "entry-unavailable" &&
    value !== "audio-unavailable"
  ) {
    throw new NavigatorDictionaryContractError("the dictionary unavailability reason is invalid");
  }
  return value;
}

function unavailableMessage(reason: NavigatorDictionaryUnavailableReason): string {
  parseReason(reason);
  return reason === "snapshot-unavailable"
    ? "The dictionaries changed."
    : "This dictionary entry is no longer available.";
}

function parseMessage(value: string | null): string | null {
  if (value !== null && typeof value !== "string") {
    throw new NavigatorDictionaryContractError("the dictionary message is invalid");
  }
  return value;
}

function errorMessage(cause: unknown): string | null {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : null;
}

function validLanguage(value: string | null): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(value);
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}

function defaultRequestId(): string {
  requestSequence += 1;
  return `dictionary-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}
