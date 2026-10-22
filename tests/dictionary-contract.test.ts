import { describe, expect, it, vi } from "vitest";
import type { NavigatorDictionaryLookupRequest } from "../src/dictionary.js";
import {
  createNavigatorDictionaryCoordinator,
  type NavigatorDictionaryAudioElement,
} from "../src/runtime/dictionary.js";
import { dictionaryCapabilities, dictionaryEntry, dictionarySense } from "./dictionary-fixtures.js";

function fakeAudio(listeners = new Map<string, () => void>()): NavigatorDictionaryAudioElement {
  return {
    src: "",
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    load: vi.fn(),
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  };
}

describe("dictionary coordinator", () => {
  it("looks up, loads every entry's detail, and pages sections into the entry", async () => {
    const { value } = dictionaryCapabilities();
    const coordinator = createNavigatorDictionaryCoordinator({ capabilities: value });
    await coordinator.lookup("  éléphant ", "fr-FR", "selection");
    expect(value.lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "éléphant",
        language: "fr-FR",
        initiator: "selection",
      }),
      expect.anything(),
    );
    await expect
      .poll(() => coordinator.snapshot().lookup)
      .toMatchObject({
        state: "ready",
        result: { details: { "e.éléphant": { state: "loaded" } } },
      });
    let lookup = coordinator.snapshot().lookup;
    if (lookup.state !== "ready") throw new Error("not ready");
    const view = lookup.result.lookup.views[0]!;
    expect(
      view.outcome.type === "completed" && view.outcome.entries[0]!.entry.etymology.items,
    ).toEqual(["Du latin elephantus."]);

    await coordinator.loadSection("e.éléphant", { type: "senses" });
    await coordinator.loadSection("e.éléphant", {
      type: "sense-examples",
      sense: 0,
    });
    expect(value.section).toHaveBeenCalledWith(
      "e.éléphant",
      { type: "sense-examples", sense: 0 },
      { offset: 1, limit: 2 },
      expect.anything(),
    );
    lookup = coordinator.snapshot().lookup;
    if (lookup.state !== "ready") throw new Error("not ready");
    const outcome = lookup.result.lookup.views[0]!.outcome;
    if (outcome.type !== "completed") throw new Error("not completed");
    const loaded = outcome.entries[0]!.entry;
    expect(loaded.senses.items.map((item) => item.glosses[0])).toEqual([
      "Mammifère",
      "Homme politique",
    ]);
    expect(loaded.senses.items[0]!.examples.items.map((item) => item.text)).toEqual([
      "Mammifère 0",
      "deux",
      "trois",
    ]);
    await coordinator.loadSection("e.éléphant", { type: "senses" });
    expect(value.section).toHaveBeenCalledTimes(2);
  });

  it("keeps a history for cross-references and restores results without refetching", async () => {
    const { value } = dictionaryCapabilities();
    const coordinator = createNavigatorDictionaryCoordinator({ capabilities: value });
    await coordinator.lookup("éléphant", null, "selection");
    await coordinator.lookup("trompe", "fr", "cross-reference");
    await coordinator.lookup("nez", "fr", "cross-reference");
    expect(coordinator.snapshot().history.map((result) => result.lookup.query)).toEqual([
      "éléphant",
      "trompe",
    ]);
    coordinator.back();
    const lookup = coordinator.snapshot().lookup;
    expect(lookup.state === "ready" && lookup.result.lookup.query).toBe("trompe");
    expect(value.lookup).toHaveBeenCalledTimes(3);
    await coordinator.lookup("échelle", null, "selection");
    expect(coordinator.snapshot().history).toEqual([]);
  });

  it("accepts lemma references as the host projects them", async () => {
    const { value } = dictionaryCapabilities({
      entry: async (handle: string) => ({
        status: "completed" as const,
        entry: dictionaryEntry(handle, {
          senses: {
            offset: 0,
            total: 1,
            items: [
              {
                ...dictionarySense("Pluriel de mal-baisée."),
                formOf: [
                  {
                    word: "mal-baisée",
                    extra: null,
                    romanization: null,
                    tags: [],
                    truncated: false,
                  },
                ],
              },
            ],
          },
        }),
      }),
    });
    const coordinator = createNavigatorDictionaryCoordinator({ capabilities: value });
    await coordinator.lookup("mal-baisées", "fr", "selection");
    await expect
      .poll(() => coordinator.snapshot().lookup)
      .toMatchObject({
        state: "ready",
        result: { details: { "e.mal-baisées": { state: "loaded" } } },
      });
  });

  it("reports text longer than any pack key as no entry without a provider request", async () => {
    const { value } = dictionaryCapabilities();
    const coordinator = createNavigatorDictionaryCoordinator({ capabilities: value });
    await coordinator.lookup("x".repeat(5_000), null, "selection");
    const lookup = coordinator.snapshot().lookup;
    expect(
      lookup.state === "ready" && lookup.result.lookup.views.map((view) => view.outcome),
    ).toEqual([{ type: "no-entry" }, { type: "no-entry" }]);
    expect(value.lookup).not.toHaveBeenCalled();
  });

  it("drops invalid language hints and rejects malformed provider responses", async () => {
    const lookup = vi.fn(async (request: NavigatorDictionaryLookupRequest) => ({
      status: "completed" as const,
      lookup: {
        requestId: request.requestId,
        query: request.text,
        views: [{ viewId: "unknown", outcome: { type: "no-entry" as const } }],
      },
    }));
    const { value } = dictionaryCapabilities({ lookup });
    const coordinator = createNavigatorDictionaryCoordinator({ capabilities: value });
    await coordinator.lookup("éléphant", "not a tag", "selection");
    expect(lookup.mock.calls[0]![0].language).toBeNull();
    expect(coordinator.snapshot().lookup.state).toBe("failed");
  });

  it("suppresses superseded responses", async () => {
    let release: (() => void) | undefined;
    const { value } = dictionaryCapabilities();
    const original = value.lookup;
    value.lookup = vi.fn(async (request: NavigatorDictionaryLookupRequest, context) => {
      if (request.text === "slow") await new Promise<void>((resolve) => (release = resolve));
      return original(request, context);
    });
    const coordinator = createNavigatorDictionaryCoordinator({ capabilities: value });
    const slow = coordinator.lookup("slow", null, "selection");
    await coordinator.lookup("fast", null, "selection");
    release?.();
    await slow;
    const lookup = coordinator.snapshot().lookup;
    expect(lookup.state === "ready" && lookup.result.lookup.query).toBe("fast");
  });

  it("plays one recording at a time and revokes its object URL", async () => {
    const { value } = dictionaryCapabilities();
    const listeners = new Map<string, () => void>();
    const audio = fakeAudio(listeners);
    const revokeObjectUrl = vi.fn();
    const coordinator = createNavigatorDictionaryCoordinator({
      capabilities: value,
      createAudio: () => audio,
      createObjectUrl: () => "blob:recording",
      revokeObjectUrl,
    });
    await coordinator.lookup("éléphant", null, "selection");
    await coordinator.play("a.fr.RWxlcGhhbnQub2dn");
    expect(audio.src).toBe("blob:recording");
    expect(coordinator.snapshot().playback).toEqual({
      handle: "a.fr.RWxlcGhhbnQub2dn",
      state: "playing",
    });
    listeners.get("ended")?.();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:recording");
    expect(coordinator.snapshot().playback).toBeNull();
    await expect(coordinator.play("a.fr.unknown")).rejects.toThrow(RangeError);
  });

  it("plays remote recordings, which carry credit but no duration or modification", async () => {
    const { value } = dictionaryCapabilities();
    const lookup = value.lookup;
    const entry = value.entry;
    value.lookup = vi.fn(async (request: NavigatorDictionaryLookupRequest, context) =>
      streamed(await lookup(request, context)),
    );
    value.entry = vi.fn(async (handle: string, context) => streamed(await entry(handle, context)));
    const audio = fakeAudio();
    const coordinator = createNavigatorDictionaryCoordinator({
      capabilities: value,
      createAudio: () => audio,
      createObjectUrl: () => "blob:remote",
      revokeObjectUrl: () => {},
    });
    await coordinator.lookup("éléphant", null, "selection");
    const snapshot = coordinator.snapshot().lookup;
    if (snapshot.state !== "ready") throw new Error(`lookup is ${snapshot.state}`);
    const view = snapshot.result.lookup.views[0]!.outcome;
    if (view.type !== "completed") throw new Error(`view is ${view.type}`);
    expect(view.entries[0]!.entry.pronunciations.items[0]!.audio).toEqual({
      status: "remote",
      handle: "a.fr.RWxlcGhhbnQub2dn",
      credit: {
        author: "Speaker",
        authorUrls: [],
        license: { shortName: "CC BY-SA 4.0", url: null },
        sourceUrl: null,
        attributionRequired: true,
        modification: null,
      },
    });
    await coordinator.play("a.fr.RWxlcGhhbnQub2dn");
    expect(coordinator.snapshot().playback?.state).toBe("playing");
  });

  it("becomes unavailable when the host revokes the capability and closes idempotently", async () => {
    const { value, controller } = dictionaryCapabilities();
    const coordinator = createNavigatorDictionaryCoordinator({ capabilities: value });
    await coordinator.lookup("éléphant", null, "selection");
    controller.abort();
    expect(coordinator.snapshot().lookup).toEqual({
      state: "unavailable",
      reason: "snapshot-unavailable",
      request: null,
    });
    coordinator.close();
    coordinator.close();
    expect(value.close).toHaveBeenCalledTimes(1);
  });
});

/** Rewrites every bundled recording in a host response the way a remote collection reports it. */
function streamed<T>(value: T): T {
  if (Array.isArray(value)) return value.map(streamed) as T;
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.status === "available" && "durationMs" in record) {
    const credit = record.credit as Record<string, unknown>;
    return {
      status: "remote",
      handle: record.handle,
      credit: { ...credit, modification: null },
    } as T;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, streamed(entry)]),
  ) as T;
}
