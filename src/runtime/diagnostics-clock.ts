export class DiagnosticsClock {
  readonly #source: (() => number) | undefined;
  #last: number | null = null;
  #lastFallback = safePerformanceNow();

  constructor(source?: () => number) {
    this.#source = source;
  }

  now(): number {
    const fallback = safePerformanceNow();
    let candidate: number | undefined;
    try {
      candidate = this.#source?.();
    } catch {
      // A diagnostics clock is an observer and cannot affect runtime behavior.
    }
    const next =
      candidate !== undefined &&
      Number.isFinite(candidate) &&
      (this.#last === null || candidate >= this.#last)
        ? candidate
        : this.#last === null
          ? fallback
          : this.#last + Math.max(0, fallback - this.#lastFallback);
    this.#last = next;
    this.#lastFallback = fallback;
    return next;
  }
}

function safePerformanceNow(): number {
  try {
    const value = performance.now();
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  } catch {
    return 0;
  }
}
