import { test, expect, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import {
  contentType,
  instrumentFixtureXhtml,
  instrumentFixtureSvg,
  fixtureContentSecurityPolicy,
} from "../fixture-host.js";
import { ROLL_MAX_LIVE_CHILDREN } from "../../../src/runtime/fixed-layout/roll-geometry.js";

declare global {
  interface Window {
    rollOperation: Promise<unknown>;
    rollAbort: AbortController;
  }
}

async function fixture(page: Page, heights: number[], aliases = false, svg = false) {
  const entries: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    "EPUB/package.opf": strToU8(
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">roll-hardening</dc:identifier><dc:title>Roll hardening</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-09-13T00:00:00Z</meta><meta property="rendition:layout">roll</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${aliases ? '<item id="legacy" href="legacy.bin" media-type="application/x-test" fallback="p0"/>' : ""}${heights.map((_, i) => `<item id="p${i}" href="page-${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${aliases ? '<itemref idref="legacy" linear="no"/><itemref idref="p1"/><itemref idref="p0"/>' : ""}${heights.map((_, i) => (aliases && i < 2 ? "" : `<itemref idref="p${i}"/>`)).join("")}</spine></package>`,
    ),
    "EPUB/nav.xhtml": strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="page-0.xhtml">First page</a></li></ol></nav></body></html>',
    ),
    "EPUB/legacy.bin": strToU8("fallback"),
  };
  heights.forEach((height, i) => {
    entries[`EPUB/page-${i}.xhtml`] = strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page ${i}</title><meta name="viewport" content="width=640,height=${height}"/></head><body style="margin:0;background:#ddeeff"><p id="selection" style="position:absolute;top:20px;left:20px">Selectable words on page ${i}</p><a id="linear" href="page-0.xhtml#probe" style="position:absolute;top:70px">Linear link</a><a id="fallback" href="legacy.bin#probe" style="position:absolute;top:100px">Fallback link</a><input id="input" style="position:absolute;top:140px;left:20px"/><div id="nested" style="position:absolute;top:220px;left:20px;width:180px;height:160px;overflow:auto;touch-action:pan-y;background:white"><div style="height:1000px">Nested content</div></div><div id="probe" style="position:absolute;top:500px;left:0;width:20px;height:20px;background:red"/></body></html>`,
    );
  });
  if (svg) {
    entries["EPUB/package.opf"] = strToU8(
      new TextDecoder()
        .decode(entries["EPUB/package.opf"])
        .replace(
          /href="page-(\d+)\.xhtml" media-type="application\/xhtml\+xml"/gu,
          'href="page-$1.svg" media-type="image/svg+xml"',
        ),
    );
    entries["EPUB/nav.xhtml"] = strToU8(
      new TextDecoder().decode(entries["EPUB/nav.xhtml"]).replace("page-0.xhtml", "page-0.svg"),
    );
    heights.forEach((height, i) => {
      delete entries[`EPUB/page-${i}.xhtml`];
      entries[`EPUB/page-${i}.svg`] = strToU8(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 ${height}"><title>Page ${i}</title><rect id="probe" x="500" y="500" width="20" height="20" fill="red"/></svg>`,
      );
    });
  }
  const bytes = zipSync(entries);
  const counts = new Map<string, number>();
  const unavailable = new Set<number>();
  const bridgeFault = new Set<number>();
  await page.route("**/roll.epub", (route) =>
    route.fulfill({ body: Buffer.from(bytes), contentType: "application/epub+zip" }),
  );
  await page.route("**/roll-publication/**", (route) => {
    const path = decodeURIComponent(
      new URL(route.request().url()).pathname.slice("/roll-publication/".length),
    );
    counts.set(path, (counts.get(path) ?? 0) + 1);
    let source = entries[path];
    if (source === undefined) return route.fulfill({ status: 404 });
    if ([...bridgeFault].some((i) => path === `EPUB/page-${i}.xhtml`))
      source = strToU8(
        new TextDecoder()
          .decode(source)
          .replace(
            "</body>",
            '<script>window.postMessage = function() { throw new Error("test item transport failure"); };</script></body>',
          ),
      );
    const noAgent = [...unavailable].some((i) => path === `EPUB/page-${i}.xhtml`);
    return route.fulfill({
      body: Buffer.from(
        path.endsWith(".xhtml") && !noAgent
          ? instrumentFixtureXhtml(source)
          : path.endsWith(".svg")
            ? instrumentFixtureSvg(source, "/_epub-navigator/content-agent.js", null)
            : source,
      ),
      contentType: contentType(path),
      headers: { "Content-Security-Policy": fixtureContentSecurityPolicy },
    });
  });
  return { counts, unavailable, bridgeFault };
}

