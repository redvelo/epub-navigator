import type { PublicationMount } from "../../generated/kernel.js";
import type {
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
} from "../agent-protocol/index.js";
import type { TocTargetMeasurementOptions } from "../navigator/api.js";
import type { PaginationMeasurementRuntime } from "./contracts.js";
import type { PaginationCacheIdentity, PaginationMeasurementCache } from "./cache/contract.js";
import type { PaginationPacing } from "./constants.js";

export interface PaginationMeasurementResponses {
  readonly mount: PublicationMount;
  readonly eligibleResourcePaths: readonly string[];
}

export interface PublicationPaginationCapabilities {
  readonly responses?: PaginationMeasurementResponses | undefined;
  readonly foregroundPreparation?:
    | { readonly eligibleResourcePaths: readonly string[] }
    | undefined;
  readonly cache?: PaginationMeasurementCache | undefined;
  readonly cacheIdentity?: PaginationCacheIdentity | undefined;
  /** Host hint for how aggressively background measurement may run; default "normal". */
  readonly pacing?: PaginationPacing | undefined;
  readonly signal: AbortSignal;
  close(): void;
}

export type MeasurementRuntimeFactory = (
  container: HTMLElement,
) => Promise<PaginationMeasurementRuntime>;

export type PreparedTocMeasurement = (
  occurrence: number,
  frameGeneration: number,
  layoutGeneration: number,
  pageCount: number,
  targets: readonly TocTargetMeasurementRequest[],
  options?: TocTargetMeasurementOptions,
) => Promise<readonly TocTargetMeasurementResult[]>;
