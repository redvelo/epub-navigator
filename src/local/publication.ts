import type { PublicationFacts } from "../generated/publication.js";
import { NavigatorError } from "../runtime.js";
import { initializeNavigatorWasm, WasmPublication } from "../wasm.js";

/** Opens an EPUB archive through the Stack-backed facade in Navigator's combined WASM module. */
export async function openLocalPublication(
  source: ArrayBuffer | Uint8Array,
): Promise<PublicationAccess> {
  await initializeNavigatorWasm().catch((cause: unknown) => {
    throw new NavigatorError(
      {
        code: "local-runtime-initialization-failed",
        message: errorMessage(cause, "the local EPUB runtime could not be initialized"),
      },
      { cause },
    );
  });

  let publication: WasmPublication;
  try {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    publication = WasmPublication.open(bytes);
  } catch (cause) {
    throw new NavigatorError(
      {
        code: "publication-open-failed",
        message: errorMessage(cause, "the EPUB publication could not be opened"),
      },
      { cause },
    );
  }
  try {
    return new WasmPublicationAccess(publication);
  } catch (error) {
    try {
      publication.free();
    } catch {
      // Preserve the error that prevented publication construction.
    }
    throw error;
  }
}

/** An opened EPUB publication backed by a WebAssembly allocation. */
export interface PublicationAccess {
  readonly facts: PublicationFacts;
  readonly availableResourcePaths: readonly string[];
  analysis(): LocalPublicationAnalysis;
  readResource(path: string): Uint8Array;
  close(): void;
}

export type ExecutableContentState = "detected" | "analyzed-absent" | "unknown" | "inapplicable";
export type ForegroundPreparationState = "eligible" | "ineligible" | "unknown";

export interface LocalSearchEntry {
  readonly id: string;
  readonly resourcePath: string;
  readonly fragment: string | null;
  readonly text: string;
  readonly source: string;
  readonly readingOrderOccurrenceIndexes: readonly number[];
}

export interface LocalSearchDocument {
  readonly occurrence: number;
  readonly resourcePath: string;
  readonly source: string;
}

export type LocalSearchDocumentState = "complete" | "partial" | "unavailable" | "inapplicable";

export interface LocalPublicationAnalysis {
  readonly executableContent: readonly ExecutableContentState[];
  readonly foregroundPreparation: readonly ForegroundPreparationState[];
  readonly searchDocuments: readonly LocalSearchDocument[];
  readonly searchEntries: readonly LocalSearchEntry[];
  readonly searchDocumentStates: Readonly<Record<string, LocalSearchDocumentState>>;
}

export const MAX_LOCAL_SEARCH_DOCUMENT_STATES_BYTES = 8 * 1_048_576;
export const MAX_LOCAL_SEARCH_DOCUMENTS_BYTES = 8 * 1_048_576;
export const MAX_LOCAL_SEARCH_ENTRIES_BYTES = 16 * 1_048_576;
export const MAX_LOCAL_ANALYSIS_BYTES = 256 * 1_048_576;
const MAX_LOCAL_SEARCH_ENTRIES = 100_000;
const MAX_LOCAL_SEARCH_ENTRY_TEXT_BYTES = 1_048_576;
const MAX_LOCAL_SEARCH_STRING_BYTES = 16_384;

class WasmPublicationAccess implements PublicationAccess {
  readonly facts: PublicationFacts;
  readonly availableResourcePaths: readonly string[];
  readonly #publication: WasmPublication;
  #closed = false;

  constructor(publication: WasmPublication) {
    this.#publication = publication;
    let factsJson: string;
    try {
      factsJson = publication.publicationFactsJson;
    } catch (cause) {
      throw new NavigatorError(
        {
          code: "publication-facts-read-failed",
          message: errorMessage(cause, "publication facts could not be read"),
        },
        { cause },
      );
    }
    this.facts = parsePublicationSnapshot(factsJson);
    this.availableResourcePaths = Object.freeze(
      this.facts.resources.resources.flatMap((resource) =>
        resource.presence.state === "present" && resource.address.kind === "local"
          ? [resource.address.value]
          : [],
      ),
    );
  }

  readResource(path: string): Uint8Array {
    this.#assertOpen();
    try {
      return this.#publication.readResource(path);
    } catch (cause) {
      throw new NavigatorError(
        {
          code: "resource-read-failed",
          message: errorMessage(cause, `publication resource could not be read: ${path}`),
          path,
        },
        { cause },
      );
    }
  }

