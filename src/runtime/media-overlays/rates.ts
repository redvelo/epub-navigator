/**
 * Pitch-preserving narration rates.
 *
 * A leaf module on purpose: the playback controller reaches the agent protocol, and the
 * protocol's layout codec reaches the shared preference lists, so defining these in the
 * controller put a cycle between them and left the codec reading uninitialized bindings.
 */
export const MEDIA_OVERLAY_RATES = [
  "0.5",
  "0.75",
  "1",
  "1.25",
  "1.5",
  "1.75",
  "2",
  "2.5",
  "3",
] as const;

export type NavigatorMediaOverlayRate = (typeof MEDIA_OVERLAY_RATES)[number];

export function isNavigatorMediaOverlayRate(value: unknown): value is NavigatorMediaOverlayRate {
  return MEDIA_OVERLAY_RATES.some((rate) => rate === value);
}
