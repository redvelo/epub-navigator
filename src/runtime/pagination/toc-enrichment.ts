import { MAX_TOC_TARGETS_PER_OPERATION } from "../agent-protocol/index.js";
import type {
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
} from "../agent-protocol/index.js";
import { failedTocTargets } from "./occurrence-state.js";

export interface TocEnrichmentResult<Owner> {
  readonly owner: Owner;
  readonly results: readonly TocTargetMeasurementResult[];
}

export async function enrichTocTargets<Owner>(options: {
  readonly owner: Owner;
  readonly requests: readonly TocTargetMeasurementRequest[];
  readonly signal: AbortSignal;
  readonly measure: (
    targets: readonly TocTargetMeasurementRequest[],
    signal: AbortSignal,
  ) => Promise<readonly TocTargetMeasurementResult[]>;
  readonly now: () => number;
  readonly deadlineMs?: number | undefined;
  readonly sliceMs?: number | undefined;
}): Promise<TocEnrichmentResult<Owner>> {
  const controller = new AbortController();
  const relay = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", relay, { once: true });
  const results: TocTargetMeasurementResult[] = [];
  let expired = false;
  let sliceStarted = options.now();
  const deadline = setTimeout(() => {
    expired = true;
    controller.abort("timeout");
  }, options.deadlineMs ?? 2_000);
  try {
    for (
      let offset = 0;
      offset < options.requests.length;
      offset += MAX_TOC_TARGETS_PER_OPERATION
    ) {
      const chunk = options.requests.slice(offset, offset + MAX_TOC_TARGETS_PER_OPERATION);
      try {
        results.push(...(await options.measure(chunk, controller.signal)));
      } catch (cause) {
        if (options.signal.aborted) throw cause;
        const message = expired
          ? "TOC target enrichment exceeded its occurrence deadline"
          : cause instanceof Error
            ? cause.message
            : "TOC target measurement failed";
        results.push(...failedTocTargets(chunk, message));
      }
      if (expired) {
        results.push(
          ...failedTocTargets(
            options.requests.slice(offset + chunk.length),
            "TOC target enrichment exceeded its occurrence deadline",
          ),
        );
        break;
      }
      if (
        offset + chunk.length < options.requests.length &&
        options.now() - sliceStarted >= (options.sliceMs ?? 8)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStarted = options.now();
      }
    }
    return { owner: options.owner, results };
  } finally {
    clearTimeout(deadline);
    options.signal.removeEventListener("abort", relay);
  }
}

import type { PaginationMeasurementRuntime } from "./contracts.js";
import { tocEnrichmentDeadlineMs, tocEnrichmentSliceMs } from "./constants.js";
import { MeasurementSessionPaginationController } from "./measurement-session.js";
import type { BackgroundTargetOwner, BackgroundTargetResult } from "./background-measurement.js";

export abstract class TocPaginationController extends MeasurementSessionPaginationController {
  async _measureTargets(
    runtime: PaginationMeasurementRuntime,
    owner: BackgroundTargetOwner,
  ): Promise<BackgroundTargetResult | null> {
    const requests = this._tocRequestsByOccurrence[owner.occurrence] ?? [];
    if (requests.length === 0) return { owner, results: [] };
    this._targetMeasurementController?.abort();
    const controller = new AbortController();
    this._targetMeasurementController = controller;
    try {
      return await enrichTocTargets({
        owner,
        requests,
        signal: controller.signal,
        measure: (targets, signal) => runtime.measureTocTargets(targets, { signal }),
        now: () => this._now(),
        deadlineMs: tocEnrichmentDeadlineMs,
        sliceMs: tocEnrichmentSliceMs,
      });
    } finally {
      if (this._targetMeasurementController === controller) {
        this._targetMeasurementController = null;
      }
    }
  }
}
