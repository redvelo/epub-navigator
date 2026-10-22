import { expect, test } from "@playwright/test";
import { routeRollFixture } from "./roll-fixture.js";

for (const fixture of ["lay-roll-images-in-spine", "lay-roll-images-mixed"]) {
  test(`${fixture}: real raster loads as a contained image document with source identity`, async ({
    page,
  }) => {
    await routeRollFixture(page, fixture);
    await page.goto("/synthetic/fixed-roll.html");
    await expect(page.locator("#result")).toHaveText("ready");
    const occurrence = await page.evaluate(() => {
      const image = window.roll
        .snapshot()
        .readingOrder.find(
          ({ document }) => document.state === "loadable" && document.adapter === "fixed-image",
        )!.ordinal;
      window.roll.open(image);
      return image;
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const committed = window.roll.snapshot().document.committed;
          return committed?.layout.state === "settled" ? committed.frame.occurrence : null;
        }),
      )
      .toBe(occurrence);
    const frame = page.locator(`iframe[data-epub-navigator-occurrence="${occurrence}"]`);
    await expect(frame).toHaveAttribute("src", /\.png\?epub-navigator-image-document=1$/u);
    const geometry = await frame
      .contentFrame()
      .locator("html")
      .evaluate((root) => {
        const image = document.querySelector("img")!;
        return {
          source: root.getAttribute("data-epub-navigator-viewport-source"),
          natural: [image.naturalWidth, image.naturalHeight],
          viewport: [innerWidth, innerHeight],
          image: [image.width, image.height],
          query: new URL(image.src).search,
          meta: document.querySelector("meta[name=viewport]") !== null,
        };
      });
    expect(geometry).toEqual({
      source: "image-natural",
      natural: [1674, 1378],
      viewport: [1674, 1378],
      image: [1674, 1378],
      query: "",
      meta: false,
    });
    const committed = await page.evaluate(() => window.roll.snapshot().document.committed!);
    expect(committed.frame.adapter).toBe("fixed-image");
    expect(committed.frame.resource).toMatch(/\.png$/u);
    expect(committed.layout.state === "settled" && committed.layout.layout.settlement.adapter).toBe(
      "fixed-image",
    );
  });
}
