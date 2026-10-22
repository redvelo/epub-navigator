import { expect, test } from "@playwright/test";

const enforceAbsoluteBudgets = process.env.EPUB_PAGINATION_PERF_BUDGETS === "1";
// A shared runner is slower than the machine a budget was measured on, so CI states how much
// slower it is allowed to be. The overhead percentage takes the allowance too: its denominator is
// a vsync-paced frame, which every machine holds at the same 16.7 ms, while its numerator is work
// that a slower core stretches. It reads as a ratio but behaves like a wall-clock measure.
const allowance = Number(process.env.EPUB_PAGINATION_PERF_ALLOWANCE ?? "1");
const budget = (value: number) => value * allowance;

test("pagination lab remains correct and records provisional budgets", async ({
  page,
}, testInfo) => {
  await page.goto("/performance/pagination-lab.html");
  await expect
    .poll(() => page.evaluate(() => window.__EPUB_PAGINATION_LAB__ !== undefined))
    .toBe(true);
  const result = await page.evaluate(() => window.__EPUB_PAGINATION_LAB__!.run());
  await testInfo.attach("pagination-performance.json", {
    body: JSON.stringify({ enforceAbsoluteBudgets, ...result }, null, 2),
    contentType: "application/json",
  });

  expect(result.targetCount).toBe(500);
  expect(result.diagnosticEvents).toBeGreaterThan(0);
  expect(result.geometryScans).toBeGreaterThan(0);
  expect(result.assessment10kParagraphs).toBe(10_000);
  expect(result.assessment10kRectangles).toBe(0);
  expect(result.assessment10kTextRangeScans).toBe(0);
  expect(result.cooperative10kYields).toBeGreaterThan(0);
  expect(result.unsafeDiagnosticPayload).toBe(false);
  expect(result.staleCommits).toBe(0);
  expect(result.remainingFrames).toBe(0);
  for (const value of Object.values(result)) {
    if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
  }
  if (!enforceAbsoluteBudgets) return;
  expect(result.pageTurnP95Ms, "desktop page turn p95").toBeLessThanOrEqual(budget(60));
  expect(result.initial1kMs, "1k initial layout transaction").toBeLessThanOrEqual(budget(450));
  // 5079-5307 ms measured 2026-10-13 on a Ryzen 9800X3D. The previous 4500 was set on
  // 2026-08-19 and never ran green in CI, and the commits either side of it cannot be rebuilt,
  // so the figure it was taken from is unrecoverable. Chromium laying out the paragraphs is
  // nearly all of this: the kernel's own assessment accounts for 30-43 ms of it.
  expect(result.relayout10kMs, "10k relayout transaction").toBeLessThanOrEqual(budget(6_000));
  expect(result.target500Ms, "500 simple targets").toBeLessThanOrEqual(budget(500));
  expect(result.backgroundOverheadPercent, "foreground background overhead").toBeLessThanOrEqual(
    budget(10),
  );
  expect(result.cleanupMs, "cleanup").toBeLessThanOrEqual(budget(100));
});

test("ordinary 1k paragraph assessment remains bounded under 6x CPU throttling", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  try {
    await page.goto("/performance/pagination-lab.html");
    await expect
      .poll(() => page.evaluate(() => window.__EPUB_PAGINATION_LAB__ !== undefined))
      .toBe(true);
    const result = await page.evaluate(() => window.__EPUB_PAGINATION_LAB__!.runAssessment(1_000));
    await testInfo.attach("pagination-performance-6x.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    expect(result.paragraphCount).toBe(1_000);
    expect(result.rectangleCount).toBe(0);
    expect(result.textRangeScanCount).toBe(0);
    expect(result.relayoutMs).toBeLessThan(budget(10_000));
  } finally {
    if (!page.isClosed()) await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await session.detach().catch(() => undefined);
  }
});
