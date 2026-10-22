import { useLayoutEffect, useState, type CSSProperties } from "react";

export function useContainedVisualViewportStyle(
  root: HTMLElement | null,
  active: boolean,
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!active || root === null) return;
    const view = root.ownerDocument.defaultView;
    if (view === null) return;
    const update = () => {
      const host = root.getBoundingClientRect();
      const visual = view.visualViewport;
      const viewportLeft = visual?.offsetLeft ?? 0;
      const viewportTop = visual?.offsetTop ?? 0;
      const viewportRight = viewportLeft + (visual?.width ?? view.innerWidth);
      const viewportBottom = viewportTop + (visual?.height ?? view.innerHeight);
      const left = Math.max(host.left, viewportLeft);
      const top = Math.max(host.top, viewportTop);
      const right = Math.max(left, Math.min(host.right, viewportRight));
      const bottom = Math.max(top, Math.min(host.bottom, viewportBottom));
      setStyle({
        inset: "auto",
        left: left - host.left,
        top: top - host.top,
        width: right - left,
        height: bottom - top,
      });
    };
    update();
    const visual = view.visualViewport;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resize?.observe(root);
    view.addEventListener("resize", update, { passive: true });
    visual?.addEventListener("resize", update, { passive: true });
    visual?.addEventListener("scroll", update, { passive: true });
    return () => {
      resize?.disconnect();
      view.removeEventListener("resize", update);
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
    };
  }, [active, root]);
  return active && root !== null ? style : undefined;
}
