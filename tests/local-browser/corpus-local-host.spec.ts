import { readFile } from "node:fs/promises";
import type { ConsoleMessage, Locator, Page } from "@playwright/test";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { corpusPublication } from "../fixtures/epub3-samples/catalog.js";
import {
  cachedResources,
  expect,
  fixture,
  reader,
  readerFrame,
  returnToLibrary,
  test,
  type PublicationFilePayload,
} from "./helpers.js";

const corpus = (name: string): string => fixture(`epub3-samples/${name}`);
const svgInjection =
  /<script xmlns="http:\/\/www\.w3\.org\/2000\/svg" href="[^"]*content-agent\.js"><\/script>/u;

test("imports, serves, and reopens SVG in Spine", async ({ page, openPublication }) => {
  test.setTimeout(90_000);
  const { blake3 } = corpusPublication("svg-in-spine")!;
  const coverPath = "OPS/Images/cover.svg";
  const coverUrl = `http://127.0.0.1:4176/publications/${blake3}/${coverPath}`;
  const coverResponse = page.waitForResponse(
    (response) => response.url() === coverUrl && response.request().resourceType() === "document",
  );
  await openPublication(corpus("svg-in-spine.epub"), 60_000);
  await expectFixedSvg(page, coverUrl);
  expect((await coverResponse).headers()["content-type"]).toContain("image/svg+xml");

  const { id, resources } = await cachedResources(page);
  expect(id).toBe(blake3);
  expect(resources.find((resource) => resource.path === coverPath)).toMatchObject({
    mediaType: "image/svg+xml",
    responseInstrumentation: "svg",
    executableContent: "analyzed-absent",
    foregroundPreparation: "eligible",
  });
  const serving = await page.evaluate(
    async ({ id, path, url }) => {
      const cache = await caches.open(`epub-navigator:${id}`);
      const key = (await cache.keys()).find((request) =>
        request.url.endsWith(`/resources/${id}/${path}`),
      );
      const authored = async () => (await cache.match(key!))!.text();
      const before = await authored();
      const served = await fetch(url);
      const head = await fetch(url, { method: "HEAD" });
      const text = await served.text();
      return {
        before,
        after: await authored(),
        served: text,
        servedBytes: String(new TextEncoder().encode(text).byteLength),
        contentLength: served.headers.get("content-length"),
        headContentLength: head.headers.get("content-length"),
        policies: [
          served.headers.get("content-security-policy"),
          head.headers.get("content-security-policy"),
        ],
      };
    },
    { id, path: coverPath, url: coverUrl },
  );
  expect(serving.served).toMatch(svgInjection);
  expect(serving.served.replace(svgInjection, "")).toBe(serving.before);
  expect(serving.after).toBe(serving.before);
  expect(serving.contentLength).toBe(serving.servedBytes);
  expect(serving.headContentLength).toBe(serving.servedBytes);
  for (const policy of serving.policies) expectForegroundScriptPolicy(policy);

  await expect
    .poll(() =>
      evaluateReaderDocument(page, () => {
        const artwork = document.getElementById("path3337_1_")?.getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          visible: artwork !== undefined && artwork.width > 0 && artwork.height > 0,
        };
      }),
    )
    .toEqual({ viewport: { width: 1571, height: 2068 }, visible: true });

  await page.reload();
  await expectFixedSvg(page, coverUrl);
  await expect
    .poll(() => evaluateReaderDocument(page, () => ({ width: innerWidth, height: innerHeight })))
    .toEqual({ width: 1571, height: 2068 });
});

