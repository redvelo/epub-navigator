export interface ScheduledPaginationWork {
  readonly occurrence: number;
  readonly task: "page-count" | "toc";
  readonly runRevision: number;
  readonly taskGeneration: number;
}
