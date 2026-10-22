// @vitest-environment jsdom

import {
  createNavigatorRuntime,
  openNavigation,
  openQuickMenu,
  openReadingSettings,
  publication,
  readerRegion,
  readerSession,
  renderReader,
  transition,
} from "./reader-harness.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NavigatorError } from "../../src/runtime.js";

describe("NavigatorReader status, fixed view, and authored navigation", () => {
  it("presents opening, reading, progress, color scheme, and replacement state", async () => {
    const { runtime } = await renderReader();
    await waitFor(() => expect(screen.getByText("Opening publication")).toBeInTheDocument());

    act(() => runtime.commit(0));
    const settings = await openReadingSettings();
    fireEvent.click(
      within(within(settings).getByRole("radiogroup", { name: "Interface colors" })).getByRole(
        "radio",
        { name: "Dark" },
      ),
    );
    expect(readerRegion()).toHaveClass("dark");
    expect(runtime.setPresentationPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ colorScheme: "dark" }),
    );
    fireEvent.click(within(settings).getByRole("button", { name: "Close reading settings" }));

    act(() => runtime.observePagination(0, 3, 1));
    expect(screen.getByText("21%")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show Chapter one in contents" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Section pages 1 of 3")).toBeInTheDocument();

    act(() => runtime.interact("next"));
    expect(runtime.next).toHaveBeenCalledOnce();
    expect(readerRegion()).toHaveAttribute("data-reader-state", "replacement-pending");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Loading"));
  });

  it("projects structural adapter settlement and unavailable issue states", async () => {
    const { runtime } = await renderReader();
    const reader = readerRegion();

    act(() => runtime.commit(0, "fixed-xhtml"));
    expect(reader).toHaveAttribute("data-document-adapter", "fixed-xhtml");
    expect(reader).toHaveAttribute("data-presentation-mode", "fixed");
    expect(reader).toHaveAttribute("data-layout-settlement", "contain");
    expect(reader).not.toHaveAttribute("data-layout-issue");
    expect(reader).toHaveAttribute("data-reader-state", "reading");

    act(() =>
      runtime.makeFirstOccurrenceUnavailable({
        state: "unavailable",
        resource: "EPUB/chapter-1.svg",
        adapter: "fixed-svg",
        reason: "document-adapter-unavailable",
      }),
    );
    expect(reader).toHaveAttribute("data-document-adapter", "fixed-svg");
    expect(reader).toHaveAttribute("data-layout-settlement", "unavailable");
    expect(reader).toHaveAttribute("data-layout-issue", "document-adapter-unavailable");

    act(() =>
      runtime.makeFirstOccurrenceUnavailable({
        state: "unavailable",
        resource: "EPUB/chapter-1.xhtml",
        adapter: null,
        reason: "manifest-fallback-exhausted",
      }),
    );
    expect(reader).not.toHaveAttribute("data-document-adapter");
    expect(reader).toHaveAttribute("data-layout-settlement", "unavailable");
    expect(reader).toHaveAttribute("data-layout-issue", "manifest-fallback-exhausted");
  });

  it.each([
    ["workspace", "fixed-xhtml"],
    ["compact", "fixed-svg"],
  ] as const)("offers bounded zoom controls in %s chrome for %s", async (profile, adapter) => {
    const { runtime } = await renderReader({ profile });
    const zoomControls = () => screen.queryByRole("toolbar", { name: "Fixed page zoom controls" });

    act(() => runtime.commit(0, adapter));
    expect(zoomControls()).not.toBeInTheDocument();
    const appearance = await openQuickMenu();
    fireEvent.click(within(appearance).getByRole("button", { name: "Adjust fixed-page zoom" }));
    const toolbar = await screen.findByRole("toolbar", { name: "Fixed page zoom controls" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(within(toolbar).getByRole("button", { name: "Zoom in" }));
    expect(runtime.setFixedZoom).toHaveBeenLastCalledWith(1.25, undefined);
    const reset = within(toolbar).getByRole("button", { name: "Reset zoom to fit" });
    expect(reset).toHaveTextContent("125%");
    fireEvent.click(reset);
    expect(runtime.setFixedZoom).toHaveBeenLastCalledWith(1, undefined);

    act(() => runtime.commit(0));
    expect(zoomControls()).not.toBeInTheDocument();
  });

  it("keeps a synchronously promoted prepared section out of loading state", async () => {
    const { runtime } = await renderReader();
    act(() => runtime.commit(0));
    runtime.next.mockImplementationOnce(() => {
      runtime.commit(1);
      return transition([]);
    });

    act(() => runtime.interact("next"));

    expect(readerRegion()).toHaveAttribute("data-reader-state", "reading");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show Chapter two in contents" }),
    ).toBeInTheDocument();

    act(() => runtime.setPreparedLayoutPending());
    expect(readerRegion()).toHaveAttribute("data-reader-status", "ready");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps failed TOC targets visible, keeps expansion through updates, and navigates", async () => {
    const { runtime } = await renderReader();
    act(() => runtime.commit(0));
    await openNavigation();

    const unavailable = screen.getByRole("button", { name: "Unavailable" });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveAccessibleDescription("No destination was provided");

    const part = screen.getByRole("button", { name: "Toggle Part one" });
    expect(part).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(part);
    expect(part).toHaveAttribute("aria-expanded", "false");
    act(() => runtime.observePagination(1, 3, 1));
    expect(part).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(part);
    fireEvent.click(screen.getByRole("button", { name: "Chapter two" }));
    expect(runtime.open).toHaveBeenLastCalledWith(1);
  });

  it("disables a resolved navigation target without a usable local resource", async () => {
    const mounted = publication(true);
    mounted.facts.resources.resources[1]!.address = {
      kind: "remote",
      value: "https://example.invalid/chapter-2.xhtml",
    } as never;
    const { runtime } = await renderReader({ session: readerSession(mounted) });
    act(() => runtime.commit(0));
    await openNavigation();

    const chapter = screen.getByRole("button", { name: "Chapter two" });
    expect(chapter).toBeDisabled();
    expect(chapter).toHaveAccessibleDescription(
      "The destination resource cannot be opened by this reader",
    );
  });

  it.each(["compact", "workspace"] as const)(
    "marks page-count measurement quietly in %s chrome and never reports coverage as an issue",
    async (profile) => {
      const { runtime } = await renderReader({ profile });
      act(() => runtime.commit(0));
      const measuring = () => screen.queryByTitle("Measuring pages");
      act(() =>
        runtime.paginate({
          ...runtime.paginationValue,
          activity: "enriching-toc",
          pageCountCoverage: { ...runtime.paginationValue.pageCountCoverage, state: "exact" },
          tocEnrichment: { state: "pending", measuredTargets: 0, totalTargets: 1 },
        }),
      );
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(measuring()).not.toBeInTheDocument();

      act(() =>
        runtime.paginate({
          ...runtime.paginationValue,
          activity: "measuring-pages",
          pageCountCoverage: { ...runtime.paginationValue.pageCountCoverage, state: "incomplete" },
        }),
      );
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(readerRegion()).toHaveAttribute("data-reader-status", "ready");
      expect(readerRegion()).toHaveAttribute("data-reader-measuring", "true");
      expect(measuring()).toHaveAttribute("aria-hidden", "true");

      act(() =>
        runtime.paginate({
          ...runtime.paginationValue,
          activity: "idle",
          pageCountCoverage: { ...runtime.paginationValue.pageCountCoverage, state: "unavailable" },
        }),
      );
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(readerRegion()).not.toHaveAttribute("data-reader-measuring");
      expect(measuring()).not.toBeInTheDocument();
    },
  );

  it("records the controller publication consumed by each reader render", async () => {
    const record = vi.fn();
    const { runtime } = await renderReader({ diagnostics: { level: "trace", record } });
    act(() => runtime.commit(0));
    act(() => runtime.paginate({ ...runtime.paginationValue, publicationSequence: 7 }));

    await waitFor(() =>
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "reader-render",
          publicationSequence: 7,
          stateRevision: runtime.value.stateRevision,
        }),
      ),
    );
  });

  it("forwards updated diagnostics without replacing the session runtime", async () => {
    const nextRecord = vi.fn();
    const { rerender } = await renderReader({ diagnostics: { level: "trace", record: vi.fn() } });
    const { diagnostics } = createNavigatorRuntime.mock.calls[0]![0];

    rerender({ diagnostics: { level: "trace", record: nextRecord } });
    const event = {
      type: "controller-update" as const,
      sequence: 1,
      stateRevision: 2,
      documentPending: false,
      layoutOwner: null,
    };
    diagnostics.record(event);

    expect(nextRecord).toHaveBeenCalledWith(event);
    expect(createNavigatorRuntime).toHaveBeenCalledOnce();
  });

  it("does not clear a terminal runtime error on a later document commit", async () => {
    const { runtime } = await renderReader();

    act(() => {
      runtime.errors.emit(
        new NavigatorError({
          code: "resource-read-failed",
          message: "terminal runtime failure",
          path: "EPUB/chapter-1.xhtml",
        }),
      );
      runtime.commit(0);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("terminal runtime failure");
    expect(readerRegion()).toHaveAttribute("data-reader-state", "terminal-error");
  });

  it("shows host pagination capability acquisition and failure", async () => {
    const { runtime, rerender } = await renderReader({
      profile: "compact",
      paginationAvailability: "pending",
    });
    await waitFor(() => expect(readerRegion()).toHaveAttribute("data-reader-status", "loading"));
    act(() => runtime.commit(0));
    expect(readerRegion()).toHaveAttribute("data-reader-status", "ready");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender({ profile: "compact", paginationAvailability: "unavailable" });
    expect(screen.getByRole("status")).toHaveTextContent("Issue");
  });
});