  analysis(): LocalPublicationAnalysis {
    this.#assertOpen();
    let value: unknown;
    try {
      const json = this.#publication.analysisJson();
      if (utf8Length(json) > MAX_LOCAL_ANALYSIS_BYTES) {
        throw new RangeError("publication analysis is oversized");
      }
      value = JSON.parse(json);
    } catch (cause) {
      throw new NavigatorError(
        {
          code: "publication-facts-read-failed",
          message: errorMessage(cause, "publication analysis could not be read"),
        },
        { cause },
      );
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "executableContent",
        "foregroundPreparation",
        "searchDocuments",
        "searchEntries",
        "searchDocumentStates",
      ])
    ) {
      throw new NavigatorError({
        code: "publication-facts-read-failed",
        message: "publication analysis has an invalid shape",
      });
    }
    if (
      !isAlignedArray(value.executableContent, this.facts, isExecutableContentState) ||
      !isAlignedArray(value.foregroundPreparation, this.facts, isForegroundPreparationState) ||
      !isLocalSearchDocuments(value.searchDocuments, this.facts) ||
      !isLocalSearchEntries(value.searchEntries, this.facts) ||
      !isLocalSearchProjection(value.searchDocuments, value.searchEntries, this.facts) ||
      !isLocalSearchDocumentStates(value.searchDocumentStates, this.facts)
    ) {
      throw new NavigatorError({
        code: "publication-facts-read-failed",
        message: "publication analysis is invalid or not aligned with publication facts",
      });
    }
    const statesJson = JSON.stringify(value.searchDocumentStates);
    if (utf8Length(statesJson) > MAX_LOCAL_SEARCH_DOCUMENT_STATES_BYTES) {
      throw new NavigatorError({
        code: "publication-facts-read-failed",
        message: "publication analysis is oversized",
      });
    }
    // Search products beyond the browser-local storage bounds are dropped rather than failing
    // the import: the publication still opens, and every searchable document reports unavailable.
    const searchOversized =
      utf8Length(JSON.stringify(value.searchDocuments)) > MAX_LOCAL_SEARCH_DOCUMENTS_BYTES ||
      utf8Length(JSON.stringify(value.searchEntries)) > MAX_LOCAL_SEARCH_ENTRIES_BYTES;
    return Object.freeze({
      executableContent: Object.freeze(value.executableContent.slice()),
      foregroundPreparation: Object.freeze(value.foregroundPreparation.slice()),
      searchDocuments: Object.freeze(searchOversized ? [] : value.searchDocuments.slice()),
      searchEntries: Object.freeze(searchOversized ? [] : value.searchEntries.slice()),
      searchDocumentStates: freezeSearchDocumentStates(
        searchOversized
          ? Object.fromEntries(
              Object.entries(value.searchDocumentStates).map(([path, state]) => [
                path,
                state === "inapplicable" ? state : "unavailable",
              ]),
            )
          : value.searchDocumentStates,
      ),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#publication.free();
    } catch (cause) {
      throw new NavigatorError(
        {
          code: "publication-close-failed",
          message: errorMessage(cause, "the EPUB publication could not be closed cleanly"),
        },
        { cause },
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new NavigatorError({
        code: "publication-closed",
        message: "the EPUB publication is closed",
      });
    }
  }
}

function isExecutableContentState(value: unknown): value is ExecutableContentState {
  return (
    value === "detected" ||
    value === "analyzed-absent" ||
    value === "unknown" ||
    value === "inapplicable"
  );
}

function isForegroundPreparationState(value: unknown): value is ForegroundPreparationState {
  return value === "eligible" || value === "ineligible" || value === "unknown";
}

function isAlignedArray<T>(
  value: unknown,
  facts: PublicationFacts,
  predicate: (candidate: unknown) => candidate is T,
): value is T[] {
  return (
    Array.isArray(value) &&
    value.length === facts.resources.resources.length &&
    value.every(predicate)
  );
}

