import type {
  NavigatorAnnotationMutationRequest,
  NavigatorAnnotationProjection,
  NavigatorAnnotationRecord,
  NavigatorHighlightAnnotationRecord,
} from "../../src/annotations.js";
import type { NavigatorReadingPosition } from "epub-navigator/react";

export const annotationDatabaseName = "epub-navigator-reader";
export const annotationDatabaseVersion = 3;

const projectionStoreName = "annotation-projections";
const legacyProjectionStoreName = "highlight-projections";
const readingPositionStoreName = "reading-positions";
const maxPublicationIdLength = 1_024;
const maxRequestIdLength = 128;
const maxRecordIdLength = 128;
const maxRecords = 500;
const maxTargetBytes = 1_048_576;
const maxAggregateTargetBytes = 1_048_576;
const maxNoteCodePoints = 4_096;
const maxNoteBytes = 16_384;
const maxAggregateNoteBytes = 1_048_576;
const maxExcerptCodePoints = 512;
const maxExcerptBytes = 2_048;
const maxSectionLabelCodePoints = 256;
const maxSectionLabelBytes = 1_024;
const maxU32 = 0xffff_ffff;
const textEncoder = new TextEncoder();

export type AnnotationRecord = NavigatorAnnotationRecord;
export type AnnotationProjection = NavigatorAnnotationProjection;
export type AnnotationMutationRequest = NavigatorAnnotationMutationRequest;

export type AnnotationMutationResult =
  | {
      readonly status: "committed";
      readonly requestId: string;
      readonly basedOnRevision: number;
      readonly revision: number;
      readonly recordId: string;
      readonly projection: AnnotationProjection;
    }
  | {
      readonly status: "conflict";
      readonly requestId: string;
      readonly basedOnRevision: number;
      readonly revision: number;
      readonly projection: AnnotationProjection;
    };

export interface AnnotationRepository {
  load(publicationId: string, signal?: AbortSignal): Promise<AnnotationProjection>;
  mutate(
    publicationId: string,
    request: AnnotationMutationRequest,
    signal?: AbortSignal,
  ): Promise<AnnotationMutationResult>;
  loadReadingPosition(
    publicationId: string,
    signal?: AbortSignal,
  ): Promise<NavigatorReadingPosition | null>;
  saveReadingPosition(
    publicationId: string,
    position: NavigatorReadingPosition,
    signal?: AbortSignal,
  ): Promise<void>;
  removePublication(publicationId: string, signal?: AbortSignal): Promise<void>;
}

interface StoredAnnotationProjection extends AnnotationProjection {
  readonly publicationId: string;
}

interface StoredReadingPosition extends NavigatorReadingPosition {
  readonly publicationId: string;
}

interface LegacyHighlightRecord {
  readonly id: string;
  readonly targetJson: string;
  readonly occurrence: number;
}

