import { MediaOverlayAgentRuntime } from "../media-overlays/agent-coordinator.js";
import { type TocTargetMeasurementOptions } from "../navigator/api.js";
import { type OwnedFrame, type OwnedTocOperation } from "../navigator/runtime-types.js";
import {
  tocOperationAbortError,
  adapterSettlementPageCount,
} from "../navigator/runtime-support.js";
import { AGENT_OPERATION_TIMEOUT_MS } from "../agent/configuration.js";
import type { PaginationCancellationReason } from "../pagination/index.js";
import { postFrameMessage } from "../agent/transport.js";
import {
  currentDocument,
  currentFixedSettlement,
  currentPaginatedLayout,
  preparedSettledLayout,
} from "../kernel-view.js";
import { normalizeAgentRequest, MAX_TOC_TARGETS_PER_OPERATION } from "../agent-protocol/index.js";
import type {
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
} from "../agent-protocol/index.js";

export abstract class TocMeasurementRuntime extends MediaOverlayAgentRuntime {
  measureTocTargets(
    targets: readonly TocTargetMeasurementRequest[],
    options: TocTargetMeasurementOptions = {},
  ): Promise<readonly TocTargetMeasurementResult[]> {
    this._assertOpen();
    if (options.signal?.aborted === true) return Promise.reject(tocOperationAbortError());
    if (targets.length === 0 || targets.length > MAX_TOC_TARGETS_PER_OPERATION) {
      return Promise.reject(
        new Error(`TOC target measurement requires 1 to ${MAX_TOC_TARGETS_PER_OPERATION} targets`),
      );
    }
    const frame = this._committed;
    if (
      frame === null ||
      frame.window === null ||
      frame.phase !== "committed" ||
      frame.documentGeneration === null
    ) {
      return Promise.reject(new Error("TOC targets require a committed content document"));
    }
    const snapshot = this._kernel.snapshot();
    const document = currentDocument(snapshot);
    const layout = document?.layout.layout;
    const pageCount =
      currentPaginatedLayout(snapshot)?.pageCount ??
      (currentFixedSettlement(snapshot) === null ? null : 1);
    if (
      document?.generation !== frame.documentGeneration ||
      layout?.documentGeneration !== frame.documentGeneration ||
      pageCount === null
    ) {
      return Promise.reject(new Error("TOC targets require a committed paginated layout"));
    }
    return this._measureFrameTocTargets(
      frame,
      {
        owner: "committed",
        generation: frame.documentGeneration,
        occurrence: frame.occurrence,
        layoutGeneration: layout.layoutGeneration,
        pageCount,
      },
      targets,
      options,
    );
  }

  protected _measurePreparedTocTargets(
    occurrence: number,
    frameGeneration: number,
    layoutGeneration: number,
    pageCount: number,
    targets: readonly TocTargetMeasurementRequest[],
    options: TocTargetMeasurementOptions = {},
  ): Promise<readonly TocTargetMeasurementResult[]> {
    this._assertOpen();
    const frame = this._frames.get(frameGeneration);
    const prepared = this._kernel
      .snapshot()
      .preparedFrames.find((candidate) => candidate.frame.generation === frameGeneration);
    const settled = prepared === undefined ? null : preparedSettledLayout(prepared);
    const settledPageCount =
      settled === null ? null : adapterSettlementPageCount(settled.settlement);
    if (
      frame === undefined ||
      frame.role !== "prepared" ||
      frame.phase !== "prepared" ||
      prepared?.frame.occurrence !== occurrence ||
      settled?.layoutGeneration !== layoutGeneration ||
      settledPageCount !== pageCount
    ) {
      return Promise.reject(new Error("TOC targets do not identify the settled prepared frame"));
    }
    return this._measureFrameTocTargets(
      frame,
      {
        owner: "prepared",
        generation: null,
        occurrence,
        layoutGeneration,
        pageCount,
      },
      targets,
      options,
    );
  }

