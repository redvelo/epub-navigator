// @vitest-environment jsdom

import { FakeRuntime, publication } from "./reader-harness.js";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AuthoredNavigation } from "../../src/react/navigation/authored-navigation.js";
import { getDefaultStore } from "jotai";
import { useNavigationController } from "../../src/react/navigation/controller.js";
import { navigationIntentAtom } from "../../src/react/navigation/state.js";
import { projectAuthoredNavigation } from "../../src/react/navigation/model.js";
import { currentFrame } from "../../src/runtime/kernel-view.js";

it.each(["toc", "page-list", "landmarks"] as const)(
  "ignores authored hidden flags in generated %s navigation without erasing facts",
  (semantic) => {
    const facts = publication().facts;
    const list = facts.navigation!.lists[0]!;
    list.semantic = semantic;
    list.hidden = true;
    const parent = list.points[0]!;
    parent.hidden = true;
    parent.children[0]!.hidden = true;
    const original = structuredClone(facts);
    const projection = projectAuthoredNavigation(facts);
    const onNavigate = vi.fn();
    const runtime = new FakeRuntime();
    runtime.commit(0);
    render(
      <AuthoredNavigation
        projection={projection}
        current={currentFrame(runtime.value)}
        pagination={null}
        onNavigate={onNavigate}
      />,
    );
    if (semantic !== "toc") {
      fireEvent.click(
        screen.getByRole("tab", { name: semantic === "page-list" ? "Pages" : "Landmarks" }),
      );
    } else {
      expect(screen.getByRole("button", { name: "Toggle Part one" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    }
    expect(screen.getByRole("button", { name: "Part one" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Chapter one" }));
    expect(screen.getByRole("button", { name: "Chapter two" })).toBeEnabled();
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ point: parent.children[0], pointPath: [0, 0] }),
    );
    expect(facts).toEqual(original);
  },
);

it.each(["toc", "page-list", "landmarks"] as const)(
  "opens the first linear duplicate from the second occurrence through %s",
  (semantic) => {
    const facts = publication(true).facts;
    facts.navigation!.lists[0]!.semantic = semantic;
    facts.resources.readingOrder[0]!.target = facts.resources.readingOrder[1]!.target;
    facts.resources.readingOrder[0]!.resource = facts.resources.readingOrder[1]!.resource;
    const projection = projectAuthoredNavigation(facts);
    const point = [...projection.contents, ...projection.pages, ...projection.landmarks][0]!
      .points[1]!;
    const runtime = new FakeRuntime();
    runtime.commit(1);
    const store = getDefaultStore();
    store.set(navigationIntentAtom, null);
    const { result } = renderHook(() =>
      useNavigationController({
        onReaderCommand: () => {},
        runtime: { current: runtime },
        frameHost: { current: null },
        committed: currentFrame(runtime.value),
        committedDocument: runtime.value.document.committed,
        pending: null,
        closeNavigationSurfaces: vi.fn(),
        closeNavigationOverlay: vi.fn(),
        error: null,
      }),
    );
    act(() => result.current.navigateToc(point));
    expect(runtime.open).toHaveBeenCalledWith(0);
    expect(runtime.relocate).not.toHaveBeenCalled();
    expect(store.get(navigationIntentAtom)?.locator).toMatchObject({
      occurrence: 0,
      resource: "EPUB/chapter-2.xhtml",
    });
    expect(point.occurrences).toEqual([0, 1]);
  },
);
