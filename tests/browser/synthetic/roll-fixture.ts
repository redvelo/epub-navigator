import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import {
  contentType,
  fixtureContentSecurityPolicy,
  instrumentFixtureImageDocument,
  instrumentFixtureSvg,
  instrumentFixtureXhtml,
} from "../fixture-host.js";
import { imageDocumentQuery } from "../../../src/image-document.js";

export const rollFixtures = [
  "lay-roll-embedded-images",
  "lay-roll-embedded-images-svg",
  "lay-roll-images-in-spine",
  "lay-roll-images-mixed",
] as const;

export async function readRollFixture(fixture: string) {
  const bytes = await readFile(new URL(`../../fixtures/epub34/${fixture}.epub`, import.meta.url));
  return { bytes, resources: unzipSync(bytes) };
}

export async function routeRollFixture(page: Page, fixture: string): Promise<void> {
  const { bytes, resources } = await readRollFixture(fixture);
  await page.route("**/roll.epub", (route) =>
    route.fulfill({ body: bytes, contentType: "application/epub+zip" }),
  );
  await page.route("**/roll-publication/**", (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname.slice("/roll-publication/".length));
    const original = resources[path];
    if (original === undefined) return route.fulfill({ status: 404 });
    let source: Uint8Array = original;
    let mime = contentType(path);
    if (url.search === `?${imageDocumentQuery}` && mime.startsWith("image/")) {
      url.search = "";
      source = instrumentFixtureImageDocument(url.href);
      mime = "application/xhtml+xml";
    } else if (url.search) return route.fulfill({ status: 400 });
    else if (path.endsWith(".xhtml")) source = instrumentFixtureXhtml(source);
    else if (path.endsWith(".svg"))
      source = instrumentFixtureSvg(source, "/_epub-navigator/content-agent.js", null);
    return route.fulfill({
      body: Buffer.from(source),
      contentType: mime,
      headers: { "Content-Security-Policy": fixtureContentSecurityPolicy },
    });
  });
}
