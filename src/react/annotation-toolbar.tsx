import type { MouseEvent as ReactMouseEvent } from "react";
import { ExternalLink, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import type { NavigatorAnnotationRecord } from "../annotations.js";
import type { DocumentDirection, DocumentWritingMode } from "../generated/kernel.js";
import type { AnnotationRangeAdjustment } from "../runtime/navigator/api.js";
import { AnchoredToolbar, type SelectionToolbarRect } from "./selection-toolbar.js";
import { Button } from "./components/ui/button.js";
import { ButtonGroup } from "./components/ui/button-group.js";

type DecoratedAnnotationRecord = Exclude<NavigatorAnnotationRecord, { readonly type: "bookmark" }>;

interface AnnotationToolbarProps {
  readonly anchorRect: SelectionToolbarRect;
  readonly clippingRect: SelectionToolbarRect;
  readonly records: readonly DecoratedAnnotationRecord[];
  readonly selectedId: string | null;
  readonly hasLink: boolean;
  readonly busy: boolean;
  readonly rangeBusy: boolean;
  readonly error: string | null;
  readonly direction: DocumentDirection;
  readonly writingMode: DocumentWritingMode;
  readonly onSelect: (id: string) => void;
  readonly onAddNote: (record: DecoratedAnnotationRecord, event: MouseEvent) => void;
  readonly onEdit: (record: DecoratedAnnotationRecord, event: MouseEvent) => void;
  readonly onOpenLink: (event: MouseEvent) => void;
  readonly onDelete: (record: DecoratedAnnotationRecord, event: MouseEvent) => void;
  readonly onAdjust: (
    record: DecoratedAnnotationRecord,
    adjustment: AnnotationRangeAdjustment,
    event: MouseEvent,
  ) => void;
  readonly onEscape: () => void;
}

export function AnnotationToolbar({
  anchorRect,
  clippingRect,
  records,
  selectedId,
  hasLink,
  busy,
  rangeBusy,
  error,
  direction,
  writingMode,
  onSelect,
  onAddNote,
  onEdit,
  onOpenLink,
  onDelete,
  onAdjust,
  onEscape,
}: AnnotationToolbarProps) {
  const selected = records.find(({ id }) => id === selectedId) ?? null;
  return (
    <AnchoredToolbar
      anchorRect={anchorRect}
      clippingRect={clippingRect}
      busy={busy || rangeBusy}
      error={error}
      ariaLabel={selected === null ? "Choose annotation" : "Annotation actions"}
      onEscape={onEscape}
    >
      {selected === null ? (
        <div className="epub-navigator-reader__annotation-chooser">
          {records.map((record, index) => (
            <Button
              key={record.id}
              type="button"
              variant="ghost"
              autoFocus={index === 0}
              className="epub-navigator-reader__selection-toolbar-action"
              onClick={() => onSelect(record.id)}
            >
              <span>{record.type === "note" ? "Note" : "Highlight"}</span>
              <small>{record.excerpt?.trim() || "No excerpt"}</small>
            </Button>
          ))}
        </div>
      ) : (
        <div className="epub-navigator-reader__annotation-toolbar-groups">
          <ButtonGroup className="epub-navigator-reader__annotation-toolbar-range-actions">
            {(
              [
                ["Expand beginning", { edge: "start", movement: "backward" }],
                ["Contract beginning", { edge: "start", movement: "forward" }],
                ["Contract ending", { edge: "end", movement: "backward" }],
                ["Expand ending", { edge: "end", movement: "forward" }],
              ] as const
            ).map(([label, adjustment]) => (
              <Button
                key={label}
                type="button"
                variant="ghost"
                size="icon-lg"
                data-rhea-local-action
                title={label}
                aria-label={label}
                disabled={busy}
                aria-disabled={rangeBusy || undefined}
                className="epub-navigator-reader__selection-toolbar-action epub-navigator-reader__annotation-toolbar-range-action size-11"
                onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                  if (rangeBusy) return;
                  onAdjust(selected, adjustment, event.nativeEvent);
                }}
              >
                <RangeEdgeIcon
                  edge={adjustment.edge}
                  action={
                    (adjustment.edge === "start" && adjustment.movement === "backward") ||
                    (adjustment.edge === "end" && adjustment.movement === "forward")
                      ? "expand"
                      : "contract"
                  }
                  direction={direction}
                  writingMode={writingMode}
                />
              </Button>
            ))}
          </ButtonGroup>
          <ButtonGroup className="epub-navigator-reader__annotation-toolbar-actions">
            {selected.type === "highlight" ? (
              <Button
                type="button"
                size="icon-lg"
                autoFocus
                title="Add note"
                aria-label="Add note"
                disabled={busy}
                aria-disabled={rangeBusy || undefined}
                className="epub-navigator-reader__selection-toolbar-action size-11"
                onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                  if (rangeBusy) return;
                  onAddNote(selected, event.nativeEvent);
                }}
              >
                <MessageSquarePlus aria-hidden="true" size={20} strokeWidth={2} />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon-lg"
                autoFocus
                title="Edit note"
                aria-label="Edit note"
                disabled={busy}
                aria-disabled={rangeBusy || undefined}
                className="epub-navigator-reader__selection-toolbar-action size-11"
                onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                  if (rangeBusy) return;
                  onEdit(selected, event.nativeEvent);
                }}
              >
                <Pencil aria-hidden="true" size={20} strokeWidth={2} />
              </Button>
            )}
            {hasLink ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                data-rhea-local-action
                title="Open link"
                aria-label="Open link"
                disabled={busy}
                aria-disabled={rangeBusy || undefined}
                className="epub-navigator-reader__selection-toolbar-action size-11"
                onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                  if (rangeBusy) return;
                  onOpenLink(event.nativeEvent);
                }}
              >
                <ExternalLink aria-hidden="true" size={20} strokeWidth={2} />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              size="icon-lg"
              title="Delete annotation"
              aria-label="Delete annotation"
              disabled={busy}
              aria-disabled={rangeBusy || undefined}
              className="epub-navigator-reader__selection-toolbar-action epub-navigator-reader__annotation-toolbar-delete size-11"
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                if (rangeBusy) return;
                onDelete(selected, event.nativeEvent);
              }}
            >
              <Trash2 aria-hidden="true" size={20} strokeWidth={2} />
            </Button>
          </ButtonGroup>
        </div>
      )}
    </AnchoredToolbar>
  );
}

