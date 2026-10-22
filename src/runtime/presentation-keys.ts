import type { PresentationPreferences, ReflowablePresentation } from "../generated/kernel.js";

/**
 * Builds a key list the compiler rejects unless it names every key of `T`.
 *
 * Presentation comparisons decide whether a preference change reaches the content agent, so a
 * key omitted from one is a control that silently does nothing. Listing the keys once, under a
 * check that fails on an unlisted key, makes the next preference impossible to forget.
 */
function exhaustiveKeys<T>() {
  return <const K extends readonly (keyof T)[]>(
    keys: Exclude<keyof T, K[number]> extends never ? K : never,
  ): K => keys;
}

export const presentationKeys = exhaustiveKeys<PresentationPreferences>()([
  "mode",
  "paginationColumns",
  "theme",
  "colorScheme",
  "typeface",
  "fontScale",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "paragraphSpacing",
  "textIndent",
  "measure",
  "alignment",
  "hyphenation",
  "rootScrollbar",
]);

/** The authored keys the agent's presentation carries beyond the reader's preferences. */
export const authoredPresentationKeys = exhaustiveKeys<
  Omit<ReflowablePresentation, (typeof presentationKeys)[number]>
>()(["alignXCenter"]);

const reflowableKeys = [...presentationKeys, ...authoredPresentationKeys];

export function samePresentationValues(
  left: PresentationPreferences,
  right: PresentationPreferences,
): boolean {
  return presentationKeys.every((key) => left[key] === right[key]);
}

/** Theme is excluded where a color change must not cost a relayout. */
export function samePresentationValuesExceptTheme(
  left: ReflowablePresentation,
  right: ReflowablePresentation,
): boolean {
  return reflowableKeys.every((key) => key === "theme" || left[key] === right[key]);
}
