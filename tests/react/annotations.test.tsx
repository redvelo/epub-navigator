// @vitest-environment jsdom

import { FakeRuntime, publication, renderReader, searchCapabilities } from "./reader-harness.js";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, getDefaultStore, Provider } from "jotai";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NavigatorAnnotationProjection,
  NavigatorHighlightAnnotationRecord,
} from "../../src/annotations.js";
import { AnnotationsPanel, NoteEditor } from "../../src/react/annotations-panel.js";
import { activateAnnotationAtom } from "../../src/react/annotations/dispatch.js";
import {
  annotationQueryAtom,
  publicationFactsAtom,
  selectedAnnotationIdAtom,
  useAnnotationState,
} from "../../src/react/annotations/state.js";
import { readerStoreAtom } from "../../src/react/navigation/navigate-atom.js";
import { navigationIntentAtom } from "../../src/react/navigation/state.js";
import { activeRuntimeAtom, runtimeViewAtom } from "../../src/react/runtime/projection-state.js";
import { SelectionToolbar } from "../../src/react/selection-toolbar.js";
import type { RestoreAnnotationTargetResult } from "../../src/runtime/navigator/api.js";
import { dictionaryCapabilities } from "../dictionary-fixtures.js";

afterEach(() => getDefaultStore().set(annotationQueryAtom, ""));

const highlight = (id: string, excerpt: string): NavigatorHighlightAnnotationRecord => ({
  type: "highlight",
  id,
  targetJson: "{}",
  occurrence: 0,
  excerpt,
  sectionLabel: null,
});

