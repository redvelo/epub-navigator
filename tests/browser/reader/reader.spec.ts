import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const compactDevice = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const reader = (page: Page) => page.locator(".epub-navigator-reader");
const publicationFrame = (page: Page) =>
  page.locator('iframe[data-epub-navigator-participant="primary"]');
const publicationContent = (page: Page) => publicationFrame(page).contentFrame();
const selectionActions = (page: Page) => page.getByRole("toolbar", { name: "Selection actions" });
const bottomPages = (page: Page) => page.locator(".epub-navigator-reader__bottom-pages");
const activeElementTag = (page: Page) => page.evaluate(() => document.activeElement?.tagName);
/** Compact surfaces are drawers, so they are only where they belong once they stop moving. */
const settled = async (surface: Locator): Promise<Locator> => {
  await expect(surface).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  return surface;
};
const readerIsFullscreen = (page: Page) =>
  page.evaluate(
    () => document.fullscreenElement?.classList.contains("epub-navigator-reader") ?? false,
  );
const configurationStyle = (page: Page, name: string) =>
  publicationContent(page)
    .locator(`style[data-epub-navigator-configuration="${name}"]`)
    .evaluate((style) => style.textContent ?? "");
const scrollY = (page: Page) =>
  publicationContent(page)
    .locator("html")
    .evaluate(() => window.scrollY);

test.beforeEach(async ({ page }) => {
  await openReader(page);
});

