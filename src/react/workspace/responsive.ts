import { useEffect, useState } from "react";

export function useContainerWidth(reader: React.RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = reader.current;
    if (element === null) return;
    const update = () => setWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [reader]);
  return width;
}

const coarsePointer = "(pointer: coarse)";

function touchPrimary(): boolean {
  return window.matchMedia?.(coarsePointer).matches ?? false;
}

export function useCompactReader(): boolean {
  const [compact, setCompact] = useState(touchPrimary);

  useEffect(() => {
    const media = window.matchMedia?.(coarsePointer);
    if (media === undefined) return;
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return compact;
}

const anyCoarsePointer = "(any-pointer: coarse)";

function touchAvailable(): boolean {
  return window.matchMedia?.(anyCoarsePointer).matches ?? false;
}

/** Whether any attached pointer is coarse, which is what makes a touch preference worth offering. */
export function useTouchAvailable(): boolean {
  const [available, setAvailable] = useState(touchAvailable);

  useEffect(() => {
    const media = window.matchMedia?.(anyCoarsePointer);
    if (media === undefined) return;
    const update = () => setAvailable(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return available;
}

const anyHover = "(any-hover: hover)";

function hoverAvailable(): boolean {
  return window.matchMedia?.(anyHover).matches ?? false;
}

/**
 * Whether any attached input can hover, which is a mouse or a trackpad rather than a finger. A
 * pointing device of that kind arrives with a keyboard, so this is the signal that a key or
 * click preference is worth offering. Pointer precision is not: an e-ink Android reader with no
 * mouse and no keyboard still answers `any-pointer: fine` yes, and hover no.
 */
export function useHoverAvailable(): boolean {
  const [available, setAvailable] = useState(hoverAvailable);

  useEffect(() => {
    const media = window.matchMedia?.(anyHover);
    if (media === undefined) return;
    const update = () => setAvailable(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return available;
}
