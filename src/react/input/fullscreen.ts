import { useState, useSyncExternalStore } from "react";
import type { NavigatorFullscreenController } from "../public-types.js";

export interface FullscreenController {
  readonly active: boolean;
  readonly available: boolean;
  readonly fillsViewport: boolean;
  readonly toggle: () => void;
}

export const noFullscreen: FullscreenController = {
  active: false,
  available: false,
  fillsViewport: false,
  toggle: () => {},
};

export function hostFullscreen(
  controller: NavigatorFullscreenController | null | undefined,
): FullscreenController | null {
  if (controller === undefined) return null;
  if (controller === null) return noFullscreen;
  return {
    active: controller.active,
    available: true,
    fillsViewport: false,
    toggle: controller.toggle,
  };
}

export function useReaderFullscreen(element: HTMLElement | null): FullscreenController {
  const [fallbackActive, setFallbackActive] = useState(false);
  const nativeActive = useSyncExternalStore(
    (onStoreChange) => subscribeFullscreen(element, onStoreChange),
    () =>
      element !== null &&
      fullscreenElement(element.ownerDocument as FullscreenDocument) === element,
  );

  return {
    active: nativeActive || fallbackActive,
    available: element !== null,
    fillsViewport: true,
    toggle: () => {
      if (element === null) return;
      const document = element.ownerDocument as FullscreenDocument;
      if (fallbackActive) {
        setFallbackActive(false);
        return;
      }
      if (fullscreenElement(document) === element) {
        const exit =
          document.exitFullscreen?.bind(document) ?? document.webkitExitFullscreen?.bind(document);
        if (exit !== undefined) void Promise.resolve(exit());
        return;
      }
      const request =
        element.requestFullscreen?.bind(element) ??
        (element as FullscreenElement).webkitRequestFullscreen?.bind(element);
      if (request === undefined || !fullscreenEnabled(document)) {
        setFallbackActive(true);
        return;
      }
      void Promise.resolve(request()).catch(() => setFallbackActive(true));
    },
  };
}

const fullscreenEvents = [
  "fullscreenchange",
  "fullscreenerror",
  "webkitfullscreenchange",
  "webkitfullscreenerror",
] as const;

function subscribeFullscreen(element: HTMLElement | null, onChange: () => void): () => void {
  const document = element?.ownerDocument;
  if (document === undefined) return () => {};
  for (const event of fullscreenEvents) document.addEventListener(event, onChange);
  return () => {
    for (const event of fullscreenEvents) document.removeEventListener(event, onChange);
  };
}

interface FullscreenDocument extends Document {
  readonly webkitFullscreenElement?: (Element | null) | undefined;
  readonly webkitFullscreenEnabled?: boolean | undefined;
  webkitExitFullscreen?: (() => void | Promise<void>) | undefined;
}

interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: (() => void | Promise<void>) | undefined;
}

function fullscreenElement(document: FullscreenDocument): Element | null {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

function fullscreenEnabled(document: FullscreenDocument): boolean {
  return document.fullscreenEnabled || document.webkitFullscreenEnabled === true;
}

export function useSystemColorPreference(): "light" | "dark" {
  return useSyncExternalStore(subscribeSystemColor, systemColorPreference);
}

function subscribeSystemColor(onChange: () => void): () => void {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (media === undefined) return () => {};
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function systemColorPreference(): "light" | "dark" {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
