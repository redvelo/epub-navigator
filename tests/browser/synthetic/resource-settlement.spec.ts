import { expect, test } from "@playwright/test";
import { runScenario } from "./agent-scenario.js";

test("settles font and image resources within the layout deadline", async ({ page }) => {
  const result = await runScenario(
    page,
    async ({ addFont, addImage, addStylesheet, layout, release, messages, quiesce }) => {
      addFont("fast-font");
      addImage("fast-image");
      addStylesheet("fast-stylesheet");
      const pending = layout(1);
      await Promise.all([release("fast-font"), release("fast-image"), release("fast-stylesheet")]);
      const settled = await pending;
      await quiesce();
      return {
        settled,
        invalidations: messages.filter((message) => message.type === "layout-invalidated").length,
      };
    },
  );

  expect(result.settled).toMatchObject({
    result: {
      adapter: "reflowable-xhtml",
      outcome: {
        status: "settled",
        settlement: { measurement: { requiredFonts: "loaded", requiredResources: "loaded" } },
      },
    },
  });
  expect(result.invalidations).toBe(0);
});

test("bounds settlement and invalidates once when an image completes after the deadline", async ({
  page,
}) => {
  const result = await runScenario(
    page,
    async ({ addImage, layout, release, messages, quiesce, waitFor }) => {
      addImage("late-image");
      const started = performance.now();
      const settled = await layout(1);
      const elapsed = performance.now() - started;
      await release("late-image");
      await waitFor(() => messages.some((message) => message.type === "layout-invalidated"));
      await quiesce();
      return {
        settled,
        elapsed,
        invalidations: messages.filter((message) => message.type === "layout-invalidated").length,
      };
    },
  );

  expect(result.settled).toMatchObject({
    result: {
      outcome: {
        status: "settled",
        settlement: { measurement: { requiredResources: "timed-out" } },
      },
    },
  });
  expect(result.elapsed).toBeLessThan(1_200);
  expect(result.invalidations).toBe(1);
});

test("does not wait on stylesheet links the browser will never load", async ({ page }) => {
  const result = await runScenario(page, async ({ addMarkup, layout }) => {
    addMarkup(
      `<link rel="stylesheet" type="application/vnd.adobe-page-template+xml" href="page-template.xpgt"/>` +
        `<link rel="stylesheet" href="/_epub-navigator/gated-resource?kind=stylesheet&amp;id=never" disabled="disabled"/>` +
        `<link rel="stylesheet" href=""/>`,
      "head",
    );
    const started = performance.now();
    const settled = await layout(1);
    return { settled, elapsed: performance.now() - started };
  });
  expect(result.settled).toMatchObject({
    result: {
      outcome: { status: "settled", settlement: { measurement: { requiredResources: "loaded" } } },
    },
  });
  expect(result.elapsed).toBeLessThan(800);
});

test("fetches unsized lazy images and leaves sized ones lazy", async ({ page }) => {
  const result = await runScenario(page, async ({ frame, gated, addMarkup, layout, release }) => {
    const source = (id: string) => gated("image", id).replace("&", "&amp;");
    addMarkup(
      `<div style="height:5000px"></div>` +
        `<img id="lazy-unsized" loading="lazy" src="${source("lazy-unsized")}"/>` +
        `<img id="lazy-sized" loading="lazy" width="10" height="10" src="${source("lazy-sized")}"/>`,
    );
    const pending = layout(1);
    await release("lazy-unsized");
    const settled = await pending;
    const content = frame.contentDocument;
    return {
      settled,
      unsizedLoading: content?.getElementById("lazy-unsized")?.getAttribute("loading"),
      sizedLoading: (content?.getElementById("lazy-sized") as HTMLImageElement | null)?.loading,
      unsizedComplete: (content?.getElementById("lazy-unsized") as HTMLImageElement | null)
        ?.complete,
    };
  });
  expect(result.settled).toMatchObject({
    result: {
      outcome: { status: "settled", settlement: { measurement: { requiredResources: "loaded" } } },
    },
  });
  expect(result.unsizedComplete).toBe(true);
  expect(result.sizedLoading).toBe("lazy");
});

