import { useStore } from "jotai";
import { useEffect, type RefObject } from "react";
import { navigationIntentAtom } from "../navigation/state.js";
import { focusVisiblePrimaryPublicationFrame } from "./focus.js";

interface PublicationFocusRestorationOptions {
  readonly readerRoot: RefObject<HTMLElement | null>;
  readonly frameHost: RefObject<HTMLElement | null>;
  readonly hasCommittedDocument: boolean;
  readonly compactSurfaceOpen: boolean;
  readonly workspaceSurfaceOpen: boolean;
  readonly navigationOverlayOpen: boolean;
  readonly annotationsOverlayOpen: boolean;
  readonly noteEditorOpen: boolean;
}

export function usePublicationFocusRestoration({
  readerRoot,
  frameHost,
  hasCommittedDocument,
  compactSurfaceOpen,
  workspaceSurfaceOpen,
  navigationOverlayOpen,
  annotationsOverlayOpen,
  noteEditorOpen,
}: PublicationFocusRestorationOptions): void {
  const store = useStore();
  useEffect(() => {
    const root = readerRoot.current;
    const container = frameHost.current;
    const document = root?.ownerDocument;
    const view = document?.defaultView;
    if (
      root === null ||
      container === null ||
      document === undefined ||
      view === null ||
      view === undefined
    )
      return;

    let pendingUserFocus: { readonly target: EventTarget | null; readonly expires: number } | null =
      null;
    const markPointerFocus = (event: PointerEvent) => {
      pendingUserFocus = { target: event.target, expires: performance.now() + 700 };
    };
    const markKeyboardFocus = (event: KeyboardEvent) => {
      if (event.key === "Tab")
        pendingUserFocus = { target: null, expires: performance.now() + 700 };
    };
    const restoreUnownedFocus = () => {
      if (
        compactSurfaceOpen ||
        workspaceSurfaceOpen ||
        navigationOverlayOpen ||
        annotationsOverlayOpen ||
        noteEditorOpen ||
        !hasCommittedDocument ||
        document.visibilityState === "hidden"
      )
        return;
      const active = document.activeElement;
      if (
        active === null ||
        active === document.body ||
        active === document.documentElement ||
        active === root ||
        active === container
      ) {
        focusVisiblePrimaryPublicationFrame(container);
      }
    };
    const restoreVisibleFocus = () => {
      if (document.visibilityState === "visible") restoreUnownedFocus();
    };
    const restorationFrame = view.requestAnimationFrame(restoreUnownedFocus);
    const cancelDelayedPublicationFocus = (event: FocusEvent) => {
      const userFocus = pendingUserFocus;
      pendingUserFocus = null;
      const intent = store.get(navigationIntentAtom);
      const target = event.target;
      if (
        userFocus === null ||
        performance.now() > userFocus.expires ||
        (userFocus.target instanceof Element && userFocus.target !== target) ||
        intent === null ||
        !intent.focusAfterCompletion ||
        !(target instanceof Element) ||
        target === document.body ||
        target === document.documentElement ||
        target === root ||
        target === container ||
        container.contains(target)
      )
        return;
      store.set(navigationIntentAtom, { ...intent, focusCancelled: true });
    };

    view.addEventListener("focus", restoreUnownedFocus);
    view.addEventListener("resize", restoreUnownedFocus, { passive: true });
    view.visualViewport?.addEventListener("resize", restoreUnownedFocus, { passive: true });
    document.addEventListener("fullscreenchange", restoreUnownedFocus);
    document.addEventListener("visibilitychange", restoreVisibleFocus);
    document.addEventListener("focusin", cancelDelayedPublicationFocus);
    root.addEventListener("pointerdown", markPointerFocus, true);
    root.addEventListener("keydown", markKeyboardFocus, true);
    return () => {
      view.cancelAnimationFrame(restorationFrame);
      view.removeEventListener("focus", restoreUnownedFocus);
      view.removeEventListener("resize", restoreUnownedFocus);
      view.visualViewport?.removeEventListener("resize", restoreUnownedFocus);
      document.removeEventListener("fullscreenchange", restoreUnownedFocus);
      document.removeEventListener("visibilitychange", restoreVisibleFocus);
      document.removeEventListener("focusin", cancelDelayedPublicationFocus);
      root.removeEventListener("pointerdown", markPointerFocus, true);
      root.removeEventListener("keydown", markKeyboardFocus, true);
    };
  }, [
    annotationsOverlayOpen,
    compactSurfaceOpen,
    frameHost,
    hasCommittedDocument,
    navigationOverlayOpen,
    noteEditorOpen,
    readerRoot,
    store,
    workspaceSurfaceOpen,
  ]);
}
