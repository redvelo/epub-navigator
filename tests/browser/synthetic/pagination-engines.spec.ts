import { expect, test, type Page } from "@playwright/test";
import {
  currentDocument,
  currentObservation,
  currentPaginatedLayout,
  currentReflowSettlement,
} from "../../../src/runtime/kernel-view.js";
import { selectionEdgeDwellMs } from "../../../src/runtime/content-agent/selection/controller.js";

/** Derived from the controller's own cadence, so retuning the dwell cannot strand the spec. */
const pastDwell = selectionEdgeDwellMs + 100;

test.beforeEach(async ({ page }) => {
  await page.goto("/synthetic/text-pagination.html");
  await expect
    .poll(() => page.evaluate(() => window.__EPUB_TEXT_PAGINATION__ !== undefined))
    .toBe(true);
  await page.clock.install();
});

for (const columns of ["single", "double"] as const) {
  test(`lays out and moves horizontal ${columns} pagination`, async ({ page }) => {
    const snapshot = await page.evaluate(async (value) => {
      const harness = window.__EPUB_TEXT_PAGINATION__!;
      const populated = await harness.setScenario("safe");
      return value === "double" ? harness.setColumns(value) : populated;
    }, columns);
    expect(currentReflowSettlement(snapshot)?.mode).toBe("paginated");
    expect(currentPaginatedLayout(snapshot)).toMatchObject({
      columnsPerView: columns === "single" ? 1 : 2,
    });
    const columnSizing = await page
      .locator('iframe:not([aria-hidden="true"])')
      .contentFrame()
      .locator("body")
      .evaluate((body) => {
        const style = getComputedStyle(body);
        return { count: style.columnCount, width: style.columnWidth };
      });
    expect(columnSizing).toEqual({ count: columns === "single" ? "1" : "2", width: "auto" });
    await assertForwardMovement(page);
  });
}

test("keeps automatic horizontal pages at least 360px wide", async ({ page }) => {
  await page.setViewportSize({ width: 673, height: 909 });
  const go6 = await page.evaluate(() => window.__EPUB_TEXT_PAGINATION__!.setColumns("auto"));
  expect(currentPaginatedLayout(go6)).toMatchObject({ columnsPerView: 1 });

  await page.setViewportSize({ width: 782, height: 700 });
  await expect.poll(() => columnsPerView(page)).toBe(1);
  await page.setViewportSize({ width: 783, height: 700 });
  await expect.poll(() => columnsPerView(page)).toBe(2);
});

test("lays out and moves horizontal RTL pagination", async ({ page }) => {
  const snapshot = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.setFlow("horizontal-tb", "rtl"),
  );
  expect(currentObservation(snapshot)).toMatchObject({
    writingMode: "horizontal-tb",
    direction: "rtl",
  });
  await assertForwardMovement(page);
});

test("lays out vertical pagination and invalidates for replaced images", async ({ page }) => {
  const vertical = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.setFlow("vertical-rl", "rtl"),
  );
  expect(currentReflowSettlement(vertical)?.mode).toBe("paginated");
  const generation = currentDocument(vertical)?.layout.layout.layoutGeneration ?? 0;
  const replaced = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.installForcedReplacedContent(),
  );
  expect(currentDocument(replaced)?.layout.layout.layoutGeneration).toBeGreaterThan(generation);
  expect(currentReflowSettlement(replaced)?.mode).toBe("paginated");
  await assertForwardMovement(page);
});

