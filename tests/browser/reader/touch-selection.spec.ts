import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import {
  selectionEdgeDwellMs,
  selectionEdgeTouchRepeatMs,
  selectionTouchDwellMs,
} from "../../../src/runtime/content-agent/selection/controller.js";

/**
 * Native touch selection as the content agent sees it: after a long press the browser takes
 * the touch over, so the page gets the touch begun and cancelled, then only the selection
 * changing under an invisible finger, strays for a finger in a margin, scrolls to reveal
 * them, and the selection menu when the finger lifts.
 */

const compactDevice = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
test.use(compactDevice);

const pastDwell = selectionEdgeDwellMs + 100;
const pastRepeat = selectionEdgeTouchRepeatMs + 100;
const pastTouchDwell = selectionTouchDwellMs + 100;

const selectionActions = (page: Page) => page.getByRole("toolbar", { name: "Selection actions" });

const reader = (page: Page) => page.locator(".epub-navigator-reader");
const publicationFrame = (page: Page) =>
  page.locator('iframe[data-epub-navigator-participant="primary"]');

declare global {
  function touchTakenOver(): void;
  function longPressWord(index?: number): LongPress;
  function lastLongPress(): LongPress;
  interface LongPress {
    text: string;
    x: number;
    y: number;
    words: { text: string; x: number; y: number }[];
  }
  function touchAt(type: "pointermove" | "pointerup", x: number, y: number): void;
  function visibleTextPosition(edge: "start" | "end"): { node: Node; offset: number };
  function effectivePaginatedPosition(): number;
}

