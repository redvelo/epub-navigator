import { atom } from "jotai";
import type { PresentationPreferences } from "../../generated/kernel.js";
import type { ReaderConfiguration } from "../../runtime/navigator/api.js";
import type { NavigatorReaderPreferences } from "../public-types.js";
import { samePresentationValues } from "../../runtime/presentation-keys.js";

export const defaultPreferences: NavigatorReaderPreferences = {
  colorScheme: "system",
  presentationMode: "auto",
  paginationColumns: "auto",
  publicationTheme: "original",
  publicationTypeface: "original",
  fontScale: "100",
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
  clickZones: false,
  narrationRate: "1",
  narrationSkippedTypes: [],
};

export const uncontrolledPreferencesAtom = atom(defaultPreferences);

export const readerConfigurationAtom = atom<ReaderConfiguration>({
  appearance: {
    rootScrollbar: "hidden",
  },
  input: {
    keyboardMode: "standard",
    touchZones: true,
    progressionDirection: "ltr",
    selectionMenu: "native",
  },
});

export const presentationPreferencesAtom = atom<PresentationPreferences>({
  mode: defaultPreferences.presentationMode,
  paginationColumns: defaultPreferences.paginationColumns,
  theme: defaultPreferences.publicationTheme,
  colorScheme: "light",
  typeface: defaultPreferences.publicationTypeface,
  fontScale: defaultPreferences.fontScale,
  lineHeight: defaultPreferences.lineHeight,
  letterSpacing: defaultPreferences.letterSpacing,
  wordSpacing: defaultPreferences.wordSpacing,
  paragraphSpacing: defaultPreferences.paragraphSpacing,
  textIndent: defaultPreferences.textIndent,
  measure: defaultPreferences.measure,
  alignment: defaultPreferences.alignment,
  hyphenation: defaultPreferences.hyphenation,
  rootScrollbar: "hidden" as const,
});

export function samePresentationPreferences(
  left: PresentationPreferences,
  right: PresentationPreferences,
): boolean {
  return samePresentationValues(left, right);
}
