// @vitest-environment jsdom

import {
  createNavigatorRuntime,
  FakeRuntime,
  openNavigation,
  publication,
  readerPreferences,
  readerSession,
  renderReader,
  searchCapabilities,
} from "./reader-harness.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigatorReader } from "../../src/react/index.js";
import { projectAuthoredNavigation } from "../../src/react/navigation/model.js";
import { SearchPanel, type SearchPanelProps } from "../../src/react/search/panel.js";
import type { NavigatorRuntime } from "../../src/runtime/navigator/api.js";
import type {
  NavigatorSearchResult,
  NavigatorSearchSession,
  NavigatorSearchSnapshot,
} from "../../src/search.js";

afterEach(() => {
  ControllableIntersectionObserver.instances = [];
});

async function openSearch() {
  const navigation = await openNavigation();
  fireEvent.click(within(navigation).getByRole("button", { name: "Search publication" }));
  return screen.getByRole("searchbox", { name: "Search publication" });
}

function submitSearch(input: HTMLElement, query = "needle") {
  fireEvent.change(input, { target: { value: query } });
  fireEvent.submit(input.closest("form")!);
}

describe("NavigatorReader search", () => {
  it.each(["ctrlKey", "metaKey"] as const)(
    "leaves %s+F to the publication when keyboard mode is off",
    async (modifier) => {
      const search = searchCapabilities();
      const { runtime, rerender } = await renderReader({
        search,
        preferences: readerPreferences({ keyboardMode: "off" }),
      });
      act(() => runtime.commit(0));
      const disabled = new KeyboardEvent("keydown", {
        key: "f",
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(document, disabled);
      expect(disabled.defaultPrevented).toBe(false);
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

      rerender({ search, preferences: readerPreferences({ keyboardMode: "standard" }) });
      const enabled = new KeyboardEvent("keydown", {
        key: "f",
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(document, enabled);
      expect(enabled.defaultPrevented).toBe(true);
      await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
    },
  );
  it("fully resets search when the host replaces the session", async () => {
    const secondRuntime = new FakeRuntime();
    const { rerender } = await renderReader({
      profile: "compact",
      search: searchCapabilities(),
    });
    createNavigatorRuntime.mockResolvedValue(secondRuntime);
    fireEvent.change(await openSearch(), { target: { value: "old query" } });

    rerender({
      session: readerSession(),
      profile: "compact",
      search: searchCapabilities(),
    });
    await waitFor(() => expect(secondRuntime.open).toHaveBeenCalledWith(0));
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
    expect(await openSearch()).toHaveValue("");
  });

  it("submits provider search, projects current-document matches, and restores a result", async () => {
    const runtime = new FakeRuntime();
    const search = searchCapabilities();
    runtime.restoreAnnotationTarget.mockResolvedValueOnce({
      status: "restored",
      occurrence: 0,
      resource: "EPUB/chapter-1.xhtml",
      relocation: null,
    });
    await renderReader({ search }, runtime);
    act(() => runtime.commit(0));

    const input = await openSearch();
    fireEvent.click(screen.getByRole("button", { name: "Search scope: Whole book" }));
    expect(screen.getByRole("menuitemradio", { name: "Whole book" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "This section" }));
    fireEvent.click(screen.getByRole("button", { name: /Search scope: This section/u }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Whole book" }));
    submitSearch(input);

    await waitFor(() => expect(search.search).toHaveBeenCalledOnce());
    expect(search.search).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { type: "publication" }, initiator: "query-entry" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const result = await screen.findByRole("button", { name: "Before needle after" });
    await waitFor(() =>
      expect(runtime.setDecorationProjection).toHaveBeenLastCalledWith(
        expect.objectContaining({
          records: expect.arrayContaining([
            expect.objectContaining({ appearance: "search-result", occurrence: 0 }),
          ]),
        }),
      ),
    );

    fireEvent.click(result);
    await waitFor(() => expect(runtime.restoreAnnotationTarget).toHaveBeenCalledOnce());
    expect(runtime.restoreAnnotationTarget).toHaveBeenCalledWith(
      {
        targetJson: JSON.stringify({ type: "Annotation", target: "match" }),
        occurrenceHint: { occurrence: 0, resource: "EPUB/chapter-1.xhtml" },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("offers occurrence-only search after a document commits", async () => {
    const search = searchCapabilities(["occurrence"]);
    const { runtime } = await renderReader({ search });

    const navigation = await openNavigation();
    expect(
      within(navigation).queryByRole("button", { name: "Search publication" }),
    ).not.toBeInTheDocument();
    act(() => runtime.commit(0));
    fireEvent.click(within(navigation).getByRole("button", { name: "Search publication" }));

    fireEvent.click(screen.getByRole("button", { name: /Search scope: This section/u }));
    expect(screen.getByRole("menuitemradio", { name: "This section" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Whole book" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    submitSearch(screen.getByRole("searchbox", { name: "Search publication" }));
    await waitFor(() => expect(search.search).toHaveBeenCalledOnce());
    expect(search.search).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { type: "occurrence", occurrence: 0, resource: "EPUB/chapter-1.xhtml" },
      }),
      expect.anything(),
    );
  });

  it("does not close a search provider during Strict Mode effect replay", async () => {
    const runtimes: FakeRuntime[] = [];
    const search = searchCapabilities();
    createNavigatorRuntime.mockImplementation(async () => {
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return runtime;
    });
    const { unmount } = render(
      <StrictMode>
        <NavigatorReader session={readerSession()} search={search} />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(runtimes.some((runtime) => runtime.open.mock.calls.length > 0)).toBe(true),
    );
    await Promise.resolve();
    expect(search.close).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(search.close).toHaveBeenCalledOnce());
  });

  it("adopts a delayed effective fallback reading order without closing the provider", async () => {
    const runtime = new FakeRuntime();
    runtime.value = {
      ...runtime.value,
      readingOrder: runtime.value.readingOrder.map((occurrence, index) =>
        index === 0
          ? {
              ...occurrence,
              selectedDeclaration: 2,
              document: {
                state: "loadable" as const,
                resource: "EPUB/images/front cover.svg",
                adapter: "fixed-svg" as const,
              },
            }
          : occurrence,
      ),
    };
    let resolveRuntime!: (runtime: NavigatorRuntime) => void;
    createNavigatorRuntime.mockReturnValue(
      new Promise<NavigatorRuntime>((resolve) => (resolveRuntime = resolve)),
    );
    const search = searchCapabilities();
    vi.mocked(search.search).mockImplementation(async (request) => ({
      status: "completed",
      batch: {
        requestId: request.requestId,
        results: [searchResult("fallback", 0, "EPUB/images/front cover.svg", null)],
        coverage: { state: "complete", searchedOccurrences: 2, totalOccurrences: 2 },
        continuation: null,
        totalResultCount: 1,
      },
    }));
    render(<NavigatorReader session={readerSession()} search={search} />);

    await act(async () => resolveRuntime(runtime));
    await waitFor(() => expect(runtime.open).toHaveBeenCalledWith(0));
    submitSearch(await openSearch());

    expect(await screen.findByRole("button", { name: "Before needle after" })).toBeInTheDocument();
    expect(search.close).not.toHaveBeenCalled();
  });
});

describe("SearchPanel", () => {
  it("uses provider, authored TOC, and reading-order fallback section labels", () => {
    const results = [
      searchResult("provider", 0, "EPUB/chapter-1.xhtml", "Provider heading"),
      searchResult("authored", 1, "EPUB/chapter-2.xhtml", null),
      searchResult("fallback", 2, "EPUB/appendix.xhtml", null),
    ];
    render(<SearchPanel {...searchPanelProps(readySnapshot("request", null, results))} />);

    expect(screen.getByRole("heading", { name: "Provider heading" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chapter two" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Section 3 of 3" })).toBeInTheDocument();
    expect(screen.queryByText("Untitled section")).not.toBeInTheDocument();
  });

  it.each([
    ["scrolling", false],
    ["paginated", true],
  ])(
    "requests each visible continuation once in a %s panel and not while querying",
    (_, paginated) => {
      vi.stubGlobal("IntersectionObserver", ControllableIntersectionObserver);
      const onContinue = vi.fn();
      const initial = readySnapshot("request", "token-1");
      const { rerender } = render(
        <SearchPanel {...searchPanelProps(initial, onContinue)} paginated={paginated} />,
      );

      ControllableIntersectionObserver.instances.at(-1)?.intersect();
      ControllableIntersectionObserver.instances.at(-1)?.intersect();
      expect(onContinue).toHaveBeenCalledTimes(1);

      rerender(
        <SearchPanel
          {...searchPanelProps(
            { state: "querying", phase: "continuation", session: session("request", "token-2") },
            onContinue,
          )}
          paginated={paginated}
        />,
      );
      for (const observer of ControllableIntersectionObserver.instances) observer.intersect();
      expect(onContinue).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveTextContent("Loading more results");

      rerender(
        <SearchPanel
          {...searchPanelProps(readySnapshot("request", "token-2"), onContinue)}
          paginated={paginated}
        />,
      );
      ControllableIntersectionObserver.instances.at(-1)?.intersect();
      ControllableIntersectionObserver.instances.at(-1)?.intersect();
      expect(onContinue).toHaveBeenCalledTimes(2);
    },
  );

  it("does not fail when IntersectionObserver is unavailable", () => {
    expect(() =>
      render(<SearchPanel {...searchPanelProps(readySnapshot("request", "next"))} />),
    ).not.toThrow();
  });
});

function searchPanelProps(
  snapshot: NavigatorSearchSnapshot,
  onContinue: () => void = vi.fn(),
): SearchPanelProps {
  const mounted = publication(true);
  return {
    snapshot,
    authoredNavigation: projectAuthoredNavigation(mounted.facts),
    readingOrderLength: 3,
    scope: "publication",
    publicationScopeAvailable: true,
    occurrenceScopeAvailable: true,
    occurrenceLabel: "This section: Chapter one",
    activation: null,
    onScopeChange: vi.fn(),
    onSubmit: vi.fn(),
    onContinue,
    onActivate: vi.fn(),
  };
}

function readySnapshot(
  requestId: string,
  continuation: string | null,
  results: readonly NavigatorSearchResult[] = [
    searchResult("first", 0, "EPUB/chapter-1.xhtml", "Chapter one"),
  ],
): NavigatorSearchSnapshot {
  return { state: "ready", session: session(requestId, continuation, results) };
}

function session(
  requestId: string,
  continuation: string | null,
  results: readonly NavigatorSearchResult[] = [
    searchResult("first", 0, "EPUB/chapter-1.xhtml", "Chapter one"),
  ],
): NavigatorSearchSession {
  return {
    requestId,
    query: "needle",
    scope: { type: "publication" },
    initiator: "query-entry",
    results,
    coverage: { state: "complete", searchedOccurrences: 3, totalOccurrences: 3 },
    continuation,
    totalResultCount: continuation === null ? results.length : null,
    selectedResultId: null,
  };
}

function searchResult(
  id: string,
  occurrence: number,
  resource: string,
  label: string | null,
): NavigatorSearchResult {
  return {
    id,
    section: { id: `section-${id}`, occurrence, resource, label },
    targetJson: JSON.stringify({ source: resource }),
    excerpt: { before: "Before ", match: "needle", after: " after" },
  };
}

class ControllableIntersectionObserver implements IntersectionObserver {
  static instances: ControllableIntersectionObserver[] = [];
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  readonly #targets = new Set<Element>();
  readonly #callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
    ControllableIntersectionObserver.instances.push(this);
  }

  observe = (target: Element) => this.#targets.add(target);
  unobserve = (target: Element) => this.#targets.delete(target);
  disconnect = () => this.#targets.clear();
  takeRecords = () => [];

  intersect(): void {
    const entries = [...this.#targets].map(
      (target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry,
    );
    this.#callback(entries, this);
  }
}
