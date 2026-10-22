import { atomWithStorage } from "jotai/utils";
import type {
  NavigatorReaderPreferences,
  NavigatorReaderWorkspaceState,
} from "epub-navigator/react";
import {
  defaultReaderPreferences,
  isRecord,
  normalizeStoredReaderPreferences,
} from "./preference-values.js";

const storage = {
  getItem(_key: string, initialValue: NavigatorReaderPreferences): NavigatorReaderPreferences {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(_key) ?? "null");
      return normalizeStoredReaderPreferences(value, initialValue);
    } catch {
      return initialValue;
    }
  },
  setItem(key: string, value: NavigatorReaderPreferences): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Persistence is best effort; Jotai still owns the current in-memory value.
    }
  },
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // Persistence is best effort.
    }
  },
};

export const readerPreferencesAtom = atomWithStorage<NavigatorReaderPreferences>(
  "epub-navigator.preferences",
  defaultReaderPreferences,
  storage,
  { getOnInit: true },
);

export const defaultWorkspaceState: NavigatorReaderWorkspaceState = {
  navigation: { open: false, pinned: false, width: 280 },
  annotations: { open: false, pinned: false, width: 280 },
};

type ReaderWorkspaceStates = Readonly<Record<string, NavigatorReaderWorkspaceState>>;

const workspaceStorage = {
  getItem(key: string, initialValue: ReaderWorkspaceStates): ReaderWorkspaceStates {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      if (typeof value !== "object" || value === null || Array.isArray(value)) return initialValue;
      return Object.fromEntries(
        Object.entries(value).flatMap(([id, candidate]) => {
          const normalized = normalizeWorkspaceState(candidate);
          return normalized === null ? [] : [[id, normalized]];
        }),
      );
    } catch {
      return initialValue;
    }
  },
  setItem(key: string, value: ReaderWorkspaceStates): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Persistence is best effort; Jotai still owns the current in-memory value.
    }
  },
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // Persistence is best effort.
    }
  },
};

export const readerWorkspaceStatesAtom = atomWithStorage<ReaderWorkspaceStates>(
  "epub-navigator.workspaces",
  {},
  workspaceStorage,
  { getOnInit: true },
);

function normalizeWorkspaceState(value: unknown): NavigatorReaderWorkspaceState | null {
  if (!isRecord(value)) return null;
  const candidate = value;
  const navigation = normalizeWorkspacePanel(candidate.navigation);
  const annotations = normalizeWorkspacePanel(candidate.annotations);
  return navigation === null || annotations === null ? null : { navigation, annotations };
}

function normalizeWorkspacePanel(
  value: unknown,
): NavigatorReaderWorkspaceState["navigation"] | null {
  if (!isRecord(value)) return null;
  const candidate = value;
  if (
    typeof candidate.open !== "boolean" ||
    typeof candidate.pinned !== "boolean" ||
    typeof candidate.width !== "number" ||
    !Number.isFinite(candidate.width)
  ) {
    return null;
  }
  return {
    open: candidate.open,
    pinned: candidate.pinned,
    width: Math.min(480, Math.max(224, Math.round(candidate.width))),
  };
}