test("settles video that will not preload or has no usable source", async ({ page }) => {
  const noPreload = await runScenario(page, async ({ addMarkup, layout }) => {
    addMarkup(
      `<video preload="none" src="/_epub-navigator/gated-resource?kind=image&amp;id=never"></video>`,
    );
    const started = performance.now();
    const settled = await layout(1);
    return { settled, elapsed: performance.now() - started };
  });
  expect(noPreload.settled).toMatchObject({
    result: {
      outcome: { status: "settled", settlement: { measurement: { requiredResources: "loaded" } } },
    },
  });
  expect(noPreload.elapsed).toBeLessThan(800);

  const noSource = await runScenario(page, async ({ addMarkup, layout }) => {
    addMarkup(
      `<video><source src="/_epub-navigator/missing.mp4" type="video/mp4"/><source src="/_epub-navigator/missing.webm" type="video/webm"/></video>`,
    );
    return layout(1);
  });
  expect(noSource).toMatchObject({
    result: {
      outcome: { status: "settled", settlement: { measurement: { requiredResources: "failed" } } },
    },
  });
});

test("settles a large index after a delayed font completes in the same frame", async ({ page }) => {
  const result = await runScenario(
    page,
    async ({ frame, addFont, layout, release, messages, waitFor, delivered }) => {
      const content = frame.contentDocument;
      if (content?.body === null || content === null)
        throw new Error("fixture document unavailable");
      const index = content.createElement("nav");
      index.setAttribute("role", "doc-index");
      const fragment = content.createDocumentFragment();
      for (let entry = 0; entry < 1_200; entry += 1) {
        const paragraph = content.createElement("p");
        paragraph.textContent = `Index entry ${String(entry)} with several cross references`;
        fragment.append(paragraph);
      }
      index.append(fragment);
      content.body.append(index);
      addFont("large-index-font");

      const pending = layout(1, "paginated");
      await delivered();
      await release("large-index-font");
      const initial = await pending;
      if (initial.result?.outcome?.settlement?.measurement?.requiredFonts === "loaded")
        return initial;
      await waitFor(() => messages.some((message) => message.type === "layout-invalidated"));
      return layout(2, "paginated");
    },
  );

  expect(result).toMatchObject({
    result: {
      outcome: {
        status: "settled",
        settlement: { measurement: { requiredFonts: "loaded" } },
      },
    },
  });
});

test("removes resource settlement listeners after each deadline", async ({ page }) => {
  const result = await runScenario(page, async ({ frame, addImage, layout, release }) => {
    addImage("listener-timeout-image");
    const image = frame.contentDocument?.querySelector("img");
    if (image === null || image === undefined) throw new Error("the test image is unavailable");
    const active = new Set<EventListenerOrEventListenerObject>();
    const add = image.addEventListener.bind(image);
    const remove = image.removeEventListener.bind(image);
    image.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === "load" || type === "error") active.add(listener);
      add(type, listener, options);
    }) as typeof image.addEventListener;
    image.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === "load" || type === "error") active.delete(listener);
      remove(type, listener, options);
    }) as typeof image.removeEventListener;

    await layout(1);
    const afterFirst = active.size;
    await layout(2);
    const afterSecond = active.size;
    await release("listener-timeout-image");
    return { afterFirst, afterSecond };
  });

  expect(result).toEqual({ afterFirst: 0, afterSecond: 0 });
});

test("treats resource failure and update-transaction completion as terminal settlement", async ({
  page,
}) => {
  const result = await runScenario(
    page,
    async ({ addFont, addImage, layout, release, messages, clearMessages, delivered, quiesce }) => {
      const initial = await layout(1);
      clearMessages();
      const pending = layout(2);
      await delivered();
      addFont("failed-update-font");
      addImage("failed-update-image");
      await Promise.all([
        release("failed-update-font", true),
        release("failed-update-image", true),
      ]);
      const update = await pending;
      await quiesce();
      const repeatedStarted = performance.now();
      const repeated = await layout(3);
      const repeatedElapsed = performance.now() - repeatedStarted;
      return {
        initial,
        update,
        repeated,
        repeatedElapsed,
        invalidations: messages.filter((message) => message.type === "layout-invalidated").length,
      };
    },
  );

  expect(result.initial).toMatchObject({
    result: {
      outcome: {
        status: "settled",
        settlement: { measurement: { requiredFonts: "loaded", requiredResources: "loaded" } },
      },
    },
  });
  expect(result.update).toMatchObject({
    result: {
      outcome: {
        status: "settled",
        settlement: { measurement: { requiredFonts: "failed", requiredResources: "failed" } },
      },
    },
  });
  expect(result.repeated).toMatchObject({
    result: {
      outcome: {
        status: "settled",
        settlement: { measurement: { requiredFonts: "failed", requiredResources: "failed" } },
      },
    },
  });
  expect(result.repeatedElapsed).toBeLessThan(220);
  expect(result.invalidations).toBe(0);
});