test("book details render formatted descriptions and send links to the host", async ({ page }) => {
  await openReader(page, "?rich-description");
  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  await page.getByRole("button", { name: "Publication details", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Publication details" });
  await expect(
    details.getByRole("heading", { name: "Alice’s Adventures in Wonderland", exact: true }),
  ).toHaveCount(1);
  const description = details.getByRole("region", { name: "Description" });
  await expect(description.locator("strong")).toHaveText("illustrated");
  await expect(description.getByRole("listitem")).toHaveText([
    "Original drawings",
    "A curious heroine",
  ]);
  await expect(description.locator("img, script")).toHaveCount(0);
  const url = page.url();
  await description.getByRole("link", { name: "Visit the publisher" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__EPUB_NAVIGATOR_LAST_ACTIVATION__))
    .toMatchObject({ resolvedUrl: "https://example.com/alice", internal: false });
  await expect(page).toHaveURL(url);
  await details.getByRole("button", { name: "Close publication details" }).click();
  await expect(details).toBeHidden();
});

test("opens shortcut help from the desktop quick menu with keyboard mode off", async ({ page }) => {
  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  const menu = page.getByRole("dialog", { name: "Quick Menu" });
  await expect(menu.getByRole("button", { name: "Keyboard shortcuts" }).locator("kbd")).toHaveText(
    "?",
  );
  await menu.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Reading settings" });
  await settings
    .getByRole("radiogroup", { name: "Keyboard", exact: true })
    .getByRole("radio", { name: "Off", exact: true })
    .click();
  await settings.getByRole("button", { name: "Close reading settings" }).click();
  await publicationFrame(page).focus();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeHidden();
  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  const action = menu.getByRole("button", { name: "Keyboard shortcuts" });
  await expect(action.locator("kbd")).toHaveCount(0);
  await action.click();
  await expect(menu).toBeHidden();
  await expect(help).toBeVisible();
  await expect(help).toContainText("Reader shortcuts are disabled.");
  await help.getByRole("button", { name: "Close keyboard shortcuts" }).click();
  await expect(help).toBeHidden();
  await expect(publicationFrame(page)).toBeFocused();
});

test("reader shortcuts work from publication focus and preserve annotation selection", async ({
  page,
}) => {
  await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/);
  await publicationFrame(page).focus();
  await page.keyboard.press("t");
  await expect(page.getByRole("dialog", { name: "Navigation", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => activeElementTag(page)).toBe("IFRAME");
  await page.keyboard.press("q");
  await expect(page.getByRole("dialog", { name: "Quick Menu" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Quick Menu" })).toBeHidden();
  await publicationFrame(page).focus();
  await page.keyboard.press(",");
  await expect(page.getByRole("dialog", { name: "Reading settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => activeElementTag(page)).toBe("IFRAME");
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.keyboard.press("Escape");
  await publicationFrame(page).focus();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  await expect.poll(() => activeElementTag(page)).toBe("IFRAME");

  await selectPublicationText(page, 0);
  await expect(selectionActions(page)).toBeVisible();
  await publicationFrame(page).focus();
  await page.keyboard.press("f");
  await expect(selectionActions(page)).toBeHidden();
  await selectPublicationText(page, 1);
  await expect(selectionActions(page)).toBeVisible();
  await publicationFrame(page).focus();
  await page.keyboard.press("d");
  const editor = page.getByRole("dialog", { name: "Add note" });
  await expect(editor.getByRole("textbox", { name: "Note" })).toBeFocused();
  await page.keyboard.type("Keyboard note");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toBeHidden();
  await selectPublicationText(page, 0);
  await expect(selectionActions(page)).toBeVisible();
  await publicationFrame(page).focus();
  await page.keyboard.press("Escape");
  await expect(selectionActions(page)).toBeHidden();
  await publicationFrame(page).focus();
  await page.keyboard.press("a");
  const annotations = page.getByRole("dialog", { name: "Annotations", exact: true });
  await expect(annotations.getByRole("button", { name: /^Go to highlight:/u })).toBeVisible();
  await expect(annotations.getByText("Keyboard note")).toBeVisible();
});

test("mouse history buttons turn pages once and are consumed over dialogs", async ({ page }) => {
  await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/);
  const cdp = await page.context().newCDPSession(page);
  const sideClick = async (button: "back" | "forward", locator: Locator) => {
    const box = (await locator.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, button, clickCount: 1 };
    await cdp.send("Input.dispatchMouseEvent", {
      ...point,
      type: "mousePressed",
      buttons: button === "back" ? 8 : 16,
    });
    await cdp.send("Input.dispatchMouseEvent", { ...point, type: "mouseReleased", buttons: 0 });
  };
  await page.evaluate(() => history.pushState(null, "", "?mouse-history-sentinel"));
  const url = page.url();
  const initial = await reader(page).getAttribute("data-section-first-visible-page");
  await sideClick("forward", publicationFrame(page));
  await expect(reader(page)).not.toHaveAttribute("data-section-first-visible-page", initial!);
  const next = await reader(page).getAttribute("data-section-first-visible-page");
  await sideClick("back", page.getByRole("toolbar", { name: "Reader controls" }));
  await expect(reader(page)).toHaveAttribute("data-section-first-visible-page", initial!);
  await expect(page).toHaveURL(url);
  await sideClick("forward", publicationFrame(page));
  await expect(reader(page)).toHaveAttribute("data-section-first-visible-page", next!);
  const settings = await openReaderSettings(page);
  await sideClick("back", settings);
  await expect(settings).toBeVisible();
  await expect(reader(page)).toHaveAttribute("data-section-first-visible-page", next!);
  await expect(page).toHaveURL(url);
  await cdp.detach();
});

test("desktop edge clicks are opt-in and do not turn while clearing a selection", async ({
  page,
}) => {
  await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/);
  const frame = publicationFrame(page);
  const edgeClick = async () => {
    const box = (await frame.boundingBox())!;
    await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
  };
  const initial = await reader(page).getAttribute("data-section-first-visible-page");
  await edgeClick();
  await expect(reader(page)).toHaveAttribute("data-section-first-visible-page", initial!);
  const settings = await openReaderSettings(page);
  await settings.getByRole("switch", { name: "Click edges to turn pages" }).click();
  await settings.getByRole("button", { name: "Close reading settings" }).click();
  await selectPublicationText(page, 0);
  await edgeClick();
  await expect(selectionActions(page)).toBeHidden();
  await expect(reader(page)).toHaveAttribute("data-section-first-visible-page", initial!);
  await edgeClick();
  await expect(reader(page)).not.toHaveAttribute("data-section-first-visible-page", initial!);
});

test("recovers an invalidated frame and keeps Library clickable above the error surface", async ({
  page,
}) => {
  const frame = publicationFrame(page);
  const original = await frame.elementHandle();
  const invalidate = () =>
    frame.evaluate((element: HTMLIFrameElement) => {
      element.contentWindow!.location.href = "about:blank";
    });
  await invalidate();
  await expect(page.getByRole("alert")).toContainText("Section unavailable");
  await expect(frame).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(reader(page)).toHaveAttribute("data-reader-state", "reading");
  expect(await original.evaluate((element) => element.isConnected)).toBe(false);
  await invalidate();
  await expect(page.getByRole("alert")).toContainText("Section unavailable");
  await page.getByRole("button", { name: /Open quick menu/u }).click();
  await page.getByRole("button", { name: /library$/iu }).click();
  await expect(page.locator("html")).toHaveAttribute("data-library-requested", "true");
});

test("provides a stable workspace toolbar and independent panels", async ({ page }) => {
  const frame = publicationFrame(page);
  const toolbar = page.getByRole("toolbar", { name: "Reader controls" });
  await expect(reader(page)).toHaveAttribute("aria-label", /reader$/);
  await expect(page.getByRole("main", { name: "Publication reading area" })).toBeVisible();
  await expect(frame).toBeVisible();
  await expect(toolbar).toBeVisible();
  const frameBox = await frame.boundingBox();
  expect(frameBox?.width).toBeCloseTo((await reader(page).boundingBox())?.width ?? 0, 0);

  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  const appearance = page.getByRole("dialog", { name: "Quick Menu" });
  await expect(appearance.getByRole("button", { name: /library$/iu })).toBeVisible();
  await appearance.getByRole("button", { name: "Publication details" }).click();
  const details = page.getByRole("dialog", { name: "Publication details" });
  const cover = details.getByRole("img", { name: /cover$/u });
  await expect(cover).toBeVisible();
  await expect
    .poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await details.getByRole("button", { name: "Close publication details" }).click();

  const originalFrame = await frame.elementHandle();
  const navigationButton = toolbar.locator('button[aria-label="Navigation"]');
  const annotationsButton = toolbar.locator('button[aria-label="Annotations"]');
  await navigationButton.click();
  await expect(navigationButton).toHaveAttribute("aria-pressed", "true");
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("button", { name: /library$/iu })).toHaveCount(0);
  expect(await frame.boundingBox()).toEqual(frameBox);
  await page.getByRole("button", { name: "Close navigation panel" }).click();
  await expect(navigation).toBeHidden();
  await expect(navigationButton).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => activeElementTag(page)).toBe("IFRAME");
  expect(await originalFrame.evaluate((element) => element.isConnected)).toBe(true);

  await annotationsButton.click();
  await expect(annotationsButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog", { name: "Annotations" })).toContainText(
    "No annotations yet",
  );
});

test("projects fragment page-list context into chrome without replacing local pages", async ({
  page,
}) => {
  await openReader(page, "?page-list");
  const topPage = page.locator(".epub-navigator-reader__workspace-status > span").last();
  const openPage = async (label: string) => {
    await page.getByRole("button", { name: "Navigation", exact: true }).click();
    const navigation = page.getByRole("dialog", { name: "Navigation" });
    await navigation.getByRole("tab", { name: "Pages" }).click();
    await navigation.getByRole("button", { name: label, exact: true }).click();
    await expect(navigation).toBeHidden();
  };

  await openPage("1");
  await expect(topPage).toHaveText("p. 1-2");
  await expect(topPage).toHaveAttribute("aria-label", "Publication pages 1 to 2");
  await expect(bottomPages(page)).toHaveText(/\d+(?:-\d+)? \/ \d+/u);

  await openPage("2");
  await expect(topPage).toHaveText("p. 1-2");
  await publicationFrame(page).focus();
  await page.keyboard.press("PageDown");
  await expect(reader(page)).toHaveAttribute("data-section-first-visible-page", "2");
  await expect(reader(page)).toHaveAttribute("data-reader-state", "reading");
  await expect(topPage).toHaveText("p. 2");
  await expect(topPage).toHaveAttribute("aria-label", "Publication page 2");
  await expect(page.getByRole("progressbar", { name: "Reading progress" })).toHaveAttribute(
    "aria-valuetext",
    /progress/u,
  );
});

test("reports foreground activity without exposing it as reader interaction", async ({ page }) => {
  await page.addInitScript(() => {
    const probe = { activities: [] as string[], messageTypes: [] as string[] };
    Object.assign(window, { __epubActivityTest: probe });
    window.addEventListener("message", (event) => {
      const data = event.data as { type?: unknown; activity?: unknown };
      if (typeof data?.type === "string") probe.messageTypes.push(data.type);
      if (data?.type === "activity" && typeof data.activity === "string") {
        probe.activities.push(data.activity);
      }
    });
  });
  await openReader(page, "?page-list");
  const recorded = (key: "activities" | "messageTypes") =>
    page.evaluate(
      (name) =>
        (window as unknown as { __epubActivityTest: Record<string, string[]> }).__epubActivityTest[
          name
        ],
      key,
    );
  const content = publicationContent(page);

  await content.locator("body").click({ position: { x: 100, y: 100 } });
  await expect.poll(() => recorded("activities")).toContain("pointer");
  await publicationFrame(page).focus();
  await page.keyboard.press("PageDown");
  await expect.poll(() => recorded("activities")).toContain("presentation");
  await content.locator("html").evaluate(() => window.dispatchEvent(new Event("scroll")));
  await expect.poll(() => recorded("activities")).toContain("scroll");
  await content.locator("body").evaluate((body) => {
    const text = body.querySelector("p")?.firstChild;
    if (text == null) return;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(3, text.textContent?.length ?? 0));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect.poll(() => recorded("messageTypes")).toContain("selection-changed");
});

test("anchors Quick Menu to its workspace title activation", async ({ page }) => {
  const trigger = page.getByRole("button", { name: /Open quick menu for/u });
  const triggerBox = (await trigger.boundingBox())!;
  const popover = page.getByRole("dialog", { name: "Quick Menu" });
  const popoverCenter = async () => {
    const box = (await popover.boundingBox())!;
    return { x: box.x + box.width / 2, top: box.y };
  };

  for (const fraction of [0.35, 0.65]) {
    const activation = { x: triggerBox.width * fraction, y: triggerBox.height / 2 };
    await trigger.click({ position: activation });
    const center = await popoverCenter();
    expect(center.top).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height);
    expect(Math.abs(center.x - (triggerBox.x + activation.x))).toBeLessThanOrEqual(2);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }

  await trigger.press("Enter");
  expect(
    Math.abs((await popoverCenter()).x - (triggerBox.x + triggerBox.width / 2)),
  ).toBeLessThanOrEqual(2);
  await publicationContent(page)
    .locator("body")
    .click({ position: { x: 20, y: 20 } });
  await expect(popover).toBeHidden();
  await trigger.click();
  await popover.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Reading settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Close reading settings" }).click();
  await expect(trigger).toBeFocused();
});

test("searches the publication and activates a workspace result", async ({ page }) => {
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Navigation" })
    .getByRole("button", { name: "Search publication" })
    .click();
  const search = page.getByRole("dialog", { name: "Search" });
  let scope = search.getByRole("button", { name: "Search scope: Whole book" });
  await scope.click();
  const scopeMenu = page.getByRole("menu", { name: "Search scope" });
  await expect(scopeMenu.getByRole("menuitemradio", { name: "Whole book" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await scopeMenu.getByRole("menuitemradio", { name: "This section" }).click();
  scope = search.getByRole("button", { name: /Search scope: This section/u });
  await expect(scope).toBeFocused();
  await scope.click();
  await page.getByRole("menuitemradio", { name: "Whole book" }).click();
  const input = search.getByRole("searchbox", { name: "Search publication" });
  await input.fill("rabbit");
  await input.press("Enter");

  await expect(search.getByRole("status")).toHaveText("1 result");
  await expect(search.getByRole("heading", { name: "I: Down the Rabbit-Hole" })).toBeVisible();
  await search
    .getByRole("button")
    .filter({ hasText: "The rabbit-hole went straight on like a tunnel for some way." })
    .click();
  await expect(publicationFrame(page)).toHaveAttribute("src", /chapter-1\.xhtml$/);
  await expect
    .poll(() =>
      publicationContent(page)
        .locator("html")
        .evaluate(() => {
          for (const highlight of CSS.highlights.values()) {
            for (const range of highlight as Iterable<Range>) {
              if (range.toString() !== "rabbit") continue;
              const rect = range.getBoundingClientRect();
              return {
                text: range.toString(),
                visible: rect.bottom > 0 && rect.top < innerHeight,
                active:
                  document
                    .querySelector('style[data-epub-navigator-configuration="decorations"]')
                    ?.textContent?.includes("rgb(255 152 0 / 70%)") ?? false,
              };
            }
          }
          return null;
        }),
    )
    .toEqual({ text: "rabbit", visible: true, active: true });

  await selectPublicationText(page, 0);
  await selectionActions(page).getByRole("button", { name: "Search within publication" }).click();
  await expect(search.getByRole("searchbox", { name: "Search publication" })).not.toHaveValue("");
  await expect(search.getByRole("status")).toBeVisible();
});

test("looks up a selection and follows a word inside the dictionary", async ({ page }) => {
  await lookUpSelectionInDictionary(page, "workspace");
});

test("creates, edits, navigates, and deletes mixed annotations", async ({ page }) => {
  const settings = await openReaderSettings(page);
  await settings
    .getByRole("radiogroup", { name: "Keyboard" })
    .getByRole("radio", { name: "Standard" })
    .click();
  await settings.getByRole("radio", { name: "Single" }).click();
  await settings.getByRole("button", { name: "Close reading settings" }).click();
  await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/);
  const frame = publicationFrame(page);

  await selectPublicationText(page, 0);
  await selectionActions(page).getByRole("button", { name: "Highlight" }).click();
  await expect(selectionActions(page)).toBeHidden();

  await selectPublicationText(page, 1);
  await selectionActions(page).getByRole("button", { name: "Add note" }).click();
  const editor = page.getByRole("dialog", { name: "Add note" });
  await editor.getByRole("textbox", { name: "Note" }).fill("Initial note text");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await expect
    .poll(() => configurationStyle(page, "decorations"))
    .toContain("background-color: rgb(190 85 70 / 24%)");
  await expect.poll(() => activeElementTag(page)).toBe("IFRAME");

  const notePages = await bottomPages(page).textContent();
  await clearPublicationSelection(page);
  await frame.focus();
  await page.keyboard.press("PageDown");
  await expect(bottomPages(page)).not.toHaveText(notePages ?? "");

  const annotations = page.getByRole("dialog", { name: "Annotations" });
  const openAnnotations = () =>
    page.getByRole("button", { name: "Annotations", exact: true }).click();
  await openAnnotations();
  await expect(annotations.getByText("Initial note text")).toBeVisible();
  await expect
    .poll(() =>
      annotations
        .locator(".epub-navigator-reader__page-viewport")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await expect(annotations.getByRole("button", { name: /^Go to highlight:/u })).toBeVisible();
  await annotations.getByRole("button", { name: /^Go to note:/u }).click();
  await expect(annotations).toBeHidden();
  await openAnnotations();
  await expect(annotations.getByText("Opening…")).toHaveCount(0);
  await annotations.getByRole("button", { name: "Close annotations panel" }).click();

  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await page.getByRole("button", { name: /^Titlepage/u }).click();
  await expect(frame).toHaveAttribute("src", /titlepage\.xhtml$/);
  await openAnnotations();
  await annotations.getByRole("button", { name: /^Go to note:/u }).click();
  await expect(annotations).toBeHidden();
  await expect(frame).toHaveAttribute("src", /chapter-1\.xhtml$/);
  await openAnnotations();
  await expect(annotations.getByText("Opening…")).toHaveCount(0);

  const note = annotations.locator("li").filter({ hasText: "Initial note text" });
  await note.getByRole("button", { name: /^Actions for note:/u }).click();
  await page.getByRole("menuitem", { name: "Edit note" }).click();
  const edit = page.getByRole("dialog", { name: "Edit note" });
  await edit.getByRole("textbox", { name: "Note" }).fill("Updated note text");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(annotations.getByText("Updated note text")).toBeVisible();

  const highlight = annotations.getByRole("button", { name: /^Go to highlight:/u }).locator("..");
  await highlight.getByRole("button", { name: /^Actions for highlight:/u }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(highlight).toHaveCount(0);

  await page.evaluate(() => window.__EPUB_NAVIGATOR_DUPLICATE_ANNOTATIONS__?.(40));
  await expect(annotations.getByRole("list").getByRole("listitem")).toHaveCount(41);
  const pages = annotations.locator(".epub-navigator-reader__pages");
  await expect(pages).toHaveAttribute("data-page-count", /[2-9]|\d{2,}/);
  const indicator = pages.locator(".epub-navigator-reader__page-footer output");
  const initialPage = await indicator.textContent();
  await pages.getByRole("button", { name: "Next annotations page" }).click();
  await expect(indicator).not.toHaveText(initialPage ?? "");
  await expect(annotations.getByRole("searchbox", { name: "Filter annotations" })).toBeVisible();
  await expect(frame).toBeVisible();
});

test("copies exact selected text and clears the native range", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/);
  const selectedText = await selectPublicationText(page, 0);
  const content = publicationContent(page);
  expect(
    await content
      .locator("body")
      .evaluate((body) =>
        body.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
        ),
      ),
  ).toBe(false);

  await selectionActions(page).getByRole("button", { name: "Copy" }).click();
  await expect(selectionActions(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selectedText);
  await expect
    .poll(() => content.locator("html").evaluate(() => getSelection()?.rangeCount))
    .toBe(0);
});

test("focuses an authored footnote and returns to its note reference", async ({ page }) => {
  const content = publicationContent(page);
  await content.locator("body").evaluate((body) => {
    const paragraph = document.createElement("p");
    paragraph.append("Reader footnote reference ");
    const reference = document.createElement("a");
    reference.id = "reader-footnote-reference";
    reference.href = "#reader-footnote";
    reference.setAttributeNS("http://www.idpf.org/2007/ops", "epub:type", "noteref");
    reference.textContent = "Footnote 1";
    paragraph.append(reference);
    const footnote = document.createElement("aside");
    footnote.id = "reader-footnote";
    footnote.setAttribute("role", "doc-footnote");
    footnote.textContent = "A deterministic authored footnote.";
    body.append(paragraph, footnote);
  });
  const footnoteFocus = content.locator('[data-epub-navigator-configuration="footnote-focus"]');
  const returnAction = page.getByRole("button", { name: "Return to note reference" });

  await content.getByRole("link", { name: "Footnote 1" }).click();
  await expect(returnAction).toBeVisible();
  await expect(footnoteFocus).toBeFocused();
  await expectNoSeriousViolations(page, ".epub-navigator-reader");

  await returnAction.click();
  await expect(returnAction).toBeHidden();
  await expect(content.locator("#reader-footnote-reference")).toBeFocused();
  await expect(footnoteFocus).toHaveCount(0);

  await content.getByRole("link", { name: "Footnote 1" }).click();
  await expect(returnAction).toBeVisible();
  await content
    .locator("#reader-footnote-reference")
    .evaluate((reference) => reference.replaceWith(reference.textContent ?? "Footnote 1"));
  await returnAction.click();
  await expect(returnAction).toBeHidden();
  const fallback = content.getByLabel("Note reference", { exact: true });
  await expect(fallback).toBeFocused();
  await fallback.blur();
  await expect(footnoteFocus).toHaveCount(0);
});

test("recognizes reciprocal EPUB 2 class-based footnotes", async ({ page }) => {
  const content = publicationContent(page);
  await content.locator("body").evaluate((body) => {
    const fixture = document.createElement("section");
    fixture.innerHTML = `
      <p class="bl_right">Frantz Fanon, 1961<a class="hlink" href="#itr-ftn2" id="itr-ftn2a"><sup class="frac">2</sup></a></p>
      <p class="footnote" id="itr-ftn2"><a class="hlink" href="#itr-ftn2a">2</a> Frantz Fanon, <em>The Wretched of the Earth</em>, New York: Grove Press, 1963, p. 314.</p>
      <p><a id="one-way-reference" href="#one-way-note">One-way note</a></p>
      <p class="footnote" id="one-way-note">No reciprocal backlink.</p>
      <p><a id="generic-reference" href="#generic-target">Generic reciprocal link</a></p>
      <p id="generic-target"><a href="#generic-reference">Generic backlink</a></p>`;
    body.append(fixture);
  });
  const returnAction = page.getByRole("button", { name: "Return to note reference" });

  await content.locator("#itr-ftn2a").click();
  await expect(returnAction).toBeVisible();
  await expect(
    content.locator('[data-epub-navigator-configuration="footnote-focus"]'),
  ).toBeFocused();
  await returnAction.click();
  await expect(returnAction).toBeHidden();
  await expect(content.locator("#itr-ftn2a")).toBeFocused();

  await content.locator("#one-way-reference").click();
  await expect(returnAction).toBeHidden();
  await content.locator("#generic-reference").click();
  await expect(returnAction).toBeHidden();

  await content.locator("#itr-ftn2a").click();
  const dismissAction = page.getByRole("button", { name: "Dismiss note return" });
  await expect(dismissAction).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Note navigation" }).getByRole("button"),
  ).toHaveCount(2);
  const source = await publicationFrame(page).getAttribute("src");
  await dismissAction.click();
  await expect(returnAction).toBeHidden();
  await expect(dismissAction).toBeHidden();
  await expect(publicationFrame(page)).toHaveAttribute("src", source ?? "");
});

test("opens annotation highlights, adjusts their range, and converts them to notes", async ({
  page,
}) => {
  await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/);
  await selectPublicationText(page, 0);
  await selectionActions(page).getByRole("button", { name: "Highlight" }).click();
  await expect(selectionActions(page)).toBeHidden();
  await selectPublicationText(page, 0);
  await publicationContent(page)
    .locator("html")
    .evaluate(() => {
      getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
  await expect
    .poll(() =>
      publicationContent(page)
        .locator("html")
        .evaluate(() => {
          for (const highlight of CSS.highlights.values()) {
            for (const range of highlight as Iterable<AbstractRange>) {
              if (!(range instanceof Range)) continue;
              const rect = range.getClientRects()[0];
              if (rect === undefined || rect.width === 0 || rect.height === 0) continue;
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              document.elementFromPoint(x, y)?.dispatchEvent(
                new MouseEvent("click", {
                  bubbles: true,
                  cancelable: true,
                  button: 0,
                  detail: 1,
                  clientX: x,
                  clientY: y,
                }),
              );
              return true;
            }
          }
          return false;
        }),
    )
    .toBe(true);

  const toolbar = page.getByRole("toolbar", { name: "Annotation actions" });
  const expandEnding = toolbar.getByRole("button", { name: "Expand ending" });
  await expect(expandEnding).toBeVisible();
  await expandEnding.evaluate((button) => {
    button.dataset.disabledDuringAdjustment = "false";
    new MutationObserver(() => {
      if (button.hasAttribute("disabled")) button.dataset.disabledDuringAdjustment = "true";
    }).observe(button, { attributes: true, attributeFilter: ["disabled"] });
  });
  await expandEnding.click();
  await expect(toolbar).toBeVisible();
  await expect(expandEnding).toBeEnabled();
  await expect(expandEnding).toBeFocused();
  await expect(expandEnding).toHaveAttribute("data-disabled-during-adjustment", "false");
  await toolbar.getByRole("button", { name: "Add note" }).click();
  const editor = page.getByRole("dialog", { name: "Add note" });
  await editor.getByRole("textbox", { name: "Note" }).fill("Converted note text");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();

  await page.getByRole("button", { name: "Annotations", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Annotations" })).toContainText(
    "Converted note text",
  );
});

test("keeps workspace dialogs bounded by the reader", async ({ page }) => {
  const readerBox = (await reader(page).boundingBox())!;
  const expectBounded = async (dialog: Locator) => {
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeLessThan(readerBox.width);
    expect(box.height).toBeLessThan(readerBox.height);
    await expect(dialog.locator(".epub-navigator-reader__pages")).toHaveCount(1);
  };
  const settings = await openReaderSettings(page);
  await expectBounded(settings);
  await settings.getByRole("button", { name: "Close reading settings" }).click();

  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  await page
    .getByRole("dialog", { name: "Quick Menu" })
    .getByRole("button", { name: "Publication details" })
    .click();
  await expectBounded(page.getByRole("dialog", { name: "Publication details" }));
});

test("keeps the reader fullscreen through background settlement", async ({ page }) => {
  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  await expect.poll(() => readerIsFullscreen(page)).toBe(true);
  await expect(reader(page)).toHaveAttribute("data-reader-fullscreen", "true");
  await readerSettled(page);
  expect(await readerIsFullscreen(page)).toBe(true);
  await expect(page.getByRole("dialog", { name: "Quick menu" })).toBeHidden();
  await page.getByRole("button", { name: /Open quick menu for/u }).click();
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test("pins either default panel in workspace", async ({ page }) => {
  await expect(reader(page)).toHaveAttribute("data-display-profile", "workspace");

  for (const [button, panel] of [
    ["Navigation", "navigation"],
    ["Annotations", "annotations"],
  ] as const) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await page
      .getByRole("dialog", { name: button })
      .getByRole("button", { name: `Pin ${panel} panel` })
      .click();
    await expect(page.locator(`.epub-navigator-reader__workspace-slot--${panel}`)).toHaveAttribute(
      "data-effective",
      "pinned",
    );
  }
});

test("preserves desired pinning through keyboard resize", async ({ page }) => {
  const frame = publicationFrame(page);
  const frameHandle = await frame.elementHandle();
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  const overlay = page.getByRole("dialog", { name: "Navigation" });
  await overlay.getByRole("button", { name: "Pin navigation panel" }).click();
  const separator = page.getByRole("separator", { name: "Resize navigation panel" });
  await expect(separator).toBeVisible();
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "296");

  await page.locator("#root").evaluate((root) => (root.style.width = "1200px"));
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeLessThan(1200);
  await expect(separator).toBeVisible();
  await expect(overlay).toBeHidden();
  await page.getByRole("button", { name: "Unpin navigation panel" }).click();
  await expect(overlay).toBeVisible();
  expect((await overlay.boundingBox())?.width).toBe(296);
  expect(await frameHandle.evaluate((element) => element.isConnected)).toBe(true);
});

test("keeps authored publication colors and coherent settings in a narrow fine-pointer reader", async ({
  page,
}) => {
  await page.setViewportSize(compactDevice.viewport);
  const content = publicationContent(page);
  await content.locator("body").evaluate((body) => {
    const paragraph = document.createElement("p");
    paragraph.id = "authored-publication-colors";
    paragraph.style.color = "rgb(12, 34, 56)";
    paragraph.style.backgroundColor = "rgb(210, 220, 230)";
    paragraph.style.border = "2px solid rgb(78, 90, 12)";
    const link = document.createElement("a");
    link.href = "#authored-publication-colors";
    link.style.color = "rgb(45, 67, 89)";
    link.style.textDecoration = "none";
    link.textContent = "Authored link";
    paragraph.append(link);
    body.append(paragraph);
  });
  await page.getByRole("button", { name: "Open quick menu" }).click();
  const quick = page.getByRole("dialog", { name: "Quick menu" });
  await expect(quick.getByRole("radio", { name: "Original" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const light = quick.getByRole("radio", { name: "Light" });
  await light.click();
  await expect(light).toHaveAttribute("aria-checked", "true");
  const authored = content.locator("#authored-publication-colors");
  await expect(authored).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect(authored).toHaveCSS("background-color", "rgb(210, 220, 230)");
  await expect(authored).toHaveCSS("border-top-color", "rgb(78, 90, 12)");
  const authoredLink = content.getByRole("link", { name: "Authored link" });
  await expect(authoredLink).toHaveCSS("color", "rgb(45, 67, 89)");
  await expect(authoredLink).toHaveCSS("text-decoration-line", "none");

  const quickLayout = quick.getByRole("group", { name: "Layout" });
  // The reader follows the publication until asked otherwise, and this one declares no flow.
  await expect(quickLayout.getByRole("button", { name: "Auto" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The ramp is a pure magnitude: it bottoms out at 80% and both surfaces agree on where it is.
  await quick.getByRole("button", { name: "Decrease text size" }).click();
  await quick.getByRole("button", { name: "Decrease text size" }).click();
  await expect(quick.getByRole("button", { name: "Decrease text size" })).toBeDisabled();
  await quick.getByRole("button", { name: "Increase text size" }).click();
  await quick.getByRole("button", { name: "Settings", exact: true }).click();

  const settings = page.getByRole("dialog", { name: "Reading settings" });
  await expect(settings.getByRole("group", { name: "Text size" }).getByRole("status")).toHaveText(
    "90%",
  );
  await settings.getByRole("button", { name: "Decrease text size" }).click();
  await expect(settings.getByRole("button", { name: "Decrease text size" })).toBeDisabled();
  await expect(settings.getByRole("group", { name: "Text size" }).getByRole("status")).toHaveText(
    "80%",
  );
  const presentation = settings.getByRole("radiogroup", { name: "Presentation" });
  await expect(presentation.getByRole("radio", { name: "Auto" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await presentation.getByRole("radio", { name: "Scrolled" }).click();
  await expect(
    settings.getByText("Scroll through a section; page turns move between sections."),
  ).toBeVisible();
  const columns = settings.getByRole("radiogroup", { name: "Columns" });
  await expect(columns).toHaveAttribute("aria-disabled", "true");
  await expect(columns.getByRole("radio", { name: "Auto" })).toBeDisabled();
  await expect(settings.getByText("Columns apply to paginated reading only.")).toBeVisible();

  await page.locator("html").evaluate((element) => (element.style.fontSize = "24px"));
  await expect
    .poll(() => settings.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
});

test("keeps a surface inside an embedded reader container rather than the viewport", async ({
  page,
}) => {
  await page.locator("#root").evaluate((root) => {
    root.style.width = "32rem";
    root.style.height = "24rem";
  });
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await expect.poll(async () => (await dialog.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  const rootBox = (await page.locator("#root").boundingBox())!;
  const dialogBox = (await dialog.boundingBox())!;
  expect(dialogBox.width).toBeLessThanOrEqual(rootBox.width);
  expect(dialogBox.height).toBeLessThanOrEqual(rootBox.height);
});

test("matches a bounded Wide surface to the publication canvas", async ({ page }) => {
  const dialog = await openReaderSettings(page);
  await dialog
    .getByRole("radiogroup", { name: "Book colors" })
    .getByRole("radio", { name: "Light" })
    .click();
  await dialog
    .getByRole("radiogroup", { name: "Columns" })
    .getByRole("radio", { name: "Single" })
    .click();
  await dialog
    .getByRole("radiogroup", { name: "Margins" })
    .getByRole("radio", { name: "Comfortable" })
    .click();
  await page.getByRole("button", { name: "Close reading settings" }).click();

  await expect
    .poll(async () => (await publicationFrame(page).boundingBox())?.width)
    .toBeCloseTo(960, 0);
  await expect(page.getByRole("main", { name: "Publication reading area" })).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(publicationContent(page).locator("html")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
});

test("keeps one committed frame through idle dialog and resize activity", async ({ page }) => {
  const frameHandle = await publicationFrame(page).elementHandle();
  const documentRequests: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.url().includes("/publications/alice/")) {
      documentRequests.push(request.url());
    }
  });

  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await page.getByRole("button", { name: "Close navigation panel" }).click();
  const resized = await diagnosticsMark(page);
  await page.locator("#root").evaluate((root) => (root.style.width = "38rem"));
  await readerSettled(page, resized);

  expect(documentRequests).toEqual([]);
  expect(
    await frameHandle.evaluate(
      (element) =>
        element ===
        element.ownerDocument.querySelector('iframe[data-epub-navigator-participant="primary"]'),
    ),
  ).toBe(true);
  await expect(reader(page)).toHaveAttribute("data-reader-state", "reading");
});

test("keeps keybinds usable through theme and viewport relayout", async ({ page }) => {
  const dialog = await openReaderSettings(page);
  await dialog.getByRole("radio", { name: "Scrolled" }).click();
  await dialog
    .getByRole("radiogroup", { name: "Keyboard" })
    .getByRole("radio", { name: "Standard" })
    .click();
  const colors = dialog.getByRole("radiogroup", { name: "Book colors" });
  await colors.getByRole("radio", { name: "Auto" }).click();
  await colors.getByRole("radio", { name: "Dark" }).click();
  const light = colors.getByRole("radio", { name: "Light" });
  await light.click();
  await expect(light).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Close reading settings" }).click();

  const content = publicationContent(page);
  const root = content.locator("html");
  await expect.poll(() => configurationStyle(page, "m3")).toContain("background-color: Canvas");
  await expect(root).not.toHaveCSS("position", "fixed");
  await expect(root).toHaveCSS("background-color", "rgb(255, 255, 255)");
  const colorSamples = await root.evaluate(async (element) => {
    const values: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      await new Promise(requestAnimationFrame);
      values.push(getComputedStyle(element).backgroundColor);
    }
    return values;
  });
  expect(new Set(colorSamples)).toEqual(new Set(["rgb(255, 255, 255)"]));
  await content.locator("body").evaluate((body) => {
    body.style.minHeight = "400vh";
    body.tabIndex = -1;
    body.focus();
  });
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => activeElementTag(page)).toBe("IFRAME");
  await expect
    .poll(async () => {
      await page.keyboard.press("PageDown");
      return scrollY(page);
    })
    .toBeGreaterThan(0);

  const resized = await diagnosticsMark(page);
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
  ]) {
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await page.setViewportSize(viewport);
    await expect.poll(() => activeElementTag(page)).toBe("IFRAME");
  }
  await expect(reader(page)).toHaveAttribute("data-reader-state", "reading");
  await readerSettled(page, resized);
  const restoredPosition = await scrollY(page);
  await expect
    .poll(async () => {
      await page.keyboard.press("PageDown");
      return scrollY(page);
    })
    .toBeGreaterThan(restoredPosition);
});

test("has no serious reader-chrome accessibility violations", async ({ page }) => {
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await expectNoSeriousViolations(page, ".epub-navigator-reader");
  await page.getByRole("button", { name: "Close navigation panel" }).click();
  await expect(await openReaderSettings(page)).toBeVisible();
  await expectNoSeriousViolations(page, ".epub-navigator-reader__settings");
});

test("reports blocked external publication activations to the host", async ({ page }) => {
  const content = publicationContent(page);
  await content.locator("body").evaluate((body) => {
    const link = document.createElement("a");
    link.href = "https://example.com/outside";
    link.textContent = "External";
    body.append(link);
  });
  await content.getByRole("link", { name: "External" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__EPUB_NAVIGATOR_LAST_ACTIVATION__))
    .toEqual(
      expect.objectContaining({ resolvedUrl: "https://example.com/outside", internal: false }),
    );
});

test("persists the reader color preference across reloads", async ({ page }) => {
  const settings = await openReaderSettings(page);
  await settings
    .getByRole("radiogroup", { name: "Interface" })
    .getByRole("radio", { name: "Dark" })
    .click();
  await expect(reader(page)).toHaveClass(/dark/);
  await expect
    .poll(() => publicationFrame(page).evaluate((frame) => frame.style.colorScheme))
    .toBe("dark");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("epub-navigator.preferences")))
    .toContain('"colorScheme":"dark"');

  await page.reload();
  await expect(reader(page)).toHaveAttribute("data-reader-state", "reading", { timeout: 15_000 });
  await expect(reader(page)).toHaveClass(/dark/);
  const root = publicationContent(page).locator("html");
  await expect(root).toHaveCSS("color-scheme", "dark");
  const colors = async (locator: Locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color];
    });
  const [publicationBackground, publicationForeground] = await colors(root);
  expect(publicationBackground).not.toBe(publicationForeground);
  const [interfaceBackground, interfaceForeground] = await colors(reader(page));
  expect(interfaceBackground).not.toBe(interfaceForeground);

  const bookColors = (await openReaderSettings(page)).getByRole("radiogroup", {
    name: "Book colors",
  });
  for (const theme of ["Auto", "Dark"] as const) {
    await bookColors.getByRole("radio", { name: theme }).click();
    await expect(root).toHaveCSS("background-color", publicationBackground!);
  }
});

test("supports Vim scrolling and reading-order navigation", async ({ page }) => {
  const dialog = await openReaderSettings(page);
  await dialog.getByRole("radio", { name: "Vim" }).click();
  await dialog.getByRole("radio", { name: "Scrolled" }).click();
  await page.getByRole("button", { name: "Close reading settings" }).click();

  const frame = publicationFrame(page);
  const content = publicationContent(page);
  await expect(content.locator("html")).not.toHaveCSS("position", "fixed");
  await content.locator("body").evaluate((body) => {
    const input = document.createElement("input");
    body.append(input);
    input.focus();
  });
  await content.locator("input").press("l");
  expect(await content.locator("input").evaluate((input: HTMLInputElement) => input.value)).toBe(
    "l",
  );
  await expect(frame).toHaveAttribute("src", /titlepage\.xhtml$/);
  const extended = await diagnosticsMark(page);
  await content.locator("body").evaluate((body) => {
    body.querySelector("input")?.remove();
    body.style.minHeight = "300vh";
    body.tabIndex = -1;
    body.focus();
  });
  await readerSettled(page, extended);
  await content.locator("html").evaluate(() => scrollTo(0, 0));
  await expect.poll(() => scrollY(page)).toBe(0);
  await frame.focus();
  await page.keyboard.press("j");
  await expect
    .poll(() => content.locator("html").evaluate(() => window.scrollY / innerHeight))
    .toBeGreaterThan(0.5);
  await page.keyboard.press("k");
  await expect.poll(() => scrollY(page)).toBe(0);
  await page.keyboard.press("j");
  await expect.poll(() => scrollY(page)).toBeGreaterThan(0);
  await page.keyboard.press("g");
  await contentFrames(page);
  expect(await scrollY(page)).toBeGreaterThan(0);
  await page.keyboard.press("G");
  await expect
    .poll(() =>
      content
        .locator("html")
        .evaluate(
          () => window.scrollY + innerHeight >= (document.scrollingElement?.scrollHeight ?? 0) - 2,
        ),
    )
    .toBe(true);
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect.poll(() => scrollY(page)).toBe(0);

  await page.keyboard.press("l");
  await expect(frame).toHaveAttribute("src", /imprint\.xhtml$/);
  await expect(reader(page)).toHaveAttribute("data-reader-state", "reading");
  await expect.poll(() => activeElementTag(page)).toBe("IFRAME");
  await page.keyboard.press("h");
  await expect(frame).toHaveAttribute("src", /titlepage\.xhtml$/);
});

test("paginates long content and advances with standard keys", async ({ page }) => {
  await expect.poll(() => activeElementTag(page)).toBe("IFRAME");
  const settings = await openReaderSettings(page);
  await settings
    .getByRole("radiogroup", { name: "Keyboard" })
    .getByRole("radio", { name: "Standard" })
    .click();
  await settings.getByRole("radio", { name: "Single" }).click();
  await page.getByRole("button", { name: "Close reading settings" }).click();

  const content = publicationContent(page);
  const root = content.locator("html");
  await content.locator("body").evaluate((body) => {
    const fixture = document.createElement("section");
    fixture.style.display = "contents";
    for (let page = 1; page <= 4; page += 1) {
      const column = document.createElement("section");
      column.id = `pagination-page-${page}`;
      Object.assign(column.style, {
        breakBefore: "column",
        blockSize: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      });
      const start = document.createElement("p");
      start.textContent = `Page ${page} start`;
      const end = document.createElement("p");
      end.textContent = `Page ${page} end`;
      column.append(start, end);
      const source = document.querySelector("img");
      if (page === 1 && source instanceof HTMLImageElement) {
        for (const [id, width] of [
          ["pagination-large-image", "4000px"],
          ["pagination-small-image", "40px"],
        ]) {
          const image = source.cloneNode() as HTMLImageElement;
          image.id = id!;
          image.style.width = width!;
          image.style.height = "auto";
          column.insertBefore(image, end);
        }
      }
      fixture.append(column);
    }
    body.append(fixture);
    body.tabIndex = -1;
    body.focus();
  });

  await expect
    .poll(() =>
      root.evaluate(
        (element) => element.scrollWidth > element.clientWidth && element.clientWidth > 0,
      ),
    )
    .toBe(true);
  await expect(bottomPages(page).getByText(/1 \/ (?:[2-9]|\d{2,})/)).toBeVisible();
  const geometry = await root.evaluate(() => {
    const body = document.body.getBoundingClientRect();
    const box = (id: string) => {
      const { left, top, bottom, width, height } = document
        .getElementById(id)!
        .getBoundingClientRect();
      return { left, top, bottom, width, height };
    };
    return {
      viewport: innerWidth,
      bodyTop: body.top,
      bodyBottom: body.bottom,
      pages: [1, 2, 3].map((page) => box(`pagination-page-${page}`)),
      page: box("pagination-page-1"),
      large: box("pagination-large-image"),
      small: box("pagination-small-image"),
    };
  });
  expect(geometry.pages[1]!.left - geometry.pages[0]!.left).toBeCloseTo(geometry.viewport, 0);
  expect(geometry.pages[2]!.left - geometry.pages[1]!.left).toBeCloseTo(geometry.viewport, 0);
  for (const column of geometry.pages) {
    expect(column.top).toBeCloseTo(geometry.bodyTop, 0);
    expect(column.bottom).toBeCloseTo(geometry.bodyBottom, 0);
  }
  expect(geometry.large.width).toBeLessThanOrEqual(geometry.page.width + 1);
  expect(geometry.large.height).toBeLessThanOrEqual(geometry.page.height + 1);
  expect(geometry.small.width).toBeLessThanOrEqual(41);

  const scrollLeft = () => root.evaluate((element) => Math.abs(element.scrollLeft));
  await publicationFrame(page).focus();
  await page.keyboard.press("PageDown");
  await expect.poll(scrollLeft).toBeCloseTo(geometry.viewport, 0);
  await expect(bottomPages(page).getByText(/2 \/ (?:[2-9]|\d{2,})/)).toBeVisible();

  const themeSettings = await openReaderSettings(page);
  await themeSettings
    .getByRole("radiogroup", { name: "Book colors" })
    .getByRole("radio", { name: "Dark" })
    .click();
  await page.getByRole("button", { name: "Close reading settings" }).click();
  await expect
    .poll(async () => Math.abs((await scrollLeft()) - geometry.viewport))
    .toBeLessThanOrEqual(20);
  await expect(bottomPages(page).getByText(/2 \/ (?:[2-9]|\d{2,})/)).toBeVisible();

  await root.evaluate((element) => (element.scrollLeft = 0));
  const doubleSettings = await openReaderSettings(page);
  await doubleSettings.getByRole("radio", { name: "Double" }).click();
  await page.getByRole("button", { name: "Close reading settings" }).click();
  const pageStarts = () =>
    root.evaluate(() => ({
      viewport: innerWidth,
      pages: [1, 2, 3].map(
        (page) => document.getElementById(`pagination-page-${page}`)!.getBoundingClientRect().left,
      ),
    }));
  await expect
    .poll(async () => {
      const { viewport, pages } = await pageStarts();
      return Math.abs(pages[1]! - pages[0]! - viewport / 2) <= 1;
    })
    .toBe(true);
  const spread = await pageStarts();
  expect(spread.pages[2]! - spread.pages[0]!).toBeCloseTo(spread.viewport, 0);
  await expect(bottomPages(page).getByText(/1-2 \/ (?:[3-9]|\d{2,})/)).toBeVisible();
  await content.locator("body").evaluate((body) => {
    document.documentElement.scrollLeft = 0;
    body.focus();
  });
  await readerSettled(page);
  await content.locator("body").press("PageDown");
  await expect.poll(scrollLeft).toBeCloseTo(spread.viewport, 0);
  await expect(bottomPages(page).getByText(/3-4 \/ (?:[4-9]|\d{2,})/)).toBeVisible();
});

test("snaps an authored illustration fragment to a complete spread", async ({ page }) => {
  await openListOfIllustrationsInSpreads(page);
  await page.evaluate(() => {
    const samples: Array<{ aligned: boolean; visible: boolean }> = [];
    Object.assign(window, { __EPUB_NAVIGATOR_FRAGMENT_REVEALS__: samples });
    let remaining = 120;
    const sample = () => {
      const destination = [...document.querySelectorAll("iframe")].find((candidate) =>
        candidate.src.endsWith("chapter-1.xhtml"),
      );
      const view = destination?.contentWindow;
      const target = destination?.contentDocument?.getElementById("illustration-2");
      const root = destination?.contentDocument?.scrollingElement;
      if (
        destination?.getAttribute("aria-hidden") !== "true" &&
        destination?.style.opacity !== "0" &&
        view != null &&
        target != null &&
        root != null
      ) {
        const remainder = Math.abs(root.scrollLeft) % view.innerWidth;
        const rectangle = target.getBoundingClientRect();
        samples.push({
          aligned: Math.min(remainder, view.innerWidth - remainder) <= 2,
          visible: rectangle.right > 0 && rectangle.left < view.innerWidth,
        });
      }
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await publicationContent(page).locator('a[href="chapter-1.xhtml#illustration-2"]').click();
  await expect(publicationFrame(page)).toHaveAttribute("src", /chapter-1\.xhtml$/);

  await expect
    .poll(() =>
      publicationContent(page)
        .locator("html")
        .evaluate(() => {
          const root = document.scrollingElement;
          const target = document.getElementById("illustration-2");
          if (root === null || target === null) return null;
          const remainder = Math.abs(root.scrollLeft) % innerWidth;
          const rectangle = target.getBoundingClientRect();
          return {
            aligned: Math.min(remainder, innerWidth - remainder) <= 2,
            visible: rectangle.right > 0 && rectangle.left < innerWidth,
          };
        }),
    )
    .toEqual({ aligned: true, visible: true });
  const revealSamples = await page.evaluate(
    () =>
      (
        window as unknown as {
          __EPUB_NAVIGATOR_FRAGMENT_REVEALS__: { aligned: boolean; visible: boolean }[];
        }
      ).__EPUB_NAVIGATOR_FRAGMENT_REVEALS__,
  );
  expect(revealSamples.length).toBeGreaterThan(0);
  expect(revealSamples.every((sample) => sample.aligned && sample.visible)).toBe(true);
});

test("returns from a cross-document authored note", async ({ page }) => {
  await openListOfIllustrationsInSpreads(page);
  const reference = publicationContent(page).locator('a[href="chapter-1.xhtml#illustration-2"]');
  await reference.evaluate((element) =>
    element.setAttributeNS("http://www.idpf.org/2007/ops", "epub:type", "noteref"),
  );
  await reference.click();

  const frame = publicationFrame(page);
  await expect(frame).toHaveAttribute("src", /chapter-1\.xhtml$/);
  const returnAction = page.getByRole("button", { name: "Return to note reference" });
  await returnAction.click();
  await expect(frame).toHaveAttribute("src", /loi\.xhtml$/);
  await expect(returnAction).toBeHidden();
  await expect(reference).toBeInViewport();
});

test("fragments oversized centered inline-block prose across pages", async ({ page }) => {
  const initialSettings = await openReaderSettings(page);
  await initialSettings
    .getByRole("radiogroup", { name: "Keyboard" })
    .getByRole("radio", { name: "Standard" })
    .click();
  await initialSettings.getByRole("radio", { name: "Single" }).click();
  await page.getByRole("button", { name: "Close reading settings" }).click();
  await openContentsEntry(page, "III: A Caucus-Race and a Long Tale", /chapter-3\.xhtml$/);

  const content = publicationContent(page);
  const firstLine = content.getByText("“Fury said to", { exact: true });
  const poem = firstLine.locator("..");
  const cutOffNotice = page.getByText("Some content may be cut off in paginated view.");
  await expect(firstLine).toBeAttached();
  await expect(poem).toHaveCSS("display", "block");
  await expect(poem).toHaveCSS("zoom", "1");
  await expect(poem).toHaveAttribute("data-epub-navigator-fragmentation", /^m3-/);
  await expect(cutOffNotice).toHaveCount(0);

  const geometry = await poem.evaluate((element) => {
    const position = document.scrollingElement!.scrollLeft;
    const first = element.querySelector("span")!.getBoundingClientRect();
    const last = element.querySelector("span:last-of-type")!.getBoundingClientRect();
    const next = element.parentElement!.nextElementSibling!.getBoundingClientRect();
    const pageOf = (rect: DOMRect) => Math.floor((position + rect.left) / innerWidth);
    return {
      firstPage: pageOf(first),
      lastPage: pageOf(last),
      nextPage: pageOf(next),
      tops: [first.top, last.top, next.top],
      bottoms: [last.bottom, next.bottom],
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      viewportHeight: innerHeight,
    };
  });
  expect(geometry.lastPage).toBeGreaterThan(geometry.firstPage);
  expect(geometry.nextPage).toBeGreaterThanOrEqual(geometry.lastPage);
  for (const top of geometry.tops) expect(top).toBeGreaterThanOrEqual(0);
  for (const bottom of geometry.bottoms)
    expect(bottom).toBeLessThanOrEqual(geometry.viewportHeight);

  await expect
    .poll(async () => Number(await reader(page).getAttribute("data-section-page-count")))
    .toBeGreaterThan(1);
  await content.locator("html").evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
    );
  });
  await expect
    .poll(async () => Number(await reader(page).getAttribute("data-section-first-visible-page")))
    .toBeGreaterThan(0);
  await expect(publicationFrame(page)).toHaveAttribute("src", /chapter-3\.xhtml$/);
  await expect.poll(() => content.locator("html").evaluate((root) => root.scrollTop)).toBe(0);

  const scrollSettings = await openReaderSettings(page);
  await scrollSettings.getByRole("radio", { name: "Scrolled" }).click();
  await page.getByRole("button", { name: "Close reading settings" }).click();
  await expect(poem).toHaveCSS("display", "inline-block");
  await expect(poem).toHaveCSS("zoom", "1");
  await expect(poem).not.toHaveAttribute("data-epub-navigator-fragmentation");
  const authoredGeometry = await poem.evaluate((element) => ({
    fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
    height: element.getBoundingClientRect().height,
    viewportHeight: innerHeight,
  }));
  expect(geometry.fontSize).toBeCloseTo(authoredGeometry.fontSize, 1);
  expect(authoredGeometry.height).toBeGreaterThan(authoredGeometry.viewportHeight);

  await poem.evaluate((element) => ((element as HTMLElement).style.breakInside = "avoid"));
  const paginatedSettings = await openReaderSettings(page);
  await paginatedSettings.getByRole("radio", { name: "Paginated" }).click();
  await page.getByRole("button", { name: "Close reading settings" }).click();
  await expect(poem).toHaveCSS("display", "inline-block");
  await expect(poem).not.toHaveAttribute("data-epub-navigator-fragmentation");
  await expect(cutOffNotice).toBeVisible();
});

test("keeps the annotations surface out of unrelated reader renders", async ({ page }) => {
  await page.getByRole("button", { name: "Annotations", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Annotations" })).toBeVisible();
  const frame = publicationFrame(page);
  await expect(frame).toBeVisible();
  const renders = () =>
    page.evaluate(
      () =>
        (window.__EPUB_NAVIGATOR_DIAGNOSTICS__ ?? []).filter(
          (event) => event.type === "annotations-render",
        ).length,
    );
  const position = () =>
    page.evaluate(
      () =>
        `${document.querySelector('iframe[data-epub-navigator-participant="primary"]')?.getAttribute("src")}#${document.querySelector(".epub-navigator-reader")?.getAttribute("data-section-first-visible-page")}`,
    );
  const before = await renders();
  for (let step = 0; step < 6; step += 1) {
    const from = await position();
    await frame.focus();
    await page.keyboard.press("PageDown");
    await expect.poll(position).not.toBe(from);
  }
  await readerSettled(page);
  // Paging changes nothing the annotations surface renders, and it subscribes to its own atoms,
  // so a parent render must not reach it. A regression here restores ~7 renders per page turn.
  expect(await renders()).toBe(before);
});

test.describe("dark system preference", () => {
  test.use({ colorScheme: "dark" });

  test("keeps Alice black-on-transparent artwork on a coherent adaptive canvas", async ({
    page,
  }) => {
    const root = publicationContent(page).locator("html");
    const documentAppearance = await root.evaluate((element) => ({
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element).color,
    }));
    expect(documentAppearance.dark).toBe(true);
    expect(documentAppearance.background).not.toBe(documentAppearance.color);
    expect(documentAppearance.color).not.toBe("rgb(0, 0, 0)");

    const titleImage = publicationContent(page).locator("img").first();
    await expect(titleImage).toBeVisible();
    await expect(titleImage).not.toHaveCSS("filter", "none");
    expect(
      await titleImage.evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBeGreaterThan(0);

    await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/);
    const illustration = publicationContent(page).locator("img").first();
    await expect(illustration).toBeVisible();
    expect(
      await illustration.evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBeGreaterThan(0);
    await expect(illustration).toHaveCSS("background-color", documentAppearance.color);
    await expect(illustration).toHaveCSS("filter", "none");
  });

  test("lets Interface Light establish Alice's Original color environment", async ({ page }) => {
    const settings = await openReaderSettings(page);
    await settings
      .getByRole("radiogroup", { name: "Interface" })
      .getByRole("radio", { name: "Light" })
      .click();
    await settings.getByRole("button", { name: "Close reading settings" }).click();

    const root = publicationContent(page).locator("html");
    await expect
      .poll(() => root.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
      .toBe(true);
    await expect(root).toHaveCSS("color-scheme", "light");
    const colors = (locator: Locator) =>
      locator.evaluate((element) => [
        getComputedStyle(element).backgroundColor,
        getComputedStyle(element).color,
      ]);
    expect(await colors(root)).toEqual(await colors(reader(page)));
    const expectUnfiltered = async () => {
      const image = publicationContent(page).locator("img").first();
      await expect(image).toBeVisible();
      await expect(image).toHaveCSS("filter", "none");
      await expect(image).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    };
    await expectUnfiltered();
    await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/);
    await expectUnfiltered();
  });
});

test.describe("compact profile", () => {
  test.use(compactDevice);

  test("focuses search when opened by keyboard", async ({ page }) => {
    await publicationFrame(page).focus();
    await page.keyboard.press("/");
    await expect(page.getByRole("searchbox", { name: "Search publication" })).toBeFocused();
    await page.keyboard.type("rabbit");
    await expect(page.getByRole("searchbox", { name: "Search publication" })).toHaveValue("rabbit");
  });

  test("sizes compact surfaces to their kind, with fullscreen and panel tabs", async ({ page }) => {
    await expect(page.getByRole("toolbar", { name: "Reader controls" })).toHaveCount(0);
    await page.getByRole("button", { name: "Open quick menu" }).click();
    const quick = await settled(page.getByRole("dialog", { name: "Quick menu" }));
    const readerBox = (await reader(page).boundingBox())!;
    const quickBox = (await quick.boundingBox())!;
    // Quick menu is a popover elsewhere, so it takes only the height it needs.
    expect(quickBox.width).toBeCloseTo(readerBox.width, 0);
    expect(quickBox.y).toBeCloseTo(readerBox.y, 0);
    expect(quickBox.height).toBeLessThan(readerBox.height);
    await expect(quick).toHaveCSS("border-bottom-width", "2px");
    await quick.getByRole("button", { name: "Enter fullscreen" }).click();
    await expect(quick).toBeHidden();
    await page.getByRole("button", { name: "Open quick menu" }).click();
    await quick.getByRole("button", { name: "Exit fullscreen" }).click();
    await expect(quick).toBeHidden();
    await page.getByRole("button", { name: "Open quick menu" }).click();
    await expect(quick.getByRole("button", { name: "Enter fullscreen" })).toBeVisible();
    await expect(quick.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await quick.press("Escape");
    await expect(quick).toBeHidden();

    await page.getByRole("button", { name: "Open navigation" }).click();
    const dialog = await settled(page.getByRole("dialog", { name: "Navigation" }));
    // Navigation is a panel elsewhere, so it stays a defined full-height region.
    expect((await dialog.boundingBox())!.height).toBeCloseTo(readerBox.height, 0);
    await expect(page.getByRole("navigation", { name: "Publication navigation" })).toBeVisible();
    await expect(dialog.getByRole("tablist", { name: "Navigation lists" })).toBeVisible();
    await dialog
      .getByRole("tablist", { name: "Reader panels" })
      .getByRole("tab", { name: "Annotations" })
      .click();
    const annotations = page.getByRole("dialog", { name: "Annotations" });
    await expect(
      annotations.getByRole("button", { name: "Add bookmark at current location" }),
    ).toBeVisible();

    await annotations.press("Escape");
    await expect(annotations).toBeHidden();
    await expect.poll(() => activeElementTag(page)).toBe("IFRAME");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(annotations).toBeVisible();
  });

  test("transforms compact Navigation into Search", async ({ page }) => {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page
      .getByRole("dialog", { name: "Navigation" })
      .getByRole("button", { name: "Search publication" })
      .click();

    const search = page.getByRole("dialog", { name: "Search" });
    await expect(search.getByRole("button", { name: "Back to navigation" })).toBeVisible();
    await expect(search.getByRole("tablist", { name: "Reader panels" })).toHaveCount(0);
    const scope = search.getByRole("button", { name: "Search scope: Whole book" });
    await scope.click();
    await expect(page.getByRole("menuitemradio", { name: "Whole book" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(scope).toBeFocused();
    const input = search.getByRole("searchbox", { name: "Search publication" });
    await input.fill("rabbit");
    await input.press("Enter");
    await expect(search.getByRole("status")).toHaveText("1 result");
    await expect(search.getByRole("heading", { name: "I: Down the Rabbit-Hole" })).toBeVisible();

    await search.getByRole("button", { name: "Back to navigation" }).click();
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  });

  test("looks up a selection and follows a word inside the dictionary", async ({ page }) => {
    await lookUpSelectionInDictionary(page, "compact");
  });

  test("edits compact notes without leaving fullscreen", async ({ page }) => {
    await page.getByRole("button", { name: "Open quick menu" }).click();
    const quick = page.getByRole("dialog", { name: "Quick menu" });
    await quick.getByRole("button", { name: "Enter fullscreen" }).click();
    await expect.poll(() => readerIsFullscreen(page)).toBe(true);
    await expect(quick).toBeHidden();
    await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/, "compact");
    await selectPublicationText(page, 0);
    await selectionActions(page).getByRole("button", { name: "Add note" }).click();

    const editor = page.getByRole("dialog", { name: "Add note" });
    const text = editor.getByRole("textbox", { name: "Note" });
    await expect(editor.getByRole("tablist", { name: "Reader panels" })).toHaveCount(0);
    await expect(text).toBeFocused();
    await expect.poll(() => readerIsFullscreen(page)).toBe(true);
    await text.fill("Compact note text");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toBeHidden();

    await page.getByRole("button", { name: "Open navigation" }).click();
    const annotations = page.getByRole("dialog", { name: "Annotations" });
    await expect(annotations).toBeVisible();
    const row = annotations.locator("li").filter({ hasText: "Compact note text" });
    await row.getByRole("button", { name: /^Actions for note:/u }).click();
    await page.getByRole("menuitem", { name: "Edit note" }).click();

    const edit = page.getByRole("dialog", { name: "Edit note" });
    await expect(edit.getByRole("tablist", { name: "Reader panels" })).toHaveCount(0);
    await expect(edit.getByRole("textbox", { name: "Note" })).toBeFocused();
    await expect.poll(() => readerIsFullscreen(page)).toBe(true);
    await edit.getByRole("button", { name: "Cancel" }).click();
    await expect(annotations).toBeVisible();
    await expect(row).toBeFocused();
  });

  test("keeps the compact note editor inside the visual viewport", async ({ page }) => {
    await page.setViewportSize({ width: 572, height: 772 });
    await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/, "compact");
    await selectPublicationText(page, 0);
    const expected = await reader(page).evaluate((element) => {
      const host = element.getBoundingClientRect();
      const values = {
        offsetLeft: host.left + 7,
        offsetTop: host.top + 11,
        width: host.width - 14,
        height: 508,
      };
      const visual = new EventTarget();
      Object.defineProperties(visual, {
        offsetLeft: { get: () => values.offsetLeft },
        offsetTop: { get: () => values.offsetTop },
        pageLeft: { get: () => values.offsetLeft },
        pageTop: { get: () => values.offsetTop },
        width: { get: () => values.width },
        height: { get: () => values.height },
        scale: { get: () => 1 },
      });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
      return values;
    });
    await selectionActions(page).getByRole("button", { name: "Add note" }).click();

    const editor = page.getByRole("dialog", { name: "Add note" });
    const text = editor.getByRole("textbox", { name: "Note" });
    await expect(text).toBeFocused();
    const box = (await editor.boundingBox())!;
    expect(box.x).toBeCloseTo(expected.offsetLeft, 0);
    expect(box.y).toBeCloseTo(expected.offsetTop, 0);
    expect(box.width).toBeCloseTo(expected.width, 0);
    expect(box.height).toBeCloseTo(expected.height, 0);
    await editor.locator(".epub-navigator-reader__note-editor-excerpt").evaluate((element) => {
      element.textContent = "A long selected passage from the publication. ".repeat(50);
    });
    expect((await text.boundingBox())!.height).toBeGreaterThan(180);
    const body = editor.locator(".epub-navigator-reader__note-editor-body");
    const bodyOverflow = () =>
      body.evaluate((element) => element.scrollHeight - element.clientHeight);
    expect(await bodyOverflow()).toBeLessThanOrEqual(1);
    await text.fill("A long note. ".repeat(150));
    expect(await bodyOverflow()).toBeLessThanOrEqual(1);
    const footerBox = (await editor
      .locator(".epub-navigator-reader__note-editor-footer")
      .boundingBox())!;
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(
      expected.offsetTop + expected.height + 1,
    );
  });

  test("paginates compact navigation and annotation panels", async ({ page }) => {
    await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/, "compact");
    await selectPublicationText(page, 0);
    await selectionActions(page).getByRole("button", { name: "Add note" }).click();
    const noteEditor = page.getByRole("dialog", { name: "Add note" });
    await noteEditor
      .getByRole("textbox", { name: "Note" })
      .fill(`Universal rendering annotation ${"unbroken".repeat(40)}`);
    await noteEditor.getByRole("button", { name: "Save" }).click();
    await page.locator("#root").evaluate((root) => (root.style.height = "20rem"));
    await page.getByRole("button", { name: "Open navigation" }).click();

    const panelTab = (name: string) =>
      page.getByRole("tablist", { name: "Reader panels" }).getByRole("tab", { name });
    await panelTab("Navigation").click();
    const navigation = page.getByRole("dialog", { name: "Navigation" });
    await navigation
      .getByRole("button", { name: "Toggle Alice’s Adventures in Wonderland" })
      .click();
    const pages = navigation.locator(".epub-navigator-reader__pages").first();
    await expect(pages).toHaveAttribute("data-page-count", /[2-9]|\d{2,}/);
    const viewport = pages.locator(".epub-navigator-reader__page-viewport");
    await viewport.evaluate((element) => (element.scrollTop = 18));
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const indicator = navigation.locator(".epub-navigator-reader__page-footer output");
    const initialPage = await indicator.textContent();
    const next = navigation.getByRole("button", { name: "Next navigation page" });
    const footerBox = (await navigation
      .locator(".epub-navigator-reader__page-footer")
      .boundingBox())!;
    const tabsBox = (await navigation
      .getByRole("tablist", { name: "Reader panels" })
      .boundingBox())!;
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(tabsBox.y + 1);
    const lists = navigation.getByRole("tablist", { name: "Navigation lists" });
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual((await lists.boundingBox())!.y + 1);
    // A tab is carried by its fill, so pressing one previews that fill instead of ruling
    // under it, which the fill would then contradict.
    const pagesTab = lists.getByRole("tab", { name: "Pages", exact: true });
    await pagesTab.hover();
    await page.mouse.down();
    const pressed = await pagesTab.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      mark: getComputedStyle(element, "::after").content,
    }));
    expect(pressed.mark).toBe("none");
    expect(pressed.background).not.toBe("rgba(0, 0, 0, 0)");
    await page.mouse.move(0, 0);
    await page.mouse.up();
    expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await next.locator("svg").boundingBox())!.width).toBeGreaterThanOrEqual(24);
    if (await next.isEnabled()) await next.click();
    else await navigation.getByRole("button", { name: "Previous navigation page" }).click();
    await expect(indicator).not.toHaveText(initialPage ?? "");

    await panelTab("Annotations").click();
    const annotations = page.getByRole("dialog", { name: "Annotations" });
    await page.evaluate(() => window.__EPUB_NAVIGATOR_DUPLICATE_ANNOTATIONS__?.(20));
    const annotationPages = annotations.locator(
      ".epub-navigator-reader__annotations > .epub-navigator-reader__pages",
    );
    await expect(annotationPages).toHaveAttribute("data-page-count", /[2-9]|\d{2,}/);
    const card = annotations.locator(".epub-navigator-reader__annotation-card").first();
    await expect(card.getByRole("button", { name: /^Go to note:/u }).locator("q")).toBeVisible();
    for (const element of [
      card,
      annotationPages.locator(".epub-navigator-reader__page-viewport"),
    ]) {
      await expect
        .poll(() => element.evaluate((node) => node.scrollWidth - node.clientWidth))
        .toBeLessThanOrEqual(1);
    }
    const actions = annotations.getByRole("button", { name: /^Actions for note:/u }).first();
    await actions.focus();
    await actions.press("Enter");
    await expect(actions).toHaveAttribute("aria-expanded", "true");
    const annotationMenu = page.getByRole("menu", { name: /^Actions for note:/u });
    await expect(annotationMenu).toBeVisible();
    expect(
      await annotationMenu.evaluate(
        (element) => element.closest(".epub-navigator-reader") !== null,
      ),
    ).toBe(true);
    await annotationMenu.press("Escape");
    await expect(actions).toBeFocused();
  });

  test("keeps compact settings commands coherent through unsettled WebView geometry", async ({
    page,
  }) => {
    const pages = await openShortCompactSettings(page);
    const viewport = pages.locator(".epub-navigator-reader__page-viewport");
    const indicator = pages.locator(".epub-navigator-reader__page-footer output");
    const next = pages.getByRole("button", { name: "Next settings page" });
    const count = Number(await pages.getAttribute("data-page-count"));

    await viewport.evaluate((element) => {
      let prototype: object | null = element;
      let scrollTopDescriptor: PropertyDescriptor | undefined;
      let scrollHeightDescriptor: PropertyDescriptor | undefined;
      while (
        prototype !== null &&
        (scrollTopDescriptor === undefined || scrollHeightDescriptor === undefined)
      ) {
        scrollTopDescriptor ??= Object.getOwnPropertyDescriptor(prototype, "scrollTop");
        scrollHeightDescriptor ??= Object.getOwnPropertyDescriptor(prototype, "scrollHeight");
        prototype = Object.getPrototypeOf(prototype) as object | null;
      }
      const nativeTop = scrollTopDescriptor!.get!.bind(element) as () => number;
      const nativeSetTop = scrollTopDescriptor!.set!.bind(element) as (value: number) => void;
      const nativeHeight = scrollHeightDescriptor!.get!.bind(element) as () => number;
      const assigned: number[] = [];
      Object.assign(element, { __assignedScrollTops: assigned, __nativeScrollTop: nativeTop });
      let reported = nativeTop();
      let collapseNextHeightRead = true;
      let releaseScheduled = false;
      Object.defineProperty(element, "scrollHeight", {
        configurable: true,
        get: () => {
          if (!collapseNextHeightRead) return nativeHeight();
          collapseNextHeightRead = false;
          return element.clientHeight;
        },
      });
      Object.defineProperty(element, "scrollTop", {
        configurable: true,
        get: () => reported,
        set: (value: number) => {
          assigned.push(value);
          nativeSetTop(value);
          if (releaseScheduled) return;
          releaseScheduled = true;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              reported = nativeTop();
              releaseScheduled = false;
            }),
          );
        },
      });
    });
    const nativeTop = () =>
      viewport.evaluate((element) =>
        (element as unknown as { __nativeScrollTop: () => number }).__nativeScrollTop(),
      );

    await next.click();
    await expect(indicator).toHaveText(`2 / ${count}`);
    await expect.poll(nativeTop).toBeGreaterThan(0);
    const firstTop = await nativeTop();
    await next.click();
    await expect(indicator).toHaveText(`3 / ${count}`);
    await expect.poll(nativeTop).toBeGreaterThan(firstTop);
    expect(
      await viewport.evaluate(
        (element) =>
          (element as unknown as { __assignedScrollTops: number[] }).__assignedScrollTops,
      ),
    ).toHaveLength(2);
  });

  test("swipes horizontally through compact paginated settings", async ({ page }) => {
    const pages = await openShortCompactSettings(page);
    const count = Number(await pages.getAttribute("data-page-count"));
    const viewport = pages.locator(".epub-navigator-reader__page-viewport");
    const indicator = pages.locator(".epub-navigator-reader__page-footer output");
    const lightTheme = pages.getByRole("radio", { name: "Light" }).first();
    await lightTheme.evaluate((element) => {
      Object.assign(window, { __MENU_SWIPE_CLICKS__: 0 });
      for (const type of ["touchstart", "touchmove", "touchend"]) {
        element.addEventListener(type, (event) => event.stopPropagation());
      }
      element.addEventListener("click", () => {
        const probe = window as unknown as { __MENU_SWIPE_CLICKS__: number };
        probe.__MENU_SWIPE_CLICKS__ += 1;
      });
    });

    await dispatchNativeTouchSwipe(page, lightTheme, -96, 4, 41);
    await expect(indicator).toHaveText(`2 / ${count}`);
    expect(
      await page.evaluate(
        () => (window as unknown as { __MENU_SWIPE_CLICKS__: number }).__MENU_SWIPE_CLICKS__,
      ),
    ).toBe(0);

    await dispatchNativeTouchSwipe(page, viewport, 96, 3, 43);
    await expect(indicator).toHaveText(`1 / ${count}`);
    await dispatchNativeTouchSwipe(page, viewport, 4, 96, 42);
    await expect(indicator).toHaveText(`1 / ${count}`);
    await dispatchNativeTouchSwipe(page, viewport, 24, 2, 44);
    await expect(indicator).toHaveText(`1 / ${count}`);

    // A deliberate drag is the same gesture as a flick, only slower.
    await dispatchNativeTouchSwipe(page, viewport, -96, 4, 45, { steps: 6, gapMs: 140 });
    await expect(indicator).toHaveText(`2 / ${count}`);
  });

  test("uses touch zones without overlaying publication content", async ({ page }) => {
    const readerBox = (await reader(page).boundingBox())!;
    await page.mouse.move(readerBox.x + readerBox.width / 2, readerBox.y + readerBox.height / 2);
    await expect(page.getByRole("toolbar", { name: "Reader controls" })).toHaveCount(0);
    const y = readerBox.y + readerBox.height * 0.75;
    await page.touchscreen.tap(readerBox.x + readerBox.width * 0.5, y);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.touchscreen.tap(readerBox.x + readerBox.width * 0.9, y);
    await expect(publicationFrame(page)).toHaveAttribute("src", /imprint\.xhtml$/);
  });

  test("turns the page for a deliberate swipe, not only a flick", async ({ page }) => {
    // A finger on a low-refresh display takes its time, and the gesture is no less a page turn
    // for it: direction and distance say what it is, and the clock only rejects a drag that was
    // really something else.
    await dispatchNativeTouchSwipe(page, publicationFrame(page), -220, 4, 95, {
      steps: 6,
      gapMs: 140,
    });
    await expect(publicationFrame(page)).toHaveAttribute("src", /imprint\.xhtml$/);
  });

  test("keeps compact chrome clear of display cutouts and rounded corners", async ({ page }) => {
    const bottomRail = page.locator(".epub-navigator-reader__compact-bottom-rail");
    const edges = () =>
      page.evaluate(() => {
        const box = (selector: string) =>
          document.querySelector(`.epub-navigator-reader${selector}`)!.getBoundingClientRect();
        const root = box("");
        const rail = document.querySelector(".epub-navigator-reader__compact-bottom-rail")!;
        const railBox = rail.getBoundingClientRect();
        const publication = box("__publication-region");
        return {
          sectionStart: box("__bottom-section").left - root.left,
          pagesEnd: root.right - box("__bottom-pages").right,
          publicationStart: publication.left - root.left,
          publicationEnd: root.right - publication.right,
          publicationTop: publication.top,
          publicationHeight: publication.height,
          railTop: railBox.top,
          progressWidth: box("__compact-progress").width,
          railWidth: railBox.width,
          triggerWidth: box("__compact-bottom-trigger").width,
          topRailStart: Number.parseFloat(
            getComputedStyle(document.querySelector(".epub-navigator-reader__compact-top-rail")!)
              .paddingLeft,
          ),
          railPaddingTop: getComputedStyle(rail).paddingTop,
          railPaddingBottom: getComputedStyle(rail).paddingBottom,
          railHeight: Math.round(railBox.height),
        };
      });
    const sheetPadding = () =>
      appearance.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          top: style.paddingTop,
          bottom: style.paddingBottom,
          left: style.paddingLeft,
          right: style.paddingRight,
        };
      });
    const setInsets = (insets: Partial<Record<"top" | "bottom" | "left" | "right", number>>) =>
      session.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: 0, bottom: 0, left: 0, right: 0, ...insets },
      });
    const appearance = page.getByRole("dialog", { name: "Quick Menu" });
    const openAppearance = async () => {
      await page.getByRole("button", { name: "Open quick menu" }).click();
      await expect(appearance).toBeVisible();
      await settled(appearance);
    };
    const closeAppearance = async () => {
      await appearance.press("Escape");
      await expect(appearance).toBeHidden();
    };

    await expect(bottomRail).toBeVisible();
    const withoutInsets = await edges();
    expect(withoutInsets).toMatchObject({
      railPaddingTop: "8px",
      railPaddingBottom: "0px",
      railHeight: 28,
    });
    expect(withoutInsets.sectionStart).toBeCloseTo(12, 0);
    expect(withoutInsets.pagesEnd).toBeCloseTo(12, 0);
    expect(withoutInsets.publicationStart).toBeCloseTo(0, 0);
    expect(withoutInsets.publicationEnd).toBeCloseTo(0, 0);

    const session = await page.context().newCDPSession(page);
    await setInsets({ top: 48 });
    await expect.poll(async () => (await edges()).sectionStart).toBeCloseTo(12, 0);
    const portrait = await edges();
    expect(portrait.pagesEnd).toBeCloseTo(12, 0);
    // Absolutely positioned rail children resolve against the padding box, so they still span it.
    expect(portrait.progressWidth).toBeCloseTo(portrait.railWidth, 0);
    expect(portrait.triggerWidth).toBeCloseTo(portrait.railWidth, 0);
    // A cutout inset never changes the rail's own vertical balance.
    expect(portrait).toMatchObject({
      railPaddingTop: "8px",
      railPaddingBottom: "0px",
      railHeight: 28,
    });
    expect(portrait.publicationStart).toBeCloseTo(0, 0);
    expect(portrait.publicationEnd).toBeCloseTo(0, 0);

    await openAppearance();
    const header = (await appearance.locator("header").first().boundingBox())!;
    expect(header.y).toBeGreaterThanOrEqual((await reader(page).boundingBox())!.y + 48);
    // The sheet clears the cutout without constraining its own width.
    expect(await sheetPadding()).toMatchObject({ top: "48px", left: "0px", right: "0px" });
    await closeAppearance();

    await setInsets({ bottom: 34 });
    await expect
      .poll(async () => (await edges()).publicationTop)
      .toBe(withoutInsets.publicationTop);
    expect(await edges()).toEqual(withoutInsets);
    const setCorners = (left: string | null, right: string | null) =>
      reader(page).evaluate(
        (element, [leftValue, rightValue]) => {
          const style = (element as HTMLElement).style;
          for (const [side, value] of [
            ["left", leftValue],
            ["right", rightValue],
          ] as const) {
            if (value === null) style.removeProperty(`--reader-host-corner-bottom-${side}`);
            else style.setProperty(`--reader-host-corner-bottom-${side}`, value);
          }
        },
        [left, right] as const,
      );
    await setCorners("28px", "40px");
    await expect.poll(async () => (await edges()).sectionStart).toBeCloseTo(28, 0);
    const roundedPortrait = await edges();
    expect(roundedPortrait.pagesEnd).toBeCloseTo(40, 0);
    expect(roundedPortrait).toMatchObject({
      railPaddingBottom: "0px",
      railHeight: 28,
      publicationTop: withoutInsets.publicationTop,
      publicationHeight: withoutInsets.publicationHeight,
      railTop: withoutInsets.railTop,
    });
    expect(roundedPortrait.publicationStart).toBeCloseTo(0, 0);
    expect(roundedPortrait.publicationEnd).toBeCloseTo(0, 0);

    await openAppearance();
    expect(await sheetPadding()).toMatchObject({ bottom: "0px", left: "0px", right: "0px" });
    await appearance.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Reading settings" });
    await expect(settings).toBeVisible();
    await settled(settings);
    const settingsFooter = await settings
      .locator(".epub-navigator-reader__page-footer")
      .evaluate((element) => {
        const root = document.querySelector(".epub-navigator-reader")!.getBoundingClientRect();
        const footer = element.getBoundingClientRect();
        const buttons = element.querySelectorAll("button");
        return {
          start: buttons[0]!.getBoundingClientRect().left - root.left,
          end: root.right - buttons[1]!.getBoundingClientRect().right,
          width: footer.width,
          rootWidth: root.width,
          bottom: root.bottom - footer.bottom,
          height: footer.height,
        };
      });
    expect(settingsFooter.start).toBeCloseTo(28, 0);
    expect(settingsFooter.end).toBeCloseTo(40, 0);
    expect(settingsFooter.width).toBe(settingsFooter.rootWidth);
    expect(settingsFooter.bottom).toBeCloseTo(0, 0);
    await settings.press("Escape");
    await expect(settings).toBeHidden();
    await setCorners(null, null);

    await setInsets({ left: 60 });
    await expect.poll(async () => (await edges()).sectionStart).toBeCloseTo(60, 0);
    const landscape = await edges();
    expect(landscape.pagesEnd).toBeCloseTo(12, 0);
    expect(landscape.topRailStart).toBeCloseTo(60, 0);
    expect(landscape.publicationStart).toBeCloseTo(60, 0);
    expect(landscape.publicationEnd).toBeCloseTo(0, 0);
    await openAppearance();
    expect(await sheetPadding()).toMatchObject({ left: "0px", right: "0px" });
    await closeAppearance();

    await setInsets({ right: 60 });
    await expect.poll(async () => (await edges()).pagesEnd).toBeCloseTo(60, 0);
    const mirroredLandscape = await edges();
    expect(mirroredLandscape.sectionStart).toBeCloseTo(12, 0);
    expect(mirroredLandscape.publicationStart).toBeCloseTo(0, 0);
    expect(mirroredLandscape.publicationEnd).toBeCloseTo(60, 0);

    await session.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
    await expect.poll(async () => (await edges()).sectionStart).toBeCloseTo(12, 0);
  });
});