test("short pages stop at the hard budget with a recoverable capacity notice", async ({ page }) => {
  const { counts } = await fixture(page, [...Array.from({ length: 40 }, () => 1), 2000]);
  await page.goto("/synthetic/fixed-roll.html");
  await expect(page.locator("#result")).toHaveText("ready");
  await page.evaluate(() =>
    window.roll.setPaginationCapabilities({
      signal: new AbortController().signal,
      close() {},
      responses: {
        mount: {
          baseUrl: `${location.origin}/roll-publication/`,
          contentOrigin: "shared-reader-origin",
          remoteResources: "blocked",
        },
        eligibleResourcePaths: window.roll
          .snapshot()
          .readingOrder.flatMap((item) =>
            item.document.state === "loadable" ? [item.document.resource] : [],
          ),
      },
    }),
  );
  await expect(page.locator("[data-epub-navigator-roll-capacity]")).toBeVisible();
  expect(await page.locator("iframe").count()).toBeLessThanOrEqual(ROLL_MAX_LIVE_CHILDREN);
  expect(await page.locator("[data-epub-navigator-roll-occurrence]").count()).toBeLessThanOrEqual(
    ROLL_MAX_LIVE_CHILDREN,
  );
  const loaded = () => [...counts.values()].reduce((a, b) => a + b, 0);
  const reconciled = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  await expect
    .poll(() => page.evaluate(() => window.roll.paginationSnapshot()?.activity))
    .toBe("idle");
  await reconciled();
  const mounted = await page.locator("iframe").count();
  await expect.poll(loaded).toBe(mounted);
  await reconciled();
  expect(await page.locator("iframe").count()).toBe(mounted);
  expect(loaded(), JSON.stringify([...counts])).toBe(mounted);
  expect(mounted).toBeLessThanOrEqual(ROLL_MAX_LIVE_CHILDREN);
  await page.evaluate(() => window.roll.open(40));
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(40);
  await expect(page.locator("[data-epub-navigator-roll-capacity]")).toBeHidden();
  expect(await page.evaluate(() => window.roll.snapshot().session)).toBe("open");
});

test("readiness and active navigation failures stay item-local and retry only on demand", async ({
  page,
}) => {
  const { counts, unavailable, bridgeFault } = await fixture(
    page,
    Array.from({ length: 10 }, () => 1000),
  );
  unavailable.add(1);
  await page.goto("/synthetic/fixed-roll.html");
  const failure = page.locator(
    '[data-epub-navigator-roll-occurrence="1"] [data-epub-navigator-roll-failure]',
  );
  await expect(failure).toBeVisible({ timeout: 10000 });
  const retained = await page.locator('iframe[data-epub-navigator-occurrence="0"]').elementHandle();
  expect(await page.evaluate(() => window.roll.snapshot().session)).toBe("open");
  expect(await retained.evaluate((element) => element.isConnected)).toBe(true);
  expect(counts.get("EPUB/page-1.xhtml")).toBe(1);
  await page.evaluate(() => window.roll.open(7));
  await page.evaluate(() => window.roll.open(1));
  await expect(failure).toBeVisible();
  expect(counts.get("EPUB/page-1.xhtml")).toBe(1);
  unavailable.delete(1);
  await failure.getByRole("button", { name: "Retry page" }).click();
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(1);
  expect(counts.get("EPUB/page-1.xhtml")).toBe(2);
  await page
    .locator('iframe[data-epub-navigator-occurrence="1"]')
    .evaluate((frame: HTMLIFrameElement) => {
      frame.contentWindow!.location.replace("about:blank");
    });
  await expect(failure).toBeVisible();
  await expect(page.locator("#result")).toHaveText("ready");
  await page.evaluate(() => window.roll.reload());
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(1);
  await page.evaluate(() => window.roll.next());
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(2);
  bridgeFault.add(7);
  await page.evaluate(() => window.roll.open(7));
  await expect(
    page.locator('[data-epub-navigator-roll-occurrence="7"] [data-epub-navigator-roll-failure]'),
  ).toBeVisible();
  await expect(page.locator("#result")).toHaveText("ready");
  expect(await page.evaluate(() => window.roll.snapshot().session)).toBe("open");
  bridgeFault.delete(7);
  await page.evaluate(() => window.roll.reload());
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(7);
  unavailable.add(0);
  await page.goto("/synthetic/fixed-roll-react.html");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByRole("button", { name: "Navigation", exact: true })).toBeEnabled();
  unavailable.delete(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.locator(
      'iframe[data-epub-navigator-occurrence="0"][data-epub-navigator-participant="primary"]',
    ),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("authored links select the first linear alias and discard fragments on metadata fallback", async ({
  page,
}) => {
  await fixture(page, [1000, 1000, 1000, 1000], true);
  await page.goto("/synthetic/fixed-roll.html");
  await expect(page.locator("#result")).toHaveText("ready");
  await page.evaluate(() => window.roll.open(1));
  const source = page.frameLocator('iframe[data-epub-navigator-occurrence="1"]');
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(1);
  await source.locator("#linear").click();
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => window.roll.fixedRollProgression?.()))
    .toBeCloseTo(0.5, 2);
  await page.evaluate(() => window.roll.open(1));
  await source.locator("#fallback").click();
  // Only the nonlinear occurrence aliases legacy.bin; preserve the existing fallback rule.
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(0);
  await expect
    .poll(() => page.evaluate(() => window.roll.fixedRollProgression?.()))
    .toBeCloseTo(0, 2);
});

