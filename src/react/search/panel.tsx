import { useAtom } from "jotai";
import { ChevronDown, CircleDashed, Search as SearchIcon } from "lucide-react";
import { useEffect, useRef, type FormEvent, type RefObject, useLayoutEffect } from "react";
import type {
  NavigatorSearchResult,
  NavigatorSearchScope,
  NavigatorSearchSnapshot,
} from "../../search.js";
import { Button } from "../components/ui/button.js";
import { searchQueryAtom } from "./state.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group.js";
import { PaginatedOverflow } from "../paginated-overflow.js";
import { cn } from "../lib/utils.js";
import { authoredSectionLabel, type AuthoredNavigationProjection } from "../navigation/model.js";

export interface SearchQueryFormProps {
  readonly inputRef?: RefObject<HTMLInputElement | null> | undefined;
  readonly portalContainer?: (HTMLElement | null) | undefined;
  readonly compact?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly scope: NavigatorSearchScope["type"];
  readonly publicationScopeAvailable: boolean;
  readonly occurrenceScopeAvailable: boolean;
  readonly occurrenceLabel: string | null;
  readonly onScopeChange: (scope: NavigatorSearchScope["type"]) => void;
  readonly onSubmit: () => void;
}

export function SearchQueryForm({
  inputRef,
  portalContainer,
  compact = false,
  busy = false,
  scope,
  publicationScopeAvailable,
  occurrenceScopeAvailable,
  occurrenceLabel,
  onScopeChange,
  onSubmit,
}: SearchQueryFormProps) {
  const [query, setQuery] = useAtom(searchQueryAtom);
  const scopeLabel = scope === "occurrence" ? (occurrenceLabel ?? "This section") : "Whole book";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (query.trim().length > 0) onSubmit();
  };
  return (
    <form
      role="search"
      className={cn("epub-navigator-reader__search-form min-w-0", !compact && "m-2")}
      onSubmit={submit}
    >
      <InputGroup
        className={cn(
          "epub-navigator-reader__search-field bg-background text-foreground",
          compact ? "h-9" : "h-10",
        )}
        data-disabled={busy || undefined}
      >
        <InputGroupAddon>
          {busy ? <CircleDashed aria-hidden="true" /> : <SearchIcon aria-hidden="true" />}
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          type="search"
          aria-label="Search publication"
          placeholder="Search publication"
          value={query}
          disabled={busy}
          className="px-0.5 placeholder:text-muted-foreground/80 disabled:cursor-wait"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <InputGroupAddon align="inline-end" className="border-s border-border ps-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-rhea-local-action
                  aria-label={`Search scope: ${scopeLabel}`}
                  title={scopeLabel}
                  className="group/scope relative h-full w-11 rounded-xl after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']"
                />
              }
            >
              <ChevronDown
                className="size-3.5 group-data-[popup-open]/scope:rotate-180"
                aria-hidden="true"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              portalContainer={portalContainer ?? undefined}
              aria-label="Search scope"
              positionerProps={{
                side: "bottom",
                align: "end",
                sideOffset: 6,
                collisionPadding: 8,
              }}
              className="max-w-[min(16rem,calc(100cqw-1rem))]"
            >
              <DropdownMenuRadioGroup
                value={scope}
                onValueChange={(value) => {
                  if (value === "publication" || value === "occurrence") onScopeChange(value);
                }}
              >
                <SearchScopeMenuItem
                  value="publication"
                  label="Whole book"
                  disabled={!publicationScopeAvailable}
                />
                <SearchScopeMenuItem
                  value="occurrence"
                  label="This section"
                  disabled={!occurrenceScopeAvailable}
                />
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}

function SearchScopeMenuItem({
  value,
  label,
  disabled,
}: {
  readonly value: NavigatorSearchScope["type"];
  readonly label: string;
  readonly disabled: boolean;
}) {
  return (
    <DropdownMenuRadioItem value={value} disabled={disabled} closeOnClick>
      <span className="truncate">{label}</span>
    </DropdownMenuRadioItem>
  );
}

