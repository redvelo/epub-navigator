import type { OccurrencePagination } from "./types.js";

export interface PageEstimate {
  readonly total: number;
  readonly counts: readonly number[];
  readonly starts: readonly number[];
}

const minimumCalibrationPages = 4;

// Calibrates pages-per-byte on the measured reflowable occurrences and applies it to the rest.
// Weight 0 marks an occurrence whose bytes say nothing about its pages (fixed layout, unknown
// size); those estimate as one page. Page counts are quantized: a one-page document may hold
// a tenth of a page of text (covers, footnote files), so only multi-page documents inform the
// rate, and a few such pages must be measured before an estimate is published.
export function calibratedPageEstimate(
  entries: Iterable<OccurrencePagination>,
  weights: readonly number[],
): PageEstimate | null {
  let measuredPages = 0;
  let measuredWeight = 0;
  const list = [...entries];
  for (const entry of list) {
    const weight = weights[entry.occurrence] ?? 0;
    if (entry.state !== "measured" || entry.pageCount < 2 || weight <= 0) continue;
    measuredPages += entry.pageCount;
    measuredWeight += weight;
  }
  if (measuredPages < minimumCalibrationPages) return null;
  const rate = measuredPages / measuredWeight;
  const counts: number[] = [];
  const starts: number[] = [];
  let total = 0;
  for (const entry of list) {
    starts[entry.occurrence] = total;
    let count: number;
    if (entry.state === "measured") count = entry.pageCount;
    else if (entry.state === "inapplicable") count = 0;
    else {
      const weight = weights[entry.occurrence] ?? 0;
      count = weight > 0 ? Math.max(1, Math.round(weight * rate)) : 1;
    }
    counts[entry.occurrence] = count;
    total += count;
  }
  return Object.freeze({ total, counts: Object.freeze(counts), starts: Object.freeze(starts) });
}
