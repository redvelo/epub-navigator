import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const reader = (page: Page) => page.locator(".epub-navigator-reader");
const frame = (page: Page) => page.locator('iframe[data-epub-navigator-participant="primary"]');

// A surface is reported visible while it is still off screen, so geometry read straight after
// that measures where the surface started. Its own transitions say when it has arrived, which a
// slow machine stretches and a reduced-motion host skips entirely.
const settled = (page: Page) =>
  page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished));
  });

const railInset = (page: Page) =>
  page
    .locator(".epub-navigator-reader__compact-bottom-rail")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft));

test.beforeEach(async ({ page }) => {
  await page.goto("/reader/reader.html");
  await expect(reader(page)).toHaveAttribute("data-reader-state", "reading", { timeout: 15_000 });
});

test("a compact surface leaves the publication where it was", async ({ page }) => {
  const publicationTop = () => frame(page).evaluate((element) => element.getBoundingClientRect().y);
  const before = await publicationTop();
  await page.getByRole("button", { name: /Open navigation/u }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await settled(page);
  expect(await publicationTop()).toBe(before);
  expect(await reader(page).evaluate((element) => element.scrollTop)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
  await settled(page);
  expect(await publicationTop()).toBe(before);
});

test("dragging in from an edge reveals the reader's own chrome", async ({ page }) => {
  const drag = (from: number, to: number) =>
    page
      .frameLocator('iframe[data-epub-navigator-participant="primary"]')
      .locator("body")
      .evaluate(
        (body, [startY, endY]) => {
          const target = body.ownerDocument.elementFromPoint(120, startY!) ?? body;
          const send = (type: string, y: number) =>
            target.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                composed: true,
                pointerId: 7,
                pointerType: "touch",
                isPrimary: true,
                button: 0,
                clientX: 120,
                clientY: y,
              }),
            );
          send("pointerdown", startY!);
          send("pointermove", (startY! + endY!) / 2);
          send("pointerup", endY!);
        },
        [from, to],
      );

  await drag(20, 160);
  await expect(page.getByRole("dialog", { name: "Quick Menu" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Quick Menu" })).toBeHidden();

  await drag(760, 620);
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
});

test("keeps a surface clear of a host cutout", async ({ page }) => {
  await reader(page).evaluate((element) => {
    (element as HTMLElement).style.setProperty("--reader-host-cutout-top", "64px");
    element.setAttribute("data-top-cutout", "");
  });

  await page.getByRole("button", { name: /Open navigation/u }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await settled(page);
  // Nothing a finger has to find sits in the cutout, so the header is the sheet's first row.
  expect(
    (await page.locator(".epub-navigator-reader__compact-titled-header").boundingBox())!.y,
  ).toBe(64);
});

// No grip starts a drag, so the drag is the whole surface's: a header is as good as any part
// of it. Real touch points, because a dismissal is a flick and the release velocity is what
// carries the sheet out.
const dragSurface = async (
  page: Page,
  locator: Locator,
  distance: number,
  { across = 0, onMove }: { across?: number; onMove?: () => Promise<void> } = {},
) => {
  const box = (await locator.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const point = (fraction: number) => ({
    x: box.x + box.width / 2 + across * fraction,
    y: box.y + box.height / 2 + distance * fraction,
    id: 11,
    radiusX: 4,
    radiusY: 4,
    force: 1,
  });
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(0)] });
  for (const fraction of [0.2, 0.5, 0.8, 1]) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point(fraction)],
    });
    await onMove?.();
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
};

