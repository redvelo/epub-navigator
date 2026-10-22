import type { Locator, Page, Request } from "@playwright/test";
import {
  alice,
  expect,
  cachedResources,
  reader as readerView,
  readerFrame,
  returnToLibrary,
  test,
} from "./helpers.js";

test("searches persisted analysis and activates an authored result", async ({
  page,
  openPublication,
}) => {
  test.setTimeout(120_000);
  await openPublication(alice);

  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  const openSearch = navigation.getByRole("button", { name: "Search publication" });
  await expect(openSearch).toBeEnabled();
  await openSearch.click();
  const search = page.getByRole("dialog", { name: "Search" });
  const input = search.getByRole("searchbox", { name: "Search publication" });
  await input.fill("rabbit-hole");
  await input.press("Enter");

  await expect(search.getByRole("status")).toContainText(/result/u);
  const result = search.locator(".epub-navigator-reader__search-results button").first();
  await expect(result).toContainText(/rabbit-hole/iu);
  await result.click();
  await expect(readerFrame(page)).toHaveAttribute("src", /chapter-1\.xhtml$/u);
});

test("promotes an analyzed static adjacent section without loading state", async ({
  page,
  openPublication,
}) => {
  test.setTimeout(60_000);
  await openPublication(alice);
  const prepared = page.locator(
    '[data-epub-navigator-frame-stack] > iframe[aria-hidden="true"][src*="/publications/"]',
  );
  await expect(prepared).toHaveCount(1, { timeout: 30_000 });
  await expect
    .poll(() =>
      prepared
        .contentFrame()
        .locator('style[data-epub-navigator-configuration="m3"]')
        .textContent(),
    )
    .toContain("column-count");
  await prepared.evaluate((element) => element.setAttribute("data-prepared-promotion-test", ""));
  await readerFrame(page).evaluate((element) =>
    element.setAttribute("data-prepared-outgoing-test", ""),
  );
  const loadingObserved = await watchForSelector(page, '[data-reader-status="loading"]');

  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Navigation" })
    .getByRole("button", { name: /Imprint/u })
    .click();

  const promoted = page.locator("iframe[data-prepared-promotion-test]");
  await expect(promoted).not.toHaveAttribute("aria-hidden", "true");
  await expect(promoted).toBeVisible();
  const nextPrepared = page.locator(
    '[data-epub-navigator-frame-stack] > iframe[aria-hidden="true"][src*="/publications/"]:not([data-prepared-outgoing-test])',
  );
  await expect
    .poll(
      () =>
        nextPrepared.evaluateAll(
          (elements) =>
            elements.length > 0 &&
            elements.every((element) =>
              (element as HTMLIFrameElement).contentDocument
                ?.querySelector<HTMLStyleElement>('style[data-epub-navigator-configuration="m3"]')
                ?.textContent?.includes("column-count"),
            ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(readerView(page)).toHaveAttribute("data-reader-status", "ready");
  expect(await loadingObserved()).toBe(false);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelectorAll("[data-epub-navigator-frame-stack] > iframe").length,
      ),
    )
    .toBeLessThanOrEqual(3);
});

test("repaginates from a later page without losing position or exact progress", async ({
  page,
  openPublication,
}) => {
  test.setTimeout(120_000);
  await openPublication(alice);
  const reader = readerView(page);
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await navigation.getByRole("button", { name: /Toggle Alice.s Adventures/u }).click();
  await navigation.getByRole("button", { name: /Down the Rabbit-Hole/u }).click();
  const frame = readerFrame(page);
  await expect(frame).toBeVisible();
  await expect
    .poll(async () => Number(await reader.getAttribute("data-section-page-count")))
    .toBeGreaterThan(2);
  await scrollToPage(frame, 1);
  await expect
    .poll(async () => Number(await reader.getAttribute("data-section-first-visible-page")))
    .toBeGreaterThan(0);
  await expect(reader).toHaveAttribute("data-pagination-coverage", "exact", { timeout: 45_000 });
  const progress = page.getByRole("progressbar", { name: "Reading progress" });
  await expect(progress).toHaveAttribute("data-accuracy", "exact");
  const estimatedObserved = await watchForSelector(
    page,
    '[role="progressbar"][data-accuracy="estimated"]',
  );

  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Line spacing" })
    .getByRole("radio", { name: "1.25x" })
    .click();
  await page.getByRole("button", { name: "Close reading settings" }).click();

  await expect
    .poll(
      async () =>
        `${await reader.getAttribute("data-pagination-coverage")}:${await reader.getAttribute("data-pagination-activity")}`,
      { timeout: 45_000 },
    )
    .toBe("exact:idle");
  await expect
    .poll(async () => Number(await reader.getAttribute("data-section-first-visible-page")))
    .toBeGreaterThan(0);
  await expect(progress).toHaveAttribute("data-accuracy", "exact");
  expect(await estimatedObserved()).toBe(false);

  const preparedNext = page.locator(
    'iframe[aria-hidden="true"][src$="/epub/text/chapter-2.xhtml"]',
  );
  await expect(preparedNext).toHaveCount(1, { timeout: 30_000 });
  await expect(
    preparedNext.contentFrame().locator('style[data-epub-navigator-configuration="m3"]'),
  ).toBeAttached();
  await preparedNext.evaluate((element) =>
    element.setAttribute("data-repagination-promotion-test", ""),
  );
  const loadingObserved = await watchForSelector(page, '[data-reader-status="loading"]');
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  const reopenedNavigation = page.getByRole("dialog", { name: "Navigation" });
  const disclosure = reopenedNavigation.getByRole("button", {
    name: /Toggle Alice.s Adventures/u,
  });
  if ((await disclosure.getAttribute("aria-expanded")) !== "true") await disclosure.click();
  await reopenedNavigation.getByRole("button", { name: /Pool of Tears/u }).click();
  await expect(page.locator("iframe[data-repagination-promotion-test]")).not.toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(reader).toHaveAttribute("data-reader-status", "ready");
  expect(await loadingObserved()).toBe(false);
});

test("imports, serves, and reopens a local publication", async ({ page, openPublication }) => {
  test.setTimeout(120_000);
  await openPublication(alice);
  const reader = readerView(page);
  const frame = readerFrame(page);
  const documentUrl = (await frame.getAttribute("src"))!;
  const { id, resources } = await cachedResources(page);
  const svg = resources
    .filter((resource) => resource.mediaType === "image/svg+xml")
    .sort((left, right) => left.sizeBytes - right.sizeBytes)[0]!;
  expect(svg.responseInstrumentation).toBe("none");
  expect(resources.map((resource) => resource.responseInstrumentation)).toContain("xhtml");
  const cacheState = await page.evaluate(
    async ({ id, url, svgPath }) => {
      const cache = await caches.open(`epub-navigator:${id}`);
      const keys = await cache.keys();
      const authored = async (suffix: string) =>
        (await cache.match(keys.find((key) => key.url.endsWith(suffix))!))!.text();
      const served = await fetch(url);
      const measurement = await fetch(url.replace("/publications/", "/measurements/"));
      const stylesheet = await fetch(new URL("../css/core.css", url));
      const svgUrl = `/publications/${id}/${svgPath}`;
      const servedSvg = await fetch(svgUrl);
      return {
        authored: await authored(".xhtml"),
        accessControl: served.headers.get("access-control-allow-origin"),
        contentType: served.headers.get("content-type"),
        served: await served.text(),
        measurementCsp: measurement.headers.get("content-security-policy"),
        measurementText: await measurement.text(),
        stylesheetStatus: stylesheet.status,
        stylesheetContentType: stylesheet.headers.get("content-type"),
        stylesheetText: await stylesheet.text(),
        rangeStatus: (await fetch(url, { headers: { Range: "bytes=0-1" } })).status,
        queryStatus: (await fetch(`${url}?route=invalid`)).status,
        svgContentType: servedSvg.headers.get("content-type"),
        authoredSvg: await authored(`/resources/${id}/${svgPath}`),
        servedSvg: await servedSvg.text(),
        measuredSvg: await (await fetch(svgUrl.replace("/publications/", "/measurements/"))).text(),
      };
    },
    { id, url: documentUrl, svgPath: svg.path },
  );
  expect(cacheState.authored).not.toContain("content-agent.js");
  expect(cacheState.accessControl).toBe("*");
  expect(cacheState.contentType).toContain("application/xhtml+xml");
  expect(cacheState.served).toContain("content-agent.js");
  expect(cacheState.served).toContain("data-epub-navigator-reader-font");
  expect(cacheState.served.indexOf("reader-serif.css")).toBeLessThan(
    cacheState.served.indexOf("content-agent.js"),
  );
  const measurementNonce = cacheState.measurementText.match(
    /<script xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" src="[^"]*content-agent\.js" nonce="([0-9a-f]+)"><\/script>/u,
  )?.[1];
  expect(measurementNonce).toBeDefined();
  expect(cacheState.measurementCsp).toContain(`script-src 'nonce-${measurementNonce}'`);
  expect(cacheState.measurementCsp).toContain("script-src-attr 'none'");
  expect(cacheState.stylesheetStatus).toBe(200);
  expect(cacheState.stylesheetContentType).toContain("text/css");
  expect(cacheState.stylesheetText).toContain("font-variant-numeric");
  expect(cacheState.rangeStatus).toBe(416);
  expect(cacheState.queryStatus).toBe(400);
  expect(cacheState.svgContentType).toContain("image/svg+xml");
  expect(cacheState.servedSvg).toBe(cacheState.authoredSvg);
  expect(cacheState.measuredSvg).toBe(cacheState.authoredSvg);
  await expect(page.locator("[data-epub-pagination-session]")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.querySelectorAll("[data-epub-pagination-session] iframe").length,
        ),
      { timeout: 30_000 },
    )
    .toBeLessThanOrEqual(2);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const name = (await caches.keys()).find((candidate) =>
            candidate.startsWith("epub-navigator-pagination:"),
          );
          if (name === undefined) return 0;
          return (await (await caches.open(name)).keys()).length;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(1);
  await expect
    .poll(
      async () => {
        const coverage = await reader.getAttribute("data-pagination-coverage");
        const activity = await reader.getAttribute("data-pagination-activity");
        return coverage === "exact" || activity !== "idle" ? coverage : `${coverage}:${activity}`;
      },
      { timeout: 45_000 },
    )
    .toBe("exact");
  const totalOccurrences = await reader.getAttribute("data-pagination-total");
  if (totalOccurrences === null) throw new Error("the pagination occurrence total is missing");
  await expect(reader).toHaveAttribute("data-pagination-measured", totalOccurrences);
  await expect(reader).toHaveAttribute("data-pagination-toc", "complete", {
    timeout: 45_000,
  });
  const totalTargets = await reader.getAttribute("data-pagination-targets-total");
  if (totalTargets === null) throw new Error("the pagination target total is missing");
  await expect(reader).toHaveAttribute("data-pagination-targets-measured", totalTargets);
  await expect(reader).toHaveAttribute("data-section-first-visible-page", "0");
  await expect
    .poll(async () => Number(await reader.getAttribute("data-section-page-count")))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => Number(await reader.getAttribute("data-pagination-page-count")))
    .toBeGreaterThan(1);
  const progress = page.getByRole("progressbar", { name: "Reading progress" });
  await expect(progress).toHaveAttribute("data-accuracy", "exact");
  await expect(progress).toHaveAttribute("aria-valuetext", /Exact progress, page 1 of \d+/u);
  await expect
    .poll(async () => Number(await reader.getAttribute("data-pagination-publication-sequence")))
    .toBeGreaterThan(0);
  const initialToc = await visibleTocDestinationText(page);
  expect(initialToc.length).toBeGreaterThan(0);
  expect(initialToc.every((destination) => /\d+$/u.test(destination))).toBe(true);
  await expect(reader).toHaveAttribute("data-section-first-visible-page", "0");

  await page.waitForFunction(
    () => {
      const iframe = document.querySelector(
        'iframe:not([aria-hidden="true"])[title$="publication content"]',
      ) as HTMLIFrameElement | null;
      if (iframe === null) return false;
      const publicationDocument = iframe.contentDocument;
      if (publicationDocument === null) return false;
      const image = publicationDocument.querySelector("img");
      const view = iframe.contentWindow;
      return (
        view !== null &&
        view.navigator.serviceWorker.controller !== null &&
        publicationDocument.styleSheets.length >= 3 &&
        image !== null &&
        image.complete &&
        image.naturalWidth > 0 &&
        getComputedStyle(image).display === "block"
      );
    },
    { timeout: 30_000 },
  );
  const frameState = await frame.evaluate((element) => {
    const iframe = element as HTMLIFrameElement;
    const publicationDocument = iframe.contentDocument;
    const view = iframe.contentWindow;
    if (publicationDocument === null || view === null) {
      throw new Error("the publication frame document is unavailable");
    }
    const image = publicationDocument.querySelector("img");
    const paragraph = publicationDocument.querySelector("p");
    if (image === null) throw new Error("the publication image is unavailable");
    if (paragraph === null) throw new Error("the publication paragraph is unavailable");
    return {
      imageDisplay: getComputedStyle(image).display,
      imageWidth: image.naturalWidth,
      fontFamily: getComputedStyle(publicationDocument.body ?? publicationDocument.documentElement)
        .fontFamily,
      paragraphFontFamily: getComputedStyle(paragraph).fontFamily,
      rootFontSize: getComputedStyle(publicationDocument.documentElement).fontSize,
      readerSerifLoaded: publicationDocument.fonts.check('20px "Navigator Reader Serif"'),
      sandbox: iframe.getAttribute("sandbox"),
      sameOrigin: view.location.origin === location.origin,
      serviceWorkerControlled: view.navigator.serviceWorker.controller !== null,
      stylesheetCount: publicationDocument.styleSheets.length,
    };
  });
  expect(frameState.sameOrigin).toBe(true);
  expect(frameState.sandbox).toBe("allow-scripts allow-same-origin");
  expect(frameState.serviceWorkerControlled).toBe(true);
  expect(frameState.stylesheetCount).toBeGreaterThanOrEqual(3);
  expect(frameState.imageDisplay).toBe("block");
  expect(frameState.imageWidth).toBeGreaterThan(0);
  expect(frameState.fontFamily).toContain("Navigator Reader Serif");
  expect(frameState.paragraphFontFamily).toContain("Navigator Reader Serif");
  expect(frameState.rootFontSize).toBe("20px");
  expect(frameState.readerSerifLoaded).toBe(true);

  const readerAssets = await page.evaluate(async () => {
    const stylesheet = await fetch("/reader-fonts/reader-serif.css");
    const css = await stylesheet.text();
    const fontPath = css.match(/\.\/files\/([^)'"\s]+)/)?.[1];
    if (fontPath === undefined) throw new Error("the Reader Serif stylesheet has no font URL");
    const font = await fetch(`/reader-fonts/files/${fontPath}`);
    const agent = await fetch("/content-agent.js");
    return {
      stylesheetType: stylesheet.headers.get("content-type"),
      fontStatus: font.status,
      fontType: font.headers.get("content-type"),
      agentText: await agent.text(),
    };
  });
  expect(readerAssets.stylesheetType).toContain("text/css");
  expect(readerAssets.fontStatus).toBe(200);
  expect(readerAssets.fontType).toBe("font/woff2");
  expect(readerAssets.agentText).not.toContain("Literata Variable");

  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  await page.getByRole("radio", { name: "Light" }).click();
  await expect
    .poll(() =>
      frame
        .contentFrame()
        .locator(":root")
        .evaluate((root) => getComputedStyle(root).backgroundColor),
    )
    .toBe("rgb(255, 255, 255)");
  await expect
    .poll(() =>
      frame
        .contentFrame()
        .locator("p")
        .first()
        .evaluate((paragraph) => getComputedStyle(paragraph).color),
    )
    .toBe("rgb(0, 0, 0)");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const lineSpacing = page.getByRole("radiogroup", { name: "Line spacing" });
  const widestLineSpacing = lineSpacing.getByRole("radio", { name: "2x" });
  await widestLineSpacing.click();
  await expect(widestLineSpacing).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() =>
      frame
        .contentFrame()
        .locator("p")
        .first()
        .evaluate((paragraph) => {
          const style = getComputedStyle(paragraph);
          return Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize);
        }),
    )
    .toBeCloseTo(2, 1);
  await page
    .getByRole("radiogroup", { name: "Book colors" })
    .getByRole("radio", { name: "Auto" })
    .click();
  await page.getByRole("button", { name: "Close reading settings" }).click();

  await expect
    .poll(async () => {
      return [
        await reader.getAttribute("data-pagination-coverage"),
        await reader.getAttribute("data-pagination-activity"),
        await reader.getAttribute("data-pagination-toc"),
      ].join(":");
    })
    .not.toBe("exact:idle:complete");
  await expect(reader).toHaveAttribute("data-pagination-coverage", "exact", {
    timeout: 45_000,
  });
  await expect(reader).toHaveAttribute("data-pagination-activity", "idle", {
    timeout: 45_000,
  });
  await expect(reader).toHaveAttribute("data-pagination-toc", "complete", {
    timeout: 45_000,
  });
  // Counts are written after the catalog completes, so reopening only restores what the write
  // queue has drained. Reloading before then re-measures the tail.
  await expect(reader).toHaveAttribute("data-pagination-cache", "idle", { timeout: 45_000 });
  const measurementRequests: string[] = [];
  const captureMeasurementRequest = (request: Request) => {
    if (new URL(request.url()).pathname.includes("/measurements/")) {
      measurementRequests.push(request.url());
    }
  };
  page.on("request", captureMeasurementRequest);
  await page.reload();
  await expect(frame).toBeVisible({ timeout: 30_000 });
  await expect(reader).toHaveAttribute("data-pagination-coverage", "exact", {
    timeout: 30_000,
  });
  await expect(reader).toHaveAttribute("data-pagination-activity", "idle", {
    timeout: 30_000,
  });
  await expect(reader).toHaveAttribute("data-pagination-toc", "complete", {
    timeout: 30_000,
  });
  const restoredToc = await visibleTocDestinationText(page);
  expect(restoredToc.length).toBeGreaterThan(0);
  expect(restoredToc.every((destination) => !destination.endsWith("..."))).toBe(true);
  page.off("request", captureMeasurementRequest);
  expect(measurementRequests).toEqual([]);

  await returnToLibrary(page);

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.unregister();
  });
  await page.reload();
  await expect(reader).toBeVisible({ timeout: 30_000 });

  await expect(page.getByRole("button", { name: "Navigation", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await returnToLibrary(page);
  await page.getByRole("button", { name: /Remove Alice/u }).click();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await caches.keys()).filter(
            (name) =>
              name.startsWith("epub-navigator:") || name.startsWith("epub-navigator-pagination:"),
          ).length,
      ),
    )
    .toBe(0);
});

