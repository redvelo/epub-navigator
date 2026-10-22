import { expect, test, type Page } from "@playwright/test";

test.use({ hasTouch: true });

const primary = 'iframe[data-epub-navigator-participant="primary"]';

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "touch dispatch over the devtools protocol");
  await page.goto("/synthetic/retired-frame.html");
  await expect
    .poll(() => page.evaluate(() => window.__EPUB_RETIRED_FRAME__ !== undefined))
    .toBe(true);
});

async function touchscreen(page: Page) {
  const box = (await page.locator(primary).boundingBox())!;
  const client = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", x?: number, y?: number) =>
    client.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: x === undefined || y === undefined ? [] : [{ x, y, id: 1 }],
    });
  return { box, send };
}

test("keeps a retired frame attached until the touch that started in it ends", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  const participants = () => page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.participants());
  const { box, send } = await touchscreen(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await send("touchStart", x, y);
  await page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.open(1));
  await page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.flush());
  expect((await participants()).filter((role) => role === "retired")).toHaveLength(1);

  await send("touchEnd");
  await expect.poll(participants).not.toContain("retired");

  const frame = page.frameLocator(primary);
  await frame.locator("body").evaluate((body) => {
    window.addEventListener("pointerdown", () => body.setAttribute("data-pointerdown", "seen"), {
      capture: true,
    });
  });
  await send("touchStart", x, y);
  await send("touchEnd");
  await expect(frame.locator("body")).toHaveAttribute("data-pointerdown", "seen");

  await page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.open(2));
  await expect.poll(participants).not.toContain("retired");
  expect(pageErrors).toEqual([]);
});

test("turns pages with horizontal swipes and ignores vertical drags", async ({ page }) => {
  const position = () => page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.position());
  await page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.open(3));
  await expect.poll(async () => (await position()).page).toBe(0);
  const { box, send } = await touchscreen(page);
  const swipe = async (fromX: number, toX: number, fromY: number, toY: number) => {
    const steps = 6;
    await send("touchStart", fromX, fromY);
    for (let step = 1; step <= steps; step += 1) {
      await send(
        "touchMove",
        fromX + ((toX - fromX) * step) / steps,
        fromY + ((toY - fromY) * step) / steps,
      );
    }
    await send("touchEnd");
    await page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.flush());
  };
  const interactions = () => page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.interactions());
  const y = box.y + box.height / 2;
  await swipe(box.x + box.width * 0.7, box.x + box.width * 0.3, y, y);
  await expect.poll(async () => (await position()).occurrence).toBe(4);
  await swipe(box.x + box.width * 0.3, box.x + box.width * 0.7, y, y);
  await expect.poll(async () => (await position()).occurrence).toBe(3);
  const x = box.x + box.width / 2;
  const before = await interactions();
  // Clear of the bands that reveal reader chrome, so this drag has nothing at all to do.
  await swipe(x, x + 10, box.y + box.height * 0.6, box.y + box.height * 0.4);
  await swipe(x, x - 20, y, y);
  expect(await interactions()).toBe(before);
  expect((await position()).occurrence).toBe(3);
});

test("leaves a scrolled section on a horizontal swipe and scrolls it on a page key", async ({
  page,
}) => {
  const harness = () => page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.position());
  await page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.open(3));
  await page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.scroll());
  const content = page.frameLocator(primary).locator("html");
  const scrollTop = () => content.evaluate((root) => root.scrollTop);
  // The swipe has to be answered from a document with text still below it, or moving on would
  // only be the boundary behaviour this already had.
  await page
    .frameLocator(primary)
    .locator("body")
    .evaluate((body) => ((body as HTMLElement).style.minHeight = "400vh"));
  await expect
    .poll(() => content.evaluate((root) => root.scrollHeight - root.clientHeight))
    .toBeGreaterThan(200);
  expect(await scrollTop()).toBe(0);

  const { box, send } = await touchscreen(page);
  const y = box.y + box.height / 2;
  const steps = 6;
  const fromX = box.x + box.width * 0.7;
  const toX = box.x + box.width * 0.3;
  await send("touchStart", fromX, y);
  for (let step = 1; step <= steps; step += 1) {
    await send("touchMove", fromX + ((toX - fromX) * step) / steps, y);
  }
  await send("touchEnd");
  await page.evaluate(() => window.__EPUB_RETIRED_FRAME__!.flush());
  await expect.poll(async () => (await harness()).occurrence).toBe(4);

  // The block axis is still the text's: a page key moves within the section it is in.
  await page
    .frameLocator(primary)
    .locator("body")
    .evaluate((body) => {
      (body as HTMLElement).style.minHeight = "400vh";
      body.tabIndex = -1;
      body.focus();
    });
  await expect
    .poll(() => content.evaluate((root) => root.scrollHeight - root.clientHeight))
    .toBeGreaterThan(200);
  await page.keyboard.press("PageDown");
  await expect.poll(scrollTop).toBeGreaterThan(0);
  expect((await harness()).occurrence).toBe(4);
});