test("closes a surface dragged back towards the edge it arrived over", async ({ page }) => {
  await page.getByRole("button", { name: /Open navigation/u }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await settled(page);
  await dragSurface(page, page.locator(".epub-navigator-reader__compact-titled-header"), 220);
  await expect(navigation).toBeHidden();

  // A surface off the top edge leaves the way it came, which is the other direction.
  await page.getByRole("button", { name: /Open quick menu/u }).click();
  const quick = page.getByRole("dialog", { name: "Quick Menu" });
  await expect(quick).toBeVisible();
  await settled(page);
  await dragSurface(page, page.locator(".epub-navigator-reader__compact-menu-header"), 220);
  await expect(quick).toBeVisible();
  await dragSurface(page, page.locator(".epub-navigator-reader__compact-menu-header"), -220);
  await expect(quick).toBeHidden();
});

test("leaves a dragged surface where it is on a low-refresh display", async ({ page }) => {
  await reader(page).evaluate((element) =>
    element.setAttribute("data-interaction-feedback", "minimal"),
  );
  await page.getByRole("button", { name: /Open navigation/u }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await settled(page);
  const resting = (await navigation.boundingBox())!.y;
  const backdrop = page.locator(".epub-navigator-reader__surface-backdrop");
  const samples: { top: number; backdrop: string }[] = [];
  await dragSurface(page, page.locator(".epub-navigator-reader__compact-titled-header"), 220, {
    onMove: async () => {
      samples.push({
        top: (await navigation.boundingBox())!.y,
        backdrop: await backdrop.evaluate((element) => getComputedStyle(element).opacity),
      });
    },
  });

  // Such a display smears a surface tracking the finger as readily as a transition, so the
  // drag moves neither the sheet nor the fill behind it; the release decides.
  expect(samples).toHaveLength(4);
  for (const sample of samples) expect(sample).toEqual({ top: resting, backdrop: "1" });
  await expect(navigation).toBeHidden();
});

test("leaves a paginated body's gestures to the body", async ({ page }) => {
  await page.getByRole("button", { name: /Open navigation/u }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await settled(page);
  const pages = navigation.locator(".epub-navigator-reader__page-footer output");
  const body = navigation.locator(".epub-navigator-reader__page-viewport");
  const count = Number((await pages.textContent())!.split("/")[1]);
  expect(count).toBeGreaterThan(1);

  // A page turn is a horizontal flick with the vertical drift any finger adds, and the drawer
  // arbitrates every touch in the sheet: whichever page the body rests on, the turn is the
  // body's gesture and not a dismissal.
  await dragSurface(page, body, 4, { across: 120 });
  await expect(pages).toHaveText(`1 / ${count}`);
  await dragSurface(page, body, 4, { across: -120 });
  await expect(pages).toHaveText(`2 / ${count}`);
  await expect(navigation).toBeVisible();

  // Dragging the body scrolls the body. The sheet leaves by its own chrome.
  await dragSurface(page, body, -120);
  await expect(navigation).toBeVisible();
  expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await dragSurface(page, body, 220);
  await expect(navigation).toBeVisible();
});

test("turns inline pages and still gives up the sheet on a low-refresh display", async ({
  page,
}) => {
  // A minimal-feedback host fragments a body into viewport-sized pages across the inline axis,
  // the way Elephant's tokens do, which leaves the block axis nothing to scroll.
  await reader(page).evaluate((element) => {
    element.setAttribute("data-interaction-feedback", "minimal");
    (element as HTMLElement).style.setProperty("--reader-page-fragment-block", "100%");
    (element as HTMLElement).style.setProperty("--reader-page-fragment-columns", "1");
  });
  await page.getByRole("button", { name: /Open quick menu/u }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Reading settings" });
  await expect(settings).toBeVisible();
  await settled(page);
  const pages = settings.locator(".epub-navigator-reader__page-footer output");
  const body = settings.locator(".epub-navigator-reader__page-viewport");
  const count = Number((await pages.textContent())!.split("/")[1]);
  expect(count).toBeGreaterThan(1);
  expect(
    await body.evaluate((element) => ({
      overflows: element.scrollWidth > element.clientWidth,
      scrolls: element.scrollHeight > element.clientHeight,
    })),
  ).toEqual({ overflows: true, scrolls: false });

  await dragSurface(page, body, 4, { across: -120 });
  await expect(pages).toHaveText(`2 / ${count}`);
  await expect(settings).toBeVisible();

  // With no block-axis scrolling of its own to protect, the body hands a drag down back to the
  // sheet rather than swallowing it.
  await dragSurface(page, body, 220);
  await expect(settings).toBeHidden();
});

test("fills the selected tab away from a low-refresh display", async ({ page }) => {
  await page.getByRole("button", { name: /Open navigation/u }).click();
  const tab = page
    .getByRole("tablist", { name: "Reader panels" })
    .getByRole("tab", { name: "Navigation" });
  await expect(tab).toHaveAttribute("data-active", "");
  const look = () =>
    tab.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderTopLeftRadius,
      mark: getComputedStyle(element, "::after").opacity,
      decoration: getComputedStyle(element).textDecorationLine,
    }));

  const standard = await look();
  expect(standard.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(standard.radius).not.toBe("0px");
  // The fill says which tab it is, so nothing is drawn under it and nothing underlines it.
  expect(standard.mark).toBe("0");
  expect(standard.decoration).toBe("none");
  await tab.hover();
  expect(await look()).toEqual(standard);

  await reader(page).evaluate((element) =>
    element.setAttribute("data-interaction-feedback", "minimal"),
  );
  const minimal = await look();
  expect(minimal.background).toBe("rgba(0, 0, 0, 0)");
  expect(minimal.radius).toBe("0px");
  expect(await tab.evaluate((e) => getComputedStyle(e, "::after").opacity)).toBe("1");
});

test("dismisses a partial drawer by pressing the publication behind it", async ({ page }) => {
  await page.getByRole("button", { name: /Open quick menu/u }).click();
  const quick = page.getByRole("dialog", { name: "Quick Menu" });
  await expect(quick).toBeVisible();
  await settled(page);
  const box = (await quick.boundingBox())!;
  // The publication is a frame of its own, so the press has to land on the reader's backdrop,
  // and one press has to be enough.
  const x = box.x + box.width / 2;
  const y = Math.min(box.y + box.height + 40, 824);
  await page.touchscreen.tap(x, y);
  await expect(quick).toBeHidden();

  await page.getByRole("button", { name: /Open quick menu/u }).click();
  await expect(quick).toBeVisible();
  await settled(page);
  await page.mouse.click(x, y);
  await expect(quick).toBeHidden();
});

test("slides a drawer in without resizing it on the way", async ({ page }) => {
  const transition = () =>
    page
      .locator('[data-slot="drawer-popup"]')
      .evaluate((element) => getComputedStyle(element).transitionProperty);
  await page.getByRole("button", { name: /Open navigation/u }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  expect(await transition()).toBe("transform");
});

test("slides a drawer in without dragging the reader along with it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Sampling ends when the drawer comes to rest, so the run holds every frame of the slide
  // however long the machine took over it, and the last frame is the resting one.
  await page.evaluate(() => {
    const slide: {
      frames: { offset: number; scrollTop: number; scrollHeight: number }[];
      done: boolean;
    } = {
      frames: [],
      done: false,
    };
    (window as unknown as { __slide: typeof slide }).__slide = slide;
    const tick = () => {
      const popup = document.querySelector('[data-open][data-slot="drawer-popup"]');
      const root = document.querySelector(".epub-navigator-reader");
      if (popup !== null && root !== null) {
        slide.frames.push({
          offset: Math.round(new DOMMatrixReadOnly(getComputedStyle(popup).transform).m42),
          scrollTop: root.scrollTop,
          scrollHeight: root.scrollHeight,
        });
      }
      const travelled = slide.frames.some((frame) => frame.offset > 0);
      if (travelled && slide.frames.at(-1)!.offset === 0) slide.done = true;
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.getByRole("button", { name: /Open navigation/u }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __slide: { done: boolean } }).__slide.done),
    )
    .toBe(true);
  const frames = await page.evaluate(
    () =>
      (
        window as unknown as {
          __slide: { frames: { offset: number; scrollTop: number; scrollHeight: number }[] };
        }
      ).__slide.frames,
  );
  const height = await reader(page).evaluate((element) => element.clientHeight);

  // The drawer really travelled, and the reader stayed exactly where it was while it did.
  expect(frames.length).toBeGreaterThan(5);
  expect(Math.max(...frames.map((frame) => frame.offset))).toBeGreaterThan(height / 2);
  expect(frames.at(-1)!.offset).toBe(0);
  expect(Math.max(...frames.map((frame) => frame.scrollTop))).toBe(0);
  expect(Math.max(...frames.map((frame) => frame.scrollHeight))).toBeLessThanOrEqual(height);
});

test("says how each surface leaves, and leaves that way on Back", async ({ page }) => {
  const control = (name: RegExp | string) => page.getByRole("button", { name });

  // Reached from the publication, so it closes.
  await page.getByRole("button", { name: /Open navigation/u }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await expect(control("Close navigation")).toBeVisible();

  // Search is reached from navigation, so it returns there.
  await control("Search publication").click();
  await expect(control("Back to navigation")).toBeVisible();
  await control("Back to navigation").click();
  await expect(control("Close navigation")).toBeVisible();

  await control("Close navigation").click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();

  // Reading settings is reached from quick menu, so it returns there.
  await page.getByRole("button", { name: /Open quick menu/u }).click();
  await control(/^Settings$/u).click();
  await expect(page.getByRole("dialog", { name: "Reading settings" })).toBeVisible();
  await control("Back to quick menu").click();
  await expect(page.getByRole("dialog", { name: "Quick Menu" })).toBeVisible();
});

/** Host-reported rounded corners, which is what gives the clearance controller work to do. */
async function roundCorners(page: Page): Promise<void> {
  await reader(page).evaluate((element) => {
    const style = (element as HTMLElement).style;
    for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"])
      style.setProperty(`--reader-host-corner-${corner}-radius`, "44px");
    style.setProperty("--reader-host-corner-bottom-left-x", "44");
    style.setProperty("--reader-host-corner-bottom-left-y", "800");
    style.setProperty("--reader-host-corner-bottom-right-x", "346");
    style.setProperty("--reader-host-corner-bottom-right-y", "800");
  });
  // The clearance controller answers the host corners asynchronously, so wait for the inset it
  // produces rather than for an interval long enough to have covered it.
  await expect.poll(() => railInset(page)).toBeGreaterThan(12);
}

test("keeps the rails clear of rounded corners while a surface is open", async ({ page }) => {
  await roundCorners(page);
  const clear = await railInset(page);

  // A surface marks the rest of the reader aria-hidden. The rail is still painted, so the
  // clearance it needs is unchanged.
  await page.getByRole("button", { name: /Open quick menu/u }).click();
  await expect(page.getByRole("dialog", { name: "Quick Menu" })).toBeVisible();
  await settled(page);
  expect(await railInset(page)).toBe(clear);
});

test("settles a surface before measuring what its edges have to clear", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await roundCorners(page);
  // The sampler runs until the surface has arrived, so the frames it holds are exactly the
  // ones the slide was on screen for.
  await page.evaluate(() => {
    const tabsSamples: { sizes: string[]; stop: boolean } = { sizes: [], stop: false };
    (window as unknown as { __tabs: typeof tabsSamples }).__tabs = tabsSamples;
    const tick = () => {
      const tabs = document.querySelector('[aria-label="Reader panels"]');
      if (tabs !== null) {
        const style = getComputedStyle(tabs);
        tabsSamples.sizes.push(
          `${Math.round(tabs.getBoundingClientRect().width)}:${style.marginLeft}`,
        );
      }
      if (!tabsSamples.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.getByRole("button", { name: /Open navigation/u }).click();
  await settled(page);
  const sizes = await page.evaluate(() => {
    const tabsSamples = (window as unknown as { __tabs: { sizes: string[]; stop: boolean } })
      .__tabs;
    tabsSamples.stop = true;
    return tabsSamples.sizes;
  });

  // Measured mid-slide the tabs look like they are down in a corner, and get inset by its
  // radius; the panel would resize under a thumb already on its way down.
  expect(sizes.length).toBeGreaterThan(5);
  expect([...new Set(sizes)]).toHaveLength(1);
});

test("previews the fill on a pressed tab rather than ruling under it", async ({ page }) => {
  await page.getByRole("button", { name: /Open navigation/u }).click();
  const tab = page
    .getByRole("tablist", { name: "Reader panels" })
    .getByRole("tab", { name: "Annotations" });
  await expect(tab).toBeVisible();
  await settled(page);
  const box = (await tab.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const pressed = await tab.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    mark: getComputedStyle(element, "::after").content,
  }));
  await page.mouse.up();
  expect(pressed.mark).toBe("none");
  expect(pressed.background).not.toBe("rgba(0, 0, 0, 0)");
});

test("centres a surface title against its own controls", async ({ page }) => {
  const centred = async () => {
    const box = (await page.locator("header h2, header p").first().boundingBox())!;
    const width = await reader(page).evaluate((element) => element.clientWidth);
    return { left: Math.round(box.x), right: Math.round(width - (box.x + box.width)) };
  };

  // A trailing slot with nothing in it still balances the control leading the header.
  await page.getByRole("button", { name: /Open quick menu/u }).click();
  await settled(page);
  const quick = await centred();
  expect(quick.left).toBe(quick.right);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settled(page);
  const settings = await centred();
  expect(settings.left).toBe(settings.right);

  // And a header carrying trailing actions centres the same way.
  await page.getByRole("button", { name: "Back to quick menu" }).click();
  await settled(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Open navigation/u }).click();
  await settled(page);
  const navigation = await centred();
  expect(navigation.left).toBe(navigation.right);
});

test("gives a surface a visible way out where nothing else offers one", async ({ page }) => {
  // A minimal-feedback host has no motion and no dimming, so the control is the clearest
  // clue the surface can be left at all.
  await reader(page).evaluate((element) =>
    element.setAttribute("data-interaction-feedback", "minimal"),
  );

  await page.getByRole("button", { name: /Open quick menu/u }).click();
  const quick = page.getByRole("dialog", { name: "Quick Menu" });
  await expect(quick).toBeVisible();
  await quick.getByRole("button", { name: "Close quick menu" }).click();
  await expect(quick).toBeHidden();
});