test("selection on the second visible page retains its owner across reconciliation and capture", async ({
  page,
}) => {
  await fixture(page, [200, 600, 400, 1000, 1000]);
  await page.goto("/synthetic/fixed-roll.html");
  await expect(
    page.locator(
      'iframe[data-epub-navigator-occurrence="1"][data-epub-navigator-participant="primary"]',
    ),
  ).toHaveCount(1);
  await page
    .locator('iframe[data-epub-navigator-occurrence="1"]')
    .evaluate((frame: HTMLIFrameElement) => {
      const doc = frame.contentDocument!;
      const range = doc.createRange();
      range.selectNodeContents(doc.querySelector("#selection")!);
      const selection = doc.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await expect
    .poll(() => page.evaluate(() => window.roll.currentSelection().selection?.status))
    .toBe("captured");
  const identity = await page.evaluate(async () => {
    const owner = window.roll.snapshot().document.committed!;
    await window.roll.captureSelection();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return {
      occurrence: owner.frame.occurrence,
      generation: owner.generation,
      current: window.roll.snapshot().document.committed!.generation,
      selection: window.roll.currentSelection().selection?.status,
    };
  });
  expect(identity).toMatchObject({
    occurrence: 1,
    current: identity.generation,
    selection: "captured",
  });
  await page.evaluate(() => window.roll.open(3));
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(3);
});

test("roll messages reject stale layout generations, wrong sessions, and oversized deltas", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const sessions = new Map<MessageEventSource | null, string>();
    (window as unknown as { rollSessions: typeof sessions }).rollSessions = sessions;
    window.addEventListener("message", (event) => {
      if (event.data?.namespace === "epub-navigator" && typeof event.data.session === "string")
        sessions.set(event.source, event.data.session);
    });
  });
  await fixture(page, [1200, 1000, 1600]);
  await page.goto("/synthetic/fixed-roll.html");
  await expect(page.locator("#result")).toHaveText("ready");
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
    .toBe("settled");
  const original = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[data-epub-navigator-occurrence="0"]',
    )!;
    const session = (
      window as unknown as { rollSessions: Map<MessageEventSource | null, string> }
    ).rollSessions.get(frame.contentWindow)!;
    const generation = window.roll.snapshot().document.committed!.layout.layout.layoutGeneration;
    let notifications = 0;
    const unsubscribe = window.roll.subscribe(() => notifications++);
    window.roll.setFixedZoom(1.25);
    unsubscribe();
    return { session, generation, notifications };
  });
  expect(original.notifications).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.roll.snapshot().document.committed!.layout.layout.layoutGeneration,
      ),
    )
    .not.toBe(original.generation);
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
    .toBe("settled");
  const generation = await page.evaluate(
    () => window.roll.snapshot().document.committed!.layout.layout.layoutGeneration,
  );
  const scroller = page.locator("[data-epub-navigator-roll]");
  const before = await scroller.evaluate((element) => element.scrollTop);
  await page
    .frameLocator('iframe[data-epub-navigator-occurrence="0"]')
    .locator("body")
    .evaluate(
      (_body, values) => {
        for (const data of [
          { session: values.session, layoutGeneration: values.old, y: 100 },
          { session: "wrong-session", layoutGeneration: values.current, y: 100 },
          { session: values.session, layoutGeneration: values.current, y: 1e9 },
        ])
          window.parent.postMessage(
            { namespace: "epub-navigator-roll", type: "scroll", x: 0, ...data },
            location.origin,
          );
      },
      { session: original.session, old: original.generation, current: generation },
    );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before);
  await page
    .frameLocator('iframe[data-epub-navigator-occurrence="0"]')
    .locator("body")
    .evaluate(
      (_body, values) => {
        window.parent.postMessage(
          {
            namespace: "epub-navigator-roll",
            type: "scroll",
            session: values.session,
            layoutGeneration: values.generation,
            x: 0,
            y: 25,
          },
          location.origin,
        );
      },
      { session: original.session, generation },
    );
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(before + 25);
});

