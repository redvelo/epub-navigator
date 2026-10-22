import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { cn } from "./lib/utils.js";

export function PaginationFooter({
  page,
  pageCount,
  pageLabel,
  onPageChange,
  className,
}: {
  readonly page: number;
  readonly pageCount: number;
  readonly pageLabel: string;
  readonly onPageChange: (delta: number) => void;
  readonly className?: string | undefined;
}) {
  return (
    <footer
      className={cn("epub-navigator-reader__page-footer", className)}
      data-single-page={pageCount <= 1}
      aria-hidden={pageCount <= 1}
      aria-label={`${pageLabel} pages`}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="size-[48px]"
        data-rhea-local-action="compact"
        aria-label={`Previous ${pageLabel.toLocaleLowerCase()} page`}
        disabled={page === 0}
        onClick={() => onPageChange(-1)}
      >
        <ChevronLeft className="size-[28px]" aria-hidden="true" />
      </Button>
      <output aria-label={`${pageLabel} page ${page + 1} of ${pageCount}`}>
        {page + 1} / {pageCount}
      </output>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="size-[48px]"
        data-rhea-local-action="compact"
        aria-label={`Next ${pageLabel.toLocaleLowerCase()} page`}
        disabled={page === pageCount - 1}
        onClick={() => onPageChange(1)}
      >
        <ChevronRight className="size-[28px]" aria-hidden="true" />
      </Button>
    </footer>
  );
}
