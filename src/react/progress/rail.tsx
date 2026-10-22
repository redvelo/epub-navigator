import { useRef, type ReactNode } from "react";
import type { ReaderProgressProjection } from "../progress/projection.js";
import { cn } from "../lib/utils.js";

export function CompactBottomRail({
  className,
  projection,
  progression,
  section,
  sectionPages,
  onOpen,
  onSectionOpen,
  narration,
  narrationCovered = false,
}: {
  readonly className?: string | undefined;
  readonly projection: ReaderProgressProjection;
  readonly progression: "ltr" | "rtl";
  readonly section: string;
  readonly sectionPages: string | null;
  readonly onOpen?: (() => void) | undefined;
  readonly onSectionOpen?: (() => void) | undefined;
  readonly narration?: ReactNode | undefined;
  readonly narrationCovered?: boolean | undefined;
}) {
  const pointerStart = useRef<number | null>(null);
  const openedBySwipe = useRef(false);
  const railCoordinate = (coordinate: number) =>
    progression === "rtl" ? 1 - coordinate : coordinate;
  return (
    <footer className={cn("epub-navigator-reader__compact-bottom-rail", className)}>
      <div
        className="epub-navigator-reader__compact-progress"
        dir="ltr"
        role="progressbar"
        aria-label="Reading progress"
        aria-valuetext={projection.accessibleLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(projection.coordinate * 100)}
        data-accuracy={projection.accuracy}
        data-freshness={projection.freshness}
        data-marker-state={projection.markers.state}
        data-marker-freshness={projection.markers.freshness}
      >
        <em aria-hidden="true" data-boundary="start" />
        <em aria-hidden="true" data-boundary="end" />
        <span aria-hidden="true" style={{ inlineSize: `${projection.coordinate * 100}%` }} />
        <i
          aria-hidden="true"
          style={{ insetInlineStart: `${railCoordinate(projection.coordinate) * 100}%` }}
        />
        {projection.markers.markers.map((marker) => (
          <b
            aria-hidden="true"
            key={marker.identity}
            data-depth={marker.depth}
            style={{ insetInlineStart: `${railCoordinate(marker.coordinate) * 100}%` }}
          />
        ))}
      </div>
      {onSectionOpen === undefined ? (
        <span className="epub-navigator-reader__bottom-section">{section}</span>
      ) : (
        <button
          type="button"
          className="epub-navigator-reader__bottom-section"
          aria-label={`Show ${section} in contents`}
          onClick={onSectionOpen}
        >
          {section}
        </button>
      )}
      <span
        className="epub-navigator-reader__bottom-narration"
        data-covered={narrationCovered || undefined}
        inert={narrationCovered}
      >
        {narration}
      </span>
      <span
        className="epub-navigator-reader__bottom-pages"
        aria-label={
          sectionPages === null ? undefined : `Section pages ${sectionPages.replace(" / ", " of ")}`
        }
      >
        {sectionPages}
      </span>
      {onOpen === undefined ? null : (
        <button
          type="button"
          className="epub-navigator-reader__compact-bottom-trigger"
          aria-label="Open navigation"
          onPointerDown={(event) => {
            pointerStart.current = event.clientY;
            openedBySwipe.current = false;
          }}
          onPointerUp={(event) => {
            const start = pointerStart.current;
            pointerStart.current = null;
            if (start === null || start - event.clientY < 24) return;
            openedBySwipe.current = true;
            onOpen();
          }}
          onClick={() => {
            if (openedBySwipe.current) {
              openedBySwipe.current = false;
              return;
            }
            onOpen();
          }}
        />
      )}
    </footer>
  );
}
