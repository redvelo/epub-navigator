import type { PublicationMount, ReadingOrderOccurrence } from "../generated/kernel.js";
import type { PublicationFacts, ResourceRecord } from "../generated/publication.js";
import { publicationResourceUrl } from "../mount.js";
import { type MountedPublication } from "../publication.js";
import type { PaginationMeasurementCache } from "../runtime/pagination/index.js";
import {
  isLocalSearchProjection,
  isLocalSearchDocuments,
  isLocalSearchEntries,
  isLocalSearchDocumentStates,
  MAX_LOCAL_SEARCH_ENTRIES_BYTES,
  MAX_LOCAL_SEARCH_DOCUMENTS_BYTES,
  MAX_LOCAL_SEARCH_DOCUMENT_STATES_BYTES,
  type ExecutableContentState,
  type ForegroundPreparationState,
  type LocalSearchEntry,
  type LocalSearchDocument,
  type LocalSearchDocumentState,
} from "./publication.js";

/** The stable cache namespace used by the demo browser-local host. */
export const localCachePrefix = "epub-navigator:";
export const localPaginationCachePrefix = "epub-navigator-pagination:";
// Reject prepared CSS and older navigation facts; rebuild raw resources only on explicit reimport.
export const localResourceManifestRevision =
  "raw-css-navigation-v3-response-instrumentation-v3-fixed-image-source-text-v1";

const internalStorageOrigin = "https://epub-navigator.invalid/";
const localPaginationRecordMaxBytes = 64 * 1024;
const localPaginationAggregateMaxBytes = 4 * 1024 * 1024;
const localPaginationMetadataMaxBytes = 1024;

export type LocalResponseInstrumentationProfile = "none" | "xhtml" | "svg" | "fixed-image";

export interface LocalResourceManifestEntry {
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly responseInstrumentation: LocalResponseInstrumentationProfile;
  readonly executableContent: ExecutableContentState;
  /** Missing only in manifests imported before foreground preparation analysis was persisted. */
  readonly foregroundPreparation?: ForegroundPreparationState | undefined;
}

export interface LocalResourceManifest {
  readonly revision: typeof localResourceManifestRevision;
  readonly resources: readonly LocalResourceManifestEntry[];
}

export interface LocalCompletionMarker {
  readonly id: string;
  readonly sourceSizeBytes: number;
  readonly importedAt: number;
}

export interface LocalPublicationRecord extends MountedPublication {
  readonly id: string;
  readonly searchDocumentStates: Readonly<Record<string, LocalSearchDocumentState>>;
  readonly sourceSizeBytes: number;
  readonly importedAt: number;
}

export interface LocalPublicationWrite {
  readonly id: string;
  readonly source: Uint8Array;
  readonly facts: PublicationFacts;
  readonly searchDocumentStates: Readonly<Record<string, LocalSearchDocumentState>>;
  readonly searchDocuments: readonly LocalSearchDocument[];
  readonly searchEntries: readonly LocalSearchEntry[];
  readonly manifest: LocalResourceManifest;
  readonly resources: Readonly<Record<string, Uint8Array>>;
  readonly importedAt: number;
}

export function localCacheName(id: string): string {
  assertPublicationId(id);
  return `${localCachePrefix}${id}`;
}

export function localPaginationCacheName(id: string): string {
  assertPublicationId(id);
  return `${localPaginationCachePrefix}${id}`;
}