  protected _measureFrameTocTargets(
    frame: OwnedFrame,
    ownership: Pick<
      OwnedTocOperation,
      "owner" | "generation" | "occurrence" | "layoutGeneration" | "pageCount"
    >,
    targets: readonly TocTargetMeasurementRequest[],
    options: TocTargetMeasurementOptions,
  ): Promise<readonly TocTargetMeasurementResult[]> {
    if (options.signal?.aborted === true) return Promise.reject(tocOperationAbortError());
    if (targets.length === 0 || targets.length > MAX_TOC_TARGETS_PER_OPERATION) {
      return Promise.reject(
        new Error(`TOC target measurement requires 1 to ${MAX_TOC_TARGETS_PER_OPERATION} targets`),
      );
    }
    if (frame.window === null || frame.iframe.contentWindow !== frame.window) {
      return Promise.reject(new Error("TOC target frame is unavailable"));
    }
    const operationId = this._nextDirectOperation;
    this._nextDirectOperation = operationId === 0xffff_ffff ? 0x8000_0000 : operationId + 1;
    if (this._tocOperations.has(operationId)) {
      return Promise.reject(new Error("the TOC target operation counter is exhausted"));
    }
    const identities = new Set(
      targets.map((target) => `${target.listIndex}:${target.pointPath.join("/")}`),
    );
    if (identities.size !== targets.length) {
      return Promise.reject(new Error("TOC target identities must be unique"));
    }
    const request = normalizeAgentRequest({
      namespace: "epub-navigator",
      session: frame.session,
      type: "request",
      operation: operationId,
      request: { type: "measure-toc-targets", targets },
    });
    if (request === null) return Promise.reject(new Error("TOC target requests are invalid"));
    const frameWindow = frame.window;
    return new Promise((resolve, reject) => {
      let operation: OwnedTocOperation;
      const timer = setTimeout(() => {
        const current = this._tocOperations.get(operationId);
        if (current !== undefined) {
          this._cancelTocOperation(frame, operationId, current, "timeout");
          this._releaseTocOperation(operationId, current);
          current.fail(new Error("the TOC target measurement timed out"));
        }
      }, AGENT_OPERATION_TIMEOUT_MS);
      const signal = options.signal ?? null;
      const abortListener =
        signal === null
          ? null
          : () => {
              const current = this._tocOperations.get(operationId);
              if (current !== operation) return;
              this._cancelTocOperation(
                frame,
                operationId,
                current,
                signal.reason === "timeout" ? "timeout" : "owner-superseded",
              );
              this._releaseTocOperation(operationId, current);
              current.fail(tocOperationAbortError());
            };
      operation = {
        ...ownership,
        frameGeneration: frame.frameGeneration,
        timer,
        identities,
        signal,
        abortListener,
        cancellationSent: false,
        finish: resolve,
        fail: reject,
      };
      this._tocOperations.set(operationId, operation);
      if (signal !== null && abortListener !== null) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      if (signal?.aborted === true) {
        abortListener?.();
        return;
      }
      if (ownership.generation !== null) {
        this._record({
          type: "operation-owner",
          action: "register",
          operationKind: "toc",
          operation: operationId,
          documentGeneration: ownership.generation,
          layoutGeneration: ownership.layoutGeneration,
        });
      }
      try {
        postFrameMessage(frameWindow, this._frameProfile, request);
      } catch (cause) {
        const operation = this._tocOperations.get(operationId);
        if (operation !== undefined) {
          this._cancelTocOperation(frame, operationId, operation, "delivery-failed");
          this._releaseTocOperation(operationId, operation);
          operation.fail(
            cause instanceof Error
              ? cause
              : new Error("the TOC target request could not be delivered"),
          );
        }
      }
    });
  }

  protected _tocOperationIsCurrent(frame: OwnedFrame, operation: OwnedTocOperation): boolean {
    const snapshot = this._kernel.snapshot();
    if (operation.owner === "prepared") {
      const prepared = snapshot.preparedFrames.find(
        (candidate) => candidate.frame.generation === operation.frameGeneration,
      );
      const settled = prepared === undefined ? null : preparedSettledLayout(prepared);
      const pageCount = settled === null ? null : adapterSettlementPageCount(settled.settlement);
      return (
        frame.role === "prepared" &&
        frame.phase === "prepared" &&
        prepared?.frame.occurrence === operation.occurrence &&
        settled?.layoutGeneration === operation.layoutGeneration &&
        pageCount === operation.pageCount
      );
    }
    const document = currentDocument(snapshot);
    const layout = document?.layout.layout;
    const pageCount =
      currentPaginatedLayout(snapshot)?.pageCount ??
      (currentFixedSettlement(snapshot) === null ? null : 1);
    return (
      operation.generation !== null &&
      frame === this._committed &&
      frame.phase === "committed" &&
      document?.generation === operation.generation &&
      layout?.documentGeneration === operation.generation &&
      layout.layoutGeneration === operation.layoutGeneration &&
      pageCount === operation.pageCount
    );
  }

  protected _clearTocOperationsForGeneration(generation: number): void {
    for (const [operationId, operation] of this._tocOperations) {
      if (operation.generation !== generation) continue;
      this._releaseTocOperation(operationId, operation);
      operation.fail(new Error("the TOC target measurement was cancelled"));
    }
  }

  protected _clearTocOperationsForSupersededLayout(
    generation: number,
    layoutGeneration: number,
  ): void {
    for (const [operationId, operation] of this._tocOperations) {
      if (operation.generation !== generation || operation.layoutGeneration === layoutGeneration) {
        continue;
      }
      const frame = [...this._frames.values()].find(
        (candidate) => candidate.documentGeneration === generation,
      );
      if (frame !== undefined) this._cancelTocOperation(frame, operationId, operation);
      this._releaseTocOperation(operationId, operation);
      operation.fail(new Error("the TOC target layout was superseded"));
    }
  }

  protected _clearAllTocOperations(): void {
    for (const [operationId, operation] of this._tocOperations) {
      this._releaseTocOperation(operationId, operation);
      operation.fail(new Error("the TOC target measurement was cancelled"));
    }
  }

  protected _cancelTocOperationsForFrame(frame: OwnedFrame): void {
    for (const [operationId, operation] of this._tocOperations) {
      if (operation.frameGeneration !== frame.frameGeneration) continue;
      this._cancelTocOperation(frame, operationId, operation);
      this._releaseTocOperation(operationId, operation);
      operation.fail(tocOperationAbortError());
    }
  }

  protected _releaseTocOperation(operationId: number, operation: OwnedTocOperation): void {
    clearTimeout(operation.timer);
    if (operation.signal !== null && operation.abortListener !== null) {
      operation.signal.removeEventListener("abort", operation.abortListener);
    }
    if (this._tocOperations.get(operationId) === operation) {
      this._tocOperations.delete(operationId);
    }
  }

  protected _cancelTocOperation(
    frame: OwnedFrame,
    operationId: number,
    operation: OwnedTocOperation,
    reason: PaginationCancellationReason = "owner-superseded",
  ): void {
    if (operation.cancellationSent) return;
    operation.cancellationSent = true;
    if (operation.generation !== null) {
      this._record({
        type: "operation-owner",
        action: "cancel",
        operationKind: "toc",
        operation: operationId,
        documentGeneration: operation.generation,
        layoutGeneration: operation.layoutGeneration,
        reason,
      });
    }
    this._postOperationCancellation(frame, operationId, "measure-toc-targets");
  }
}