describe("NavigatorReader annotations", () => {
  it.each(["highlight", "note"] as const)(
    "restores a same-document %s before completing its focus intent and ignores superseded completion",
    async (type) => {
      const runtime = new FakeRuntime();
      runtime.commit(0);
      const { resource } = runtime.snapshot().document.committed!.frame;
      const store = createStore();
      let complete!: (result: RestoreAnnotationTargetResult) => void;
      runtime.restoreAnnotationTarget.mockImplementation(
        () => new Promise((resolve) => (complete = resolve)),
      );
      store.set(readerStoreAtom, store);
      store.set(publicationFactsAtom, publication().facts);
      store.set(activeRuntimeAtom, runtime);
      store.set(runtimeViewAtom, {
        snapshot: runtime.snapshot(),
        visibleOccurrenceRange: null,
        finalSpreadLeadingOccurrence: null,
      });
      const { result } = renderHook(() => useAnnotationState(), {
        wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
      });
      const record = { ...highlight("annotation", "Words"), type, text: "Note" };
      const activate = () =>
        store.set(activateAnnotationAtom, record, { isTrusted: true } as MouseEvent);
      act(activate);
      expect(runtime.restoreAnnotationTarget).toHaveBeenCalledWith({
        targetJson: "{}",
        occurrenceHint: { occurrence: 0, resource },
      });
      expect(runtime.relocateAnnotationTarget).not.toHaveBeenCalled();
      expect(runtime.open).not.toHaveBeenCalled();
      expect(result.current.annotationActivation?.type).toBe("activating");
      expect(store.get(navigationIntentAtom)?.annotationTargetJson).toBe("{}");
      const restored: RestoreAnnotationTargetResult = {
        status: "restored",
        occurrence: 0,
        resource,
        relocation: null,
      };
      await act(async () => complete(restored));
      expect(result.current.selectedAnnotationId).toBe(record.id);
      expect(result.current.annotationActivation).toBeNull();
      expect(store.get(navigationIntentAtom)).toMatchObject({
        annotationTargetJson: null,
        focusAfterCompletion: true,
      });

      act(activate);
      const newerIntent = {
        ...store.get(navigationIntentAtom)!,
        annotationActivationToken: null,
        annotationTargetJson: null,
      };
      store.set(navigationIntentAtom, newerIntent);
      act(() => store.set(selectedAnnotationIdAtom, "newer"));
      await act(async () => complete(restored));
      expect(result.current.selectedAnnotationId).toBe("newer");
      expect(store.get(navigationIntentAtom)).toBe(newerIntent);
    },
  );

  it.each([
    ["an explicit reader menu", { selectionMenu: "reader" as const }, ["Copy"]],
    ["only dictionaries", { dictionary: dictionaryCapabilities().value }, ["Look up", "Copy"]],
    [
      "every capability",
      {
        annotations: { revision: 1, records: [] },
        onAnnotationMutation: vi.fn(),
        search: searchCapabilities(),
        dictionary: dictionaryCapabilities().value,
      },
      ["Highlight (f)", "Add note (d)", "Look up", "Search within publication", "Copy"],
    ],
  ])("offers selection actions for %s", async (_, props, actions) => {
    const runtime = new FakeRuntime();
    runtime.locate(0, 7);
    await renderReader(props, runtime);

    act(() => runtime.selectRange("éléphant"));

    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((button) => button.title),
    ).toEqual(actions);
  });

  it("draws above a selection a finger still holds and not at all while it drags", async () => {
    const runtime = new FakeRuntime();
    runtime.locate(0, 7);
    await renderReader({ selectionMenu: "reader" as const }, runtime);

    act(() => runtime.selectRange("éléphant"));
    expect(
      screen.getByRole("toolbar", { name: "Selection actions" }).getAttribute("data-placement"),
    ).toBe("below");

    act(() => runtime.selectRange("éléphant", "settled"));
    expect(
      screen.getByRole("toolbar", { name: "Selection actions" }).getAttribute("data-placement"),
    ).toBe("above");

    act(() => runtime.selectRange("éléphant", "dragging"));
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull();

    act(() => runtime.selectRange("éléphant", "settled"));
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeTruthy();
  });

  it("projects controlled annotations and rejects synthetic selection actions", async () => {
    const runtime = new FakeRuntime();
    runtime.locate(0, 7);
    const onAnnotationMutation = vi.fn();
    await renderReader(
      {
        annotations: {
          revision: 0,
          records: [
            {
              type: "bookmark",
              id: "bookmark",
              targetJson: "{}",
              occurrence: 0,
              sectionLabel: "Chapter one",
              label: null,
            },
          ],
        },
        onAnnotationMutation,
      },
      runtime,
    );
    expect(runtime.configure).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ selectionMenu: "reader" }) }),
    );
    expect(runtime.setDecorationProjection).toHaveBeenCalledOnce();
    expect(runtime.setDecorationProjection).toHaveBeenCalledWith({ revision: 1, records: [] });

    fireEvent.click(screen.getByRole("button", { name: "Annotations" }));
    const annotationsDialog = await screen.findByRole("dialog", { name: "Annotations" });
    fireEvent.click(
      within(annotationsDialog).getByRole("button", { name: "Add bookmark at current location" }),
    );
    expect(runtime.generateCurrentLocationAnnotationTarget).not.toHaveBeenCalled();

    act(() => runtime.selectRange());
    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Highlight" }));
    expect(onAnnotationMutation).not.toHaveBeenCalled();
    expect(runtime.generateSelectionAnnotationTarget).not.toHaveBeenCalled();

    fireEvent.keyDown(toolbar, { key: "Escape" });
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();
  });

  it("opens controlled annotation actions and an overlap chooser", async () => {
    const runtime = new FakeRuntime();
    const onAnnotationMutation = vi.fn();
    await renderReader(
      {
        annotations: {
          revision: 1,
          records: [
            highlight("highlight", "First words"),
            { ...highlight("note", "Overlapping words"), type: "note", text: "A note" },
          ],
        },
        onAnnotationMutation,
      },
      runtime,
    );

    act(() => runtime.activateDecoration(["note", "highlight"], true));
    const chooser = screen.getByRole("toolbar", { name: "Choose annotation" });
    expect(within(chooser).getByRole("button", { name: /Note/u })).toBeInTheDocument();
    fireEvent.click(within(chooser).getByRole("button", { name: /Highlight/u }));

    const actions = screen.getByRole("toolbar", { name: "Annotation actions" });
    expect(runtime.setActiveDecoration).toHaveBeenCalledWith(1, "highlight");
    for (const name of ["Expand beginning", "Contract ending", "Add note", "Open link"]) {
      fireEvent.click(within(actions).getByRole("button", { name }));
    }
    expect(runtime.adjustAnnotationRange).not.toHaveBeenCalled();
    expect(runtime.activateDecorationLink).not.toHaveBeenCalled();
    expect(onAnnotationMutation).not.toHaveBeenCalled();
  });

  it("does not offer a contextual link action when an activation has no link", async () => {
    const runtime = new FakeRuntime();
    await renderReader(
      { annotations: { revision: 1, records: [highlight("h", "Words")] } },
      runtime,
    );

    act(() => runtime.activateDecoration(["h"], false));

    expect(screen.getByRole("toolbar", { name: "Annotation actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open link" })).not.toBeInTheDocument();
  });
});

