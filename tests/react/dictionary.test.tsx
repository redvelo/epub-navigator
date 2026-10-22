// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigatorDictionarySnapshot } from "../../src/dictionary.js";
import { DictionaryContent } from "../../src/react/dictionary/content.js";
import {
  dictionaryEntry,
  dictionaryExample,
  dictionarySense,
  dictionaryViews,
} from "../dictionary-fixtures.js";

afterEach(cleanup);

describe("DictionaryContent", () => {
  it("titles views by source, shows every sense with examples, and collapses other sections", () => {
    const entry = dictionaryEntry("e.1", {
      etymology: { offset: 0, total: 1, items: ["Du latin elephantus."] },
      senses: {
        offset: 0,
        total: 2,
        items: [
          dictionarySense("Mammifère", 1),
          { ...dictionarySense("Homme politique"), examples: { offset: 0, total: 0, items: [] } },
        ],
      },
    });
    const snapshot: NavigatorDictionarySnapshot = {
      lookup: {
        state: "ready",
        result: {
          request: { requestId: "r", text: "éléphant", language: "fr", initiator: "selection" },
          lookup: {
            requestId: "r",
            query: "éléphant",
            views: [
              {
                viewId: "fr",
                outcome: {
                  type: "completed",
                  truncated: false,
                  entries: [{ matchClass: "authored-headword", entry }],
                },
              },
              { viewId: "fr-en", outcome: { type: "no-entry" } },
            ],
          },
          details: { "e.1": { state: "loaded" } },
          sections: {},
        },
      },
      history: [],
      playback: null,
    };
    render(
      <DictionaryContent
        snapshot={snapshot}
        views={dictionaryViews}
        onLookup={vi.fn()}
        onLoadSection={vi.fn()}
        onPlay={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const view = screen.getByRole("region", { name: "French Wiktionary" });
    expect(screen.queryByRole("region", { name: /English/ })).not.toBeInTheDocument();
    expect(within(view).getByRole("heading", { name: "éléphant" })).toHaveAttribute("lang", "fr");
    expect(within(view).getByText("Mammifère")).toBeVisible();
    expect(within(view).getByText("Homme politique")).toBeVisible();
    expect(within(view).getByText(dictionaryExample("Mammifère 0").text)).toBeVisible();
    expect(within(view).getByRole("button", { name: "Etymology" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(view).getByRole("button", { name: "Play pronunciation" })).toBeInTheDocument();
  });
});