export function createLocalPaginationCache(
  id: string,
  hostSignal: AbortSignal,
): PaginationMeasurementCache {
  assertPublicationId(id);
  const assertActive = (signal: AbortSignal): void => {
    if (hostSignal.aborted || signal.aborted)
      throw new DOMException("cache operation aborted", "AbortError");
  };
  return {
    async read(basis, record, { signal, maxBytes }) {
      return withPublicationLock(id, async () => {
        assertActive(signal);
        if (!(await caches.has(localCacheName(id)))) return null;
        const cache = await caches.open(localPaginationCacheName(id));
        const metadata = await readPaginationCacheMetadata(cache, id);
        const request = paginationCacheRequest(id, basis, record);
        if (!metadata.some((candidate) => candidate.basis === basis)) {
          await cache.delete(request);
          return null;
        }
        const response = await cache.match(request);
        assertActive(signal);
        if (response === undefined) return null;
        const storedBytes = responseContentLength(response);
        if (storedBytes === null) {
          await writePaginationCacheUpdateMarker(cache, id);
          await deletePaginationBasis(cache, id, basis);
          await writePaginationCacheMetadata(cache, id, removePaginationBasis(metadata, basis));
          return null;
        }
        try {
          const value = await readBoundedResponse(
            response,
            Math.min(maxBytes, localPaginationRecordMaxBytes),
            hostSignal,
            signal,
          );
          const touched = touchPaginationBasis(metadata, basis);
          if (touched !== metadata) await writePaginationCacheMetadata(cache, id, touched);
          return value;
        } catch (cause) {
          if (!(cause instanceof RangeError)) throw cause;
          await writePaginationCacheUpdateMarker(cache, id);
          await cache.delete(request);
          const next = removePaginationRecord(metadata, basis, storedBytes);
          await writePaginationCacheMetadata(cache, id, next);
          return null;
        }
      });
    },
    async write(basis, record, value, { signal }) {
      await withPublicationLock(id, async () => {
        assertActive(signal);
        if (value.byteLength > localPaginationRecordMaxBytes) {
          throw new RangeError("the pagination cache record is oversized");
        }
        if (!(await caches.has(localCacheName(id)))) return;
        const cache = await caches.open(localPaginationCacheName(id));
        let metadata = await readPaginationCacheMetadata(cache, id);
        const request = paginationCacheRequest(id, basis, record);
        const previous = await cache.match(request);
        let previousBytes = 0;
        if (previous !== undefined) {
          const storedBytes = responseContentLength(previous);
          if (storedBytes === null) {
            await writePaginationCacheUpdateMarker(cache, id);
            await deletePaginationBasis(cache, id, basis);
            metadata = removePaginationBasis(metadata, basis);
          } else {
            previousBytes = storedBytes;
          }
        }
        const next = putPaginationRecord(metadata, basis, value.byteLength, previousBytes);
        const aggregateBytes = next.metadata.reduce((total, group) => total + group.totalBytes, 0);
        if (aggregateBytes > localPaginationAggregateMaxBytes) {
          throw new RangeError("the pagination cache aggregate is oversized");
        }
        assertActive(signal);
        await writePaginationCacheUpdateMarker(cache, id);
        await cache.put(request, responseForBytes(value, "application/octet-stream"));
        for (const evicted of next.evicted) await deletePaginationBasis(cache, id, evicted.basis);
        await writePaginationCacheMetadata(cache, id, next.metadata);
        assertActive(signal);
      });
    },
    async remove(basis, record, { signal }) {
      await withPublicationLock(id, async () => {
        assertActive(signal);
        if (!(await caches.has(localCacheName(id)))) return;
        const cache = await caches.open(localPaginationCacheName(id));
        const request = paginationCacheRequest(id, basis, record);
        const response = await cache.match(request);
        const metadata = await readPaginationCacheMetadata(cache, id);
        const responseBytes = response === undefined ? 0 : responseContentLength(response);
        if (responseBytes === null) {
          await writePaginationCacheUpdateMarker(cache, id);
          await deletePaginationBasis(cache, id, basis);
          await writePaginationCacheMetadata(cache, id, removePaginationBasis(metadata, basis));
          return;
        }
        if (response === undefined) return;
        await writePaginationCacheUpdateMarker(cache, id);
        await cache.delete(request);
        const next = removePaginationRecord(metadata, basis, responseBytes);
        await writePaginationCacheMetadata(cache, id, next);
        assertActive(signal);
      });
    },
    async removeBasis(basis, { signal }) {
      await withPublicationLock(id, async () => {
        assertActive(signal);
        if (!(await caches.has(localCacheName(id)))) return;
        const cache = await caches.open(localPaginationCacheName(id));
        const metadata = await readPaginationCacheMetadata(cache, id);
        await writePaginationCacheUpdateMarker(cache, id);
        await deletePaginationBasis(cache, id, basis);
        await writePaginationCacheMetadata(
          cache,
          id,
          metadata.filter((candidate) => candidate.basis !== basis),
        );
        assertActive(signal);
      });
    },
  };
}

