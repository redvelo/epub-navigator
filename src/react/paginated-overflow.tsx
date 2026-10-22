import {
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { PaginationFooter } from "./pagination-footer.js";
import { cn } from "./lib/utils.js";

import { PaginationFooterContext } from "./pagination-footer-context.js";
import { useSurfacePager } from "./surface-pager.js";

function columnPitch(element: HTMLDivElement, content: HTMLDivElement | null): number {
  const column = content?.getClientRects()[0];
  if (content === null || column === undefined) return element.clientWidth;
  const style = getComputedStyle(content);
  const edges = [
    style.paddingInlineStart,
    style.paddingInlineEnd,
    style.borderInlineStartWidth,
    style.borderInlineEndWidth,
  ].reduce((total, edge) => {
    const size = Number.parseFloat(edge);
    return total + (Number.isNaN(size) ? 0 : size);
  }, 0);
  const gap = Number.parseFloat(style.columnGap);
  return column.width - edges + (Number.isNaN(gap) ? 0 : gap);
}

function pageAxis(
  element: HTMLDivElement,
  content: HTMLDivElement | null,
  flow: HTMLDivElement | null,
): {
  readonly size: number;
  readonly count: number;
  readonly maximum: number;
  readonly offset: number;
  readonly inline: boolean;
} {
  const inline = element.scrollWidth - element.clientWidth > 1;
  if (!inline) {
    const size = element.clientHeight;
    const extent = element.scrollHeight;
    return {
      size,
      count: size === 0 ? 1 : Math.max(1, Math.ceil((extent - 1) / size)),
      maximum: Math.max(0, extent - size),
      offset: element.scrollTop,
      inline,
    };
  }
  const size = columnPitch(element, content);
  const extent = element.scrollWidth;
  const fragments = flow === null ? 0 : flow.getClientRects().length;
  const count = Math.max(
    1,
    fragments > 0 ? fragments : size === 0 ? 1 : Math.ceil((extent - 1) / size),
  );
  return {
    size,
    count,
    maximum: Math.max(0, Math.min(extent - size, (count - 1) * size)),
    offset: Math.abs(element.scrollLeft),
    inline,
  };
}

function scrollToOffset(element: HTMLDivElement, offset: number, inline: boolean): void {
  if (!inline) {
    element.scrollTop = offset;
    return;
  }
  element.scrollLeft = getComputedStyle(element).direction === "rtl" ? -offset : offset;
}

export function PaginatedOverflow({
  children,
  className,
  pageLabel = "Navigation",
  deviceTurns = false,
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly pageLabel?: string | undefined;
  /**
   * Claims a device's page buttons while these pages are on screen, for a page that is not laid
   * over anything else. A surface inside a dialog is recognised as laid over one on its own.
   */
  readonly deviceTurns?: boolean | undefined;
}) {
  const footerHost = useContext(PaginationFooterContext);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const animationFrame = useRef<number | null>(null);
  const pendingPage = useRef<{ page: number; remainingObservations: number } | null>(null);
  const logicalPage = useRef(0);
  const logicalPageCount = useRef(1);
  const selectedInitialLocation = useRef(false);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [inlinePages, setInlinePages] = useState(false);
  const update = () => {
    const element = viewport.current;
    if (element === null) return;
    const {
      size: height,
      count: observedCount,
      maximum,
      offset: top,
      inline,
    } = pageAxis(element, content.current, flow.current);
    if (height === 0) return;
    setInlinePages(inline);
    const observedPage =
      maximum > 0 && maximum - top < 1
        ? observedCount - 1
        : Math.min(observedCount - 1, Math.floor(top / height));
    const pending = pendingPage.current;
    if (pending !== null) {
      const targetPage = Math.min(logicalPageCount.current - 1, pending.page);
      const targetTop = Math.min(maximum, targetPage * height);
      const geometryIncludesTarget = observedCount > targetPage;
      if (geometryIncludesTarget && Math.abs(top - targetTop) < 1) {
        pendingPage.current = null;
        logicalPage.current = targetPage;
        logicalPageCount.current = observedCount;
        setPageCount(observedCount);
        setPage(targetPage);
      } else {
        logicalPage.current = targetPage;
        setPage(targetPage);
        if (pending.remainingObservations > 0) {
          pending.remainingObservations -= 1;
          scheduleUpdate();
        }
      }
      return;
    }
    logicalPage.current = observedPage;
    logicalPageCount.current = observedCount;
    setPageCount(observedCount);
    setPage(observedPage);
  };
  const scheduleUpdate = () => {
    if (animationFrame.current !== null) return;
    animationFrame.current = requestAnimationFrame(() => {
      animationFrame.current = null;
      update();
    });
  };
  useEffect(() => {
    const element = viewport.current;
    const contentElement = content.current;
    if (element === null || contentElement === null) return;
    if (!selectedInitialLocation.current) {
      selectedInitialLocation.current = true;
      const current = element.querySelector<HTMLElement>('[aria-current="location"]');
      if (typeof current?.scrollIntoView === "function") current.scrollIntoView({ block: "start" });
    }
    scheduleUpdate();
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resize?.observe(element);
    resize?.observe(contentElement);
    return () => {
      resize?.disconnect();
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
      animationFrame.current = null;
    };
  }, []);
  useLayoutEffect(() => scheduleUpdate(), [children]);
  const changePage = (delta: number) => {
    const element = viewport.current;
    if (element === null) return;
    const { size, inline } = pageAxis(element, content.current, flow.current);
    if (size === 0) return;
    const targetPage = Math.max(
      0,
      Math.min(
        logicalPageCount.current - 1,
        (pendingPage.current?.page ?? logicalPage.current) + delta,
      ),
    );
    if (targetPage === logicalPage.current && pendingPage.current === null) return;
    pendingPage.current = {
      page: targetPage,
      remainingObservations: 3,
    };
    logicalPage.current = targetPage;
    setPage(targetPage);
    scrollToOffset(element, targetPage * size, inline);
    scheduleUpdate();
  };
  useHorizontalPageSwipe(viewport, changePage);
  useSurfacePager(viewport, deviceTurns, changePage);
  const footer = (
    <PaginationFooter
      page={page}
      pageCount={pageCount}
      pageLabel={pageLabel}
      onPageChange={changePage}
    />
  );
  return (
    <div className="epub-navigator-reader__pages" data-page-count={pageCount}>
      <div
        ref={viewport}
        className={cn("epub-navigator-reader__page-viewport", className)}
        // A drawer arbitrates every touch inside it and yields a cross-axis gesture only to a
        // region that scrolls on that axis. Pages laid out across the inline axis are such a
        // region, so the turn is left to arbitration and a drag along the block axis, which has
        // nothing to scroll there, still takes the sheet away. Pages stacked down the block axis
        // are not: the turn scrolls nothing the drawer can see, so the body claims both axes and
        // the sheet leaves by its chrome.
        //
        // Arbitration reads `overflow`, not the layout: a host that hides the viewport's inline
        // overflow makes the drawer treat an inline-paginated page as unscrollable on both axes,
        // and it then swallows the turn. Keep the inline axis scrollable wherever pages are
        // laid out across it.
        {...(inlinePages ? {} : { "data-base-ui-swipe-ignore": "" })}
        onScroll={scheduleUpdate}
        onKeyDown={(event) => {
          if (event.key !== "PageDown" && event.key !== "PageUp") return;
          event.preventDefault();
          changePage(event.key === "PageDown" ? 1 : -1);
        }}
      >
        <div ref={content} className="epub-navigator-reader__page-content">
          <div ref={flow} className="epub-navigator-reader__page-flow">
            {children}
          </div>
        </div>
      </div>
      {footerHost === null ? footer : createPortal(footer, footerHost)}
    </div>
  );
}

/** A page turn is recognised by direction and distance; the clock only rejects a drag that was
 * really something else, so it is generous enough for a deliberate finger. */
const SWIPE_TRAVEL = 40;
const SWIPE_DURATION = 1500;

function useHorizontalPageSwipe(
  viewport: RefObject<HTMLDivElement | null>,
  changePage: (delta: number) => void,
): void {
  const pageChange = useEffectEvent(changePage);
  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    let candidate: {
      identifier: number;
      startedAt: number;
      startX: number;
      startY: number;
      horizontal: boolean;
    } | null = null;
    let suppressedClick: { x: number; y: number; until: number } | null = null;
    const touchWithIdentifier = (touches: TouchList, identifier: number): Touch | null => {
      for (let index = 0; index < touches.length; index += 1) {
        const touch = touches.item(index);
        if (touch?.identifier === identifier) return touch;
      }
      return null;
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        candidate = null;
        return;
      }
      const touch = event.touches.item(0);
      if (touch === null) return;
      candidate = {
        identifier: touch.identifier,
        startedAt: performance.now(),
        startX: touch.clientX,
        startY: touch.clientY,
        horizontal: false,
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (candidate === null) return;
      const touch = touchWithIdentifier(event.touches, candidate.identifier);
      if (touch === null) {
        candidate = null;
        return;
      }
      const x = touch.clientX - candidate.startX;
      const y = touch.clientY - candidate.startY;
      if (!candidate.horizontal && Math.abs(y) > 12 && Math.abs(y) > Math.abs(x)) {
        candidate = null;
        return;
      }
      if (!candidate.horizontal && Math.abs(x) > 12 && Math.abs(x) > Math.abs(y) * 1.25) {
        candidate.horizontal = true;
      }
      if (candidate.horizontal) event.preventDefault();
    };
    const onTouchEnd = (event: TouchEvent) => {
      const completed = candidate;
      candidate = null;
      if (completed === null) return;
      const touch = touchWithIdentifier(event.changedTouches, completed.identifier);
      if (touch === null) return;
      const x = touch.clientX - completed.startX;
      const y = touch.clientY - completed.startY;
      if (
        !completed.horizontal ||
        performance.now() - completed.startedAt > SWIPE_DURATION ||
        Math.abs(x) < SWIPE_TRAVEL ||
        Math.abs(x) <= Math.abs(y) * 1.25
      ) {
        return;
      }
      event.preventDefault();
      suppressedClick = {
        x: touch.clientX,
        y: touch.clientY,
        until: performance.now() + 700,
      };
      pageChange(x < 0 ? 1 : -1);
    };
    const onTouchCancel = () => {
      candidate = null;
    };
    const onClick = (event: MouseEvent) => {
      const suppressed = suppressedClick;
      if (suppressed === null) return;
      suppressedClick = null;
      if (
        performance.now() > suppressed.until ||
        Math.hypot(event.clientX - suppressed.x, event.clientY - suppressed.y) > 24
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    element.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    element.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    element.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });
    element.addEventListener("click", onClick, { capture: true });
    return () => {
      element.removeEventListener("touchstart", onTouchStart, true);
      element.removeEventListener("touchmove", onTouchMove, true);
      element.removeEventListener("touchend", onTouchEnd, true);
      element.removeEventListener("touchcancel", onTouchCancel, true);
      element.removeEventListener("click", onClick, true);
    };
  }, [viewport]);
}
