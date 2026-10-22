import { useLayoutEffect } from "react";

export function cornerClearance(
  radius: number,
  centerX: number,
  centerY: number,
  edgeY: number,
  edgeX: number,
  upper: boolean,
  left: boolean,
): number {
  const distance = upper ? centerY - edgeY : edgeY - centerY;
  if (radius <= 0 || distance <= 0) return 0;
  const arc = Math.sqrt(Math.max(0, radius * radius - distance * distance));
  return Math.ceil(Math.max(0, left ? centerX - arc - edgeX : edgeX - centerX - arc));
}

const surfaces = [
  [".epub-navigator-reader__compact-top-rail", true],
  [".epub-navigator-reader__compact-bottom-rail", false],
  [".epub-navigator-reader__compact-sheet > * > header", true],
  [".epub-navigator-reader__compact-sheet .epub-navigator-reader__page-footer", false],
  [".epub-navigator-reader__note-sheet .epub-navigator-reader__note-editor-footer", false],
  ['.epub-navigator-reader__compact-sheet [aria-label="Reader panels"]', false],
  ['.epub-navigator-reader__compact-sheet [aria-label="Navigation lists"]', false],
] as const;

export function useCornerClearance(root: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (root === null) return;
    const view = root.ownerDocument.defaultView!;
    if (typeof view.ResizeObserver === "undefined") return;
    let textMetrics: CanvasRenderingContext2D | null = null;
    const updated = new Map<HTMLElement, Set<string>>();
    let frame: number | null = null;
    const schedule = () => {
      if (frame === null) frame = view.requestAnimationFrame(update);
    };
    const resize = new view.ResizeObserver(schedule);
    const observed = new Set<Element>();
    const update = () => {
      frame = null;
      const style = view.getComputedStyle(root);
      const cutoutBound = (side: string) =>
        Number.parseFloat(style.getPropertyValue(`--reader-host-cutout-bounds-${side}`));
      const cutout = {
        left: cutoutBound("left"),
        top: cutoutBound("top"),
        right: cutoutBound("right"),
        bottom: cutoutBound("bottom"),
      };
      const rootBox = root.getBoundingClientRect();
      const topCutout =
        Number.parseFloat(style.getPropertyValue("--reader-host-cutout-top")) > 0 &&
        cutout.left > rootBox.left &&
        cutout.right < rootBox.right &&
        cutout.right > cutout.left;
      root.toggleAttribute("data-top-cutout", topCutout);
      const travelling = [...root.querySelectorAll('[data-slot="drawer-popup"]')].some((popup) => {
        const matrix = new view.DOMMatrixReadOnly(view.getComputedStyle(popup).transform);
        return Math.abs(matrix.m41) > 0.5 || Math.abs(matrix.m42) > 0.5;
      });
      if (travelling) {
        schedule();
        return;
      }
      const configured =
        Number.isFinite(cutout.left) ||
        ["top-left", "top-right", "bottom-left", "bottom-right"].some(
          (corner) => style.getPropertyValue(`--reader-host-corner-${corner}-radius`).trim() !== "",
        );
      if (!configured) {
        root.style.removeProperty("--reader-shared-rail-left");
        root.style.removeProperty("--reader-shared-rail-right");
        for (const [element, properties] of updated)
          for (const property of properties) element.style.removeProperty(property);
        updated.clear();
        for (const element of observed) resize.unobserve(element);
        observed.clear();
        return;
      }
      textMetrics ??= root.ownerDocument.createElement("canvas").getContext("2d")!;
      const current = new Set<Element>();
      for (const [selector, upper] of surfaces) {
        for (const element of root.querySelectorAll<HTMLElement>(selector)) {
          current.add(element);
          if (!observed.has(element)) resize.observe(element);
          const setProperty = (property: string, value: string) => {
            if (element.style.getPropertyValue(property) !== value)
              element.style.setProperty(property, value);
            const properties = updated.get(element) ?? new Set<string>();
            properties.add(property);
            updated.set(element, properties);
          };
          if (selector === ".epub-navigator-reader__compact-top-rail" && topCutout) {
            setProperty("--reader-top-cutout-start", `${cutout.left - rootBox.left}px`);
            setProperty("--reader-top-cutout-width", `${cutout.right - cutout.left}px`);
          }
          const rects: DOMRect[] = [];
          const walker = root.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const parent = node.parentElement!;
            const decorative = parent.closest('.sr-only, svg, [aria-hidden="true"]');
            if (
              !node.textContent?.trim() ||
              (decorative !== null && decorative !== element && element.contains(decorative))
            ) {
              continue;
            }
            const textStyle = view.getComputedStyle(parent);
            if (textStyle.visibility === "hidden") continue;
            textMetrics.font = `${textStyle.fontStyle} ${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`;
            const metrics = textMetrics.measureText(node.textContent);
            const range = root.ownerDocument.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              const baseline = rect.bottom - metrics.fontBoundingBoxDescent;
              rects.push(
                new DOMRect(
                  rect.left,
                  baseline - metrics.actualBoundingBoxAscent,
                  rect.width,
                  metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
                ),
              );
            }
          }
          for (const icon of element.querySelectorAll("svg")) {
            if (view.getComputedStyle(icon).visibility !== "hidden")
              rects.push(icon.getBoundingClientRect());
          }
          const visible = rects.filter((rect) => rect.width > 0 && rect.height > 0);
          {
            for (const side of ["left", "right"]) {
              const property = `--reader-edge-cutout-${side}`;
              if (Number.isFinite(cutout.top) && Number.isFinite(cutout.bottom)) {
                const overlap = visible.some(
                  (rect) => rect.top < cutout.bottom && rect.bottom > cutout.top,
                );
                setProperty(
                  property,
                  overlap ? style.getPropertyValue(`--reader-host-cutout-${side}`) : "0px",
                );
              } else {
                element.style.removeProperty(property);
              }
            }
          }
          for (const left of [true, false]) {
            const corner = `${upper ? "top" : "bottom"}-${left ? "left" : "right"}`;
            const property = `--reader-edge-corner-${corner}`;
            const radius = Number.parseFloat(
              style.getPropertyValue(`--reader-host-corner-${corner}-radius`),
            );
            if (!Number.isFinite(radius)) {
              element.style.removeProperty(property);
              continue;
            }
            const centerX = Number.parseFloat(
              style.getPropertyValue(`--reader-host-corner-${corner}-x`),
            );
            const centerY = Number.parseFloat(
              style.getPropertyValue(`--reader-host-corner-${corner}-y`),
            );
            const y = upper
              ? Math.min(...visible.map((rect) => rect.top))
              : Math.max(...visible.map((rect) => rect.bottom));
            const inset =
              visible.length === 0 || radius === 0
                ? 0
                : cornerClearance(
                    radius,
                    centerX,
                    centerY,
                    y + (upper ? -1 : 1),
                    left ? rootBox.left : rootBox.right,
                    upper,
                    left,
                  );
            const value = `${inset}px`;
            setProperty(property, value);
          }
        }
      }
      const topRail = root.querySelector<HTMLElement>(".epub-navigator-reader__compact-top-rail");
      const bottomRail = root.querySelector<HTMLElement>(
        ".epub-navigator-reader__compact-bottom-rail",
      );
      const title = root.querySelector<HTMLElement>(".epub-navigator-reader__compact-menu-trigger");
      for (const side of ["left", "right"] as const) {
        const property = `--reader-shared-rail-${side}`;
        if (
          !topCutout &&
          ["left", "right"].some(
            (edge) => Number.parseFloat(style.getPropertyValue(`--reader-host-cutout-${edge}`)) > 0,
          ) &&
          topRail &&
          bottomRail &&
          title
        ) {
          const inset = Number.parseFloat(view.getComputedStyle(title).paddingLeft);
          const topStyle = view.getComputedStyle(topRail);
          const bottomStyle = view.getComputedStyle(bottomRail);
          const value = `${Math.max(
            (Number.parseFloat(topStyle.getPropertyValue(`--reader-edge-corner-top-${side}`)) ||
              0) + inset,
            (Number.parseFloat(topStyle.getPropertyValue(`--reader-edge-cutout-${side}`)) || 0) +
              inset,
            Number.parseFloat(
              bottomStyle.getPropertyValue(`--reader-edge-corner-bottom-${side}`),
            ) || 0,
            Number.parseFloat(bottomStyle.getPropertyValue(`--reader-edge-cutout-${side}`)) || 0,
            inset,
          )}px`;
          if (root.style.getPropertyValue(property) !== value)
            root.style.setProperty(property, value);
        } else root.style.removeProperty(property);
      }
      for (const element of observed) if (!current.has(element)) resize.unobserve(element);
      observed.clear();
      for (const element of current) observed.add(element);
      for (const [element, properties] of updated) {
        if (current.has(element)) continue;
        for (const property of properties) element.style.removeProperty(property);
        updated.delete(element);
      }
    };
    const mutation = new view.MutationObserver(schedule);
    mutation.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    for (let ancestor = root.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      mutation.observe(ancestor, { attributes: true, attributeFilter: ["style", "class"] });
    }
    resize.observe(root);
    view.addEventListener("resize", schedule);
    root.ownerDocument.fonts?.addEventListener("loadingdone", schedule);
    update();
    return () => {
      root.removeAttribute("data-top-cutout");
      root.style.removeProperty("--reader-shared-rail-left");
      root.style.removeProperty("--reader-shared-rail-right");
      mutation.disconnect();
      resize.disconnect();
      view.removeEventListener("resize", schedule);
      root.ownerDocument.fonts?.removeEventListener("loadingdone", schedule);
      if (frame !== null) view.cancelAnimationFrame(frame);
      for (const [element, properties] of updated)
        for (const property of properties) element.style.removeProperty(property);
    };
  }, [root]);
}