test("target-only bookmarks preserve duplicate occurrence and reject conflicting positions without movement", async ({
  page,
}) => {
  await fixture(page, [1400, 1400, 1400, 1400], true);
  await page.goto("/synthetic/fixed-roll.html");
  await expect(page.locator("#result")).toHaveText("ready");
  await page.evaluate(() => window.roll.open(2));
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(2);
  await page.evaluate(() => window.roll.panFixedBy({ x: 0, y: -250 }));
  const bookmark = await page.evaluate(() => window.captureRoll());
  expect(bookmark.status).toBe("generated");
  if (bookmark.status !== "generated") throw new Error(JSON.stringify(bookmark));
  const target = JSON.parse(bookmark.targetJson) as Record<string, unknown>;
  expect(target["urn:epub-navigator:roll-occurrence"]).toBe(2);
  await page.evaluate(() => window.roll.open(1));
  expect(
    await page.evaluate(
      (targetJson) => window.roll.restoreAnnotationTarget({ targetJson, occurrenceHint: null }),
      bookmark.targetJson,
    ),
  ).toMatchObject({ status: "restored", occurrence: 2 });
  const before = await page
    .locator("[data-epub-navigator-roll]")
    .evaluate((element) => element.scrollTop);
  const invalid = [
    {
      targetJson: bookmark.targetJson,
      occurrenceHint: { occurrence: 0, resource: "EPUB/page-0.xhtml" },
    },
    {
      targetJson: JSON.stringify({ ...target, "urn:epub-navigator:roll-occurrence": 99 }),
      occurrenceHint: null,
    },
    { targetJson: JSON.stringify({ ...target, source: "page-3.xhtml" }), occurrenceHint: null },
    { targetJson: bookmark.targetJson, occurrenceHint: null, rollProgression: 0.9 },
    {
      targetJson: JSON.stringify({
        ...target,
        "urn:epub-navigator:roll-inline-progression": "0.2",
      }),
      occurrenceHint: null,
    },
  ];
  for (const position of invalid) {
    expect(
      await page.evaluate((position) => window.roll.restoreAnnotationTarget(position), position),
    ).toMatchObject({ status: "failed", reason: "invalid-position" });
    expect(
      await page.locator("[data-epub-navigator-roll]").evaluate((element) => element.scrollTop),
    ).toBe(before);
    expect(
      await page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence),
    ).toBe(2);
  }
  const location = await page.evaluate(async () => {
    await window.roll.captureCurrentLocation();
    return window.roll.currentLocation().location!;
  });
  await page.evaluate(() => window.roll.panFixedBy({ x: 0, y: -100 }));
  expect(await page.evaluate((location) => window.roll.relocate(location), location)).toMatchObject(
    { outcome: "completed", status: { status: "resolved" } },
  );
  await expect
    .poll(() => page.locator("[data-epub-navigator-roll]").evaluate((element) => element.scrollTop))
    .toBeCloseTo(before, 0);
});

