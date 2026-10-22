import { useAtom } from "jotai";
import { Ellipsis, Pencil, RotateCcw, Search, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, type FormEvent } from "react";
import type {
  NavigatorAnnotationProjection,
  NavigatorAnnotationRecord,
  NavigatorNoteAnnotationRecord,
} from "../annotations.js";
import type { DecorationRecordPosition } from "../generated/kernel.js";
import { annotationQueryAtom } from "./annotations/state.js";
import type { NavigatorAnnotationAction } from "./public-types.js";
import { Button } from "./components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./components/ui/input-group.js";
import { Textarea } from "./components/ui/textarea.js";
import { cn } from "./lib/utils.js";
import { PaginatedOverflow } from "./paginated-overflow.js";

export interface AnnotationRowOperation {
  readonly recordId: string;
  readonly type: "activating" | "deleting" | "failed";
  readonly message?: string | undefined;
}

export interface BookmarkOperationStatus {
  readonly status: "generating" | "persisting" | "awaiting-projection" | "failed";
  readonly error: string | null;
}

export interface NoteEditorDraft {
  readonly mode: "create" | "convert" | "edit";
  readonly recordId: string | null;
  readonly excerpt: string | null;
  readonly sectionLabel: string | null;
  readonly text: string;
  readonly status: "idle" | "submitting" | "awaiting-projection" | "failed";
  readonly error: string | null;
}

export interface AnnotationsPanelProps {
  readonly availability: "pending" | "unavailable" | "available";
  readonly projection?: NavigatorAnnotationProjection | undefined;
  readonly positions: readonly DecorationRecordPosition[];
  readonly selectedRecordId: string | null;
  readonly operation: AnnotationRowOperation | null;
  readonly onActivate: (record: NavigatorAnnotationRecord, event: MouseEvent) => void;
  readonly onEdit: (record: NavigatorNoteAnnotationRecord, trigger: HTMLElement) => void;
  readonly onDelete: (record: NavigatorAnnotationRecord, event: MouseEvent) => void;
  readonly retryDelete: ((event: MouseEvent) => void) | null;
  readonly bookmarkOperation?: (BookmarkOperationStatus | null) | undefined;
  readonly retryBookmark?: ((event: MouseEvent) => void) | null | undefined;
  readonly hostActions?:
    | ((record: NavigatorAnnotationRecord) => readonly NavigatorAnnotationAction[])
    | undefined;
  readonly portalContainer?: (HTMLElement | null) | undefined;
}

