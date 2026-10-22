import type { ReflowableLayoutMode } from "../generated/kernel.js";
import { MEDIA_OVERLAY_RATES } from "./media-overlays/rates.js";
// A type-only edge: the lists describe the host-facing preference shape but carry no React.
import type { NavigatorReaderPreferences } from "../react/public-types.js";

/**
 * Builds a value list the compiler rejects unless it names every member of `T`.
 *
 * The same shape as the key list in `runtime/presentation-keys.ts`, for the other half of the
 * problem: a preference's permitted values were written out by hand in the agent codec, in the
 * host's validator, and in each host's bootstrap guard, and nothing tied the copies together.
 * Drift showed up only at runtime, as a save the reader could request and the host refused.
 */
function exhaustiveValues<T extends string>() {
  return <const V extends readonly T[]>(
    values: Exclude<T, V[number]> extends never ? V : never,
  ): V => values;
}

type StringValuedPreference = {
  [K in keyof NavigatorReaderPreferences]-?: NavigatorReaderPreferences[K] extends string
    ? K
    : never;
}[keyof NavigatorReaderPreferences];

/**
 * Every value each reader preference admits, as the single list a host can validate against.
 *
 * `touchZones` is a boolean and `narrationSkippedTypes` an open list of structure types, so
 * neither appears here.
 */
export const navigatorReaderPreferenceValues: {
  readonly [K in StringValuedPreference]: readonly NavigatorReaderPreferences[K][];
} = Object.freeze({
  colorScheme: exhaustiveValues<NavigatorReaderPreferences["colorScheme"]>()([
    "system",
    "light",
    "dark",
  ]),
  presentationMode: exhaustiveValues<NavigatorReaderPreferences["presentationMode"]>()([
    "auto",
    "paginated",
    "document-scroll",
  ]),
  paginationColumns: exhaustiveValues<NavigatorReaderPreferences["paginationColumns"]>()([
    "auto",
    "single",
    "double",
  ]),
  publicationTheme: exhaustiveValues<NavigatorReaderPreferences["publicationTheme"]>()([
    "auto",
    "original",
    "light",
    "dark",
  ]),
  publicationTypeface: exhaustiveValues<NavigatorReaderPreferences["publicationTypeface"]>()([
    "original",
    "reader-serif",
    "reader-sans",
  ]),
  fontScale: exhaustiveValues<NavigatorReaderPreferences["fontScale"]>()([
    "80",
    "90",
    "100",
    "110",
    "125",
    "140",
    "160",
    "200",
  ]),
  lineHeight: exhaustiveValues<NavigatorReaderPreferences["lineHeight"]>()([
    "original",
    "1.25",
    "1.5",
    "1.75",
    "2",
  ]),
  letterSpacing: exhaustiveValues<NavigatorReaderPreferences["letterSpacing"]>()([
    "0",
    "0.03",
    "0.06",
    "0.12",
  ]),
  wordSpacing: exhaustiveValues<NavigatorReaderPreferences["wordSpacing"]>()([
    "0",
    "0.04",
    "0.08",
    "0.16",
  ]),
  paragraphSpacing: exhaustiveValues<NavigatorReaderPreferences["paragraphSpacing"]>()([
    "original",
    "0",
    "1",
    "2",
  ]),
  textIndent: exhaustiveValues<NavigatorReaderPreferences["textIndent"]>()([
    "original",
    "0",
    "1",
    "2",
  ]),
  measure: exhaustiveValues<NavigatorReaderPreferences["measure"]>()([
    "narrow",
    "medium",
    "wide",
    "full-width",
  ]),
  alignment: exhaustiveValues<NavigatorReaderPreferences["alignment"]>()([
    "original",
    "start",
    "justify",
  ]),
  hyphenation: exhaustiveValues<NavigatorReaderPreferences["hyphenation"]>()([
    "original",
    "auto",
    "off",
  ]),
  keyboardMode: exhaustiveValues<NavigatorReaderPreferences["keyboardMode"]>()([
    "off",
    "standard",
    "vim",
  ]),
  // The playback controller already owns this list; the type is derived from it.
  narrationRate: MEDIA_OVERLAY_RATES,
});

/**
 * The modes a document is actually laid out in, once `auto` has resolved against the flow the
 * publication asked for. The reader preference admits `auto`; a laid-out document never does.
 */
export const reflowableLayoutModes = exhaustiveValues<ReflowableLayoutMode>()([
  "paginated",
  "document-scroll",
]);

export function isReflowableLayoutMode(value: unknown): value is ReflowableLayoutMode {
  return (reflowableLayoutModes as readonly unknown[]).includes(value);
}

export function isPreferenceValue<K extends StringValuedPreference>(
  preference: K,
  value: unknown,
): value is NavigatorReaderPreferences[K] {
  return (navigatorReaderPreferenceValues[preference] as readonly unknown[]).includes(value);
}
