import { useEffect, useRef } from "react";
import { Minus, Plus, X } from "lucide-react";
import type { FixedViewState } from "../../runtime/navigator/api.js";
import { Button } from "../components/ui/button.js";

export function FixedZoomControls({
  state,
  onZoom,
}: {
  readonly state: FixedViewState;
  readonly onZoom: (zoom: number) => void;
}) {
  const percentage = Math.round(state.zoom * 100);
  const step = (direction: -1 | 1) => Math.round((state.zoom + direction * 0.25) * 100) / 100;
  return (
    <div
      className="epub-navigator-reader__fixed-zoom-controls"
      role="group"
      aria-label="Fixed page zoom"
    >
      <div className="epub-navigator-reader__fixed-zoom-segments">
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          data-rhea-local-action
          className="rounded-none focus-visible:ring-inset"
          aria-label="Zoom out"
          disabled={state.zoom <= state.minimumZoom}
          onClick={() => onZoom(step(-1))}
        >
          <Minus aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-w-20 rounded-none focus-visible:ring-inset"
          aria-label="Reset zoom to fit"
          disabled={state.zoom === state.minimumZoom}
          onClick={() => onZoom(state.minimumZoom)}
        >
          {state.zoom === state.minimumZoom ? "Fit" : `${percentage}%`}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          data-rhea-local-action
          className="rounded-none focus-visible:ring-inset"
          aria-label="Zoom in"
          disabled={state.zoom >= state.maximumZoom}
          onClick={() => onZoom(step(1))}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
      <span className="sr-only" aria-live="polite">
        Zoom {percentage} percent
      </span>
    </div>
  );
}

export function ZoomAdjustment({
  state,
  onZoom,
  onClose,
}: {
  readonly state: FixedViewState;
  readonly onZoom: (zoom: number) => void;
  readonly onClose: () => void;
}) {
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => toolbar.current?.querySelector<HTMLButtonElement>("button")?.focus(), []);
  return (
    <div
      ref={toolbar}
      className="epub-navigator-reader__zoom-adjustment"
      role="toolbar"
      aria-label="Fixed page zoom controls"
    >
      <FixedZoomControls state={state} onZoom={onZoom} />
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        data-rhea-local-action
        className="epub-navigator-reader__zoom-adjustment-close rounded-none focus-visible:ring-inset"
        aria-label="Close zoom controls"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