async function openPaginatedChapter(page: Page): Promise<FrameLocator> {
  await page.goto("/reader/reader.html");
  await expect(reader(page)).toHaveAttribute("data-reader-state", "reading", { timeout: 15_000 });
  await page.getByRole("button", { name: /Open quick menu/u }).click();
  await page
    .getByRole("dialog", { name: "Quick Menu" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Reading settings" })
    .getByRole("radio", { name: "Paginated" })
    .click();
  await page.getByRole("button", { name: "Back to quick menu" }).click();
  await page.getByRole("button", { name: "Close quick menu" }).click();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Toggle Alice’s Adventures in Wonderland" }).click();
  await page.getByRole("button", { name: /Down the Rabbit-Hole/u }).click();
  await expect(publicationFrame(page)).toHaveAttribute("src", /chapter-1\.xhtml$/);
  await expect(reader(page)).toHaveAttribute("data-reader-state", "reading");
  const frame = publicationFrame(page).contentFrame();
  await expect
    .poll(() => frame.locator("html").evaluate(() => getComputedStyle(document.body).columnCount))
    .toBe("1");
  await frame.locator("html").evaluate(() => {
    const global = window as unknown as {
      touchTakenOver: typeof touchTakenOver;
      longPressWord: typeof longPressWord;
      lastLongPress: typeof lastLongPress;
      touchAt: typeof touchAt;
      visibleTextPosition: typeof visibleTextPosition;
      effectivePaginatedPosition: typeof effectivePaginatedPosition;
    };
    global.touchTakenOver = () => {
      const init = {
        pointerId: 9,
        pointerType: "touch",
        isPrimary: true,
        clientX: 100,
        clientY: 100,
        bubbles: true,
      };
      window.dispatchEvent(new PointerEvent("pointerdown", { ...init, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointercancel", init));
    };
    global.touchAt = (type, x, y) => {
      window.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 9,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
    };
    // A long press as the agent sees it: the finger lands mid-word, the browser selects the
    // word around it and raises its menu with the finger still down, and the agent takes the
    // drag over from the browser. The pressed word is one of the page's first long words, all
    // in one text node, with the others returned as places to drag to.
    let lastPress: LongPress | undefined;
    global.lastLongPress = () => {
      if (lastPress === undefined) throw new Error("no long press yet");
      return lastPress;
    };
    global.longPressWord = (index = 0) => {
      const first = visibleTextPosition("start");
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      walker.currentNode = first.node;
      let found: { text: Text; words: { start: number; word: string; rect: DOMRect }[] } | null =
        null;
      for (let node: Node | null = first.node; node !== null; node = walker.nextNode()) {
        const text = node as Text;
        const from = node === first.node ? first.offset : 0;
        const words: { start: number; word: string; rect: DOMRect }[] = [];
        for (const match of text.data.slice(from).matchAll(/[A-Za-z]{6,}/gu)) {
          const start = from + match.index;
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + match[0].length);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0) {
            words.push({ start, word: match[0], rect });
          }
        }
        if (words.length >= 2) {
          found = { text, words };
          break;
        }
      }
      if (found === null) throw new Error("the page has no text with two long words on screen");
      const { text, words } = found;
      const pressed = words[index];
      if (pressed === undefined) throw new Error(`the page has no long word ${index}`);
      const centre = (rect: DOMRect) => ({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      const { x, y } = centre(pressed.rect);
      const start = pressed.start;
      window.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: 9,
          pointerType: "touch",
          isPrimary: true,
          button: 0,
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
      getSelection()!.setBaseAndExtent(text, start, text, start + pressed.word.length);
      // The browser raises its menu synchronously with the word already selected and queues
      // the selection change behind it, so the agent takes the drag over before it hears of it.
      document.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true }));
      document.dispatchEvent(new Event("selectionchange"));
      const press = {
        text: pressed.word,
        x,
        y,
        words: words.map((word) => ({ text: word.word, ...centre(word.rect) })),
      };
      lastPress = press;
      return press;
    };
    global.visibleTextPosition = (edge) => {
      const style = getComputedStyle(document.body);
      const inlineStart = parseFloat(style.marginInlineStart);
      const inlineEnd = parseFloat(style.marginInlineEnd);
      const blockStart = parseFloat(style.marginBlockStart) + 1;
      const blockEnd = innerHeight - parseFloat(style.marginBlockEnd) - 1;
      const inline = edge === "start" ? inlineStart + 1 : innerWidth - inlineEnd - 1;
      for (let probe = 0; ; probe += 1) {
        const y = edge === "start" ? blockStart + probe * 16 : blockEnd - probe * 16;
        if (y < blockStart || y > blockEnd) break;
        const position = document.caretPositionFromPoint(inline, y);
        if (position === null || position.offsetNode.nodeType !== Node.TEXT_NODE) continue;
        const range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
        const rect = range.getClientRects()[0];
        if (rect !== undefined && rect.left >= 0 && rect.right <= innerWidth) {
          return { node: position.offsetNode, offset: position.offset };
        }
      }
      throw new Error("the page has no visible text position");
    };
    // The page shown, whether scrolled to or held in place by the agent's translate.
    global.effectivePaginatedPosition = () => {
      const transform = getComputedStyle(document.body).transform;
      const match = /matrix\(([^)]+)\)/u.exec(transform);
      const translate = match === null ? 0 : Number(match[1]?.split(",")[4] ?? 0);
      return Math.abs(document.scrollingElement!.scrollLeft) + Math.abs(translate);
    };
  });
  return frame;
}

async function settleOnPage(frame: FrameLocator, page: number): Promise<number> {
  return frame.locator("html").evaluate(async (root, page) => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      root.scrollLeft = page * innerWidth;
      window.dispatchEvent(new Event("scroll"));
      await sleep(300);
      if (root.scrollLeft === page * innerWidth) break;
    }
    await sleep(600);
    return innerWidth;
  }, page);
}

