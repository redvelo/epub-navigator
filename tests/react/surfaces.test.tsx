// @vitest-environment jsdom

import {
  createNavigatorRuntime,
  openQuickMenu,
  openReadingSettings,
  readerRegion,
  renderReader,
} from "./reader-harness.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { NavigatorReaderHandle } from "../../src/react/index.js";

describe("NavigatorReader responsive reader surfaces", () => {
  it("shows the host's window fullscreen in the quick menu without pinning the reader", async () => {
    const toggle = vi.fn();
    const { rerender } = await renderReader({
      profile: "compact",
      hostControls: { fullscreen: { active: false, toggle } },
    });
    const reader = readerRegion();
    const appearance = await openQuickMenu();
    fireEvent.click(within(appearance).getByRole("button", { name: "Enter fullscreen" }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(reader).not.toHaveAttribute("data-reader-fullscreen");
    await waitFor(() => expect(appearance).not.toBeInTheDocument());

    rerender({ profile: "compact", hostControls: { fullscreen: { active: true, toggle } } });
    const reopened = await openQuickMenu();
    expect(within(reopened).getByRole("button", { name: "Exit fullscreen" })).toBeInTheDocument();
    expect(reader).not.toHaveAttribute("data-reader-fullscreen");
  });

  it("offers no fullscreen when the host has none", async () => {
    await renderReader({ profile: "compact", hostControls: { fullscreen: null } });
    const appearance = await openQuickMenu();
    expect(within(appearance).queryByRole("button", { name: /fullscreen$/u })).toBeNull();
  });

  it("uses the compact profile with quick menu controls on a touch-primary pointer", async () => {
    const { runtime } = await renderReader({ profile: "compact" });
    const reader = readerRegion();
    expect(reader).toHaveAttribute("data-display-profile", "compact");
    expect(screen.queryByRole("toolbar", { name: "Reader controls" })).not.toBeInTheDocument();

    const appearance = await openQuickMenu();
    expect(within(appearance).getByRole("radiogroup", { name: "Book colors" })).toBeInTheDocument();
    expect(within(appearance).getByRole("button", { name: "Auto" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const scroll = within(appearance).getByRole("button", { name: "Scrolled" });
    fireEvent.click(scroll);
    await waitFor(() =>
      expect(runtime.setPresentationPreferences).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: "document-scroll" }),
      ),
    );
    expect(scroll).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(appearance).getByRole("button", { name: "Enter fullscreen" }));
    expect(reader).toHaveAttribute("data-reader-fullscreen", "true");
    await waitFor(() => expect(appearance).not.toBeInTheDocument());
    const reopened = await openQuickMenu();
    fireEvent.click(within(reopened).getByRole("button", { name: "Exit fullscreen" }));
    expect(reader).not.toHaveAttribute("data-reader-fullscreen");
    await waitFor(() => expect(reopened).not.toBeInTheDocument());

    const appearanceAgain = await openQuickMenu();
    fireEvent.click(within(appearanceAgain).getByRole("button", { name: /^Settings$/u }));
    const settings = await screen.findByRole("dialog", { name: "Reading settings" });
    expect(within(settings).getByRole("radio", { name: "Scrolled" })).toBeChecked();
    fireEvent.click(within(settings).getByRole("radio", { name: "Paginated" }));
    await waitFor(() =>
      expect(runtime.setPresentationPreferences).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: "paginated" }),
      ),
    );
  });

  it("exposes the workspace controls and curated publication details", async () => {
    const { runtime } = await renderReader({ profile: "workspace" });
    act(() => runtime.commit(0));

    const toolbar = screen.getByRole("toolbar", { name: "Reader controls" });
    expect(within(toolbar).getByRole("button", { name: "Navigation" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Annotations" })).toBeInTheDocument();
    const appearance = await openQuickMenu();
    fireEvent.click(within(appearance).getByRole("button", { name: "Publication details" }));
    const details = await screen.findByRole("dialog", { name: "Publication details" });
    for (const text of [
      "Ada Reader",
      "Identifier",
      "urn:book:small",
      "A compact test publication.",
    ]) {
      expect(within(details).getByText(text)).toBeInTheDocument();
    }
    expect(within(details).getAllByRole("heading", { name: "A Small Book" })).toHaveLength(1);
    expect(within(details).getByRole("region", { name: "Description" })).toHaveTextContent(
      "A compact test publication.",
    );
    expect(within(details).getByRole("img", { name: "A Small Book cover" })).toHaveAttribute(
      "src",
      "https://reader.invalid/books/book/EPUB/images/front%20cover.svg",
    );
    expect(within(details).queryByText("Not shown in curated details")).not.toBeInTheDocument();
  });

  it.each(["compact", "workspace"] as const)(
    "renders host controls in the %s quick menu and settings surface",
    async (profile) => {
      await renderReader({
        profile,
        hostControls: {
          quickMenu: <button type="button">Front light quick</button>,
          deviceSettings: <button type="button">Front light settings</button>,
        },
      });

      const appearance = await openQuickMenu();
      expect(
        within(appearance).getByRole("button", { name: "Front light quick" }),
      ).toBeInTheDocument();
      fireEvent.click(within(appearance).getByRole("button", { name: /^Settings$/u }));

      const settings = await screen.findByRole("dialog", { name: "Reading settings" });
      expect(within(settings).getByRole("heading", { name: "Device" })).toBeInTheDocument();
      expect(
        within(settings).getByRole("button", { name: "Front light settings" }),
      ).toBeInTheDocument();
    },
  );

  it("reports controlled workspace panel changes without replacing the runtime", async () => {
    const onWorkspaceStateChange = vi.fn();
    const workspaceState = {
      navigation: { open: false, pinned: false, width: 240 },
      annotations: { open: false, pinned: false, width: 360 },
    };
    const props = { profile: "workspace" as const, onWorkspaceStateChange };
    const { rerender } = await renderReader({ ...props, workspaceState });

    fireEvent.click(screen.getByRole("button", { name: "Navigation" }));
    const navigationOpen = {
      ...workspaceState,
      navigation: { ...workspaceState.navigation, open: true },
    };
    expect(onWorkspaceStateChange).toHaveBeenCalledWith(navigationOpen);
    rerender({ ...props, workspaceState: navigationOpen });
    expect(await screen.findByRole("dialog", { name: "Navigation" })).toHaveStyle({
      inlineSize: "240px",
    });
    rerender({
      ...props,
      workspaceState: {
        ...workspaceState,
        annotations: { ...workspaceState.annotations, open: true },
      },
    });
    expect(await screen.findByRole("dialog", { name: "Annotations" })).toHaveStyle({
      inlineSize: "360px",
    });
    expect(createNavigatorRuntime).toHaveBeenCalledOnce();
  });

  it("closes profile-specific transient surfaces without replacing the session", async () => {
    const { rerender } = await renderReader({ profile: "compact" });
    await openQuickMenu();

    rerender({ profile: "workspace" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Quick Menu" })).not.toBeInTheDocument(),
    );
    expect(createNavigatorRuntime).toHaveBeenCalledOnce();
  });
});

it("leaves the topmost surface on request, and says whether there was one", async () => {
  const reader = createRef<NavigatorReaderHandle>();
  await renderReader({ profile: "compact", ref: reader });

  expect(reader.current!.dismissSurface()).toBe(false);

  await openReadingSettings();

  // Reading settings was opened from quick menu, so leaving it returns there.
  expect(reader.current!.dismissSurface()).toBe(true);
  await waitFor(() =>
    expect(screen.getByRole("dialog", { name: "Quick Menu" })).toBeInTheDocument(),
  );

  // Quick menu was reached from the publication, so leaving it dismisses.
  expect(reader.current!.dismissSurface()).toBe(true);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(reader.current!.dismissSurface()).toBe(false);
});

it("offers each interaction preference only where that kind of input exists", async () => {
  const { rerender } = await renderReader({ profile: "workspace" });
  const workspace = await openReadingSettings();
  expect(within(workspace).getByRole("radiogroup", { name: "Keyboard" })).toBeInTheDocument();
  expect(
    within(workspace).getByRole("switch", { name: "Click edges to turn pages" }),
  ).toBeInTheDocument();
  expect(within(workspace).queryByRole("switch", { name: "Touch zones" })).not.toBeInTheDocument();

  rerender({ profile: "compact" });

  const compact = await openReadingSettings();
  expect(within(compact).getByRole("switch", { name: "Touch zones" })).toBeInTheDocument();
  expect(within(compact).queryByRole("radiogroup", { name: "Keyboard" })).not.toBeInTheDocument();
  expect(
    within(compact).queryByRole("switch", { name: "Click edges to turn pages" }),
  ).not.toBeInTheDocument();
});