test("imports and reopens a locally transformed scripted SVG", async ({
  page,
  openPublication,
}) => {
  test.setTimeout(90_000);
  const coverPath = "OPS/Images/cover.svg";
  const scriptPath = "OPS/Scripts/cover.js";
  const transformed = await scriptedSvgPublication();
  const coverResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/${coverPath}`) && response.request().resourceType() === "document",
  );
  await openPublication(transformed.payload, 60_000);
  await expectFixedSvg(page);
  await expect(reader(page).locator(".epub-navigator-reader__bottom-pages")).toHaveText("1 / 1");
  const coverUrl = (await readerFrame(page).getAttribute("src"))!;
  expectForegroundScriptPolicy((await coverResponse).headers()["content-security-policy"]);

  const publisherEvidence = () =>
    evaluateReaderDocument(page, () => {
      const evidence = window as unknown as Record<string, unknown>;
      const agent = document.documentElement.firstElementChild;
      return {
        firstChildAgent: agent?.getAttribute("href")?.endsWith("content-agent.js") === true,
        agentNonce: agent?.getAttribute("nonce") ?? null,
        external: evidence.__scriptedSvgExternal,
        inline: evidence.__scriptedSvgInline,
        handler: evidence.__scriptedSvgHandler,
        parserReadingSystem: evidence.__scriptedSvgParserReadingSystem,
        publisherRuns: localStorage.getItem("scripted-svg-publisher-runs"),
      };
    });
  const executed = {
    firstChildAgent: true,
    agentNonce: null,
    external: true,
    inline: true,
    handler: true,
    parserReadingSystem: true,
  };
  await expect.poll(publisherEvidence).toEqual({ ...executed, publisherRuns: "1" });

  const { id, resources } = await cachedResources(page);
  expect(resources.find((resource) => resource.path === coverPath)).toMatchObject({
    mediaType: "image/svg+xml",
    responseInstrumentation: "svg",
    executableContent: "detected",
    foregroundPreparation: "ineligible",
  });
  const cacheState = await page.evaluate(
    async ({ id, coverPath, scriptPath, coverUrl }) => {
      const cache = await caches.open(`epub-navigator:${id}`);
      const keys = await cache.keys();
      const cached = async (suffix: string) =>
        (await cache.match(keys.find((key) => key.url.endsWith(suffix))!))!;
      const facts = (await (await cached("/facts.json")).json()) as {
        resources: { resources: { address: { value?: string }; scripted?: boolean }[] };
      };
      const foreground = await fetch(coverUrl);
      const measurement = await fetch(coverUrl.replace("/publications/", "/measurements/"));
      return {
        scripted: facts.resources.resources.find((resource) => resource.address.value === coverPath)
          ?.scripted,
        authoredCover: await (await cached(`/resources/${id}/${coverPath}`)).text(),
        authoredScript: await (await cached(`/resources/${id}/${scriptPath}`)).text(),
        foregroundText: await foreground.text(),
        foregroundPolicy: foreground.headers.get("content-security-policy"),
        measurementStatus: measurement.status,
        measurementText: await measurement.text(),
      };
    },
    { id, coverPath, scriptPath, coverUrl },
  );
  expect(cacheState).toMatchObject({
    scripted: true,
    authoredCover: transformed.cover,
    authoredScript: transformed.script,
    measurementStatus: 403,
  });
  expect(cacheState.foregroundText.replace(svgInjection, "")).toBe(transformed.cover);
  expectForegroundScriptPolicy(cacheState.foregroundPolicy);
  expect(cacheState.measurementText).toContain("not eligible for background measurement");
  await expect(
    page.locator(`[data-epub-pagination-session] iframe[src="${coverUrl}"]`),
  ).toHaveCount(0);

  await page.reload();
  await expectFixedSvg(page, coverUrl);
  await expect(reader(page).locator(".epub-navigator-reader__bottom-pages")).toHaveText("1 / 1");
  await expect.poll(publisherEvidence).toEqual({ ...executed, publisherRuns: "2" });
});

test("runs Trees publisher scripts beside the content agent", async ({ page, openPublication }) => {
  test.setTimeout(60_000);
  await openPublication(corpus("trees.epub"), 45_000);
  await expect
    .poll(() =>
      evaluateReaderDocument(page, () => {
        const canvas = document.querySelector("canvas");
        return {
          canvasSize: canvas === null ? null : { width: canvas.width, height: canvas.height },
          readingSystem: navigator.epubReadingSystem?.hasFeature("spine-scripting") === true,
        };
      }),
    )
    .toEqual({ canvasSize: { width: 600, height: 400 }, readingSystem: true });
});

// The compact profile follows the primary pointer, not the viewport, so a phone-sized window
// alone leaves the reader in workspace; this asserts compact, so it emulates a phone.
test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("imports Page Blanche with managed fixed XHTML geometry", async ({
    page,
    openPublication,
  }) => {
    await openPublication(corpus("page-blanche.epub"));
    const view = reader(page);
    await expect(view).toHaveAttribute("data-document-adapter", "fixed-xhtml");
    await expect(view).toHaveAttribute("data-presentation-mode", "fixed");
    await expect(view).toHaveAttribute("data-layout-settlement", "contain");
    await expect(view).toHaveAttribute("data-pagination-coverage", "exact", { timeout: 45_000 });
    await expect(view).toHaveAttribute("data-pagination-measured", "10");
    await expect(view).toHaveAttribute("data-display-profile", "compact");
    const pages = view.locator(".epub-navigator-reader__bottom-pages");
    await expect(pages).toHaveText("1 / 1");
    const frame = readerFrame(page);
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    await expect
      .poll(() => evaluateReaderDocument(page, () => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 1200, height: 1577 });
    await expect
      .poll(() =>
        frame
          .contentFrame()
          .locator(":root")
          .evaluate((root) => getComputedStyle(root).scrollbarWidth),
      )
      .toBe("none");

    const fitScale = transformScale(await frame.evaluate((element) => element.style.transform));
    const topRail = page.locator(".epub-navigator-reader__compact-top-rail");
    await expect(topRail.getByRole("group", { name: "Fixed page zoom" })).toHaveCount(0);
    await topRail.getByRole("button", { name: "Open quick menu" }).click();
    await page.getByRole("button", { name: "Adjust fixed-page zoom" }).click();
    const zoomToolbar = page.getByRole("toolbar", { name: "Fixed page zoom controls" });
    await expect(zoomToolbar).toBeVisible();
    const [top, controls, bottom] = await Promise.all(
      [
        topRail,
        page.locator(".epub-navigator-reader__zoom-adjustment"),
        page.locator(".epub-navigator-reader__compact-bottom-rail"),
      ].map((locator) => locator.boundingBox()),
    );
    expect(controls!.y).toBeGreaterThanOrEqual(top!.y + top!.height);
    expect(controls!.y + controls!.height).toBeLessThanOrEqual(bottom!.y);
    await expect(page.locator(".epub-navigator-reader__compact-progress")).toBeVisible();
    await zoomToolbar
      .getByRole("group", { name: "Fixed page zoom" })
      .getByRole("button", { name: "Zoom in" })
      .click();
    const reset = page.getByRole("button", { name: "Reset zoom to fit" });
    await expect(reset).toHaveText("125%");
    const zoomedTransform = await frame.evaluate((element) => element.style.transform);
    expect(transformScale(zoomedTransform) / fitScale).toBeCloseTo(1.25, 5);
    await frame.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect
      .poll(() => frame.evaluate((element) => element.style.transform))
      .not.toBe(zoomedTransform);
    await page.keyboard.press("0");
    await expect(reset).toHaveText("Fit");

    const coverSource = (await frame.getAttribute("src"))!;
    await frame.focus();
    await page.keyboard.press("PageDown");
    await expect(frame).not.toHaveAttribute("src", coverSource);
    await frame.focus();
    await page.keyboard.press("PageDown");
    const authoredPage = topRail.locator(".epub-navigator-reader__compact-book-progress");
    await expect(authoredPage).toHaveText("p. 1");
    await expect(authoredPage).toHaveAttribute("aria-label", "Publication page 1");
    await expect(pages).toHaveText("1 / 1");
    const authoredSource = (await frame.getAttribute("src"))!;
    await frame.focus();
    await page.keyboard.press("PageUp");
    await expect(frame).not.toHaveAttribute("src", authoredSource);
    await frame.focus();
    await page.keyboard.press("PageUp");
    await expect(frame).toHaveAttribute("src", coverSource);
  });
});

test("imports and reads the complete Haruko authored RTL workflow", async ({
  page,
  openPublication,
}) => {
  test.setTimeout(180_000);
  const { blake3 } = corpusPublication("haruko")!;
  const root = `http://127.0.0.1:4176/publications/${blake3}/OPS`;
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPublication(corpus("haruko-html-jpeg.epub"), 60_000);
  // The demo reader matches the interface by default; the book's own colours are the subject
  // of the canvas checks below.
  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  await page
    .getByRole("radiogroup", { name: "Book colors" })
    .getByRole("radio", { name: "Original" })
    .click();
  await page.keyboard.press("Escape");

  const view = reader(page);
  await expect(view).toHaveAttribute("data-page-progression", "rtl");
  await expect(view).toHaveAttribute("data-pagination-coverage", "exact", { timeout: 45_000 });
  await expect(view).toHaveAttribute("data-pagination-activity", "idle");
  await expect(view).toHaveAttribute("data-pagination-measured", "13");
  await expect(view).toHaveAttribute("data-pagination-total", "13");
  await expect(page.getByRole("progressbar", { name: "Reading progress" })).toHaveAttribute(
    "data-accuracy",
    "exact",
  );
  const { resources } = await cachedResources(page);
  for (let occurrence = 1; occurrence <= 12; occurrence += 1) {
    expect(
      resources.find(
        (resource) => resource.path === `OPS/xhtml/${harukoPage(occurrence - 1)}.xhtml`,
      ),
    ).toMatchObject({
      mediaType: "application/xhtml+xml",
      responseInstrumentation: "xhtml",
      executableContent: "analyzed-absent",
      foregroundPreparation: "eligible",
    });
  }

  await page.evaluate(() => {
    const evidence = { maximumFrames: 0 };
    const sample = () => {
      evidence.maximumFrames = Math.max(
        evidence.maximumFrames,
        document.querySelectorAll("[data-epub-navigator-frame-stack] > iframe").length,
      );
    };
    new MutationObserver(sample).observe(document.body, { childList: true, subtree: true });
    sample();
    Object.assign(window, { __harukoFrames: evidence });
  });

  const visited = new Set<number>();
  const markVisited = (occurrences: readonly number[]) => {
    for (const occurrence of occurrences) {
      expect(visited.has(occurrence), `occurrence ${occurrence} was already visible`).toBe(false);
      visited.add(occurrence);
    }
  };
  await expectHarukoView(page, root, 0, null, "Exact progress, page 1 of 14");
  await expectHarukoImage(harukoFrame(page, 0, "primary"), "01.jpg");
  markVisited([0]);

  const prepared = page.locator(
    '[data-epub-navigator-frame-stack] > iframe[aria-hidden="true"][data-epub-navigator-occurrence="1"]',
  );
  await expect(prepared).toHaveCount(1, { timeout: 30_000 });
  await expectHarukoImage(prepared, "02.jpg");
  await prepared.evaluate((element) => element.setAttribute("data-haruko-prepared", ""));

  await observeAtomicReveal(page, [1, 2]);
  await advanceHaruko(page, 0, "PageDown");
  await expectHarukoView(page, root, 1, 2, "Exact progress, pages 2 to 3 of 14");
  await expect(page.locator("iframe[data-haruko-prepared]")).toHaveAttribute(
    "data-epub-navigator-participant",
    "primary",
  );
  await expectAtomicReveal(page);
  await expectHarukoImage(harukoFrame(page, 1, "primary"), "02.jpg");
  await expectHarukoImage(harukoFrame(page, 2, "fixed-companion"), "03.jpg");
  markVisited([1, 2]);

  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  await page.getByRole("button", { name: "Adjust fixed-page zoom" }).click();
  const zoom = page.getByRole("group", { name: "Fixed page zoom" });
  const fitTransforms = await harukoTransforms(page);
  await zoom.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoom.getByRole("button", { name: "Reset zoom to fit" })).toHaveText("125%");
  const beforePan = await harukoTransforms(page);
  expect(transformScale(beforePan.primary)).toBeCloseTo(
    1.25 * transformScale(fitTransforms.primary),
    5,
  );
  expect(transformScale(beforePan.primary)).toBeCloseTo(transformScale(beforePan.companion), 5);
  await harukoFrame(page, 2, "fixed-companion").focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(() => harukoTransforms(page)).not.toEqual(beforePan);
  const afterPan = await harukoTransforms(page);

  await observeAtomicReveal(page, [3, 4]);
  await advanceHaruko(page, 1, "PageDown");
  await expectHarukoView(page, root, 3, 4, "Exact progress, pages 4 to 5 of 14");
  await expectAtomicReveal(page);
  const afterNavigation = await harukoTransforms(page);
  expect(afterNavigation.primary).toBe(beforePan.primary);
  expect(afterNavigation.primary).not.toBe(afterPan.primary);
  expect(transformScale(afterNavigation.primary)).toBeCloseTo(
    transformScale(afterNavigation.companion),
    5,
  );
  markVisited([3, 4]);
  await harukoFrame(page, 3, "primary").focus();
  await page.keyboard.press("0");
  await expect.poll(() => harukoTransforms(page)).toEqual(fitTransforms);

  await page.setViewportSize({ width: 700, height: 1000 });
  await expectHarukoView(page, root, 3, null, "Exact progress, page 4 of 14");
  expect(
    await harukoFrame(page, 3, "primary").evaluate((element) => element.style.transform),
  ).not.toBe(afterNavigation.primary);
  await observeAtomicReveal(page, [3, 4]);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expectHarukoView(page, root, 3, 4, "Exact progress, pages 4 to 5 of 14");
  await expectAtomicReveal(page, true);
  expect(await harukoTransforms(page)).toEqual(fitTransforms);

  for (const primary of [5, 7, 9]) {
    const companion = primary + 1;
    await observeAtomicReveal(page, [primary, companion]);
    await advanceHaruko(page, primary - 2, "PageDown");
    await expectHarukoView(
      page,
      root,
      primary,
      companion,
      `Exact progress, pages ${primary + 1} to ${companion + 1} of 14`,
    );
    await expectAtomicReveal(page);
    await expectHarukoImage(harukoFrame(page, primary, "primary"), harukoImage(primary));
    await expectHarukoImage(
      harukoFrame(page, companion, "fixed-companion"),
      harukoImage(companion),
    );
    markVisited([primary, companion]);
  }

  // The last fixed page is authored into a spread with the reflowable colophon: `p12` carries
  // `page-spread-right` and `about` carries `page-spread-left rendition:layout-reflowable`, so
  // the colophon shares the final view and exact progress counts the pages its pane shows,
  // both of them at this width.
  await observeAtomicReveal(page, [11, 12]);
  await advanceHaruko(page, 9, "PageDown");
  await expectHarukoView(page, root, 11, 12, "Exact progress, pages 12 to 14 of 14");
  // The colophon shows both its pages at once, so `p12` is the furthest page the cursor reaches
  // and the rail has to end there rather than on the last page of the book.
  await expect(page.getByRole("progressbar", { name: "Reading progress" })).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  await expectAtomicReveal(page);
  await expectHarukoImage(harukoFrame(page, 11, "primary"), "12.jpg");
  await expect(harukoFrame(page, 12, "fixed-companion")).toHaveAttribute(
    "data-epub-navigator-placement",
    "left",
  );
  // `default.css` colours the body and nothing else; a browser would propagate that to the
  // canvas, so the reader paints the root with it rather than its own Canvas colour.
  await expectHarukoCanvas(harukoFrame(page, 12, "fixed-companion"));
  markVisited([11, 12]);

  // Resizing the window re-lays out the reflowable companion at its new half width, through
  // portrait where the spread comes apart and back. The kernel once treated a reflowable
  // companion re-layout as unreachable and panicked, which left every later command failing.
  const panics: string[] = [];
  const recordPanic = (text: string) => {
    if (/panicked|recursive use of an object/u.test(text)) panics.push(text);
  };
  const onConsole = (message: ConsoleMessage) => recordPanic(message.text());
  const onPageError = (error: Error) => recordPanic(error.message);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  // Each resize lands while the previous re-layout is still in flight, which is the state that
  // panicked. Waiting for one to settle before the next would take away the overlap.
  for (const width of [1400, 1200, 1000, 800, 1000, 1200, 1400, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(80);
  }
  await expectHarukoView(page, root, 11, 12, "Exact progress, pages 12 to 14 of 14");
  await expectHarukoImage(harukoFrame(page, 11, "primary"), "12.jpg");
  await expectHarukoCanvas(harukoFrame(page, 12, "fixed-companion"));
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  expect(panics).toEqual([]);
  expect([...visited].sort((left, right) => left - right)).toEqual(
    Array.from({ length: 13 }, (_, occurrence) => occurrence),
  );

  // The colophon is the trailing member of the final spread. A page turn turns its pages in
  // place while `p12` stays beside it, and only its last page lets the view move on; progress
  // follows the pages the colophon shows. Narrower, its half of the spread holds one column, so
  // it has pages to turn.
  const pageCount = () => view.getAttribute("data-pagination-page-count");
  const widePageCount = await pageCount();
  await page.setViewportSize({ width: 760, height: 500 });
  // Until the resize is absorbed the view reports the previous viewport's pagination as exact
  // and idle, and the colophon still holds the pages it had when its half of the spread was
  // wider. The new page count is the first thing that tells the two apart.
  await expect.poll(pageCount, { timeout: 45_000 }).not.toBe(widePageCount);
  await expect(view).toHaveAttribute("data-pagination-coverage", "exact", { timeout: 45_000 });
  await expect(view).toHaveAttribute("data-pagination-activity", "idle", { timeout: 45_000 });
  await expectHarukoView(page, root, 11, 12, /^Exact progress, pages \d+ to \d+ of \d+$/u);
  const colophon = () => harukoFrame(page, 12, "fixed-companion").contentFrame().locator("html");
  const colophonPage = () =>
    colophon().evaluate((root) => Math.round(Math.abs(root.scrollLeft) / root.clientWidth));
  const countColophonPages = () =>
    colophon().evaluate((root) => Math.round(root.scrollWidth / root.clientWidth));
  // Twelve single-page fixed occurrences precede the colophon, so the rest of the book's pages
  // are its own, and the pages it shows must agree with the count the reader reports.
  const colophonPages = Number(await pageCount()) - 12;
  expect(colophonPages).toBeGreaterThan(1);
  await expect.poll(countColophonPages, { timeout: 15_000 }).toBe(colophonPages);
  await expect.poll(colophonPage).toBe(0);
  for (let turned = 1; turned < colophonPages; turned += 1) {
    await advanceHaruko(page, 11, "PageDown");
    await expect.poll(colophonPage).toBe(turned);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expectHarukoView(page, root, 11, 12, /^Exact progress, page \d+ of \d+$/u);
  }
  await expectHarukoView(page, root, 11, 12, /^Exact progress, page (\d+) of \1$/u);
  await advanceHaruko(page, 11, "PageDown");
  await expect.poll(colophonPage).toBe(colophonPages - 1);
  await expectHarukoView(page, root, 11, 12, /^Exact progress, page (\d+) of \1$/u);
  for (let turned = colophonPages - 1; turned > 0; turned -= 1) {
    await advanceHaruko(page, 11, "PageUp");
    await expect.poll(colophonPage).toBe(turned - 1);
  }
  await expectHarukoView(page, root, 11, 12, /^Exact progress, pages \d+ to \d+ of \d+$/u);
  await expectHarukoCanvas(harukoFrame(page, 12, "fixed-companion"));
  await page.setViewportSize({ width: 1600, height: 900 });
  await expectHarukoView(page, root, 11, 12, "Exact progress, pages 12 to 14 of 14");

  // Stepping back from the colophon's first page returns to the trailing page of the previous
  // pair, `p11`, which brings `p10` with it: the same two pages the forward walk showed, read
  // from the other end.
  await observeAtomicReveal(page, [9, 10]);
  await advanceHaruko(page, 11, "PageUp");
  await expectHarukoView(page, root, 10, 9, "Exact progress, pages 10 to 11 of 14");
  await expectAtomicReveal(page);
  await expectHarukoImage(harukoFrame(page, 10, "primary"), "11.jpg");
  await expectHarukoImage(harukoFrame(page, 9, "fixed-companion"), "10.jpg");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __harukoFrames: { maximumFrames: number } }).__harukoFrames
          .maximumFrames,
    ),
  ).toBeLessThanOrEqual(3);

  await clearStoredReadingPositions(page);
  await page.reload();
  await expect(view).toHaveAttribute("data-pagination-coverage", "exact", { timeout: 30_000 });
  await expectHarukoView(page, root, 0, null, "Exact progress, page 1 of 14");

  await returnToLibrary(page);
  await page.getByRole("button", { name: /^ハルコさんの彼氏/u }).click();
  await expect(view).toHaveAttribute("data-pagination-coverage", "exact", { timeout: 30_000 });
  await expectHarukoView(page, root, 0, null, "Exact progress, page 1 of 14");
  await expectHarukoImage(harukoFrame(page, 0, "primary"), "01.jpg");
});