test("persists reading position and point bookmarks across library reopen", async ({
  page,
  openPublication,
}) => {
  test.setTimeout(120_000);
  const positionMessages: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Reading position")) positionMessages.push(message.text());
  });
  await openPublication(alice);

  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Navigation" })
    .getByRole("button", { name: /Imprint/u })
    .click();
  await expect(page.getByRole("button", { name: /Show Imprint in contents/u })).toBeVisible();

  await page.getByRole("button", { name: "Annotations", exact: true }).click();
  const annotations = page.getByRole("dialog", { name: "Annotations" });
  const addBookmark = annotations.getByRole("button", {
    name: "Add bookmark at current location",
  });
  await expect(addBookmark).toBeEnabled();
  await addBookmark.click();
  const bookmark = annotations
    .getByRole("region", { name: "Imprint" })
    .locator("[data-annotation-id]")
    .filter({ has: page.getByRole("button", { name: /^Go to bookmark/u }) });
  await expect(bookmark).toBeVisible();
  await page.getByRole("button", { name: "Close annotations panel" }).click();

  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await navigation.getByRole("button", { name: /Toggle Alice.s Adventures/u }).click();
  await navigation.getByRole("button", { name: /Down the Rabbit-Hole/u }).click();
  await expect(
    page.getByRole("button", { name: /Show .*Down the Rabbit-Hole in contents/u }),
  ).toBeVisible();
  const reader = readerView(page);
  const chapterFrame = readerFrame(page);
  await expect
    .poll(async () => Number(await reader.getAttribute("data-section-page-count")))
    .toBeGreaterThan(4);
  await scrollToPage(chapterFrame, 2);
  await expect
    .poll(async () => Number(await reader.getAttribute("data-section-first-visible-page")))
    .toBeGreaterThan(1);
  const savedPage = Number(await reader.getAttribute("data-section-first-visible-page"));

  await page.getByRole("button", { name: "Annotations", exact: true }).click();
  const chapterAnnotations = page.getByRole("dialog", { name: "Annotations" });
  const addChapterBookmark = chapterAnnotations.getByRole("button", {
    name: "Add bookmark at current location",
  });
  await expect(addChapterBookmark).toBeEnabled();
  await addChapterBookmark.click();
  await expect(
    chapterAnnotations
      .getByRole("region", { name: /Down the Rabbit-Hole/u })
      .locator("[data-annotation-id]")
      .filter({ has: page.getByRole("button", { name: /^Go to bookmark/u }) }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close annotations panel" }).click();

  await returnToLibrary(page);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("epub-navigator-reader", 3);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise<string | null>((resolve, reject) => {
            const request = database
              .transaction("reading-positions")
              .objectStore("reading-positions")
              .getAll();
            request.onsuccess = () => resolve(request.result[0]?.occurrenceHint?.resource ?? null);
            request.onerror = () => reject(request.error);
          });
        } finally {
          database.close();
        }
      }),
    )
    .toMatch(/chapter-1\.xhtml$/u);
  await page.locator("main li button").first().click();
  await expect(readerView(page)).toBeVisible({ timeout: 30_000 });
  const frame = readerFrame(page);
  await expect(frame).toHaveAttribute("src", /chapter-1\.xhtml$/, { timeout: 30_000 });
  await expect(reader).toHaveAttribute("data-section-first-visible-page", String(savedPage));
  expect(positionMessages).toEqual([]);

  const navigationButton = page.getByRole("button", { name: "Navigation", exact: true });
  await expect(navigationButton).toHaveAttribute("aria-pressed", "false");
  await scrollToPage(frame, 1);
  await expect
    .poll(async () => Number(await reader.getAttribute("data-section-first-visible-page")))
    .not.toBe(savedPage);
  const latestPage = Number(await reader.getAttribute("data-section-first-visible-page"));
  expect(latestPage).toBeGreaterThan(0);
  await returnToLibrary(page);
  await page.locator("main li button").first().click();
  await expect(frame).toHaveAttribute("src", /chapter-1\.xhtml$/, { timeout: 30_000 });
  await expect(reader).toHaveAttribute("data-section-first-visible-page", String(latestPage));
  expect(positionMessages).toEqual([]);
  await expect(navigationButton).toHaveAttribute("aria-pressed", "false");

  await navigationButton.click();
  await page
    .getByRole("dialog", { name: "Navigation" })
    .getByRole("button", { name: /Imprint/u })
    .click();
  await expect(frame).toHaveAttribute("src", /imprint\.xhtml$/);
  await page.getByRole("button", { name: "Annotations", exact: true }).click();
  const restoredAnnotations = page.getByRole("dialog", { name: "Annotations" });
  const restoredChapterBookmark = restoredAnnotations
    .getByRole("region", { name: /Down the Rabbit-Hole/u })
    .locator("[data-annotation-id]");
  await restoredChapterBookmark.getByRole("button", { name: /Go to bookmark/u }).click();
  await expect
    .poll(async () => Number(await reader.getAttribute("data-section-first-visible-page")))
    .toBe(savedPage);

  const restoredImprintBookmark = restoredAnnotations
    .getByRole("region", { name: "Imprint" })
    .locator("[data-annotation-id]");
  await restoredImprintBookmark.getByRole("button", { name: /Go to bookmark/u }).click();
  await expect(frame).toHaveAttribute("src", /imprint\.xhtml$/);
});