test("turns the page for a native handle drag that reaches the page's last position", async ({
  page,
}) => {
  const frame = await openPaginatedChapter(page);
  const stride = await settleOnPage(frame, 2);
  const position = () => frame.locator("html").evaluate(() => effectivePaginatedPosition());
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await frame.locator("html").evaluate((root) => {
    touchTakenOver();
    const selection = getSelection()!;
    const first = visibleTextPosition("start");
    selection.setBaseAndExtent(first.node, first.offset, first.node, first.offset + 1);
    document.dispatchEvent(new Event("selectionchange"));
    const last = visibleTextPosition("end");
    selection.extend(last.node, last.offset);
    document.dispatchEvent(new Event("selectionchange"));
    const scrolled = new Promise((resolve) => addEventListener("scroll", resolve, { once: true }));
    root.scrollLeft = 80;
    return scrolled;
  });
  expect(await position()).toBeCloseTo(2 * stride, 0);
  await page.clock.runFor(pastDwell);
  expect(await position()).toBeCloseTo(3 * stride, 0);
  // Strays the browser resolves for a finger in the margin, and its scrolls to reveal them,
  // move neither the page nor the selection's anchor.
  for (let index = 0; index < 6; index++) {
    await frame.locator("html").evaluate((root, index) => {
      const selection = getSelection()!;
      selection.extend(document.body, document.body.childNodes.length - (index % 2));
      document.dispatchEvent(new Event("selectionchange"));
      const scrolled = new Promise((resolve) =>
        addEventListener("scroll", resolve, { once: true }),
      );
      root.scrollLeft += 80;
      return scrolled;
    }, index);
    await page.clock.runFor(150);
    expect(await position()).toBeCloseTo(3 * stride, 0);
  }
  // The finger rests over the revealed page and lifts: the browser raises its menu.
  // The finger comes to rest on the revealed page's first character, meeting the anchor that
  // stands in for the page's start, then lifts: the browser raises its menu.
  await frame.locator("html").evaluate(() => {
    const selection = getSelection()!;
    const resting = visibleTextPosition("start");
    selection.extend(resting.node, resting.offset);
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true }));
  });
  await page.clock.runFor(pastRepeat);
  expect(
    await frame.locator("html").evaluate((root) => {
      const selection = getSelection()!;
      const first = visibleTextPosition("start");
      const caret = document.createRange();
      caret.setStart(selection.focusNode!, selection.focusOffset);
      caret.collapse(true);
      const rect = caret.getBoundingClientRect();
      const anchor = document.createRange();
      anchor.setStart(selection.anchorNode!, selection.anchorOffset);
      anchor.collapse(true);
      return {
        scroll: Math.abs(root.scrollLeft),
        held: document.querySelector("style[data-epub-navigator-hold]") !== null,
        collapsed: selection.isCollapsed,
        focusVisible: rect.left >= 0 && rect.right <= innerWidth,
        anchorBeforePage: anchor.compareBoundaryPoints(Range.START_TO_START, firstRange(first)) < 0,
      };
      function firstRange(position: { node: Node; offset: number }): Range {
        const range = document.createRange();
        range.setStart(position.node, position.offset);
        range.collapse(true);
        return range;
      }
    }),
  ).toEqual({
    scroll: 3 * stride,
    held: false,
    collapsed: false,
    focusVisible: true,
    anchorBeforePage: true,
  });
});

test("turns backward for a native start handle dragged to the page's first position", async ({
  page,
}) => {
  const frame = await openPaginatedChapter(page);
  const stride = await settleOnPage(frame, 2);
  const position = () => frame.locator("html").evaluate(() => effectivePaginatedPosition());
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await frame.locator("html").evaluate(() => {
    touchTakenOver();
    const selection = getSelection()!;
    const body = document.body;
    const first = visibleTextPosition("start");
    selection.setBaseAndExtent(first.node, first.offset + 1, body, body.childNodes.length);
    document.dispatchEvent(new Event("selectionchange"));
    // Grabbing the start handle re-bases the selection on the end: the moving end becomes
    // the focus, and it then reaches the first position on the page.
    selection.setBaseAndExtent(body, body.childNodes.length, first.node, first.offset + 1);
    document.dispatchEvent(new Event("selectionchange"));
    selection.extend(first.node, first.offset);
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(await position()).toBeCloseTo(2 * stride, 0);
  await page.clock.runFor(pastDwell);
  expect(await position()).toBeCloseTo(stride, 0);
  // The finger is now over the revealed page, and the browser places the focus under it.
  expect(
    await frame.locator("html").evaluate(() => {
      const selection = getSelection()!;
      const resting = visibleTextPosition("end");
      selection.extend(resting.node, resting.offset);
      document.dispatchEvent(new Event("selectionchange"));
      const caret = document.createRange();
      caret.setStart(selection.focusNode!, selection.focusOffset);
      caret.collapse(true);
      const rect = caret.getBoundingClientRect();
      return {
        collapsed: selection.isCollapsed,
        focusVisible: rect.left >= 0 && rect.right <= innerWidth,
      };
    }),
  ).toEqual({ collapsed: false, focusVisible: true });
  // Lifting restores the distant end as the anchor and releases the held page.
  await frame.locator("html").evaluate(() => {
    document.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true }));
  });
  await page.clock.runFor(pastRepeat);
  expect(
    await frame.locator("html").evaluate((root) => ({
      scroll: Math.abs(root.scrollLeft),
      held: document.querySelector("style[data-epub-navigator-hold]") !== null,
      anchorAtEnd:
        getSelection()!.anchorNode === document.body &&
        getSelection()!.anchorOffset === document.body.childNodes.length,
    })),
  ).toEqual({ scroll: stride, held: false, anchorAtEnd: true });
});

