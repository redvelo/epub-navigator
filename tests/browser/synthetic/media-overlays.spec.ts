import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Response, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { unzipSync } from "fflate";
import type { NavigatorDiagnosticEvent } from "../../../src/runtime/index.js";
import { instrumentXhtml } from "../../../src/xhtml-instrumentation.js";

const fixtures = new URL("../../fixtures/epub3-samples/", import.meta.url);
const archive = readFileSync(fileURLToPath(new URL("moby-dick-mo.epub", fixtures)));
const entries = unzipSync(new Uint8Array(archive));
const descriptionFixtures = new URL("moby-dick-media-overlays/", fixtures);
const activeClass = "-epub-media-overlay-active";
const audioPath = "OPS/audio/mobydick_001_002_melville.mp4";
const opusExcerpt = readFileSync(fileURLToPath(new URL("moby-dick-excerpt.ogg", fixtures)));
const HAVE_FUTURE_DATA = 3;
const isolatedOrigin = "http://moby.localhost:4174";

const mediaTypes: Record<string, string> = {
  xhtml: "application/xhtml+xml",
  css: "text/css",
  mp4: "audio/mp4",
  smil: "application/smil+xml",
  jpg: "image/jpeg",
  png: "image/png",
  ncx: "application/x-dtbncx+xml",
};

declare global {
  interface Window {
    __narrationAudio?: HTMLMediaElement;
    __narrationActivations?: string[];
    __narrationSamples?: number[];
    __narrationSamplesStopped?: boolean;
    __contentSettled?: Promise<void>;
    mediaOverlayHarness: {
      readonly calls: string[];
      readonly diagnostics: NavigatorDiagnosticEvent[];
      captureReadingPosition?: (() => Promise<unknown>) | undefined;
    };
  }
}