describe("AnnotationsPanel", () => {
  const projection: NavigatorAnnotationProjection = {
    revision: 4,
    records: [
      {
        type: "note",
        id: "ambiguous",
        targetJson: "{}",
        occurrence: 0,
        excerpt: "Ambiguous quote",
        sectionLabel: "Opening",
        text: "Remember this",
      },
      highlight("later", "Later quote"),
      {
        type: "bookmark",
        id: "bookmark",
        targetJson: "{}",
        occurrence: 1,
        sectionLabel: "Chapter two",
        label: "Return here",
      },
      highlight("earlier", "Earlier quote"),
    ],
  };
  const renderPanel = (props: Partial<ComponentProps<typeof AnnotationsPanel>> = {}) =>
    render(<AnnotationsPanel {...panelProps(props)} />);
  const panelProps = (props: Partial<ComponentProps<typeof AnnotationsPanel>>) => ({
    availability: "available" as const,
    projection,
    positions: [],
    selectedRecordId: null,
    operation: null,
    onActivate: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    retryDelete: null,
    ...props,
  });

  it("appends host-owned actions to each annotation menu", async () => {
    const copy = vi.fn();
    renderPanel({
      hostActions: (record) =>
        record.type === "bookmark"
          ? []
          : [{ id: "copy", label: "Copy as Markdown", onSelect: () => copy(record.id) }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Actions for highlight: Later quote" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    expect(copy).toHaveBeenCalledWith("later");
  });

  it("orders comparable records before ambiguous records and filters by text", async () => {
    const { rerender } = renderPanel({
      positions: [
        { id: "later", occurrence: 0, documentTextStart: "20" },
        { id: "earlier", occurrence: 0, documentTextStart: "10" },
        { id: "ambiguous", occurrence: 0, documentTextStart: null },
      ],
    });

    expect(screen.getByRole("heading", { name: "Opening" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chapter two" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Go to/u }).map((button) => button.textContent),
    ).toEqual([
      expect.stringContaining("Earlier quote"),
      expect.stringContaining("Later quote"),
      expect.stringContaining("Remember this"),
      expect.stringContaining("Return here"),
    ]);
    const noteName = "Go to note: Ambiguous quote. Note: Remember this";
    expect(screen.getByRole("button", { name: noteName })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Actions for note:/u }));
    expect(screen.getByRole("menuitem", { name: "Edit note" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();

    act(() => getDefaultStore().set(annotationQueryAtom, "remember"));
    rerender(<AnnotationsPanel {...panelProps({ selectedRecordId: "ambiguous" })} />);
    expect(screen.getByRole("button", { name: noteName })).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(screen.queryByText("Later quote")).not.toBeInTheDocument();
  });

  it("keeps a failed deletion directly retryable", async () => {
    const retryDelete = vi.fn();
    renderPanel({
      projection: { revision: 1, records: [projection.records[0]!] },
      operation: { recordId: "ambiguous", type: "failed", message: "Delete rejected" },
      retryDelete,
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Delete rejected");
    fireEvent.click(screen.getByRole("button", { name: /^Actions for note:/u }));
    expect(screen.getByRole("menuitem", { name: "Edit note" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Retry delete" }));
    expect(retryDelete).toHaveBeenCalledWith(expect.any(MouseEvent));
  });

  it("keeps record actions available after an activation failure", async () => {
    renderPanel({
      projection: { revision: 1, records: [projection.records[1]!] },
      operation: { recordId: "later", type: "failed", message: "Location unavailable" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Actions for highlight:/u }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Retry delete" })).not.toBeInTheDocument();
  });

  it("announces bookmark failures and exposes retry", async () => {
    const retryBookmark = vi.fn();
    renderPanel({
      projection: { revision: 1, records: [] },
      bookmarkOperation: { status: "failed", error: "Bookmark rejected" },
      retryBookmark,
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Bookmark rejected");
    await userEvent.click(screen.getByRole("button", { name: "Retry bookmark" }));
    expect(retryBookmark).toHaveBeenCalledWith(expect.any(MouseEvent));
  });
});

describe("NoteEditor", () => {
  const draft = {
    mode: "create" as const,
    recordId: null,
    excerpt: "Selected words",
    sectionLabel: "Chapter One",
    status: "idle" as const,
    error: null,
  };
  const editor = (text: string, autoFocus: boolean, onSave = vi.fn()) => (
    <NoteEditor
      draft={{ ...draft, text }}
      autoFocus={autoFocus}
      onTextChange={vi.fn()}
      onSave={onSave}
      onCancel={vi.fn()}
    />
  );

  it("focuses the note text when requested", async () => {
    render(editor("Existing note", true));
    expect(await screen.findByRole("textbox", { name: "Note" })).toHaveFocus();
  });

  it("requires non-whitespace text and submits valid drafts", async () => {
    const onSave = vi.fn();
    const { rerender } = render(editor("   ", false, onSave));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Note" })).not.toHaveFocus();

    rerender(editor("A useful note", false, onSave));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expect.any(Event));
  });
});

describe("SelectionToolbar", () => {
  const anchorRect = { left: 200, top: 200, right: 300, bottom: 220 };
  const clippingRect = { left: 0, top: 0, right: 500, bottom: 400 };
  const renderToolbar = (props: Partial<ComponentProps<typeof SelectionToolbar>> = {}) =>
    render(
      <SelectionToolbar
        anchorRect={anchorRect}
        clippingRect={clippingRect}
        busy={false}
        busyAction={null}
        error={null}
        copyAvailable={false}
        annotationAvailable
        searchAvailable={false}
        lookupAvailable={false}
        onCopyActivation={vi.fn()}
        onHighlightActivation={vi.fn()}
        onAddNoteActivation={vi.fn()}
        onSearchActivation={vi.fn()}
        onLookupActivation={vi.fn()}
        onEscape={vi.fn()}
        {...props}
      />,
    );

  it.each([
    ["above the selection", {}, "above", { left: "140px", top: "148px" }],
    [
      "clamped below near the top edge",
      {
        anchorRect: { left: 190, top: 4, right: 220, bottom: 24 },
        clippingRect: { left: 20, top: 0, right: 220, bottom: 200 },
      },
      "below",
      { left: "20px", top: "32px" },
    ],
    ["below a forward selection", { preferredPlacement: "below" }, "below", { top: "228px" }],
    [
      "above when below lacks space",
      {
        anchorRect: { left: 200, top: 150, right: 300, bottom: 170 },
        clippingRect: { left: 0, top: 0, right: 500, bottom: 200 },
        preferredPlacement: "below",
      },
      "above",
      { top: "98px" },
    ],
  ] as const)("places the toolbar %s", (_, props, placement, position) => {
    renderToolbar(props);
    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    expect(toolbar).toHaveAttribute("data-placement", placement);
    expect(toolbar.parentElement).toHaveStyle(position);
    expect(screen.getByRole("button", { name: "Highlight" })).not.toHaveFocus();
  });

  it("passes the native activation event and handles Escape from the toolbar", async () => {
    const onHighlightActivation = vi.fn();
    const onCopyActivation = vi.fn();
    const onEscape = vi.fn();
    renderToolbar({ copyAvailable: true, onCopyActivation, onHighlightActivation, onEscape });

    await userEvent.click(screen.getByRole("button", { name: "Highlight" }));
    expect(onHighlightActivation).toHaveBeenCalledWith(expect.any(MouseEvent));
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopyActivation).toHaveBeenCalledWith(expect.any(MouseEvent));
    await userEvent.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("offers publication search without annotation actions", async () => {
    const onSearchActivation = vi.fn();
    renderToolbar({ annotationAvailable: false, searchAvailable: true, onSearchActivation });

    expect(screen.queryByRole("button", { name: "Highlight" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Search within publication" }));
    expect(onSearchActivation).toHaveBeenCalledWith(expect.any(MouseEvent));
  });

  it("exposes busy and error state with live semantics", () => {
    renderToolbar({
      busy: true,
      busyAction: "highlight",
      error: "Highlight could not be created",
      copyAvailable: true,
    });

    expect(screen.getByRole("toolbar")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Creating highlight");
    expect(screen.getByRole("alert")).toHaveTextContent("Highlight could not be created");
    expect(screen.getByRole("button", { name: "Highlight" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
  });
});
