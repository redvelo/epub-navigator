import { useLayoutEffect, useRef } from "react";
import { useAtom } from "jotai";
import { uncontrolledPreferencesAtom } from "./preferences-state.js";
import { useSystemColorPreference } from "../input/fullscreen.js";
import type { PreferencesSetter } from "./preferences.js";
import type { NavigatorReaderProps } from "../public-types.js";

export interface ReaderPreferencesBinding {
  readonly preferences: NonNullable<NavigatorReaderProps["preferences"]>;
  readonly setPreferences: PreferencesSetter;
  readonly colorPreference: "light" | "dark";
  readonly colorPreferenceRef: { current: "light" | "dark" };
}

/** Keeps controlled and uncontrolled preferences on one path and resolves the effective theme. */
export function useReaderPreferencesBinding({
  controlledPreferences,
  onPreferencesChange,
}: {
  readonly controlledPreferences: NavigatorReaderProps["preferences"];
  readonly onPreferencesChange: NavigatorReaderProps["onPreferencesChange"];
}): ReaderPreferencesBinding {
  const [uncontrolledPreferences, setUncontrolledPreferences] = useAtom(
    uncontrolledPreferencesAtom,
  );
  const preferences = controlledPreferences ?? uncontrolledPreferences;
  const preferencesRef = useRef(preferences);
  const systemColorPreference = useSystemColorPreference();
  const colorPreference =
    preferences.colorScheme === "light" || preferences.colorScheme === "dark"
      ? preferences.colorScheme
      : systemColorPreference;
  const colorPreferenceRef = useRef(colorPreference);
  useLayoutEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);
  return {
    preferences,
    setPreferences: (value) => {
      const next = typeof value === "function" ? value(preferencesRef.current) : value;
      preferencesRef.current = next;
      if (controlledPreferences === undefined) setUncontrolledPreferences(next);
      onPreferencesChange?.(next);
    },
    colorPreference,
    colorPreferenceRef,
  };
}
