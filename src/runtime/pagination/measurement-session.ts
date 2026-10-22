import type { KernelTransition } from "../../generated/kernel.js";
import type { PaginationMeasurementRuntime } from "./contracts.js";
import { viewColumns } from "../agent-protocol/index.js";

import {
  currentDocument,
  currentFixedSettlement,
  currentFrame,
  currentPaginatedLayout,
  currentReflowSettlement,
  foregroundLayoutPending,
  pendingDocumentFrame,
} from "../kernel-view.js";
import { fixedAdapterUnavailableReason, layoutSettlementIsDurable } from "./classification.js";
import { CachePaginationController } from "./cache/repository.js";
import type { BackgroundTargetOwner } from "./background-measurement.js";

export abstract class MeasurementSessionPaginationController extends CachePaginationController {
  async _measurementRuntime(): Promise<PaginationMeasurementRuntime> {
    if (this._runtime !== null) return this._runtime;
    if (this._runtimePromise !== null) return this._runtimePromise;
    const factory = this._createMeasurementRuntime;
    if (factory === null) throw new Error("background pagination responses are unavailable");
    const auxiliary = this._auxiliaryContainer();
    const sessionToken = ++this._sessionToken;
    const promise = Promise.resolve()
      .then(() => factory(auxiliary))
      .then((runtime) => {
        let unsubscribe: (() => void) | null = null;
        let errorUnsubscribe: (() => void) | null = null;
        try {
          if (this._closed || sessionToken !== this._sessionToken) {
            throw new Error("the pagination measurement session was superseded");
          }
          runtime.setPresentationPreferences(this._preferences);
          unsubscribe = runtime.subscribe((transition) =>
            this._measurementTransition(runtime, transition),
          );
          errorUnsubscribe = runtime.subscribeErrors((error) => {
            if (this._runtime !== runtime || sessionToken !== this._sessionToken) return;
            const occurrence = this._activeOccurrence;
            const task = this._activeTask;
            this._teardownMeasurementRuntime();
            if (occurrence !== null && task === "page-count") {
              this._retryPageCount(occurrence, error);
            } else if (occurrence !== null && task === "toc") {
              this._setTargetFailure(occurrence, error);
            }
          });
          if (this._closed || sessionToken !== this._sessionToken) {
            throw new Error("the pagination measurement session was superseded");
          }
          this._runtime = runtime;
          this._runtimeUnsubscribe = unsubscribe;
          this._runtimeErrorUnsubscribe = errorUnsubscribe;
          return runtime;
        } catch (cause) {
          try {
            unsubscribe?.();
          } catch {
            // Continue rolling back the remaining construction ownership.
          }
          try {
            errorUnsubscribe?.();
          } catch {
            // Continue rolling back the remaining construction ownership.
          }
          try {
            runtime.close();
          } catch {
            // Construction rollback is best-effort after ownership has been withheld.
          }
          throw cause;
        }
      })
      .catch((cause: unknown) => {
        if (this._runtimePromise === promise) {
          this._runtimePromise = null;
          if (sessionToken === this._sessionToken) this._removeAuxiliaryContainer();
        }
        throw cause;
      });
    this._runtimePromise = promise;
    return promise;
  }