test("rescans when replaced content settles after the geometry scan", async ({ page }) => {
  const result = await runScenario(
    page,
    async ({ addImage, layout, release, messages, waitFor }) => {
      addImage("post-scan-image");
      const pending = layout(1, "paginated");
      await waitFor(() =>
        messages.some(
          (message) => message.type === "pagination-diagnostic" && message.scanCount > 0,
        ),
      );
      await release("post-scan-image");
      const settled = await pending;
      return {
        settled,
        scans: messages
          .filter((message) => message.type === "pagination-diagnostic")
          .reduce((total, message) => total + (message.scanCount ?? 0), 0),
      };
    },
  );

  expect(result.settled).toMatchObject({ result: { outcome: { status: "settled" } } });
  expect(result.scans).toBeGreaterThanOrEqual(2);
});

test("terminates persistent publisher mutation without a relayout loop", async ({ page }) => {
  const result = await runScenario(page, async ({ frame, layout, messages, quiesce }) => {
    const root = frame.contentDocument?.documentElement;
    if (root === undefined) throw new Error("fixture document unavailable");
    const timer = setInterval(() => root.toggleAttribute("data-publisher-churn"), 5);
    const started = performance.now();
    const terminal = await layout(1);
    clearInterval(timer);
    const elapsed = performance.now() - started;
    await quiesce();
    return {
      terminal,
      elapsed,
      invalidations: messages.filter((message) => message.type === "layout-invalidated").length,
    };
  });

  expect(result.terminal).toMatchObject({ result: { outcome: { status: "unavailable" } } });
  expect(result.elapsed).toBeLessThan(1_200);
  expect(result.invalidations).toBe(0);
});

test("coalesces geometry changes and only invalidates for geometry-relevant configuration", async ({
  page,
}) => {
  const result = await runScenario(
    page,
    async ({ frame, layout, messages, clearMessages, configure, quiesce, waitFor }) => {
      await layout(1);
      clearMessages();
      const block = frame.contentDocument?.createElement("div");
      if (block === undefined) throw new Error("fixture document is unavailable");
      block.style.height = "20px";
      frame.contentDocument?.body.append(block);
      block.style.height = "80px";
      block.style.height = "120px";
      await waitFor(() => messages.some((message) => message.type === "layout-invalidated"));
      await quiesce();
      const resizeInvalidations = messages.filter(
        (message) => message.type === "layout-invalidated",
      ).length;

      await layout(2);
      clearMessages();
      configure({
        keyboardMode: "standard",
        touchZones: true,
        progressionDirection: "rtl",
        selectionMenu: "native",
      });
      await quiesce();
      const inputInvalidations = messages.filter(
        (message) => message.type === "layout-invalidated",
      ).length;
      configure(undefined, "hidden");
      await waitFor(() => messages.some((message) => message.type === "layout-invalidated"));
      await quiesce();
      const geometryConfigurationInvalidations = messages.filter(
        (message) => message.type === "layout-invalidated",
      ).length;
      return { resizeInvalidations, inputInvalidations, geometryConfigurationInvalidations };
    },
  );

  expect(result).toEqual({
    resizeInvalidations: 1,
    inputInvalidations: 0,
    geometryConfigurationInvalidations: 1,
  });
});