export function isLocalSearchEntries(
  value: unknown,
  facts: PublicationFacts,
): value is LocalSearchEntry[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_LOCAL_SEARCH_ENTRIES ||
    !isRecord(facts.package) ||
    !isRecord(facts.package.manifest) ||
    !Array.isArray(facts.package.manifest.items) ||
    !isRecord(facts.resources) ||
    !Array.isArray(facts.resources.resources) ||
    !Array.isArray(facts.resources.readingOrder)
  ) {
    return false;
  }
  const ids = new Set<string>();
  const occurrenceIdentities = new Map<
    number,
    { readonly resourcePath: string; readonly source: string }
  >();
  return value.every((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        "id",
        "resourcePath",
        "fragment",
        "text",
        "source",
        "readingOrderOccurrenceIndexes",
      ]) ||
      !isBoundedNonemptyString(entry.id, MAX_LOCAL_SEARCH_STRING_BYTES) ||
      ids.has(entry.id) ||
      !isBoundedNonemptyString(entry.resourcePath, MAX_LOCAL_SEARCH_STRING_BYTES) ||
      !isCanonicalResourcePath(entry.resourcePath) ||
      (entry.fragment !== null &&
        !isBoundedString(entry.fragment, MAX_LOCAL_SEARCH_STRING_BYTES)) ||
      !isBoundedNonemptyString(entry.text, MAX_LOCAL_SEARCH_ENTRY_TEXT_BYTES) ||
      !isBoundedNonemptyString(entry.source, MAX_LOCAL_SEARCH_STRING_BYTES) ||
      !Array.isArray(entry.readingOrderOccurrenceIndexes)
    ) {
      return false;
    }
    const occurrences = new Set<number>();
    let previousOccurrence = -1;
    for (const index of entry.readingOrderOccurrenceIndexes) {
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index <= previousOccurrence ||
        occurrences.has(index) ||
        facts.resources.readingOrder[index] === undefined
      ) {
        return false;
      }
      const identity = occurrenceIdentities.get(index);
      if (
        identity !== undefined &&
        (identity.resourcePath !== entry.resourcePath || identity.source !== entry.source)
      ) {
        return false;
      }
      occurrenceIdentities.set(index, {
        resourcePath: entry.resourcePath,
        source: entry.source,
      });
      occurrences.add(index);
      previousOccurrence = index;
    }
    ids.add(entry.id);
    return true;
  });
}

export function isLocalSearchDocuments(
  value: unknown,
  facts: PublicationFacts,
): value is LocalSearchDocument[] {
  if (
    !Array.isArray(value) ||
    !isRecord(facts.package) ||
    !isRecord(facts.package.manifest) ||
    !Array.isArray(facts.package.manifest.items) ||
    !isRecord(facts.resources) ||
    !Array.isArray(facts.resources.resources) ||
    !Array.isArray(facts.resources.declarations) ||
    !Array.isArray(facts.resources.readingOrder) ||
    value.length > facts.resources.readingOrder.length
  ) {
    return false;
  }
  const localPaths = new Set(
    facts.resources.resources.flatMap((resource) =>
      resource.address.kind === "local" ? [resource.address.value] : [],
    ),
  );
  const sourceIdentities = new Set(
    facts.package.manifest.items.flatMap((item, index) => {
      const target = facts.resources.declarations[index]?.target;
      const resource =
        target?.state === "resource" ? facts.resources.resources[target.resource] : undefined;
      return typeof item.href === "string" &&
        item.href.length > 0 &&
        resource?.address.kind === "local"
        ? [`${item.href}\u0000${resource.address.value}`]
        : [];
    }),
  );
  const occurrences = new Set<number>();
  let previousOccurrence = -1;
  return value.every((document) => {
    if (
      !isRecord(document) ||
      !hasExactKeys(document, ["occurrence", "resourcePath", "source"]) ||
      typeof document.occurrence !== "number" ||
      !Number.isSafeInteger(document.occurrence) ||
      document.occurrence < 0 ||
      document.occurrence <= previousOccurrence ||
      facts.resources.readingOrder[document.occurrence] === undefined ||
      occurrences.has(document.occurrence) ||
      !isBoundedNonemptyString(document.resourcePath, MAX_LOCAL_SEARCH_STRING_BYTES) ||
      !isCanonicalResourcePath(document.resourcePath) ||
      !localPaths.has(document.resourcePath) ||
      !isBoundedNonemptyString(document.source, MAX_LOCAL_SEARCH_STRING_BYTES) ||
      !sourceIdentities.has(`${document.source}\u0000${document.resourcePath}`)
    ) {
      return false;
    }
    occurrences.add(document.occurrence);
    previousOccurrence = document.occurrence;
    return true;
  });
}

