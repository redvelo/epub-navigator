// @vitest-environment jsdom

import { act, renderHook, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderReader } from "./reader-harness.js";
import { useNoteSurface } from "../../src/react/notes/controller.js";
import type { NavigatorLinkActivation, NavigatorNote } from "../../src/react/public-types.js";

const BASE_URL = "https://publication.example/mount/";

function noteReference(resource: string): NavigatorLinkActivation {
  return {
    href: `${resource}#n1`,
    resolvedUrl: `${BASE_URL}${resource}#n1`,
    target: null,
    download: null,
    internal: true,
    note: { referenceRect: null, referenceLabel: "1" },
  };
}

function surface({
  readNote,
  takeTheReference = () => true,
}: {
  readonly readNote: (() => Promise<NavigatorNote | null>) | undefined;
  readonly takeTheReference?: () => boolean;
}) {
  return renderHook(() =>
    useNoteSurface({
      readNote: readNote === undefined ? undefined : () => readNote(),
      baseUrl: BASE_URL,
      frameHost: null,
      takeTheReference,
    }),
  );
}

describe("note surface", () => {
  it("reads the note out of whichever document holds it", async () => {
    const note: NavigatorNote = { markup: "<p>A note.</p>", direction: null, language: null };
    const readNote = vi.fn(() => Promise.resolve(note));
    const { result } = surface({ readNote });

    await act(async () => {
      expect(result.current.show(noteReference("notes.xhtml"))).toBe(true);
    });

    expect(readNote).toHaveBeenCalledOnce();
    expect(result.current.open?.label).toBe("1");
    expect(result.current.open?.note).toEqual({ state: "ready", note });
  });

  it("takes the page to a note it cannot read, rather than leaving it out of reach", async () => {
    const takeTheReference = vi.fn(() => true);
    const { result } = surface({ readNote: () => Promise.resolve(null), takeTheReference });

    await act(async () => {
      result.current.show(noteReference("notes.xhtml"));
    });

    expect(takeTheReference).toHaveBeenCalledWith({ resource: "notes.xhtml", fragment: "n1" });
    expect(result.current.open).toBeNull();
  });

  it("says so when it can neither read the note nor go to it", async () => {
    const { result } = surface({
      readNote: () => Promise.reject(new Error("no note there")),
      takeTheReference: () => false,
    });

    await act(async () => {
      result.current.show(noteReference("notes.xhtml"));
    });

    expect(result.current.open?.note).toEqual({ state: "unavailable" });
  });

  it("leaves a reference alone when the host cannot read notes at all", () => {
    const { result } = surface({ readNote: undefined });
    expect(result.current.show(noteReference("notes.xhtml"))).toBe(false);
  });
});

describe("note surfaces", () => {
  const readNote = () =>
    Promise.resolve({
      markup: "<p>Kroeber did not define peasants.</p>",
      direction: null,
      language: null,
    });

  it("shows a compact note on a bare sheet that leaves by the page, not by chrome", async () => {
    const { runtime } = await renderReader({ profile: "compact", hostControls: { readNote } });
    act(() => runtime.activateNoteReference("1"));
    const sheet = await screen.findByRole("dialog", { name: "Note 1" });
    expect(await within(sheet).findByText("Kroeber did not define peasants.")).toBeVisible();
    expect(sheet.querySelector("header")).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Close note" })).not.toBeInTheDocument();
    expect(sheet.closest('[data-slot="drawer-popup"]')).not.toBeNull();
  });

  it("keeps the workspace note beside its reference", async () => {
    const { runtime } = await renderReader({ profile: "workspace", hostControls: { readNote } });
    act(() => runtime.activateNoteReference("1"));
    const popover = await screen.findByRole("dialog", { name: "Note 1" });
    expect(await within(popover).findByText("Kroeber did not define peasants.")).toBeVisible();
    expect(popover.closest('[data-slot="popover-content"]') ?? popover).toHaveAttribute(
      "data-slot",
      "popover-content",
    );
  });
});
