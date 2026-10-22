import { useRef, type ReactNode } from "react";
import { BookmarkPlus, PinOff, X } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { clampPanelWidth, panelLabel } from "./layout.js";
import type { NavigatorReaderWorkspacePanelState } from "../public-types.js";

export function WorkspacePanel({
  side,
  state,
  direction,
  onChange,
  label,
  titleAction,
  children,
}: {
  readonly side: "navigation" | "annotations";
  readonly state: NavigatorReaderWorkspacePanelState;
  readonly direction: "ltr" | "rtl";
  readonly onChange: (state: NavigatorReaderWorkspacePanelState) => void;
  readonly label?: string | undefined;
  readonly titleAction?: ReactNode | undefined;
  readonly children: ReactNode;
}) {
  const panelName = label ?? panelLabel(side);
  const pointerStart = useRef<{ readonly x: number; readonly width: number } | null>(null);
  const resizeDirection = (side === "navigation" ? 1 : -1) * (direction === "ltr" ? 1 : -1);
  const resize = (width: number) => onChange({ ...state, width: clampPanelWidth(width) });
  return (
    <section className="epub-navigator-reader__workspace-panel" aria-label={`${panelName} panel`}>
      <header className="epub-navigator-reader__workspace-panel-header">
        <strong>{panelName}</strong>
        {titleAction}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-rhea-local-action="compact"
          aria-label={`Unpin ${panelName.toLocaleLowerCase()} panel`}
          onClick={() => onChange({ ...state, pinned: false })}
        >
          <PinOff aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-rhea-local-action="compact"
          aria-label={`Close ${panelName.toLocaleLowerCase()} panel`}
          onClick={() => onChange({ ...state, open: false })}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="epub-navigator-reader__workspace-panel-content">{children}</div>
      <div
        className="epub-navigator-reader__workspace-resize-handle"
        role="separator"
        aria-label={`Resize ${panelLabel(side).toLocaleLowerCase()} panel`}
        aria-orientation="vertical"
        aria-valuemin={224}
        aria-valuemax={480}
        aria-valuenow={state.width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          resize(state.width + (event.key === "ArrowRight" ? 16 : -16) * resizeDirection);
        }}
        onPointerDown={(event) => {
          pointerStart.current = { x: event.clientX, width: state.width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = pointerStart.current;
          if (start === null || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          resize(start.width + (event.clientX - start.x) * resizeDirection);
        }}
        onPointerUp={(event) => {
          pointerStart.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          pointerStart.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
      />
    </section>
  );
}

export function BookmarkTitleAction({
  disabled,
  busy,
  onActivate,
}: {
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onActivate: (event: MouseEvent) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-rhea-local-action="compact"
      aria-label="Add bookmark at current location"
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={(event) => onActivate(event.nativeEvent)}
    >
      <BookmarkPlus aria-hidden="true" />
    </Button>
  );
}
