import { describe, expect, it, vi } from "vitest";
import { AnnotationCoordinatorRuntime } from "../src/runtime/annotations/annotation-coordinator.js";

const identity = { operation: 0, generation: 17, occurrence: 4, resource: "EPUB/page.xhtml" };
const stale = { ...identity, outcome: "completed", result: { status: "stale" } };

function generate(capture: unknown, pending: object | null = null) {
  const captureCurrentLocation = vi.fn(async () => capture);
  const runtime = {
    _assertOpen: vi.fn(),
    _locationSnapshot: {
      revision: 7,
      location: { kind: "point", occurrence: 4, resource: "EPUB/page.xhtml" },
      basis: { documentGeneration: 17, frameGeneration: 18, layoutGeneration: 19 },
    },
    _kernel: { snapshot: () => ({ document: { pending } }) },
    captureCurrentLocation,
  } as unknown as AnnotationCoordinatorRuntime;
  return {
    captureCurrentLocation,
    result: AnnotationCoordinatorRuntime.prototype.generateCurrentLocationAnnotationTarget.call(
      runtime,
      7,
    ),
  };
}

describe("current-location annotation target generation", () => {
  it.each(["layout-invalidated", "preference-changed", "replacement", "close"] as const)(
    "preserves %s as a structured point-generation cancellation",
    async (reason) => {
      await expect(generate({ status: "cancelled", reason }).result).resolves.toEqual({
        ...identity,
        outcome: "failed",
        failure: { code: "operation-cancelled", reason },
      });
    },
  );

  it("reports a stale point generation while a replacement is pending", async () => {
    const { result, captureCurrentLocation } = generate(null, { generation: 21 });
    await expect(result).resolves.toEqual(stale);
    expect(captureCurrentLocation).not.toHaveBeenCalled();
  });

  it("reports a stale point generation when the second capture is no longer available", async () => {
    for (const status of ["stale", "unavailable"]) {
      await expect(generate({ status, basis: null }).result).resolves.toEqual(stale);
    }
  });
});
