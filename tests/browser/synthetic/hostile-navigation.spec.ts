import { expect, test, type Page } from "@playwright/test";

test("classifies publisher-initiated hostile browser navigation in Chromium", async ({ page }) => {
  const requests: string[] = [];
  const downloads: string[] = [];
  const popups: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/_hostile-navigation/") ||
      request.url().endsWith("/epub/text/milestone-1-cross.xhtml")
    ) {
      requests.push(request.url());
    }
  });
  const finished: string[] = [];
  page.on("requestfinished", (request) => finished.push(request.url()));
  page.on("requestfailed", (request) => finished.push(request.url()));
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  page.on("popup", (popup) => popups.push(popup.url()));

  await page.goto("/synthetic/hostile-navigation.html");
  await expect(page.locator("#result")).toHaveAttribute("data-state", "ready", {
    timeout: 20_000,
  });
  const readerUrl = page.url();

  for (const kind of ["assign", "replace", "meta-refresh"] as const) {
    await expectPrimaryInvalidation(page, kind, requests, readerUrl, [kind]);
  }
  await expectPrimaryInvalidation(page, "redirect", requests, readerUrl, [
    "redirect/redirect",
    "target/redirect-redirect",
  ]);

  for (const kind of ["top", "parent", "blank", "named", "window-open"] as const) {
    const before = requests.length;
    const invalidations = (await fixtureState(page)).invalidations;
    const result = await trigger(page, kind);
    const state = await settledState(page, kind);
    expect(state.readerUrl).toBe(readerUrl);
    expect(state.committed).not.toBeNull();
    expect(state.frameCount).toBe(1);
    expect(state.invalidations).toBe(invalidations);
    expect(requests.slice(before), `${kind} request evidence`).toEqual([]);
    if (kind === "top" || kind === "parent") expect(result).toBe("SecurityError");
    else expect(result).toBeNull();
  }
  expect(popups).toEqual([]);

  const downloadRequestStart = requests.length;
  const downloadInvalidations = (await fixtureState(page)).invalidations;
  expect(await trigger(page, "download")).toBeNull();
  const downloadState = await settledState(page, "download");
  expect(downloadState.readerUrl).toBe(readerUrl);
  expect(downloadState.invalidations).toBe(downloadInvalidations);
  expect(requests.slice(downloadRequestStart)).toEqual([]);
  expect(downloads).toEqual([]);

  const attachmentRequestStart = requests.length;
  const attachmentInvalidations = (await fixtureState(page)).invalidations;
  expect(await trigger(page, "attachment")).toBeNull();
  await expect
    .poll(() => finished.some((url) => url.includes("/_hostile-navigation/attachment/")))
    .toBe(true);
  const attachmentState = await settledState(page, "attachment");
  expect(attachmentState.readerUrl).toBe(readerUrl);
  expect(attachmentState.committed).not.toBeNull();
  expect(attachmentState.frameCount).toBe(1);
  expect(attachmentState.invalidations).toBe(attachmentInvalidations);
  expect(requests.slice(attachmentRequestStart)).toEqual([
    expect.stringContaining("/_hostile-navigation/attachment/attachment"),
  ]);
  expect(downloads).toEqual([]);

  for (const [index, kind] of (["child-external", "child-publication"] as const).entries()) {
    const before = requests.length;
    const invalidations = (await fixtureState(page)).invalidations;
    expect(await trigger(page, kind)).toBeNull();
    const state = await settledState(page, kind);
    expect(state.readerUrl).toBe(readerUrl);
    expect(state.committed).not.toBeNull();
    expect(state.frameCount).toBe(1);
    expect(state.childFrames).toBe(index + 1);
    expect(state.invalidations).toBe(invalidations);
    expect(requests.slice(before), `${kind} request evidence`).toEqual([]);
  }
});

async function expectPrimaryInvalidation(
  page: Page,
  kind: "assign" | "replace" | "meta-refresh" | "redirect",
  requests: readonly string[],
  readerUrl: string,
  expectedRequestParts: readonly string[],
): Promise<void> {
  const requestStart = requests.length;
  const before = await fixtureState(page);
  expect(await trigger(page, kind)).toBeNull();
  await expect.poll(async () => (await fixtureState(page)).committed).toBeNull();
  const invalidated = await fixtureState(page);
  expect(invalidated.readerUrl).toBe(readerUrl);
  expect(invalidated.frameCount).toBe(0);
  expect(invalidated.invalidations).toBe(before.invalidations + 1);
  const attempted = requests.slice(requestStart);
  for (const part of expectedRequestParts) {
    expect(
      attempted.some((url) => url.includes(part)),
      `${kind} request ${part}`,
    ).toBe(true);
  }
  const recovered = await page.evaluate(() => window.hostileNavigationFixture.recover());
  expect(recovered.readerUrl).toBe(readerUrl);
  expect(recovered.committed).not.toBeNull();
  expect(recovered.frameCount).toBe(1);
}

function trigger(page: Page, kind: Parameters<Window["hostileNavigationFixture"]["trigger"]>[0]) {
  return page.evaluate((value) => window.hostileNavigationFixture.trigger(value, value), kind);
}

async function settledState(page: Page, id: string) {
  const probe = page.waitForRequest((request) => request.url().includes(`request-probe=${id}`));
  const state = await page.evaluate((value) => window.hostileNavigationFixture.settle(value), id);
  await probe;
  return state;
}

function fixtureState(page: Page) {
  return page.evaluate(() => window.hostileNavigationFixture.state());
}
