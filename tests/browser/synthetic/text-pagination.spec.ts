import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import type { KernelSnapshot } from "epub-navigator";
import {
  currentObservation,
  currentPaginatedLayout,
  currentReflowSettlement,
} from "../../../src/runtime/kernel-view.js";

type Scenario =
  | "safe"
  | "ancestors"
  | "descendants"
  | "multiple"
  | "collision"
  | "starved-margins"
  | "wide-table"
  | "unfit-table"
  | "mixed-margins"
  | "starved-div"
  | "wide-pre"
  | "unfit-pre"
  | "two-column-table";

test.beforeEach(async ({ page }) => {
  await page.goto("/synthetic/text-pagination.html");
  await expect
    .poll(() => page.evaluate(() => window.__EPUB_TEXT_PAGINATION__ !== undefined))
    .toBe(true);
});

test("reports no issue when the document has no oversized atomic text", async ({ page }) => {
  expect(currentPaginatedLayout(await snapshot(page))?.layoutRepairs).toEqual({
    status: "no-issues-detected",
  });
});

test("performs one authoritative content-end scan on a stable layout", async ({ page }) => {
  const diagnostics = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.measureStableGeometry(),
  );
  expect(diagnostics.scanCount).toBe(1);
  expect(diagnostics.rectangleCount).toBeGreaterThan(0);
  expect(diagnostics.assessment).toMatchObject({
    displayCandidateCount: 0,
    rectangleCount: 0,
    textRangeScanCount: 0,
  });
  expect(diagnostics.assessment?.paragraphCount).toBeGreaterThan(0);
  expect(diagnostics.phases.filter(({ phase }) => phase === "content-end-scan")).toHaveLength(1);
  // Foreground frames settle visual effects once more after relocating; nothing is measured again.
  const scanIndex = diagnostics.phases.findIndex(({ phase }) => phase === "content-end-scan");
  expect(diagnostics.phases.slice(scanIndex + 1).map(({ phase }) => phase)).toEqual(
    diagnostics.phases.slice(scanIndex + 1).map(() => "settlement"),
  );
  for (const phase of diagnostics.phases) expect(phase.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(diagnostics)).not.toContain("Alice");
});

test("retains vertical RTL physical pagination geometry", async ({ page }) => {
  const settled = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.setFlow("vertical-rl", "rtl"),
  );
  const settlement = currentReflowSettlement(settled);
  expect(currentObservation(settled)).toMatchObject({
    writingMode: "vertical-rl",
    direction: "rtl",
  });
  expect(settlement?.mode).toBe("paginated");
  expect(settlement?.measurement.physicalMovement.x).toBe(0);
  expect(settlement?.measurement.physicalMovement.y).toBeLessThan(0);
});

test("retains forced-break and replaced-content pagination", async ({ page }) => {
  const before = currentPaginatedLayout(await snapshot(page));
  const settled = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.installForcedReplacedContent(),
  );
  const after = currentPaginatedLayout(settled);
  if (before === null || after === null) throw new Error("paginated layout is unavailable");
  expect(after.pageCount).toBeGreaterThan(before.pageCount);
  await expect(contentFrame(page).locator("section[style] > img")).toHaveJSProperty(
    "complete",
    true,
  );
});

for (const [scenario, expected] of [
  ["clipped-overflow", 1],
  ["empty", 1],
  ["authored-blank", 3],
] as const) {
  test(`counts the ${scenario} content end exactly`, async ({ page }) => {
    const settled = await page.evaluate(
      (value) => window.__EPUB_TEXT_PAGINATION__!.installContentEndScenario(value),
      scenario,
    );
    const pages = currentPaginatedLayout(settled);
    if (pages === null) throw new Error("paginated layout is unavailable");
    expect(pages.pageCount).toBe(expected);
  });
}

test("counts visible out-of-flow content", async ({ page }) => {
  const settled = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.installContentEndScenario("out-of-flow"),
  );
  const pages = currentPaginatedLayout(settled);
  if (pages === null) throw new Error("paginated layout is unavailable");
  expect(pages.pageCount).toBeGreaterThan(1);
});

test("counts generated in-flow content", async ({ page }) => {
  const settled = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.installContentEndScenario("generated"),
  );
  const pages = currentPaginatedLayout(settled);
  if (pages === null) throw new Error("paginated layout is unavailable");
  expect(pages.pageCount).toBeGreaterThan(1);
});

