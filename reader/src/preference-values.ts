import type { NavigatorReaderPreferences } from "epub-navigator/react";

const narrationRates: readonly NavigatorReaderPreferences["narrationRate"][] = [
  "0.5",
  "0.75",
  "1",
  "1.25",
  "1.5",
  "1.75",
  "2",
  "2.5",
  "3",
];

export const defaultReaderPreferences: NavigatorReaderPreferences = {
  colorScheme: "system",
  presentationMode: "auto",
  paginationColumns: "auto",
  publicationTheme: "auto",
  publicationTypeface: "reader-serif",
  fontScale: "125",
  lineHeight: "original",
  letterSpacing: "0",
  wordSpacing: "0",
  paragraphSpacing: "original",
  textIndent: "original",
  measure: "wide",
  alignment: "original",
  hyphenation: "original",
  keyboardMode: "standard",
  touchZones: true,
  narrationRate: "1",
  narrationSkippedTypes: [],
};

export function normalizeStoredReaderPreferences(
  value: unknown,
  initialValue: NavigatorReaderPreferences = defaultReaderPreferences,
): NavigatorReaderPreferences {
  if (!isRecord(value)) return initialValue;
  const candidate = value;
  if (
    !isOneOf(candidate.colorScheme, ["system", "light", "dark"]) ||
    !isOneOf(candidate.keyboardMode, ["off", "standard", "vim"]) ||
    typeof candidate.touchZones !== "boolean"
  ) {
    return initialValue;
  }
  const legacyTypeface = candidate.fontFamily;
  return {
    colorScheme: candidate.colorScheme,
    presentationMode: oneOf(
      candidate.presentationMode,
      ["auto", "paginated", "document-scroll"],
      initialValue.presentationMode,
    ),
    paginationColumns: oneOf(
      candidate.paginationColumns,
      ["auto", "single", "double"],
      initialValue.paginationColumns,
    ),
    publicationTheme:
      candidate.publicationTheme === "publisher"
        ? "original"
        : candidate.publicationTheme === "night"
          ? "dark"
          : candidate.publicationTheme === "sepia" ||
              candidate.publicationTheme === "paper" ||
              candidate.publicationTheme === "white" ||
              candidate.publicationTheme === "e-ink"
            ? "light"
            : oneOf(
                candidate.publicationTheme,
                ["auto", "original", "light", "dark"],
                initialValue.publicationTheme,
              ),
    publicationTypeface:
      legacyTypeface === "literata"
        ? "reader-serif"
        : legacyTypeface === "publisher"
          ? "original"
          : oneOf(
              candidate.publicationTypeface,
              ["original", "reader-serif", "reader-sans"],
              initialValue.publicationTypeface,
            ),
    // A stored authored-root choice becomes the equivalent percentage: the two rendered
    // identically unless the publication fixed its own root size.
    fontScale:
      candidate.fontScale === "original"
        ? "100"
        : oneOf(
            candidate.fontScale,
            ["80", "90", "100", "110", "125", "140", "160", "200"],
            initialValue.fontScale,
          ),
    lineHeight: oneOf(
      candidate.lineHeight,
      ["original", "1.25", "1.5", "1.75", "2"],
      initialValue.lineHeight,
    ),
    letterSpacing: oneOf(
      candidate.letterSpacing,
      ["0", "0.03", "0.06", "0.12"],
      initialValue.letterSpacing,
    ),
    wordSpacing: oneOf(
      candidate.wordSpacing,
      ["0", "0.04", "0.08", "0.16"],
      initialValue.wordSpacing,
    ),
    paragraphSpacing: oneOf(
      candidate.paragraphSpacing,
      ["original", "0", "1", "2"],
      initialValue.paragraphSpacing,
    ),
    textIndent: oneOf(candidate.textIndent, ["original", "0", "1", "2"], initialValue.textIndent),
    measure:
      candidate.measure === "comfortable"
        ? "wide"
        : oneOf(
            candidate.measure,
            ["narrow", "medium", "wide", "full-width"],
            initialValue.measure,
          ),
    alignment: oneOf(candidate.alignment, ["original", "start", "justify"], initialValue.alignment),
    hyphenation: oneOf(
      candidate.hyphenation,
      ["original", "auto", "off"],
      initialValue.hyphenation,
    ),
    keyboardMode: candidate.keyboardMode,
    touchZones: candidate.touchZones,
    narrationRate: isOneOf(candidate.narrationRate, narrationRates)
      ? candidate.narrationRate
      : initialValue.narrationRate,
    narrationSkippedTypes: isSkippedTypeList(candidate.narrationSkippedTypes)
      ? [...new Set(candidate.narrationSkippedTypes)]
      : initialValue.narrationSkippedTypes,
  };
}

function isSkippedTypeList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (type: unknown) => typeof type === "string" && type.length > 0 && type.length <= 256,
    )
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOneOf<const T extends string>(value: unknown, values: readonly T[]): value is T {
  return values.some((candidate) => candidate === value);
}

function oneOf<const T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return isOneOf(value, values) ? value : fallback;
}
