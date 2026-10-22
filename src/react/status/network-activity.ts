import { useSyncExternalStore } from "react";
import type { NavigatorReaderProps } from "../public-types.js";

const RECENT_ACTIVITY_WINDOW_MS = 30_000;

export function useRecentNetworkActivity(
  sessionId: NavigatorReaderProps["session"]["id"],
  activity: NavigatorReaderProps["networkActivity"],
): boolean {
  const observedAt = activity?.sessionId === sessionId ? activity.lastObservedAt : null;
  const from = observedAt !== null && Number.isFinite(observedAt) ? observedAt : null;
  const to = from === null ? null : from + RECENT_ACTIVITY_WINDOW_MS;

  const subscribe = (onExpiry: () => void) => {
    if (from === null || to === null) return () => {};
    const now = Date.now();
    if (now < from || now >= to) return () => {};
    const timer = setTimeout(onExpiry, to - now);
    return () => clearTimeout(timer);
  };

  return useSyncExternalStore(subscribe, () => {
    if (from === null || to === null) return false;
    const now = Date.now();
    return now >= from && now < to;
  });
}
