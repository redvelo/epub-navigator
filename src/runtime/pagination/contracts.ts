import type {
  KernelSnapshot,
  KernelTransition,
  PresentationPreferences,
} from "../../generated/kernel.js";
import type { NavigatorError } from "../../runtime.js";
import type { TocTargetMeasurementOptions } from "../navigator/api.js";
import type {
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
} from "../agent-protocol/index.js";

/** Browser capability required by an auxiliary whole-publication measurement session. */
export interface PaginationMeasurementRuntime {
  open(occurrence: number): KernelTransition;
  setPresentationPreferences(preferences: PresentationPreferences): KernelTransition;
  snapshot(): KernelSnapshot;
  subscribe(listener: (transition: KernelTransition) => void): () => void;
  subscribeErrors(listener: (error: NavigatorError) => void): () => void;
  measureTocTargets(
    targets: readonly TocTargetMeasurementRequest[],
    options?: TocTargetMeasurementOptions,
  ): Promise<readonly TocTargetMeasurementResult[]>;
  close(): KernelTransition;
}