export function createIndexedDbAnnotationRepository(
  databaseFactory: IDBFactory = indexedDB,
  randomUUID: () => string = () => crypto.randomUUID(),
): AnnotationRepository {
  return {
    async load(publicationId, signal) {
      validatePublicationId(publicationId);
      const database = await openDatabase(databaseFactory, signal);
      try {
        const transaction = migrationTransaction(database, "readwrite");
        const unbindAbort = bindAbort(transaction, signal);
        try {
          const projection = await loadCurrentOrMigrate(transaction, publicationId);
          await transactionCompletion(transaction);
          return projection;
        } catch (error) {
          abortTransaction(transaction);
          throw error;
        } finally {
          unbindAbort();
        }
      } finally {
        database.close();
      }
    },

    async mutate(publicationId, request, signal) {
      validatePublicationId(publicationId);
      validateMutationRequest(request);
      const database = await openDatabase(databaseFactory, signal);
      try {
        const transaction = migrationTransaction(database, "readwrite");
        const unbindAbort = bindAbort(transaction, signal);
        try {
          const current = await loadCurrentOrMigrate(transaction, publicationId);
          if (current.revision !== request.basedOnRevision) {
            await transactionCompletion(transaction);
            return {
              status: "conflict",
              requestId: request.requestId,
              basedOnRevision: request.basedOnRevision,
              revision: current.revision,
              projection: current,
            };
          }

          const { records, recordId } = applyMutation(current, request, randomUUID);
          validateProjectionContents(records);
          if (current.revision === maxU32) throw new Error("annotation revision is exhausted");
          const revision = current.revision + 1;
          const stored: StoredAnnotationProjection = { publicationId, revision, records };
          await requestResult(transaction.objectStore(projectionStoreName).put(stored));
          await transactionCompletion(transaction);
          return {
            status: "committed",
            requestId: request.requestId,
            basedOnRevision: request.basedOnRevision,
            revision,
            recordId,
            projection: { revision, records },
          };
        } catch (error) {
          abortTransaction(transaction);
          throw error;
        } finally {
          unbindAbort();
        }
      } finally {
        database.close();
      }
    },

    async loadReadingPosition(publicationId, signal) {
      validatePublicationId(publicationId);
      const database = await openDatabase(databaseFactory, signal);
      try {
        const transaction = database.transaction(readingPositionStoreName, "readonly");
        const unbindAbort = bindAbort(transaction, signal);
        try {
          const stored: unknown = await requestResult(
            transaction.objectStore(readingPositionStoreName).get(publicationId),
          );
          await transactionCompletion(transaction);
          return stored === undefined ? null : validateStoredReadingPosition(stored, publicationId);
        } catch (error) {
          abortTransaction(transaction);
          throw error;
        } finally {
          unbindAbort();
        }
      } finally {
        database.close();
      }
    },

    async saveReadingPosition(publicationId, position, signal) {
      validatePublicationId(publicationId);
      validateReadingPosition(position);
      const database = await openDatabase(databaseFactory, signal);
      try {
        const transaction = database.transaction(readingPositionStoreName, "readwrite");
        const unbindAbort = bindAbort(transaction, signal);
        try {
          const stored: StoredReadingPosition = { publicationId, ...position };
          await requestResult(transaction.objectStore(readingPositionStoreName).put(stored));
          await transactionCompletion(transaction);
        } catch (error) {
          abortTransaction(transaction);
          throw error;
        } finally {
          unbindAbort();
        }
      } finally {
        database.close();
      }
    },

    async removePublication(publicationId, signal) {
      validatePublicationId(publicationId);
      const database = await openDatabase(databaseFactory, signal);
      try {
        const transaction = publicationStateTransaction(database, "readwrite");
        const unbindAbort = bindAbort(transaction, signal);
        try {
          await requestResult(transaction.objectStore(projectionStoreName).delete(publicationId));
          await requestResult(
            transaction.objectStore(readingPositionStoreName).delete(publicationId),
          );
          if (hasLegacyStore(database)) {
            await requestResult(
              transaction.objectStore(legacyProjectionStoreName).delete(publicationId),
            );
          }
          await transactionCompletion(transaction);
        } catch (error) {
          abortTransaction(transaction);
          throw error;
        } finally {
          unbindAbort();
        }
      } finally {
        database.close();
      }
    },
  };
}

function applyMutation(
  current: AnnotationProjection,
  request: AnnotationMutationRequest,
  randomUUID: () => string,
): { records: AnnotationRecord[]; recordId: string } {
  if (
    request.type === "create-highlight" ||
    request.type === "create-note" ||
    request.type === "create-bookmark"
  ) {
    if (current.records.length >= maxRecords) {
      throw new Error("annotation projection has too many records");
    }
    const id = randomUUID();
    validateId(id, "generated annotation ID");
    if (current.records.some((record) => record.id === id)) {
      throw new Error("generated annotation ID is not unique");
    }
    const record: AnnotationRecord =
      request.type === "create-bookmark"
        ? {
            type: "bookmark",
            id,
            targetJson: request.targetJson,
            occurrence: request.occurrence,
            sectionLabel: request.sectionLabel,
            label: request.label,
          }
        : request.type === "create-note"
          ? {
              type: "note",
              id,
              targetJson: request.targetJson,
              occurrence: request.occurrence,
              excerpt: request.excerpt,
              sectionLabel: request.sectionLabel,
              text: request.text,
            }
          : {
              type: "highlight",
              id,
              targetJson: request.targetJson,
              occurrence: request.occurrence,
              excerpt: request.excerpt,
              sectionLabel: request.sectionLabel,
            };
    return { records: [...current.records, record], recordId: id };
  }

  const index = current.records.findIndex((record) => record.id === request.recordId);
  if (index < 0) throw new Error("annotation record does not exist");
  const existing = current.records[index];
  if (existing === undefined) throw new Error("annotation record does not exist");
  const records = [...current.records];
  if (request.type === "update-note") {
    if (existing.type !== "note") throw new Error("annotation record is not a note");
    records[index] = { ...existing, text: request.text };
  } else if (request.type === "convert-highlight-to-note") {
    if (existing.type !== "highlight") throw new Error("annotation record is not a highlight");
    records[index] = { ...existing, type: "note", text: request.text };
  } else if (request.type === "retarget-annotation") {
    if (existing.type === "bookmark") throw new Error("annotation record cannot be retargeted");
    records[index] = { ...existing, targetJson: request.targetJson, excerpt: request.excerpt };
  } else {
    records.splice(index, 1);
  }
  return { records, recordId: request.recordId };
}