test("keeps the long-pressed word when the finger lifts where it pressed", async ({ page }) => {
  const frame = await openPaginatedChapter(page);
  await settleOnPage(frame, 2);
  const result = await frame.locator("html").evaluate(() => {
    const press = longPressWord();
    // The finger shifts a little as it lifts, as a real lift does.
    touchAt("pointermove", press.x + 2, press.y + 1);
    touchAt("pointermove", press.x + 3, press.y + 2);
    touchAt("pointerup", press.x + 3, press.y + 2);
    return { word: press.text, selected: getSelection()!.toString() };
  });
  expect(result.selected).toBe(result.word);
});

test("advances by word once a long press turns into a drag", async ({ page }) => {
  const frame = await openPaginatedChapter(page);
  await settleOnPage(frame, 2);
  const result = await frame.locator("html").evaluate(() => {
    const press = longPressWord(0);
    const next = press.words[1]!;
    touchAt("pointermove", press.x + 2, press.y);
    const resting = getSelection()!.toString();
    // The finger comes to rest in the middle of a later word: the whole word is taken.
    touchAt("pointermove", next.x, next.y);
    const dragged = getSelection()!.toString();
    touchAt("pointerup", next.x, next.y);
    return {
      word: press.text,
      next: next.text,
      resting,
      dragged,
      lifted: getSelection()!.toString(),
    };
  });
  expect(result.resting).toBe(result.word);
  expect(result.dragged.startsWith(result.word)).toBe(true);
  expect(result.dragged.endsWith(result.next)).toBe(true);
  expect(result.lifted).toBe(result.dragged);
});

test("keeps the pressed word when the drag turns back past it", async ({ page }) => {
  const frame = await openPaginatedChapter(page);
  await settleOnPage(frame, 2);
  const result = await frame.locator("html").evaluate(() => {
    const press = longPressWord(1);
    const earlier = press.words[0]!;
    touchAt("pointermove", earlier.x, earlier.y);
    const selection = getSelection()!;
    const anchor = document.createRange();
    anchor.setStart(selection.anchorNode!, selection.anchorOffset);
    anchor.collapse(true);
    const focus = document.createRange();
    focus.setStart(selection.focusNode!, selection.focusOffset);
    focus.collapse(true);
    touchAt("pointerup", earlier.x, earlier.y);
    return {
      word: press.text,
      earlier: earlier.text,
      dragged: selection.toString(),
      anchorAfterFocus: anchor.compareBoundaryPoints(Range.START_TO_START, focus) > 0,
    };
  });
  expect(result.dragged.startsWith(result.earlier)).toBe(true);
  expect(result.dragged.endsWith(result.word)).toBe(true);
  expect(result.anchorAfterFocus).toBe(true);
});

test("shows the selection toolbar as soon as a long press lands, before the finger lifts", async ({
  page,
}) => {
  const frame = await openPaginatedChapter(page);
  await settleOnPage(frame, 2);
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await frame.locator("html").evaluate(() => {
    longPressWord();
  });
  // No dwell for the press itself: the toolbar is drawn while the finger is still down.
  await page.clock.runFor(100);
  await expect(selectionActions(page)).toBeVisible();
  await frame.locator("html").evaluate(() => {
    const press = lastLongPress();
    touchAt("pointerup", press.x + 2, press.y + 1);
  });
  await page.clock.runFor(100);
  await expect(selectionActions(page)).toBeVisible();
});

