import type { DocumentAdapter } from "../../../generated/kernel.js";
import type { AgentInputPolicy, AgentConfiguration } from "../types.js";
import { isRecord } from "./primitives.js";

export function normalizeInputPolicy(value: unknown): AgentInputPolicy | null {
  if (!isRecord(value)) return null;
  const { keyboardMode, progressionDirection, selectionMenu } = value;
  if (
    (keyboardMode !== "off" && keyboardMode !== "standard" && keyboardMode !== "vim") ||
    typeof value.touchZones !== "boolean" ||
    (value.clickZones !== undefined && typeof value.clickZones !== "boolean") ||
    (progressionDirection !== "ltr" && progressionDirection !== "rtl") ||
    (selectionMenu !== "native" && selectionMenu !== "reader") ||
    (value.notes !== undefined && value.notes !== "navigate" && value.notes !== "show")
  )
    return null;
  return {
    keyboardMode,
    touchZones: value.touchZones,
    ...(value.clickZones === undefined ? {} : { clickZones: value.clickZones }),
    progressionDirection,
    selectionMenu,
    ...(value.notes === undefined ? {} : { notes: value.notes }),
  };
}

export function normalizeConfiguration(value: unknown): AgentConfiguration | null {
  if (!isRecord(value) || !isRecord(value.appearance)) return null;
  const { rootScrollbar, decorations } = value.appearance;
  const input = normalizeInputPolicy(value.input);
  if (
    (rootScrollbar !== "publisher" && rootScrollbar !== "hidden") ||
    (decorations !== undefined && decorations !== "standard" && decorations !== "monochrome") ||
    input === null
  )
    return null;
  return {
    appearance: { rootScrollbar, ...(decorations === undefined ? {} : { decorations }) },
    input,
  };
}

export function isDocumentAdapter(value: unknown): value is DocumentAdapter {
  return (
    value === "reflowable-xhtml" ||
    value === "fixed-xhtml" ||
    value === "fixed-svg" ||
    value === "fixed-image"
  );
}