test("bounds completed-operation replay memory", async ({ page }) => {
  const result = await runScenario(page, async ({ request, messages, waitFor, quiesce }) => {
    for (let operation = 1_000; operation < 1_270; operation += 1) {
      const before = messages.length;
      request(operation, "resolve-locator", "locator-target");
      await waitFor(() => messages.length > before);
    }
    const beforeExpiredReplay = messages.length;
    request(1_000, "resolve-locator", "locator-target");
    await waitFor(() => messages.length > beforeExpiredReplay);
    const beforeRecentReplay = messages.length;
    request(1_269, "resolve-locator", "locator-target");
    await quiesce();
    return {
      expiredReplayAccepted: messages.length > beforeExpiredReplay,
      recentReplayIgnored: messages.length === beforeRecentReplay,
    };
  });

  expect(result).toEqual({ expiredReplayAccepted: true, recentReplayIgnored: true });
});

test("rolls back a relocation cancelled after scrolling", async ({ page }) => {
  const result = await runScenario(
    page,
    async ({ frame, layout, request, cancel, messages, waitFor, quiesce }) => {
      const content = frame.contentDocument;
      if (content?.body === null || content === null)
        throw new Error("fixture document unavailable");
      const target = content.createElement("p");
      target.id = "late-relocation-target";
      target.style.marginBlockStart = "3000px";
      target.textContent = "Late relocation target";
      content.body.append(target);
      await layout(1);
      const scrolling = content.scrollingElement;
      if (scrolling === null) throw new Error("fixture scrolling element unavailable");
      content.defaultView?.scrollTo(0, 0);
      let mutatedPosition = 0;
      content.defaultView?.addEventListener(
        "scroll",
        () => {
          mutatedPosition = Math.max(
            mutatedPosition,
            Math.abs(content.defaultView?.scrollY ?? scrolling.scrollTop),
          );
        },
        { passive: true },
      );
      const resultCount = messages.filter((message) => message.type === "result").length;
      request(900, "relocate", target.id);
      cancel(900, "relocate");
      await waitFor(() => Math.abs(content.defaultView?.scrollY ?? scrolling.scrollTop) < 1);
      await quiesce();
      return {
        mutatedPosition,
        finalPosition: content.defaultView?.scrollY ?? scrolling.scrollTop,
        reported: messages.filter((message) => message.type === "result").length > resultCount,
      };
    },
  );

  expect(result.mutatedPosition).toBeGreaterThan(0);
  expect(result.finalPosition).toBe(0);
  expect(result.reported).toBe(false);
});

test("rolls back nested scrolling after annotation relocation cancellation", async ({ page }) => {
  const result = await runScenario(
    page,
    async ({ frame, requestAnnotation, cancel, messages, waitFor, quiesce }) => {
      const content = frame.contentDocument;
      const view = content?.defaultView;
      if (content?.body === null || content === null || view == null)
        throw new Error("fixture document unavailable");
      const scroller = content.createElement("div");
      scroller.style.cssText = "block-size: 100px; overflow: auto";
      const spacer = content.createElement("div");
      spacer.style.blockSize = "1000px";
      const target = content.createElement("p");
      target.id = "nested-annotation-target";
      target.textContent = "Nested annotation target";
      scroller.append(spacer, target);
      content.body.append(scroller);
      scroller.scrollTop = 0;
      let mutatedPosition = 0;
      scroller.addEventListener(
        "scroll",
        () => {
          mutatedPosition = Math.max(mutatedPosition, scroller.scrollTop);
        },
        { passive: true },
      );
      view.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
      view.Range.prototype.getBoundingClientRect = () => new view.DOMRect();
      const resultCount = messages.filter((message) => message.type === "result").length;
      requestAnnotation(903, "relocate-annotation-target", "#nested-annotation-target");
      cancel(903, "relocate-annotation-target");
      await waitFor(() => mutatedPosition > 0 && scroller.scrollTop === 0);
      await quiesce();
      return {
        mutatedPosition,
        finalPosition: scroller.scrollTop,
        reported: messages.filter((message) => message.type === "result").length > resultCount,
      };
    },
  );

  expect(result.mutatedPosition).toBeGreaterThan(0);
  expect(result.finalPosition).toBe(0);
  expect(result.reported).toBe(false);
});

