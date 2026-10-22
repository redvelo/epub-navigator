// @vitest-environment jsdom

import { readerRegion, renderReader } from "./reader-harness.js";
import { act, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRecentNetworkActivity } from "../../src/react/status/network-activity.js";

describe("recent network activity", () => {
  it("expires from observation time, not polling time, and refreshes for new activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { result, rerender, unmount } = renderHook(
      ({ lastObservedAt }) =>
        useRecentNetworkActivity("book", { sessionId: "book", lastObservedAt }),
      { initialProps: { lastObservedAt: 90_000 } },
    );
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(19_999);
    });
    rerender({ lastObservedAt: 90_000 });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);

    rerender({ lastObservedAt: Date.now() });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    rerender({ lastObservedAt: Date.now() });
    act(() => {
      vi.advanceTimersByTime(29_999);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
    rerender({ lastObservedAt: Date.now() });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([70_000, 100_001, NaN, Infinity])(
    "ignores stale or invalid timestamp %s",
    (lastObservedAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const { result } = renderHook(() =>
        useRecentNetworkActivity("book", { sessionId: "book", lastObservedAt }),
      );
      expect(result.current).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("clears on session replacement and when the host removes the observation", () => {
    vi.useFakeTimers();
    const activity = { sessionId: "first", lastObservedAt: Date.now() };
    const { result, rerender } = renderHook(
      ({ sessionId, enabled }) => useRecentNetworkActivity(sessionId, enabled ? activity : null),
      { initialProps: { sessionId: "first", enabled: true } },
    );
    expect(result.current).toBe(true);
    rerender({ sessionId: "second", enabled: true });
    expect(result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    rerender({ sessionId: "first", enabled: false });
    expect(result.current).toBe(false);
  });

  it.each(["compact", "workspace"] as const)(
    "renders a passive status in %s chrome below loading priority",
    async (profile) => {
      const { runtime, session, rerender } = await renderReader({ profile });
      act(() => runtime.commit(0));
      vi.useFakeTimers();
      rerender({
        profile,
        networkActivity: { sessionId: session.id, lastObservedAt: Date.now() },
      });
      expect(screen.getByRole("status")).toHaveAccessibleName("Recent network activity");
      const reader = readerRegion();
      expect(reader).toHaveAttribute("data-reader-status", "network");
      act(() => runtime.interact("next"));
      expect(reader).toHaveAttribute("data-reader-status", "network");
      act(() => {
        vi.advanceTimersByTime(199);
      });
      expect(reader).toHaveAttribute("data-reader-status", "network");
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(reader).toHaveAttribute("data-reader-status", "loading");
      expect(screen.queryByTitle("Recent network activity")).not.toBeInTheDocument();
      act(() => runtime.commit(1));
      expect(reader).toHaveAttribute("data-reader-status", "network");
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(reader).toHaveAttribute("data-reader-status", "ready");
      expect(screen.queryByTitle("Recent network activity")).not.toBeInTheDocument();
    },
  );
});