export function AnnotationsPanel({
  availability,
  projection,
  positions,
  selectedRecordId,
  operation,
  onActivate,
  onEdit,
  onDelete,
  retryDelete,
  bookmarkOperation = null,
  retryBookmark = null,
  hostActions,
  portalContainer = null,
}: AnnotationsPanelProps) {
  const filterLabel = useId();
  const [query, setQuery] = useAtom(annotationQueryAtom);
  const bookmarkStatus =
    bookmarkOperation === null ? null : (
      <div
        className="epub-navigator-reader__bookmark-status flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3 text-xs"
        role={bookmarkOperation.status === "failed" ? "alert" : "status"}
        aria-live="polite"
      >
        <span className="min-w-0 flex-1">
          {bookmarkOperation.status === "generating"
            ? "Creating bookmark target…"
            : bookmarkOperation.status === "persisting"
              ? "Saving bookmark…"
              : bookmarkOperation.status === "awaiting-projection"
                ? "Waiting for saved bookmark…"
                : bookmarkOperation.error}
        </span>
        {bookmarkOperation.status === "failed" && retryBookmark !== null ? (
          <Button
            className="min-h-11 px-2"
            type="button"
            variant="ghost"
            onClick={(event) => retryBookmark(event.nativeEvent)}
          >
            Retry bookmark
          </Button>
        ) : null}
      </div>
    );
  if (availability === "pending") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {bookmarkStatus}
        <AnnotationStatus
          title="Loading annotations"
          detail="Saved highlights, notes, and bookmarks are loading."
        />
      </div>
    );
  }
  if (availability === "unavailable" || projection === undefined) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {bookmarkStatus}
        <AnnotationStatus
          title="Annotations unavailable"
          detail="This host cannot currently provide saved annotations."
        />
      </div>
    );
  }
  if (projection.records.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {bookmarkStatus}
        <AnnotationStatus
          title="No annotations yet"
          detail="Highlights, notes, and bookmarks will appear here without changing the publication."
        />
      </div>
    );
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const ordered = orderAnnotations(projection.records, positions);
  const visible = ordered.filter((record) => {
    if (normalizedQuery.length === 0) return true;
    return [
      record.type === "bookmark" ? record.label : record.excerpt,
      record.sectionLabel,
      record.type === "note" ? record.text : null,
    ]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
  const groups = groupAnnotations(visible);

  return (
    <section
      className="epub-navigator-reader__annotations flex h-full min-h-0 flex-col"
      aria-label="Annotations"
    >
      {bookmarkStatus}
      <div className="epub-navigator-reader__annotation-filters shrink-0 border-b border-border p-2.5">
        <label className="block" htmlFor={filterLabel}>
          <span className="sr-only">Filter annotations</span>
          <InputGroup className="epub-navigator-reader__annotation-search h-10 bg-background">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id={filterLabel}
              type="search"
              value={query}
              placeholder="Filter annotations"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </InputGroup>
        </label>
      </div>
      {visible.length === 0 ? (
        <AnnotationStatus title="No matching annotations" detail="Change the search text." />
      ) : (
        <PaginatedOverflow key={query} pageLabel="Annotations">
          {groups.map((group) => (
            <section
              key={group.occurrence}
              className="epub-navigator-reader__annotation-group min-w-0 max-w-full border-t border-border first:border-t-0"
              aria-labelledby={`${filterLabel}-section-${group.occurrence}`}
            >
              <h3
                id={`${filterLabel}-section-${group.occurrence}`}
                className="sticky top-0 z-1 m-0 truncate bg-background px-3 pt-3 pb-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase"
              >
                {group.label ?? `Section ${group.occurrence + 1}`}
              </h3>
              <ol className="epub-navigator-reader__annotation-list m-0 grid min-w-0 max-w-full list-none gap-2 px-2 pb-2">
                {group.records.map((record) => (
                  <AnnotationCard
                    key={record.id}
                    record={record}
                    selected={selectedRecordId === record.id}
                    operation={operation?.recordId === record.id ? operation : null}
                    portalContainer={portalContainer}
                    onActivate={onActivate}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    retryDelete={retryDelete}
                    hostActions={hostActions?.(record) ?? []}
                  />
                ))}
              </ol>
            </section>
          ))}
        </PaginatedOverflow>
      )}
    </section>
  );
}

function AnnotationCard({
  record,
  selected,
  operation,
  portalContainer,
  onActivate,
  onEdit,
  onDelete,
  retryDelete,
  hostActions,
}: {
  readonly record: NavigatorAnnotationRecord;
  readonly selected: boolean;
  readonly operation: AnnotationRowOperation | null;
  readonly portalContainer: HTMLElement | null;
  readonly onActivate: AnnotationsPanelProps["onActivate"];
  readonly onEdit: AnnotationsPanelProps["onEdit"];
  readonly onDelete: AnnotationsPanelProps["onDelete"];
  readonly retryDelete: AnnotationsPanelProps["retryDelete"];
  readonly hostActions: readonly NavigatorAnnotationAction[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const busy = operation?.type === "deleting";
  const failedDelete = operation?.type === "failed" && retryDelete !== null;
  const actionsLabel = annotationActionsLabel(record);
  const noteExcerpt = record.type === "note" ? record.excerpt?.trim() || null : null;
  return (
    <li
      className="epub-navigator-reader__annotation-card grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)_2.75rem] items-stretch rounded-2xl border border-border bg-card text-card-foreground"
      data-selected={selected}
      data-annotation-id={record.id}
      tabIndex={-1}
    >
      <button
        className="epub-navigator-reader__annotation-target flex h-auto min-h-12 w-full min-w-0 max-w-full shrink flex-col items-stretch justify-center gap-1.5 overflow-hidden rounded-none border-0 bg-transparent p-3 text-left whitespace-normal disabled:opacity-60"
        type="button"
        disabled={busy}
        aria-label={annotationActivationLabel(record)}
        aria-current={selected ? "location" : undefined}
        onClick={(event) => onActivate(record, event.nativeEvent)}
      >
        {record.type === "bookmark" ? (
          record.label === null ? (
            <span className="text-sm text-muted-foreground">Saved location</span>
          ) : (
            <span className="min-w-0 line-clamp-3 break-words text-sm leading-snug [overflow-wrap:anywhere]">
              {record.label}
            </span>
          )
        ) : record.type === "note" ? (
          <>
            {noteExcerpt === null ? null : (
              <q className="min-w-0 line-clamp-2 break-words text-sm leading-snug [overflow-wrap:anywhere]">
                {noteExcerpt}
              </q>
            )}
            <span
              className={cn(
                "min-w-0 line-clamp-3 break-words whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]",
                noteExcerpt !== null && "mt-1",
              )}
            >
              {record.text}
            </span>
          </>
        ) : (
          <q className="min-w-0 line-clamp-3 break-words text-sm leading-snug [overflow-wrap:anywhere]">
            {annotationExcerpt(record)}
          </q>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={trigger}
              className="epub-navigator-reader__annotation-menu-trigger size-11 self-center rounded-xl"
              type="button"
              variant="ghost"
              size="icon-lg"
              data-rhea-local-action
              aria-label={actionsLabel}
              title="Annotation actions"
              disabled={busy}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          portalContainer={portalContainer ?? undefined}
          aria-label={actionsLabel}
        >
          {failedDelete ? (
            <DropdownMenuItem closeOnClick onClick={(event) => retryDelete(event.nativeEvent)}>
              <RotateCcw aria-hidden="true" /> Retry delete
            </DropdownMenuItem>
          ) : null}
          {record.type === "note" ? (
            <DropdownMenuItem
              closeOnClick
              onClick={(event) => onEdit(record, trigger.current ?? event.currentTarget)}
            >
              <Pencil aria-hidden="true" /> Edit note
            </DropdownMenuItem>
          ) : null}
          {hostActions.map((action) => (
            <DropdownMenuItem key={action.id} closeOnClick onClick={action.onSelect}>
              {action.label}
            </DropdownMenuItem>
          ))}
          {(record.type === "note" || hostActions.length > 0) && !failedDelete ? (
            <DropdownMenuSeparator />
          ) : null}
          {failedDelete ? null : (
            <DropdownMenuItem
              variant="destructive"
              closeOnClick
              onClick={(event) => onDelete(record, event.nativeEvent)}
            >
              <Trash2 aria-hidden="true" /> Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {operation === null ? null : (
        <p
          className={cn(
            "col-span-2 m-0 break-words px-3 pb-2 text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]",
            operation.type === "failed" && "text-destructive",
          )}
          role={operation.type === "failed" ? "alert" : "status"}
        >
          {operation.type === "activating"
            ? "Opening…"
            : operation.type === "deleting"
              ? "Deleting…"
              : operation.message}
        </p>
      )}
    </li>
  );
}

export function NoteEditor({
  draft,
  autoFocus,
  onTextChange,
  onSave,
  onCancel,
}: {
  readonly draft: NoteEditorDraft;
  readonly autoFocus: boolean;
  readonly onTextChange: (text: string) => void;
  readonly onSave: (event: Event) => void;
  readonly onCancel: () => void;
}) {
  const textId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => {
      const text = textRef.current;
      if (text === null) return;
      text.focus({ preventScroll: true });
      const navigator: (Navigator & { virtualKeyboard?: { show(): void } }) | undefined =
        text.ownerDocument.defaultView?.navigator;
      navigator?.virtualKeyboard?.show();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  const codePoints = Array.from(draft.text).length;
  const valid = codePoints > 0 && codePoints <= 4_096 && /\S/u.test(draft.text);
  const busy = draft.status === "submitting" || draft.status === "awaiting-projection";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !busy) onSave(event.nativeEvent);
  };
  return (
    <form
      className="epub-navigator-reader__note-editor flex min-h-0 flex-1 flex-col"
      onSubmit={submit}
    >
      <div className="epub-navigator-reader__note-editor-body min-h-0 flex-1 overflow-auto p-4">
        {draft.sectionLabel !== null ? (
          <p className="m-0 text-xs font-medium text-muted-foreground">{draft.sectionLabel}</p>
        ) : null}
        {draft.excerpt !== null ? (
          <blockquote className="epub-navigator-reader__note-editor-excerpt mt-2 border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
            {draft.excerpt}
          </blockquote>
        ) : null}
        <label className="mt-4 block text-sm font-medium" htmlFor={textId}>
          Note
        </label>
        <Textarea
          ref={textRef}
          id={textId}
          className="epub-navigator-reader__note-editor-text mt-2 min-h-48 resize-y bg-background p-3 text-base leading-relaxed"
          value={draft.text}
          autoFocus={autoFocus}
          disabled={busy}
          aria-describedby={`${textId}-count${draft.error === null ? "" : ` ${textId}-error`}`}
          onChange={(event) => onTextChange(event.currentTarget.value)}
        />
        <p
          id={`${textId}-count`}
          className="mt-1 text-right text-xs text-muted-foreground"
          data-invalid={codePoints > 4_096 || (codePoints > 0 && !/\S/u.test(draft.text))}
        >
          {codePoints.toLocaleString()} / 4,096
        </p>
        {draft.error !== null ? (
          <p id={`${textId}-error`} className="mt-2 text-sm text-destructive" role="alert">
            {draft.error}
          </p>
        ) : null}
      </div>
      <footer className="epub-navigator-reader__note-editor-footer flex shrink-0 justify-end gap-2 border-t border-border p-3">
        <Button
          className="epub-navigator-reader__note-editor-action min-h-11"
          type="button"
          variant="outline"
          size="lg"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          className="epub-navigator-reader__note-editor-action epub-navigator-reader__note-editor-action--save min-h-11"
          type="submit"
          size="lg"
          disabled={!valid || busy}
        >
          {busy ? "Saving…" : draft.status === "failed" ? "Retry" : "Save"}
        </Button>
      </footer>
    </form>
  );
}

function AnnotationStatus({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <section className="grid min-h-full place-content-center gap-2 p-8 text-center" role="status">
      <h3 className="m-0 text-base font-medium">{title}</h3>
      <p className="m-0 max-w-[28ch] text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </section>
  );
}

function annotationExcerpt(record: NavigatorAnnotationRecord): string {
  return record.type === "bookmark" ? "" : (record.excerpt ?? "Selected publication text");
}

function annotationActivationLabel(record: NavigatorAnnotationRecord): string {
  if (record.type === "bookmark") {
    return record.label === null ? "Go to bookmark" : `Go to bookmark: ${record.label}`;
  }
  if (record.type === "note") {
    const excerpt = record.excerpt?.trim();
    return excerpt ? `Go to note: ${excerpt}. Note: ${record.text}` : `Go to note: ${record.text}`;
  }
  return `Go to ${record.type}: ${annotationExcerpt(record)}`;
}

function annotationActionsLabel(record: NavigatorAnnotationRecord): string {
  if (record.type === "bookmark") {
    return record.label === null ? "Actions for bookmark" : `Actions for bookmark: ${record.label}`;
  }
  const content =
    record.type === "note"
      ? [record.excerpt?.trim(), record.text].filter(Boolean).join(". Note: ")
      : annotationExcerpt(record);
  return `Actions for ${record.type}: ${content}`;
}

function groupAnnotations(records: readonly NavigatorAnnotationRecord[]): readonly {
  readonly occurrence: number;
  readonly label: string | null;
  readonly records: readonly NavigatorAnnotationRecord[];
}[] {
  const groups: {
    occurrence: number;
    label: string | null;
    records: NavigatorAnnotationRecord[];
  }[] = [];
  for (const record of records) {
    const current = groups.at(-1);
    if (current?.occurrence === record.occurrence) {
      current.label ??= record.sectionLabel;
      current.records.push(record);
    } else {
      groups.push({
        occurrence: record.occurrence,
        label: record.sectionLabel,
        records: [record],
      });
    }
  }
  return groups;
}

function orderAnnotations(
  records: readonly NavigatorAnnotationRecord[],
  positions: readonly DecorationRecordPosition[],
): NavigatorAnnotationRecord[] {
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const sourceOrder = new Map(records.map((record, index) => [record.id, index]));
  return [...records].sort((left, right) => {
    if (left.occurrence !== right.occurrence) return left.occurrence - right.occurrence;
    const leftStart = positionById.get(left.id)?.documentTextStart;
    const rightStart = positionById.get(right.id)?.documentTextStart;
    if (
      leftStart !== null &&
      leftStart !== undefined &&
      rightStart !== null &&
      rightStart !== undefined
    ) {
      const comparison = BigInt(leftStart) - BigInt(rightStart);
      if (comparison !== 0n) return comparison < 0n ? -1 : 1;
    } else if (leftStart !== null && leftStart !== undefined) {
      return -1;
    } else if (rightStart !== null && rightStart !== undefined) {
      return 1;
    }
    return (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0);
  });
}
