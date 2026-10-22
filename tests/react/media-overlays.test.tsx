// @vitest-environment jsdom

import { readerRegion, renderReader, type RenderReaderProps } from "./reader-harness.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  NavigatorMediaOverlayDescription,
  NavigatorMediaOverlayTimeline,
} from "../../src/media-overlays.js";
import type { NavigatorNarrationStatus, NavigatorReaderHandle } from "../../src/react/index.js";
import type { PublicationMediaOverlayCapabilities } from "../../src/runtime/media-overlays/capabilities.js";

class FakeAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  preservesPitch = false;
  paused = true;
  ended = false;
  error = null;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  removeAttribute = vi.fn();
  addEventListener() {}
  removeEventListener() {}
}

function stubAudio() {
  const audio = new FakeAudio();
  vi.stubGlobal("Audio", function Audio() {
    return audio;
  });
  return audio;
}

function timeline(): NavigatorMediaOverlayTimeline {
  return {
    overlayIndex: 0,
    canonicalPath: "EPUB/chapter-1.smil",
    declarations: [],
    skippable: ["pagebreak"],
    escapable: [],
    segmentCount: 1,
    playableSegmentCount: 1,
    availability: { state: "available" },
    segments: [
      {
        segmentIndex: 0,
        semanticPath: [],
        text: {
          reference: {
            state: "local-fragment",
            authoredHref: "chapter-1.xhtml#p1",
            canonicalPath: "EPUB/chapter-1.xhtml",
            query: null,
            fragment: "p1",
            fragmentExists: { state: "exists" },
          },
          availability: { state: "available" },
        },
        audio: {
          reference: {
            state: "local-resource",
            authoredHref: "audio.mp3",
            canonicalPath: "EPUB/audio.mp3",
            query: null,
          },
          availability: { state: "available" },
        },
        clipBegin: { state: "parsed", milliseconds: "0" },
        clipEnd: { state: "parsed", milliseconds: "1000" },
        playability: { state: "playable" },
      },
    ],
  };
}

function capabilities(): PublicationMediaOverlayCapabilities {
  const { segments: _segments, ...summary } = timeline();
  const declaration = {
    declarationIndex: 0,
    authoredId: { state: "missing" as const },
    authoredHref: null,
    canonicalPath: null,
    mediaType: null,
  };
  const description: NavigatorMediaOverlayDescription = {
    package: {
      state: "available",
      declared: true,
      declarations: [declaration],
      metadata: {
        totalDurations: [],
        itemDurations: [],
        narrators: [],
        activeClasses: [],
        playbackActiveClasses: [],
      },
    },
    coverage: {
      state: "complete",
      packageRelationships: null,
      smilExtraction: [],
      smilRelationships: [],
      fragmentObservations: [],
      mediaInspection: [],
    },
    playback: {
      state: "available",
      overlays: [summary],
      associations: [
        {
          occurrenceIndex: 0,
          effectiveLinear: "yes",
          content: {
            state: "resolved",
            declaration,
            canonicalPath: "EPUB/chapter-1.xhtml",
            bytes: { state: "present" },
          },
          overlay: { state: "resolved", declaration, overlayIndex: 0 },
          entrySegmentIndexes: [0],
        },
      ],
    },
  };
  return {
    availability: {
      status: "available",
      playableOccurrenceIndexes: [0],
      unavailableOccurrenceCount: 0,
    },
    signal: new AbortController().signal,
    description: vi.fn(async () => ({ status: "ok" as const, description })),
    timeline: vi.fn(async () => ({
      status: "ok" as const,
      result: { state: "available" as const, timeline: timeline() },
    })),
    close: vi.fn(),
  };
}

async function renderNarrated(props: RenderReaderProps = {}) {
  const { runtime } = await renderReader(props);
  act(() => {
    runtime.commit(0);
    runtime.visibleRangeValue = {
      primaryOccurrence: 0,
      firstOccurrence: 0,
      lastOccurrence: 0,
      companion: null,
    };
    runtime.locate(0);
  });
  return runtime;
}

async function openNarrationOptions() {
  fireEvent.click(screen.getByRole("button", { name: "Narration options" }));
  return screen.findByRole("progressbar", { name: "Section narration" });
}