for (const columns of ["single", "double"] as const) {
  test(`repairs and traverses oversized text in ${columns} columns`, async ({ page }) => {
    if (columns === "double") await setColumns(page, columns);
    const settled = await setScenario(page, "safe");
    expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
      status: "repaired",
      repairedElements: 1,
    });
    const frame = contentFrame(page);
    const candidate = frame.locator('[data-candidate="safe"]');
    await expect(candidate).toHaveCSS("display", "block");
    await expect(candidate).toHaveAttribute("data-epub-navigator-fragmentation", /^m3-/);

    const pages = currentPaginatedLayout(settled);
    if (pages === null) throw new Error("paginated layout is unavailable");
    const geometry = await lineGeometry(frame, "safe", pages.columnOrigin, pages.columnPitch);
    expect(geometry.pages.length).toBe(64);
    expect(geometry.pages).toEqual([...geometry.pages].sort((left, right) => left - right));
    expect(new Set(geometry.pages).size).toBeGreaterThan(1);
    for (const rectangle of geometry.rectangles) {
      expect(rectangle.top).toBeGreaterThanOrEqual(-1);
      expect(rectangle.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    }
    await traverseCandidate(frame, settled, "safe", geometry.pages);
  });
}

test("leaves unsafe ancestor layouts unmodified and reports them", async ({ page }) => {
  const settled = await setScenario(page, "ancestors");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "unresolved",
    repairedElements: 0,
    unresolvedElements: 7,
  });
  const candidates = contentFrame(page).locator("[data-candidate]");
  await expect(candidates).toHaveCount(7);
  for (let index = 0; index < 7; index += 1) {
    await expect(candidates.nth(index)).toHaveCSS("display", "inline-block");
    await expect(candidates.nth(index)).not.toHaveAttribute("data-epub-navigator-fragmentation");
  }
});

test("leaves unsafe descendant layouts unmodified and reports them", async ({ page }) => {
  const settled = await setScenario(page, "descendants");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "unresolved",
    repairedElements: 0,
    unresolvedElements: 9,
  });
  const candidates = contentFrame(page).locator("[data-candidate]");
  await expect(candidates).toHaveCount(9);
  for (let index = 0; index < 9; index += 1) {
    await expect(candidates.nth(index)).toHaveCSS("display", "inline-block");
    await expect(candidates.nth(index)).not.toHaveAttribute("data-epub-navigator-fragmentation");
  }
});

test("reports mixed candidates and marks only safe text", async ({ page }) => {
  const settled = await setScenario(page, "multiple");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "unresolved",
    repairedElements: 2,
    unresolvedElements: 2,
  });
  const frame = contentFrame(page);
  await expect(frame.locator("[data-epub-navigator-fragmentation]")).toHaveCount(2);
  await expect(frame.locator('[data-candidate="safe-a"]')).toHaveCSS("display", "block");
  await expect(frame.locator('[data-candidate="safe-b"]')).toHaveCSS("display", "block");
  await expect(frame.locator('[data-candidate="unsafe-a"]')).toHaveCSS("display", "inline-block");
  await expect(frame.locator('[data-candidate="unsafe-b"]')).toHaveCSS("display", "inline-block");

  const recomputed = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.removeCandidate("safe-b"),
  );
  expect(currentPaginatedLayout(recomputed)?.layoutRepairs).toEqual({
    status: "unresolved",
    repairedElements: 1,
    unresolvedElements: 2,
  });
  await expect(frame.locator("[data-epub-navigator-fragmentation]")).toHaveCount(1);
});

test("scales a starved indent until the prose keeps its measure", async ({ page }) => {
  const settled = await setScenario(page, "starved-margins");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "repaired",
    repairedElements: 1,
  });
  const frame = contentFrame(page);
  const candidate = frame.locator('[data-candidate="starved"]');
  await expect(candidate).toHaveAttribute("data-epub-navigator-fragmentation", /^m3-/);
  const column = await frame.locator("body").evaluate((body) => body.getBoundingClientRect().width);
  const geometry = await candidate.evaluate((element) => ({
    marginStart: parseFloat(getComputedStyle(element).marginInlineStart),
    measure: element.getClientRects()[0]?.width ?? 0,
  }));
  // Four fifths of the column became two fifths: the indent is halved, not dropped.
  expect(geometry.marginStart).toBeCloseTo(column * 0.4, 0);
  expect(geometry.measure).toBeGreaterThanOrEqual(column * 0.6 - 1);
});

