export type PaginationCacheMutation =
  | {
      readonly type: "write";
      readonly record: string;
      readonly value: Uint8Array;
    }
  | {
      readonly type: "remove";
      readonly record: string;
    };

export interface PaginationMeasurementCache {
  read(
    basis: string,
    record: string,
    options: { readonly signal: AbortSignal; readonly maxBytes: number },
  ): Promise<Uint8Array | null>;
  /** Returns one bounded result per requested record, in request order. */
  readMany?(
    basis: string,
    records: readonly string[],
    options: { readonly signal: AbortSignal; readonly maxBytes: number },
  ): Promise<readonly (Uint8Array | null)[]>;
  write(
    basis: string,
    record: string,
    value: Uint8Array,
    options: { readonly signal: AbortSignal },
  ): Promise<void>;
  /** Applies the mutations in request order as one all-or-nothing operation. */
  writeMany?(
    basis: string,
    operations: readonly PaginationCacheMutation[],
    options: { readonly signal: AbortSignal },
  ): Promise<void>;
  remove?(basis: string, record: string, options: { readonly signal: AbortSignal }): Promise<void>;
  removeBasis(basis: string, options: { readonly signal: AbortSignal }): Promise<void>;
}

export interface PaginationCacheIdentity {
  /** SHA-256 of the deployed artifacts that can affect measurement results. */
  readonly measurementArtifactDigest: string;
}
