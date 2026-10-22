// @vitest-environment jsdom

import {
  createNavigatorRuntime,
  FakeRuntime,
  publication,
  readerRegion,
  readerSession,
  searchCapabilities,
  setReaderProfile,
} from "./reader-harness.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MountedPublication } from "../../src/publication.js";
import { NavigatorReader } from "../../src/react/index.js";

function namedSession(title: string, contentOrigin: MountedPublication["mount"]["contentOrigin"]) {
  const mounted = publication();
  (mounted.facts.package.metadata as unknown as { title: { content: string }[] }).title = [
    { content: title },
  ];
  return readerSession({ ...mounted, mount: { ...mounted.mount, contentOrigin } });
}

function twoRuntimes() {
  const runtimes = [new FakeRuntime(), new FakeRuntime()] as const;
  createNavigatorRuntime.mockResolvedValueOnce(runtimes[0]).mockResolvedValueOnce(runtimes[1]);
  return runtimes;
}

async function openSearch(reader: HTMLElement) {
  fireEvent.click(within(reader).getByRole("button", { name: "Open navigation" }));
  const navigation = await within(reader).findByRole("dialog", { name: "Navigation" });
  fireEvent.click(within(navigation).getByRole("button", { name: "Search publication" }));
  return within(reader).getByRole("searchbox", { name: "Search publication" });
}

describe("NavigatorReader scoped state", () => {
  it("keeps surfaces and search queries scoped while independently closing runtimes", async () => {
    setReaderProfile("compact");
    const [firstRuntime, secondRuntime] = twoRuntimes();
    const first = namedSession("First Book", "shared-reader-origin");
    const second = namedSession("Second Book", "isolated-publication-origin");
    const secondSearch = searchCapabilities();
    const secondReaderElement = (
      <NavigatorReader key="second" session={second} search={secondSearch} />
    );
    const { rerender } = render(
      <>
        <NavigatorReader key="first" session={first} search={searchCapabilities()} />
        {secondReaderElement}
      </>,
    );
    await waitFor(() => {
      expect(firstRuntime.open).toHaveBeenCalledWith(0);
      expect(secondRuntime.open).toHaveBeenCalledWith(0);
    });

    const firstReader = readerRegion("First Book");
    const secondReader = readerRegion("Second Book");
    const firstQuery = await openSearch(firstReader);
    expect(within(secondReader).queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.change(firstQuery, { target: { value: "first-only query" } });
    // Search returns to navigation, and navigation closes, each surface naming its own exit.
    fireEvent.click(within(firstReader).getByRole("button", { name: "Back to navigation" }));
    fireEvent.click(await within(firstReader).findByRole("button", { name: "Close navigation" }));
    await waitFor(() => expect(within(firstReader).queryByRole("dialog")).not.toBeInTheDocument());
    expect(await openSearch(secondReader)).toHaveValue("");

    rerender(secondReaderElement);
    await waitFor(() => expect(firstRuntime.close).toHaveBeenCalledOnce());
    expect(secondRuntime.close).not.toHaveBeenCalled();
    expect(createNavigatorRuntime).toHaveBeenCalledTimes(2);
    const remainingReader = readerRegion("Second Book");
    expect(within(remainingReader).getByRole("dialog", { name: "Search" })).toBeInTheDocument();
    expect(
      within(remainingReader).getByRole("searchbox", { name: "Search publication" }),
    ).toHaveValue("");
  });

  it("contains dialog portals in their owning reader and removes them on close", async () => {
    setReaderProfile("compact");
    twoRuntimes();
    render(
      <>
        <NavigatorReader session={namedSession("First Book", "shared-reader-origin")} />
        <NavigatorReader session={namedSession("Second Book", "isolated-publication-origin")} />
      </>,
    );
    await waitFor(() => expect(createNavigatorRuntime).toHaveBeenCalledTimes(2));

    const firstReader = readerRegion("First Book");
    const secondReader = readerRegion("Second Book");
    fireEvent.click(within(firstReader).getByRole("button", { name: "Open quick menu" }));
    const dialog = await within(firstReader).findByRole("dialog", { name: "Quick Menu" });
    expect(secondReader).not.toContainElement(dialog);
    expect(within(secondReader).queryByRole("dialog")).not.toBeInTheDocument();

    // Quick menu leaves the publication in view, so the page behind it dismisses it.
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("resets publication surfaces while retaining uncontrolled workspace and preferences", async () => {
    const [firstRuntime, secondRuntime] = twoRuntimes();
    const { rerender } = render(
      <NavigatorReader session={namedSession("First Book", "shared-reader-origin")} />,
    );
    await waitFor(() => expect(firstRuntime.open).toHaveBeenCalledWith(0));

    const toolbar = screen.getByRole("toolbar", { name: "Reader controls" });
    const navigationButton = within(toolbar).getByRole("button", { name: "Navigation" });
    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Open quick menu for First Book" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Increase text size" }));
    expect(screen.getByText("110%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Settings$/u }));
    await screen.findByRole("dialog", { name: "Reading settings" });
    fireEvent.click(navigationButton);
    expect(navigationButton).toHaveAttribute("aria-pressed", "true");

    rerender(
      <NavigatorReader session={namedSession("Second Book", "isolated-publication-origin")} />,
    );
    await waitFor(() => expect(secondRuntime.open).toHaveBeenCalledWith(0));
    await waitFor(() => expect(firstRuntime.close).toHaveBeenCalledOnce());

    expect(screen.queryByRole("dialog", { name: "Reading settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close navigation panel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open quick menu for Second Book" }));
    expect(await screen.findByText("110%")).toBeInTheDocument();
    expect(createNavigatorRuntime).toHaveBeenCalledTimes(2);
  });
});