export function isPublicationId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function publicationMount(rootBaseUrl: string, id: string): PublicationMount {
  assertPublicationId(id);
  const base = validatedRootBase(rootBaseUrl);
  return {
    baseUrl: new URL(`${id}/`, base).href,
    remoteResources: "blocked",
    contentOrigin: "shared-reader-origin",
  };
}

export function resourceManifestFromFacts(
  facts: PublicationFacts,
  executableContent: readonly ExecutableContentState[] = facts.resources.resources.map(
    () => "unknown",
  ),
  foregroundPreparation: readonly ForegroundPreparationState[] = facts.resources.resources.map(
    () => "unknown",
  ),
  readingOrder: readonly ReadingOrderOccurrence[] = [],
): LocalResourceManifest {
  if (executableContent.length !== facts.resources.resources.length) {
    throw new Error("executable-content analysis is not aligned with publication resources");
  }
  if (foregroundPreparation.length !== facts.resources.resources.length) {
    throw new Error("foreground-preparation analysis is not aligned with publication resources");
  }
  const images = new Set(
    readingOrder.flatMap(({ document }) =>
      document.state === "loadable" && document.adapter === "fixed-image"
        ? [document.resource]
        : [],
    ),
  );
  return {
    revision: localResourceManifestRevision,
    resources: facts.resources.resources.flatMap((resource, ordinal) => {
      if (resource.presence.state !== "present" || resource.address.kind !== "local") return [];
      return [
        {
          ...manifestEntry(
            facts,
            resource,
            ordinal,
            resource.address.value,
            executableContent[ordinal] ?? "unknown",
            foregroundPreparation[ordinal] ?? "unknown",
          ),
          ...(images.has(resource.address.value)
            ? { responseInstrumentation: "fixed-image" as const }
            : {}),
        },
      ];
    }),
  };
}

export function resourceContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (
    {
      xhtml: "application/xhtml+xml; charset=utf-8",
      html: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "text/javascript; charset=utf-8",
      mjs: "text/javascript; charset=utf-8",
      svg: "image/svg+xml",
      xml: "application/xml; charset=utf-8",
      opf: "application/oebps-package+xml; charset=utf-8",
      ncx: "application/x-dtbncx+xml; charset=utf-8",
      json: "application/json; charset=utf-8",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      avif: "image/avif",
      woff: "font/woff",
      woff2: "font/woff2",
      ttf: "font/ttf",
      otf: "font/otf",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      mp4: "video/mp4",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      ogv: "video/ogg",
      webm: "video/webm",
    }[extension] ?? "application/octet-stream"
  );
}

export function resourceCacheRequest(id: string, path: string): Request {
  assertPublicationId(id);
  return new Request(
    publicationResourceUrl(
      {
        baseUrl: `${internalStorageOrigin}resources/${id}/`,
        remoteResources: "blocked",
        contentOrigin: "shared-reader-origin",
      },
      path,
    ),
  );
}

