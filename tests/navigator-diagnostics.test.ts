import { describe, expect, it, vi } from "vitest";
import {
  recordNavigatorDiagnostic,
  type NavigatorDiagnosticEvent,
} from "../src/runtime/pagination/index.js";

const traceEvent: NavigatorDiagnosticEvent = {
  type: "controller-update",
  sequence: 1,
  stateRevision: 2,
  documentPending: false,
  layoutOwner: null,
};

const summaryEvent: NavigatorDiagnosticEvent = {
  type: "pagination-run",
  action: "terminal",
  runRevision: 3,
  durationMs: 12,
  measuredOccurrences: 2,
  totalOccurrences: 2,
  measuredPageCount: 5,
  totalPageCount: 5,
  measuredTargets: 1,
  totalTargets: 1,
  outcome: "complete",
  pageCountAttempts: 2,
  timedOutOccurrences: 0,
  measurementMs: 8,
};

const cacheDrainEvent: NavigatorDiagnosticEvent = {
  type: "cache-drain",
  runRevision: 3,
  outcome: "durable",
  durationMs: 4,
};

const fontEvidenceEvent: NavigatorDiagnosticEvent = {
  type: "font-evidence",
  target: "publication",
  family: "navigator-reader-serif",
  frameGeneration: 4,
  configured: true,
  declared: true,
  loaded: true,
  check: true,
};

describe("navigator diagnostics", () => {
  it("delivers only the closed summary event set at summary level", () => {
    const record = vi.fn();
    const diagnostics = { level: "summary" as const, record };

    recordNavigatorDiagnostic(diagnostics, traceEvent);
    recordNavigatorDiagnostic(diagnostics, summaryEvent);
    recordNavigatorDiagnostic(diagnostics, cacheDrainEvent);
    recordNavigatorDiagnostic(diagnostics, fontEvidenceEvent);

    expect(record).toHaveBeenCalledTimes(3);
    expect(record).toHaveBeenNthCalledWith(1, summaryEvent);
    expect(record).toHaveBeenNthCalledWith(2, cacheDrainEvent);
    expect(record).toHaveBeenNthCalledWith(3, fontEvidenceEvent);
  });

  it("delivers all events at trace level and keeps delivery passive", () => {
    const record = vi.fn(() => {
      throw new Error("observer failed");
    });
    const diagnostics = { level: "trace" as const, record };

    expect(() => recordNavigatorDiagnostic(diagnostics, traceEvent)).not.toThrow();
    expect(record).toHaveBeenCalledWith(traceEvent);
  });
});