test("outer geometry restoration observes supersession, late abort, deadline, and unavailable targets", async ({
  page,
}) => {
  await fixture(page, [1400, 1400, 1400]);
  await page.goto("/synthetic/fixed-roll.html");
  await expect(page.locator("#result")).toHaveText("ready");
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
    .toBe("settled");
  const target = JSON.stringify({
    source: "page-0.xhtml",
    selector: { type: "CssSelector", value: "#probe" },
  });
  await page.evaluate((targetJson) => {
    window.rollGeometry.delayNext();
    window.rollOperation = window.roll.restoreAnnotationTarget({
      targetJson,
      occurrenceHint: null,
    });
  }, target);
  await expect.poll(() => page.evaluate(() => window.rollGeometry.pending)).toBe(true);
  expect(
    await page.evaluate(() =>
      Promise.race([window.rollOperation, Promise.resolve().then(() => "pending")]),
    ),
  ).toBe("pending");
  const second = JSON.stringify({
    source: "page-0.xhtml",
    "urn:epub-navigator:roll-progression": 0.15,
  });
  expect(
    await page.evaluate(
      (targetJson) => window.roll.restoreAnnotationTarget({ targetJson, occurrenceHint: null }),
      second,
    ),
  ).toMatchObject({ status: "restored" });
  expect(await page.evaluate(() => window.rollOperation)).toMatchObject({
    status: "cancelled",
    reason: "superseded",
  });
  const scroller = page.locator("[data-epub-navigator-roll]");
  const before = await scroller.evaluate((element) => element.scrollTop);
  await page.evaluate(() => window.rollGeometry.release());
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(before);
  await page.evaluate((targetJson) => {
    window.rollAbort = new AbortController();
    window.rollGeometry.delayNext();
    window.rollOperation = window.roll.restoreAnnotationTarget(
      { targetJson, occurrenceHint: null },
      { signal: window.rollAbort.signal },
    );
  }, target);
  await expect.poll(() => page.evaluate(() => window.rollGeometry.pending)).toBe(true);
  await page.evaluate(() => window.rollAbort.abort());
  expect(await page.evaluate(() => window.rollOperation)).toMatchObject({
    status: "cancelled",
    reason: "abort",
  });
  await page.evaluate(() => window.rollGeometry.release());
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before);
  await page.evaluate((targetJson) => {
    window.rollGeometry.delayNext();
    window.rollOperation = window.roll.restoreAnnotationTarget(
      { targetJson, occurrenceHint: null },
      { timeoutMs: 250 },
    );
  }, target);
  await expect.poll(() => page.evaluate(() => window.rollGeometry.pending)).toBe(true);
  expect(await page.evaluate(() => window.rollOperation)).toMatchObject({
    status: "failed",
    reason: "timeout",
  });
  await page.evaluate(() => window.rollGeometry.release());
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before);
  expect(
    await page.evaluate(() =>
      window.roll.restoreAnnotationTarget({
        targetJson: JSON.stringify({
          source: "page-0.xhtml",
          selector: { type: "CssSelector", value: "#missing-target" },
        }),
        occurrenceHint: null,
      }),
    ),
  ).toMatchObject({ status: "failed", reason: "unavailable" });
  expect(
    await page.evaluate(() =>
      window.roll.relocateAnnotationTarget(
        JSON.stringify({
          source: "page-0.xhtml",
          selector: { type: "CssSelector", value: "#missing-target" },
        }),
      ),
    ),
  ).toMatchObject({ outcome: "failed", failure: { code: "operation-delivery-failed" } });
  await page.evaluate((targetJson) => {
    window.rollGeometry.delayNext();
    window.rollOperation = window.roll.relocateAnnotationTarget(targetJson);
  }, target);
  await expect.poll(() => page.evaluate(() => window.rollGeometry.pending)).toBe(true);
  await page.evaluate(
    (targetJson) => window.roll.restoreAnnotationTarget({ targetJson, occurrenceHint: null }),
    second,
  );
  expect(await page.evaluate(() => window.rollOperation)).toMatchObject({
    outcome: "failed",
    failure: { code: "operation-cancelled" },
  });
  await page.evaluate(() => window.rollGeometry.release());
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before);
  await page.evaluate(() => {
    window.rollGeometry.delayNext();
    const frame = window.roll.snapshot().document.committed!.frame;
    window.rollOperation = window.roll.relocate({
      kind: "point",
      occurrence: frame.occurrence,
      resource: frame.resource,
      evidence: [{ kind: "html-fragment", value: "probe" }],
      observation: { layoutProgression: null, renderedTextProgression: null },
    });
  });
  await expect.poll(() => page.evaluate(() => window.rollGeometry.pending)).toBe(true);
  await page.evaluate(
    (targetJson) => window.roll.restoreAnnotationTarget({ targetJson, occurrenceHint: null }),
    second,
  );
  expect(await page.evaluate(() => window.rollOperation)).toMatchObject({
    outcome: "failed",
    failure: { code: "operation-cancelled" },
  });
  await page.evaluate(() => window.rollGeometry.release());
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before);
  await page.evaluate((targetJson) => {
    window.rollGeometry.delayNext();
    window.rollOperation = window.roll.restoreAnnotationTarget({
      targetJson,
      occurrenceHint: null,
    });
  }, target);
  await expect.poll(() => page.evaluate(() => window.rollGeometry.pending)).toBe(true);
  await page.evaluate(() => window.roll.close());
  expect(await page.evaluate(() => window.rollOperation)).toMatchObject({
    status: "cancelled",
    reason: "close",
  });
  await page.evaluate(() => window.rollGeometry.release());
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("selection anchors reproject on outer movement and targets reveal both axes at zoom", async ({
  page,
}) => {
  await fixture(page, [1400, 1400, 1400]);
  await page.goto("/synthetic/fixed-roll.html");
  await expect(page.locator("#result")).toHaveText("ready");
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
    .toBe("settled");
  const frame = page.frameLocator('iframe[data-epub-navigator-occurrence="0"]');
  await frame.locator("#selection").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect
    .poll(() => page.evaluate(() => window.roll.currentSelection().selection?.status))
    .toBe("captured");
  const original = await page.evaluate(() => {
    const selected = window.roll.currentSelection().selection;
    if (selected?.status !== "captured") throw new Error("selection missing");
    return selected.anchor;
  });
  await page.evaluate(() => window.roll.panFixedBy({ x: 0, y: -100 }));
  const moved = await page.evaluate(() => {
    const selected = window.roll.currentSelection().selection;
    if (selected?.status !== "captured") throw new Error("selection missing");
    return selected.anchor;
  });
  expect(moved.rect.y).toBeCloseTo(original.rect.y! - 100, 0);
  expect(moved.rect.y!).toBeLessThan(moved.clippingRect.y!);
  expect(
    await page.evaluate(() => window.roll.snapshot().document.committed!.frame.occurrence),
  ).toBe(0);
  await page.evaluate(() => window.roll.setFixedZoom(2));
  await expect
    .poll(() => page.evaluate(() => window.roll.currentSelection().selection?.status))
    .toBe("captured");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selection = window.roll.currentSelection().selection;
        return selection?.status === "captured" ? selection.anchor.rect.height : 0;
      }),
    )
    .toBeCloseTo(original.rect.height! * 2, 0);
  await page.evaluate(() => window.roll.clearSelection());
  const previousGeneration = await page.evaluate(
    () => window.roll.snapshot().document.committed!.layout.layout.layoutGeneration,
  );
  await frame.locator("#probe").evaluate((element) => {
    (element as HTMLElement).style.left = "500px";
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.roll.snapshot().document.committed!.layout.layout.layoutGeneration,
      ),
    )
    .not.toBe(previousGeneration);
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
    .toBe("settled");
  await page.locator("[data-epub-navigator-roll]").evaluate((element) => {
    element.scrollLeft = 0;
  });
  expect(
    await page.evaluate(() =>
      window.roll.relocateAnnotationTarget(
        JSON.stringify({
          source: "page-0.xhtml",
          selector: { type: "CssSelector", value: "#probe" },
        }),
      ),
    ),
  ).toMatchObject({ outcome: "completed", result: { outcome: "resolved" } });
  const rect = (await frame.locator("#probe").boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(640);
  expect(rect.y).toBeCloseTo(0, 0);
  const bookmark = await page.evaluate(() => window.captureRoll());
  expect(bookmark.status).toBe("generated");
  if (bookmark.status !== "generated") throw new Error(JSON.stringify(bookmark));
  const embedded = JSON.parse(bookmark.targetJson);
  expect(embedded["urn:epub-navigator:roll-inline-progression"]).toBeGreaterThan(0);
  expect(embedded["urn:epub-navigator:roll-zoom"]).toBe(2);
  await page.evaluate(() => {
    window.roll.setFixedZoom(1);
    window.roll.open(1);
  });
  expect(
    await page.evaluate(
      (targetJson) => window.roll.restoreAnnotationTarget({ targetJson, occurrenceHint: null }),
      bookmark.targetJson,
    ),
  ).toMatchObject({ status: "restored" });
  expect(await page.evaluate(() => window.roll.fixedViewState()?.zoom)).toBe(2);
  const restoredRect = (await frame.locator("#probe").boundingBox())!;
  expect(restoredRect.x).toBeCloseTo(rect.x, 0);
  expect(restoredRect.y).toBeCloseTo(rect.y, 0);
  await page.evaluate(() => window.roll.panFixedBy({ x: 100, y: -100 }));
  expect(
    await page.evaluate(
      (targetJson) => window.roll.relocateAnnotationTarget(targetJson),
      bookmark.targetJson,
    ),
  ).toMatchObject({ outcome: "completed", result: { outcome: "resolved" } });
  const directRect = (await frame.locator("#probe").boundingBox())!;
  expect(directRect.x).toBeCloseTo(rect.x, 0);
  expect(directRect.y).toBeCloseTo(rect.y, 0);
});

