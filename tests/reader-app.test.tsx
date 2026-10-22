// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Fragment, StrictMode } from "react";
import { Provider, createStore } from "jotai";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalPublicationRecord } from "../src/local/storage.js";
import type { NavigatorReaderSession } from "../src/publication.js";
import type { PublicationPaginationCapabilities } from "../src/runtime/pagination/index.js";

const readerMock = vi.hoisted(() => ({
  capture: vi.fn(),
  props: null as Record<string, unknown> | null,
}));

vi.mock("epub-navigator/react", () => ({
  NavigatorReader: (props: {
    session: NavigatorReaderSession;
    pagination?: PublicationPaginationCapabilities;
    paginationAvailability?: "pending" | "unavailable";
    ref?: { current: unknown };
  }) => {
    readerMock.props = props as unknown as Record<string, unknown>;
    if (props.ref !== undefined) props.ref.current = { captureReadingPosition: readerMock.capture };
    return (
      <div
        data-testid="reader"
        data-publication={props.session.publication.mount.baseUrl}
        data-lease={
          props.pagination?.signal.aborted
            ? "aborted"
            : props.pagination === undefined
              ? "none"
              : "active"
        }
        data-pagination-availability={props.paginationAvailability ?? "available"}
      />
    );
  },
}));

import { LocalPublicationReader } from "../reader/src/App.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  readerMock.capture.mockReset();
  readerMock.props = null;
});

