import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { instrumentXhtml } from "../../../src/xhtml-instrumentation.js";
import { instrumentSvg } from "../../../src/svg-instrumentation.js";
import { imageDocumentQuery, imageDocumentSource } from "../../../src/image-document.js";
import { contentType } from "../fixture-host.js";
import { readRollFixture, rollFixtures } from "./roll-fixture.js";

test.use({ launchOptions: { args: ["--site-per-process"] } });

for (const fixture of rollFixtures) {
  test(`${fixture}: isolated nonce-only publication viewport, zoom, and target-only bookmark`, async ({
    page,
  }) => {
    const { bytes, resources } = await readRollFixture(fixture);
    const agent = await readFile(new URL("../../../dist/content-agent.js", import.meta.url));
    const nonce = "roll-cross-origin-agent-only";
    let origin = "";
    const server = createServer((request, response) => {
      const url = new URL(request.url!, origin);
      if (url.pathname === "/__agent.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.end(agent);
        return;
      }
      const path = decodeURIComponent(url.pathname.slice(1));
      const original = resources[path];
      if (original === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      let source: Uint8Array = original;
      let mime = contentType(path);
      const options = { contentAgentUrl: `${origin}/__agent.js`, nonce };
      if (url.search === `?${imageDocumentQuery}` && mime.startsWith("image/")) {
        url.search = "";
        source = instrumentXhtml(imageDocumentSource(url.href), options);
        mime = "application/xhtml+xml";
      } else if (url.search) {
        response.writeHead(400);
        response.end();
        return;
      } else if (path.endsWith(".xhtml")) source = instrumentXhtml(source, options);
      else if (path.endsWith(".svg")) source = instrumentSvg(source, options);
      response.writeHead(200, {
        "Content-Type": mime,
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:4174; sandbox allow-scripts allow-same-origin`,
      });
      response.end(source);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://p-roll.localhost:${(server.address() as { port: number }).port}`;
    try {
      await page.route("**/roll.epub", (route) =>
        route.fulfill({ body: bytes, contentType: "application/epub+zip" }),
      );
      await page.goto(
        `/synthetic/fixed-roll.html?publication-origin=${encodeURIComponent(origin)}`,
      );
      await expect(page.locator("#result")).toHaveText("ready");
      await expect
        .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state), {
          timeout: 5000,
        })
        .toBe("settled");
      await expect
        .poll(() => page.locator('iframe[data-epub-navigator-participant="primary"]').count())
        .toBeGreaterThanOrEqual(3);
      await expect(page.locator("[data-epub-navigator-roll-failure]")).toHaveCount(0);
      const dimensions = await page
        .frameLocator('iframe[data-epub-navigator-occurrence="0"]')
        .locator(":root")
        .evaluate(() => [window.innerWidth, window.innerHeight]);
      expect(dimensions).toEqual([1674, 1378]);
      const forbidden = await page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
        try {
          return frame.contentWindow!.document.documentElement !== null;
        } catch (error) {
          return (error as DOMException).name;
        }
      });
      expect(forbidden).toBe("SecurityError");
      await page.evaluate(() => window.roll.setFixedZoom(2));
      await page.evaluate(() => window.roll.panFixedBy({ x: -180, y: -80 }));
      const position = await page.evaluate(() => window.captureRoll());
      expect(position.status, JSON.stringify(position)).toBe("generated");
      if (position.status !== "generated") throw new Error(JSON.stringify(position));
      await page.evaluate(() => window.roll.open(5));
      expect(
        await page.evaluate(
          (targetJson) => window.roll.restoreAnnotationTarget({ targetJson, occurrenceHint: null }),
          position.targetJson,
        ),
      ).toMatchObject({ status: "restored", occurrence: position.occurrenceHint!.occurrence });
      await expect
        .poll(() => page.evaluate(() => window.roll.fixedRollProgression?.()))
        .toBeCloseTo(position.rollProgression!, 2);
      const nativeTarget = JSON.stringify({
        ...JSON.parse(position.targetJson),
        "urn:epub-navigator:roll-progression": 0.22313801721743962,
      });
      expect(
        await page.evaluate(
          (targetJson) =>
            window.roll.restoreAnnotationTarget({
              targetJson,
              occurrenceHint: null,
              rollProgression: 0.2231380172174396,
            }),
          nativeTarget,
        ),
      ).toMatchObject({ status: "restored" });
      expect(await page.locator("iframe").count()).toBeLessThanOrEqual(12);
      await page.evaluate(() => window.roll.close());
      await expect(page.locator("iframe")).toHaveCount(0);
    } finally {
      await page.goto("about:blank");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
