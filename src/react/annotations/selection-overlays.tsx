import type { NavigatorAnnotationRecord } from "../../annotations.js";
import type { DocumentWritingMode } from "../../generated/kernel.js";
import type {
  AnnotationRangeAdjustment,
  NavigatorDecorationActivation,
} from "../../runtime/navigator/api.js";
import { AnnotationToolbar } from "../annotation-toolbar.js";
import type {
  AnnotationDeleteState,
  AnnotationRetargetState,
  SelectionActionState,
} from "./state.js";
import { SelectionToolbar, type SelectionToolbarProps } from "../selection-toolbar.js";

type ToolbarAnchor = Pick<SelectionToolbarProps, "anchorRect" | "clippingRect">;
type DecoratedAnnotationRecord = Exclude<NavigatorAnnotationRecord, { readonly type: "bookmark" }>;

export interface SelectionAnnotationOverlaysProps {
  readonly selection: {
    readonly visible: boolean;
    readonly anchor: ToolbarAnchor | null;
    readonly placement: SelectionToolbarProps["preferredPlacement"];
    readonly action: SelectionActionState | null;
    readonly copyAvailable: boolean;
    readonly annotationAvailable: boolean;
    readonly searchAvailable: boolean;
    readonly lookupAvailable: boolean;
    readonly onCopy: SelectionToolbarProps["onCopyActivation"];
    readonly onHighlight: SelectionToolbarProps["onHighlightActivation"];
    readonly onAddNote: SelectionToolbarProps["onAddNoteActivation"];
    readonly onSearch: SelectionToolbarProps["onSearchActivation"];
    readonly onLookup: SelectionToolbarProps["onLookupActivation"];
    readonly onDismiss: SelectionToolbarProps["onEscape"];
  };
  readonly contextual: {
    readonly anchor: ToolbarAnchor | null;
    readonly records: readonly DecoratedAnnotationRecord[];
    readonly selectedId: string | null;
    readonly activation: NavigatorDecorationActivation | null;
    readonly operation: AnnotationDeleteState | null;
    readonly retargetOperation: AnnotationRetargetState | null;
    readonly direction: "ltr" | "rtl";
    readonly writingMode: DocumentWritingMode;
    readonly onSelect: (id: string) => void;
    readonly onAddNote: (record: DecoratedAnnotationRecord, event: MouseEvent) => void;
    readonly onEditNote: (
      record: Extract<NavigatorAnnotationRecord, { readonly type: "note" }>,
      trigger: HTMLElement,
    ) => void;
    readonly onOpenLink: (activation: NavigatorDecorationActivation) => void;
    readonly onDelete: (record: DecoratedAnnotationRecord, event: MouseEvent) => void;
    readonly onAdjust: (
      record: NavigatorAnnotationRecord,
      adjustment: AnnotationRangeAdjustment,
      event: MouseEvent,
    ) => void;
    readonly onDismiss: () => void;
  };
}

export function SelectionAnnotationOverlays({
  selection,
  contextual,
}: SelectionAnnotationOverlaysProps) {
  return (
    <>
      {selection.visible && selection.anchor !== null ? (
        <SelectionToolbar
          anchorRect={selection.anchor.anchorRect}
          clippingRect={selection.anchor.clippingRect}
          preferredPlacement={selection.placement}
          busy={selection.action !== null && selection.action.status !== "failed"}
          busyAction={selection.action?.action ?? null}
          error={selection.action?.status === "failed" ? selection.action.error : null}
          copyAvailable={selection.copyAvailable}
          annotationAvailable={selection.annotationAvailable}
          searchAvailable={selection.searchAvailable}
          lookupAvailable={selection.lookupAvailable}
          onCopyActivation={selection.onCopy}
          onHighlightActivation={selection.onHighlight}
          onAddNoteActivation={selection.onAddNote}
          onSearchActivation={selection.onSearch}
          onLookupActivation={selection.onLookup}
          onEscape={selection.onDismiss}
        />
      ) : null}
      {contextual.anchor !== null && contextual.records.length > 0 ? (
        <AnnotationToolbar
          anchorRect={contextual.anchor.anchorRect}
          clippingRect={contextual.anchor.clippingRect}
          records={contextual.records}
          selectedId={contextual.selectedId}
          hasLink={contextual.activation?.link != null}
          direction={contextual.direction}
          writingMode={contextual.writingMode}
          busy={
            contextual.operation?.status === "submitting" ||
            contextual.operation?.status === "awaiting-projection"
          }
          rangeBusy={
            contextual.retargetOperation !== null &&
            contextual.retargetOperation.status !== "failed"
          }
          error={
            contextual.retargetOperation?.status === "failed"
              ? contextual.retargetOperation.error
              : contextual.operation?.status === "failed"
                ? contextual.operation.error
                : null
          }
          onSelect={contextual.onSelect}
          onAddNote={contextual.onAddNote}
          onEdit={(record, event) => {
            const trigger = event.currentTarget;
            if (!event.isTrusted || record.type !== "note" || !(trigger instanceof HTMLElement)) {
              return;
            }
            contextual.onEditNote(record, trigger);
            contextual.onDismiss();
          }}
          onOpenLink={(event) => {
            if (!event.isTrusted || contextual.activation === null) return;
            contextual.onOpenLink(contextual.activation);
            contextual.onDismiss();
          }}
          onDelete={contextual.onDelete}
          onAdjust={contextual.onAdjust}
          onEscape={contextual.onDismiss}
        />
      ) : null}
    </>
  );
}