export async function writePublicationCache(
  cache: Cache,
  publication: LocalPublicationWrite,
  onResourceWritten?: (completed: number, total: number) => void,
): Promise<LocalCompletionMarker> {
  if (
    !isLocalSearchDocumentStates(publication.searchDocumentStates, publication.facts) ||
    !isLocalSearchDocuments(publication.searchDocuments, publication.facts) ||
    !isLocalSearchEntries(publication.searchEntries, publication.facts) ||
    !isLocalSearchProjection(
      publication.searchDocuments,
      publication.searchEntries,
      publication.facts,
    )
  ) {
    throw new TypeError("publication search metadata is invalid");
  }
  const marker: LocalCompletionMarker = {
    id: publication.id,
    sourceSizeBytes: publication.source.byteLength,
    importedAt: publication.importedAt,
  };
  const total = publication.manifest.resources.length;
  const factsJson = JSON.stringify(publication.facts);
  const searchDocumentStatesJson = JSON.stringify(publication.searchDocumentStates);
  const searchDocumentsJson = JSON.stringify(publication.searchDocuments);
  const searchEntriesJson = JSON.stringify(publication.searchEntries);
  const manifestJson = JSON.stringify(publication.manifest);
  if (utf8Length(searchDocumentStatesJson) > MAX_LOCAL_SEARCH_DOCUMENT_STATES_BYTES) {
    throw new RangeError("publication search document states are oversized");
  }
  if (utf8Length(searchEntriesJson) > MAX_LOCAL_SEARCH_ENTRIES_BYTES) {
    throw new RangeError("publication search entries are oversized");
  }
  if (utf8Length(searchDocumentsJson) > MAX_LOCAL_SEARCH_DOCUMENTS_BYTES) {
    throw new RangeError("publication search documents are oversized");
  }

  await cache.put(
    sourceCacheRequest(publication.id),
    responseForBytes(publication.source, "application/epub+zip"),
  );
  await cache.put(factsCacheRequest(publication.id), responseForText(factsJson));
  await cache.put(
    searchDocumentStatesCacheRequest(publication.id),
    responseForText(searchDocumentStatesJson),
  );
  await cache.put(
    searchDocumentsCacheRequest(publication.id),
    responseForText(searchDocumentsJson),
  );
  await cache.put(searchEntriesCacheRequest(publication.id), responseForText(searchEntriesJson));
  await cache.put(manifestCacheRequest(publication.id), responseForText(manifestJson));

  let completed = 0;
  for (const resource of publication.manifest.resources) {
    const bytes = publication.resources[resource.path];
    if (bytes === undefined) throw new Error(`resource bytes are missing: ${resource.path}`);
    await cache.put(
      resourceCacheRequest(publication.id, resource.path),
      responseForBytes(bytes, resource.mediaType),
    );
    completed += 1;
    onResourceWritten?.(completed, total);
  }

  await cache.put(markerCacheRequest(publication.id), responseForText(JSON.stringify(marker)));
  return marker;
}

export async function readCommittedPublication(
  rootBaseUrl: string,
  id: string,
): Promise<LocalPublicationRecord | undefined> {
  return (await readCommittedPublicationSnapshot(rootBaseUrl, id))?.publication;
}

export async function readCommittedPublicationSnapshot(
  rootBaseUrl: string,
  id: string,
): Promise<
  | {
      readonly publication: LocalPublicationRecord;
      readonly searchDocuments: readonly LocalSearchDocument[];
      readonly searchEntries: readonly LocalSearchEntry[];
    }
  | undefined
> {
  if (!isPublicationId(id) || !(await caches.has(localCacheName(id)))) return undefined;
  const cache = await caches.open(localCacheName(id));
  const marker = await readJson(cache, markerCacheRequest(id));
  const facts = await readJson(cache, factsCacheRequest(id));
  const searchDocumentStates = await readBoundedJson(
    cache,
    searchDocumentStatesCacheRequest(id),
    MAX_LOCAL_SEARCH_DOCUMENT_STATES_BYTES,
  );
  const searchEntries = await readBoundedJson(
    cache,
    searchEntriesCacheRequest(id),
    MAX_LOCAL_SEARCH_ENTRIES_BYTES,
  );
  const searchDocuments = await readBoundedJson(
    cache,
    searchDocumentsCacheRequest(id),
    MAX_LOCAL_SEARCH_DOCUMENTS_BYTES,
  );
  const manifest = await readJson(cache, manifestCacheRequest(id));
  if (
    !isCompletionMarker(marker, id) ||
    !isPublicationSnapshot(facts) ||
    !isLocalSearchDocumentStates(searchDocumentStates, facts) ||
    !isLocalSearchDocuments(searchDocuments, facts) ||
    !isLocalSearchEntries(searchEntries, facts) ||
    !isLocalSearchProjection(searchDocuments, searchEntries, facts) ||
    !isResourceManifest(manifest)
  ) {
    return undefined;
  }
  if (!(await cacheContains(cache, sourceCacheRequest(id)))) return undefined;
  for (const resource of manifest.resources) {
    if (!(await cacheContains(cache, resourceCacheRequest(id, resource.path)))) return undefined;
  }
  return {
    publication: {
      id,
      facts,
      searchDocumentStates: Object.freeze({ ...searchDocumentStates }),
      mount: publicationMount(rootBaseUrl, id),
      sourceSizeBytes: marker.sourceSizeBytes,
      importedAt: marker.importedAt,
    },
    searchDocuments,
    searchEntries,
  };
}

export async function readCommittedResourceManifest(
  id: string,
): Promise<LocalResourceManifest | undefined> {
  if (!isPublicationId(id) || !(await caches.has(localCacheName(id)))) return undefined;
  const cache = await caches.open(localCacheName(id));
  const manifest = await readJson(cache, manifestCacheRequest(id));
  return isResourceManifest(manifest) ? manifest : undefined;
}