interface RangeEdgeIconProps {
  readonly edge: "start" | "end";
  readonly action: "expand" | "contract";
  readonly direction: DocumentDirection;
  readonly writingMode: DocumentWritingMode;
}

function RangeEdgeIcon({ edge, action, direction, writingMode }: RangeEdgeIconProps) {
  const start = edge === "start";
  const vertical = writingMode !== "horizontal-tb";
  const arrow = start
    ? action === "expand"
      ? "M6 12H2m2-2-2 2 2 2"
      : "M2 12h4m-2-2 2 2-2 2"
    : action === "expand"
      ? "M18 12h4m-2-2 2 2-2 2"
      : "M22 12h-4m2-2-2 2 2 2";
  return (
    <svg
      aria-hidden="true"
      className="epub-navigator-reader__range-edge-icon size-6"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-edge={edge}
      data-action={action}
      data-writing-mode={writingMode}
    >
      <g transform={vertical ? "rotate(90 12 12)" : undefined}>
        <g transform={direction === "rtl" ? "translate(24 0) scale(-1 1)" : undefined}>
          <rect
            x="8"
            y="7"
            width="8"
            height="10"
            fill="currentColor"
            stroke="none"
            opacity="0.15"
          />
          <path d="M10 5H8v14h2" strokeWidth={start ? 2 : 1} opacity={start ? 1 : 0.35} />
          <path d="M14 5h2v14h-2" strokeWidth={start ? 1 : 2} opacity={start ? 0.35 : 1} />
          <path d={arrow} strokeWidth="1.75" />
        </g>
      </g>
    </svg>
  );
}
