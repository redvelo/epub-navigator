// @vitest-environment jsdom

import {
  createNavigatorRuntime,
  FakeRuntime,
  publicationHost,
  readerPreferences,
  readerSession,
  renderReader,
} from "./reader-harness.js";
import { act, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  NavigatorReader,
  type NavigatorReaderHandle,
  type NavigatorReaderProps,
  type NavigatorReadingPosition,
} from "../../src/react/index.js";
import type { RestoreAnnotationTargetResult } from "../../src/runtime/navigator/api.js";

const readingPosition = (occurrence = 1): NavigatorReadingPosition => ({
  targetJson: JSON.stringify({ type: "Annotation", target: "chapter" }),
  occurrenceHint: { occurrence, resource: `EPUB/chapter-${occurrence + 1}.xhtml` },
});

const restored = (occurrence = 1): RestoreAnnotationTargetResult => ({
  status: "restored",
  occurrence,
  resource: `EPUB/chapter-${occurrence + 1}.xhtml`,
  relocation: null,
});

function pendingRestoration(runtime: FakeRuntime) {
  let resolve!: (result: RestoreAnnotationTargetResult) => void;
  runtime.restoreAnnotationTarget.mockImplementationOnce(
    () => new Promise((settle) => (resolve = settle)),
  );
  return (result: RestoreAnnotationTargetResult) => act(async () => resolve(result));
}

function renderRestoring(runtime: FakeRuntime, props: Partial<NavigatorReaderProps> = {}) {
  createNavigatorRuntime.mockResolvedValue(runtime);
  const session = readerSession();
  const view = render(
    <NavigatorReader session={session} initialReadingPosition={readingPosition()} {...props} />,
  );
  return {
    ...view,
    rerender: (next: Partial<NavigatorReaderProps>) =>
      view.rerender(<NavigatorReader session={session} {...next} />),
  };
}

