// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { PublicationMount } from "../src/generated/kernel.js";
import {
  isExpectedFrameMessage,
  postFrameMessage,
  resolveFrameProfile,
} from "../src/runtime/frame-profile.js";

describe("publication frame profile", () => {
  it("uses exact origins for shared and isolated publications", () => {
    for (const [baseUrl, contentOrigin, origin] of [
      [`${location.origin}/books/alice/`, "shared-reader-origin", location.origin],
      [
        "https://alice.publications.invalid/",
        "isolated-publication-origin",
        "https://alice.publications.invalid",
      ],
    ] as const) {
      expect(resolveFrameProfile(mount(baseUrl, contentOrigin), document)).toEqual({
        sandbox: "allow-scripts allow-same-origin",
        messageOrigin: origin,
        targetOrigin: origin,
      });
    }
  });

  it("adds only explicitly granted frame capabilities in deterministic order", () => {
    expect(
      resolveFrameProfile(mount(`${location.origin}/books/alice/`), document, {
        allowForms: true,
        allowModals: true,
      }).sandbox,
    ).toBe("allow-scripts allow-same-origin allow-forms allow-modals");
    expect(
      resolveFrameProfile(mount(`${location.origin}/books/alice/`), document, {
        allowForms: false,
      }).sandbox,
    ).toBe("allow-scripts allow-same-origin");
  });

  it("rejects mounts that contradict their origin profile", () => {
    for (const [baseUrl, contentOrigin, message] of [
      [
        `${location.origin}/books/alice/`,
        "isolated-publication-origin",
        "must be distinct from the reader origin",
      ],
      [
        "https://alice.publications.invalid/books/alice/",
        "isolated-publication-origin",
        "must be mounted at its origin root",
      ],
      [
        "https://alice.publications.invalid/books/alice/",
        "shared-reader-origin",
        "must use the reader origin",
      ],
    ] as const) {
      expect(() => resolveFrameProfile(mount(baseUrl, contentOrigin), document)).toThrow(message);
    }
  });

  it("sends to and accepts only the resolved exact origin and source", () => {
    const profile = resolveFrameProfile(
      mount("https://alice.publications.invalid/", "isolated-publication-origin"),
      document,
    );
    const postMessage = vi.fn();
    postFrameMessage({ postMessage }, profile, { type: "probe" });
    expect(postMessage).toHaveBeenCalledWith(
      { type: "probe" },
      "https://alice.publications.invalid",
    );

    const source = {} as Window;
    expect(
      isExpectedFrameMessage(
        { source, origin: "https://alice.publications.invalid" },
        source,
        profile,
      ),
    ).toBe(true);
    expect(
      isExpectedFrameMessage({ source, origin: "https://other.invalid" }, source, profile),
    ).toBe(false);
    expect(
      isExpectedFrameMessage(
        { source: {} as Window, origin: "https://alice.publications.invalid" },
        source,
        profile,
      ),
    ).toBe(false);
  });
});

function mount(
  baseUrl: string,
  contentOrigin: PublicationMount["contentOrigin"] = "shared-reader-origin",
): PublicationMount {
  return { baseUrl, remoteResources: "blocked", contentOrigin };
}