test("names the keys for the presentation the book is in", async ({ page }) => {
  await openReader(page);
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  const show = async () => {
    await publicationFrame(page).focus();
    await page.keyboard.press("?");
    await expect(help).toBeVisible();
  };
  const choose = async (mode: "Scrolled" | "Paginated") => {
    const settings = await openReaderSettings(page);
    await settings.getByRole("radio", { name: mode, exact: true }).click();
    await page.getByRole("button", { name: "Close reading settings" }).click();
  };

  await choose("Scrolled");
  await show();
  await expect(help).toContainText("Next screen");
  await expect(help).toContainText("Next / previous section");
  await expect(help).toContainText("moves by screen");
  await help.getByRole("button", { name: "Close keyboard shortcuts" }).click();

  await choose("Paginated");
  await show();
  await expect(help).toContainText("Next page");
  await expect(help).toContainText("Follow reading direction");
  await expect(help).toContainText("turns pages");
});

function diagnosticsMark(page: Page): Promise<number> {
  return page.evaluate(() => window.__EPUB_NAVIGATOR_DIAGNOSTICS__?.length ?? 0);
}

async function readerSettled(page: Page, since: number | null = null): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((mark) => {
        const open = new Set<string>();
        let activity: string | null = null;
        let settledSinceMark = mark === null;
        (window.__EPUB_NAVIGATOR_DIAGNOSTICS__ ?? []).forEach((event, index) => {
          if (event.type === "layout") {
            const key = `${event.role}:${event.documentGeneration}:${event.layoutGeneration}:${event.operation}`;
            if (event.action === "start") open.add(key);
            else open.delete(key);
            if (event.action === "settle" && mark !== null && index >= mark)
              settledSinceMark = true;
          } else if (event.type === "controller-publish") activity = event.activity;
        });
        return settledSinceMark && open.size === 0 && activity === "idle";
      }, since),
    )
    .toBe(true);
  await contentFrames(page);
}