async function loadCurrentOrMigrate(
  transaction: IDBTransaction,
  publicationId: string,
): Promise<AnnotationProjection> {
  const currentStore = transaction.objectStore(projectionStoreName);
  const stored: unknown = await requestResult(currentStore.get(publicationId));
  if (stored !== undefined) return validateStoredProjection(stored, publicationId);
  if (!transaction.db.objectStoreNames.contains(legacyProjectionStoreName))
    return emptyProjection();

  const legacyStore = transaction.objectStore(legacyProjectionStoreName);
  const legacy: unknown = await requestResult(legacyStore.get(publicationId));
  if (legacy === undefined) return emptyProjection();
  const migrated = validateLegacyProjection(legacy, publicationId);
  const next: StoredAnnotationProjection = { publicationId, ...migrated };
  await requestResult(currentStore.put(next));
  await requestResult(legacyStore.delete(publicationId));
  return migrated;
}

function validateMutationRequest(request: AnnotationMutationRequest): void {
  if (!isPlainObject(request) || typeof request.type !== "string") {
    throw new TypeError("annotation mutation request is invalid");
  }
  const common = ["type", "requestId", "basedOnRevision"];
  if (request.type === "create-bookmark") {
    requireExactKeys(request, [
      ...common,
      "locationRevision",
      "occurrence",
      "targetJson",
      "sectionLabel",
      "label",
    ]);
    if (!isU32(request.locationRevision)) {
      throw new TypeError("annotation location revision is invalid");
    }
    validateOccurrenceAndTarget(request);
    validateNullableText(
      request.sectionLabel,
      maxSectionLabelCodePoints,
      maxSectionLabelBytes,
      "section label",
    );
    validateNullableText(request.label, maxSectionLabelCodePoints, maxSectionLabelBytes, "label");
  } else if (request.type === "create-highlight") {
    requireExactKeys(request, [
      ...common,
      "selectionRevision",
      "occurrence",
      "targetJson",
      "excerpt",
      "sectionLabel",
    ]);
    validateCreateFields(request);
  } else if (request.type === "create-note") {
    requireExactKeys(request, [
      ...common,
      "selectionRevision",
      "occurrence",
      "targetJson",
      "excerpt",
      "sectionLabel",
      "text",
    ]);
    validateCreateFields(request);
    validateNoteText(request.text);
  } else if (request.type === "update-note" || request.type === "convert-highlight-to-note") {
    requireExactKeys(request, [...common, "recordId", "text"]);
    validateId(request.recordId, "annotation record ID");
    validateNoteText(request.text);
  } else if (request.type === "delete-annotation") {
    requireExactKeys(request, [...common, "recordId"]);
    validateId(request.recordId, "annotation record ID");
  } else if (request.type === "retarget-annotation") {
    requireExactKeys(request, [...common, "recordId", "targetJson", "excerpt"]);
    validateId(request.recordId, "annotation record ID");
    validateTarget(request.targetJson);
    if (typeof request.excerpt !== "string") throw new TypeError("annotation excerpt is invalid");
    validateNullableText(request.excerpt, maxExcerptCodePoints, maxExcerptBytes, "excerpt");
  } else {
    throw new TypeError("annotation mutation request is invalid");
  }
  validateId(request.requestId, "annotation request ID", maxRequestIdLength);
  if (!isU32(request.basedOnRevision)) throw new TypeError("annotation base revision is invalid");
}

function validateCreateFields(
  request: Extract<AnnotationMutationRequest, { type: "create-highlight" | "create-note" }>,
): void {
  if (!isU32(request.selectionRevision)) {
    throw new TypeError("annotation selection revision is invalid");
  }
  validateOccurrenceAndTarget(request);
  validateNullableText(request.excerpt, maxExcerptCodePoints, maxExcerptBytes, "excerpt");
  validateNullableText(
    request.sectionLabel,
    maxSectionLabelCodePoints,
    maxSectionLabelBytes,
    "section label",
  );
}