export async function listCommittedPublications(
  rootBaseUrl: string,
): Promise<LocalPublicationRecord[]> {
  const names = await caches.keys();
  const publications: LocalPublicationRecord[] = [];
  for (const name of names) {
    if (!name.startsWith(localCachePrefix)) continue;
    const id = name.slice(localCachePrefix.length);
    const publication = await readCommittedPublication(rootBaseUrl, id);
    if (publication !== undefined) publications.push(publication);
  }
  return publications.sort((left, right) => right.importedAt - left.importedAt);
}

export async function deletePublicationCache(id: string): Promise<boolean> {
  const [authored] = await Promise.all([
    caches.delete(localCacheName(id)),
    caches.delete(localPaginationCacheName(id)),
  ]);
  return authored;
}

export function withPublicationLock<T>(id: string, callback: () => Promise<T>): Promise<T> {
  assertPublicationId(id);
  const lockManager = (
    globalThis as unknown as {
      readonly navigator?: {
        readonly locks?: {
          request<T>(name: string, callback: () => Promise<T>): Promise<T>;
        };
      };
    }
  ).navigator?.locks;
  return lockManager === undefined
    ? callback()
    : lockManager.request(`epub-navigator:${id}`, callback);
}

export function sourceCacheRequest(id: string): Request {
  return internalRequest(id, "source.epub");
}

export function factsCacheRequest(id: string): Request {
  return internalRequest(id, "facts.json");
}

export function manifestCacheRequest(id: string): Request {
  return internalRequest(id, "resources.json");
}

export function searchDocumentStatesCacheRequest(id: string): Request {
  return internalRequest(id, "search-document-states.json");
}

export function searchDocumentsCacheRequest(id: string): Request {
  return internalRequest(id, "search-documents.json");
}

export function searchEntriesCacheRequest(id: string): Request {
  return internalRequest(id, "search.json");
}

export function markerCacheRequest(id: string): Request {
  return internalRequest(id, "complete.json");
}

function paginationCacheRequest(id: string, basis: string, record: string): Request {
  assertPaginationCacheKey(basis);
  assertPaginationCacheKey(record);
  return new Request(`${internalStorageOrigin}pagination/${id}/entries/${basis}/${record}`);
}

function paginationCacheIndexRequest(id: string): Request {
  assertPublicationId(id);
  return new Request(`${internalStorageOrigin}pagination/${id}/index.json`);
}

interface PaginationCacheGroupMetadata {
  readonly basis: string;
  readonly totalBytes: number;
}

type PaginationCacheMetadata = readonly PaginationCacheGroupMetadata[];

const emptyPaginationCacheMetadata: PaginationCacheMetadata = Object.freeze([]);

async function readPaginationCacheMetadata(
  cache: Cache,
  id: string,
): Promise<PaginationCacheMetadata> {
  const response = await cache.match(paginationCacheIndexRequest(id));
  if (response === undefined) return emptyPaginationCacheMetadata;
  try {
    const bytes = await readBoundedResponse(response, localPaginationMetadataMaxBytes);
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (isPaginationCacheMetadata(value)) return value;
  } catch {
    // Invalid derived data is discarded rather than migrated.
  }
  await clearPaginationCache(cache);
  return emptyPaginationCacheMetadata;
}

function writePaginationCacheMetadata(
  cache: Cache,
  id: string,
  metadata: PaginationCacheMetadata,
): Promise<void> {
  return cache.put(paginationCacheIndexRequest(id), responseForText(JSON.stringify(metadata)));
}

function writePaginationCacheUpdateMarker(cache: Cache, id: string): Promise<void> {
  return cache.put(
    paginationCacheIndexRequest(id),
    responseForText(JSON.stringify({ state: "updating" })),
  );
}

function isPaginationCacheKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function touchPaginationBasis(
  metadata: PaginationCacheMetadata,
  basis: string,
): PaginationCacheMetadata {
  const group = metadata.find((candidate) => candidate.basis === basis);
  if (group === undefined || metadata[0] === group) return metadata;
  return [group, ...metadata.filter((candidate) => candidate !== group)];
}

