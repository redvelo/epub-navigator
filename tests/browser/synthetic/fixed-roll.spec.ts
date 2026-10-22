import { expect, test } from "@playwright/test";
import { rollFixtures, routeRollFixture } from "./roll-fixture.js";

for (const fixture of rollFixtures) {
  test(`${fixture}: width-fit, gapless retained window, navigation, zoom, and saved offset`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeRollFixture(page, fixture);
    await page.goto("/synthetic/fixed-roll.html");
    await expect(page.locator("#result")).toHaveText("ready", { timeout: 30_000 });
    const roll = page.locator("[data-epub-navigator-roll]");
    await expect(roll).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state), {
        timeout: 30_000,
      })
      .toBe("settled");
    await expect
      .poll(() => page.locator('iframe[data-epub-navigator-participant="primary"]').count())
      .toBeGreaterThan(2);
    // An entering frame is not composited on its first exposed animation frame, so an image
    // spine item stands in with its own bytes painted by this document, behind the frame.
    const imageSpine =
      fixture === "lay-roll-images-in-spine" || fixture === "lay-roll-images-mixed";
    await expect
      .poll(() =>
        page.evaluate((expected) => {
          const previews = [
            ...document.querySelectorAll<HTMLImageElement>("[data-epub-navigator-roll-preview]"),
          ];
          const mounted = new Set(
            [
              ...document.querySelectorAll<HTMLElement>("[data-epub-navigator-roll-occurrence]"),
            ].map((host) => Number(host.dataset.epubNavigatorRollOccurrence)),
          );
          const hostsAbove = [
            ...document.querySelectorAll<HTMLElement>("[data-epub-navigator-roll-occurrence]"),
          ].every((host) => getComputedStyle(host).zIndex === "1");
          return (
            previews.length > 0 === expected &&
            hostsAbove &&
            previews.every(
              (preview) =>
                preview.complete &&
                preview.naturalWidth > 0 &&
                getComputedStyle(preview).zIndex === "0",
            ) &&
            // Stand-ins lead the mounted window, so at least one has no child yet.
            (!expected ||
              previews.some(
                (preview) => !mounted.has(Number(preview.dataset.epubNavigatorRollPreview)),
              ))
          );
        }, imageSpine),
      )
      .toBe(true);
    const first = await page.locator('iframe[data-epub-navigator-occurrence="1"]').elementHandle();
    const geometry = await page.evaluate(() => {
      const frames = [
        ...document.querySelectorAll<HTMLIFrameElement>(
          'iframe[data-epub-navigator-participant="primary"]',
        ),
      ].sort(
        (a, b) =>
          Number(a.dataset.epubNavigatorOccurrence) - Number(b.dataset.epubNavigatorOccurrence),
      );
      return frames.map((frame) => {
        const rect = frame.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          intrinsic: [frame.clientWidth, frame.clientHeight],
        };
      });
    });
    for (const frame of geometry) {
      expect(frame.width).toBeCloseTo(640, 0);
      expect(frame.intrinsic).toEqual([1674, 1378]);
    }
    for (let i = 1; i < geometry.length; i++)
      expect(Math.abs(geometry[i]!.top - geometry[i - 1]!.bottom)).toBeLessThan(0.1);
    await roll.evaluate((element) => {
      element.scrollTop = 600;
    });
    await expect
      .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
      .toBe(1);
    expect(await first.evaluate((element) => element.isConnected)).toBe(true);
    const before = await roll.evaluate((element) => element.scrollTop);
    await page.evaluate(() => window.roll.setFixedZoom(2));
    expect(await roll.evaluate((element) => element.scrollTop)).toBeCloseTo(
      (before + 450) * 2 - 450,
      0,
    );
    await page.evaluate(() => window.roll.setFixedZoom(1));
    await expect.poll(() => roll.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
    const position = await page.evaluate(() => window.captureRoll());
    expect(position.status).toBe("generated");
    if (position.status !== "generated") throw new Error(JSON.stringify(position));
    expect(position.rollProgression).toBeGreaterThan(0);
    const evidenceA = await page.evaluate(() =>
      window.roll.currentLocation().location?.kind === "point"
        ? window.roll.currentLocation().location
        : null,
    );
    await roll.evaluate((element) => {
      element.scrollTop = 800;
    });
    const secondBookmark = await page.evaluate(() => window.captureRoll());
    expect(secondBookmark.status).toBe("generated");
    if (secondBookmark.status !== "generated") throw new Error(JSON.stringify(secondBookmark));
    expect(secondBookmark.targetJson).not.toBe(position.targetJson);
    const evidenceB = await page.evaluate(() => window.roll.currentLocation().location);
    expect(evidenceB).not.toEqual(evidenceA);
    const burstFrames = await page.evaluate(() => {
      for (const occurrence of [4, 5, 6, 7]) window.roll.open(occurrence);
      return document.querySelectorAll("iframe").length;
    });
    expect(burstFrames).toBeLessThan(7);
    await expect
      .poll(
        () => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence),
        { timeout: 30_000 },
      )
      .toBe(7);
    expect(await page.locator("iframe").count()).toBeLessThan(7);
    expect(await first.evaluate((element) => element.isConnected)).toBe(false);
    const restored = await page.evaluate(
      (position) => window.roll.restoreAnnotationTarget(position),
      position,
    );
    expect(restored.status).toBe("restored");
    await expect
      .poll(() => page.evaluate(() => window.roll.fixedRollProgression?.()))
      .toBeCloseTo(position.rollProgression!, 2);
    const retainedGeneration = await page.evaluate(
      () => window.roll.snapshot().document.committed!.generation,
    );
    await page.evaluate(() => window.roll.open(2));
    await expect
      .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
      .toBe(2);
    expect(
      await page.evaluate(() => window.roll.snapshot().document.committed!.generation),
    ).not.toBe(retainedGeneration);
    await page.evaluate(() => window.roll.open(1));
    expect(await page.evaluate(() => window.roll.snapshot().document.committed!.generation)).toBe(
      retainedGeneration,
    );
    const targetOnly = await page.evaluate(
      (targetJson) => window.roll.restoreAnnotationTarget({ targetJson, occurrenceHint: null }),
      secondBookmark.targetJson,
    );
    expect(targetOnly.status).toBe("restored");
    await expect
      .poll(() => page.evaluate(() => window.roll.fixedRollProgression?.()))
      .toBeCloseTo(secondBookmark.rollProgression!, 2);
    const progression = await page.evaluate(() => window.roll.fixedRollProgression?.());
    await page.locator("#frame-host").evaluate((element) => {
      element.style.width = "320px";
    });
    await expect
      .poll(() =>
        page
          .locator('iframe[data-epub-navigator-occurrence="1"]')
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeCloseTo(320, 0);
    await expect
      .poll(() => page.evaluate(() => window.roll.fixedRollProgression?.()))
      .toBeCloseTo(progression!, 2);
    await page.evaluate(() => window.roll.open(4));
    const afterResize = await page.evaluate(
      (targetJson) => window.roll.restoreAnnotationTarget({ targetJson, occurrenceHint: null }),
      position.targetJson,
    );
    expect(afterResize.status).toBe("restored");
    await expect
      .poll(() => page.evaluate(() => window.roll.fixedRollProgression?.()))
      .toBeCloseTo(position.rollProgression!, 2);
    await page.evaluate(() => window.roll.setFixedZoom(2));
    await expect
      .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
      .toBe("settled");
    await page.evaluate(() => window.roll.panFixedBy({ x: -250, y: 0 }));
    expect(await roll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    const boundary = await page.evaluate(() => {
      const frame = window.roll.snapshot().document.committed!.frame;
      return window.roll.relocate({
        kind: "point",
        occurrence: frame.occurrence,
        resource: frame.resource,
        evidence: [{ kind: "document-boundary", boundary: "start" }],
        observation: { layoutProgression: null, renderedTextProgression: null },
      });
    });
    expect(boundary).toMatchObject({ outcome: "completed", status: { status: "resolved" } });
    await expect.poll(() => roll.evaluate((element) => element.scrollLeft)).toBe(0);
    await page.mouse.move(160, 100);
    const scrollBeforeWheel = await roll.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, 100);
    await expect
      .poll(() => roll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrollBeforeWheel);
    const beforeForgedMessage = await roll.evaluate((element) => element.scrollTop);
    await page.evaluate(async () => {
      window.postMessage(
        { namespace: "epub-navigator-roll", type: "scroll", session: "forged", x: 0, y: 100000 },
        location.origin,
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    expect(await roll.evaluate((element) => element.scrollTop)).toBe(beforeForgedMessage);
    await page.evaluate(() => window.roll.close());
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(roll).toHaveCount(0);
    if (fixture.endsWith("-svg")) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/synthetic/fixed-roll-react.html");
    await expect(page.locator("[data-epub-navigator-roll]")).toHaveCount(1);
    await expect
      .poll(() => page.locator('iframe[data-epub-navigator-participant="primary"]').count())
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: /open quick menu/i }).click();
    await page.getByRole("button", { name: "Adjust fixed-page zoom" }).click();
    await expect(page.getByRole("button", { name: /zoom in/i })).toBeVisible();
    await page.getByRole("button", { name: /zoom in/i }).click();
    await expect(page.locator('[data-epub-navigator-roll-current="true"] iframe')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}
