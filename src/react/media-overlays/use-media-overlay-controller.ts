import { useStore } from "jotai";
import { useEffect, useRef, useLayoutEffect } from "react";
import type { PublicationMount, ReadingOrderOccurrence } from "../../generated/kernel.js";
import type { PublicationMediaOverlayCapabilities } from "../../runtime/media-overlays/capabilities.js";
import {
  createNavigatorMediaOverlayController,
  type NavigatorMediaOverlayRate,
  type NavigatorMediaOverlaySnapshot,
} from "../../runtime/media-overlays/controller.js";
import type { RefObject } from "react";
import type { NavigatorRuntime } from "../../runtime/navigator/api.js";
import { usePublishedToStore } from "../lib/publish.js";
import {
  mediaOverlayAvailableAtom,
  mediaOverlayControllerAtom,
  mediaOverlaySnapshotAtom,
  clearMediaOverlayControllerAtom,
} from "./state.js";

export function useMediaOverlayController({
  runtime,
  runtimeReady,
  sessionId,
  mount,
  capabilities,
  readingOrder,
  rate,
  skippedTypes,
}: {
  readonly runtime: RefObject<NavigatorRuntime | null>;
  readonly runtimeReady: boolean;
  readonly sessionId: string;
  readonly mount: PublicationMount;
  readonly capabilities: PublicationMediaOverlayCapabilities | undefined;
  readonly readingOrder: readonly ReadingOrderOccurrence[] | undefined;
  readonly rate: NavigatorMediaOverlayRate;
  readonly skippedTypes: readonly string[];
}): void {
  const store = useStore();
  const preferences = useRef({ rate, skippedTypes });
  useLayoutEffect(() => {
    preferences.current = { rate, skippedTypes };
  });

  // The controller reads the latest preferences once at creation; later changes are applied below.
  useEffect(() => {
    const current = runtime.current;
    if (
      !runtimeReady ||
      current === null ||
      capabilities === undefined ||
      readingOrder === undefined
    ) {
      store.set(clearMediaOverlayControllerAtom);
      return;
    }
    const created = createNavigatorMediaOverlayController({
      runtime: current,
      capabilities,
      mount,
      readingOrder,
      rate: preferences.current.rate,
      skippedTypes: preferences.current.skippedTypes,
    });
    store.set(mediaOverlayControllerAtom, created);
    const unsubscribe = created.subscribe((next) => store.set(mediaOverlaySnapshotAtom, next));
    return () => {
      unsubscribe();
      if (store.get(mediaOverlayControllerAtom) === created) {
        store.set(clearMediaOverlayControllerAtom);
      }
      created.close();
    };
  }, [runtimeReady, sessionId, mount, capabilities, readingOrder, runtime, store]);

  useEffect(() => {
    store.get(mediaOverlayControllerAtom)?.setRate(rate);
  }, [rate, store]);

  useEffect(() => {
    store.get(mediaOverlayControllerAtom)?.setSkippedTypes(skippedTypes);
  }, [skippedTypes, store]);

  const available = runtimeReady && capabilities !== undefined && readingOrder !== undefined;
  usePublishedToStore(() => store.set(mediaOverlayAvailableAtom, available));
}

export function narrationControlsVisible(snapshot: NavigatorMediaOverlaySnapshot | null): boolean {
  if (snapshot === null || snapshot.state === "unavailable") return false;
  return (
    snapshot.playableHere ||
    snapshot.state === "playing" ||
    snapshot.state === "paused" ||
    snapshot.state === "loading"
  );
}