function validateOccurrenceAndTarget(request: {
  readonly occurrence: unknown;
  readonly targetJson: unknown;
}): void {
  if (!isU32(request.occurrence)) throw new TypeError("annotation occurrence is invalid");
  validateTarget(request.targetJson);
}

function validateStoredProjection(value: unknown, publicationId: string): AnnotationProjection {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["publicationId", "revision", "records"]) ||
    value.publicationId !== publicationId ||
    !isU32(value.revision) ||
    value.revision === 0 ||
    !Array.isArray(value.records) ||
    value.revision < value.records.length
  ) {
    throw new Error("stored annotation projection is invalid");
  }
  validateProjectionContents(value.records);
  return { revision: value.revision, records: value.records };
}

function validateProjectionContents(
  records: readonly unknown[],
): asserts records is AnnotationRecord[] {
  if (records.length > maxRecords) throw new Error("annotation projection has too many records");
  const ids = new Set<string>();
  let targetBytes = 0;
  let noteBytes = 0;
  for (const record of records) {
    validateRecord(record);
    if (ids.has(record.id)) throw new Error("stored annotation projection has duplicate IDs");
    ids.add(record.id);
    targetBytes += utf8Length(record.targetJson);
    if (record.type === "note") noteBytes += utf8Length(record.text);
  }
  if (targetBytes > maxAggregateTargetBytes) {
    throw new Error("annotation projection targets are oversized");
  }
  if (noteBytes > maxAggregateNoteBytes) {
    throw new Error("annotation projection notes are oversized");
  }
}

function validateRecord(value: unknown): asserts value is AnnotationRecord {
  if (!isPlainObject(value)) throw new Error("stored annotation record is invalid");
  const common = ["type", "id", "targetJson", "occurrence", "sectionLabel"];
  if (value.type === "highlight") requireStoredKeys(value, [...common, "excerpt"]);
  else if (value.type === "note") requireStoredKeys(value, [...common, "excerpt", "text"]);
  else if (value.type === "bookmark") requireStoredKeys(value, [...common, "label"]);
  else throw new Error("stored annotation record is invalid");
  try {
    validateId(value.id, "annotation record ID");
    validateTarget(value.targetJson);
    if (!isU32(value.occurrence)) throw new TypeError();
    validateNullableText(
      value.sectionLabel,
      maxSectionLabelCodePoints,
      maxSectionLabelBytes,
      "section label",
    );
    if (value.type === "bookmark") {
      validateNullableText(value.label, maxSectionLabelCodePoints, maxSectionLabelBytes, "label");
    } else {
      validateNullableText(value.excerpt, maxExcerptCodePoints, maxExcerptBytes, "excerpt");
      if (value.type === "note") validateNoteText(value.text);
    }
  } catch {
    throw new Error("stored annotation record is invalid");
  }
}

function validateStoredReadingPosition(
  value: unknown,
  publicationId: string,
): NavigatorReadingPosition {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["publicationId", "targetJson", "occurrenceHint"]) ||
    value.publicationId !== publicationId
  ) {
    throw new Error("stored reading position is invalid");
  }
  const position = {
    targetJson: value.targetJson,
    occurrenceHint: value.occurrenceHint,
  };
  try {
    validateReadingPosition(position);
  } catch {
    throw new Error("stored reading position is invalid");
  }
  return position;
}

function validateReadingPosition(value: unknown): asserts value is NavigatorReadingPosition {
  if (!isPlainObject(value) || !hasExactKeys(value, ["targetJson", "occurrenceHint"])) {
    throw new TypeError("reading position is invalid");
  }
  validateTarget(value.targetJson);
  if (value.occurrenceHint === null) return;
  if (
    !isPlainObject(value.occurrenceHint) ||
    !hasExactKeys(value.occurrenceHint, ["occurrence", "resource"]) ||
    !isU32(value.occurrenceHint.occurrence) ||
    !isCanonicalResourcePath(value.occurrenceHint.resource)
  ) {
    throw new TypeError("reading position occurrence hint is invalid");
  }
}

function isCanonicalResourcePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    !segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") &&
    !segments[0]?.includes(":")
  );
}

