import type { PaginationCacheIdentity } from "./contract.js";

export function isCacheIdentity(value: PaginationCacheIdentity): boolean {
  return /^[0-9a-f]{64}$/u.test(value.measurementArtifactDigest);
}

export async function sha256(subtle: SubtleCrypto, value: string): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
