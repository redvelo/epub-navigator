import { FixedViewRuntime } from "../fixed-layout/view-controller.js";
import { BookPaginationController } from "./controller.js";
import type {
  BookPaginationSnapshot,
  PaginationSnapshotListener,
  PublicationPaginationCapabilities,
} from "./index.js";

export abstract class PaginationBridgeRuntime extends FixedViewRuntime {
  paginationSnapshot(): BookPaginationSnapshot {
    this._assertOpen();
    if (this._paginationController === null) {
      throw new Error("the pagination controller is unavailable");
    }
    return this._paginationController.snapshot();
  }

  subscribePagination(listener: PaginationSnapshotListener): () => void {
    this._assertOpen();
    this._paginationListeners.add(listener);
    return () => this._paginationListeners.delete(listener);
  }

  setPaginationCapabilities(capabilities: PublicationPaginationCapabilities | undefined): void {
    this._assertOpen();
    this._foregroundPreparationPaths = null;
    this._evictAutomaticPreparation();
    this._disposePagination();
    if (capabilities?.signal.aborted === true) capabilities = undefined;
    const responses = capabilities?.responses;
    this._foregroundPreparationPaths =
      capabilities?.foregroundPreparation === undefined
        ? null
        : new Set(capabilities.foregroundPreparation.eligibleResourcePaths);
    const kernelSnapshot = this._kernel.snapshot();
    let controller: BookPaginationController;
    controller = new BookPaginationController({
      facts: this._publication.facts,
      documents: kernelSnapshot.readingOrder.map((occurrence) => occurrence.document),
      container: this._frameStack,
      preferences: kernelSnapshot.layout.preferences,
      createMeasurementRuntime:
        responses === undefined
          ? null
          : (container) =>
              this._createRuntime(
                {
                  session: {
                    id: this._session.id,
                    publication: { facts: this._publication.facts, mount: responses.mount },
                  },
                  container,
                  frameTitle: `${this._frameTitle} pagination measurement`,
                  presentationPreferences: this._kernel.snapshot().layout.preferences,
                  diagnostics: this._diagnostics ?? undefined,
                },
                "auxiliary",
              ),
      eligibleResourcePaths: responses?.eligibleResourcePaths,
      cache: capabilities?.cache,
      cacheIdentity: capabilities?.cacheIdentity,
      pacing: capabilities?.pacing,
      foregroundSnapshot: () => this._kernel.snapshot(),
      measureForegroundTocTargets: (targets, options) => this.measureTocTargets(targets, options),
      measurePreparedTocTargets: (
        occurrence,
        frameGeneration,
        layoutGeneration,
        pageCount,
        targets,
        options,
      ) =>
        this._measurePreparedTocTargets(
          occurrence,
          frameGeneration,
          layoutGeneration,
          pageCount,
          targets,
          options,
        ),
      preparationClaimsInvalidated: () => {
        queueMicrotask(() => {
          if (this._closed || this._paginationController !== controller) return;
          this._preparationClaims.clear();
          this._evictPreparedFramesFromKernel();
        });
      },
      basisRestarted: () => this._scheduleAdjacentPreparation(),
      diagnostics: this._diagnostics ?? undefined,
    });
    this._paginationController = controller;
    this._paginationUnsubscribe = this._paginationController.subscribe((snapshot) => {
      this._publishPagination(snapshot);
    });
    this._paginationController.updateForeground(this._kernel.snapshot());
    const snapshot = this._paginationController.snapshot();
    this._publishPagination(snapshot);
    this._scheduleAdjacentPreparation();
    if (capabilities !== undefined) {
      const signal = capabilities.signal;
      const abort = () => {
        if (this._closed || this._paginationCapabilitySignal !== signal) return;
        this.setPaginationCapabilities(undefined);
      };
      this._paginationCapabilitySignal = signal;
      this._paginationCapabilityAbortListener = abort;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
  }

  protected _disposePagination(): void {
    if (
      this._paginationCapabilitySignal !== null &&
      this._paginationCapabilityAbortListener !== null
    ) {
      this._paginationCapabilitySignal.removeEventListener(
        "abort",
        this._paginationCapabilityAbortListener,
      );
    }
    this._paginationCapabilitySignal = null;
    this._paginationCapabilityAbortListener = null;
    this._paginationUnsubscribe?.();
    this._paginationUnsubscribe = null;
    try {
      this._paginationController?.close();
    } catch {
      // Runtime teardown must preserve the caller's original close or terminal error.
    }
    this._paginationController = null;
    this._preparationClaims.clear();
  }

  protected _publishPagination(snapshot: BookPaginationSnapshot): void {
    for (const listener of this._paginationListeners) {
      try {
        listener(snapshot);
      } catch {
        // Pagination observers do not participate in runtime transitions.
      }
    }
  }
}