test("authored SVG fragments reveal both axes and embedded bookmarks survive resize", async ({
  page,
}) => {
  await fixture(page, [1400, 1400], false, true);
  await page.goto("/synthetic/fixed-roll.html");
  await expect(page.locator("#result")).toHaveText("ready");
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
    .toBe("settled");
  await page.evaluate(() => window.roll.setFixedZoom(2));
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
    .toBe("settled");
  const fragment = await page.evaluate(() => {
    const frame = window.roll.snapshot().document.committed!.frame;
    return window.roll.relocate({
      kind: "point",
      occurrence: frame.occurrence,
      resource: frame.resource,
      evidence: [{ kind: "html-fragment", value: "probe" }],
      observation: { layoutProgression: null, renderedTextProgression: null },
    });
  });
  expect(fragment, JSON.stringify(fragment)).toMatchObject({
    outcome: "completed",
    status: { status: "resolved" },
  });
  const restored = await page.evaluate(() =>
    window.roll.restoreAnnotationTarget({
      targetJson: JSON.stringify({
        source: "page-0.svg",
        selector: [{ type: "CssSelector", value: "#probe" }],
      }),
      occurrenceHint: null,
    }),
  );
  expect(restored, JSON.stringify(restored)).toMatchObject({ status: "restored" });
  const probe = page.frameLocator('iframe[data-epub-navigator-occurrence="0"]').locator("#probe");
  const before = (await probe.boundingBox())!;
  expect(before.x).toBeGreaterThanOrEqual(0);
  expect(before.x + before.width).toBeLessThanOrEqual(640);
  expect(before.y).toBeCloseTo(0, 0);
  const bookmark = await page.evaluate(() => window.captureRoll());
  expect(bookmark.status).toBe("generated");
  if (bookmark.status !== "generated") throw new Error(JSON.stringify(bookmark));
  await page.evaluate(() => window.roll.open(1));
  await page.locator("#frame-host").evaluate((element) => {
    element.style.width = "320px";
  });
  expect(
    await page.evaluate(
      (targetJson) => window.roll.restoreAnnotationTarget({ targetJson, occurrenceHint: null }),
      bookmark.targetJson,
    ),
  ).toMatchObject({ status: "restored", occurrence: 0 });
  await expect.poll(async () => (await probe.boundingBox())?.x).toBeCloseTo(before.x / 2, 0);
  await expect.poll(async () => (await probe.boundingBox())?.y).toBeCloseTo(0, 0);
});

