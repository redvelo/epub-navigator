import type { TocTargetPagination } from "./types.js";

export interface BackgroundTargetOwner {
  readonly channel: "background";
  readonly occurrence: number;
  readonly runRevision: number;
  readonly taskGeneration: number;
  readonly documentGeneration: number;
  readonly layoutGeneration: number;
  readonly pageCount: number;
}

export interface BackgroundTargetResult {
  readonly owner: BackgroundTargetOwner;
  readonly results: readonly TocTargetPagination[];
}