test("interrupts rendered-text TOC work and releases the agent queue", async ({ page }) => {
  const result = await runScenario(
    page,
    async ({
      frame,
      layout,
      requestToc,
      request,
      cancel,
      messages,
      waitFor,
      delivered,
      quiesce,
    }) => {
      const content = frame.contentDocument;
      if (content?.body === null || content === null)
        throw new Error("fixture document unavailable");
      const large = content.createElement("p");
      for (let chunk = 0; chunk < 200; chunk += 1) {
        large.append(content.createTextNode("alpha beta ".repeat(100)));
      }
      content.body.append(large);
      await layout(1, "paginated");
      const before = messages.filter((message) => message.type === "result").length;
      requestToc(901, [{ kind: "rendered-text-context", before: "alpha ", after: "beta" }]);
      await delivered();
      cancel(901, "measure-toc-targets");
      request(902, "resolve-locator", "locator-target");
      await waitFor(() =>
        messages.some((message) => message.type === "result" && message.operation === 902),
      );
      await quiesce();
      return {
        cancelledReported: messages.some(
          (message) => message.type === "result" && message.operation === 901,
        ),
        nextCompleted: messages.filter((message) => message.type === "result").length > before,
      };
    },
  );

  expect(result).toEqual({ cancelledReported: false, nextCompleted: true });
});

test("reports a boxless TOC fragment as unavailable instead of page zero", async ({ page }) => {
  const result = await runScenario(
    page,
    async ({ frame, layout, requestToc, messages, waitFor }) => {
      const content = frame.contentDocument;
      if (content?.body === null || content === null)
        throw new Error("fixture document unavailable");
      const target = content.createElement("div");
      target.id = "boxless-target";
      target.style.display = "none";
      content.body.append(target);
      await layout(1, "paginated");
      requestToc(903, [{ kind: "html-fragment", value: "boxless-target" }]);
      await waitFor(() =>
        messages.some((message) => message.type === "result" && message.operation === 903),
      );
      return messages.find((message) => message.type === "result" && message.operation === 903);
    },
  );

  expect(result).toMatchObject({
    resultType: "measure-toc-targets",
    results: [{ result: { state: "unavailable" } }],
  });
});

test("reader typography outranks publisher important rules without conflicting", async ({
  page,
}) => {
  const result = await runScenario(page, async ({ addMarkup, frame, layout }) => {
    addMarkup(
      `<style>section[data-type="titlepage"] p.author { text-align: center !important; }` +
        ` #authored p.byline { text-align: center !important; }</style>`,
      "head",
    );
    addMarkup(
      `<section data-type="titlepage"><p class="author" id="publisher-class">Author</p></section>` +
        `<div id="authored"><p class="byline" id="publisher-id">Byline</p></div>`,
    );
    const settled = await layout(1, "paginated", { alignment: "justify" });
    const textAlign = (id: string) => {
      const element = frame.contentDocument?.getElementById(id);
      if (element === null || element === undefined) throw new Error(`${id} is missing`);
      return frame.contentWindow?.getComputedStyle(element).textAlign;
    };
    return { settled, byClass: textAlign("publisher-class"), byId: textAlign("publisher-id") };
  });

  expect(result.settled).toMatchObject({ result: { outcome: { status: "settled" } } });
  expect(result.byClass).toBe("justify");
  expect(result.byId).toBe("center");
});

test("paginates a section whose publisher style constrains the root box", async ({ page }) => {
  const result = await runScenario(page, async ({ addMarkup, frame, layout }) => {
    addMarkup(
      "<style>html { margin: auto 1em; padding: 1em 0; max-height: 28em; max-width: 30em;" +
        " min-height: 90em; }</style>",
      "head",
    );
    addMarkup('<p id="authored">Authored text</p>');
    const settled = await layout(1, "paginated");
    const root = frame.contentDocument?.documentElement;
    if (root === null || root === undefined) throw new Error("fixture document is unavailable");
    const style = frame.contentWindow?.getComputedStyle(root);
    return {
      settled,
      height: style?.height,
      width: style?.width,
      viewport: `${frame.contentWindow?.innerWidth}px ${frame.contentWindow?.innerHeight}px`,
    };
  });

  expect(result.settled).toMatchObject({ result: { outcome: { status: "settled" } } });
  expect(`${result.width} ${result.height}`).toBe(result.viewport);
});
