import {
  MAX_MEDIA_OVERLAY_CLASS_TOKENS,
  MAX_MEDIA_OVERLAY_CLASS_TOKEN_LENGTH,
  MAX_MEDIA_OVERLAY_ENTRY_FRAGMENTS,
} from "../limits.js";
import { isBoundedString } from "./primitives.js";

export function isMediaOverlayFragment(value: unknown): value is string {
  return isBoundedString(value) && value.length > 0;
}

export function isMediaOverlayClassTokens(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_MEDIA_OVERLAY_CLASS_TOKENS &&
    value.every(
      (token) =>
        typeof token === "string" &&
        token.length > 0 &&
        token.length <= MAX_MEDIA_OVERLAY_CLASS_TOKEN_LENGTH &&
        !/[\s]/.test(token),
    )
  );
}

export function isMediaOverlayFragmentList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_MEDIA_OVERLAY_ENTRY_FRAGMENTS &&
    value.every(isMediaOverlayFragment)
  );
}