export function isLocalSearchProjection(
  documents: unknown,
  entries: unknown,
  facts: PublicationFacts,
): boolean {
  if (!isLocalSearchDocuments(documents, facts) || !isLocalSearchEntries(entries, facts)) {
    return false;
  }
  const identities = new Map(
    documents.map((document) => [
      document.occurrence,
      { resourcePath: document.resourcePath, source: document.source },
    ]),
  );
  return entries.every(
    (entry) =>
      entry.readingOrderOccurrenceIndexes.length > 0 &&
      entry.readingOrderOccurrenceIndexes.every((occurrence) => {
        const identity = identities.get(occurrence);
        return (
          identity !== undefined &&
          identity.resourcePath === entry.resourcePath &&
          identity.source === entry.source
        );
      }),
  );
}

export function isLocalSearchDocumentStates(
  value: unknown,
  facts: PublicationFacts,
): value is Record<string, LocalSearchDocumentState> {
  if (
    !isRecord(value) ||
    Array.isArray(value) ||
    !isRecord(facts.resources) ||
    !Array.isArray(facts.resources.resources)
  ) {
    return false;
  }
  const localPaths = facts.resources.resources.flatMap((resource) =>
    resource.address.kind === "local" ? [resource.address.value] : [],
  );
  const localPathSet = new Set(localPaths);
  const entries = Object.entries(value);
  return (
    entries.length <= 10_000 &&
    entries.length === localPaths.length &&
    Reflect.ownKeys(value).length === entries.length &&
    localPathSet.size === localPaths.length &&
    entries.every(
      ([path, state]) =>
        utf8Length(path) <= MAX_LOCAL_SEARCH_STRING_BYTES &&
        isCanonicalResourcePath(path) &&
        localPathSet.has(path) &&
        (state === "complete" ||
          state === "partial" ||
          state === "unavailable" ||
          state === "inapplicable"),
    )
  );
}

function freezeSearchDocumentStates(
  value: Record<string, LocalSearchDocumentState>,
): Readonly<Record<string, LocalSearchDocumentState>> {
  const copy: Record<string, LocalSearchDocumentState> = Object.create(null);
  for (const [path, state] of Object.entries(value)) copy[path] = state;
  return Object.freeze(copy);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isBoundedNonemptyString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && utf8Length(value) <= maxBytes;
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8Length(value) <= maxBytes;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isCanonicalResourcePath(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    return false;
  }
  if (
    Array.from(path).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return false;
  }
  const segments = path.split("/");
  return (
    !segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") &&
    !segments[0]?.includes(":")
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function parsePublicationSnapshot(json: string): PublicationFacts {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new NavigatorError(
      {
        code: "publication-facts-parse-failed",
        message: errorMessage(cause, "publication facts are not valid JSON"),
      },
      { cause },
    );
  }

  if (!hasRequiredPublicationSnapshotShape(value)) {
    throw new NavigatorError({
      code: "publication-facts-invalid",
      message: "publication facts do not contain the required structural fields",
    });
  }
  return value;
}

function hasRequiredPublicationSnapshotShape(value: unknown): value is PublicationFacts {
  if (
    !isRecord(value) ||
    !isRecord(value.package) ||
    (value.navigation !== null && !isRecord(value.navigation)) ||
    !isRecord(value.resources) ||
    typeof value.resources.packagePath !== "string" ||
    !Array.isArray(value.resources.resources) ||
    !Array.isArray(value.resources.declarations) ||
    !Array.isArray(value.resources.readingOrder) ||
    !isRecord(value.resources.selections) ||
    !isRecord(value.navigationLoading) ||
    !Array.isArray(value.navigationTargets)
  ) {
    return false;
  }

  return value.resources.resources.every(
    (resource) =>
      isRecord(resource) &&
      isProviderPresence(resource.presence) &&
      isRecord(resource.address) &&
      isResourceAddressKind(resource.address.kind) &&
      typeof resource.address.value === "string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProviderPresence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.state === "present" || value.state === "missing" || value.state === "not-applicable";
}

function isResourceAddressKind(value: unknown): boolean {
  return (
    value === "local" ||
    value === "remote" ||
    value === "data" ||
    value === "external" ||
    value === "invalid"
  );
}