describe("NavigatorReader runtime lifecycle and reading positions", () => {
  it("subscribes to locations before restoring directly without opening occurrence zero", async () => {
    const runtime = new FakeRuntime();
    const onInitialRestoration = vi.fn();
    runtime.restoreAnnotationTarget.mockImplementationOnce(async () => {
      expect(runtime.locations.listeners.size).toBe(1);
      return restored();
    });
    renderRestoring(runtime, { onInitialRestoration });

    await waitFor(() =>
      expect(onInitialRestoration).toHaveBeenCalledWith(
        expect.objectContaining({ status: "restored" }),
      ),
    );
    expect(runtime.restoreAnnotationTarget).toHaveBeenCalledWith(readingPosition());
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it("conceals publication content until initial position restoration completes", async () => {
    const runtime = new FakeRuntime();
    const complete = pendingRestoration(runtime);
    renderRestoring(runtime);

    await waitFor(() => expect(runtime.restoreAnnotationTarget).toHaveBeenCalledOnce());
    const host = publicationHost();
    expect(host).toHaveAttribute("data-initial-restoration", "pending");
    expect(host).toHaveAttribute("aria-hidden", "true");

    await complete(restored());

    expect(host).not.toHaveAttribute("data-initial-restoration");
    expect(host).not.toHaveAttribute("aria-hidden");
  });

  it("keeps publication content concealed until an initial-restoration fallback commits", async () => {
    const runtime = new FakeRuntime();
    runtime.restoreAnnotationTarget.mockResolvedValueOnce({
      status: "failed",
      reason: "unavailable",
      message: "position unavailable",
    });
    renderRestoring(runtime);

    await waitFor(() => expect(runtime.open).toHaveBeenCalledWith(0));
    const host = publicationHost();
    expect(host).toHaveAttribute("data-initial-restoration", "pending");

    act(() => runtime.commit(0));

    await waitFor(() => expect(host).not.toHaveAttribute("data-initial-restoration"));
  });

  it.each([
    { status: "failed" as const, reason: "unavailable" as const, message: "position unavailable" },
    { status: "cancelled" as const, reason: "replacement" as const },
  ])("reports a $status initial restoration and falls back to occurrence zero", async (result) => {
    const runtime = new FakeRuntime();
    const onInitialRestoration = vi.fn();
    runtime.restoreAnnotationTarget.mockResolvedValueOnce(result);
    renderRestoring(runtime, { onInitialRestoration });

    await waitFor(() => expect(runtime.open).toHaveBeenCalledWith(0));
    expect(onInitialRestoration).toHaveBeenCalledWith(result);
  });

  it("uses updated callbacks without restarting or implicitly navigating", async () => {
    const runtime = new FakeRuntime();
    const complete = pendingRestoration(runtime);
    const firstLocation = vi.fn();
    const nextLocation = vi.fn();
    const firstRestoration = vi.fn();
    const nextRestoration = vi.fn();
    const { rerender } = renderRestoring(runtime, {
      onLocationChange: firstLocation,
      onInitialRestoration: firstRestoration,
    });
    await waitFor(() => expect(runtime.restoreAnnotationTarget).toHaveBeenCalledOnce());

    rerender({
      initialReadingPosition: readingPosition(0),
      onLocationChange: nextLocation,
      onInitialRestoration: nextRestoration,
    });
    act(() => runtime.locate(1, 8));
    await complete(restored());

    expect(nextLocation).toHaveBeenCalledWith(runtime.locationValue);
    expect(firstLocation).not.toHaveBeenCalled();
    expect(nextRestoration).toHaveBeenCalledWith(expect.objectContaining({ status: "restored" }));
    expect(firstRestoration).not.toHaveBeenCalled();
    expect(runtime.restoreAnnotationTarget).toHaveBeenCalledOnce();
    expect(runtime.open).not.toHaveBeenCalled();
    expect(createNavigatorRuntime).toHaveBeenCalledOnce();
  });

  it("coalesces evidence-only location revisions before notifying the host", async () => {
    const onLocationChange = vi.fn();
    const { runtime } = await renderReader({ onLocationChange });

    act(() => runtime.locate(0, 1));
    const passive = runtime.locationValue;
    const point = passive.location;
    if (point?.kind !== "point") throw new Error("expected a point location");
    act(() =>
      runtime.emitLocation({
        ...passive,
        revision: 2,
        location: {
          ...point,
          evidence: [
            ...point.evidence,
            { kind: "rendered-text-context", before: "before", after: "after" },
          ],
          observation: { ...point.observation, layoutProgression: null },
        },
      }),
    );
    act(() => runtime.emitLocation({ ...passive, revision: 3 }));

    expect(onLocationChange).toHaveBeenCalledOnce();
    expect(runtime.currentLocation().revision).toBe(3);

    act(() =>
      runtime.emitLocation({
        ...passive,
        revision: 4,
        location: { ...point, observation: { ...point.observation, renderedTextProgression: 0.5 } },
      }),
    );
    expect(onLocationChange).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["directly", ["captured"]],
    ["after a transient stale capture", ["stale", "captured"]],
  ] as const)(
    "captures a durable reading position through the ref handle %s",
    async (_, captures) => {
      const runtime = new FakeRuntime();
      runtime.locate(1, 12);
      const { location, visibleOccurrences } = runtime.locationValue;
      const basis = {
        ...runtime.locationValue.basis!,
        localContentBasis: 1,
        localGeometryBasis: 1,
      };
      for (const status of captures) {
        runtime.captureCurrentLocation.mockResolvedValueOnce(
          status === "stale"
            ? { status, basis }
            : { status, location: location!, basis, visibleOccurrences: visibleOccurrences! },
        );
      }
      runtime.generateCurrentLocationAnnotationTarget.mockResolvedValueOnce({
        outcome: "completed",
        result: { status: "generated", targetJson: '{"target":"chapter-2"}' },
        operation: 9,
        generation: 2,
        occurrence: 1,
        resource: "EPUB/chapter-2.xhtml",
      });
      const ref = createRef<NavigatorReaderHandle>();
      await renderReader({ ref }, runtime);

      await expect(ref.current?.captureReadingPosition()).resolves.toEqual({
        status: "generated",
        targetJson: '{"target":"chapter-2"}',
        occurrenceHint: { occurrence: 1, resource: "EPUB/chapter-2.xhtml" },
      });
      expect(runtime.captureCurrentLocation).toHaveBeenCalledTimes(captures.length);
      expect(runtime.generateCurrentLocationAnnotationTarget).toHaveBeenCalledWith(12);
    },
  );

  it("restores the latest initial position only when a new publication runtime is created", async () => {
    const firstRuntime = new FakeRuntime();
    const secondRuntime = new FakeRuntime();
    firstRuntime.restoreAnnotationTarget.mockResolvedValue(restored(0));
    secondRuntime.restoreAnnotationTarget.mockResolvedValue(restored(1));
    createNavigatorRuntime.mockResolvedValueOnce(firstRuntime).mockResolvedValueOnce(secondRuntime);
    const session = readerSession();
    const { rerender } = render(
      <NavigatorReader session={session} initialReadingPosition={readingPosition(0)} />,
    );
    await waitFor(() =>
      expect(firstRuntime.restoreAnnotationTarget).toHaveBeenCalledWith(readingPosition(0)),
    );

    rerender(<NavigatorReader session={session} initialReadingPosition={readingPosition(1)} />);
    await act(() => Promise.resolve());
    expect(firstRuntime.restoreAnnotationTarget).toHaveBeenCalledOnce();

    rerender(
      <NavigatorReader
        session={{
          id: crypto.randomUUID(),
          publication: {
            facts: session.publication.facts,
            mount: { ...session.publication.mount, contentOrigin: "isolated-publication-origin" },
          },
        }}
        initialReadingPosition={readingPosition(1)}
      />,
    );
    await waitFor(() =>
      expect(secondRuntime.restoreAnnotationTarget).toHaveBeenCalledWith(readingPosition(1)),
    );
    expect(firstRuntime.close).toHaveBeenCalledOnce();
  });

  it("returns unavailable while absent or closed and suppresses late restoration publication", async () => {
    const runtime = new FakeRuntime();
    let resolveRuntime!: (runtime: FakeRuntime) => void;
    createNavigatorRuntime.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRuntime = resolve)),
    );
    const ref = createRef<NavigatorReaderHandle>();
    const onInitialRestoration = vi.fn();
    const { unmount } = render(
      <NavigatorReader
        ref={ref}
        session={readerSession()}
        initialReadingPosition={readingPosition()}
        onInitialRestoration={onInitialRestoration}
      />,
    );
    const handle = ref.current;
    const unavailable = { status: "unavailable", reason: "runtime-unavailable" };
    await expect(handle?.captureReadingPosition()).resolves.toEqual(unavailable);

    unmount();
    await act(async () => resolveRuntime(runtime));
    await expect(handle?.captureReadingPosition()).resolves.toEqual(unavailable);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(runtime.restoreAnnotationTarget).not.toHaveBeenCalled();
    expect(runtime.open).not.toHaveBeenCalled();
    expect(onInitialRestoration).not.toHaveBeenCalled();
  });

  it("unsubscribes locations and suppresses a late in-flight restoration result on cleanup", async () => {
    const runtime = new FakeRuntime();
    const complete = pendingRestoration(runtime);
    const onLocationChange = vi.fn();
    const onInitialRestoration = vi.fn();
    const { unmount } = renderRestoring(runtime, { onLocationChange, onInitialRestoration });
    await waitFor(() => expect(runtime.restoreAnnotationTarget).toHaveBeenCalledOnce());

    unmount();
    act(() => runtime.locate(1, 9));
    await complete({ status: "cancelled", reason: "close" });

    expect(runtime.locations.listeners.size).toBe(0);
    expect(onLocationChange).not.toHaveBeenCalled();
    expect(onInitialRestoration).not.toHaveBeenCalled();
    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("closes a runtime created after its host session was replaced", async () => {
    const staleRuntime = new FakeRuntime();
    const currentRuntime = new FakeRuntime();
    let resolveStale!: (runtime: FakeRuntime) => void;
    createNavigatorRuntime
      .mockImplementationOnce(() => new Promise((resolve) => (resolveStale = resolve)))
      .mockResolvedValueOnce(currentRuntime);
    const { rerender } = render(<NavigatorReader session={readerSession()} />);

    rerender(<NavigatorReader session={readerSession()} />);
    await waitFor(() => expect(currentRuntime.open).toHaveBeenCalledWith(0));
    await act(async () => resolveStale(staleRuntime));

    expect(staleRuntime.close).toHaveBeenCalledOnce();
    expect(staleRuntime.open).not.toHaveBeenCalled();
    expect(currentRuntime.close).not.toHaveBeenCalled();
  });

  it("fails fast when controlledness changes within a host session", async () => {
    const { rerender } = await renderReader();

    expect(() => rerender({ preferences: readerPreferences() })).toThrow(
      /must not switch controlledness/u,
    );
  });
});
