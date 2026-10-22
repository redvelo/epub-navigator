import { CircleDashed, Undo2, X } from "lucide-react";
import type { PhysicalFrame } from "../../generated/kernel.js";
import type { AnnotationState } from "../annotations/state.js";
import { Button } from "../components/ui/button.js";
import { ButtonGroup } from "../components/ui/button-group.js";
import { cn } from "../lib/utils.js";
import type { ReaderError } from "./errors.js";
import { useDelayedFlag } from "./reader-state.js";

/**
 * An open that resolves in a frame or two is not a wait, and naming it paints a word the reader
 * cannot finish reading. The surface still covers from the first frame; only its label waits.
 */
const openingLabelDelayMs = 200;

export interface PublicationStatusProps {
  readonly committed: PhysicalFrame | null;
  readonly initialRestorationPending: boolean;
  /** Reading has begun in a layout whose current page follows the scroll. */
  readonly readingSurfaceRetained: boolean;
  readonly error: ReaderError | null;
  readonly retry: () => void;
  readonly layoutRepairsUnresolved: boolean;
  readonly footnoteReturn: AnnotationState["footnoteReturn"];
  readonly onReturnFromFootnote: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly onDismissFootnoteReturn: () => void;
}

export function PublicationStatus({
  committed,
  initialRestorationPending,
  readingSurfaceRetained,
  error,
  retry,
  layoutRepairsUnresolved,
  footnoteReturn,
  onReturnFromFootnote,
  onDismissFootnoteReturn,
}: PublicationStatusProps) {
  const opening =
    (committed === null || initialRestorationPending) && error === null && !readingSurfaceRetained;
  const named = useDelayedFlag(opening, openingLabelDelayMs);
  return (
    <>
      {opening ? (
        <div
          className="epub-navigator-reader__blocking-surface absolute inset-0 z-10 grid place-content-center justify-items-center gap-3 bg-background p-6 text-center text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {named ? (
            <>
              <CircleDashed className="size-5" aria-hidden="true" />
              <span className="font-medium text-foreground">Opening publication</span>
            </>
          ) : null}
        </div>
      ) : null}
      {error !== null ? (
        <div
          className="epub-navigator-reader__blocking-surface absolute inset-0 z-20 grid place-content-center justify-items-center gap-2 bg-background p-6 text-center text-sm text-muted-foreground"
          role="alert"
        >
          <strong className="text-base font-medium text-foreground">
            {error.terminal ? "Reader unavailable" : "Section unavailable"}
          </strong>
          <span className="max-w-sm">{error.message}</span>
          {!error.terminal ? (
            <Button className="mt-2 min-h-11" onClick={retry}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
      {error === null && committed !== null && layoutRepairsUnresolved ? (
        <div
          className={cn(
            "epub-navigator-reader__floating-surface pointer-events-none absolute inset-x-3 z-20 mx-auto w-fit max-w-[calc(100%-1.5rem)] rounded-md border bg-background px-3 py-2 text-center text-sm font-medium text-foreground",
            footnoteReturn === null ? "bottom-3" : "bottom-13",
          )}
          role="status"
          aria-live="polite"
        >
          Some content may be cut off in paginated view.
        </div>
      ) : null}
      {error === null && committed !== null && footnoteReturn !== null ? (
        <div className="epub-navigator-reader__footnote-return absolute inset-x-3 bottom-3 z-20 mx-auto w-fit max-w-[calc(100%-1.5rem)]">
          <ButtonGroup
            aria-label="Note navigation"
            aria-busy={footnoteReturn.status === "returning" || undefined}
            className="overflow-hidden rounded-xl border-0! bg-background shadow-sm outline outline-1 -outline-offset-1 outline-border"
          >
            <Button
              size="icon-lg"
              className="h-8 w-[3.1875rem] border-0 p-0 [&_svg]:size-[1.125rem]"
              aria-label="Return to note reference"
              aria-invalid={footnoteReturn.status === "failed" || undefined}
              disabled={footnoteReturn.status === "returning"}
              onClick={onReturnFromFootnote}
            >
              {footnoteReturn.status === "returning" ? (
                <CircleDashed aria-hidden="true" />
              ) : (
                <Undo2 aria-hidden="true" />
              )}
            </Button>
            <span className="w-px self-stretch bg-border" aria-hidden="true" />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-rhea-local-action="compact"
              className="h-8 w-7 border-0 p-0 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
              aria-label="Dismiss note return"
              disabled={footnoteReturn.status === "returning"}
              onClick={onDismissFootnoteReturn}
            >
              <X aria-hidden="true" />
            </Button>
          </ButtonGroup>
          {footnoteReturn.status === "failed" ? (
            <span className="sr-only" role="alert">
              {footnoteReturn.message}
            </span>
          ) : footnoteReturn.status === "returning" ? (
            <span className="sr-only" role="status" aria-live="polite">
              Returning to note reference
            </span>
          ) : (
            <span className="sr-only" role="status" aria-live="polite">
              Note return available
            </span>
          )}
        </div>
      ) : null}
    </>
  );
}
