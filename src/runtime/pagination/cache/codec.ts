import type { TocTargetPageResult } from "../../agent-protocol/index.js";

export const cacheRecordMaxBytes = 64 * 1024;

export type CachedPageRecord =
  | {
      readonly type: "page-count";
      readonly revision: number;
      readonly pageCount: number;
      readonly columnsPerView: 1 | 2;
      readonly settled: boolean;
    }
  | {
      readonly type: "inapplicable";
      readonly revision: number;
      readonly reason: "effective-presentation-not-paginated";
    };

export interface CachedTargetRecord {
  readonly type: "toc-target";
  readonly revision: number;
  readonly result: Exclude<TocTargetPageResult, { readonly state: "failed" }>;
}

export function decodeCacheRecord<T>(
  bytes: Uint8Array,
  validate: (value: unknown) => value is T,
): T | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return validate(value) ? value : null;
  } catch {
    return null;
  }
}

export function encodeCacheRecord(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > cacheRecordMaxBytes)
    throw new RangeError("pagination record is oversized");
  return bytes;
}

export function isCachedPageRecord(value: unknown): value is CachedPageRecord {
  return (
    isRecord(value) &&
    isPositiveUint32(value.revision) &&
    ((value.type === "page-count" &&
      Object.keys(value).length === 5 &&
      isPositiveUint32(value.pageCount) &&
      (value.columnsPerView === 1 || value.columnsPerView === 2) &&
      typeof value.settled === "boolean") ||
      (value.type === "inapplicable" &&
        Object.keys(value).length === 3 &&
        isCacheableInapplicableReason(value.reason)))
  );
}

export function isCacheableInapplicableReason(
  value: unknown,
): value is "effective-presentation-not-paginated" {
  return value === "effective-presentation-not-paginated";
}

export function cachedTargetValidator(pageCount: number, revision: number) {
  return (value: unknown): value is CachedTargetRecord => {
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 3 ||
      value.type !== "toc-target" ||
      value.revision !== revision ||
      !isRecord(value.result)
    ) {
      return false;
    }
    const result = value.result;
    return (
      (result.state === "located" &&
        typeof result.physicalPage === "number" &&
        isUint32(result.physicalPage) &&
        result.physicalPage < pageCount) ||
      ((result.state === "ambiguous" || result.state === "unavailable") &&
        typeof result.reason === "string" &&
        result.reason.length <= 16_384)
    );
  };
}

export function isCachedTargetRecord(
  value: unknown,
  pageCount: number,
  revision: number,
): value is CachedTargetRecord {
  return cachedTargetValidator(pageCount, revision)(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function isPositiveUint32(value: unknown): value is number {
  return isUint32(value) && value > 0;
}
