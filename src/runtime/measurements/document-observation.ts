import { TocMeasurementRuntime } from "./toc-measurement.js";
import type { DocumentObservationOptions } from "../navigator/api.js";
import type { OwnedObservationOperation } from "../navigator/runtime-types.js";
import { AGENT_OPERATION_TIMEOUT_MS } from "../agent/configuration.js";
import { postFrameMessage } from "../agent/transport.js";
import { buildAgentRequest } from "../agent-protocol/index.js";
import type {
  DocumentObservationRequest,
  DocumentObservationResult,
} from "../agent-protocol/index.js";

export function documentObservationAbortError(): DOMException {
  return new DOMException("the document observation was cancelled", "AbortError");
}

/**
 * A direct reader-to-agent operation, like TOC measurement: it bypasses the kernel
 * because nothing about the publication's state changes. It is bound to the
 * committed frame generation it was sent to and is never advertised unless the
 * runtime was created with document observation enabled.
 */
export abstract class DocumentObservationRuntime extends TocMeasurementRuntime {
  observeDocument(
    request: DocumentObservationRequest,
    options: DocumentObservationOptions = {},
  ): Promise<DocumentObservationResult> {
    this._assertOpen();
    if (!this._documentObservation) {
      return Promise.reject(new Error("document observation is not enabled for this runtime"));
    }
    if (options.signal?.aborted === true) return Promise.reject(documentObservationAbortError());
    const frame = this._committed;
    if (
      frame === null ||
      frame.window === null ||
      frame.phase !== "committed" ||
      frame.documentGeneration === null ||
      frame.iframe.contentWindow !== frame.window
    ) {
      return Promise.reject(
        new Error("document observation requires a committed content document"),
      );
    }
    const operationId = this._nextDirectOperation;
    this._nextDirectOperation = operationId === 0xffff_ffff ? 0x8000_0000 : operationId + 1;
    if (this._observationOperations.has(operationId)) {
      return Promise.reject(new Error("the document observation operation counter is exhausted"));
    }
    let message;
    try {
      message = buildAgentRequest(frame.session, operationId, {
        type: "observe-document",
        observation: request,
      });
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
    const frameWindow = frame.window;
    return new Promise((resolve, reject) => {
      let operation: OwnedObservationOperation;
      const timer = setTimeout(() => {
        const current = this._observationOperations.get(operationId);
        if (current !== undefined) {
          this._releaseObservationOperation(operationId, current);
          current.fail(new Error("the document observation timed out"));
        }
      }, AGENT_OPERATION_TIMEOUT_MS);
      const signal = options.signal ?? null;
      const abortListener =
        signal === null
          ? null
          : () => {
              const current = this._observationOperations.get(operationId);
              if (current !== operation) return;
              this._releaseObservationOperation(operationId, current);
              current.fail(documentObservationAbortError());
            };
      operation = {
        frameGeneration: frame.frameGeneration,
        generation: frame.documentGeneration!,
        timer,
        signal,
        abortListener,
        finish: resolve,
        fail: reject,
      };
      this._observationOperations.set(operationId, operation);
      if (signal !== null && abortListener !== null) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      try {
        postFrameMessage(frameWindow, this._frameProfile, message);
      } catch (cause) {
        const current = this._observationOperations.get(operationId);
        if (current !== undefined) {
          this._releaseObservationOperation(operationId, current);
          current.fail(
            cause instanceof Error
              ? cause
              : new Error("the document observation request could not be delivered"),
          );
        }
      }
    });
  }

  protected _releaseObservationOperation(
    operationId: number,
    operation: OwnedObservationOperation,
  ): void {
    clearTimeout(operation.timer);
    if (operation.signal !== null && operation.abortListener !== null) {
      operation.signal.removeEventListener("abort", operation.abortListener);
    }
    if (this._observationOperations.get(operationId) === operation) {
      this._observationOperations.delete(operationId);
    }
  }

  protected _clearObservationOperationsForGeneration(generation: number): void {
    for (const [operationId, operation] of this._observationOperations) {
      if (operation.generation !== generation) continue;
      this._releaseObservationOperation(operationId, operation);
      operation.fail(new Error("the document observation was cancelled"));
    }
  }

  protected _clearAllObservationOperations(): void {
    for (const [operationId, operation] of this._observationOperations) {
      this._releaseObservationOperation(operationId, operation);
      operation.fail(new Error("the document observation was cancelled"));
    }
  }
}
