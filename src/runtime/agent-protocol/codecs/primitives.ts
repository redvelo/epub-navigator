import type { ContentAgentOperation } from "../types.js";
import { MAX_PROTOCOL_STRING, MAX_ANNOTATION_AGGREGATE_STRING_BYTES } from "../limits.js";

export function isBoundedUtf8String(value: unknown): value is string {
  return typeof value === "string" && utf8ByteLength(value) <= MAX_PROTOCOL_STRING;
}

export function isCanonicalBrowserTextOffset(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    BigInt(value) <= 0xffff_ffff_ffff_ffffn
  );
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > MAX_ANNOTATION_AGGREGATE_STRING_BYTES) return bytes;
    if (codePoint > 0xffff) index += 1;
  }
  return bytes;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PROTOCOL_STRING;
}

export function isOperation(value: unknown): value is ContentAgentOperation {
  return (
    value === "resolve-locator" ||
    value === "relocate" ||
    value === "resolve-annotation-target" ||
    value === "relocate-annotation-target" ||
    value === "capture-selection" ||
    value === "capture-current-location" ||
    value === "generate-annotation-target" ||
    value === "generate-current-location-annotation-target" ||
    value === "reconcile-decorations" ||
    value === "adjust-annotation-range" ||
    value === "advance-presentation" ||
    value === "find-media-overlay-entry" ||
    value === "layout" ||
    value === "measure-toc-targets" ||
    value === "observe-document"
  );
}

export function isOperationId(value: unknown): value is number {
  return isIntegerNumber(value) && value >= 0 && value <= 0xffff_ffff;
}

export function isArrayOf<T>(
  value: unknown,
  item: (candidate: unknown) => candidate is T,
): value is T[] {
  return Array.isArray(value) && value.every((candidate: unknown) => item(candidate));
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function isNonnegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

export function isNonnegativeInteger(value: unknown): value is number {
  return isIntegerNumber(value) && value >= 0 && value <= 0xffff_ffff;
}

export function isPositiveInteger(value: unknown): value is number {
  return isIntegerNumber(value) && value > 0 && value <= 0xffff_ffff;
}

export function isProgression(value: unknown): value is number {
  return isNonnegativeFinite(value) && value <= 1;
}

export function safely<T>(normalize: () => T | null): T | null {
  try {
    return normalize();
  } catch {
    return null;
  }
}