describe("NavigatorReader narration", () => {
  it("renders no narration controls without a host capability", async () => {
    await renderNarrated();
    expect(screen.queryByRole("button", { name: "Play narration" })).not.toBeInTheDocument();
  });

  it("plays narration from a user action and keeps focus on the control", async () => {
    const audio = stubAudio();
    const mediaOverlays = capabilities();
    const runtime = await renderNarrated({ mediaOverlays });
    const play = await screen.findByRole("button", { name: "Play narration" });
    expect(mediaOverlays.description).not.toHaveBeenCalled();
    play.focus();
    fireEvent.click(play);
    const pause = await screen.findByRole("button", { name: "Pause narration" });
    expect(pause).toHaveAttribute("aria-pressed", "true");
    expect(runtime.setMediaOverlayActive).toHaveBeenCalledWith(
      expect.objectContaining({ occurrence: 0, fragment: "p1" }),
    );
    expect(audio.src).toBe("https://reader.invalid/books/book/EPUB/audio.mp3");
    expect(pause).toHaveFocus();
    fireEvent.click(pause);
    expect(await screen.findByRole("button", { name: "Play narration" })).toBeInTheDocument();
    expect(audio.pause).toHaveBeenCalled();
  });

  it("shows section time in the options while playing and after pausing", async () => {
    const audio = stubAudio();
    await renderNarrated({ mediaOverlays: capabilities(), profile: "workspace" });
    fireEvent.click(await screen.findByRole("button", { name: "Play narration" }));
    await screen.findByRole("button", { name: "Pause narration" });
    expect(await openNarrationOptions()).toHaveAttribute("aria-valuetext", "0:00 of 0:01");

    audio.currentTime = 0.5;
    fireEvent.click(screen.getByRole("button", { name: "Pause narration" }));
    await screen.findByRole("button", { name: "Play narration" });
    expect(await openNarrationOptions()).toHaveAttribute("aria-valuetext", "0:00 of 0:01");
  });

  it("lets the host play and pause narration and observe its state", async () => {
    const audio = stubAudio();
    const ref = createRef<NavigatorReaderHandle>();
    const statuses: NavigatorNarrationStatus[] = [];
    await renderNarrated({
      mediaOverlays: capabilities(),
      profile: "workspace",
      ref,
      onNarrationChange: (narration) => statuses.push(narration),
    });
    act(() => ref.current!.pauseNarration());
    await screen.findByRole("button", { name: "Play narration" });
    act(() => ref.current!.playNarration());
    await screen.findByRole("button", { name: "Pause narration" });
    act(() => ref.current!.pauseNarration());
    expect(await screen.findByRole("button", { name: "Play narration" })).toBeInTheDocument();
    expect(audio.pause).toHaveBeenCalled();
    expect(
      statuses
        .map((narration) => narration.state)
        .filter((state, index, states) => state !== states[index - 1]),
    ).toEqual(["idle", "loading", "playing", "paused"]);
    expect(statuses.at(-1)).toMatchObject({
      state: "paused",
      rate: "1",
      timing: { elapsedMs: 0, totalMs: 1000 },
    });
  });

  it("makes compact narration controls inert while a sheet covers the rail", async () => {
    await renderNarrated({ mediaOverlays: capabilities(), profile: "compact" });
    const play = await screen.findByRole("button", { name: "Play narration" });
    expect(play.closest("[inert]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    await waitFor(() => expect(play.closest("[inert]")).not.toBeNull());
  });

  it("offers Play in the options after stopping and closes when the publication takes focus", async () => {
    stubAudio();
    await renderNarrated({ mediaOverlays: capabilities(), profile: "workspace" });
    fireEvent.click(await screen.findByRole("button", { name: "Play narration" }));
    await screen.findByRole("button", { name: "Pause narration" });
    fireEvent.click(screen.getByRole("button", { name: "Narration options" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop narration" }));

    const options = await screen.findByRole("dialog", { name: "Narration" });
    const replay = await within(options).findByRole("button", { name: "Play narration" });
    expect(within(options).getByText("0:00 / 0:01")).toBeInTheDocument();
    fireEvent.click(replay);
    expect(await within(options).findByRole("button", { name: "Stop narration" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pause narration" })).toBeInTheDocument();

    const frame = document.createElement("iframe");
    readerRegion().append(frame);
    frame.focus();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Narration" })).not.toBeInTheDocument(),
    );
  });
});
