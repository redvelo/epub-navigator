import { alice, expect, settle, test } from "./helpers.js";

test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

test("absorbs a top camera into the gutter and clears side cameras only where they overlap", async ({
  page,
  openPublication,
}) => {
  await openPublication(alice);
  const configure = async (top: number, left: number, bounds: number[]) =>
    page.evaluate(
      ({ top, left, bounds }) => {
        const style = document.documentElement.style;
        for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"])
          style.setProperty(`--reader-host-corner-${corner}-radius`, "0px");
        for (const [side, value] of Object.entries({ top, left, right: 0 }))
          style.setProperty(`--reader-host-cutout-${side}`, `${value}px`);
        ["left", "top", "right", "bottom"].forEach((side, i) =>
          style.setProperty(`--reader-host-cutout-bounds-${side}`, `${bounds[i]}px`),
        );
      },
      { top, left, bounds },
    );
  const rail = page.locator(".epub-navigator-reader__compact-top-rail");
  const publication = page.locator(".epub-navigator-reader__publication-region");
  await configure(68, 0, [187, 0, 225, 68]);
  await expect(rail).toHaveCSS("height", "68px");
  await expect(rail).toHaveCSS("padding-top", "0px");
  expect((await publication.boundingBox())!.y).toBe(68);
  const title = (await page.getByRole("button", { name: "Open quick menu" }).boundingBox())!;
  expect(title.x + title.width).toBeLessThanOrEqual(187);
  expect(title.y).toBeLessThan(68);
  expect(title.y + title.height).toBeGreaterThanOrEqual(66);
  expect(
    (await page.locator(".epub-navigator-reader__compact-book-progress").boundingBox())!.x,
  ).toBeGreaterThanOrEqual(225);
  await page.locator(".epub-navigator-reader__compact-book-progress").click();
  const quickHeader = page.locator(".epub-navigator-reader__compact-menu-header");
  // A sheet starts below the camera rather than laying its own chrome underneath it.
  await expect(quickHeader).toHaveCSS("height", "56px");
  await settle(quickHeader);
  expect((await quickHeader.boundingBox())!.y).toBe(68);
  await expect(quickHeader.getByRole("button", { name: "Publication", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Publication", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Reading settings" });
  await expect(settings.getByRole("heading", { name: "Reading settings" })).toHaveText("Settings");
  await expect(settings.locator("header")).toHaveCSS("height", "56px");
  // The sheet starts below the camera, so the header stays reachable.
  expect((await settings.locator("header").boundingBox())!.y).toBe(68);
  await page.addStyleTag({ content: "h2 { margin-block: 17px; }" });
  await expect(settings.locator("header")).toHaveCSS("height", "56px");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation", exact: true });
  const footer = navigation.locator(".epub-navigator-reader__page-footer");
  await expect(footer).toHaveCount(1);
  await settle(footer);
  const panelTabs = (await navigation
    .getByRole("tablist", { name: "Reader panels" })
    .boundingBox())!;
  const listTabs = (await navigation
    .getByRole("tablist", { name: "Navigation lists" })
    .boundingBox())!;
  // The page footer sits above both tab rows; the panel tabs are the bar at the sheet's edge.
  const footerBox = (await footer.boundingBox())!;
  expect(listTabs.y).toBeGreaterThanOrEqual(footerBox.y + footerBox.height);
  expect(panelTabs.y).toBeGreaterThanOrEqual(listTabs.y + listTabs.height);
  await page.getByRole("button", { name: "Search publication", exact: true }).click();
  const search = page.locator(".epub-navigator-reader__compact-search-header");
  await settle(search);
  expect((await search.boundingBox())!.y).toBeGreaterThanOrEqual(68);
  expect((await search.locator("form").boundingBox())!.y).toBeGreaterThanOrEqual(68);
  expect(
    (await page.getByRole("button", { name: "Back to navigation" }).boundingBox())!.y,
  ).toBeGreaterThanOrEqual(68);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 915, height: 412 });
  await configure(0, 68, [0, 185, 68, 227]);
  await expect(rail).toHaveCSS("height", "28px");
  await expect(rail).toHaveCSS("padding-left", "0px");
  await expect(page.locator(".epub-navigator-reader__compact-bottom-rail")).toHaveCSS(
    "padding-left",
    "12px",
  );
  expect((await publication.boundingBox())!.x).toBe(68);
  await page.getByRole("button", { name: "Open quick menu" }).click();
  const quickSheet = page.getByRole("dialog", { name: "Quick Menu", exact: true });
  expect((await quickSheet.locator("header").boundingBox())!.x).toBe(0);
  expect((await quickSheet.locator("header").boundingBox())!.width).toBe(915);
  // The quick menu does not paginate: a window too short to hold it scrolls it instead. At this
  // height the menu happens to fit exactly, so the window is shortened to the point where its
  // content cannot, which is the only height at which "scrolls rather than paginates" is a
  // statement about the menu rather than about how tall its content currently is.
  await expect(quickSheet.locator(".epub-navigator-reader__page-footer")).toHaveCount(0);
  await page.setViewportSize({ width: 915, height: 300 });
  const quickScroller = quickSheet.locator("div.overflow-y-auto").first();
  await expect(quickScroller).toHaveCSS("overflow-y", "auto");
  await expect
    .poll(() => quickScroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect(quickSheet.locator(".epub-navigator-reader__page-footer")).toHaveCount(0);
  await page.setViewportSize({ width: 915, height: 412 });
  await page.getByRole("button", { name: "Publication", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Publication details", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Publication details", exact: true })).toHaveText(
    "Publication",
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const style = document.documentElement.style;
    for (const upper of [true, false])
      for (const left of [true, false]) {
        const name = `--reader-host-corner-${upper ? "top" : "bottom"}-${left ? "left" : "right"}`;
        style.setProperty(`${name}-radius`, "52px");
        style.setProperty(`${name}-x`, `${left ? 52 : innerWidth - 52}px`);
        style.setProperty(`${name}-y`, `${upper ? 52 : innerHeight - 52}px`);
      }
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const top = document
          .querySelector(".epub-navigator-reader__compact-menu-trigger > span")!
          .getBoundingClientRect();
        const bottom = document
          .querySelector(".epub-navigator-reader__bottom-section")!
          .getBoundingClientRect();
        return Math.abs(top.left - bottom.left);
      }),
    )
    .toBeLessThan(1);
  await configure(0, 68, [0, 0, 68, 40]);
  await expect(rail).toHaveCSS("padding-left", "68px");
  await configure(0, 0, [0, 0, 0, 0]);
  await expect(rail).toHaveCSS("padding-left", "0px");
  expect((await publication.boundingBox())!.x).toBe(0);
});