test("turns the pages of reflowable spread members in place in both directions", async ({
  page,
  openPublication,
}) => {
  test.setTimeout(180_000);
  // A fixed-layout book: a lone cover, then two spreads that each pair a fixed page with a
  // reflowable document, trailing in the first spread and leading in the second, then a lone
  // page. Occurrences: 0 cover, 1 A fixed, 2 B reflowable, 3 C reflowable, 4 D fixed, 5 E.
  await page.setViewportSize({ width: 1000, height: 700 });
  await openPublication(spreadPanesPublication(), 60_000);
  const view = reader(page);
  await expect(view).toHaveAttribute("data-pagination-coverage", "exact", { timeout: 45_000 });
  await expect(view).toHaveAttribute("data-pagination-activity", "idle", { timeout: 45_000 });
  const progress = page.getByRole("progressbar", { name: "Reading progress" });
  const label = (text: string) =>
    expect(progress).toHaveAttribute("aria-valuetext", `Exact progress, ${text}`, {
      timeout: 15_000,
    });
  const panePage = (occurrence: number, participant: "primary" | "fixed-companion") => () =>
    paneState(spreadFrame(page, occurrence, participant)).then((state) => state.page);

  await expectPanesView(page, 0, null);
  const total = Number((await progress.getAttribute("aria-valuetext"))!.match(/of (\d+)$/u)![1]);
  await label(`page 1 of ${total}`);
  await turnPanes(page, 0, "PageDown");
  await expectPanesView(page, 1, 2);
  await expect
    .poll(() => paneState(spreadFrame(page, 2, "fixed-companion")).then((s) => s.pages), {
      timeout: 15_000,
    })
    .toBeGreaterThan(1);
  const bPages = (await paneState(spreadFrame(page, 2, "fixed-companion"))).pages;
  const cPages = total - 4 - bPages;
  expect(cPages).toBeGreaterThan(1);
  await label(`pages 2 to 3 of ${total}`);

  // Forward: the trailing reflowable turns beside the fixed page until its last page.
  for (let turned = 1; turned < bPages; turned += 1) {
    await turnPanes(page, 1, "PageDown");
    await expect.poll(panePage(2, "fixed-companion")).toBe(turned);
    await label(`page ${3 + turned} of ${total}`);
  }
  // Then the next spread, where the reflowable leads and turns as the primary.
  await turnPanes(page, 1, "PageDown");
  await expectPanesView(page, 3, 4);
  await expect.poll(panePage(3, "primary")).toBe(0);
  await label(`page ${3 + bPages} of ${total}`);
  for (let turned = 1; turned < cPages; turned += 1) {
    await turnPanes(page, 3, "PageDown");
    await expect.poll(panePage(3, "primary")).toBe(turned);
  }
  await label(`pages ${2 + bPages + cPages} to ${3 + bPages + cPages} of ${total}`);
  await turnPanes(page, 3, "PageDown");
  await expectPanesView(page, 5, null);
  await label(`page ${total} of ${total}`);

  // Backward: entering a spread lands on the reflowable member's last page, whether it is the
  // companion or the primary, and turning back visits every page before leaving the spread.
  await turnPanes(page, 5, "PageUp");
  await expectPanesView(page, 4, 3);
  await expect.poll(panePage(3, "fixed-companion"), { timeout: 15_000 }).toBe(cPages - 1);
  await label(`pages ${2 + bPages + cPages} to ${3 + bPages + cPages} of ${total}`);
  for (let turned = cPages - 1; turned > 0; turned -= 1) {
    await turnPanes(page, 4, "PageUp");
    await expect.poll(panePage(3, "fixed-companion")).toBe(turned - 1);
    await label(`page ${3 + bPages + turned - 1} of ${total}`);
  }
  await turnPanes(page, 4, "PageUp");
  await expectPanesView(page, 2, 1);
  await expect.poll(panePage(2, "primary"), { timeout: 15_000 }).toBe(bPages - 1);
  await label(`page ${2 + bPages} of ${total}`);
  for (let turned = bPages - 1; turned > 0; turned -= 1) {
    await turnPanes(page, 2, "PageUp");
    await expect.poll(panePage(2, "primary")).toBe(turned - 1);
  }
  await label(`pages 2 to 3 of ${total}`);
  await turnPanes(page, 2, "PageUp");
  await expectPanesView(page, 0, null);
  await label(`page 1 of ${total}`);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

function spreadPanesPublication(): PublicationFilePayload {
  const encoder = new TextEncoder();
  const fixedPage = (name: string, color: string): string =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${name}</title><meta name="viewport" content="width=600, height=800"/><style>body{margin:0;width:600px;height:800px;background:${color};font:48px sans-serif}</style></head><body><p>Page ${name}</p></body></html>`;
  const reflowablePage = (name: string): string =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${name}</title></head><body><h1>Text ${name}</h1>${Array.from(
      { length: 36 },
      (_, index) =>
        `<p id="${name}-${index + 1}">Paragraph ${index + 1} of ${name}: the quick brown fox jumps over the lazy dog, and keeps running until the column is full.</p>`,
    ).join("")}</body></html>`;
  const files: Record<string, string> = {
    "META-INF/container.xml":
      '<?xml version="1.0" encoding="UTF-8"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "OPS/package.opf": `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" xml:lang="en" prefix="rendition: http://www.idpf.org/vocab/rendition/#" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:elephant:spread-panes</dc:identifier><dc:title>Spread panes</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-12T00:00:00Z</meta><meta property="rendition:layout">pre-paginated</meta><meta property="rendition:orientation">portrait</meta><meta property="rendition:spread">landscape</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="d" href="d.xhtml" media-type="application/xhtml+xml"/><item id="e" href="e.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="cover" properties="page-spread-center"/><itemref idref="a" properties="page-spread-left"/><itemref idref="b" properties="page-spread-right rendition:layout-reflowable"/><itemref idref="c" properties="page-spread-left rendition:layout-reflowable"/><itemref idref="d" properties="page-spread-right"/><itemref idref="e" properties="page-spread-center"/></spine></package>`,
    "OPS/nav.xhtml":
      '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="cover.xhtml">Spread panes</a></li></ol></nav></body></html>',
    "OPS/cover.xhtml": fixedPage("Cover", "#eeeeee"),
    "OPS/a.xhtml": fixedPage("A", "#dde6ff"),
    "OPS/b.xhtml": reflowablePage("B"),
    "OPS/c.xhtml": reflowablePage("C"),
    "OPS/d.xhtml": fixedPage("D", "#ffe6dd"),
    "OPS/e.xhtml": fixedPage("E", "#e6ffdd"),
  };
  const mtime = new Date("1990-01-01T12:00:00.000Z");
  const archive: Zippable = {
    mimetype: [encoder.encode("application/epub+zip"), { level: 0, mtime }],
  };
  for (const [path, text] of Object.entries(files)) {
    archive[path] = [encoder.encode(text), { level: 6, mtime }];
  }
  return {
    name: "spread-panes.epub",
    mimeType: "application/epub+zip",
    buffer: Buffer.from(zipSync(archive, { level: 6 })),
  };
}

function spreadFrame(
  page: Page,
  occurrence: number,
  participant: "primary" | "fixed-companion",
): Locator {
  return page.locator(
    `iframe[data-epub-navigator-participant="${participant}"]` +
      `[data-epub-navigator-occurrence="${occurrence}"]:not([aria-hidden="true"]):not([inert])`,
  );
}

async function expectPanesView(page: Page, primary: number, companion: number | null) {
  await expect(spreadFrame(page, primary, "primary")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator(
      '[data-epub-navigator-frame-stack] > iframe:not([aria-hidden="true"]):not([inert])',
    ),
  ).toHaveCount(companion === null ? 1 : 2, { timeout: 30_000 });
  if (companion !== null) {
    await expect(spreadFrame(page, companion, "fixed-companion")).toBeVisible({ timeout: 30_000 });
  }
}

function paneState(frame: Locator): Promise<{ page: number; pages: number }> {
  return frame
    .contentFrame()
    .locator("html")
    .evaluate((root) => ({
      page: Math.round(Math.abs(root.scrollLeft) / root.clientWidth),
      pages: Math.round(root.scrollWidth / root.clientWidth),
    }));
}

async function turnPanes(page: Page, primary: number, key: "PageDown" | "PageUp") {
  await spreadFrame(page, primary, "primary").focus();
  await page.keyboard.press(key);
}

async function expectFixedSvg(page: Page, source?: string): Promise<void> {
  const view = reader(page);
  await expect(view).toHaveAttribute("data-document-adapter", "fixed-svg", { timeout: 30_000 });
  await expect(view).toHaveAttribute("data-layout-settlement", "contain");
  await expect(readerFrame(page)).toHaveCount(1);
  await expect(readerFrame(page)).toBeVisible();
  if (source !== undefined) await expect(readerFrame(page)).toHaveAttribute("src", source);
}

function expectForegroundScriptPolicy(policy: string | null | undefined): void {
  expect(policy).toContain("script-src 'self' 'unsafe-inline'");
  expect(policy).not.toContain("script-src-attr 'none'");
  expect(policy).not.toContain("'nonce-");
}

function evaluateReaderDocument<T>(page: Page, callback: () => T): Promise<T> {
  return readerFrame(page).contentFrame().locator(":root").evaluate(callback);
}

function transformScale(transform: string): number {
  const scale = /scale\(([^)]+)\)/u.exec(transform)?.[1];
  if (scale === undefined) throw new Error(`fixed transform has no scale: ${transform}`);
  return Number(scale);
}

function harukoPage(occurrence: number): string {
  return occurrence === 12 ? "AboutThisDocument" : `p${String(occurrence + 1).padStart(2, "0")}`;
}

function harukoImage(occurrence: number): string {
  return `${String(occurrence + 1).padStart(2, "0")}.jpg`;
}

function harukoFrame(
  page: Page,
  occurrence: number,
  participant: "primary" | "fixed-companion",
): Locator {
  return page.locator(
    `iframe[data-epub-navigator-participant="${participant}"]` +
      `[data-epub-navigator-occurrence="${occurrence}"]:not([aria-hidden="true"]):not([inert])`,
  );
}

async function expectHarukoView(
  page: Page,
  root: string,
  primary: number,
  companion: number | null,
  progressLabel: string | RegExp,
): Promise<void> {
  const primaryFrame = harukoFrame(page, primary, "primary");
  await expect(primaryFrame).toBeVisible({ timeout: 30_000 });
  await expect(primaryFrame).toHaveAttribute("src", `${root}/xhtml/${harukoPage(primary)}.xhtml`);
  await expect(
    page.locator(
      '[data-epub-navigator-frame-stack] > iframe:not([aria-hidden="true"]):not([inert])',
    ),
  ).toHaveCount(companion === null ? 1 : 2, { timeout: 30_000 });
  if (companion !== null) {
    await expect(harukoFrame(page, companion, "fixed-companion")).toHaveAttribute(
      "src",
      `${root}/xhtml/${harukoPage(companion)}.xhtml`,
    );
  }
  await expect(page.getByRole("progressbar", { name: "Reading progress" })).toHaveAttribute(
    "aria-valuetext",
    progressLabel,
  );
  await expect(reader(page)).toHaveAttribute(
    "data-document-adapter",
    primary === 12 ? "reflowable-xhtml" : "fixed-xhtml",
  );
}

async function expectHarukoCanvas(frame: Locator): Promise<void> {
  await expect
    .poll(() =>
      frame
        .contentFrame()
        .locator("html")
        .evaluate((root) => [
          getComputedStyle(root).backgroundColor,
          getComputedStyle(root.ownerDocument.body).backgroundColor,
        ]),
    )
    .toEqual(["rgb(255, 244, 231)", "rgb(255, 244, 231)"]);
}

async function expectHarukoImage(frame: Locator, fileName: string): Promise<void> {
  await expect
    .poll(() =>
      frame
        .contentFrame()
        .locator(":root")
        .evaluate(() => {
          const image = document.querySelector("img");
          return image === null
            ? null
            : { source: image.src, complete: image.complete, loaded: image.naturalWidth > 0 };
        }),
    )
    .toEqual({
      source: expect.stringContaining(`/OPS/images/${fileName}`),
      complete: true,
      loaded: true,
    });
}

async function advanceHaruko(page: Page, occurrence: number, key: "PageDown" | "PageUp") {
  await harukoFrame(page, occurrence, "primary").focus();
  await page.keyboard.press(key);
}

async function observeAtomicReveal(page: Page, occurrences: readonly number[]): Promise<void> {
  await page.evaluate((targets) => {
    const samples: number[] = [];
    const sample = () => {
      samples.push(
        targets.filter((occurrence) => {
          const frame = document.querySelector<HTMLIFrameElement>(
            `iframe[data-epub-navigator-occurrence="${occurrence}"]`,
          );
          return frame !== null && !frame.inert && frame.getAttribute("aria-hidden") !== "true";
        }).length,
      );
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "inert", "data-epub-navigator-participant"],
    });
    sample();
    Object.assign(window, { __harukoReveal: { samples, stop: () => observer.disconnect() } });
  }, occurrences);
}