test("controls edge scrolling while extending a live selection", async ({ page }) => {
  const snapshot = await page.evaluate(async () => {
    const harness = window.__EPUB_TEXT_PAGINATION__!;
    await harness.setScenario("safe");
    return harness.setColumns("double");
  });
  const pages = currentPaginatedLayout(snapshot);
  if (pages === null) throw new Error("paginated layout is unavailable");
  const initialVisiblePage = pages.firstVisiblePage;
  const frame = page.locator('iframe:not([aria-hidden="true"])').contentFrame();
  await pauseClock(page);
  await frame.locator("html").evaluate((root) => {
    window.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: innerWidth / 2,
        clientY: innerHeight / 2,
        bubbles: true,
      }),
    );
    document.body?.dispatchEvent(new Event("selectstart", { bubbles: true, cancelable: true }));
    const selection = getSelection();
    const range = document.createRange();
    if (selection === null || document.body === null) throw new Error("selection is unavailable");
    range.selectNodeContents(document.body);
    selection.removeAllRanges();
    selection.addRange(range);
    root.scrollLeft = 80;
    window.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("selectionchange"));
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
        buttons: 1,
        clientX: innerWidth - 1,
        clientY: innerHeight / 2,
        bubbles: true,
      }),
    );
  });

  expect(await frame.locator("html").evaluate((root) => Math.abs(root.scrollLeft))).toBeLessThan(2);
  await page.clock.runFor(pastDwell);
  expect(await frame.locator("html").evaluate((root) => Math.abs(root.scrollLeft))).toBeCloseTo(
    pages.spreadStride,
    0,
  );
  const transient = await page.evaluate(() => window.__EPUB_TEXT_PAGINATION__!.snapshot());
  expect(currentPaginatedLayout(transient)?.firstVisiblePage).toBe(initialVisiblePage);

  await frame.locator("html").evaluate(() => {
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 0,
        clientX: innerWidth - 1,
        clientY: innerHeight / 2,
        bubbles: true,
      }),
    );
  });
  await page.clock.resume();
  await expect
    .poll(() =>
      frame.locator("html").evaluate((root, stride) => {
        const position = Math.abs(root.scrollLeft);
        const maximum = root.scrollWidth - innerWidth;
        return (
          Math.min(position % stride, stride - (position % stride)) < 2 ||
          Math.abs(position - maximum) < 2
        );
      }, pages.spreadStride),
    )
    .toBe(true);
  await expect
    .poll(async () => {
      const current = await page.evaluate(() => window.__EPUB_TEXT_PAGINATION__!.snapshot());
      return currentPaginatedLayout(current)?.firstVisiblePage ?? -1;
    })
    .toBeGreaterThan(initialVisiblePage);
  expect(await frame.locator("html").evaluate(() => getSelection()?.isCollapsed)).toBe(false);
  expect(await frame.locator("html").evaluate((root) => Math.abs(root.scrollLeft))).toBeCloseTo(
    pages.spreadStride,
    0,
  );
});

test("keeps a real mouse selection stable through a full spread turn", async ({ page }) => {
  const snapshot = await page.evaluate(async () => {
    await window.__EPUB_TEXT_PAGINATION__!.setScenario("safe");
    return window.__EPUB_TEXT_PAGINATION__!.setColumns("double");
  });
  const pages = currentPaginatedLayout(snapshot)!;
  const iframe = page.locator('iframe:not([aria-hidden="true"])');
  const frame = iframe.contentFrame();
  const box = (await iframe.boundingBox())!;
  const start = await frame.locator("body").evaluate((body) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 1);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.left >= 0 && rect.top >= 0 && rect.bottom < innerHeight) {
        return { x: rect.left + 1, y: (rect.top + rect.bottom) / 2 };
      }
    }
    throw new Error("visible text is unavailable");
  });
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + start.y, { steps: 12 });
  await expect
    .poll(() => frame.locator("html").evaluate((root) => Math.abs(root.scrollLeft)))
    .toBeCloseTo(pages.spreadStride, 0);
  await page.mouse.move(box.x + start.x + 20, box.y + start.y);
  await page.mouse.up();
  await pauseClock(page);
  await page.clock.runFor(600);
  expect(await frame.locator("html").evaluate((root) => Math.abs(root.scrollLeft))).toBeCloseTo(
    pages.spreadStride,
    0,
  );
  expect(await frame.locator("html").evaluate(() => getSelection()?.isCollapsed)).toBe(false);
});

