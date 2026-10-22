import { LocatorOperationsRuntime } from "./locator-operations.js";
import {
  type NavigatorReadingPosition,
  type RestoreAnnotationTargetOptions,
  type RestoreAnnotationTargetResult,
} from "../navigator/api.js";
import { commandInput } from "../kernel.js";
import { currentDocument, occurrenceLoadableTarget } from "../kernel-view.js";

export abstract class ReadingPositionRestorerRuntime extends LocatorOperationsRuntime {
  async restoreAnnotationTarget(
    position: NavigatorReadingPosition,
    options: RestoreAnnotationTargetOptions = {},
  ): Promise<RestoreAnnotationTargetResult> {
    if (this._closed) return { status: "cancelled", reason: "close" };
    this._cancelRestore("superseded");
    const controller = new AbortController();
    this._restoreController = controller;
    let cancellation: Extract<RestoreAnnotationTargetResult, { status: "cancelled" }>["reason"] =
      "superseded";
    const cancel = (reason: typeof cancellation) => {
      cancellation = reason;
      controller.abort();
    };
    const signal = options.signal;
    const onAbort = () => cancel("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) return { status: "cancelled", reason: "abort" };
      if (
        typeof position !== "object" ||
        position === null ||
        typeof position.targetJson !== "string" ||
        position.targetJson.length === 0 ||
        position.targetJson.length > 1024 * 1024
      ) {
        return {
          status: "failed",
          reason: "invalid-position",
          message: "reading position is invalid",
        };
      }
      let plan;
      try {
        JSON.parse(position.targetJson);
        plan = this._kernel.projectAnnotationTarget(position.targetJson);
      } catch (cause) {
        return {
          status: "failed",
          reason: "invalid-position",
          message: cause instanceof Error ? cause.message : "annotation target is invalid",
        };
      }
      const hint = position.occurrenceHint;
      if (
        hint !== null &&
        (typeof hint !== "object" ||
          !Number.isSafeInteger(hint.occurrence) ||
          hint.occurrence < 0 ||
          typeof hint.resource !== "string" ||
          hint.resource !== plan.resource)
      ) {
        return {
          status: "failed",
          reason: "invalid-position",
          message: "occurrence hint is invalid",
        };
      }
      const readingOrder = this._kernel.snapshot().readingOrder;
      const occurrence =
        hint === null
          ? readingOrder.find(
              (candidate) => occurrenceLoadableTarget(candidate)?.resource === plan.resource,
            )?.ordinal
          : readingOrder.find(
              (candidate) =>
                candidate.ordinal === hint.occurrence &&
                occurrenceLoadableTarget(candidate)?.resource === hint.resource,
            )?.ordinal;
      if (occurrence === undefined) {
        return {
          status: "failed",
          reason: "invalid-position",
          message: "annotation target does not identify a loadable reading-order occurrence",
        };
      }
      const timeoutMs = options.timeoutMs ?? 10_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return {
          status: "failed",
          reason: "invalid-position",
          message: "timeoutMs must be positive",
        };
      }
      const deadline = performance.now() + timeoutMs;
      const waitForSettledLayout = async (): Promise<"settled" | "timeout" | "cancelled"> =>
        new Promise((resolve) => {
          let finished = false;
          let unsubscribe = () => {};
          const finish = (result: "settled" | "timeout" | "cancelled") => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            unsubscribe();
            controller.signal.removeEventListener("abort", aborted);
            resolve(result);
          };
          const check = () => {
            if (controller.signal.aborted) {
              aborted();
              return;
            }
            if (performance.now() >= deadline) {
              finish("timeout");
              return;
            }
            try {
              const snapshot = this._kernel.snapshot();
              const document = currentDocument(snapshot);
              if (
                snapshot.document.pending === null &&
                document?.frame.occurrence === occurrence &&
                document.frame.resource === plan.resource &&
                document.layout.state === "settled"
              ) {
                finish("settled");
              }
            } catch {
              cancellation = "close";
              finish("cancelled");
            }
          };
          const remaining = Math.max(0, deadline - performance.now());
          const timer = setTimeout(() => finish("timeout"), remaining);
          const aborted = () => {
            const reason = controller.signal.reason;
            if (reason === "replacement" || reason === "close" || reason === "superseded") {
              cancellation = reason;
            }
            finish("cancelled");
          };
          controller.signal.addEventListener("abort", aborted, { once: true });
          unsubscribe = this.subscribe(check);
          check();
        });
      const current = currentDocument(this._kernel.snapshot());
      if (
        current === null ||
        current.frame.occurrence !== occurrence ||
        current.frame.resource !== plan.resource ||
        this._kernel.snapshot().document.pending !== null
      ) {
        const transition = this._accepted(
          this._dispatchAndApply(commandInput({ type: "open-occurrence", occurrence })),
        );
        const generation = transition.events.find(
          (event) => event.type === "document-pending",
        )?.generation;
        if (generation === undefined) {
          return {
            status: "failed",
            reason: "unavailable",
            message: "occurrence did not begin loading",
          };
        }
        const settlement = await new Promise<"committed" | "failed" | "timeout" | "cancelled">(
          (resolve) => {
            let settled = false;
            const finish = (value: "committed" | "failed" | "timeout" | "cancelled") => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              unsubscribe();
              controller.signal.removeEventListener("abort", aborted);
              resolve(value);
            };
            const unsubscribe = this.subscribe((next) => {
              for (const event of next.events) {
                if (
                  event.type === "document-committed" &&
                  event.generation === generation &&
                  event.occurrence === occurrence &&
                  event.resource === plan.resource
                ) {
                  finish("committed");
                } else if (
                  (event.type === "document-cancelled" ||
                    event.type === "document-load-failed" ||
                    event.type === "document-invalidated") &&
                  event.generation === generation
                ) {
                  finish("failed");
                } else if (event.type === "document-pending" && event.generation !== generation) {
                  cancellation = "replacement";
                  finish("cancelled");
                } else if (event.type === "closed") {
                  cancellation = "close";
                  finish("cancelled");
                }
              }
            });
            const timer = setTimeout(
              () => finish("timeout"),
              Math.max(0, deadline - performance.now()),
            );
            const aborted = () => {
              const reason = controller.signal.reason;
              if (reason === "replacement" || reason === "close" || reason === "superseded") {
                cancellation = reason;
              }
              finish("cancelled");
            };
            controller.signal.addEventListener("abort", aborted, { once: true });
          },
        );
        if (settlement === "cancelled") return { status: "cancelled", reason: cancellation };
        if (settlement === "timeout") {
          return {
            status: "failed",
            reason: "timeout",
            message: "annotation restoration timed out",
          };
        }
        if (settlement === "failed") {
          return {
            status: "failed",
            reason: "unavailable",
            message: "occurrence failed to settle",
          };
        }
      }
      const layoutSettlement = await waitForSettledLayout();
      if (layoutSettlement === "cancelled") {
        return { status: "cancelled", reason: cancellation };
      }
      if (layoutSettlement === "timeout") {
        return {
          status: "failed",
          reason: "timeout",
          message: "annotation restoration timed out",
        };
      }
      if (controller.signal.aborted) return { status: "cancelled", reason: cancellation };
      if (
        plan.selectors.length === 1 &&
        plan.selectors[0]?.kind === "resource" &&
        plan.selectors[0].refinements.length === 0
      ) {
        return { status: "restored", occurrence, resource: plan.resource, relocation: null };
      }
      for (;;) {
        if (controller.signal.aborted) return { status: "cancelled", reason: cancellation };
        const relocation = await this._runAnnotationTargetOperation(
          "relocate-annotation-target",
          position.targetJson,
        );
        if (controller.signal.aborted) return { status: "cancelled", reason: cancellation };
        if (relocation.outcome === "failed") {
          if (
            relocation.failure.code === "operation-cancelled" &&
            (relocation.failure.reason === "layout-invalidated" ||
              relocation.failure.reason === "preference-changed")
          ) {
            const settlement = await waitForSettledLayout();
            if (settlement === "cancelled") {
              return { status: "cancelled", reason: cancellation };
            }
            if (settlement === "timeout") {
              return {
                status: "failed",
                reason: "timeout",
                message: "annotation restoration timed out",
              };
            }
            continue;
          }
          if (relocation.failure.code === "operation-cancelled") {
            return { status: "cancelled", reason: cancellation };
          }
          return {
            status: "failed",
            reason: "unavailable",
            message: relocation.failure.message,
          };
        }
        if (relocation.result.outcome === "stale") {
          const settlement = await waitForSettledLayout();
          if (settlement === "cancelled") {
            return { status: "cancelled", reason: cancellation };
          }
          if (settlement === "timeout") {
            return {
              status: "failed",
              reason: "timeout",
              message: "annotation restoration timed out",
            };
          }
          continue;
        }
        if (relocation.result.outcome !== "resolved") {
          return {
            status: "failed",
            reason: "unavailable",
            message: `annotation target relocation was ${relocation.result.outcome}`,
          };
        }
        return {
          status: "restored",
          occurrence,
          resource: plan.resource,
          relocation: relocation.result,
        };
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this._restoreController === controller) {
        this._restoreController = null;
      }
    }
  }

  protected _cancelRestore(reason: "superseded" | "replacement" | "close"): void {
    const controller = this._restoreController;
    if (controller === null) return;
    this._restoreController = null;
    controller.abort(reason);
  }
}
