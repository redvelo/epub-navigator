// @vitest-environment jsdom

import {
  createNavigatorRuntime,
  FakeRuntime,
  openNavigation,
  openQuickMenu,
  openReadingSettings,
  paginationCapabilities,
  publicationHost,
  readerPreferences,
  readerSession,
  renderReader,
  searchCapabilities,
} from "./reader-harness.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { NavigatorReader } from "../../src/react/index.js";
import type { NavigatorReaderHandle } from "../../src/react/index.js";
import type { NavigatorRuntime } from "../../src/runtime/navigator/api.js";

function appendPrimaryFrame(hidden: boolean) {
  const frame = document.createElement("iframe");
  frame.dataset.epubNavigatorParticipant = "primary";
  frame.dataset.epubNavigatorOccurrence = "0";
  if (hidden) frame.setAttribute("aria-hidden", "true");
  publicationHost().append(frame);
  return frame;
}

const truncationWarning = "Some content may be cut off in paginated view.";

describe("NavigatorReader input, focus, preferences, and runtime identity", () => {
  it("dismisses its modal drawer with Escape and restores publication focus", async () => {
    const { runtime } = await renderReader();
    act(() => runtime.commit(0));
    const frame = document.createElement("iframe");
    const focus = vi.spyOn(frame, "focus");
    publicationHost().append(frame);

    fireEvent.click(screen.getByRole("button", { name: "Navigation" }));
    const dialog = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument(),
    );
    expect(frame).toHaveFocus();
    // What matters is that focus returns without scrolling the publication; Base Rhea decides the
    // rest of the options it passes.
    expect(focus).toHaveBeenCalledWith(expect.objectContaining({ preventScroll: true }));
  });

  it("renders an optional Back to library action only in Quick Menu", async () => {
    const onLibraryRequest = vi.fn();
    const { runtime } = await renderReader({ onLibraryRequest, search: searchCapabilities() });
    act(() => runtime.commit(0));

    const appearance = await openQuickMenu();
    await userEvent.click(within(appearance).getByRole("button", { name: /library$/iu }));
    await waitFor(() => expect(onLibraryRequest).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Navigation" }));
    const navigation = await screen.findByRole("dialog", { name: "Navigation" });
    expect(within(navigation).queryByRole("button", { name: /library$/iu })).toBeNull();
  });

  it("reports a recoverable failure and retries the exact occurrence", async () => {
    const { runtime } = await renderReader();

    act(() => runtime.fail("readiness-timeout"));
    expect(screen.getByRole("alert")).toHaveTextContent("did not start its reading agent");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(runtime.open).toHaveBeenLastCalledWith(0);
    act(() => runtime.commit(0));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["pending failure", "invalidation"])("retries section two after %s", async (failure) => {
    const { runtime } = await renderReader();
    act(() => {
      runtime.commit(0);
      runtime.open(1);
      if (failure === "invalidation") {
        runtime.commit(1);
        runtime.invalidate();
      } else runtime.fail("readiness-timeout");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Section unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(runtime.open).toHaveBeenLastCalledWith(1);
    act(() => runtime.commit(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reloads a failed replacement of the current section with a fresh frame", async () => {
    const { runtime } = await renderReader();
    act(() => {
      runtime.commit(1);
      runtime.open(1);
      runtime.fail("readiness-timeout");
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(runtime.reload).toHaveBeenCalledOnce();
  });

  it("retains the recovery section when retry throws", async () => {
    const { runtime } = await renderReader();
    act(() => {
      runtime.commit(1);
      runtime.invalidate();
    });
    runtime.open.mockImplementationOnce(() => {
      throw new Error("Retry failed");
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Retry failed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(runtime.open).toHaveBeenLastCalledWith(1);
  });

  it("retains its runtime for an equal publication under the same session ID and closes it on unmount", async () => {
    const { runtime, session, rerender, unmount } = await renderReader();

    rerender({
      session: {
        ...session,
        publication: { facts: session.publication.facts, mount: { ...session.publication.mount } },
      },
    });
    await act(() => Promise.resolve());
    expect(createNavigatorRuntime).toHaveBeenCalledOnce();
    expect(runtime.close).not.toHaveBeenCalled();

    unmount();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("rejects changed publication data under the same host session ID", async () => {
    const { session, rerender } = await renderReader();

    expect(() =>
      rerender({
        session: {
          id: session.id,
          publication: {
            facts: session.publication.facts,
            mount: { ...session.publication.mount, baseUrl: "https://reader.invalid/replacement/" },
          },
        },
      }),
    ).toThrow("NavigatorReader session publication must remain immutable");
  });

  it("keeps publication frame sandbox capabilities immutable within a session", async () => {
    const { rerender } = await renderReader({
      frameSandbox: { allowForms: true, allowModals: true },
    });
    expect(createNavigatorRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ frameSandbox: { allowForms: true, allowModals: true } }),
    );

    rerender({ frameSandbox: { allowForms: true, allowModals: true } });
    expect(createNavigatorRuntime).toHaveBeenCalledOnce();
    expect(() => rerender({ frameSandbox: { allowForms: false, allowModals: true } })).toThrow(
      "frame sandbox capabilities must remain immutable",
    );
  });

  it("replaces its runtime when only the host session ID changes", async () => {
    const secondRuntime = new FakeRuntime();
    const { runtime, session, rerender } = await renderReader();
    createNavigatorRuntime.mockResolvedValue(secondRuntime);

    rerender({ session: { id: crypto.randomUUID(), publication: session.publication } });
    await waitFor(() => expect(secondRuntime.open).toHaveBeenCalledWith(0));

    expect(runtime.close).toHaveBeenCalledOnce();
    expect(createNavigatorRuntime).toHaveBeenCalledTimes(2);
  });

  it("attaches pagination capabilities without replacing the foreground runtime", async () => {
    const pagination = paginationCapabilities();
    const { runtime, rerender } = await renderReader();

    rerender({ pagination });
    await waitFor(() => expect(runtime.setPaginationCapabilities).toHaveBeenCalledWith(pagination));
    expect(createNavigatorRuntime).toHaveBeenCalledOnce();
  });

  it("constructs the runtime with persisted presentation and pagination state", async () => {
    const pagination = paginationCapabilities();
    const { runtime } = await renderReader({
      pagination,
      preferences: readerPreferences({ paginationColumns: "single" }),
    });

    expect(createNavigatorRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        presentationPreferences: expect.objectContaining({
          mode: "paginated",
          paginationColumns: "single",
        }),
        pagination,
      }),
    );
    expect(runtime.setPresentationPreferences).not.toHaveBeenCalled();
    expect(runtime.setPaginationCapabilities).not.toHaveBeenCalled();
  });

  it("reconciles pagination acquired while runtime creation is pending", async () => {
    const runtime = new FakeRuntime();
    let resolveRuntime!: (runtime: NavigatorRuntime) => void;
    createNavigatorRuntime.mockReturnValue(
      new Promise<NavigatorRuntime>((resolve) => (resolveRuntime = resolve)),
    );
    const pagination = paginationCapabilities();
    const session = readerSession();
    const { rerender } = render(<NavigatorReader session={session} />);

    rerender(<NavigatorReader session={session} pagination={pagination} />);
    await act(async () => resolveRuntime(runtime));
    await waitFor(() => expect(runtime.open).toHaveBeenCalledWith(0));

    expect(runtime.setPaginationCapabilities).toHaveBeenCalledOnce();
    expect(runtime.setPaginationCapabilities).toHaveBeenCalledWith(pagination);
  });

  it("reports preference changes to its host", async () => {
    const onPreferencesChange = vi.fn();
    await renderReader({
      readerTypefaces: ["reader-serif", "reader-sans"],
      preferences: readerPreferences(),
      onPreferencesChange,
    });
    const settings = await openReadingSettings();
    await userEvent.click(
      within(within(settings).getByRole("radiogroup", { name: "Interface colors" })).getByRole(
        "radio",
        { name: "Dark" },
      ),
    );
    expect(onPreferencesChange).toHaveBeenCalledWith(readerPreferences({ colorScheme: "dark" }));

    await userEvent.click(await screen.findByRole("radio", { name: "Reader Serif" }));
    expect(onPreferencesChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ colorScheme: "dark", publicationTypeface: "reader-serif" }),
    );
    expect(
      within(screen.getByRole("radiogroup", { name: "Typeface" })).getByRole("radio", {
        name: "Original",
      }),
    ).toBeChecked();
  });

  it("asks for the monochrome decoration palette on a display that ghosts", async () => {
    const { runtime, rerender } = await renderReader();
    expect(runtime.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ appearance: expect.objectContaining({ decorations: "standard" }) }),
    );

    rerender({ interactionFeedback: "minimal" });

    await waitFor(() =>
      expect(runtime.configure).toHaveBeenLastCalledWith(
        expect.objectContaining({
          appearance: expect.objectContaining({ decorations: "monochrome" }),
        }),
      ),
    );
  });

  it("keeps configuration failures visible until that operation recovers", async () => {
    const { runtime, rerender } = await renderReader({ preferences: readerPreferences() });
    runtime.configure.mockClear();
    runtime.setPresentationPreferences.mockClear();
    runtime.configure.mockImplementationOnce(() => {
      throw new Error("input configuration failed");
    });

    rerender({ preferences: readerPreferences({ colorScheme: "dark", keyboardMode: "vim" }) });

    expect(await screen.findByRole("alert")).toHaveTextContent("input configuration failed");
    expect(runtime.setPresentationPreferences).toHaveBeenCalled();

    rerender({ preferences: readerPreferences({ colorScheme: "dark" }) });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("retries the current presentation preferences after a recoverable failure", async () => {
    const { runtime, rerender } = await renderReader({ preferences: readerPreferences() });
    runtime.setPresentationPreferences.mockClear();
    runtime.setPresentationPreferences.mockImplementationOnce(() => {
      throw new Error("presentation update failed");
    });

    rerender({ preferences: readerPreferences({ colorScheme: "dark" }) });

    expect(await screen.findByRole("alert")).toHaveTextContent("presentation update failed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(runtime.setPresentationPreferences).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("updates input policy and handles typed runtime interactions", async () => {
    const { runtime } = await renderReader();
    act(() => runtime.commit(0));
    expect(runtime.configure).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ keyboardMode: "standard" }) }),
    );

    await openReadingSettings();
    await userEvent.click(await screen.findByRole("radio", { name: "Vim" }));
    await waitFor(() =>
      expect(runtime.configure).toHaveBeenLastCalledWith(
        expect.objectContaining({
          input: {
            keyboardMode: "vim",
            touchZones: true,
            clickZones: false,
            progressionDirection: "ltr",
            selectionMenu: "native",
            // No host note source here, so a reference goes on navigating to its note.
            notes: "navigate",
          },
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close reading settings" }));

    act(() => runtime.interact("next"));
    expect(runtime.next).toHaveBeenCalledOnce();
  });

  it("advances shell presentation keys in-document and crosses only reported boundaries", async () => {
    const { runtime } = await renderReader({ preferences: readerPreferences() });
    act(() => runtime.commit(0));

    fireEvent.keyDown(document, { key: "PageDown" });
    await waitFor(() => expect(runtime.advancePresentation).toHaveBeenCalledWith("forward"));
    expect(runtime.next).not.toHaveBeenCalled();

    runtime.advancePresentation.mockResolvedValueOnce({
      outcome: "completed",
      status: { status: "boundary" },
      operation: 3,
      generation: 1,
      occurrence: 0,
      resource: "EPUB/chapter-1.xhtml",
    });
    fireEvent.keyDown(document, { key: "PageDown" });
    await waitFor(() => expect(runtime.next).toHaveBeenCalledOnce());
    expect(runtime.open).toHaveBeenLastCalledWith(1);
  });

  it("uses section navigation and document boundaries for Vim keys in the outer reader", async () => {
    const { runtime } = await renderReader({
      preferences: readerPreferences({ keyboardMode: "vim" }),
    });
    act(() => runtime.commit(0));
    fireEvent.keyDown(document, { key: "l" });
    expect(runtime.next).toHaveBeenCalledOnce();
    expect(runtime.advancePresentation).not.toHaveBeenCalled();
    act(() => runtime.commit(1));
    fireEvent.keyDown(document, { key: "h" });
    expect(runtime.previous).toHaveBeenCalledOnce();
    act(() => runtime.commit(0));
    fireEvent.keyDown(document, { key: "G", shiftKey: true });
    await waitFor(() =>
      expect(runtime.relocate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          observation: { layoutProgression: 1, renderedTextProgression: null },
        }),
      ),
    );
    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "g" });
    await waitFor(() =>
      expect(runtime.relocate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          observation: { layoutProgression: 0, renderedTextProgression: null },
        }),
      ),
    );
  });

  it("answers Vim movement keys while a reader control holds focus after a menu closes", async () => {
    const { runtime } = await renderReader({
      preferences: readerPreferences({ keyboardMode: "vim" }),
    });
    act(() => runtime.commit(0));
    const control = screen.getByRole("button", { name: "Navigation" });
    act(() => control.focus());
    expect(document.activeElement).toBe(control);

    fireEvent.keyDown(control, { key: "j" });
    await waitFor(() => expect(runtime.advancePresentation).toHaveBeenCalledWith("forward"));
    fireEvent.keyDown(control, { key: "l" });
    expect(runtime.next).toHaveBeenCalledOnce();
    // The keys a button answers itself stay with it.
    const movements = runtime.advancePresentation.mock.calls.length;
    fireEvent.keyDown(control, { key: "ArrowRight" });
    fireEvent.keyDown(control, { key: "Enter" });
    expect(runtime.advancePresentation).toHaveBeenCalledTimes(movements);
  });

  it("turns a page for a host whose device the browser never hears, whatever the keyboard is", async () => {
    const reader = createRef<NavigatorReaderHandle>();
    const { runtime } = await renderReader({
      preferences: readerPreferences({ keyboardMode: "off" }),
      ref: reader,
    });
    act(() => runtime.commit(0));

    // A side button is not a keyboard, so turning off keyboard input must not silence it.
    fireEvent.keyDown(document, { key: "PageDown" });
    expect(runtime.advancePresentation).not.toHaveBeenCalled();

    act(() => reader.current!.turnPage("forward"));
    await waitFor(() => expect(runtime.advancePresentation).toHaveBeenCalledWith("forward"));
    act(() => reader.current!.turnPage("backward"));
    await waitFor(() => expect(runtime.advancePresentation).toHaveBeenCalledWith("backward"));
  });

  it("leaves the publication where it is while a surface is laid over it", async () => {
    const reader = createRef<NavigatorReaderHandle>();
    const { runtime } = await renderReader({ profile: "compact", ref: reader });
    act(() => runtime.commit(0));
    await openNavigation();

    // The buttons belong to whatever is on top: the pages of the surface, never the book under it.
    await act(async () => {
      reader.current!.turnPage("forward");
    });
    expect(runtime.advancePresentation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    act(() => reader.current!.turnPage("forward"));
    await waitFor(() => expect(runtime.advancePresentation).toHaveBeenCalledWith("forward"));
  });

  it("does not handle shell keys when keyboard mode is off or a control owns focus", async () => {
    const { runtime, rerender } = await renderReader({
      preferences: readerPreferences({ keyboardMode: "off" }),
    });
    act(() => runtime.commit(0));

    fireEvent.keyDown(document, { key: "PageDown" });
    expect(runtime.advancePresentation).not.toHaveBeenCalled();

    rerender({ preferences: readerPreferences() });
    const navigation = screen.getByRole("button", { name: "Navigation" });
    navigation.focus();
    fireEvent.keyDown(navigation, { key: "PageDown" });
    expect(runtime.advancePresentation).not.toHaveBeenCalled();
  });

  it("retries generation-owned focus after a hidden fixed primary is revealed", async () => {
    const { runtime } = await renderReader();
    const frame = appendPrimaryFrame(true);

    act(() => runtime.commit(0, "fixed-xhtml"));
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(frame).not.toHaveFocus();

    frame.removeAttribute("aria-hidden");
    act(() => void runtime.publish());
    await waitFor(() => expect(frame).toHaveFocus());
  });

  it("cancels delayed publication focus when reader chrome is deliberately focused", async () => {
    const { runtime } = await renderReader();
    const frame = appendPrimaryFrame(true);
    act(() => runtime.commit(0, "fixed-xhtml"));

    const navigation = screen.getByRole("button", { name: "Navigation" });
    navigation.focus();
    frame.removeAttribute("aria-hidden");
    act(() => void runtime.publish());
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

    expect(navigation).toHaveFocus();
    expect(frame).not.toHaveFocus();
  });

  it("reports publication link activations to its host", async () => {
    const onLinkActivation = vi.fn();
    const { runtime } = await renderReader({ onLinkActivation });

    act(() => runtime.activate(false));
    expect(onLinkActivation).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedUrl: "https://example.com/", internal: false }),
    );
  });

  it("reports external form attempt metadata without form values", async () => {
    const onExternalFormAttempt = vi.fn();
    const { runtime } = await renderReader({ onExternalFormAttempt });

    act(() => runtime.attemptExternalForm());
    expect(onExternalFormAttempt).toHaveBeenCalledWith({
      action: "https://forms.invalid/submit",
      resolvedUrl: "https://forms.invalid/submit",
      method: "post",
      target: null,
    });
  });

  it("offers footnote return without moving outer-reader focus", async () => {
    const onLinkActivation = vi.fn();
    const { runtime } = await renderReader({ onLinkActivation });
    act(() => runtime.commit(0));
    const navigation = screen.getByRole("button", { name: "Navigation" });
    navigation.focus();

    act(() => runtime.activate(true, 12));

    const noteNavigation = screen.getByRole("group", { name: "Note navigation" });
    expect(
      within(noteNavigation)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Return to note reference", "Dismiss note return"]);
    expect(navigation).toHaveFocus();
    expect(onLinkActivation).toHaveBeenCalledWith(
      expect.objectContaining({ href: "chapter-2.xhtml", internal: true }),
    );

    act(() => void runtime.open(1));
    expect(screen.queryByRole("button", { name: "Return to note reference" })).toBeNull();
  });

  it("dismisses the footnote return controls without navigating", async () => {
    const { runtime } = await renderReader();
    act(() => {
      runtime.commit(0);
      runtime.activate(true, 12);
    });

    await userEvent.click(screen.getByRole("button", { name: "Dismiss note return" }));

    expect(screen.queryByRole("group", { name: "Note navigation" })).toBeNull();
    expect(runtime.returnFromFootnote).not.toHaveBeenCalled();
  });

  it("keeps an unresolved text pagination warning until a scroll layout settles", async () => {
    const { runtime } = await renderReader();
    act(() => {
      runtime.commit(0);
      runtime.settleLayout({ status: "unresolved", repairedElements: 0, unresolvedElements: 1 });
    });
    expect(screen.getByText(truncationWarning)).toBeInTheDocument();

    act(() => void runtime.open(1));
    expect(screen.getByText(truncationWarning)).toBeInTheDocument();

    act(() => {
      runtime.commit(1);
      runtime.settleLayout({ status: "no-issues-detected" }, "document-scroll");
    });
    expect(screen.queryByText(truncationWarning)).not.toBeInTheDocument();
  });

  it.each([
    { status: "no-issues-detected" as const },
    { status: "repaired" as const, repairedElements: 1 },
  ])("does not warn for $status text pagination", async (layoutRepairs) => {
    const { runtime } = await renderReader();

    act(() => {
      runtime.commit(0);
      runtime.settleLayout(layoutRepairs);
    });
    expect(screen.queryByText(truncationWarning)).not.toBeInTheDocument();
  });
});