async function expectAtomicReveal(page: Page, startsSingleton = false): Promise<void> {
  let samples = await page.evaluate(() => {
    const evidence = (window as unknown as { __harukoReveal: { samples: number[]; stop(): void } })
      .__harukoReveal;
    evidence.stop();
    return evidence.samples;
  });
  if (startsSingleton) samples = samples.slice(samples.findIndex((visible) => visible !== 1));
  expect(samples).not.toContain(1);
  expect(samples).toContain(2);
}

async function harukoTransforms(page: Page): Promise<{ primary: string; companion: string }> {
  const [primary, companion] = await Promise.all(
    ["primary", "fixed-companion"].map((participant) =>
      page
        .locator(`iframe[data-epub-navigator-participant="${participant}"]`)
        .evaluate((element) => element.style.transform),
    ),
  );
  return { primary: primary!, companion: companion! };
}

async function clearStoredReadingPositions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("epub-navigator-reader");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("reading-positions")) return;
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("reading-positions", "readwrite");
        transaction.objectStore("reading-positions").clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
}

async function scriptedSvgPublication(): Promise<{
  readonly payload: PublicationFilePayload;
  readonly cover: string;
  readonly script: string;
}> {
  const entries = unzipSync(new Uint8Array(await readFile(corpus("svg-in-spine.epub"))));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const packagePath = "OPS/content.opf";
  const coverPath = "OPS/Images/cover.svg";
  const coverItem =
    '<item id="page001" properties="cover-image" href="Images/cover.svg" media-type="image/svg+xml" />';
  const packageDocument = decoder.decode(entries[packagePath]);
  const originalCover = decoder.decode(entries[coverPath]);
  const svgRootEnd = '\t xml:space="preserve">';
  if (!packageDocument.includes(coverItem) || !originalCover.includes(svgRootEnd)) {
    throw new Error("the SVG corpus archive no longer has the expected cover declaration");
  }
  const cover = originalCover.replace(
    svgRootEnd,
    `${svgRootEnd.slice(0, -1)} onload="window.__scriptedSvgHandler = true">\n` +
      '<script id="publisher-external" href="../Scripts/cover.js"></script>\n' +
      '<script id="publisher-inline"><![CDATA[window.__scriptedSvgInline = true; window.__scriptedSvgParserReadingSystem = navigator.epubReadingSystem?.hasFeature("spine-scripting") === true;]]></script>\n',
  );
  const script =
    'const runs = Number(localStorage.getItem("scripted-svg-publisher-runs") ?? "0") + 1;\n' +
    'localStorage.setItem("scripted-svg-publisher-runs", String(runs));\n' +
    "window.__scriptedSvgExternal = true;\n" +
    'window.__scriptedSvgParserReadingSystem = navigator.epubReadingSystem?.hasFeature("spine-scripting") === true;\n';
  entries[packagePath] = encoder.encode(
    packageDocument.replace(
      coverItem,
      '<item id="page001" properties="cover-image scripted" href="Images/cover.svg" media-type="image/svg+xml" />\n' +
        '\t<item id="cover-script" href="Scripts/cover.js" media-type="text/javascript" />',
    ),
  );
  entries[coverPath] = encoder.encode(cover);
  entries["OPS/Scripts/cover.js"] = encoder.encode(script);

  const mtime = new Date("1990-01-01T12:00:00.000Z");
  const archive: Zippable = { mimetype: [entries.mimetype!, { level: 0, mtime }] };
  for (const [path, bytes] of Object.entries(entries)) {
    if (path !== "mimetype") archive[path] = [bytes, { level: 6, mtime }];
  }
  return {
    payload: {
      name: "scripted-svg-in-spine.epub",
      mimeType: "application/epub+zip",
      buffer: Buffer.from(zipSync(archive, { level: 6 })),
    },
    cover,
    script,
  };
}