async function contentFrames(page: Page): Promise<void> {
  await publicationContent(page)
    .locator("html")
    .evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
}

async function openReader(page: Page, query = ""): Promise<void> {
  await page.goto(`/reader/reader.html${query}`);
  await expect(reader(page)).toHaveAttribute("data-reader-state", "reading", { timeout: 15_000 });
}

async function openReaderSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /Open quick menu/u }).click();
  await page
    .getByRole("dialog", { name: "Quick menu" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Reading settings" });
}

async function openContentsEntry(
  page: Page,
  entry: string,
  resource: RegExp,
  profile: "workspace" | "compact" = "workspace",
): Promise<void> {
  await page
    .getByRole("button", {
      name: profile === "compact" ? "Open navigation" : "Navigation",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Toggle Alice’s Adventures in Wonderland" }).click();
  await page.getByRole("button", { name: entry }).click();
  await expect(publicationFrame(page)).toHaveAttribute("src", resource);
}

async function openListOfIllustrationsInSpreads(page: Page): Promise<void> {
  const settings = await openReaderSettings(page);
  await settings.getByRole("radio", { name: "Double" }).click();
  await page.getByRole("button", { name: "Close reading settings" }).click();
  await openContentsEntry(page, "List of Illustrations", /loi\.xhtml$/);
}

async function openShortCompactSettings(page: Page): Promise<Locator> {
  await page.locator("#root").evaluate((root) => (root.style.height = "20rem"));
  const settings = await openReaderSettings(page);
  const pages = settings.locator(".epub-navigator-reader__pages");
  await expect(pages).toHaveAttribute("data-page-count", /[3-9]|\d{2,}/);
  // The panel repaginates as its own content settles, so the count a caller reads is only good
  // once it has stopped moving.
  await expect
    .poll(async () => {
      const first = await pages.getAttribute("data-page-count");
      await page.waitForTimeout(150);
      return (await pages.getAttribute("data-page-count")) === first ? first : null;
    })
    .not.toBeNull();
  return pages;
}

async function lookUpSelectionInDictionary(
  page: Page,
  profile: "workspace" | "compact",
): Promise<void> {
  await openContentsEntry(page, "I: Down the Rabbit-Hole", /chapter-1\.xhtml$/, profile);
  await selectPublicationText(page, 0);
  await selectionActions(page).getByRole("button", { name: "Look up" }).click();

  const surface = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("region", { name: "English Wiktionary" }) });
  await expect(surface).toBeVisible();
  if (profile === "workspace") {
    expect((await surface.boundingBox())!.width).toBeLessThan(page.viewportSize()!.width);
  } else {
    // The sheet has one height, the reader's, and no raised position to rest at instead.
    expect((await surface.boundingBox())!.height).toBe((await reader(page).boundingBox())!.height);
  }
  const view = surface.getByRole("region", { name: "English Wiktionary" });
  const gloss = view.getByText("Largest living land mammal");
  await expect(gloss).toBeVisible();
  await expect(view.getByText(/An example with/)).toBeVisible();
  const etymology = view.getByRole("button", { name: "Etymology" });
  await expect(etymology).toHaveAttribute("aria-expanded", "false");
  await etymology.click();
  await expect(view.getByText("From Middle English olifaunt.")).toBeVisible();

  const glossBox = (await gloss.boundingBox())!;
  await page.mouse.click(glossBox.x + 4, glossBox.y + glossBox.height / 2);
  await expect(
    surface.getByRole("heading", { name: "Largest", exact: true }).first(),
  ).toBeVisible();
  await expect(surface.locator(".epub-navigator-reader__page-footer output")).toHaveText(
    /1 \/ \d+/,
  );
  const back = surface.getByRole("button", { name: "Back to previous word" });
  await back.click();
  await expect(back).toHaveCount(0);
  if (profile === "workspace") {
    await surface.getByRole("button", { name: "Close dictionary" }).click();
  } else {
    await surface.press("Escape");
  }
  await expect(surface).toBeHidden();
}

async function selectPublicationText(page: Page, index: number): Promise<string> {
  let selected = "";
  await expect
    .poll(async () => {
      selected = await publicationContent(page)
        .locator("body")
        .evaluate((body, visibleTextIndex) => {
          const visible = (rect: DOMRect) =>
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < innerWidth &&
            rect.top < innerHeight;
          const candidates: { target: Text; start: number }[] = [];
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const candidate = walker.currentNode as Text;
            if (!/\S/u.test(candidate.nodeValue ?? "")) continue;
            const probe = document.createRange();
            probe.selectNodeContents(candidate);
            if (visible(probe.getBoundingClientRect())) {
              candidates.push({
                target: candidate,
                start: (candidate.nodeValue ?? "").search(/\S/u),
              });
            }
          }
          if (candidates.length === 0) {
            const seen = new Set<Node>();
            for (let y = 16; y < innerHeight; y += 24) {
              for (let x = 16; x < innerWidth; x += 48) {
                const caret = document.caretRangeFromPoint(x, y);
                const candidate = caret?.startContainer;
                if (
                  caret == null ||
                  candidate?.nodeType !== Node.TEXT_NODE ||
                  !/\S/u.test(candidate.nodeValue ?? "") ||
                  seen.has(candidate)
                ) {
                  continue;
                }
                seen.add(candidate);
                const text = candidate.nodeValue ?? "";
                let start = Math.min(caret.startOffset, Math.max(0, text.length - 1));
                while (start < text.length && /\s/u.test(text[start] ?? "")) start += 1;
                if (start < text.length) candidates.push({ target: candidate as Text, start });
              }
            }
          }
          const candidate = candidates[visibleTextIndex] ?? candidates[0];
          if (candidate === undefined) return "";
          const range = document.createRange();
          range.setStart(candidate.target, candidate.start);
          range.setEnd(candidate.target, Math.min(candidate.target.length, candidate.start + 12));
          window.focus();
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
          return getSelection()!.toString();
        }, index);
      return selected;
    })
    .not.toBe("");
  return selected;
}

async function clearPublicationSelection(page: Page): Promise<void> {
  await publicationContent(page)
    .locator("html")
    .evaluate(() => {
      getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
}

async function expectNoSeriousViolations(page: Page, include: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).include(include).analyze();
  expect(violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual(
    [],
  );
}

async function dispatchNativeTouchSwipe(
  page: Page,
  locator: Locator,
  x: number,
  y: number,
  id: number,
  pace: { steps: number; gapMs: number } = { steps: 2, gapMs: 0 },
): Promise<void> {
  const box = (await locator.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const session = await page.context().newCDPSession(page);
  const point = (fraction: number) => ({
    x: start.x + x * fraction,
    y: start.y + y * fraction,
    id,
    radiusX: 4,
    radiusY: 4,
    force: 1,
  });
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(0)] });
  for (let step = 1; step <= pace.steps; step += 1) {
    if (pace.gapMs > 0) await page.waitForTimeout(pace.gapMs);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point(step / pace.steps)],
    });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
}
