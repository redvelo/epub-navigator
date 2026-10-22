import type { NavigatorReaderWorkspaceState } from "../public-types.js";

export type WorkspaceSurface = "settings" | "publication-details" | "zoom" | null;

export const defaultWorkspaceState: NavigatorReaderWorkspaceState = {
  navigation: { open: false, pinned: false, width: 280 },
  annotations: { open: false, pinned: false, width: 280 },
};

export function panelLabel(side: "navigation" | "annotations"): string {
  return side === "navigation" ? "Navigation" : "Annotations";
}

export function effectiveWorkspacePanels(
  state: NavigatorReaderWorkspaceState,
  width: number | null,
): {
  readonly navigation: "closed" | "pinned" | "overlay";
  readonly annotations: "closed" | "pinned" | "overlay";
} {
  if (width === null) return { navigation: "closed", annotations: "closed" };
  let remaining = width;
  const navigation = !state.navigation.open
    ? "closed"
    : state.navigation.pinned && remaining >= 576 + state.navigation.width
      ? "pinned"
      : "overlay";
  if (navigation === "pinned") remaining -= state.navigation.width;
  const annotations = !state.annotations.open
    ? "closed"
    : state.annotations.pinned && remaining >= 576 + state.annotations.width
      ? "pinned"
      : "overlay";
  return { navigation, annotations };
}

export function workspacePanelPinAvailability(
  state: NavigatorReaderWorkspaceState,
  effective: ReturnType<typeof effectiveWorkspacePanels>,
  width: number | null,
): { readonly navigation: boolean; readonly annotations: boolean } {
  if (width === null) return { navigation: false, annotations: false };
  return {
    navigation:
      width >=
      576 +
        state.navigation.width +
        (effective.annotations === "pinned" ? state.annotations.width : 0),
    annotations:
      width >=
      576 +
        state.annotations.width +
        (effective.navigation === "pinned" ? state.navigation.width : 0),
  };
}

export function normalizeWorkspaceState(
  state: NavigatorReaderWorkspaceState,
): NavigatorReaderWorkspaceState {
  return {
    navigation: { ...state.navigation, width: clampPanelWidth(state.navigation.width) },
    annotations: { ...state.annotations, width: clampPanelWidth(state.annotations.width) },
  };
}

export function clampPanelWidth(width: number): number {
  return Math.min(480, Math.max(224, Math.round(width)));
}
