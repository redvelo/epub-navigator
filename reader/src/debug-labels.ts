import * as preferences from "./preferences.ts";
import * as publicationState from "./publication-state.ts";

function labelled(value: unknown): value is { debugLabel?: string } {
  return typeof value === "object" && value !== null && "read" in value;
}

/** Names this application's own atoms for the inspector. Development only. */
export function applyReaderAppAtomDebugLabels(): void {
  for (const module of [preferences, publicationState] as Record<string, unknown>[]) {
    for (const [name, value] of Object.entries(module)) {
      if (labelled(value) && value.debugLabel === undefined) value.debugLabel = name;
    }
  }
}