function putPaginationRecord(
  metadata: PaginationCacheMetadata,
  basis: string,
  sizeBytes: number,
  previousSizeBytes: number,
): {
  readonly metadata: PaginationCacheMetadata;
  readonly evicted: readonly PaginationCacheGroupMetadata[];
} {
  const previous = metadata.find((candidate) => candidate.basis === basis);
  const group: PaginationCacheGroupMetadata = {
    basis,
    totalBytes: Math.max(0, (previous?.totalBytes ?? 0) - previousSizeBytes) + sizeBytes,
  };
  const bases = [group, ...metadata.filter((candidate) => candidate.basis !== basis)];
  return { metadata: bases.slice(0, 3), evicted: bases.slice(3) };
}

function removePaginationRecord(
  metadata: PaginationCacheMetadata,
  basis: string,
  sizeBytes: number,
): PaginationCacheMetadata {
  const group = metadata.find((candidate) => candidate.basis === basis);
  if (group === undefined || sizeBytes === 0) return metadata;
  const totalBytes = Math.max(0, group.totalBytes - sizeBytes);
  if (totalBytes === 0) return removePaginationBasis(metadata, basis);
  const replacement = { basis, totalBytes };
  return metadata.map((candidate) => (candidate === group ? replacement : candidate));
}

function removePaginationBasis(
  metadata: PaginationCacheMetadata,
  basis: string,
): PaginationCacheMetadata {
  return metadata.filter((candidate) => candidate.basis !== basis);
}

function isPaginationCacheMetadata(value: unknown): value is PaginationCacheMetadata {
  if (!Array.isArray(value) || value.length > 3) return false;
  const seen = new Set<string>();
  let aggregateBytes = 0;
  const valid = value.every((candidate) => {
    if (!isRecord(candidate)) return false;
    const { basis, totalBytes } = candidate;
    if (
      !isPaginationCacheKey(basis) ||
      seen.has(basis) ||
      typeof totalBytes !== "number" ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 0 ||
      totalBytes > localPaginationAggregateMaxBytes
    ) {
      return false;
    }
    seen.add(basis);
    aggregateBytes += totalBytes;
    return true;
  });
  return valid && aggregateBytes <= localPaginationAggregateMaxBytes;
}

async function clearPaginationCache(cache: Cache): Promise<void> {
  for (const request of await cache.keys()) await cache.delete(request);
}

function responseContentLength(response: Response): number | null {
  const value = response.headers.get("Content-Length");
  if (value === null || !/^\d+$/u.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes <= localPaginationRecordMaxBytes ? bytes : null;
}

async function deletePaginationBasis(cache: Cache, id: string, basis: string): Promise<void> {
  const prefix = `${internalStorageOrigin}pagination/${id}/entries/${basis}/`;
  for (const request of await cache.keys()) {
    if (request.url.startsWith(prefix)) await cache.delete(request);
  }
}

function assertPaginationCacheKey(key: string): void {
  if (!isPaginationCacheKey(key)) throw new Error("the pagination cache key is invalid");
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  ...signals: readonly AbortSignal[]
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("the pagination cache read limit is invalid");
  }
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RangeError("the pagination cache entry exceeds the read limit");
  }
  if (signals.some((signal) => signal.aborted)) {
    throw new DOMException("cache operation aborted", "AbortError");
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
  try {
    if (signals.some((signal) => signal.aborted)) {
      abort();
      throw new DOMException("cache operation aborted", "AbortError");
    }
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (signals.some((signal) => signal.aborted)) {
        throw new DOMException("cache operation aborted", "AbortError");
      }
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RangeError("the pagination cache entry exceeds the read limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    for (const signal of signals) signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function responseForBytes(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": "none",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(bytes.byteLength),
    },
  });
}