test("fits corners at the text and icon height rather than using the entire radius", async ({
  page,
  openPublication,
}) => {
  test.setTimeout(60_000);
  await openPublication(alice);
  const configure = async (topCutout: number) =>
    page.evaluate((top) => {
      const style = document.documentElement.style;
      for (const upper of [true, false])
        for (const left of [true, false]) {
          const name = `--reader-host-corner-${upper ? "top" : "bottom"}-${left ? "left" : "right"}`;
          style.setProperty(`${name}-radius`, "64px");
          style.setProperty(`${name}-x`, `${left ? 64 : innerWidth - 64}px`);
          style.setProperty(`${name}-y`, `${upper ? 64 : innerHeight - 64}px`);
        }
      style.setProperty("--reader-host-cutout-top", `${top}px`);
    }, topCutout);
  await configure(70);
  const top = page.locator(".epub-navigator-reader__compact-top-rail");
  const bottom = page.locator(".epub-navigator-reader__compact-bottom-rail");
  await expect(top).toHaveCSS("--reader-edge-corner-top-right", "0px");
  await expect(top).toHaveCSS("padding-right", "0px");
  const inset = (locator: typeof bottom) =>
    locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingRight));
  await expect.poll(() => inset(bottom)).toBeGreaterThan(12);
  expect(await inset(bottom)).toBeLessThan(64);
  await page.getByRole("button", { name: "Open quick menu" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Reading settings" });
  await expect(settings.locator("header")).toHaveCSS("--reader-edge-corner-top-right", "0px");
  await expect(settings.locator("header")).toHaveCSS("padding-right", "4px");
  const footer = settings.locator(".epub-navigator-reader__page-footer");
  await expect.poll(() => inset(footer)).toBeGreaterThan(0);
  expect(await inset(footer)).toBeLessThan(64);
  expect(
    (await settings.locator(".epub-navigator-reader__page-viewport").boundingBox())!.width,
  ).toBe(412);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 915, height: 412 });
  await configure(0);
  await expect.poll(() => inset(top)).toBeGreaterThan(0);
  expect(await inset(top)).toBeLessThan(64);
  expect(await inset(bottom)).toBeLessThan(64);
  await page.evaluate(() => {
    const style = document.documentElement.style;
    for (const property of [...style])
      if (property.startsWith("--reader-host-")) style.removeProperty(property);
  });
  await expect(top).toHaveCSS("padding-right", "0px");
  await expect(bottom).toHaveCSS("padding-right", "12px");
});

