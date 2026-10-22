export const ROLL_NAMESPACE = "epub-navigator-roll";
export const ROLL_MAX_DELTA = 16_384;

export function rollRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rollIdentity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Bound traversal before applying the existing, more detailed agent request codecs. */
export function boundedRollTarget(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let characters = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (++nodes > 4096 || entry.depth > 32) return false;
    if (typeof entry.value === "string") {
      characters += entry.value.length;
      if (characters > 65_536) return false;
    } else if (isRecord(entry.value)) {
      const record = entry.value;
      if (seen.has(record)) return false;
      seen.add(record);
      for (const key in record) {
        characters += key.length;
        if (characters > 65_536) return false;
        if (pending.length + nodes >= 4096) return false;
        pending.push({ value: record[key], depth: entry.depth + 1 });
      }
    }
  }
  return true;
}
