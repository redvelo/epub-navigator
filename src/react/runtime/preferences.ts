import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { atomEffect } from "jotai-effect";
import { useLayoutEffect } from "react";
import type { PresentationPreferences, PublicationTheme } from "../../generated/kernel.js";
import type { ReaderConfiguration } from "../../runtime/navigator/api.js";
import type { NavigatorReaderPreferences, NavigatorReaderProps } from "../public-types.js";
import { normalizeError, type ReaderError } from "../status/errors.js";
import { activeRuntimeAtom, configurationErrorAtom } from "./projection-state.js";
import {
  presentationPreferencesAtom,
  readerConfigurationAtom,
  samePresentationPreferences,
} from "./preferences-state.js";

export { defaultPreferences } from "./preferences-state.js";

export type PreferencesSetter = (
  next:
    | NavigatorReaderPreferences
    | ((current: NavigatorReaderPreferences) => NavigatorReaderPreferences),
) => void;

export function publicationThemeFallback(_theme: PublicationTheme): string {
  return "Canvas";
}

export function publicationColorScheme(
  theme: PublicationTheme,
  interfaceColor: "light" | "dark",
): PresentationPreferences["colorScheme"] {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return interfaceColor;
}

const configurationFailureAtom = atom<ReaderError | null>(null);
const presentationFailureAtom = atom<ReaderError | null>(null);

/**
 * Pushes reader configuration into the runtime whenever it changes. The store tracks which atoms
 * were read, so the trigger set cannot drift from the work the way a hand-written dependency
 * array does, and no lint suppression is needed to express it.
 */
const configurationEffect = atomEffect((get, set) => {
  const configuration = get(readerConfigurationAtom);
  // Read untracked: a runtime is constructed with the current configuration already applied, so
  // its arrival must not re-push it. Only a configuration change is a reason to configure.
  const runtime = get.peek(activeRuntimeAtom);
  if (runtime === null) return;
  let failure: ReaderError | null = null;
  try {
    runtime.configure(configuration);
  } catch (cause) {
    failure = normalizeError(cause, true);
  }
  set(configurationFailureAtom, failure);
});

const presentationEffect = atomEffect((get, set) => {
  const presentation = get(presentationPreferencesAtom);
  const runtime = get.peek(activeRuntimeAtom);
  if (runtime === null) return;
  let failure: ReaderError | null = null;
  try {
    runtime.setPresentationPreferences(presentation);
  } catch (cause) {
    failure = normalizeError(cause, false);
  }
  set(presentationFailureAtom, failure);
});

/** Publishing the combined failure separately keeps each effect from reading what it writes. */
const preferenceErrorEffect = atomEffect((get, set) => {
  set(configurationErrorAtom, get(configurationFailureAtom) ?? get(presentationFailureAtom));
});

const runtimePreferenceEffects = atom((get) => {
  get(configurationEffect);
  get(presentationEffect);
  get(preferenceErrorEffect);
});

/** Re-applies both after a failure, without waiting for a preference to change. */
export const retryRuntimePreferencesAtom = atom(null, (get, set) => {
  const runtime = get(activeRuntimeAtom);
  if (runtime === null) return;
  let configurationFailure: ReaderError | null = null;
  try {
    runtime.configure(get(readerConfigurationAtom));
  } catch (cause) {
    configurationFailure = normalizeError(cause, true);
  }
  set(configurationFailureAtom, configurationFailure);
  let presentationFailure: ReaderError | null = null;
  try {
    runtime.setPresentationPreferences(get(presentationPreferencesAtom));
  } catch (cause) {
    presentationFailure = normalizeError(cause, false);
  }
  set(presentationFailureAtom, presentationFailure);
});

function sameConfiguration(left: ReaderConfiguration, right: ReaderConfiguration): boolean {
  return (
    left.appearance.rootScrollbar === right.appearance.rootScrollbar &&
    left.appearance.decorations === right.appearance.decorations &&
    left.input.keyboardMode === right.input.keyboardMode &&
    left.input.touchZones === right.input.touchZones &&
    left.input.clickZones === right.input.clickZones &&
    left.input.progressionDirection === right.input.progressionDirection &&
    left.input.selectionMenu === right.input.selectionMenu &&
    left.input.notes === right.input.notes
  );
}

export interface RuntimePreferencesOptions {
  readonly preferences: NavigatorReaderPreferences;
  readonly colorPreference: "light" | "dark";
  readonly progressionDirection: "ltr" | "rtl";
  readonly readerSelectionMenuAvailable: boolean;
  readonly selectionMenu: NonNullable<NavigatorReaderProps["selectionMenu"]>;
  /** Whether the reader has somewhere to show a note, which is what decides the agent's part. */
  readonly showsNotes: boolean;
  /**
   * The host's display report, which also decides the decoration palette: a display that ghosts
   * is a display that keeps lightness and discards hue.
   */
  readonly interactionFeedback: NavigatorReaderProps["interactionFeedback"];
}

/** Publishes the reader's preference inputs; applying them is the store's work, not React's. */
export function useRuntimePreferences({
  preferences,
  colorPreference,
  progressionDirection,
  readerSelectionMenuAvailable,
  selectionMenu,
  showsNotes,
  interactionFeedback,
}: RuntimePreferencesOptions): () => void {
  const store = useStore();
  const configuration: ReaderConfiguration = {
    appearance: {
      rootScrollbar: "hidden",
      decorations: interactionFeedback === "minimal" ? "monochrome" : "standard",
    },
    input: {
      keyboardMode: preferences.keyboardMode,
      touchZones: preferences.touchZones,
      clickZones: preferences.clickZones ?? false,
      progressionDirection,
      selectionMenu:
        selectionMenu === "auto"
          ? readerSelectionMenuAvailable
            ? "reader"
            : "native"
          : selectionMenu,
      notes: showsNotes ? "show" : "navigate",
    },
  };
  const presentation: PresentationPreferences = {
    mode: preferences.presentationMode,
    paginationColumns: preferences.paginationColumns,
    theme: preferences.publicationTheme,
    colorScheme: publicationColorScheme(preferences.publicationTheme, colorPreference),
    typeface: preferences.publicationTypeface,
    fontScale: preferences.fontScale,
    lineHeight: preferences.lineHeight,
    letterSpacing: preferences.letterSpacing,
    wordSpacing: preferences.wordSpacing,
    paragraphSpacing: preferences.paragraphSpacing,
    textIndent: preferences.textIndent,
    measure: preferences.measure,
    alignment: preferences.alignment,
    hyphenation: preferences.hyphenation,
    rootScrollbar: "hidden",
  };
  useLayoutEffect(() => {
    // Each render builds a fresh object. Publishing one unconditionally would change the atom's
    // identity every render and re-apply to the runtime, so compare the values before writing.
    if (!sameConfiguration(store.get(readerConfigurationAtom), configuration)) {
      store.set(readerConfigurationAtom, configuration);
    }
    if (!samePresentationPreferences(store.get(presentationPreferencesAtom), presentation)) {
      store.set(presentationPreferencesAtom, presentation);
    }
  });
  useAtomValue(runtimePreferenceEffects);
  return useSetAtom(retryRuntimePreferencesAtom);
}
