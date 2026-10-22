import { expect, it } from "vitest";
import { normalizeStoredReaderPreferences } from "../reader/src/preference-values.js";

const stored = { colorScheme: "system", keyboardMode: "off", touchZones: true };

it.each([
  [
    "removed and renamed appearance values",
    {
      paginationColumns: "auto",
      publicationTheme: "sepia",
      fontFamily: "literata",
      fontScale: "100",
      measure: "comfortable",
    },
    {
      publicationTheme: "light",
      publicationTypeface: "reader-serif",
      fontScale: "100",
      measure: "wide",
    },
  ],
  [
    "a presentation that follows the publication, which is a reader preference again",
    { presentationMode: "auto" },
    { presentationMode: "auto" },
  ],
  [
    "an authored root text size into its equivalent percentage",
    { fontScale: "original" },
    { fontScale: "100" },
  ],
  [
    "out-of-range spacing back to its default",
    { letterSpacing: "0.5", wordSpacing: "nope", paragraphSpacing: "3", textIndent: "1" },
    { letterSpacing: "0", wordSpacing: "0", paragraphSpacing: "original", textIndent: "1" },
  ],
  [
    "the e-ink palette",
    { renderingMode: "standard", publicationTheme: "e-ink" },
    { publicationTheme: "light" },
  ],
  ["paper book colors", { publicationTheme: "paper" }, { publicationTheme: "light" }],
  ["white book colors", { publicationTheme: "white" }, { publicationTheme: "light" }],
  ["night book colors", { publicationTheme: "night" }, { publicationTheme: "dark" }],
])("migrates stored %s", (_, legacy, expected) => {
  const preferences = normalizeStoredReaderPreferences({ ...stored, ...legacy });
  expect(preferences).toMatchObject(expected);
  expect(preferences).not.toHaveProperty("renderingMode");
});
