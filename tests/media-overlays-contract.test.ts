import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isNavigatorMediaOverlayAvailability,
  isNavigatorMediaOverlayDescription,
  isNavigatorMediaOverlayTimelineResult,
  mediaOverlayAudioUrl,
  mediaOverlayTimelineMatchesSummary,
  smilClockMilliseconds,
  type NavigatorMediaOverlayDeclaration,
  type NavigatorMediaOverlayDescription,
  type NavigatorMediaOverlaySegment,
  type NavigatorMediaOverlayTimeline,
} from "../src/media-overlays.js";

const mount = {
  baseUrl: "https://publication.test/",
  remoteResources: "blocked",
  contentOrigin: "isolated-publication-origin",
} as const;

function declaration(declarationIndex: number, href: string): NavigatorMediaOverlayDeclaration {
  return {
    declarationIndex,
    authoredId: { state: "valid", value: `item-${declarationIndex}` },
    authoredHref: href,
    canonicalPath: `EPUB/${href}`,
    mediaType: null,
  };
}

function segment(segmentIndex: number, begin: string, end: string): NavigatorMediaOverlaySegment {
  return {
    segmentIndex,
    semanticPath: [{ kind: "sequence", epubTypes: ["chapter"], textReference: null }],
    text: {
      reference: {
        state: "local-fragment",
        authoredHref: `chapter.xhtml#s${segmentIndex}`,
        canonicalPath: "EPUB/chapter.xhtml",
        query: null,
        fragment: `s${segmentIndex}`,
        fragmentExists: { state: "exists" },
      },
      availability: { state: "available" },
    },
    audio: {
      reference: {
        state: "local-resource",
        authoredHref: "audio/chapter one.mp3",
        canonicalPath: "EPUB/audio/chapter one.mp3",
        query: "v=1",
      },
      availability: { state: "available" },
    },
    clipBegin: { state: "parsed", milliseconds: begin },
    clipEnd: { state: "parsed", milliseconds: end },
    playability: { state: "playable" },
  };
}

function timeline(): NavigatorMediaOverlayTimeline {
  return {
    overlayIndex: 0,
    canonicalPath: "EPUB/overlay.smil",
    declarations: [declaration(1, "overlay.smil")],
    skippable: ["pagebreak"],
    escapable: ["table"],
    segmentCount: 2,
    playableSegmentCount: 2,
    availability: { state: "available" },
    segments: [segment(0, "0", "1500"), segment(1, "1500", "3000")],
  };
}