function fulfillBytes(route: Route, bytes: Uint8Array, contentType: string) {
  const header = route.request().headers()["range"];
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null || (match[1] === "" && match[2] === "")) {
    return route.fulfill({
      status: 200,
      headers: { "content-type": contentType, "accept-ranges": "bytes" },
      body: Buffer.from(bytes),
    });
  }
  const length = bytes.byteLength;
  const start = match[1] === "" ? Math.max(0, length - Number(match[2])) : Number(match[1]);
  const end =
    match[1] === "" || match[2] === "" ? length - 1 : Math.min(Number(match[2]), length - 1);
  if (start >= length || end < start) {
    return route.fulfill({ status: 416, headers: { "content-range": `bytes */${length}` } });
  }
  return route.fulfill({
    status: 206,
    headers: {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${length}`,
    },
    body: Buffer.from(bytes.subarray(start, end + 1)),
  });
}

async function routeHarness(page: Page) {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      window.__narrationAudio = this;
      return play.call(this);
    };
  });
  await page.route("**/moby-dick-mo.epub", (route) =>
    route.fulfill({ contentType: "application/epub+zip", body: archive }),
  );
  await page.route("**/media-overlay-fixture/*.json", (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    return route.fulfill({
      contentType: "application/json",
      body: readFileSync(fileURLToPath(new URL(name, descriptionFixtures))),
    });
  });
}

async function openReader(
  page: Page,
  query = "",
  audio?: { readonly bytes: Uint8Array; readonly contentType: string },
) {
  await routeHarness(page);
  await page.route("**/publications/moby-dick/**", (route) => {
    const path = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/publications/moby-dick/")[1]!,
    );
    if (audio !== undefined && path === audioPath) {
      return fulfillBytes(route, audio.bytes, audio.contentType);
    }
    const source = entries[path];
    if (source === undefined) return route.fulfill({ status: 404 });
    const extension = path.split(".").at(-1)!.toLowerCase();
    if (extension === "xhtml") {
      return route.fulfill({
        contentType: mediaTypes.xhtml ?? "application/xhtml+xml",
        body: Buffer.from(
          instrumentXhtml(source, { contentAgentUrl: "/_epub-navigator/content-agent.js" }),
        ),
      });
    }
    return fulfillBytes(route, source, mediaTypes[extension] ?? "application/octet-stream");
  });
  await page.goto(`/synthetic/media-overlays.html${query}`);
  await expect(page.locator(".epub-navigator-reader")).toHaveAttribute(
    "data-reader-state",
    "reading",
    { timeout: 30_000 },
  );
}

async function openChapterOne(page: Page) {
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Navigation" })
    .getByText("Chapter 1. Loomings.", { exact: true })
    .click();
  await expect(content(page).locator("#c01h01")).toBeVisible({ timeout: 30_000 });
}

function content(page: Page) {
  return page.locator('iframe[data-epub-navigator-participant="primary"]').contentFrame();
}

async function contentSettled(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__contentSettled = new Promise((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.data !== "content-settled") return;
        removeEventListener("message", listener);
        resolve();
      };
      addEventListener("message", listener);
    });
  });
  await content(page)
    .locator("body")
    .evaluate(async () => {
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      parent.postMessage("content-settled", "*");
    });
  await page.evaluate(() => window.__contentSettled);
}

function audioState(page: Page) {
  return page.evaluate(() => {
    const audio = window.__narrationAudio;
    return audio === undefined
      ? null
      : {
          src: audio.currentSrc || audio.src,
          currentTime: audio.currentTime,
          paused: audio.paused,
          playbackRate: audio.playbackRate,
          preservesPitch: (audio as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch,
        };
  });
}

function foregroundLayoutUpdates(page: Page) {
  return page.evaluate(
    () =>
      window.mediaOverlayHarness.diagnostics.filter(
        (event) =>
          event.type === "layout" &&
          event.role === "foreground" &&
          event.phase === "update" &&
          event.action === "start",
      ).length,
  );
}

function decodeState(page: Page) {
  return page.evaluate(() => {
    interface DecodeCountingAudio extends HTMLMediaElement {
      readonly webkitAudioDecodedByteCount?: number | undefined;
    }
    const audio: DecodeCountingAudio | undefined = window.__narrationAudio;
    if (audio === undefined) return null;
    const { played } = audio;
    return {
      error: audio.error?.code ?? null,
      readyState: audio.readyState,
      playedSeconds: played.length === 0 ? 0 : played.end(played.length - 1) - played.start(0),
      decodedBytes: audio.webkitAudioDecodedByteCount ?? 0,
      currentTime: audio.currentTime,
    };
  });
}

async function expectAudioDecodes(page: Page) {
  await expect
    .poll(
      async () => {
        const state = await decodeState(page);
        return (
          state !== null &&
          state.error === null &&
          state.readyState >= HAVE_FUTURE_DATA &&
          state.playedSeconds > 0.5 &&
          state.decodedBytes > 0
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const before = (await decodeState(page))!;
  await expect
    .poll(
      async () => {
        const state = (await decodeState(page))!;
        return state.decodedBytes > before.decodedBytes && state.currentTime > before.currentTime;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

test.describe("Media Overlay narration", () => {
  test.setTimeout(90_000);

  test("offers no narration where the reading order has none", async ({ page }) => {
    await openReader(page);
    await expect(page.getByRole("button", { name: "Play narration" })).toHaveCount(0);
    expect(await page.evaluate(() => window.mediaOverlayHarness.calls)).toEqual([]);
  });

  test("plays real narration, follows the text, and pauses on reader navigation", async ({
    page,
  }) => {
    await openReader(page);
    await openChapterOne(page);
    const play = page.getByRole("button", { name: "Play narration" });
    await expect(play).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => window.mediaOverlayHarness.calls)).toEqual([]);
    const layoutUpdatesBeforePlay = await foregroundLayoutUpdates(page);
    await content(page)
      .locator("body")
      .evaluate((body, name) => {
        const activations: string[] = [];
        window.__narrationActivations = activations;
        new MutationObserver((records) => {
          for (const record of records) {
            const target = record.target as Element;
            if (target.id !== "" && target.classList.contains(name)) activations.push(target.id);
          }
        }).observe(body.ownerDocument, {
          attributes: true,
          attributeFilter: ["class"],
          subtree: true,
        });
      }, activeClass);

    await play.click();
    const pause = page.getByRole("button", { name: "Pause narration" });
    await expect(pause).toHaveAttribute("aria-pressed", "true");
    await expect(content(page).locator("#c01h01")).toHaveClass(new RegExp(activeClass), {
      timeout: 15_000,
    });
    await expect
      .poll(async () => (await audioState(page))?.currentTime ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(24.6);
    const audio = await audioState(page);
    expect(audio?.src).toContain(audioPath);
    expect(audio?.preservesPitch).toBe(true);
    await expect(pause).toBeFocused();

    await expect
      .poll(
        () =>
          content(page)
            .locator("body")
            .evaluate(() => window.__narrationActivations ?? []),
        { timeout: 15_000 },
      )
      .toContain("c01w00001");
    await expect(content(page).locator("#c01h01")).not.toHaveClass(new RegExp(activeClass));
    await expectAudioDecodes(page);

    const railOffset = await page.getByRole("group", { name: "Narration" }).evaluate((element) => {
      const rail = element.closest("footer")!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return box.left + box.width / 2 - (rail.left + rail.width / 2);
    });
    expect(Math.abs(railOffset)).toBeLessThanOrEqual(2);
    const railGeometry = await page
      .getByRole("button", { name: "Pause narration" })
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        const icon = element.querySelector("svg")!.getBoundingClientRect();
        const footer = element.closest("footer")!;
        const rail = footer.getBoundingClientRect();
        const section = footer
          .querySelector(".epub-navigator-reader__bottom-section")!
          .getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          railTop: rail.top,
          railBottom: rail.bottom,
          iconCenter: icon.top + icon.height / 2,
          sectionCenter: section.top + section.height / 2,
          background: getComputedStyle(element).backgroundColor,
          tick: getComputedStyle(element, "::after").content,
          overhang: getComputedStyle(element, "::before").insetInlineStart,
          slotPadding: getComputedStyle(
            footer.querySelector(".epub-navigator-reader__bottom-narration")!,
          ).paddingInlineStart,
        };
      });
    expect(railGeometry.top).toBeGreaterThanOrEqual(railGeometry.railTop);
    expect(railGeometry.bottom).toBeLessThanOrEqual(railGeometry.railBottom);
    expect(Math.abs(railGeometry.iconCenter - railGeometry.sectionCenter)).toBeLessThanOrEqual(2);
    expect(railGeometry.background).toBe("rgba(0, 0, 0, 0)");
    expect(railGeometry.tick).toBe("none");
    expect(railGeometry.overhang).toBe("-1px");
    expect(railGeometry.slotPadding).toBe("0px");

    const sampledFrom = (await audioState(page))!.currentTime;
    await page.evaluate(() => {
      const samples: number[] = [];
      const sample = () => {
        samples.push(window.__narrationAudio!.currentTime);
        if (!window.__narrationSamplesStopped) requestAnimationFrame(sample);
      };
      window.__narrationSamples = samples;
      window.__narrationSamplesStopped = false;
      sample();
    });
    await expect
      .poll(async () => (await audioState(page))!.currentTime, { timeout: 15_000 })
      .toBeGreaterThan(sampledFrom + 3);
    const samples = await page.evaluate(() => {
      window.__narrationSamplesStopped = true;
      return window.__narrationSamples!;
    });
    expect(samples.every((value, index) => index === 0 || value >= samples[index - 1]!)).toBe(true);
    await contentSettled(page);
    expect(await foregroundLayoutUpdates(page)).toBe(layoutUpdatesBeforePlay);
    expect(
      await page.evaluate(() => window.mediaOverlayHarness.captureReadingPosition!()),
    ).toMatchObject({ status: "generated" });

    const pausedId = await content(page).locator(`.${activeClass}`).getAttribute("id");
    await page.locator('iframe[data-epub-navigator-participant="primary"]').focus();
    await page.keyboard.press("PageDown");
    await expect(page.getByRole("button", { name: "Play narration" })).toBeVisible();
    await expect.poll(async () => (await audioState(page))?.paused).toBe(true);
    const pageScroll = () =>
      content(page)
        .locator("body")
        .evaluate((body) => {
          const scrolling = body.ownerDocument.scrollingElement!;
          return [scrolling.scrollLeft, scrolling.scrollTop];
        });
    const turnedPage = await pageScroll();
    await page.getByRole("button", { name: "Narration options" }).click();
    await expect(
      page.getByRole("dialog", { name: "Narration" }).getByText(/^\d+:\d{2} \/ \d+:\d{2}$/),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Play narration" }).click();
    await expect.poll(async () => (await audioState(page))?.paused).toBe(false);
    await expect(content(page).locator(`.${activeClass}`)).toHaveCount(1);
    await expect
      .poll(() =>
        content(page)
          .locator(`.${activeClass}`)
          .evaluate((element) => {
            const view = element.ownerDocument.defaultView!;
            return [...element.getClientRects()].some(
              (rect) =>
                rect.right > 0 &&
                rect.left < view.innerWidth &&
                rect.bottom > 0 &&
                rect.top < view.innerHeight,
            );
          }),
      )
      .toBe(true);
    await expect(content(page).locator(`.${activeClass}`)).not.toHaveId(pausedId!);
    expect(await pageScroll()).toEqual(turnedPage);
  });

  test("applies narration speed from the controls", async ({ page }) => {
    await openReader(page);
    await openChapterOne(page);
    await page.getByRole("button", { name: "Play narration" }).click();
    await expect(content(page).locator("#c01h01")).toHaveClass(new RegExp(activeClass), {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Narration options" }).click();
    await expect(page.getByText(/^\d+:\d{2} \/ \d+:\d{2}$/)).toBeVisible();
    await page.getByRole("button", { name: "Faster" }).click();
    await expect(page.getByRole("group", { name: "Narration speed" })).toContainText("1.25×");
    await expect.poll(async () => (await audioState(page))?.playbackRate).toBe(1.25);

    await page.getByRole("button", { name: "Pause narration" }).click();
    const options = page.getByRole("dialog", { name: "Narration" });
    await expect(options).toBeHidden();
    await page.getByRole("button", { name: "Narration options" }).click();
    await expect(options.getByText(/^\d+:\d{2} \/ \d+:\d{2}$/)).toBeVisible();
  });

  test("continues into the next narrated chapter and stops cleanly", async ({ page }) => {
    await openReader(page, "?rate=3");
    await openChapterOne(page);
    await page.getByRole("button", { name: "Play narration" }).click();
    await expect(content(page).locator("#c01h01")).toHaveClass(new RegExp(activeClass), {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Narration options" }).click();
    const next = page.getByRole("button", { name: "Next narration segment" });
    const last = content(page).locator("#c01p0017");
    for (
      let step = 0;
      step < 40 &&
      !(await last.evaluate((node, name) => node.classList.contains(name), activeClass));
      step += 1
    ) {
      await next.click();
    }
    await expect(last).toHaveClass(new RegExp(activeClass));
    await page.keyboard.press("Escape");

    await expect(content(page).getByRole("heading", { name: /Chapter 2/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(content(page).locator("#c02h01")).toHaveClass(new RegExp(activeClass), {
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Narration options" }).click();
    await page.getByRole("button", { name: "Previous narration segment" }).click();
    await expect(content(page).locator("#c01p0017")).toHaveClass(new RegExp(activeClass), {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Stop narration" }).click();
    await expect(content(page).locator(`.${activeClass}`)).toHaveCount(0);
    const options = page.getByRole("dialog", { name: "Narration" });
    await expect(options.getByRole("button", { name: "Play narration" })).toBeEnabled();
    await expect(options.getByText(/^\d+:\d{2} \/ \d+:\d{2}$/)).toBeVisible();

    await content(page)
      .locator("body")
      .click({ position: { x: 24, y: 24 } });
    await expect(options).toBeHidden();
    await expect(page.getByRole("button", { name: "Play narration" })).toBeVisible();
  });

  test("paints a readable translucent highlight in the dark theme", async ({ page }) => {
    await openReader(page, "?theme=dark");
    await openChapterOne(page);
    await page.getByRole("button", { name: "Play narration" }).click();
    const heading = content(page).locator("#c01h01");
    await expect(heading).toHaveClass(new RegExp(activeClass), { timeout: 15_000 });
    const paint = await heading.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(paint.background).not.toBe("rgb(255, 255, 187)");
    expect(paint.background).toMatch(/\/ 0?\.\d+\)$|^rgba\(/);
    expect(paint.background).not.toBe(paint.color);
  });

  test("decodes the host's Ogg Opus narration transcode", async ({ page }) => {
    await openReader(page, "", { bytes: opusExcerpt, contentType: "audio/ogg" });
    await openChapterOne(page);
    await page.getByRole("button", { name: "Play narration" }).click();
    await expect(content(page).locator("#c01h01")).toHaveClass(new RegExp(activeClass), {
      timeout: 15_000,
    });
    await expectAudioDecodes(page);
  });

  test("reports narration audio the browser cannot decode", async ({ page }) => {
    await openReader(page, "", {
      bytes: new TextEncoder().encode("not narration audio ".repeat(256)),
      contentType: "audio/mp4",
    });
    await openChapterOne(page);
    await page.getByRole("button", { name: "Play narration" }).click();
    await expect(page.getByText("Narration audio format is not supported")).toBeAttached({
      timeout: 15_000,
    });
    await expect(content(page).locator(`.${activeClass}`)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Play narration" })).toBeEnabled();
  });
});

test.describe("Media Overlay narration accessibility", () => {
  test.setTimeout(90_000);

  test("toggles from the keyboard, keeps focus, announces state, and passes axe", async ({
    page,
  }) => {
    await openReader(page);
    await openChapterOne(page);
    const play = page.getByRole("button", { name: "Play narration" });
    await expect(play).toBeVisible({ timeout: 30_000 });
    await play.click();
    const pause = page.getByRole("button", { name: "Pause narration" });
    await expect(pause).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Narration playing" })).toBeAttached();
    await expect(content(page).locator("#c01h01")).toHaveClass(new RegExp(activeClass), {
      timeout: 15_000,
    });
    await expect(content(page).locator("#c01h01")).not.toHaveClass(new RegExp(activeClass), {
      timeout: 15_000,
    });
    await expect(pause).toBeFocused();

    const seriousViolations = async () =>
      (
        await new AxeBuilder({ page }).include(".epub-navigator-reader").analyze()
      ).violations.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      );
    expect(await seriousViolations()).toEqual([]);
    await page.getByRole("button", { name: "Narration options" }).click();
    await expect(page.getByRole("dialog", { name: "Narration" })).toBeVisible();
    expect(await seriousViolations()).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Narration" })).toBeHidden();

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("n");
    await expect(page.getByRole("status").filter({ hasText: "Narration paused" })).toBeAttached();
    await expect.poll(async () => (await audioState(page))?.paused).toBe(true);
    await page.keyboard.press("n");
    await expect(page.getByRole("status").filter({ hasText: "Narration playing" })).toBeAttached();
    await expect.poll(async () => (await audioState(page))?.paused).toBe(false);
  });
});

async function openCompactNavigation(page: Page) {
  const trigger = page.getByRole("button", { name: "Open navigation" });
  const box = (await trigger.boundingBox())!;
  await trigger.tap({ position: { x: 16, y: box.height / 2 } });
}

test.describe("Media Overlay narration in the compact profile", () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("plays from the rail, hides under sheets, and keeps 44px targets in a guard band", async ({
    page,
  }) => {
    await openReader(page);
    await openCompactNavigation(page);
    await page
      .getByRole("dialog", { name: "Navigation" })
      .getByText("Chapter 1. Loomings.", { exact: true })
      .tap();
    // The navigation drawer slides out, so it still covers the rail for a moment after the tap.
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
    await expect(content(page).locator("#c01h01")).toBeVisible({ timeout: 30_000 });

    const play = page.getByRole("button", { name: "Play narration" });
    await expect(play).toBeVisible({ timeout: 30_000 });
    const rail = await page.getByRole("group", { name: "Narration" }).evaluate((group) => {
      const slot = group.closest(".epub-navigator-reader__bottom-narration")!;
      const footer = group.closest("footer")!.getBoundingClientRect();
      const box = slot.getBoundingClientRect();
      const [playButton, options] = [...group.querySelectorAll("button")];
      const probe = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        if (hit === null) return "none";
        if (playButton!.contains(hit)) return "play";
        if (options!.contains(hit)) return "options";
        if (hit === slot) return "guard";
        return hit.classList.contains("epub-navigator-reader__compact-bottom-trigger")
          ? "trigger"
          : "other";
      };
      const band = [footer.top + 1, (footer.top + footer.bottom) / 2, footer.bottom - 1];
      const columns = [
        box.left + 1,
        box.left + box.width / 2 - 1,
        box.left + box.width / 2 + 1,
        box.right - 1,
        box.left - 6,
        box.right + 6,
        box.left - 18,
        box.right + 18,
      ];
      return {
        top: footer.top,
        bottom: footer.bottom,
        left: box.left,
        right: box.right,
        width: box.width,
        padding: getComputedStyle(slot).paddingInlineStart,
        playTarget: getComputedStyle(playButton!, "::before").width,
        playBand: getComputedStyle(playButton!, "::before").height,
        optionsTarget: getComputedStyle(options!, "::before").width,
        hits: columns.map((x) => band.map((y) => probe(x, y))),
      };
    });
    expect(rail.width).toBeCloseTo(88, 0);
    expect(rail.padding).toBe("24px");
    expect(rail.playTarget).toBe("44px");
    expect(rail.optionsTarget).toBe("44px");
    expect(rail.playBand).toBe("28px");
    expect(rail.hits).toEqual([
      ["play", "play", "play"],
      ["play", "play", "play"],
      ["options", "options", "options"],
      ["options", "options", "options"],
      ["guard", "guard", "guard"],
      ["guard", "guard", "guard"],
      ["trigger", "trigger", "trigger"],
      ["trigger", "trigger", "trigger"],
    ]);

    // A cutout inset lifts the rail; the 44px targets must follow it and still span the band.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 48, bottom: 0, left: 0, right: 0 },
    });
    await expect
      .poll(async () =>
        page.getByRole("group", { name: "Narration" }).evaluate((group) => {
          const [playButton, options] = [...group.querySelectorAll("button")];
          const slot = group.closest(".epub-navigator-reader__bottom-narration")!;
          const railBox = group.closest("footer")!.getBoundingClientRect();
          const target = getComputedStyle(playButton!, "::before");
          return {
            width: target.width,
            band: target.height,
            optionsWidth: getComputedStyle(options!, "::before").width,
            guardBand: getComputedStyle(slot, "::before").height,
            railHeight: Math.round(railBox.height),
          };
        }),
      )
      .toEqual({
        width: "44px",
        band: "28px",
        optionsWidth: "44px",
        guardBand: "28px",
        railHeight: 28,
      });
    await session.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
    await expect
      .poll(async () =>
        page
          .getByRole("group", { name: "Narration" })
          .evaluate(
            (group) =>
              getComputedStyle([...group.querySelectorAll("button")][0]!, "::before").height,
          ),
      )
      .toBe("28px");

    const navigation = page.getByRole("dialog", { name: "Navigation" });
    await page.touchscreen.tap(rail.left - 6, (rail.top + rail.bottom) / 2);
    await expect(navigation).toHaveCount(0);
    await expect(play).toBeVisible();

    await page.mouse.move(rail.right + 6, rail.bottom - 4);
    await page.mouse.down();
    await page.mouse.move(rail.right + 6, rail.bottom - 60, { steps: 5 });
    await page.mouse.up();
    await expect(navigation).toHaveCount(0);
    await expect(play).toBeVisible();

    await page.touchscreen.tap(rail.left + 2, rail.top + 2);
    const pause = page.getByRole("button", { name: "Pause narration" });
    await expect(pause).toBeVisible();
    await expect(navigation).toHaveCount(0);
    await expect(content(page).locator("#c01h01")).toHaveClass(new RegExp(activeClass), {
      timeout: 15_000,
    });
    await expectAudioDecodes(page);
    await pause.tap();
    await expect.poll(async () => (await audioState(page))?.paused).toBe(true);

    await openCompactNavigation(page);
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
    const slot = page.locator(".epub-navigator-reader__bottom-narration");
    await expect(slot).toHaveAttribute("data-covered");
    await expect(slot).toHaveAttribute("inert");
    await expect(page.getByRole("button", { name: "Play narration" })).toBeHidden();
  });
});

test.describe("Media Overlay narration from an isolated publication origin", () => {
  test.setTimeout(90_000);

  test("plays ranged audio across origins and keeps the publication document isolated", async ({
    page,
  }) => {
    const audioResponses: Response[] = [];
    page.on("response", (response) => {
      if (response.url().startsWith(`${isolatedOrigin}/OPS/audio/`)) audioResponses.push(response);
    });
    await routeHarness(page);
    await page.goto("/synthetic/media-overlays-isolated.html?rate=3");
    await expect(page.locator(".epub-navigator-reader")).toHaveAttribute(
      "data-reader-state",
      "reading",
      { timeout: 30_000 },
    );
    await openChapterOne(page);
    const frame = page.locator('iframe[data-epub-navigator-participant="primary"]');
    expect(
      await frame.evaluate((element: HTMLIFrameElement) => element.contentDocument),
    ).toBeNull();
    expect(
      page.frames().some((candidate) => candidate.url().startsWith(`${isolatedOrigin}/OPS/`)),
    ).toBe(true);

    await page.getByRole("button", { name: "Play narration" }).click();
    await expect(content(page).locator("#c01h01")).toHaveClass(new RegExp(activeClass), {
      timeout: 15_000,
    });
    await expectAudioDecodes(page);
    expect((await audioState(page))?.src).toBe(`${isolatedOrigin}/${audioPath}`);
    const ranged = audioResponses.find((response) => response.status() === 206);
    expect(ranged).toBeDefined();
    const headers = await ranged!.allHeaders();
    expect(headers["content-type"]).toBe("audio/mp4");
    expect(headers["accept-ranges"]).toBe("bytes");
    expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(Object.keys(headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
    const direct = await page.request.get(`${isolatedOrigin}/${audioPath}`, {
      headers: { range: "bytes=0-1" },
    });
    expect(direct.headers()["cross-origin-resource-policy"]).toBe("same-origin");

    await frame.focus();
    await page.keyboard.press("PageDown");
    await expect.poll(async () => (await audioState(page))?.paused).toBe(true);
    await expect(page.getByRole("button", { name: "Play narration" })).toBeVisible();

    await page.getByRole("button", { name: "Play narration" }).click();
    await expect.poll(async () => (await audioState(page))?.paused).toBe(false);
    await page.getByRole("button", { name: "Narration options" }).click();
    const next = page.getByRole("button", { name: "Next narration segment" });
    const last = content(page).locator("#c01p0017");
    for (
      let step = 0;
      step < 40 &&
      !(await last.evaluate((node, name) => node.classList.contains(name), activeClass));
      step += 1
    ) {
      await next.click();
    }
    await expect(last).toHaveClass(new RegExp(activeClass));
    await page.keyboard.press("Escape");
    await expect(content(page).locator("#c02h01")).toHaveClass(new RegExp(activeClass), {
      timeout: 30_000,
    });
    expect(
      page
        .frames()
        .some((candidate) => candidate.url().startsWith(`${isolatedOrigin}/OPS/chapter_002`)),
    ).toBe(true);

    await page.getByRole("button", { name: "Narration options" }).click();
    await page.getByRole("button", { name: "Stop narration" }).click();
    await expect(content(page).locator(`.${activeClass}`)).toHaveCount(0);
  });
});
