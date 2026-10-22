import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { instrumentXhtml } from "../../../src/xhtml-instrumentation.js";

test("publisher anchors select the first linear duplicate, even from a later copy", async ({
  page,
}) => {
  const xhtml = (body: string) =>
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Links</title></head><body>${body}</body></html>`;
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(
      `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
    "EPUB/package.opf": strToU8(
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">authored-links</dc:identifier><dc:title>Links</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="start" href="start.xhtml" media-type="application/xhtml+xml"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="aside" href="aside.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="start"/><itemref idref="chapter" linear="no"/><itemref idref="chapter"/><itemref idref="chapter"/><itemref idref="aside" linear="no"/><itemref idref="aside" linear="no"/></spine></package>`,
    ),
    "EPUB/nav.xhtml": strToU8(
      xhtml(
        `<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="start.xhtml">Start</a></li></ol></nav>`,
      ),
    ),
    "EPUB/start.xhtml": strToU8(xhtml(`<a href="chapter.xhtml#repeat">Repeated chapter</a>`)),
    "EPUB/chapter.xhtml": strToU8(
      xhtml(
        `<h1 id="repeat">Repeated destination</h1><a href="chapter.xhtml#repeat">Repeated chapter</a><a href="#repeat">Same document fragment</a><a href="aside.xhtml#note">Nonlinear only</a>`,
      ),
    ),
    "EPUB/aside.xhtml": strToU8(
      xhtml(`<h1 id="note">Aside</h1><a href="aside.xhtml#note">Nonlinear only</a>`),
    ),
  };
  await page.route("**/authored-links.epub", (route) =>
    route.fulfill({ contentType: "application/epub+zip", body: Buffer.from(zipSync(files)) }),
  );
  await page.route("**/publications/authored-links/**", (route) => {
    const path = new URL(route.request().url()).pathname.split("/publications/authored-links/")[1]!;
    const source = files[path];
    return source === undefined
      ? route.fulfill({ status: 404 })
      : route.fulfill({
          contentType: "application/xhtml+xml",
          body: Buffer.from(
            instrumentXhtml(source, { contentAgentUrl: "/_epub-navigator/content-agent.js" }),
          ),
        });
  });
  await page.goto("/synthetic/authored-links.html");
  await expect(page.locator("#result")).toHaveText("ready");
  const committed = async (occurrence: number) => {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const snapshot = window.authoredLinks.snapshot();
          return snapshot.document.pending === null &&
            snapshot.document.committed?.layout.state === "settled"
            ? snapshot.document.committed.frame.occurrence
            : null;
        }),
      )
      .toBe(occurrence);
  };
  await committed(0);
  expect(
    await page.evaluate(() =>
      window.authoredLinks.snapshot().readingOrder.map(({ linear }) => linear),
    ),
  ).toEqual(["yes", "no", "yes", "yes", "no", "no"]);
  const anchor = (name: string) =>
    page
      .frameLocator("#frame-host iframe[data-epub-navigator-participant='primary']")
      .getByRole("link", { name, exact: true });
  await anchor("Repeated chapter").click();
  await committed(2);
  for (const name of ["Repeated chapter", "Same document fragment"]) {
    await page.evaluate(() => window.authoredLinks.open(3));
    await committed(3);
    await anchor(name).click();
    await committed(2);
  }
  await anchor("Nonlinear only").click();
  await committed(4);
  await page.evaluate(() => window.authoredLinks.open(5));
  await committed(5);
  await anchor("Nonlinear only").click();
  await committed(4);
});