test("standalone reader fills the viewport while only insetting bottom content", async ({
  page,
  openPublication,
}) => {
  test.setTimeout(60_000);
  await openPublication(alice);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/u,
  );
  const geometry = () =>
    page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const root = rect("#root");
      const reader = rect(".epub-navigator-reader");
      const rail = rect(".epub-navigator-reader__compact-bottom-rail");
      const publication = rect(".epub-navigator-reader__publication-region");
      const section = rect(".epub-navigator-reader__bottom-section");
      const pages = rect(".epub-navigator-reader__bottom-pages");
      return {
        rootBottom: root.bottom,
        readerBottom: reader.bottom,
        railBottom: rail.bottom,
        viewportBottom: visualViewport!.offsetTop + visualViewport!.height,
        railHeight: rail.height,
        publicationTop: publication.top,
        publicationBottom: publication.bottom,
        sectionInset: section.left - reader.left,
        pagesInset: reader.right - pages.right,
        publicationLeft: publication.left - reader.left,
        publicationRight: reader.right - publication.right,
      };
    });
  const baseline = await geometry();
  expect(baseline.rootBottom).toBe(baseline.viewportBottom);
  expect(baseline.readerBottom).toBe(baseline.viewportBottom);
  expect(baseline.railBottom).toBe(baseline.viewportBottom);
  expect(baseline.railHeight).toBe(28);
  expect(baseline.sectionInset).toBe(12);
  expect(baseline.pagesInset).toBe(12);

  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34 } });
  expect(await geometry()).toEqual(baseline);
  await page.evaluate(() => {
    const style = document.documentElement.style;
    style.setProperty("--reader-host-corner-bottom-left", "28px");
    style.setProperty("--reader-host-corner-bottom-right", "40px");
    style.setProperty("--reader-host-corner-top-left", "24px");
    style.setProperty("--reader-host-corner-top-right", "36px");
  });
  await expect.poll(async () => (await geometry()).sectionInset).toBe(28);
  expect(await geometry()).toEqual({ ...baseline, sectionInset: 28, pagesInset: 40 });
  await expect(page.locator(".epub-navigator-reader__compact-top-rail")).toHaveCSS(
    "padding-right",
    "36px",
  );
  await expect(page.locator(".epub-navigator-reader__compact-top-rail")).toHaveCSS(
    "padding-left",
    "24px",
  );

  await page.getByRole("button", { name: "Open quick menu" }).click();
  const header = page.getByRole("dialog", { name: "Quick Menu" }).locator("header");
  await expect(header).toHaveCSS("padding-left", "24px");
  await expect(header).toHaveCSS("padding-right", "36px");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const footer = page
    .getByRole("dialog", { name: "Reading settings" })
    .locator(".epub-navigator-reader__page-footer");
  await expect(footer).toBeVisible();
  const footerBox = await footer.boundingBox();
  expect(footerBox!.y + footerBox!.height).toBe(baseline.viewportBottom);
  expect(footerBox!.x).toBe(0);
  expect(footerBox!.width).toBe(412);
  await expect(footer).toHaveCSS("padding-left", "28px");
  await expect(footer).toHaveCSS("padding-right", "40px");
  const menuBody = page.locator(
    ".epub-navigator-reader__compact-sheet .epub-navigator-reader__page-viewport",
  );
  expect((await menuBody.boundingBox())!.width).toBe(412);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const tabs = page.getByRole("tablist", { name: "Reader panels" });
  await expect(tabs).toHaveCSS("margin-left", "28px");
  await expect(tabs).toHaveCSS("margin-right", "40px");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 915, height: 412 });
  for (const cameraSide of ["left", "right"] as const) {
    await page.evaluate((side) => {
      const style = document.documentElement.style;
      style.setProperty("--reader-host-cutout-left", side === "left" ? "60px" : "0px");
      style.setProperty("--reader-host-cutout-right", side === "right" ? "60px" : "0px");
    }, cameraSide);
    await expect
      .poll(async () => {
        const current = await geometry();
        return cameraSide === "left" ? current.publicationLeft : current.publicationRight;
      })
      .toBe(60);
    const current = await geometry();
    expect(current.railBottom).toBe(current.viewportBottom);
    expect(current.railHeight).toBe(28);
  }
  await session.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
  await page.evaluate(() => {
    for (const name of [
      "corner-top-left",
      "corner-top-right",
      "corner-bottom-left",
      "corner-bottom-right",
      "cutout-left",
      "cutout-right",
    ])
      document.documentElement.style.removeProperty(`--reader-host-${name}`);
  });
  await page.setViewportSize({ width: 412, height: 915 });
  await expect.poll(geometry).toEqual(baseline);
  await session.detach();
});