test("retained-child command revisions match notifications and close emits once before cleanup", async ({
  page,
}) => {
  await fixture(page, [1000, 1000, 1000]);
  await page.goto("/synthetic/fixed-roll.html");
  await expect(page.locator("#result")).toHaveText("ready");
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
    .toBe("settled");
  await page.evaluate(() => window.roll.open(1));
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.frame.occurrence))
    .toBe(1);
  await page.evaluate(() => window.roll.open(0));
  const report = await page.evaluate(() => {
    let observed = -1;
    let closed = 0;
    let framesAtClose = 0;
    window.roll.subscribe((transition) => {
      observed = transition.stateRevision;
      if (transition.events.some((event) => event.type === "closed")) {
        closed++;
        framesAtClose = document.querySelectorAll("iframe").length;
        window.roll.close();
      }
    });
    const results = [];
    const commands = [
      () => window.roll.setPresentationPreferences(window.roll.snapshot().layout.preferences),
      () => window.roll.reload(),
      () => window.roll.cancel(),
      () => window.roll.evictPreparedFrames(),
      () => window.roll.cancelSelectionAnnotationTargetGeneration(),
      () => window.roll.reload(),
    ];
    for (const command of commands) {
      const returned = command();
      results.push({
        returned: returned.stateRevision,
        observed,
        snapshot: window.roll.snapshot().stateRevision,
      });
    }
    const first = window.roll.close();
    const second = window.roll.close();
    return {
      results,
      closed,
      framesAtClose,
      first,
      second,
      remaining: document.querySelectorAll("iframe").length,
    };
  });
  for (const result of report.results)
    expect(result).toEqual({
      returned: result.observed,
      observed: result.observed,
      snapshot: result.observed,
    });
  expect(report.closed).toBe(1);
  expect(report.framesAtClose).toBeGreaterThan(0);
  expect(report.remaining).toBe(0);
  expect(report.first).toEqual(report.second);
  expect(report.first.events).toEqual([{ type: "closed" }]);
  expect(report.first.stateRevision).toBeGreaterThan(report.results.at(-1)!.returned);
});

