import { useAtomValue, useStore } from "jotai";
import { X } from "lucide-react";
import type { CSSProperties } from "react";
import { NoteEditor } from "../annotations-panel.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../components/ui/dialog.js";
import { activePublicationFrame } from "../input/focus.js";
import { cn } from "../lib/utils.js";
import { editReturnFocusAtom, noteDraftAtom } from "./state.js";

export interface NoteEditorDialogProps {
  readonly compact: boolean;
  readonly root: HTMLElement | null;
  readonly frameHost: HTMLElement | null;
  readonly viewportStyle: CSSProperties | undefined;
  readonly onTextChange: (text: string) => void;
  readonly onSave: (event: Event) => void;
  readonly onCancel: () => void;
}

export function NoteEditorDialog({
  compact,
  root,
  frameHost,
  viewportStyle,
  onTextChange,
  onSave,
  onCancel,
}: NoteEditorDialogProps) {
  const draft = useAtomValue(noteDraftAtom);
  const store = useStore();
  if (draft === null) return null;
  return (
    <Dialog open modal="trap-focus" onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        contained
        backdropClassName={compact ? "bg-background transition-none" : "bg-transparent"}
        viewportStyle={compact ? viewportStyle : undefined}
        viewportClassName={compact ? "p-0" : undefined}
        portalContainer={root}
        className={cn(
          compact
            ? "epub-navigator-reader__compact-sheet epub-navigator-reader__note-sheet h-full max-h-none max-w-none rounded-none border-0"
            : "h-[min(38rem,calc(100%-2rem))] max-w-xl rounded-xl",
          compact && "shadow-none transition-none",
        )}
        finalFocus={() =>
          draft.mode === "create" || draft.mode === "convert"
            ? activePublicationFrame(frameHost)
            : store.get(editReturnFocusAtom)?.element
        }
      >
        <header
          className={cn(
            "flex shrink-0 items-center justify-between border-b border-border",
            compact
              ? "epub-navigator-reader__compact-titled-header min-h-12 p-1 ps-4"
              : "h-12 px-4",
          )}
        >
          <DialogTitle className="min-w-0 truncate font-medium">
            {draft.mode === "create" || draft.mode === "convert" ? "Add note" : "Edit note"}
          </DialogTitle>
          <div
            className={
              compact
                ? "epub-navigator-reader__compact-header-actions flex items-center"
                : undefined
            }
          >
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-rhea-local-action="compact"
                  aria-label="Close note editor"
                />
              }
            >
              <X aria-hidden="true" />
            </DialogClose>
          </div>
        </header>
        <NoteEditor
          draft={draft}
          autoFocus
          onTextChange={onTextChange}
          onSave={onSave}
          onCancel={onCancel}
        />
      </DialogContent>
    </Dialog>
  );
}