test("gives up only the repair a box will not take, and keeps the rest", async ({ page }) => {
  const settled = await setScenario(page, "mixed-margins");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "unresolved",
    repairedElements: 1,
    unresolvedElements: 1,
  });
  const frame = contentFrame(page);
  await expect(frame.locator('[data-candidate="starved"]')).toHaveAttribute(
    "data-epub-navigator-fragmentation",
    /^m3-/,
  );
  await expect(frame.locator('[data-candidate="fixed-width"]')).not.toHaveAttribute(
    "data-epub-navigator-fragmentation",
  );
});

test("scales a starved division as it would a paragraph", async ({ page }) => {
  const settled = await setScenario(page, "starved-div");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "repaired",
    repairedElements: 1,
  });
  await expect(contentFrame(page).locator('[data-candidate="starved-div"]')).toHaveAttribute(
    "data-epub-navigator-fragmentation",
    /^m3-/,
  );
});

test("scales a wide block of code to its column", async ({ page }) => {
  const settled = await setScenario(page, "wide-pre");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "repaired",
    repairedElements: 1,
  });
  const candidate = contentFrame(page).locator('[data-candidate="wide-pre"]');
  const zoom = await candidate.evaluate((element) => Number(getComputedStyle(element).zoom));
  expect(zoom).toBeLessThan(1);
  expect(zoom).toBeGreaterThan(0.8);
});

test("wraps a block of code it cannot scale enough", async ({ page }) => {
  const settled = await setScenario(page, "unfit-pre");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "repaired",
    repairedElements: 1,
  });
  const frame = contentFrame(page);
  const candidate = frame.locator('[data-candidate="unfit-pre"]');
  await expect(candidate).toHaveCSS("white-space", "pre-wrap");
  await expect(candidate).toHaveCSS("zoom", "1");
  const column = await frame.locator("body").evaluate((body) => body.getBoundingClientRect().width);
  const width = await candidate.evaluate((element) => element.getClientRects()[0]?.width ?? 0);
  expect(width).toBeLessThanOrEqual(column + 1);
});

test("takes a section to one column for a table two columns cannot hold", async ({ page }) => {
  await setColumns(page, "double");
  const settled = await setScenario(page, "two-column-table");
  const pages = currentPaginatedLayout(settled);
  expect(pages?.columnsPerView).toBe(1);
  expect(pages?.layoutRepairs).toEqual({ status: "no-issues-detected" });
  // Taking the table away gives the section its two columns back.
  const recomputed = await page.evaluate(() =>
    window.__EPUB_TEXT_PAGINATION__!.removeCandidate("spanning"),
  );
  expect(currentPaginatedLayout(recomputed)?.columnsPerView).toBe(2);
});

test("scales a wide table to its column, whole and unbroken", async ({ page }) => {
  const settled = await setScenario(page, "wide-table");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "repaired",
    repairedElements: 1,
  });
  const frame = contentFrame(page);
  const candidate = frame.locator('[data-candidate="wide"]');
  await expect(candidate).toHaveAttribute("data-epub-navigator-fragmentation", /^m3-/);
  const column = await frame.locator("body").evaluate((body) => body.getBoundingClientRect().width);
  const geometry = await candidate.evaluate((element) => ({
    zoom: Number(getComputedStyle(element).zoom),
    width: element.getClientRects()[0]?.width ?? 0,
  }));
  expect(geometry.zoom).toBeLessThan(1);
  expect(geometry.zoom).toBeGreaterThan(0.8);
  expect(geometry.width).toBeLessThanOrEqual(column + 1);
});

test("leaves a table it would have to shrink below the smallest text, and says so", async ({
  page,
}) => {
  const settled = await setScenario(page, "unfit-table");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "unresolved",
    repairedElements: 0,
    unresolvedElements: 1,
  });
  const frame = contentFrame(page);
  const candidate = frame.locator('[data-candidate="unfit"]');
  await expect(candidate).not.toHaveAttribute("data-epub-navigator-fragmentation");
  await expect(candidate).toHaveCSS("zoom", "1");
});

