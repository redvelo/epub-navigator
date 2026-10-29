import type { RefObject } from "react";
import type { NavigatorLocationSnapshot } from "../../generated/kernel.js";
import type { NavigatorRuntime } from "../../runtime/navigator/api.js";
import type {
  NavigatorReadingPositionCaptureOptions,
  NavigatorReadingPositionCaptureResult,
} from "../public-types.js";

export async function captureReadingPosition(
  runtime: RefObject<NavigatorRuntime | null>,
  options: NavigatorReadingPositionCaptureOptions = {},
): Promise<NavigatorReadingPositionCaptureResult> {
  if (options.signal?.aborted) return { status: "cancelled", reason: "abort" };
  const requestedRuntime = runtime.current;
  if (requestedRuntime === null) {
    return { status: "unavailable", reason: "runtime-unavailable" };
  }
  const deadline = performance.now() + 2_000;
  const retry = async (): Promise<boolean> => {
    if (performance.now() >= deadline) return false;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return (
      !options.signal?.aborted &&
      runtime.current === requestedRuntime &&
      performance.now() < deadline
    );
  };
  for (;;) {
    const capture = await requestedRuntime.captureCurrentLocation();
    if (options.signal?.aborted) return { status: "cancelled", reason: "abort" };
    if (runtime.current !== requestedRuntime) {
      return { status: "cancelled", reason: "replacement" };
    }
    if (capture.status !== "captured") {
      const transient =
        capture.status === "stale" ||
        capture.status === "unavailable" ||
        (capture.status === "cancelled" &&
          (capture.reason === "layout-invalidated" || capture.reason === "preference-changed"));
      if (transient && (await retry())) continue;
      if (capture.status === "cancelled") return capture;
      if (capture.status === "failed") return { status: "failed", message: capture.message };
      if (capture.status === "stale") return { status: "stale" };
      return { status: "unavailable", reason: "current-location-unavailable" };
    }
    let location: NavigatorLocationSnapshot;
    try {
      location = requestedRuntime.currentLocation();
    } catch {
      return { status: "unavailable", reason: "runtime-unavailable" };
    }
    if (location.location?.kind !== "point" || location.basis === null) {
      if (await retry()) continue;
      return { status: "unavailable", reason: "current-location-unavailable" };
    }
    let generated: Awaited<ReturnType<NavigatorRuntime["generateCurrentLocationAnnotationTarget"]>>;
    try {
      generated = await requestedRuntime.generateCurrentLocationAnnotationTarget(location.revision);
    } catch (cause) {
      if (options.signal?.aborted) return { status: "cancelled", reason: "abort" };
      if (runtime.current !== requestedRuntime) {
        return { status: "cancelled", reason: "replacement" };
      }
      return {
        status: "failed",
        message: cause instanceof Error ? cause.message : "reading position capture failed",
      };
    }
    if (options.signal?.aborted) return { status: "cancelled", reason: "abort" };
    if (runtime.current !== requestedRuntime) {
      return { status: "cancelled", reason: "replacement" };
    }
    if (generated.outcome === "failed") {
      if (
        generated.failure.code === "operation-cancelled" &&
        (generated.failure.reason === "layout-invalidated" ||
          generated.failure.reason === "preference-changed") &&
        (await retry())
      ) {
        continue;
      }
      return generated.failure.code === "operation-cancelled"
        ? { status: "cancelled", reason: generated.failure.reason }
        : { status: "failed", message: generated.failure.message };
    }
    if (generated.result.status === "stale" && (await retry())) continue;
    if (generated.result.status !== "generated") return generated.result;
    if (
      requestedRuntime.fixedRollProgression !== undefined &&
      requestedRuntime.currentLocation().revision !== location.revision
    ) {
      if (await retry()) continue;
      return { status: "stale" };
    }
    // A scrolled document without rendered text generates a whole-resource target, so the
    // captured point's observed scroll progression is the position that must survive.
    const rollProgression =
      requestedRuntime.fixedRollProgression?.() ??
      location.location.observation.layoutProgression ??
      undefined;
    return {
      status: "generated",
      targetJson: generated.result.targetJson,
      occurrenceHint: { occurrence: generated.occurrence, resource: generated.resource },
      ...(rollProgression === undefined || rollProgression === null ? {} : { rollProgression }),
    };
  }
}
