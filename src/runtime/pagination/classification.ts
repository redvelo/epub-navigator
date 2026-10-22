import type {
  AdapterLayoutSettlement,
  FixedSettlement,
  ReflowableSettlement,
} from "../../generated/kernel.js";
import type { OccurrencePagination } from "./types.js";

export function isTerminalEntry(entry: OccurrencePagination): boolean {
  return entry.state !== "pending" && entry.state !== "measuring";
}

export function entryTerminalizesTargets(entry: OccurrencePagination): boolean {
  return (
    entry.state === "inapplicable" || entry.state === "unavailable" || entry.state === "failed"
  );
}

export function reflowableSettlement(layout: AdapterLayoutSettlement): ReflowableSettlement | null {
  return layout.adapter === "reflowable-xhtml" ? layout.settlement : null;
}

export function fixedSettlement(layout: AdapterLayoutSettlement): FixedSettlement | null {
  return layout.adapter === "fixed-xhtml" ||
    layout.adapter === "fixed-svg" ||
    layout.adapter === "fixed-image"
    ? layout.settlement
    : null;
}

export function fixedAdapterUnavailableReason(adapter: string): string {
  if (adapter === "fixed-image") return "fixed-image-layout-unavailable";
  return adapter === "fixed-svg"
    ? "fixed-svg-layout-unavailable"
    : "fixed-xhtml-layout-unavailable";
}

export function layoutSettlementTimedOut(layout: ReflowableSettlement | null): boolean {
  return (
    layout?.measurement.requiredFonts === "timed-out" ||
    layout?.measurement.requiredResources === "timed-out"
  );
}

export function layoutSettlementIsDurable(layout: ReflowableSettlement | null): boolean {
  return (
    layout?.measurement.requiredFonts === "loaded" &&
    layout.measurement.requiredResources === "loaded"
  );
}