describe("local publication reader capability ownership", () => {
  it("never passes the previous publication lease during a publication swap", async () => {
    const first = Promise.withResolvers<PublicationPaginationCapabilities>();
    const second = Promise.withResolvers<PublicationPaginationCapabilities>();
    const firstLease = lease();
    const secondLease = lease();
    const paginationCapabilities = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { rerender } = renderReader({ paginationCapabilities });
    first.resolve(firstLease.capabilities);
    await waitFor(() =>
      expect(screen.getByTestId("reader")).toHaveAttribute("data-lease", "active"),
    );
    const session = readerMock.props?.session as NavigatorReaderSession | undefined;
    expect(Object.keys(session?.publication ?? {})).toEqual(["facts", "mount"]);

    rerender("b");
    expect(screen.getByTestId("reader")).toHaveAttribute("data-publication", "b");
    expect(screen.getByTestId("reader")).toHaveAttribute("data-lease", "none");
    expect(screen.getByTestId("reader")).toHaveAttribute("data-pagination-availability", "pending");
    expect(firstLease.close).toHaveBeenCalledOnce();

    second.resolve(secondLease.capabilities);
    await waitFor(() =>
      expect(screen.getByTestId("reader")).toHaveAttribute("data-lease", "active"),
    );
    expect(paginationCapabilities.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("surfaces capability acquisition failure instead of silently idling", async () => {
    renderReader();

    await waitFor(() =>
      expect(screen.getByTestId("reader")).toHaveAttribute(
        "data-pagination-availability",
        "unavailable",
      ),
    );
  });

  it("reacquires an unexpectedly revoked active lease", async () => {
    const first = lease();
    const second = lease();
    const paginationCapabilities = vi
      .fn()
      .mockResolvedValueOnce(first.capabilities)
      .mockResolvedValueOnce(second.capabilities);
    renderReader({ paginationCapabilities });
    await waitFor(() =>
      expect(screen.getByTestId("reader")).toHaveAttribute("data-lease", "active"),
    );

    first.capabilities.close();

    await waitFor(() => expect(paginationCapabilities).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("reader")).toHaveAttribute("data-lease", "active"),
    );
    expect(second.capabilities.signal.aborted).toBe(false);
  });
});

describe("local publication reader position persistence", () => {
  const position = {
    targetJson: '{"target":"chapter"}',
    occurrenceHint: { occurrence: 1, resource: "EPUB/chapter.xhtml" },
  };

  it.each([false, true])(
    "loads a durable position before mounting the reader (strict mode: %s)",
    async (strict) => {
      const loaded = Promise.withResolvers<typeof position | null>();
      const repository = repositoryMock();
      repository.loadReadingPosition.mockReturnValue(loaded.promise);
      renderReader({ repository, strict });

      expect(screen.queryByTestId("reader")).not.toBeInTheDocument();
      loaded.resolve(position);
      await waitFor(() => expect(screen.getByTestId("reader")).toBeInTheDocument());
      expect(readerMock.props?.initialReadingPosition).toEqual(position);
    },
  );

  it("awaits a fresh generated capture before controlled Library navigation", async () => {
    const repository = repositoryMock();
    const saved = Promise.withResolvers<void>();
    repository.saveReadingPosition.mockReturnValue(saved.promise);
    const onLibraryRequest = vi.fn();
    const latest = {
      targetJson: '{"target":"latest"}',
      occurrenceHint: { occurrence: 2, resource: "EPUB/latest.xhtml" },
    };
    readerMock.capture.mockResolvedValue({ status: "generated", ...latest });
    renderReader({ repository, onLibraryRequest });
    await waitFor(() => expect(screen.getByTestId("reader")).toBeInTheDocument());

    act(() => (readerMock.props!.onLibraryRequest as () => void)());
    await waitFor(() => expect(repository.saveReadingPosition).toHaveBeenCalledOnce());
    expect(repository.saveReadingPosition).toHaveBeenCalledWith(
      "a",
      latest,
      expect.any(AbortSignal),
    );
    expect(onLibraryRequest).not.toHaveBeenCalled();
    saved.resolve();
    await waitFor(() => expect(onLibraryRequest).toHaveBeenCalledOnce());
  });

  it.each([
    ["does not overwrite a saved position when a settled capture is unavailable", false, 1],
    ["cancels a pending capture when the current location becomes unavailable", true, 0],
  ])("%s", async (_, locationLost, captures) => {
    vi.useFakeTimers();
    const repository = repositoryMock();
    readerMock.capture.mockResolvedValue({
      status: "unavailable",
      reason: "current-location-unavailable",
    });
    renderReader({ repository });
    await act(async () => Promise.resolve());

    const notify = readerMock.props?.onLocationChange as (snapshot: unknown) => void;
    act(() => {
      notify({
        revision: 2,
        location: { kind: "point" },
        basis: { documentGeneration: 1, frameGeneration: 1, layoutGeneration: 1 },
        visibleOccurrences: null,
      });
      if (locationLost) {
        notify({ revision: 3, location: null, basis: null, visibleOccurrences: null });
      }
      vi.advanceTimersByTime(500);
    });
    await act(async () => Promise.resolve());

    expect(readerMock.capture).toHaveBeenCalledTimes(captures);
    expect(repository.saveReadingPosition).not.toHaveBeenCalled();
  });
});

function lease() {
  const controller = new AbortController();
  const close = vi.fn(() => controller.abort());
  return { capabilities: { signal: controller.signal, close }, close };
}

function publication(id: string): LocalPublicationRecord {
  return {
    id,
    facts: {},
    mount: { baseUrl: id },
    sourceSizeBytes: 0,
    importedAt: 0,
  } as LocalPublicationRecord;
}

function repositoryMock() {
  return {
    load: vi.fn().mockResolvedValue({ revision: 0, records: [] }),
    mutate: vi.fn(),
    loadReadingPosition: vi.fn().mockResolvedValue(null),
    saveReadingPosition: vi.fn().mockResolvedValue(undefined),
    removePublication: vi.fn(),
  };
}

function renderReader({
  paginationCapabilities = vi.fn().mockRejectedValue(new Error("unavailable")),
  repository = null,
  onLibraryRequest = vi.fn(),
  strict = false,
}: {
  readonly paginationCapabilities?: ReturnType<typeof vi.fn>;
  readonly repository?: ReturnType<typeof repositoryMock> | null;
  readonly onLibraryRequest?: () => void;
  readonly strict?: boolean;
} = {}) {
  const store = createStore();
  const localHost = { readerTypefaces: true, paginationCapabilities } as never;
  const Wrapper = strict ? StrictMode : Fragment;
  const element = (id: string) => (
    <Wrapper>
      <Provider store={store}>
        <LocalPublicationReader
          readerStore={store}
          localHost={localHost}
          publication={publication(id)}
          readerTypefaces={["reader-serif", "reader-sans"]}
          preferences={{} as never}
          onPreferencesChange={vi.fn()}
          workspaceState={{} as never}
          onWorkspaceStateChange={vi.fn()}
          repository={repository}
          onLibraryRequest={onLibraryRequest}
        />
      </Provider>
    </Wrapper>
  );
  const view = render(element("a"));
  return { ...view, rerender: (id: string) => view.rerender(element(id)) };
}