export function responseForText(text: string): Response {
  return new Response(text, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function manifestEntry(
  facts: PublicationFacts,
  resource: ResourceRecord,
  resourceOrdinal: number,
  path: string,
  executableContent: ExecutableContentState,
  foregroundPreparation: ForegroundPreparationState,
): LocalResourceManifestEntry {
  const declaredMediaType = resource.declarations
    .map((ordinal) => facts.package.manifest.items[ordinal]?.mediaType)
    .find(
      (mediaType): mediaType is string => typeof mediaType === "string" && mediaType.length > 0,
    );
  const mediaType = declaredMediaType?.trim() || resourceContentType(path);
  return {
    path,
    mediaType,
    sizeBytes: resource.presence.state === "present" ? Number(resource.presence.sizeBytes ?? 0) : 0,
    responseInstrumentation: resource.hasXhtmlDeclaration
      ? "xhtml"
      : resource.hasSvgDeclaration && isReadingOrderResource(facts, resourceOrdinal)
        ? "svg"
        : "none",
    executableContent,
    foregroundPreparation,
  };
}

function isReadingOrderResource(facts: PublicationFacts, resourceOrdinal: number): boolean {
  // Profiles are physical-resource metadata, so a spine SVG is also instrumented when reused as an image.
  return facts.resources.readingOrder.some((entry) => entry.resource === resourceOrdinal);
}

function validatedRootBase(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("the local publication mount base must be an absolute URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !url.pathname.endsWith("/")
  ) {
    throw new TypeError("the local publication mount base is invalid");
  }
  return url;
}

function assertPublicationId(id: string): void {
  if (!isPublicationId(id)) throw new TypeError("the local publication id is not a BLAKE3 digest");
}

function internalRequest(id: string, name: string): Request {
  assertPublicationId(id);
  return new Request(new URL(`${id}/${name}`, `${internalStorageOrigin}metadata/`).href);
}

async function readJson(cache: Cache, request: Request): Promise<unknown> {
  const response = await cache.match(request);
  if (response === undefined) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function readBoundedJson(cache: Cache, request: Request, maxBytes: number): Promise<unknown> {
  const response = await cache.match(request);
  if (response === undefined) return undefined;
  try {
    const bytes = await readBoundedResponse(response, maxBytes);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function cacheContains(cache: Cache, request: Request): Promise<boolean> {
  return (await cache.match(request)) !== undefined;
}

function isCompletionMarker(value: unknown, id: string): value is LocalCompletionMarker {
  return (
    isRecord(value) &&
    value.id === id &&
    typeof value.sourceSizeBytes === "number" &&
    Number.isSafeInteger(value.sourceSizeBytes) &&
    value.sourceSizeBytes >= 0 &&
    typeof value.importedAt === "number" &&
    Number.isFinite(value.importedAt)
  );
}

export function isResourceManifest(value: unknown): value is LocalResourceManifest {
  if (
    !isRecord(value) ||
    value.revision !== localResourceManifestRevision ||
    !Array.isArray(value.resources)
  ) {
    return false;
  }
  const paths = new Set<string>();
  return value.resources.every((resource) => {
    if (
      !isRecord(resource) ||
      typeof resource.path !== "string" ||
      !isCanonicalResourcePath(resource.path) ||
      paths.has(resource.path) ||
      typeof resource.mediaType !== "string" ||
      resource.mediaType.length === 0 ||
      typeof resource.sizeBytes !== "number" ||
      !Number.isFinite(resource.sizeBytes) ||
      "injectAgent" in resource ||
      !isResponseInstrumentationProfile(resource.responseInstrumentation) ||
      !isExecutableContentState(resource.executableContent) ||
      (resource.foregroundPreparation !== undefined &&
        !isForegroundPreparationState(resource.foregroundPreparation))
    ) {
      return false;
    }
    paths.add(resource.path);
    return true;
  });
}

function isResponseInstrumentationProfile(
  value: unknown,
): value is LocalResponseInstrumentationProfile {
  return value === "none" || value === "xhtml" || value === "svg" || value === "fixed-image";
}

function isForegroundPreparationState(value: unknown): value is ForegroundPreparationState {
  return value === "eligible" || value === "ineligible" || value === "unknown";
}

function isExecutableContentState(value: unknown): value is ExecutableContentState {
  return (
    value === "detected" ||
    value === "analyzed-absent" ||
    value === "unknown" ||
    value === "inapplicable"
  );
}

function isPublicationSnapshot(value: unknown): value is PublicationFacts {
  return (
    isRecord(value) &&
    isRecord(value.package) &&
    (value.navigation === null || isRecord(value.navigation)) &&
    isRecord(value.resources) &&
    typeof value.resources.packagePath === "string" &&
    Array.isArray(value.resources.resources) &&
    Array.isArray(value.resources.declarations)
  );
}

function isCanonicalResourcePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