async function watchForSelector(page: Page, selector: string): Promise<() => Promise<boolean>> {
  await page.evaluate((target) => {
    const observed = window as unknown as Record<string, boolean>;
    const record = () => {
      if (document.querySelector(target) !== null) observed[`observed:${target}`] = true;
    };
    observed[`observed:${target}`] = false;
    new MutationObserver(record).observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    record();
  }, selector);
  return () =>
    page.evaluate(
      (target) => (window as unknown as Record<string, boolean>)[`observed:${target}`]!,
      selector,
    );
}

async function scrollToPage(frame: Locator, pageIndex: number): Promise<void> {
  await frame
    .contentFrame()
    .locator(":root")
    .evaluate((root, index) => {
      root.scrollLeft = innerWidth * index;
      dispatchEvent(new Event("scroll"));
    }, pageIndex);
}

async function visibleTocDestinationText(page: Page): Promise<string[]> {
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await expect(dialog).toBeVisible();
  const destinations = dialog.locator("ol button:not([aria-label])");
  await expect(destinations.first()).toBeVisible();
  const text = await destinations.evaluateAll((elements) =>
    elements.map((element) => element.textContent?.replace(/\s+/gu, " ").trim() ?? ""),
  );
  await page.getByRole("button", { name: "Close navigation panel" }).click();
  await expect(dialog).toBeHidden();
  return text;
}