function validateLegacyProjection(value: unknown, publicationId: string): AnnotationProjection {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["publicationId", "revision", "records"]) ||
    value.publicationId !== publicationId ||
    !isU32(value.revision) ||
    value.revision === 0 ||
    !Array.isArray(value.records) ||
    value.records.length === 0 ||
    value.records.length > maxRecords ||
    value.revision < value.records.length
  ) {
    throw new Error("stored legacy highlight projection is invalid");
  }
  const ids = new Set<string>();
  let targetBytes = 0;
  const records: NavigatorHighlightAnnotationRecord[] = value.records.map((record: unknown) => {
    if (!isPlainObject(record) || !hasExactKeys(record, ["id", "targetJson", "occurrence"])) {
      throw new Error("stored legacy highlight record is invalid");
    }
    try {
      validateId(record.id, "legacy highlight ID");
      validateTarget(record.targetJson);
      if (!isU32(record.occurrence)) throw new TypeError();
    } catch {
      throw new Error("stored legacy highlight record is invalid");
    }
    const legacyRecord = record as unknown as LegacyHighlightRecord;
    if (ids.has(legacyRecord.id)) throw new Error("stored legacy highlight projection is invalid");
    ids.add(legacyRecord.id);
    targetBytes += utf8Length(legacyRecord.targetJson);
    return { type: "highlight", ...legacyRecord, excerpt: null, sectionLabel: null };
  });
  if (targetBytes > maxAggregateTargetBytes) {
    throw new Error("stored legacy highlight projection is oversized");
  }
  return { revision: value.revision, records };
}

function validateTarget(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || utf8Length(value) > maxTargetBytes) {
    throw new TypeError("annotation target is invalid");
  }
}

function validateNoteText(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    codePointLength(value) === 0 ||
    codePointLength(value) > maxNoteCodePoints ||
    !/\S/u.test(value) ||
    utf8Length(value) > maxNoteBytes
  ) {
    throw new TypeError("annotation note text is invalid");
  }
}

function validateNullableText(
  value: unknown,
  maxCodePoints: number,
  maxBytes: number,
  label: string,
): asserts value is string | null {
  if (
    value !== null &&
    (typeof value !== "string" ||
      codePointLength(value) > maxCodePoints ||
      utf8Length(value) > maxBytes)
  ) {
    throw new TypeError(`annotation ${label} is invalid`);
  }
}

function validatePublicationId(value: string): void {
  validateId(value, "publication ID", maxPublicationIdLength);
}

function validateId(
  value: unknown,
  label: string,
  maxLength = maxRecordIdLength,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} is invalid`);
  }
}

function emptyProjection(): AnnotationProjection {
  return { revision: 0, records: [] };
}

function isU32(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= maxU32;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (!hasExactKeys(value, keys)) throw new TypeError("annotation mutation request is invalid");
}

function requireStoredKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (!hasExactKeys(value, keys)) throw new Error("stored annotation record is invalid");
}

function hasLegacyStore(database: IDBDatabase): boolean {
  return database.objectStoreNames.contains(legacyProjectionStoreName);
}

function migrationTransaction(database: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  const stores = [projectionStoreName];
  if (hasLegacyStore(database)) stores.push(legacyProjectionStoreName);
  return database.transaction(stores, mode);
}

function publicationStateTransaction(
  database: IDBDatabase,
  mode: IDBTransactionMode,
): IDBTransaction {
  const stores = [projectionStoreName, readingPositionStoreName];
  if (hasLegacyStore(database)) stores.push(legacyProjectionStoreName);
  return database.transaction(stores, mode);
}

function openDatabase(factory: IDBFactory, signal?: AbortSignal): Promise<IDBDatabase> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const request = factory.open(annotationDatabaseName, annotationDatabaseVersion);
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(projectionStoreName)) {
        database.createObjectStore(projectionStoreName, { keyPath: "publicationId" });
      }
      if (!database.objectStoreNames.contains(readingPositionStoreName)) {
        database.createObjectStore(readingPositionStoreName, { keyPath: "publicationId" });
      }
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(request.error ?? new Error("failed to open annotation database"));
    };
    request.onsuccess = () => {
      signal?.removeEventListener("abort", abort);
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("annotation database request failed"));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new DOMException("Transaction aborted", "AbortError")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("annotation database transaction failed")),
      { once: true },
    );
  });
}

function bindAbort(transaction: IDBTransaction, signal?: AbortSignal): () => void {
  throwIfAborted(signal);
  const abort = () => abortTransaction(transaction);
  signal?.addEventListener("abort", abort, { once: true });
  return () => signal?.removeEventListener("abort", abort);
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already be complete.
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}