test("hides the toolbar while the finger drags on and shows it again at the next rest", async ({
  page,
}) => {
  const frame = await openPaginatedChapter(page);
  await settleOnPage(frame, 2);
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await frame.locator("html").evaluate(() => {
    longPressWord(0);
  });
  await page.clock.runFor(100);
  await expect(selectionActions(page)).toBeVisible();
  await frame.locator("html").evaluate(() => {
    const press = lastLongPress();
    const next = press.words[1]!;
    touchAt("pointermove", press.x + 2, press.y);
    touchAt("pointermove", next.x, next.y);
  });
  await page.clock.runFor(100);
  await expect(selectionActions(page)).toBeHidden();
  await page.clock.runFor(pastTouchDwell);
  await expect(selectionActions(page)).toBeVisible();
  const selected = await frame.locator("html").evaluate(() => getSelection()!.toString());
  const press = await frame.locator("html").evaluate(() => ({
    word: lastLongPress().text,
    next: lastLongPress().words[1]!.text,
  }));
  expect(selected.startsWith(press.word)).toBe(true);
  expect(selected.endsWith(press.next)).toBe(true);
});

test("a tap in a turn zone with a selection open clears it and turns in one go", async ({
  page,
}) => {
  const frame = await openPaginatedChapter(page);
  await settleOnPage(frame, 2);
  await frame.locator("html").evaluate(() => {
    const press = longPressWord();
    touchAt("pointerup", press.x + 2, press.y + 1);
  });
  await expect(selectionActions(page)).toBeVisible();
  const initial = await reader(page).getAttribute("data-section-first-visible-page");
  const box = (await publicationFrame(page).boundingBox())!;
  await page.touchscreen.tap(box.x + box.width * 0.9, box.y + box.height * 0.6);
  await expect(selectionActions(page)).toBeHidden();
  await expect(reader(page)).not.toHaveAttribute("data-section-first-visible-page", initial!);
  expect(await frame.locator("html").evaluate(() => getSelection()!.toString())).toBe("");
});

test("a quick lift before the browser reports the long press is not read as a handle drag", async ({
  page,
}) => {
  const frame = await openPaginatedChapter(page);
  await settleOnPage(frame, 2);
  await frame.locator("html").evaluate(() => {
    // The browser raises its menu and the finger lifts before the queued selection change
    // arrives, which is what a fast single-word selection looks like on a slow device.
    const first = visibleTextPosition("start");
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    walker.currentNode = first.node;
    let node: Node | null = first.node;
    let match: RegExpExecArray | null = null;
    let from = first.offset;
    for (; node !== null; node = walker.nextNode(), from = 0) {
      match = /[A-Za-z]{6,}/u.exec((node as Text).data.slice(from));
      if (match !== null) break;
    }
    if (node === null || match === null) throw new Error("no word");
    const text = node as Text;
    const start = from + match.index;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + match[0].length);
    const rect = range.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = {
      pointerId: 9,
      pointerType: "touch",
      isPrimary: true,
      clientX: x,
      clientY: y,
      bubbles: true,
    };
    window.dispatchEvent(new PointerEvent("pointerdown", { ...init, button: 0 }));
    document.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true }));
    window.dispatchEvent(new PointerEvent("pointerup", init));
    getSelection()!.setBaseAndExtent(text, start, text, start + match[0].length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(selectionActions(page)).toBeVisible();
  expect(await frame.locator("style[data-epub-navigator-hold]").count()).toBe(0);
  const initial = await reader(page).getAttribute("data-section-first-visible-page");
  const box = (await publicationFrame(page).boundingBox())!;
  await page.touchscreen.tap(box.x + box.width * 0.9, box.y + box.height * 0.6);
  await expect(selectionActions(page)).toBeHidden();
  await expect(reader(page)).not.toHaveAttribute("data-section-first-visible-page", initial!);
});
