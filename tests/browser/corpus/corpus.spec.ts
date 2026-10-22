import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import {
  corpusPublications,
  type CorpusExpectedOutcome,
  type CorpusPublication,
  type CorpusScenario,
} from "../../fixtures/epub3-samples/catalog.js";
import type { CorpusApi, ScenarioReport } from "./main.js";

interface ScenarioContext {
  readonly page: Page;
  readonly publication: CorpusPublication;
  readonly scenario: CorpusScenario;
  readonly report: ScenarioReport;
  readonly origin: string;
}

interface Behavior {
  setup?(
    page: Page,
    options: { readonly isMobile: boolean; readonly origin: string },
  ): Promise<void>;
  verify(context: ScenarioContext): Promise<void>;
}

// WebKit logs denied cross-origin frame access, such as the contentDocument probe below, as a
// JavaScript error that Playwright reports as a page error even though nothing was thrown.
const crossOriginAccessDiagnostic = /^Blocked a frame with origin "[^"]*" from accessing a frame/u;
const primarySelector = 'iframe[data-epub-navigator-participant="primary"]';
const companionSelector = 'iframe[data-epub-navigator-participant="fixed-companion"]';

for (const publication of corpusPublications as readonly CorpusPublication[]) {
  for (const scenario of publication.scenarios) {
    test(`${scenario.id} reports its declared compatibility outcome`, async ({
      page,
      isMobile,
    }, testInfo) => {
      const origin = `http://${publication.id}.localhost:4174`;
      const pageErrors: Error[] = [];
      page.on("pageerror", (error) => {
        if (!crossOriginAccessDiagnostic.test(error.stack ?? "")) pageErrors.push(error);
      });
      const behavior = behaviors[scenario.id];
      await behavior?.setup?.(page, { isMobile, origin });

      await page.goto(`/corpus/?scenario=${encodeURIComponent(scenario.id)}`);
      const result = page.locator("#result");
      await expect(result).toHaveAttribute("data-state", /^(?:failed|ready)$/u, {
        timeout: 45_000,
      });
      if ((await result.getAttribute("data-state")) === "failed") {
        throw new Error((await result.textContent()) ?? "corpus scenario failed without a report");
      }
      const report = JSON.parse((await result.textContent())!) as ScenarioReport;
      const expected = { outcome: scenario.expectedOutcome, reason: scenario.expectedReason };
      const observed = classify(report, scenario);
      await testInfo.attach("compatibility-scenario.json", {
        body: JSON.stringify(
          {
            browser: testInfo.project.name,
            hostProfile: "isolated-publication-origin",
            expected,
            observed,
            report,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      expect(observed).toEqual(expected);

      expect(report.lifecycle).toMatchObject({
        pending: null,
        committed: { frame: { occurrence: scenario.occurrence, resource: scenario.resource } },
      });
      // A primary frame is promoted in the DOM before it is revealed: fixed-spread staging holds
      // it hidden while a companion loads, and the fallback that gives up on one only fires at
      // FIXED_SPREAD_STAGING_TIMEOUT_MS. Polling for the default five seconds races that exactly.
      await expect
        .poll(
          () =>
            page.locator(primarySelector).evaluate((frame: HTMLIFrameElement) => ({
              src: frame.src,
              title: frame.title,
              sandbox: frame.getAttribute("sandbox"),
              sameOriginAccess: frame.contentDocument !== null,
              inert: frame.inert,
              tabIndex: frame.getAttribute("tabindex"),
              ariaHidden: frame.getAttribute("aria-hidden"),
            })),
          { timeout: 15_000 },
        )
        .toEqual({
          src: `${origin}/${scenario.resource}`,
          title: publication.title,
          sandbox: "allow-scripts allow-same-origin",
          sameOriginAccess: false,
          inert: false,
          tabIndex: null,
          ariaHidden: null,
        });
      const eventTypes = report.events.map((event) => event.type);
      expect(eventTypes).toContain("document-pending");
      expect(eventTypes.indexOf("layout-reported")).toBeGreaterThanOrEqual(0);
      expect(eventTypes.indexOf("document-committed")).toBeGreaterThan(
        eventTypes.indexOf("layout-reported"),
      );
      if (scenario.writingMode !== undefined && expected.reason === null) {
        expect(report.observation.writingMode).toBe(scenario.writingMode);
      }
      if (scenario.direction !== undefined) {
        expect(report.observation.direction).toBe(scenario.direction);
      }
      if (scenario.language !== undefined) {
        expect(report.observation.language).toBe(scenario.language);
      }
      if (scenario.viewport !== undefined) await expectFixedPresentation(page, scenario, report);

      await behavior?.verify({ page, publication, scenario, report, origin });
      expect(pageErrors).toEqual([]);
      expect(await call(page, "close")).toBe(0);
    });
  }
}

test("corpus host rejects non-catalog and malformed routes", async ({ request }) => {
  expect((await request.get("/corpus/unknown.epub")).status()).toBe(404);
  expect((await request.get("/corpus/accessible-epub-3.epub?query=1")).status()).toBe(400);
  expect((await request.get("http://unknown.localhost:4174/EPUB/package.opf")).status()).toBe(404);
  expect(
    (
      await request.get("http://accessible-epub-3.localhost:4174/EPUB/%252e%252e/package.opf")
    ).status(),
  ).toBe(400);
  expect(
    (await request.get("http://accessible-epub-3.localhost:4174/EPUB%2Fpackage.opf")).status(),
  ).toBe(400);
});

test("corpus host serves manifest-declared media types", async ({ request }) => {
  const origin = "http://moby-dick-media-overlays.localhost:4174";
  const smil = await request.get(`${origin}/OPS/chapter_001_overlay.smil`);
  expect(smil.status()).toBe(200);
  expect(smil.headers()).toMatchObject({
    "content-type": "application/smil+xml",
    "x-content-type-options": "nosniff",
  });
  expect(await smil.text()).toContain('epub:textref="chapter_001.xhtml"');

  const audioUrl = `${origin}/OPS/audio/mobydick_001_002_melville.mp4`;
  const audio = await request.get(audioUrl);
  expect(audio.status()).toBe(200);
  expect(audio.headers()).toMatchObject({
    "content-type": "audio/mp4",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "cross-origin-resource-policy": "same-origin",
  });
  const length = (await audio.body()).byteLength;
  const partial = await request.get(audioUrl, {
    headers: { range: "bytes=10-19", "sec-fetch-dest": "audio" },
  });
  expect(partial.status()).toBe(206);
  expect(partial.headers()).toMatchObject({
    "content-range": `bytes 10-19/${length}`,
    "cross-origin-resource-policy": "cross-origin",
  });
  expect(
    Object.keys(partial.headers()).filter((name) => name.startsWith("access-control-")),
  ).toEqual([]);
  expect((await partial.body()).byteLength).toBe(10);
  const unsatisfiable = await request.get(audioUrl, { headers: { range: `bytes=${length}-` } });
  expect(unsatisfiable.status()).toBe(416);
  expect(unsatisfiable.headers()["content-range"]).toBe(`bytes */${length}`);
});

function classify(report: ScenarioReport, scenario: CorpusScenario): CorpusExpectedOutcome {
  if (report.cfiTargets) return { outcome: "degraded", reason: "cfi-dom-resolution-unsupported" };
  if (
    report.pagination?.state === "unavailable" &&
    report.pagination.reason === "declared-scripted"
  ) {
    return { outcome: "degraded", reason: "background-pagination-declared-scripted" };
  }
  if (
    scenario.writingMode !== undefined &&
    report.observation.writingMode !== scenario.writingMode
  ) {
    return { outcome: "degraded", reason: "vertical-writing-style-unavailable" };
  }
  return { outcome: "supported", reason: null };
}

async function expectFixedPresentation(
  page: Page,
  scenario: CorpusScenario,
  report: ScenarioReport,
): Promise<void> {
  const adapter = scenario.kind;
  expect(report.presentation).toMatchObject({
    plan: { adapter },
    settlement: {
      adapter,
      settlement: { mode: "contain", geometry: { intrinsicViewport: scenario.viewport } },
    },
    issue: null,
  });
  expect(report.pagination).toMatchObject({
    state: "measured",
    occurrence: scenario.occurrence,
    pageCount: 1,
  });
  const geometry = fixedGeometry(report);
  expect(geometry.scale).toBeGreaterThan(0);
  expect(geometry.renderedWidth).toBeLessThanOrEqual(geometry.containingViewport.width);
  expect(geometry.renderedHeight).toBeLessThanOrEqual(geometry.containingViewport.height);
  await expect.poll(() => frameViewport(primary(page))).toEqual(scenario.viewport);

  const frame = page.locator(`iframe[src*=${JSON.stringify(scenario.resource)}]`);
  const transform = await frame.evaluate((element) => element.style.transform);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({
    width: Math.max(320, viewport.width - 120),
    height: viewport.height + 80,
  });
  await expect.poll(() => frame.evaluate((element) => element.style.transform)).not.toBe(transform);
  expect(await frameViewport(primary(page))).toEqual(scenario.viewport);
}

const trees: Behavior = {
  async verify({ page, scenario }) {
    const evidence = await evaluateIn(primary(page), () => {
      const canvas = document.querySelector("canvas");
      const columns = document.querySelector<HTMLElement>(".mcol");
      return {
        canvasSize: canvas === null ? null : { width: canvas.width, height: canvas.height },
        readingSystem: navigator.epubReadingSystem?.hasFeature("spine-scripting") === true,
        heading: document.querySelector("h1, h2")?.textContent?.trim() ?? null,
        columnCount: columns === null ? null : getComputedStyle(columns).columnCount,
      };
    });
    expect(evidence).toMatchObject(
      scenario.id === "trees.authored-columns"
        ? {
            canvasSize: { width: 256, height: 128 },
            readingSystem: true,
            heading: "Classification",
            columnCount: "2",
          }
        : { canvasSize: { width: 600, height: 400 }, readingSystem: true },
    );
  },
};

const mobyDick: Behavior = {
  async verify({ page, scenario, origin }) {
    const text = await evaluateIn(primary(page), () => ({
      heading: document.querySelector("h1, h2")?.textContent?.trim() ?? null,
      words: ["c01w00001", "c01w00002", "c01w00003"].map(
        (id) => document.getElementById(id)?.textContent?.trim() ?? null,
      ),
    }));
    if (scenario.id === "moby-dick-media-overlays.chapter") {
      expect(text).toEqual({ heading: "Chapter 1. Loomings.", words: ["Call", "me", "Ishmael."] });
    } else {
      expect(text.heading).toBe("Chapter 2. The Carpet-Bag.");
    }
    await call(page, "narrate");
    const started = (await call(page, "narration"))!;
    await expect
      .poll(
        async () => {
          const narration = (await call(page, "narration"))!;
          return narration.state === "playing" && narration.currentTime > started.currentTime + 0.5;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(await call(page, "narration")).toMatchObject({
      source: expect.stringContaining(`${origin}/OPS/audio/`),
      error: null,
    });
    await expect(primary(page).locator(".-epub-media-overlay-active").first()).toBeAttached();
  },
};

const behaviors: Readonly<Record<string, Behavior>> = {
  "trees.publisher-scripts": trees,
  "trees.authored-columns": trees,
  "moby-dick-media-overlays.chapter": mobyDick,
  "moby-dick-media-overlays.chapter-2": mobyDick,
  "arabic.rtl-content": {
    async verify({ page }) {
      const evidence = await evaluateIn(primary(page), () => {
        const heading = document.querySelector("h1, h2");
        return {
          heading: heading?.textContent?.trim() ?? null,
          authoredDirection: document.documentElement.getAttribute("dir"),
          headingWidth: heading?.getBoundingClientRect().width ?? 0,
        };
      });
      expect(evidence).toMatchObject({ heading: "الفصل الثاني", authoredDirection: "rtl" });
      expect(evidence.headingWidth).toBeGreaterThan(0);
    },
  },
  "accessible-epub-3.navigation-semantics": {
    async verify({ page }) {
      await expect(primary(page).locator("nav#toc")).toBeAttached();
      await expect(primary(page).locator("nav#landmarks")).toBeAttached();
      await expect(page.getByRole("main")).toBeVisible();
      const frame = page.locator('iframe[title="Accessible EPUB 3"]');
      await frame.focus();
      await expect(frame).toBeFocused();
    },
  },
  "accessible-epub-3.image-cover": {
    async verify({ page }) {
      await expectReadingPosition(page, 0, { boundary: true });
    },
  },
  "vertical-writing.layout": {
    async verify({ page }) {
      await call(page, "next");
      await expect.poll(() => committedOccurrence(page)).toBe(2);
      await call(page, "previous");
      await expect.poll(() => committedOccurrence(page)).toBe(1);
    },
  },
  "voyage-of-life.mixed-fixed": {
    async verify({ page, report }) {
      expect(report.lifecycle.committed?.generation).toBe(1);
      expect(await call(page, "open", 1)).toMatchObject({
        generation: 2,
        presentation: {
          plan: { adapter: "reflowable-xhtml", mode: "paginated" },
          settlement: {
            adapter: "reflowable-xhtml",
            mode: "paginated",
            settlement: { mode: "paginated" },
          },
          issue: null,
        },
      });
      expect(await call(page, "open", 2)).toMatchObject({
        generation: 3,
        presentation: {
          plan: { adapter: "fixed-xhtml" },
          settlement: { adapter: "fixed-xhtml", settlement: { mode: "contain" } },
          issue: null,
        },
      });
      await expect(page.locator("iframe")).toHaveCount(1);
    },
  },
  "internal-links.navigation": {
    async verify({ page }) {
      const frame = primary(page);
      const links = await frame
        .locator("a[href]")
        .evaluateAll((anchors) =>
          anchors
            .map((anchor) => anchor.getAttribute("href")!)
            .filter((href) => /^(?:0001\.xhtml#|xnotes\.xhtml#|http:\/\/)/u.test(href)),
        );
      expect(links).toEqual([
        "xnotes.xhtml#n.0001.1.r",
        "http://readium.org/news/readium-019-update-adds-mathml-support",
        "0001.xhtml#t.0001.メジャーなEPUBリーダのMathJaxサポート",
        "0001.xhtml#f.0001.サンプル数式のiBooks3_2e0による表示_EF_BC_91",
        "0001.xhtml#f.0001.サンプル数式のiBooks3_2e0による表示_EF_BC_92",
      ]);
      const [crossDocument, external, sameDocument] = links as [string, string, string];

      await frame.locator(`a[href=${JSON.stringify(sameDocument)}]`).click();
      await expect.poll(() => call(page, "activations")).toContain(sameDocument);
      expect(await committedOccurrence(page)).toBe(1);
      await expectTargetInView(frame, sameDocument);

      const topLevel = page.url();
      await frame.locator(`a[href=${JSON.stringify(external)}]`).dispatchEvent("click");
      await expect.poll(() => call(page, "activations")).toContain(external);
      expect(page.url()).toBe(topLevel);

      await frame.locator(`a[href=${JSON.stringify(crossDocument)}]`).dispatchEvent("click");
      await expect.poll(() => committedOccurrence(page), { timeout: 30_000 }).toBe(5);
      expect(await call(page, "activations")).toContain(crossDocument);
      await expectTargetInView(primary(page), crossDocument);
    },
  },
  "haruko.fixed-manga": {
    async verify({ page }) {
      await expectImageLoaded(primary(page));
    },
  },
  "haruko.fixed-spread": {
    async verify({ page, origin }) {
      await expectImageLoaded(primary(page));
      const landscape = await page.evaluate(() => innerWidth > innerHeight);
      if (landscape) await verifyDesktopSpread(page, origin);
      else await verifyMobileSpread(page);
    },
  },
  "page-blanche.fixed-layout": {
    async setup(page, { isMobile }) {
      if (!isMobile) await page.setViewportSize({ width: 1600, height: 700 });
    },
    async verify({ page }) {
      await verifyPageBlanche(page);
    },
  },
  "svg-in-spine.fixed-svg": {
    async setup(page, { origin }) {
      await page.route(`${origin}/OPS/Images/publisher-script.js`, (route) =>
        route.fulfill({
          contentType: "text/javascript; charset=utf-8",
          body: [
            `window.publisherExecutionCounts.external += 1;`,
            `window.publisherExecutionOrder.push("external");`,
            `window.publisherExternalEvidence = {`,
            `  resolvedHref: new URL(document.currentScript.getAttribute("href"), document.baseURI).href,`,
            `  readingSystem: navigator.epubReadingSystem !== undefined,`,
            `};`,
          ].join("\n"),
        }),
      );
      await page.route(`${origin}/OPS/Images/cover.svg`, async (route) => {
        const response = await route.fetch();
        const served = (await response.text()).replace(
          /<svg(?=[\s>])/u,
          `<svg onload="window.publisherExecutionCounts.eventHandler+=1;window.publisherExecutionOrder.push('event-handler')"`,
        );
        const closing = served.lastIndexOf("</svg>");
        const publisherScripts =
          `<script xmlns="http://www.w3.org/2000/svg"><![CDATA[` +
          `window.publisherExecutionOrder??=[navigator.epubReadingSystem===undefined?"agent-missing":"agent-bootstrap"];` +
          `window.publisherExecutionCounts??={inline:0,external:0,eventHandler:0};` +
          `window.publisherExecutionCounts.inline+=1;` +
          `window.publisherExecutionOrder.push("inline");` +
          `window.mutatePublisherSvg=function(){document.documentElement.setAttribute("viewBox","0 0 1200 1600")};` +
          `]]></script>` +
          `<script xmlns="http://www.w3.org/2000/svg" href="publisher-script.js"></script>`;
        await route.fulfill({
          response,
          body: served.slice(0, closing) + publisherScripts + served.slice(closing),
        });
      });
    },
    async verify({ page, report, origin, scenario }) {
      const frame = primary(page);
      expect(
        await evaluateIn(frame, () => {
          const root = document.documentElement;
          const target = document.getElementById("path3337_1_")?.getBoundingClientRect();
          const publisher = window as unknown as Record<string, unknown>;
          return {
            contentType: document.contentType,
            root: { localName: root.localName, namespace: root.namespaceURI },
            viewBox: root.getAttribute("viewBox"),
            preserveAspectRatio: root.getAttribute("preserveAspectRatio"),
            executionOrder: publisher.publisherExecutionOrder,
            executionCounts: publisher.publisherExecutionCounts,
            externalEvidence: publisher.publisherExternalEvidence,
            targetVisible: target !== undefined && target.width > 0 && target.height > 0,
          };
        }),
      ).toEqual({
        contentType: "image/svg+xml",
        root: { localName: "svg", namespace: "http://www.w3.org/2000/svg" },
        viewBox: "0 0 1571 2068",
        preserveAspectRatio: null,
        executionOrder: ["agent-bootstrap", "inline", "external", "event-handler"],
        executionCounts: { inline: 1, external: 1, eventHandler: 1 },
        externalEvidence: {
          resolvedHref: `${origin}/OPS/Images/publisher-script.js`,
          readingSystem: true,
        },
        targetVisible: true,
      });

      const geometry = fixedGeometry(report);
      const scale = Math.min(
        geometry.containingViewport.width / 1571,
        geometry.containingViewport.height / 2068,
      );
      expect(geometry.scale).toBeCloseTo(scale, 8);
      expect(geometry.renderedWidth).toBeCloseTo(1571 * scale, 8);
      expect(geometry.renderedHeight).toBeCloseTo(2068 * scale, 8);

      const before = (await call(page, "snapshot")).document.committed;
      expect(await call(page, "resolveFragment", "path3337_1_")).toEqual({
        outcome: "completed",
        status: { status: "resolved" },
      });
      expect(await call(page, "relocateFragment", "svgView(viewBox(0,0,1571,2068))")).toEqual({
        outcome: "completed",
        status: {
          status: "unsupported-evidence",
          message: "standalone SVG supports only element ID fragments and document boundaries",
        },
      });
      const after = (await call(page, "snapshot")).document.committed;
      expect(after?.generation).toBe(before?.generation);
      await expect(page.locator(primarySelector)).toHaveAttribute(
        "src",
        `${origin}/${scenario.resource}`,
      );

      await expectReadingPosition(page, 0);

      const svgLayout = async () => {
        const committed = (await call(page, "snapshot")).document.committed;
        const settlement = committed?.layout.layout.settlement;
        return committed === null || committed === undefined || settlement?.adapter !== "fixed-svg"
          ? null
          : {
              documentGeneration: committed.generation,
              layoutGeneration: committed.layout.layout.layoutGeneration,
              state: committed.layout.state,
              intrinsicViewport: settlement.settlement.geometry.intrinsicViewport,
            };
      };
      const initial = (await svgLayout())!;
      await evaluateIn(frame, () =>
        (window as unknown as { mutatePublisherSvg(): void }).mutatePublisherSvg(),
      );
      await expect.poll(svgLayout).toMatchObject({
        state: "settled",
        documentGeneration: initial.documentGeneration,
        intrinsicViewport: { width: 1200, height: 1600 },
      });
      expect((await svgLayout())!.layoutGeneration).toBeGreaterThan(initial.layoutGeneration);
      await expect.poll(() => frameViewport(frame)).toEqual({ width: 1200, height: 1600 });
    },
  },
};

async function verifyDesktopSpread(page: Page, origin: string): Promise<void> {
  const spread = {
    primaryOccurrence: 1,
    firstOccurrence: 1,
    lastOccurrence: 2,
    companion: { occurrence: 2, placement: "left" },
  };
  await expect.poll(() => call(page, "visibleOccurrenceRange")).toMatchObject(spread);
  await expect
    .poll(async () =>
      (await call(page, "events")).some(
        (event) =>
          event.type === "document-observed" && event.participant?.kind === "fixed-companion",
      ),
    )
    .toBe(true);
  expect(await call(page, "participantFrames")).toEqual(
    expect.arrayContaining(
      [
        { participant: "primary", occurrence: 1, src: `${origin}/OPS/xhtml/p02.xhtml` },
        { participant: "fixed-companion", occurrence: 2, src: `${origin}/OPS/xhtml/p03.xhtml` },
      ].map((frame) =>
        expect.objectContaining({
          ...frame,
          inert: false,
          ariaHidden: null,
          computedPointerEvents: "auto",
        }),
      ),
    ),
  );
  const { document } = await call(page, "snapshot");
  expect(document.fixedCompanion).toMatchObject({
    ownerDocumentGeneration: document.committed!.generation,
    frame: { occurrence: 2, resource: "OPS/xhtml/p03.xhtml" },
    placement: "left",
  });

  const primaryFrame = page.locator(primarySelector);
  const companion = page.locator(companionSelector);
  await companion.focus();
  expect(await call(page, "captureSelection")).toMatchObject({
    outcome: "completed",
    occurrence: 2,
    resource: "OPS/xhtml/p03.xhtml",
    selection: {
      status: "unavailable",
      reason: "no-selection",
      basis: { participant: { kind: "fixed-companion" } },
    },
  });

  const fit = await call(page, "participantFrames");
  await call(page, "setFixedZoom", 1.5);
  await expect.poll(() => transformsChanged(page, fit)).toBe(true);
  const zoomed = await call(page, "participantFrames");
  expect(transformScale(zoomed[0]?.transform)).toBe(transformScale(zoomed[1]?.transform));
  expect((await call(page, "fixedViewState"))?.zoom).toBe(1.5);

  await expect
    .poll(() =>
      primary(page)
        .locator(":root")
        .evaluate((root) => getComputedStyle(root).scrollbarWidth),
    )
    .toBe("auto");
  const [host, primaryBounds, companionBounds] = await Promise.all([
    page.locator("[data-epub-navigator-frame-stack]").boundingBox(),
    primaryFrame.boundingBox(),
    companion.boundingBox(),
  ]);
  const center = host!.x + host!.width / 2;
  expect(primaryBounds!.x + primaryBounds!.width / 2).toBeGreaterThan(center);
  expect(companionBounds!.x + companionBounds!.width / 2).toBeLessThan(center);
  expect(
    Math.abs(companionBounds!.x + companionBounds!.width - primaryBounds!.x),
  ).toBeLessThanOrEqual(1);

  await companion.focus();
  await companion.contentFrame().locator("body").press("-");
  await expect
    .poll(() => call(page, "interactions"))
    .toContainEqual(
      expect.objectContaining({
        participant: expect.objectContaining({ kind: "fixed-companion" }),
        command: "fixed-zoom",
        source: "keyboard",
      }),
    );
  await expect.poll(() => transformsChanged(page, zoomed)).toBe(true);
  await expect(companion).toBeFocused();
  expect(await call(page, "visibleOccurrenceRange")).toMatchObject(spread);
}

async function verifyMobileSpread(page: Page): Promise<void> {
  expect(await call(page, "visibleOccurrenceRange")).toMatchObject({
    primaryOccurrence: 1,
    firstOccurrence: 1,
    lastOccurrence: 1,
    companion: null,
  });
  expect(await call(page, "participantFrames")).toMatchObject([
    { participant: "primary", occurrence: 1, inert: false, computedPointerEvents: "auto" },
  ]);
  await expectAccessibleFrames(page, [1]);

  await observeVisibleFrames(page);
  await page.setViewportSize({ width: 915, height: 412 });
  for (const selector of ["#frame-host", "[data-epub-navigator-frame-stack]"]) {
    expect(
      await page
        .locator(selector)
        .evaluate((element) => [element.clientWidth, element.clientHeight]),
    ).toEqual([915, 412]);
  }
  await expect
    .poll(() => call(page, "visibleOccurrenceRange"))
    .toMatchObject({
      primaryOccurrence: 1,
      firstOccurrence: 1,
      lastOccurrence: 2,
      companion: { occurrence: 2, placement: "left" },
    });
  await expectAtomicReveal(page, "1,2");
  await expectAccessibleFrames(page, [1, 2]);
  const [primaryBounds, companionBounds] = await Promise.all([
    page.locator(primarySelector).boundingBox(),
    page.locator(companionSelector).boundingBox(),
  ]);
  expect(companionBounds!.x + companionBounds!.width / 2).toBeLessThan(
    primaryBounds!.x + primaryBounds!.width / 2,
  );

  const frame = primary(page);
  await frame.locator("body").evaluate((body) => {
    const button = document.createElement("button");
    button.id = "corpus-interactive-probe";
    button.textContent = "Interactive probe";
    body.append(button);
  });
  const baseline = await call(page, "interactions");
  await touchTap(frame, "#corpus-interactive-probe", 2, 100);
  expect(await committedOccurrence(page)).toBe(1);
  expect(await call(page, "interactions")).toEqual(baseline);

  await frame.locator("body").evaluate((body) => {
    const probe = document.createElement("span");
    probe.textContent = "selection probe";
    body.append(probe);
    const range = document.createRange();
    range.selectNodeContents(probe);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  });
  // A tap in a page zone would turn the page as it dismisses the selection, so the tap that
  // only dismisses lands in the middle of the page.
  const middle = await frame.locator("body").evaluate(() => Math.round(innerWidth / 2));
  await touchTap(frame, "body", middle, 101);
  expect(await committedOccurrence(page)).toBe(1);
  expect(await call(page, "interactions")).toEqual(baseline);
  await frame.locator("body").evaluate(() => getSelection()?.removeAllRanges());

  const beforeSelectionPan = await call(page, "fixedViewState");
  await touchPan(frame, [110, 110], [160, 160], 106, true);
  expect(await call(page, "fixedViewState")).toEqual(beforeSelectionPan);
  expect(await call(page, "interactions")).toEqual(baseline);

  const beforePinch = await call(page, "participantFrames");
  await touchPinch(frame);
  await expect.poll(async () => (await call(page, "fixedViewState"))?.zoom ?? 0).toBeGreaterThan(1);
  const pinched = await call(page, "fixedViewState");
  const afterPinch = await call(page, "participantFrames");
  expect(await transformsChanged(page, beforePinch)).toBe(true);
  expect(transformScale(afterPinch[0]?.transform)).toBe(transformScale(afterPinch[1]?.transform));
  expect(await call(page, "interactions")).toContainEqual(
    expect.objectContaining({ command: "fixed-zoom", source: "touch" }),
  );

  await touchPan(frame, [110, 110], [2_000, 2_000], 102);
  const clamped = await call(page, "fixedViewState");
  const afterPan = await call(page, "participantFrames");
  expect(clamped).not.toEqual(pinched);
  expect(await transformsChanged(page, afterPinch)).toBe(true);
  await touchPan(frame, [110, 110], [2_000, 2_000], 103);
  expect(await call(page, "fixedViewState")).toEqual(clamped);
  expect(await call(page, "participantFrames")).toEqual(afterPan);
  expect(await call(page, "interactions")).toContainEqual(
    expect.objectContaining({ command: "fixed-pan", source: "touch" }),
  );

  await page.locator(primarySelector).focus();
  await frame.locator("body").press("0");
  await expect
    .poll(() => call(page, "fixedViewState"))
    .toEqual({ zoom: 1, minimumZoom: 1, maximumZoom: 4, panX: 0, panY: 0 });
  await expect(page.locator(primarySelector)).toBeFocused();

  await touchTap(frame, "body", 2, 104);
  await expect.poll(() => committedOccurrence(page)).toBe(3);
  await expect
    .poll(() => call(page, "visibleOccurrenceRange"))
    .toMatchObject({
      primaryOccurrence: 3,
      firstOccurrence: 3,
      lastOccurrence: 4,
      companion: { occurrence: 4, placement: "left" },
    });
  await expectAccessibleFrames(page, [3, 4]);
  await touchTap(primary(page), "body", 598, 105);
  await expect.poll(() => committedOccurrence(page)).toBe(2);
  await expect
    .poll(() => call(page, "visibleOccurrenceRange"))
    .toMatchObject({
      primaryOccurrence: 2,
      firstOccurrence: 1,
      lastOccurrence: 2,
      companion: { occurrence: 1, placement: "right" },
    });
  await expectAccessibleFrames(page, [1, 2]);

  await page.setViewportSize({ width: 412, height: 915 });
  await expect
    .poll(() => call(page, "visibleOccurrenceRange"), { timeout: 30_000 })
    .toMatchObject({
      primaryOccurrence: 2,
      firstOccurrence: 2,
      lastOccurrence: 2,
      companion: null,
    });
  await expectAccessibleFrames(page, [2]);
  await call(page, "previous");
  await expect.poll(() => committedOccurrence(page)).toBe(1);
  await expectAccessibleFrames(page, [1]);

  const accessibility = await new AxeBuilder({ page })
    .include("#frame-host")
    .disableRules(["landmark-one-main", "page-has-heading-one", "region"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

async function verifyPageBlanche(page: Page): Promise<void> {
  const landscape = await page.evaluate(() => innerWidth > innerHeight);
  const cover = page.locator(`${primarySelector}[data-epub-navigator-occurrence="0"]`);
  expect((await call(page, "participantFrames"))[0]).toMatchObject({
    occurrence: 0,
    placement: landscape ? "right" : "center",
  });
  await expectFixedImage(cover, "cover.jpg");
  if (landscape) {
    const [host, coverBounds] = await Promise.all([
      page.locator("[data-epub-navigator-frame-stack]").boundingBox(),
      cover.boundingBox(),
    ]);
    expect(coverBounds!.x + coverBounds!.width / 2).toBeGreaterThan(host!.x + host!.width / 2);
  }
  expect(await call(page, "visibleOccurrenceRange")).toMatchObject({
    primaryOccurrence: 0,
    firstOccurrence: 0,
    lastOccurrence: 0,
    companion: null,
  });
  await expectReadingPosition(page, 0, { boundary: true });

  const spread = (primaryOccurrence: number, companion: number | null, placement = "right") =>
    landscape && companion !== null
      ? {
          primaryOccurrence,
          firstOccurrence: Math.min(primaryOccurrence, companion),
          lastOccurrence: Math.max(primaryOccurrence, companion),
          companion: { occurrence: companion, placement },
        }
      : {
          primaryOccurrence,
          firstOccurrence: primaryOccurrence,
          lastOccurrence: primaryOccurrence,
          companion: null,
        };

  await observeVisibleFrames(page, ["1", "2"]);
  await call(page, "next");
  await expect.poll(() => committedOccurrence(page)).toBe(1);
  await expect.poll(() => call(page, "visibleOccurrenceRange")).toMatchObject(spread(1, 2));
  await expectReadingPosition(page, 1);
  if (landscape) {
    await expectAtomicReveal(page, "1,2");
    const left = page.locator(`${primarySelector}[data-epub-navigator-placement="left"]`);
    const right = page.locator(`${companionSelector}[data-epub-navigator-placement="right"]`);
    await expectAdjacent(left, right);
    await expectFixedImage(right, "PageBlanche_Page_001.jpg");
    await expect(left.contentFrame().locator("img")).toHaveCount(0);
    const width = (await right.boundingBox())!.width;
    await call(page, "setFixedZoom", 1.5);
    await expect.poll(async () => (await right.boundingBox())!.width).toBeGreaterThan(width);
    await expectAdjacent(left, right);
  }

  await call(page, "next");
  await expect.poll(() => committedOccurrence(page)).toBe(landscape ? 3 : 2);
  await expect
    .poll(() => call(page, "visibleOccurrenceRange"))
    .toMatchObject(landscape ? spread(3, 4) : spread(2, null));
  await call(page, "previous");
  await expect.poll(() => committedOccurrence(page)).toBe(landscape ? 2 : 1);
  await expect
    .poll(() => call(page, "visibleOccurrenceRange"))
    .toMatchObject(landscape ? spread(2, 1, "left") : spread(1, null));
  if (!landscape) return;

  for (const primaryOccurrence of [3, 5, 7]) {
    await call(page, "next");
    await expect.poll(() => committedOccurrence(page)).toBe(primaryOccurrence);
    await expect
      .poll(() => call(page, "visibleOccurrenceRange"))
      .toMatchObject(spread(primaryOccurrence, primaryOccurrence + 1));
    const pageImage = (occurrence: number) =>
      `PageBlanche_Page_${String(occurrence - 1).padStart(3, "0")}.jpg`;
    await expectFixedImage(
      page.locator(`${primarySelector}[data-epub-navigator-occurrence="${primaryOccurrence}"]`),
      pageImage(primaryOccurrence),
    );
    await expectFixedImage(
      page.locator(
        `${companionSelector}[data-epub-navigator-occurrence="${primaryOccurrence + 1}"]`,
      ),
      pageImage(primaryOccurrence + 1),
    );
  }
  await call(page, "next");
  await expect.poll(() => committedOccurrence(page)).toBe(9);
  expect(await call(page, "visibleOccurrenceRange")).toMatchObject(spread(9, null));
  expect((await call(page, "participantFrames"))[0]).toMatchObject({
    occurrence: 9,
    placement: "left",
  });
}

async function call<K extends keyof CorpusApi>(
  page: Page,
  method: K,
  ...args: Parameters<CorpusApi[K]>
): Promise<Awaited<ReturnType<CorpusApi[K]>>> {
  return page.evaluate(
    ([name, values]) =>
      (window.__corpusTest[name] as (...input: readonly unknown[]) => unknown)(...values),
    [method, args] as const,
  ) as Promise<Awaited<ReturnType<CorpusApi[K]>>>;
}

function primary(page: Page): FrameLocator {
  return page.locator(primarySelector).contentFrame();
}

function evaluateIn<T>(frame: FrameLocator, callback: () => T): Promise<T> {
  return frame.locator(":root").evaluate(callback);
}

function frameViewport(frame: FrameLocator) {
  return evaluateIn(frame, () => ({ width: innerWidth, height: innerHeight }));
}

function fixedGeometry(report: ScenarioReport) {
  const settlement = report.presentation.settlement;
  if (settlement?.adapter !== "fixed-xhtml" && settlement?.adapter !== "fixed-svg") {
    throw new Error("fixed contain geometry is missing");
  }
  return settlement.settlement.geometry;
}

async function committedOccurrence(page: Page): Promise<number | null> {
  return (await call(page, "snapshot")).document.committed?.frame.occurrence ?? null;
}

async function transformsChanged(
  page: Page,
  before: Awaited<ReturnType<CorpusApi["participantFrames"]>>,
): Promise<boolean> {
  const current = await call(page, "participantFrames");
  return current.every((frame, index) => frame.transform !== before[index]?.transform);
}

function transformScale(transform: string | undefined): number | null {
  const match = transform?.match(/scale\(([^)]+)\)/u);
  return match === undefined || match === null ? null : Number(match[1]);
}

async function expectReadingPosition(
  page: Page,
  occurrence: number,
  { boundary = false } = {},
): Promise<void> {
  const position = await call(page, "readingPosition");
  if (boundary) {
    expect(position.passive.location).toMatchObject({
      kind: "point",
      occurrence,
      evidence: [{ kind: "document-boundary", boundary: "start" }],
    });
  }
  expect(position.capture).toMatchObject({ status: "captured" });
  expect(position.generated).toMatchObject({
    outcome: "completed",
    occurrence,
    result: { status: "generated" },
  });
  expect(position.restoration, JSON.stringify(position.restoration)).toMatchObject({
    status: "restored",
    occurrence,
  });
}

async function expectTargetInView(frame: FrameLocator, href: string): Promise<void> {
  const id = decodeURIComponent(href.slice(href.indexOf("#") + 1));
  const top = () =>
    frame
      .locator(`[id=${JSON.stringify(id)}]`)
      .evaluate((element) => element.getBoundingClientRect().top);
  await expect.poll(top).toBeGreaterThanOrEqual(0);
  expect(await top()).toBeLessThan(900);
}

async function expectImageLoaded(frame: FrameLocator): Promise<void> {
  await expect
    .poll(() =>
      evaluateIn(frame, () => {
        const image = document.querySelector("img");
        return image !== null && image.complete && image.naturalWidth > 0;
      }),
    )
    .toBe(true);
}

async function expectFixedImage(frame: Locator, fileName: string): Promise<void> {
  await expect
    .poll(() =>
      evaluateIn(frame.contentFrame(), () => {
        const image = document.querySelector("img");
        return image === null
          ? null
          : {
              source: image.src,
              complete: image.complete,
              width: image.naturalWidth,
              height: image.naturalHeight,
            };
      }),
    )
    .toMatchObject({
      source: expect.stringContaining(fileName),
      complete: true,
      width: 1200,
      height: 1577,
    });
}

async function expectAdjacent(left: Locator, right: Locator): Promise<void> {
  const [leftBounds, rightBounds] = await Promise.all([left.boundingBox(), right.boundingBox()]);
  expect(Math.abs(leftBounds!.x + leftBounds!.width - rightBounds!.x)).toBeLessThanOrEqual(1);
}

async function expectAccessibleFrames(page: Page, occurrences: readonly number[]): Promise<void> {
  await expect
    .poll(() =>
      page.locator("iframe").evaluateAll(
        (elements, expected) => {
          const frames = elements as HTMLIFrameElement[];
          const hidden = (frame: HTMLIFrameElement) =>
            frame.inert || frame.getAttribute("aria-hidden") === "true";
          const visible = frames.filter((frame) => !hidden(frame));
          return (
            visible
              .map((frame) => Number(frame.dataset.epubNavigatorOccurrence))
              .sort((left, right) => left - right)
              .join(",") === expected &&
            visible.every((frame) =>
              ["primary", "fixed-companion"].includes(frame.dataset.epubNavigatorParticipant ?? ""),
            ) &&
            frames
              .filter(hidden)
              .every(
                (frame) =>
                  frame.inert &&
                  frame.getAttribute("aria-hidden") === "true" &&
                  frame.getAttribute("tabindex") === "-1",
              )
          );
        },
        [...occurrences].sort((left, right) => left - right).join(","),
      ),
    )
    .toBe(true);
}

async function observeVisibleFrames(page: Page, occurrences?: readonly string[]): Promise<void> {
  await page.evaluate((tracked) => {
    const samples: string[] = [];
    const sample = () => {
      samples.push(
        [...document.querySelectorAll<HTMLIFrameElement>("iframe")]
          .filter(
            (frame) =>
              !frame.inert &&
              frame.getAttribute("aria-hidden") !== "true" &&
              (tracked === null || tracked.includes(frame.dataset.epubNavigatorOccurrence ?? "")),
          )
          .map((frame) => Number(frame.dataset.epubNavigatorOccurrence))
          .sort((left, right) => left - right)
          .join(","),
      );
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "inert", "data-epub-navigator-participant"],
    });
    Object.assign(window, { __visibleFrames: { samples, stop: () => observer.disconnect() } });
  }, occurrences ?? null);
}

async function expectAtomicReveal(page: Page, spread: string): Promise<void> {
  const samples = await page.evaluate(() => {
    const evidence = (window as unknown as { __visibleFrames: { samples: string[]; stop(): void } })
      .__visibleFrames;
    evidence.stop();
    return evidence.samples;
  });
  const singles = spread.split(",");
  expect(samples.some((sample) => singles.includes(sample))).toBe(false);
  expect(samples).toContain(spread);
}

async function touchTap(
  frame: FrameLocator,
  selector: string,
  clientX: number,
  pointerId: number,
): Promise<void> {
  await frame.locator(selector).evaluate(
    (target, input) => {
      const init = {
        bubbles: true,
        cancelable: true,
        clientX: input.clientX,
        clientY: innerHeight / 2,
      };
      for (const type of ["pointerdown", "pointerup"]) {
        target.dispatchEvent(
          new PointerEvent(type, {
            ...init,
            pointerId: input.pointerId,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
          }),
        );
      }
      target.dispatchEvent(new MouseEvent("click", init));
    },
    { clientX, pointerId },
  );
}

async function touchPinch(frame: FrameLocator): Promise<void> {
  await frame.locator("body").evaluate((target) => {
    const steps: readonly [string, number, number, boolean, number][] = [
      ["pointerdown", 201, 200, true, 1],
      ["pointerdown", 202, 400, false, 1],
      ["pointermove", 201, 190, true, 1],
      ["pointermove", 202, 450, false, 1],
      ["pointerup", 201, 190, true, 0],
      ["pointerup", 202, 450, false, 0],
    ];
    for (const [type, pointerId, clientX, isPrimary, buttons] of steps) {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "touch",
          isPrimary,
          button: 0,
          buttons,
          clientX,
          clientY: innerHeight / 2,
        }),
      );
    }
  });
}

async function touchPan(
  frame: FrameLocator,
  start: readonly [number, number],
  end: readonly [number, number],
  pointerId: number,
  selectionStarts = false,
): Promise<void> {
  await frame.locator("body").evaluate(
    (target, input) => {
      const dispatch = (
        type: string,
        [clientX, clientY]: readonly [number, number],
        buttons: number,
      ) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: input.pointerId,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            buttons,
            clientX,
            clientY,
          }),
        );
      dispatch("pointerdown", input.start, 1);
      if (input.selectionStarts) {
        target.dispatchEvent(new Event("selectstart", { bubbles: true, cancelable: true }));
      }
      dispatch("pointermove", input.end, 1);
      dispatch("pointerup", input.end, 0);
    },
    { start, end, pointerId, selectionStarts },
  );
}