  _measurementTransition(
    runtime: PaginationMeasurementRuntime,
    transition: KernelTransition,
  ): void {
    if (this._closed || this._activeOccurrence === null) return;
    const revision = this._runRevision;
    const taskToken = this._taskToken;
    const occurrence = this._activeOccurrence;
    const activeTask = this._activeTask;
    if (activeTask === null) return;
    const pendingEvent = transition.events.find((event) => event.type === "document-pending");
    if (pendingEvent?.type === "document-pending" && pendingEvent.occurrence === occurrence) {
      this._activeDocumentGeneration = pendingEvent.generation;
    }
    const snapshot = runtime.snapshot();
    const pendingFrame =
      snapshot.document.pending === null ? null : pendingDocumentFrame(snapshot.document.pending);
    const committedFrame = currentFrame(snapshot);
    const ownedDocument =
      pendingFrame?.occurrence === occurrence
        ? snapshot.document.pending
        : committedFrame?.occurrence === occurrence
          ? snapshot.document.committed
          : null;
    if (ownedDocument !== null) this._activeDocumentGeneration = ownedDocument.generation;
    const terminalFailure = transition.events.find(
      (event) =>
        (event.type === "document-load-failed" ||
          event.type === "document-invalidated" ||
          event.type === "layout-operation-failed") &&
        event.generation === this._activeDocumentGeneration,
    );
    if (terminalFailure !== undefined) {
      if (activeTask === "page-count") {
        this._retryPageCount(occurrence, new Error("auxiliary layout unavailable"));
      } else {
        this._setTargetFailure(occurrence, new Error("auxiliary layout unavailable"));
      }
      return;
    }
    const committed = currentDocument(snapshot);
    const frame = currentFrame(snapshot);
    const layout = committed?.layout.layout;
    if (
      committed === null ||
      frame?.occurrence !== occurrence ||
      layout === undefined ||
      layout.documentGeneration !== committed.generation
    ) {
      return;
    }
    const fixedSettlement = currentFixedSettlement(snapshot);
    const settlement = currentReflowSettlement(snapshot);
    if (settlement === null && fixedSettlement === null) {
      if (activeTask === "page-count") {
        this._setUnavailable(occurrence, fixedAdapterUnavailableReason(frame.adapter));
      } else {
        this._setTargetFailure(occurrence, new Error("document adapter cannot be paginated"));
      }
      return;
    }
    if (settlement !== null && settlement.mode !== "paginated") {
      if (activeTask === "page-count") {
        this._setInapplicable(occurrence, "effective-presentation-not-paginated");
      } else {
        this._setTargetFailure(occurrence, new Error("effective presentation is not paginated"));
      }
      return;
    }
    if (settlement !== null && settlement.pages.layoutRepairs.status === "unresolved") {
      if (activeTask === "page-count") {
        this._setUnavailable(occurrence, "unresolved-text-pagination");
      } else {
        this._setTargetFailure(occurrence, new Error("text pagination is unresolved"));
      }
      return;
    }
    const documentGeneration = committed.generation;
    const layoutGeneration = layout.layoutGeneration;
    const pageCount = fixedSettlement === null ? settlement?.pages.pageCount : 1;
    if (pageCount === undefined) return;
    const columnsPerView =
      fixedSettlement === null && settlement !== null
        ? viewColumns(settlement.pages.columnsPerView)
        : 1;
    if (this._targetMeasurementTaskToken === taskToken) return;
    if (this._closed || revision !== this._runRevision) return;
    const stable = runtime.snapshot();
    if (
      taskToken !== this._taskToken ||
      this._foregroundBusy ||
      this._activeOccurrence !== occurrence ||
      currentDocument(stable)?.generation !== documentGeneration ||
      currentDocument(stable)?.layout.layout.layoutGeneration !== layoutGeneration ||
      foregroundLayoutPending(stable)
    ) {
      this._requeue(occurrence);
      return;
    }
    if (activeTask === "page-count") {
      this._setBackgroundMeasuredAndContinueTargets(
        runtime,
        occurrence,
        frame.resource,
        pageCount,
        columnsPerView,
        revision,
        taskToken,
        documentGeneration,
        layoutGeneration,
        currentFixedSettlement(stable) !== null ||
          layoutSettlementIsDurable(currentReflowSettlement(stable)),
      );
      return;
    }
    const measuredEntry = this._entries.get(occurrence);
    if (measuredEntry?.state !== "measured" || measuredEntry.pageCount !== pageCount) {
      this._requeuePageCount(occurrence, "unstable");
      return;
    }
    this._targetMeasurementTaskToken = taskToken;
    const owner: BackgroundTargetOwner = Object.freeze({
      channel: "background",
      occurrence,
      runRevision: revision,
      taskGeneration: taskToken,
      documentGeneration,
      layoutGeneration,
      pageCount,
    });
    void this._measureTargets(runtime, owner)
      .then((result) => {
        if (
          result === null ||
          result.owner !== owner ||
          this._closed ||
          revision !== this._runRevision ||
          taskToken !== this._taskToken ||
          this._foregroundBusy ||
          this._activeOccurrence !== occurrence ||
          this._activeTask !== "toc"
        ) {
          return;
        }
        const current = runtime.snapshot();
        if (
          currentDocument(current)?.generation !== documentGeneration ||
          currentDocument(current)?.layout.layout.layoutGeneration !== layoutGeneration ||
          foregroundLayoutPending(current) ||
          currentPaginatedLayout(current)?.layoutRepairs.status === "unresolved" ||
          (currentFixedSettlement(current) === null &&
            currentPaginatedLayout(current)?.pageCount !== pageCount)
        ) {
          this._requeuePageCount(occurrence, "unstable");
          return;
        }
        this._setTargets(occurrence, result.results);
      })
      .finally(() => {
        if (this._targetMeasurementTaskToken === taskToken) {
          this._targetMeasurementTaskToken = null;
        }
      });
  }

  _auxiliaryContainer(): HTMLElement {
    const existing = this._container.querySelector<HTMLElement>("[data-epub-pagination-session]");
    if (existing !== null) return existing;
    const container = this._container.ownerDocument.createElement("div");
    container.dataset.epubPaginationSession = "";
    container.inert = true;
    container.setAttribute("aria-hidden", "true");
    container.style.position = "absolute";
    container.style.inset = "0";
    container.style.visibility = "hidden";
    container.style.pointerEvents = "none";
    container.style.overflow = "hidden";
    this._container.append(container);
    this._record({
      type: "auxiliary",
      action: "create",
      sessions: 1,
      frames: container.querySelectorAll("iframe").length,
      sessionGeneration: this._sessionToken + 1,
    });
    return container;
  }

  _removeAuxiliaryContainer(): void {
    const auxiliary = this._container.querySelector("[data-epub-pagination-session]");
    if (auxiliary === null) return;
    const frames = auxiliary.querySelectorAll("iframe").length;
    auxiliary.remove();
    this._record({
      type: "auxiliary",
      action: "remove",
      sessions: 0,
      frames,
      sessionGeneration: this._sessionToken,
    });
  }

  _teardownMeasurementRuntime(): void {
    this._targetMeasurementController?.abort();
    this._targetMeasurementController = null;
    this._sessionToken += 1;
    this._targetMeasurementTaskToken = null;
    this._activeDocumentGeneration = null;
    const unsubscribe = this._runtimeUnsubscribe;
    this._runtimeUnsubscribe = null;
    const errorUnsubscribe = this._runtimeErrorUnsubscribe;
    this._runtimeErrorUnsubscribe = null;
    const runtime = this._runtime;
    this._runtime = null;
    this._runtimePromise = null;
    try {
      unsubscribe?.();
    } catch {
      // Teardown continues so one failed hook cannot retain other owned resources.
    }
    try {
      errorUnsubscribe?.();
    } catch {
      // Teardown continues so one failed hook cannot retain other owned resources.
    }
    try {
      runtime?.close();
    } catch {
      // Teardown is best-effort; lifecycle ownership was already revoked.
    }
    this._removeAuxiliaryContainer();
  }
}
