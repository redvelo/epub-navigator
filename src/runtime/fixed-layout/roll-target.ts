import type { PointEvidence } from "../../generated/kernel.js";
import { boundedRollTarget, rollRecord } from "./roll-protocol.js";

/** Navigator extensions on a W3C SpecificResource, NOT standard spatial selectors.
 * Fractions describe the clamped viewport origin in the authored document; zoom is width-fit-relative.
 * The same extensions qualify host current-location evidence, never kernel/agent evidence.
 * Generated targets include all four keys. Imported targets require Y; X/zoom/occurrence are
 * optional (X=0, zoom=1, occurrence resolved from the caller hint or publication source).
 * A legacy reading-position sidecar may differ by at most 4*Number.EPSILON after
 * cross-language JSON serialization. The embedded target is still authoritative.
 */
export const ROLL_Y = "urn:epub-navigator:roll-progression";
export const ROLL_X = "urn:epub-navigator:roll-inline-progression";
export const ROLL_ZOOM = "urn:epub-navigator:roll-zoom";
export const ROLL_OCCURRENCE = "urn:epub-navigator:roll-occurrence";
const keys = [ROLL_Y, ROLL_X, ROLL_ZOOM, ROLL_OCCURRENCE];

export interface RollPosition {
  readonly y: number;
  readonly x: number;
  readonly zoom: number;
  readonly occurrence?: number | undefined;
}

export function rollProgressionsAgree(left: number, right: number): boolean {
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    left >= 0 &&
    left <= 1 &&
    right >= 0 &&
    right <= 1 &&
    Math.abs(left - right) <= 4 * Number.EPSILON
  );
}

export function rollExtensions(position: RollPosition): Record<string, number> {
  return {
    [ROLL_Y]: position.y,
    [ROLL_X]: position.x,
    [ROLL_ZOOM]: position.zoom,
    ...(position.occurrence === undefined ? {} : { [ROLL_OCCURRENCE]: position.occurrence }),
  };
}

export function readRollPosition(value: Record<string, unknown>): RollPosition | null {
  if (!keys.some((key) => Object.hasOwn(value, key))) return null;
  const y = value[ROLL_Y];
  const x = Object.hasOwn(value, ROLL_X) ? value[ROLL_X] : 0;
  const zoom = Object.hasOwn(value, ROLL_ZOOM) ? value[ROLL_ZOOM] : 1;
  const occurrence = value[ROLL_OCCURRENCE];
  if (
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    y < 0 ||
    y > 1 ||
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    x < 0 ||
    x > 1 ||
    typeof zoom !== "number" ||
    !Number.isFinite(zoom) ||
    zoom < 1 ||
    zoom > 4 ||
    (Object.hasOwn(value, ROLL_OCCURRENCE) &&
      (typeof occurrence !== "number" || !Number.isSafeInteger(occurrence) || occurrence < 0))
  ) {
    throw new TypeError("invalid Navigator roll target extensions");
  }
  return { y, x, zoom, ...(typeof occurrence === "number" ? { occurrence } : {}) };
}

export function parseRollTarget(targetJson: string): {
  target: Record<string, unknown>;
  position: RollPosition | null;
} {
  if (typeof targetJson !== "string" || targetJson.length > 65_536)
    throw new TypeError("roll targets are limited to 65536 characters");
  const target: unknown = JSON.parse(targetJson);
  if (!rollRecord(target) || !boundedRollTarget(target))
    throw new TypeError("invalid or oversized roll target");
  if (
    Object.hasOwn(target, "selector") &&
    !rollRecord(target.selector) &&
    !Array.isArray(target.selector)
  )
    throw new TypeError("invalid roll target selector");
  // JSON.parse discards duplicate members. Reject ambiguous top-level source/extension keys,
  // including escaped spellings, before using the parsed object as a durable target.
  const members = new Set<string>();
  let depth = 0;
  for (let i = 0; i < targetJson.length; i++) {
    const character = targetJson[i];
    if (character === '"') {
      const start = i++;
      for (; i < targetJson.length; i++) {
        if (targetJson[i] === "\\") i++;
        else if (targetJson[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/u.test(targetJson[next] ?? "x")) next++;
      if (depth === 1 && targetJson[next] === ":") {
        const key: unknown = JSON.parse(targetJson.slice(start, i + 1));
        if (typeof key !== "string") throw new TypeError("invalid roll target member");
        if (members.has(key)) throw new TypeError("duplicate roll target member");
        members.add(key);
      }
    } else if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") depth--;
  }
  return { target, position: readRollPosition(target) };
}

export function qualifyRollEvidence(
  evidence: readonly PointEvidence[],
  position: RollPosition,
): PointEvidence[] {
  const index = evidence.findIndex((item) => item.kind !== "rendered-text-context");
  return evidence.map((item, i) => (i === index ? { ...item, ...rollExtensions(position) } : item));
}

export function rollEvidencePosition(evidence: readonly PointEvidence[]): RollPosition | null {
  let position: RollPosition | null = null;
  for (const item of evidence) {
    const next = readRollPosition(item);
    if (next === null) continue;
    if (position !== null && JSON.stringify(position) !== JSON.stringify(next))
      throw new TypeError("conflicting Navigator roll point evidence");
    position = next;
  }
  return position;
}

export function kernelRollEvidence(evidence: readonly PointEvidence[]): PointEvidence[] {
  return evidence.map((item) => {
    const copy = { ...item } as PointEvidence & Record<string, unknown>;
    for (const key of keys) delete copy[key];
    return copy;
  });
}