test.describe("real mobile touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("existing fixed drag and pinch gestures move the outer roll while controls retain input", async ({
    page,
    context,
  }) => {
    await fixture(page, [1200, 600, 1600, 800, 1000]);
    await page.goto("/synthetic/fixed-roll.html");
    await expect(page.locator("#result")).toHaveText("ready");
    await expect
      .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
      .toBe("settled");
    const client = await context.newCDPSession(page);
    const touch = async (
      type: "touchStart" | "touchMove" | "touchEnd",
      points: { x: number; y: number; id: number }[],
    ) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    await touch("touchStart", [{ x: 330, y: 550, id: 1 }]);
    await touch("touchMove", [{ x: 330, y: 490, id: 1 }]);
    await touch("touchMove", [{ x: 330, y: 400, id: 1 }]);
    await touch("touchEnd", []);
    await expect
      .poll(() =>
        page.locator("[data-epub-navigator-roll]").evaluate((element) => element.scrollTop),
      )
      .toBeGreaterThan(100);
    const revision = await page.evaluate(() => window.roll.snapshot().stateRevision);
    await touch("touchStart", [
      { x: 130, y: 250, id: 1 },
      { x: 230, y: 250, id: 2 },
    ]);
    await touch("touchMove", [
      { x: 110, y: 250, id: 1 },
      { x: 250, y: 250, id: 2 },
    ]);
    await touch("touchMove", [
      { x: 70, y: 250, id: 1 },
      { x: 290, y: 250, id: 2 },
    ]);
    await touch("touchEnd", []);
    await expect
      .poll(() => page.evaluate(() => window.roll.fixedViewState()?.zoom))
      .toBeGreaterThan(1);
    expect(await page.evaluate(() => window.roll.snapshot().stateRevision)).toBeGreaterThan(
      revision,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.evaluate(() => {
      window.roll.setFixedZoom(1);
      window.roll.open(0);
    });
    await expect
      .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
      .toBe("settled");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const nested = page
      .frameLocator('iframe[data-epub-navigator-occurrence="0"]')
      .locator("#nested");
    const rect = (await nested.boundingBox())!;
    const before = await page
      .locator("[data-epub-navigator-roll]")
      .evaluate((element) => element.scrollTop);
    await touch("touchStart", [{ x: rect.x + 50, y: rect.y + rect.height - 10, id: 1 }]);
    await touch("touchMove", [{ x: rect.x + 50, y: rect.y + 40, id: 1 }]);
    await touch("touchMove", [{ x: rect.x + 50, y: rect.y + 10, id: 1 }]);
    await touch("touchEnd", []);
    await expect.poll(() => nested.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(
      await page.locator("[data-epub-navigator-roll]").evaluate((element) => element.scrollTop),
    ).toBe(before);
    const input = page.frameLocator('iframe[data-epub-navigator-occurrence="0"]').locator("#input");
    await input.tap();
    await input.fill("touch input");
    await expect
      .poll(() => input.evaluate((element) => (element as HTMLInputElement).value))
      .toBe("touch input");
  });
});

test("bottoming out is the end of the last page, not a fraction of it", async ({ page }) => {
  // A last page shorter than the viewport never reaches the scroller's top edge.
  await fixture(page, [1400, 1400, 300]);
  await page.goto("/synthetic/fixed-roll.html");
  await expect(page.locator("#result")).toHaveText("ready");
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
    .toBe("settled");
  await page.locator("[data-epub-navigator-roll]").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      page.evaluate(() => ({
        occurrence: window.roll.snapshot().document.committed?.frame.occurrence ?? null,
        progression: window.roll.fixedRollProgression?.() ?? null,
      })),
    )
    .toEqual({ occurrence: 2, progression: 1 });
});

test("fast scrolling never republishes an uncommitted snapshot over a committed page", async ({
  page,
}) => {
  await fixture(
    page,
    Array.from({ length: 12 }, () => 900),
  );
  await page.goto("/synthetic/fixed-roll.html");
  await expect(page.locator("#result")).toHaveText("ready");
  await expect
    .poll(() => page.evaluate(() => window.roll.snapshot().document.committed?.layout.state))
    .toBe("settled");
  // The reader blanks to its opening surface whenever the published snapshot has no
  // committed document, so scrolling faster than pages load must not produce one.
  const lapses = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>("[data-epub-navigator-roll]")!;
    let uncommitted = 0;
    let unlocated = 0;
    for (let step = 0; step < 40; step++) {
      scroller.scrollTop += 500;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (window.roll.snapshot().document.committed === null) uncommitted++;
      if (window.roll.visibleOccurrenceRange() === null) unlocated++;
    }
    return { uncommitted, unlocated };
  });
  expect(lapses).toEqual({ uncommitted: 0, unlocated: 0 });
});