test("avoids publisher marker and specificity ID collisions", async ({ page }) => {
  const settled = await setScenario(page, "collision");
  expect(currentPaginatedLayout(settled)?.layoutRepairs).toEqual({
    status: "unresolved",
    repairedElements: 1,
    unresolvedElements: 1,
  });
  const frame = contentFrame(page);
  const authored = frame.locator("#authored-marker");
  await expect(authored).toHaveAttribute("data-epub-navigator-fragmentation", "m3-1");
  await expect(authored).toHaveCSS("display", "inline");
  const safe = frame.locator('[data-candidate="collision-safe"]');
  await expect(safe).toHaveAttribute("data-epub-navigator-fragmentation", /^m3-/);
  await expect(safe).not.toHaveAttribute("data-epub-navigator-fragmentation", "m3-1");
  await expect(frame.locator('[data-candidate="collision-owned"]')).toHaveAttribute(
    "data-epub-navigator-fragmentation",
    "publisher-value",
  );
  await expect(frame.locator("#epub-navigator-fragmentation-a")).toHaveCSS("display", "inline");
  await expect(frame.locator("#epub-navigator-fragmentation-b")).toHaveCSS("display", "inline");
});

function contentFrame(page: Page): FrameLocator {
  return page.locator('iframe:not([aria-hidden="true"])').contentFrame();
}

async function snapshot(page: Page): Promise<KernelSnapshot> {
  return page.evaluate(() => window.__EPUB_TEXT_PAGINATION__!.snapshot());
}

async function setScenario(page: Page, scenario: Scenario): Promise<KernelSnapshot> {
  return page.evaluate((value) => window.__EPUB_TEXT_PAGINATION__!.setScenario(value), scenario);
}

async function setColumns(page: Page, columns: "single" | "double"): Promise<KernelSnapshot> {
  return page.evaluate((value) => window.__EPUB_TEXT_PAGINATION__!.setColumns(value), columns);
}

async function lineGeometry(
  frame: FrameLocator,
  id: string,
  columnOrigin: number,
  columnPitch: number,
) {
  return frame.locator(`[data-candidate="${id}"]`).evaluate(
    (candidate, geometry) => {
      const root = document.scrollingElement;
      if (root === null) throw new Error("the publication has no scrolling element");
      const pages: number[] = [];
      const rectangles: { top: number; bottom: number }[] = [];
      for (const line of candidate.querySelectorAll<HTMLElement>("[data-source-line]")) {
        const rectangle = line.getBoundingClientRect();
        pages.push(
          Math.max(
            0,
            Math.floor(
              (root.scrollLeft + rectangle.right - geometry.columnOrigin - 0.5) /
                geometry.columnPitch,
            ),
          ),
        );
        rectangles.push({ top: rectangle.top, bottom: rectangle.bottom });
      }
      return { pages, rectangles, viewportHeight: innerHeight };
    },
    { columnOrigin, columnPitch },
  );
}

async function traverseCandidate(
  frame: FrameLocator,
  snapshot: KernelSnapshot,
  id: string,
  pages: readonly number[],
): Promise<void> {
  const pagesLayout = currentPaginatedLayout(snapshot);
  if (pagesLayout === null) throw new Error("paginated layout is unavailable");
  const firstPage = Math.min(...pages);
  const lastPage = Math.max(...pages);
  const firstSpreadPage =
    Math.floor(firstPage / pagesLayout.columnsPerView) * pagesLayout.columnsPerView;
  await frame.locator("body").evaluate(
    (body, position) => {
      const root = document.scrollingElement;
      if (root === null) throw new Error("the publication has no scrolling element");
      root.scrollLeft = position;
      (body as HTMLElement).focus();
    },
    (firstSpreadPage / pagesLayout.columnsPerView) * pagesLayout.spreadStride,
  );

  const observed: string[] = [];
  for (
    let spreadPage = firstSpreadPage;
    spreadPage <= lastPage;
    spreadPage += pagesLayout.columnsPerView
  ) {
    observed.push(
      ...(await frame.locator(`[data-candidate="${id}"]`).evaluate((candidate) =>
        [...candidate.querySelectorAll<HTMLElement>("[data-source-line]")]
          .filter((line) => {
            const rectangle = line.getBoundingClientRect();
            return rectangle.right > 0 && rectangle.left < innerWidth;
          })
          .map((line) => line.dataset.sourceLine!),
      )),
    );
    if (spreadPage + pagesLayout.columnsPerView <= lastPage) {
      const previous = await frame.locator("html").evaluate((root) => Math.abs(root.scrollLeft));
      await frame.locator("html").evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
        );
      });
      await expect
        .poll(() => frame.locator("html").evaluate((root) => Math.abs(root.scrollLeft)))
        .toBeGreaterThan(previous);
    }
  }
  const unique = [...new Set(observed)];
  expect(unique).toEqual(Array.from({ length: 64 }, (_, line) => `${id}-${line}`));
}
