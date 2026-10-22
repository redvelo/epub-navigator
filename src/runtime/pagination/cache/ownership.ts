export interface CacheRestoreOwner {
  readonly channel: "cache";
  readonly occurrence: number;
  readonly runRevision: number;
  readonly entryRevision: number;
}

export interface CacheRecordResult<T> {
  readonly owner: CacheRestoreOwner;
  readonly value: T | null;
}
