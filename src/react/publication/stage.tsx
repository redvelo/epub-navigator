import type { Ref } from "react";
import { cn } from "../lib/utils.js";
import { publicationColorScheme } from "../runtime/preferences.js";
import type { NavigatorReaderPreferences } from "../public-types.js";
import {
  SelectionAnnotationOverlays,
  type SelectionAnnotationOverlaysProps,
} from "../annotations/selection-overlays.js";
import { PublicationStatus, type PublicationStatusProps } from "../status/publication-status.js";

export interface PublicationStageProps {
  readonly frameHost: Ref<HTMLDivElement>;
  readonly surround: string;
  readonly canvasUnavailable: boolean;
  readonly initialRestorationPending: boolean;
  readonly preferences: NavigatorReaderPreferences;
  readonly colorPreference: "light" | "dark";
  readonly onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: () => void;
  readonly overlays: SelectionAnnotationOverlaysProps;
  readonly status: PublicationStatusProps;
}

export function PublicationStage({
  frameHost,
  surround,
  canvasUnavailable,
  initialRestorationPending,
  preferences,
  colorPreference,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  overlays,
  status,
}: PublicationStageProps) {
  return (
    <main
      className="epub-navigator-reader__publication-region"
      style={{
        backgroundColor: surround,
        colorScheme: publicationColorScheme(preferences.publicationTheme, colorPreference),
      }}
      aria-label="Publication reading area"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div
        ref={frameHost}
        className={cn(
          "epub-navigator-reader__publication-host absolute inset-0",
          canvasUnavailable && "epub-navigator-reader__publication-host--mat",
        )}
        data-initial-restoration={initialRestorationPending ? "pending" : undefined}
        aria-hidden={initialRestorationPending || undefined}
      />
      <SelectionAnnotationOverlays {...overlays} />
      <PublicationStatus {...status} />
    </main>
  );
}