export interface SearchPanelProps {
  readonly snapshot: NavigatorSearchSnapshot;
  readonly authoredNavigation: AuthoredNavigationProjection;
  readonly readingOrderLength: number;
  readonly scope: NavigatorSearchScope["type"];
  readonly publicationScopeAvailable: boolean;
  readonly occurrenceScopeAvailable: boolean;
  readonly occurrenceLabel: string | null;
  readonly inputRef?: RefObject<HTMLInputElement | null> | undefined;
  readonly portalContainer?: (HTMLElement | null) | undefined;
  readonly queryInHeader?: boolean | undefined;
  readonly paginated?: boolean | undefined;
  readonly activation:
    | { readonly resultId: string; readonly status: "activating" }
    | { readonly resultId: string; readonly status: "failed"; readonly message: string }
    | null;
  readonly onScopeChange: (scope: NavigatorSearchScope["type"]) => void;
  readonly onSubmit: () => void;
  readonly onContinue: () => void;
  readonly onActivate: (result: NavigatorSearchResult) => void;
}

export function SearchPanel({
  snapshot,
  authoredNavigation,
  readingOrderLength,
  scope,
  publicationScopeAvailable,
  occurrenceScopeAvailable,
  occurrenceLabel,
  inputRef,
  portalContainer,
  queryInHeader = false,
  paginated = false,
  activation,
  onScopeChange,
  onSubmit,
  onContinue,
  onActivate,
}: SearchPanelProps) {
  const session = snapshot.state === "idle" ? null : snapshot.session;
  const busy = snapshot.state === "querying";
  const groups = groupResults(session?.results ?? []);
  const continuationBusy = snapshot.state === "querying" && snapshot.phase === "continuation";
  const continuationSentinel = useRef<HTMLDivElement>(null);
  const requestedContinuation = useRef<{
    readonly requestId: string;
    readonly continuation: string;
  } | null>(null);
  const onContinueRef = useRef(onContinue);
  useLayoutEffect(() => {
    onContinueRef.current = onContinue;
  });
  const readySession = snapshot.state === "ready" ? snapshot.session : null;
  const readyRequestId = readySession?.requestId ?? null;
  const readyContinuation = readySession?.continuation ?? null;
  useEffect(() => {
    const sentinel = continuationSentinel.current;
    if (
      sentinel === null ||
      readyRequestId === null ||
      readyContinuation === null ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.target === sentinel && entry.isIntersecting)) return;
      const requested = requestedContinuation.current;
      if (requested?.requestId === readyRequestId && requested.continuation === readyContinuation) {
        return;
      }
      requestedContinuation.current = {
        requestId: readyRequestId,
        continuation: readyContinuation,
      };
      onContinueRef.current();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [readyContinuation, readyRequestId]);
  const results = (
    <div
      className="epub-navigator-reader__search-results min-h-0 pb-2"
      aria-busy={continuationBusy || undefined}
    >
      <SearchStatus snapshot={snapshot} />
      {groups.map((group) => (
        <section key={group.id} className="border-t border-border first:border-t-0">
          <h3 className="sticky top-0 z-1 bg-background px-3 pt-3 pb-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {group.label ?? authoredSectionLabel(authoredNavigation, group, readingOrderLength)}
          </h3>
          <ol className="m-0 grid list-none gap-2 px-2 pb-2">
            {group.results.map((result) => {
              const operation = activation?.resultId === result.id ? activation : null;
              return (
                <li key={result.id}>
                  <Button
                    type="button"
                    variant="outline"
                    className="epub-navigator-reader__search-result group/result h-auto min-h-12 w-full flex-col items-stretch justify-start rounded-2xl bg-card px-3 py-2.5 text-start text-sm leading-relaxed whitespace-normal"
                    aria-current={session?.selectedResultId === result.id ? "location" : undefined}
                    aria-busy={operation?.status === "activating" || undefined}
                    disabled={operation?.status === "activating"}
                    onClick={() => onActivate(result)}
                  >
                    <span className="line-clamp-3">
                      {result.excerpt.before}
                      <mark className="rounded-sm bg-primary/15 px-0.5 font-semibold text-inherit box-decoration-clone group-aria-[current=location]/result:bg-primary/25">
                        {result.excerpt.match}
                      </mark>
                      {result.excerpt.after}
                    </span>
                    {operation?.status === "failed" ? (
                      <span className="mt-1 block text-xs text-destructive" role="alert">
                        {operation.message}
                      </span>
                    ) : null}
                  </Button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {session?.continuation !== null && session?.continuation !== undefined ? (
        <div
          ref={continuationSentinel}
          className="h-px w-full pointer-events-none"
          aria-hidden="true"
        />
      ) : null}
    </div>
  );

  return (
    <div className="epub-navigator-reader__search-surface flex h-full min-h-0 flex-col">
      {queryInHeader ? null : (
        <SearchQueryForm
          inputRef={inputRef}
          portalContainer={portalContainer}
          busy={busy}
          scope={scope}
          publicationScopeAvailable={publicationScopeAvailable}
          occurrenceScopeAvailable={occurrenceScopeAvailable}
          occurrenceLabel={occurrenceLabel}
          onScopeChange={onScopeChange}
          onSubmit={onSubmit}
        />
      )}
      {paginated ? (
        <PaginatedOverflow className="min-h-0 flex-1" pageLabel="Search results">
          {results}
        </PaginatedOverflow>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">{results}</div>
      )}
    </div>
  );
}

function SearchStatus({ snapshot }: { readonly snapshot: NavigatorSearchSnapshot }) {
  if (snapshot.state === "idle") {
    return (
      <p className="m-0 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
        Enter text to search this book.
      </p>
    );
  }
  if (snapshot.state === "querying" && snapshot.phase === "initial") {
    return (
      <p className="m-0 border-b px-3 py-2 text-xs text-muted-foreground" role="status">
        Searching
      </p>
    );
  }
  if (snapshot.state === "querying" && snapshot.phase === "continuation") {
    return (
      <p className="m-0 border-b px-3 py-2 text-xs text-muted-foreground" role="status">
        Loading more results
      </p>
    );
  }
  if (snapshot.state === "failed") {
    return (
      <p
        className="m-0 border-b bg-destructive/5 px-3 py-2.5 text-xs text-destructive"
        role="alert"
      >
        {snapshot.message ?? "Search failed. Submit the query to try again."}
      </p>
    );
  }
  if (snapshot.state === "unavailable") {
    return (
      <p
        className="m-0 border-b px-3 py-2.5 text-xs leading-relaxed text-muted-foreground"
        role="status"
      >
        {snapshot.message ?? "Search is unavailable for this query."}
      </p>
    );
  }
  const { session } = snapshot;
  if (session.results.length === 0) {
    return (
      <p className="m-0 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground" role="status">
        {session.coverage?.state === "partial"
          ? "No matches in searched content. Some publication content was not searched."
          : "No matches in this book."}
      </p>
    );
  }
  const count = session.totalResultCount ?? session.results.length;
  return (
    <p
      className="m-0 border-b px-3 py-1.5 text-[0.6875rem] font-medium tabular-nums text-muted-foreground"
      role="status"
    >
      {count} {count === 1 ? "result" : "results"}
      {session.coverage?.state === "partial" ? ". Some publication content was not searched." : ""}
    </p>
  );
}

function groupResults(results: readonly NavigatorSearchResult[]): readonly {
  readonly id: string;
  readonly label: string | null;
  readonly occurrence: number;
  readonly resource: string;
  readonly results: readonly NavigatorSearchResult[];
}[] {
  const groups: {
    id: string;
    label: string | null;
    occurrence: number;
    resource: string;
    results: NavigatorSearchResult[];
  }[] = [];
  for (const result of results) {
    const current = groups.at(-1);
    if (current?.id === result.section.id) current.results.push(result);
    else groups.push({ ...result.section, results: [result] });
  }
  return groups;
}
