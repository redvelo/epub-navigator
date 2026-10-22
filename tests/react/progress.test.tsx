// @vitest-environment jsdom

import {
  exactPagination,
  measurement,
  openNavigation,
  publication,
  publicationWithPageList,
  readerRegion,
  readerSession,
  renderReader,
} from "./reader-harness.js";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NavigatorRuntime } from "../../src/runtime/navigator/api.js";

const readingProgress = () => screen.getByRole("progressbar", { name: "Reading progress" });
const publicationPage = () => screen.getByLabelText(/^Publication pages? /u);

describe("NavigatorReader reader progress and authored pages", () => {
  it("renders exact TOC pages from occurrence prefix sums", async () => {
    const { runtime } = await renderReader();
    act(() => {
      runtime.commit(0);
      runtime.paginate({
        ...exactPagination([5, 4]),
        tocEnrichment: { state: "pending", measuredTargets: 0, totalTargets: 1 },
      });
    });
    const dialog = await openNavigation();
    const page = (chapter: string) =>
      within(within(dialog).getByRole("button", { name: new RegExp(chapter, "u") }));
    expect(page("Chapter one").getByText("1")).toBeInTheDocument();
    expect(page("Chapter two").getByText("6")).toBeInTheDocument();

    act(() =>
      runtime.paginate({ ...runtime.paginationValue, freshness: "stale", activity: "paused" }),
    );
    expect(within(dialog).getAllByLabelText("Page pending")).toHaveLength(2);
  });

  it("positions a spread at its first visible physical page", async () => {
    const { runtime } = await renderReader();
    act(() => {
      runtime.commit(0);
      runtime.observePagination(2, 5, 2);
      runtime.settleLayout({ status: "no-issues-detected" }, "paginated", 5);
      runtime.paginate(exactPagination([5, 4], 0));
    });

    expect(screen.getByText("3-4 / 9")).toBeInTheDocument();
    expect(readingProgress()).toHaveAttribute(
      "aria-valuetext",
      "Exact progress, pages 3 to 4 of 9",
    );
  });

  it("recomputes exact progress when physical companion activation leaves the snapshot unchanged", async () => {
    const { runtime } = await renderReader({ profile: "compact" });
    act(() => {
      runtime.commit(0, "fixed-xhtml");
      runtime.paginate(exactPagination([1, 1], 0));
    });

    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(readingProgress()).toHaveAttribute("aria-valuetext", "Exact progress, page 1 of 2");
    expect(screen.getByLabelText("Section pages 1 of 1")).toBeInTheDocument();

    const snapshotBeforeActivation = runtime.snapshot();
    act(() => void runtime.attachFixedCompanion(1, 2, "right"));
    expect(runtime.snapshot()).toBe(snapshotBeforeActivation);
    expect(screen.getByText("1-2 / 2")).toBeInTheDocument();
    expect(readingProgress()).toHaveAttribute(
      "aria-valuetext",
      "Exact progress, pages 1 to 2 of 2",
    );
    expect(screen.getByLabelText("Section pages 1 of 1")).toBeInTheDocument();

    act(() => void runtime.detachFixedCompanion(1, 2));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(readingProgress()).toHaveAttribute("aria-valuetext", "Exact progress, page 1 of 2");
  });

  it("shows exact authored document pages in the top rail while preserving rendered section pages", async () => {
    const mounted = publicationWithPageList([
      { label: "37", chapter: 1 },
      { label: "38", chapter: 2 },
    ]);
    const { runtime } = await renderReader({
      session: readerSession(mounted),
      profile: "compact",
    });

    act(() => runtime.commit(0, "fixed-xhtml"));
    expect(publicationPage()).toHaveAccessibleName("Publication page 37");
    expect(publicationPage()).toHaveTextContent("p. 37");
    expect(screen.getByLabelText("Section pages 1 of 1")).toBeInTheDocument();

    act(() => void runtime.attachFixedCompanion(1, 2, "right"));
    expect(publicationPage()).toHaveAccessibleName("Publication page 37");
    expect(screen.getByLabelText("Section pages 1 of 1")).toBeInTheDocument();
  });

  it("measures fragment pages once per layout and follows the visible page locally", async () => {
    const mounted = publicationWithPageList([
      { label: "37", chapter: 1, fragment: "page_37" },
      { label: "38", chapter: 1, fragment: "page_38" },
    ]);
    const { runtime } = await renderReader({
      session: readerSession(mounted),
      profile: "compact",
    });
    runtime.measureTocTargets.mockImplementation(async (targets) =>
      targets.map((target) => ({
        listIndex: target.listIndex,
        pointPath: target.pointPath,
        result: { state: "located", physicalPage: target.pointPath[0] === 0 ? 0 : 1 },
      })),
    );

    act(() => runtime.commit(0));

    await waitFor(() => expect(runtime.measureTocTargets).toHaveBeenCalledOnce());
    expect(runtime.measureTocTargets.mock.calls[0]?.[0]).toEqual([
      { listIndex: 1, pointPath: [0], evidence: [{ kind: "html-fragment", value: "page_37" }] },
      { listIndex: 1, pointPath: [1], evidence: [{ kind: "html-fragment", value: "page_38" }] },
    ]);
    await waitFor(() => expect(publicationPage()).toHaveAccessibleName("Publication page 37"));
    expect(screen.getByLabelText("Section pages 1 of 1")).toBeInTheDocument();

    act(() => runtime.paginate({ ...exactPagination([18]), runRevision: 2 }));
    expect(publicationPage()).toHaveAccessibleName("Publication page 37");

    act(() => runtime.observePagination(1, 2, 1));
    expect(publicationPage()).toHaveAccessibleName("Publication page 38");

    act(() => runtime.observePagination(0, 2, 2));
    expect(publicationPage()).toHaveTextContent("p. 37-38");
    expect(publicationPage()).toHaveAccessibleName("Publication pages 37 to 38");

    act(() => void runtime.publish());
    expect(publicationPage()).toHaveAccessibleName("Publication pages 37 to 38");
    expect(runtime.measureTocTargets).toHaveBeenCalledOnce();
  });

  it("keeps authored pagination at a document prefix while its first marker resolves", async () => {
    const mounted = publicationWithPageList([
      { label: "xi", chapter: 1, fragment: "page_xi" },
      { label: "1", chapter: 2, fragment: "page_1" },
      { label: "2", chapter: 2, fragment: "page_2" },
    ]);
    const { runtime } = await renderReader({
      session: readerSession(mounted),
      profile: "compact",
    });
    let resolveMeasurement!: (
      value: Awaited<ReturnType<NavigatorRuntime["measureTocTargets"]>>,
    ) => void;
    runtime.measureTocTargets.mockImplementation(
      () => new Promise((resolve) => (resolveMeasurement = resolve)),
    );

    act(() => runtime.commit(1));

    await waitFor(() => expect(runtime.measureTocTargets).toHaveBeenCalledOnce());
    expect(publicationPage()).toHaveAccessibleName("Publication page xi");

    act(() =>
      resolveMeasurement([
        { listIndex: 1, pointPath: [1], result: { state: "located", physicalPage: 0 } },
        { listIndex: 1, pointPath: [2], result: { state: "located", physicalPage: 3 } },
      ]),
    );
    await waitFor(() => expect(publicationPage()).toHaveAccessibleName("Publication page 1"));
  });

  it("keeps UI direction independent while projecting RTL vertical progress", async () => {
    const mounted = publication();
    mounted.facts.resources.readingOrder[0]!.presentation.pageProgressionDirection = "rtl";
    const { runtime } = await renderReader({
      session: readerSession(mounted),
      profile: "compact",
    });
    act(() => {
      runtime.commit(0);
      const committed = runtime.value.document.committed!;
      const settlement = committed.layout.layout.settlement;
      if (settlement.adapter !== "reflowable-xhtml") throw new Error("reflowable layout required");
      const observation = { ...committed.layout.observation, writingMode: "vertical-rl" as const };
      runtime.value = {
        ...runtime.value,
        document: {
          ...runtime.value.document,
          committed: {
            ...committed,
            layout: {
              ...committed.layout,
              observation,
              layout: {
                ...committed.layout.layout,
                settlement: {
                  ...settlement,
                  settlement: { ...settlement.settlement, measurement: measurement(observation) },
                },
              },
            },
          },
        },
      };
      runtime.observePagination(0, 3, 1);
    });

    const reader = readerRegion();
    expect(reader).not.toHaveAttribute("dir");
    expect(reader).toHaveAttribute("data-page-progression", "rtl");
    expect(reader).toHaveAttribute("data-writing-mode", "vertical-rl");
    expect(readingProgress()).toHaveAttribute("aria-valuetext", "Estimated progress, 21 percent");
    expect(readingProgress().querySelector("i")).toHaveStyle({ insetInlineStart: "79%" });
  });
});
