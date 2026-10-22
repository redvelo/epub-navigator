import { describe, expect, it } from "vitest";
import { DiagnosticsClock } from "../src/runtime/diagnostics-clock.js";

describe("diagnostics clock", () => {
  it("falls back from throwing, non-finite, and regressing observer values", () => {
    const values: (number | Error)[] = [
      100,
      Number.NaN,
      90,
      new Error("clock failed"),
      Infinity,
      120,
    ];
    const clock = new DiagnosticsClock(() => {
      const value = values.shift();
      if (value instanceof Error) throw value;
      return value ?? 120;
    });
    const samples = Array.from({ length: 6 }, () => clock.now());

    expect(samples.every(Number.isFinite)).toBe(true);
    expect(samples).toEqual(samples.toSorted((left, right) => left - right));
  });
});
