import { fileURLToPath } from "node:url";
import { test as base, expect, type Locator, type Page } from "@playwright/test";

export { expect };

export interface PublicationFilePayload {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

export interface CachedResource {
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly responseInstrumentation: string;
  readonly executableContent: string;
  readonly foregroundPreparation?: string;
}

export const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export const alice = fixture("alice-in-wonderland.epub");

export const test = base.extend<{
  openPublication(source: string | PublicationFilePayload, timeout?: number): Promise<void>;
}>({
  openPublication: async ({ page }, provide) => {
    await provide(async (source, timeout = 30_000) => {
      await page.goto("/");
      await expect(library(page)).toBeVisible();
      await page.locator('input[type="file"]').setInputFiles(source);
      await expect(library(page)).toBeHidden({ timeout });
      await expect(readerFrame(page)).toBeVisible({ timeout });
      await expect(reader(page)).toBeVisible({ timeout });
    });
  },
});

/**
 * Waits until an element stops moving.
 *
 * Compact surfaces animate in from an edge, so geometry read the moment a drawer mounts is
 * its pre-enter position, which is off-screen by the drawer's own height.
 */
export async function settle(locator: Locator): Promise<void> {
  let previous: number | null = null;
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      const y = box === null ? null : box.y;
      const stable = y !== null && y === previous;
      previous = y;
      return stable;
    })
    .toBe(true);
}

export function library(page: Page): Locator {
  return page.getByRole("heading", { name: "Local publications" });
}

export function reader(page: Page): Locator {
  return page.locator('[data-reader-state="reading"]');
}

export function readerFrame(page: Page): Locator {
  return page.locator('iframe:not([aria-hidden="true"])[title$="publication content"]');
}

export async function returnToLibrary(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  await page.getByRole("button", { name: /library$/iu }).click();
  await expect(library(page)).toBeVisible();
}

export async function cachedResources(page: Page): Promise<{
  readonly id: string;
  readonly resources: readonly CachedResource[];
}> {
  return page.evaluate(async () => {
    const cacheName = (await caches.keys()).find((name) =>
      /^epub-navigator:[0-9a-f]{64}$/u.test(name),
    );
    if (cacheName === undefined) throw new Error("the imported publication cache is missing");
    const cache = await caches.open(cacheName);
    const key = (await cache.keys()).find((request) => request.url.endsWith("/resources.json"));
    if (key === undefined) throw new Error("the resource manifest is missing");
    const manifest = (await (await cache.match(key))!.json()) as {
      readonly resources: readonly CachedResource[];
    };
    return { id: cacheName.slice("epub-navigator:".length), resources: manifest.resources };
  });
}