test("aligns interrupted selection progression in vertical RTL flow", async ({ page }) => {
  const snapshot = await page.evaluate(async () => {
    const harness = window.__EPUB_TEXT_PAGINATION__!;
    await harness.setScenario("safe");
    return harness.setFlow("vertical-rl", "rtl");
  });
  const pages = currentPaginatedLayout(snapshot);
  if (pages === null) throw new Error("paginated layout is unavailable");
  const frame = page.locator('iframe:not([aria-hidden="true"])').contentFrame();
  await frame.locator("html").evaluate(() => {
    window.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 9,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: innerWidth / 2,
        clientY: innerHeight / 2,
        bubbles: true,
      }),
    );
    const selection = getSelection();
    const range = document.createRange();
    if (selection === null || document.body === null) throw new Error("selection is unavailable");
    range.selectNodeContents(document.body);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 9,
        pointerType: "touch",
        isPrimary: true,
        buttons: 1,
        clientX: innerWidth / 2,
        clientY: 1,
        bubbles: true,
      }),
    );
  });

  await expect
    .poll(() => frame.locator("html").evaluate((root) => Math.abs(root.scrollTop)), {
      intervals: [20],
      timeout: 700,
    })
    .toBeCloseTo(pages.spreadStride, 0);
  await frame.locator("html").evaluate(() => {
    window.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      frame.locator("html").evaluate((root, stride) => {
        const position = Math.abs(root.scrollTop);
        const maximum = root.scrollHeight - innerHeight;
        return (
          Math.min(position % stride, stride - (position % stride)) < 2 ||
          Math.abs(position - maximum) < 2
        );
      }, pages.spreadStride),
    )
    .toBe(true);
  await expect
    .poll(async () => {
      const current = await page.evaluate(() => window.__EPUB_TEXT_PAGINATION__!.snapshot());
      return currentReflowSettlement(current)?.mode ?? null;
    })
    .toBe("paginated");
});

test("does not count the empty slot after an odd final physical page", async ({ page }) => {
  const snapshot = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.installOddFinalSpread(),
  );
  const pages = currentPaginatedLayout(snapshot);
  if (pages === null) throw new Error("paginated layout is unavailable");
  expect(pages.pageCount % 2).toBe(1);
  const final = await page.evaluate(() => window.__EPUB_TEXT_PAGINATION__!.goToEnd());
  const finalPages = currentPaginatedLayout(final);
  expect(
    finalPages === null
      ? null
      : {
          firstVisiblePage: finalPages.firstVisiblePage,
          pageCount: finalPages.pageCount,
          visiblePageCount: finalPages.visiblePageCount,
        },
  ).toEqual({
    firstVisiblePage: pages.pageCount - 1,
    pageCount: pages.pageCount,
    visiblePageCount: 1,
  });
});

async function assertForwardMovement(page: Page): Promise<void> {
  const snapshot = await page.evaluate(() => window.__EPUB_TEXT_PAGINATION__!.snapshot());
  const pages = currentPaginatedLayout(snapshot);
  if (pages === null) throw new Error("paginated layout is unavailable");
  const beforePage = pages.firstVisiblePage;
  const frame = page.locator('iframe:not([aria-hidden="true"])').contentFrame();
  const before = await frame.locator("html").evaluate((root) => ({
    left: root.scrollLeft,
    top: root.scrollTop,
  }));
  await frame.locator("html").evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
    );
  });
  await expect
    .poll(async () => {
      const current = await frame.locator("html").evaluate((root) => ({
        left: root.scrollLeft,
        top: root.scrollTop,
      }));
      return Math.hypot(current.left - before.left, current.top - before.top);
    })
    .toBeGreaterThan(0);
  const after = await frame.locator("html").evaluate((root) => ({
    left: root.scrollLeft,
    top: root.scrollTop,
  }));
  const movement = Math.hypot(after.left - before.left, after.top - before.top);
  expect(beforePage + Math.round(movement / pages.spreadStride) * pages.columnsPerView).toBe(
    beforePage + pages.columnsPerView,
  );
  expect(movement).toBeCloseTo(pages.spreadStride, 0);
}

async function columnsPerView(page: Page): Promise<number | null> {
  const snapshot = await page.evaluate(() => window.__EPUB_TEXT_PAGINATION__!.snapshot());
  return currentPaginatedLayout(snapshot)?.columnsPerView ?? null;
}

async function pauseClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 50);
}
