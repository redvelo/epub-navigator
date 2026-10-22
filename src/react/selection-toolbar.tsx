import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { BookA, Copy, Highlighter, MessageSquarePlus, Search } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { ButtonGroup } from "./components/ui/button-group.js";

export interface SelectionToolbarRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface SelectionToolbarProps {
  readonly anchorRect: SelectionToolbarRect;
  readonly clippingRect: SelectionToolbarRect;
  readonly preferredPlacement?: ("above" | "below") | undefined;
  readonly busy: boolean;
  readonly busyAction: "copy" | "highlight" | "note" | null;
  readonly error: string | null;
  readonly copyAvailable: boolean;
  readonly annotationAvailable: boolean;
  readonly searchAvailable: boolean;
  readonly lookupAvailable: boolean;
  readonly onCopyActivation: (event: MouseEvent) => void;
  readonly onHighlightActivation: (event: MouseEvent) => void;
  readonly onAddNoteActivation: (event: MouseEvent) => void;
  readonly onSearchActivation: (event: MouseEvent) => void;
  readonly onLookupActivation: (event: MouseEvent) => void;
  readonly onEscape: () => void;
}

export interface AnchoredToolbarProps {
  readonly anchorRect: SelectionToolbarRect;
  readonly clippingRect: SelectionToolbarRect;
  readonly preferredPlacement?: ("above" | "below") | undefined;
  readonly busy: boolean;
  readonly error: string | null;
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly onEscape: () => void;
}

interface ToolbarSize {
  readonly width: number;
  readonly height: number;
}

const fallbackSize: ToolbarSize = { width: 220, height: 44 };
const anchorGap = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function toolbarPosition(
  anchor: SelectionToolbarRect,
  clipping: SelectionToolbarRect,
  size: ToolbarSize,
  preferredPlacement?: "above" | "below",
): { left: number; top: number; placement: "above" | "below" } {
  const centeredLeft = (anchor.left + anchor.right - size.width) / 2;
  const left = clamp(centeredLeft, clipping.left, clipping.right - size.width);
  const aboveTop = anchor.top - anchorGap - size.height;
  const belowTop = anchor.bottom + anchorGap;
  const fitsAbove = aboveTop >= clipping.top;
  const fitsBelow = belowTop + size.height <= clipping.bottom;
  const placement =
    preferredPlacement === "below" && fitsBelow
      ? "below"
      : preferredPlacement === "above" && fitsAbove
        ? "above"
        : fitsAbove && !fitsBelow
          ? "above"
          : fitsBelow && !fitsAbove
            ? "below"
            : anchor.top - clipping.top >= clipping.bottom - anchor.bottom
              ? "above"
              : "below";
  const preferredTop = placement === "above" ? aboveTop : belowTop;

  return {
    left,
    top: clamp(preferredTop, clipping.top, clipping.bottom - size.height),
    placement,
  };
}

function SelectionToolbar({
  anchorRect,
  clippingRect,
  preferredPlacement,
  busy,
  busyAction,
  error,
  copyAvailable,
  annotationAvailable,
  searchAvailable,
  lookupAvailable,
  onCopyActivation,
  onHighlightActivation,
  onAddNoteActivation,
  onSearchActivation,
  onLookupActivation,
  onEscape,
}: SelectionToolbarProps) {
  return (
    <AnchoredToolbar
      anchorRect={anchorRect}
      clippingRect={clippingRect}
      preferredPlacement={preferredPlacement}
      busy={busy}
      error={error}
      ariaLabel="Selection actions"
      onEscape={onEscape}
    >
      {busy ? (
        <span className="epub-navigator-reader__selection-toolbar-status" role="status">
          {busyAction === "copy"
            ? "Copying selection"
            : busyAction === "note"
              ? "Preparing note"
              : "Creating highlight"}
        </span>
      ) : null}
      {annotationAvailable ? (
        <>
          <Button
            className="epub-navigator-reader__selection-toolbar-action size-11"
            type="button"
            size="icon-lg"
            title="Highlight (f)"
            aria-keyshortcuts="f"
            aria-label="Highlight"
            disabled={busy}
            onClick={(event: ReactMouseEvent<HTMLButtonElement>) =>
              onHighlightActivation(event.nativeEvent)
            }
          >
            <Highlighter aria-hidden="true" size={20} strokeWidth={2} />
          </Button>
          <Button
            className="epub-navigator-reader__selection-toolbar-action size-11"
            type="button"
            variant="ghost"
            size="icon-lg"
            data-rhea-local-action
            title="Add note (d)"
            aria-keyshortcuts="d"
            aria-label="Add note"
            disabled={busy}
            onClick={(event: ReactMouseEvent<HTMLButtonElement>) =>
              onAddNoteActivation(event.nativeEvent)
            }
          >
            <MessageSquarePlus aria-hidden="true" size={20} strokeWidth={2} />
          </Button>
        </>
      ) : null}
      {lookupAvailable ? (
        <Button
          className="epub-navigator-reader__selection-toolbar-action size-11"
          type="button"
          variant="ghost"
          size="icon-lg"
          data-rhea-local-action
          title="Look up"
          aria-label="Look up"
          disabled={busy}
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) =>
            onLookupActivation(event.nativeEvent)
          }
        >
          <BookA aria-hidden="true" size={20} strokeWidth={2} />
        </Button>
      ) : null}
      {searchAvailable ? (
        <Button
          className="epub-navigator-reader__selection-toolbar-action size-11"
          type="button"
          variant="ghost"
          size="icon-lg"
          data-rhea-local-action
          title="Search within publication"
          aria-label="Search within publication"
          disabled={busy}
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) =>
            onSearchActivation(event.nativeEvent)
          }
        >
          <Search aria-hidden="true" size={20} strokeWidth={2} />
        </Button>
      ) : null}
      {copyAvailable ? (
        <Button
          className="epub-navigator-reader__selection-toolbar-action size-11"
          type="button"
          variant="ghost"
          size="icon-lg"
          data-rhea-local-action
          title="Copy"
          aria-label="Copy"
          disabled={busy}
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) =>
            onCopyActivation(event.nativeEvent)
          }
        >
          <Copy aria-hidden="true" size={20} strokeWidth={2} />
        </Button>
      ) : null}
    </AnchoredToolbar>
  );
}

function AnchoredToolbar({
  anchorRect,
  clippingRect,
  preferredPlacement,
  busy,
  error,
  ariaLabel,
  children,
  onEscape,
}: AnchoredToolbarProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<ToolbarSize>(fallbackSize);

  useLayoutEffect(() => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      setSize((current) =>
        current.width === bounds.width && current.height === bounds.height
          ? current
          : { width: bounds.width, height: bounds.height },
      );
    }
  }, [busy, children, error]);

  const position = toolbarPosition(anchorRect, clippingRect, size, preferredPlacement);
  const style = { left: position.left, top: position.top } satisfies CSSProperties;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onEscape();
  };

  return (
    <div className="epub-navigator-reader__selection-toolbar-positioner" style={style}>
      <ButtonGroup
        ref={surfaceRef}
        className="epub-navigator-reader__selection-toolbar"
        role="toolbar"
        aria-label={ariaLabel}
        aria-busy={busy}
        data-placement={position.placement}
        onKeyDown={handleKeyDown}
      >
        {error ? (
          <span className="epub-navigator-reader__selection-toolbar-error" role="alert">
            {error}
          </span>
        ) : null}
        {children}
      </ButtonGroup>
    </div>
  );
}

export { AnchoredToolbar, SelectionToolbar };