function description(): NavigatorMediaOverlayDescription {
  const { segments: _segments, ...summary } = timeline();
  return {
    package: {
      state: "available",
      declared: true,
      declarations: [declaration(0, "chapter.xhtml"), declaration(1, "overlay.smil")],
      metadata: {
        totalDurations: [
          {
            authored: "0:00:03",
            clock: { state: "parsed", milliseconds: "3000" },
            refines: null,
            declarationIndexes: [],
          },
        ],
        itemDurations: [],
        narrators: ["Narrator"],
        activeClasses: ["-epub-media-overlay-active"],
        playbackActiveClasses: [],
      },
    },
    coverage: {
      state: "complete",
      packageRelationships: { state: "complete" },
      smilExtraction: [{ canonicalPath: "EPUB/overlay.smil", result: { state: "complete" } }],
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
            declaration: declaration(0, "chapter.xhtml"),
            canonicalPath: "EPUB/chapter.xhtml",
            bytes: { state: "present" },
          },
          overlay: {
            state: "resolved",
            declaration: declaration(1, "overlay.smil"),
            overlayIndex: 0,
          },
          entrySegmentIndexes: [0, 1],
        },
      ],
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("media overlay host contract", () => {
  it("accepts complete host descriptions and timelines", () => {
    expect(isNavigatorMediaOverlayDescription(description())).toBe(true);
    expect(
      isNavigatorMediaOverlayTimelineResult({ state: "available", timeline: timeline() }),
    ).toBe(true);
    expect(
      isNavigatorMediaOverlayDescription({ ...description(), playback: { state: "absent" } }),
    ).toBe(true);
  });

  it("rejects unknown fields, broken ordering, and inconsistent counts", () => {
    const extra = { ...description(), unexpected: true };
    type MutableAssociations = {
      playback: { associations: { occurrenceIndex: number; entrySegmentIndexes: number[] }[] };
    };
    const duplicated = clone(description()) as unknown as MutableAssociations;
    const outOfRange = clone(description()) as unknown as MutableAssociations;
    duplicated.playback.associations.push(duplicated.playback.associations[0]!);
    outOfRange.playback.associations[0]!.entrySegmentIndexes = [2];
    expect([extra, duplicated, outOfRange].map(isNavigatorMediaOverlayDescription)).toEqual([
      false,
      false,
      false,
    ]);

    const miscounted = { ...timeline(), playableSegmentCount: 1 };
    const reversed = clone(timeline());
    (reversed.segments[0] as { clipEnd: unknown }).clipEnd = { state: "parsed", milliseconds: "0" };
    const unrecognized = clone(timeline());
    (unrecognized.segments[0] as { clipBegin: unknown }).clipBegin = { state: "unrecognized" };
    expect(
      [miscounted, reversed, unrecognized].map((value) =>
        isNavigatorMediaOverlayTimelineResult({ state: "available", timeline: value }),
      ),
    ).toEqual([false, false, false]);
  });

  it("accepts a playable segment whose optional clip clocks are absent", () => {
    const open = clone(timeline());
    (open.segments[0] as { clipBegin: unknown; clipEnd: unknown }).clipBegin = { state: "absent" };
    (open.segments[1] as { clipEnd: unknown }).clipEnd = { state: "absent" };
    expect(isNavigatorMediaOverlayTimelineResult({ state: "available", timeline: open })).toBe(
      true,
    );
  });

  it("accepts unusable text fragments with their precise binding issue", () => {
    const ambiguous = clone(timeline());
    const segment = ambiguous.segments[0]! as unknown as {
      text: { reference: { fragmentExists: unknown }; availability: unknown };
      playability: unknown;
    };
    segment.text.reference.fragmentExists = { state: "ambiguous" };
    segment.text.availability = { state: "unavailable", reason: "ambiguous-fragment" };
    segment.playability = { state: "unavailable", reason: "text-binding-unavailable" };
    (ambiguous as { playableSegmentCount: number }).playableSegmentCount = 1;
    expect(isNavigatorMediaOverlayTimelineResult({ state: "available", timeline: ambiguous })).toBe(
      true,
    );
  });

  it("requires unavailable timeline results to carry their summary reason", () => {
    const { segments: _segments, ...summary } = timeline();
    const unavailable = {
      ...summary,
      playableSegmentCount: 0,
      availability: { state: "unavailable", reason: "audio-preparation-failed" },
    };
    expect(
      isNavigatorMediaOverlayTimelineResult({
        state: "unavailable",
        summary: unavailable,
        reason: "audio-preparation-failed",
      }),
    ).toBe(true);
    expect(
      isNavigatorMediaOverlayTimelineResult({
        state: "unavailable",
        summary: unavailable,
        reason: "no-playable-segments",
      }),
    ).toBe(false);
  });

  it("matches fetched timelines to their description summary", () => {
    const playback = description().playback;
    if (playback.state !== "available") throw new Error("expected available playback");
    const summary = playback.overlays[0]!;
    expect(
      mediaOverlayTimelineMatchesSummary({ state: "available", timeline: timeline() }, summary),
    ).toBe(true);
    expect(
      mediaOverlayTimelineMatchesSummary(
        { state: "available", timeline: { ...timeline(), canonicalPath: "EPUB/other.smil" } },
        summary,
      ),
    ).toBe(false);
  });

  it("validates bootstrap availability", () => {
    expect(isNavigatorMediaOverlayAvailability({ status: "absent" })).toBe(true);
    expect(
      isNavigatorMediaOverlayAvailability({
        status: "available",
        playableOccurrenceIndexes: [1, 4],
        unavailableOccurrenceCount: 2,
      }),
    ).toBe(true);
    expect(
      isNavigatorMediaOverlayAvailability({
        status: "available",
        playableOccurrenceIndexes: [4, 1],
        unavailableOccurrenceCount: 0,
      }),
    ).toBe(false);
    expect(isNavigatorMediaOverlayAvailability({ status: "absent", extra: 1 })).toBe(false);
  });

  it("resolves mounted audio URLs without fragments and parses clocks safely", () => {
    const audio = timeline().segments[0]!.audio.reference;
    expect(mediaOverlayAudioUrl(mount, audio)).toBe(
      "https://publication.test/EPUB/audio/chapter%20one.mp3?v=1",
    );
    expect(
      mediaOverlayAudioUrl(mount, { state: "remote", authoredHref: "https://x.test/a.mp3" }),
    ).toBeNull();
    expect(smilClockMilliseconds({ state: "parsed", milliseconds: "1500" })).toBe(1500);
    expect(
      smilClockMilliseconds({ state: "parsed", milliseconds: "18446744073709551615" }),
    ).toBeNull();
    expect(smilClockMilliseconds({ state: "absent" })).toBeNull();
  });

  it("accepts the recorded Moby-Dick description and chapter timelines", () => {
    const directory = new URL("./fixtures/epub3-samples/", import.meta.url);
    const json = (name: string): unknown =>
      JSON.parse(readFileSync(new URL(`moby-dick-media-overlays/${name}`, directory), "utf8"));
    expect(
      createHash("sha256")
        .update(readFileSync(new URL("moby-dick-mo.epub", directory)))
        .digest("hex"),
    ).toBe("749a9de094c26bc79351722a2bf320845dc5f6af2d5bf41a96d720d723b29a4c");

    const fixture = json("description.json");
    if (!isNavigatorMediaOverlayDescription(fixture) || fixture.playback.state !== "available") {
      throw new Error("expected an available playback description");
    }
    expect(
      fixture.playback.associations
        .filter((association) => association.overlay.state === "resolved")
        .map((association) => association.occurrenceIndex),
    ).toEqual([6, 7]);
    expect(fixture.playback.overlays).toHaveLength(2);
    for (const summary of fixture.playback.overlays) {
      const result = json(`timeline-${summary.overlayIndex}.json`);
      if (!isNavigatorMediaOverlayTimelineResult(result)) throw new Error("invalid timeline");
      expect(result.state).toBe("available");
      expect(mediaOverlayTimelineMatchesSummary(result, summary)).toBe(true);
    }
  });
});
