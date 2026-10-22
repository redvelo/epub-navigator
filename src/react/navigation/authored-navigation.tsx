import { useAtom } from "jotai";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { Accordion } from "@base-ui/react/accordion";
import { ChevronRight, Layers2, ListTree, Signpost } from "lucide-react";
import type { PhysicalFrame } from "../../generated/kernel.js";
import type { BookPaginationSnapshot } from "../../runtime/pagination/index.js";
import { Button } from "../components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { PaginatedOverflow } from "../paginated-overflow.js";
import { PaginationFooterContext } from "../pagination-footer-context.js";
import { authoredNavigationExpandedAtom, authoredNavigationViewAtom } from "./state.js";
import { cn, titleCase } from "../lib/utils.js";
import { unavailableTargetMessage } from "../status/messages.js";
import {
  isAddressedTarget,
  tocPointOccurrence,
  type AuthoredNavigationList,
  type AuthoredNavigationPoint,
  type AuthoredNavigationProjection,
  type JoinedTocPoint,
} from "./model.js";

export function AuthoredNavigation({
  projection,
  current,
  pagination,
  onNavigate,
  tabsAtBottom = false,
  paginated = false,
}: {
  readonly projection: AuthoredNavigationProjection;
  readonly current: PhysicalFrame | null;
  readonly pagination: BookPaginationSnapshot | null;
  readonly onNavigate: (point: AuthoredNavigationPoint) => void;
  readonly tabsAtBottom?: boolean | undefined;
  readonly paginated?: boolean | undefined;
}) {
  const [view, setView] = useAtom(authoredNavigationViewAtom);
  const inheritedFooter = useContext(PaginationFooterContext);
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);
  const views = ["contents", "pages", "landmarks"] as const;
  const tabs = (
    <TabsList
      aria-label="Navigation lists"
      className="epub-navigator-reader__navigation-tabs grid h-auto w-auto grid-cols-3"
    >
      {views.map((tab) => (
        <TabsTrigger key={tab} value={tab} className="min-h-11" aria-label={titleCase(tab)}>
          {tab === "contents" ? (
            <ListTree className="size-5" aria-hidden="true" />
          ) : tab === "pages" ? (
            <Layers2 className="size-5" aria-hidden="true" />
          ) : (
            <Signpost className="size-5" aria-hidden="true" />
          )}
        </TabsTrigger>
      ))}
    </TabsList>
  );
  return (
    <PaginationFooterContext value={tabsAtBottom ? footerHost : inheritedFooter}>
      <Tabs
        value={view}
        onValueChange={(value) => {
          if (value === "contents" || value === "pages" || value === "landmarks") setView(value);
        }}
        className="epub-navigator-reader__authored-navigation gap-0"
      >
        {tabsAtBottom ? null : tabs}
        {views.map((tab) => {
          const lists = projection[tab];
          const content =
            lists.length === 0 ? (
              <p className="epub-navigator-reader__toc-empty">
                {tab === "contents"
                  ? "This publication does not provide a table of contents."
                  : `${titleCase(tab)} unavailable.`}
              </p>
            ) : (
              lists.map((entry) => (
                <NavigationListContent
                  key={entry.listIndex}
                  entry={entry}
                  hierarchical={tab === "contents"}
                  current={current}
                  pagination={pagination}
                  onNavigate={onNavigate}
                />
              ))
            );
          return (
            <TabsContent
              key={tab}
              value={tab}
              className={cn("min-h-0", !paginated && "epub-navigator-reader__navigation-lists")}
            >
              {paginated ? (
                <PaginatedOverflow className="epub-navigator-reader__navigation-lists">
                  {content}
                </PaginatedOverflow>
              ) : (
                content
              )}
            </TabsContent>
          );
        })}
        {tabsAtBottom ? (
          <>
            <div ref={setFooterHost} className="shrink-0" />
            {tabs}
          </>
        ) : null}
      </Tabs>
    </PaginationFooterContext>
  );
}

function NavigationListContent({
  entry,
  hierarchical,
  current,
  pagination,
  onNavigate,
}: {
  readonly entry: AuthoredNavigationList<"toc" | "page-list" | "landmarks">;
  readonly hierarchical: boolean;
  readonly current: PhysicalFrame | null;
  readonly pagination: BookPaginationSnapshot | null;
  readonly onNavigate: (point: AuthoredNavigationPoint) => void;
}) {
  return (
    <section className="epub-navigator-reader__navigation-list">
      {entry.list.heading === null ? null : <h3>{entry.list.heading.text}</h3>}
      {hierarchical ? (
        <TocTree
          points={entry.points}
          current={current}
          pagination={pagination}
          onNavigate={onNavigate}
        />
      ) : (
        <FlatNavigationPoints points={entry.points} onNavigate={onNavigate} />
      )}
    </section>
  );
}

function FlatNavigationPoints({
  points,
  onNavigate,
}: {
  readonly points: readonly AuthoredNavigationPoint[];
  readonly onNavigate: (point: AuthoredNavigationPoint) => void;
}) {
  const flattened = points.flatMap((point) => flattenNavigationPoint(point));
  return (
    <ol className="m-0 grid list-none p-0">
      {flattened.map((point) => {
        const occurrence = tocPointOccurrence(point);
        const actionable = occurrence !== null && point.resource !== null;
        const unavailableId = `navigation-${point.listIndex}-${point.pointPath.join("-")}-unavailable`;
        return (
          <li key={`${point.listIndex}-${point.pointPath.join("-")}`}>
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-h-11 w-full justify-start whitespace-normal text-left font-normal"
              disabled={!actionable}
              aria-describedby={actionable ? undefined : unavailableId}
              onClick={() => onNavigate(point)}
            >
              {point.point.label ?? "Untitled destination"}
            </Button>
            {!actionable ? (
              <span id={unavailableId} className="sr-only">
                {unavailableTargetMessage(point.target, point.resource)}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function flattenNavigationPoint(
  point: AuthoredNavigationPoint,
): readonly AuthoredNavigationPoint[] {
  return [point, ...point.children.flatMap((child) => flattenNavigationPoint(child))];
}

function TocTree({
  points,
  current,
  pagination,
  onNavigate,
}: {
  readonly points: readonly JoinedTocPoint[];
  readonly current: PhysicalFrame | null;
  readonly pagination: BookPaginationSnapshot | null;
  readonly onNavigate: (point: JoinedTocPoint) => void;
}) {
  const [expanded, setExpanded] = useAtom(authoredNavigationExpandedAtom);
  const idPrefix = useId();
  const expandedForLocation = useRef<string | null>(null);
  const previousPoints = useRef(points);

  useEffect(() => {
    const location =
      current === null ? "none" : `${current.generation}:${current.occurrence}:${current.resource}`;
    const publicationChanged = previousPoints.current !== points;
    previousPoints.current = points;
    if (!publicationChanged && expandedForLocation.current === location) return;
    expandedForLocation.current = location;
    const activeAncestors = activeTocAncestorKeys(points, current);
    setExpanded((value) => {
      const next = publicationChanged ? new Set<string>() : new Set(value);
      for (const key of activeAncestors) next.add(key);
      return next.size === value.size ? value : next;
    });
  }, [points, current, setExpanded]);

  return (
    <TocLevel
      points={points}
      current={current}
      pagination={pagination}
      onNavigate={onNavigate}
      path={[]}
      idPrefix={idPrefix}
      expanded={expanded}
      onExpandedChange={setExpanded}
    />
  );
}

function TocLevel({
  points,
  current,
  pagination,
  onNavigate,
  path,
  idPrefix,
  expanded,
  onExpandedChange,
}: {
  readonly points: readonly JoinedTocPoint[];
  readonly current: PhysicalFrame | null;
  readonly pagination: BookPaginationSnapshot | null;
  readonly onNavigate: (point: JoinedTocPoint) => void;
  readonly path: readonly number[];
  readonly idPrefix: string;
  readonly expanded: ReadonlySet<string>;
  readonly onExpandedChange: (value: ReadonlySet<string>) => void;
}) {
  // Authored hidden flags only affect in-spine rendering, not generated navigation.
  const visiblePoints = points.map((point, index) => ({ point, authoredIndex: index }));
  const branchKeys = visiblePoints.flatMap(({ point, authoredIndex }) =>
    point.children.length > 0 ? [tocPointKey([...path, authoredIndex])] : [],
  );
  const openBranches = branchKeys.filter((key) => expanded.has(key));

  return (
    <Accordion.Root
      multiple
      value={openBranches}
      onValueChange={(value) => {
        const next = new Set(expanded);
        for (const key of branchKeys) next.delete(key);
        for (const key of value) next.add(key);
        onExpandedChange(next);
      }}
      render={<ol className="m-0 grid list-none gap-0 p-0" />}
    >
      {visiblePoints.map(({ point, authoredIndex }) => {
        const pointPath = [...path, authoredIndex];
        const key = tocPointKey(pointPath);
        const unavailableId = `${idPrefix}-${key.replaceAll(".", "-")}-unavailable`;
        const occurrence = tocPointOccurrence(point);
        const actionable = occurrence !== null && point.resource !== null;
        const label = point.point.label ?? "Untitled section";
        const globalPage = tocGlobalPage(point, occurrence, pagination);
        const active =
          occurrence !== null &&
          current?.occurrence === occurrence &&
          current.resource === point.resource &&
          isAddressedTarget(point.target) &&
          point.target.fragment === null;
        return (
          <Accordion.Item key={key} value={key} render={<li />}>
            <Accordion.Header className="m-0 flex items-start gap-0.5 text-sm font-normal">
              {point.children.length > 0 ? (
                <Accordion.Trigger
                  className="group/accordion-trigger inline-flex h-11 w-7 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent p-0 text-muted-foreground outline-none hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2"
                  aria-label={`Toggle ${label}`}
                >
                  <ChevronRight
                    className="size-3.5 group-data-panel-open/accordion-trigger:rotate-90"
                    aria-hidden="true"
                  />
                </Accordion.Trigger>
              ) : (
                <span className="w-7 shrink-0" aria-hidden="true" />
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={!actionable}
                aria-describedby={actionable ? undefined : unavailableId}
                aria-current={active ? "location" : undefined}
                onClick={() => onNavigate(point)}
                className={cn(
                  "h-auto min-h-11 min-w-0 flex-1 justify-start whitespace-normal rounded-xl px-2 py-2 text-left font-normal",
                  active && "bg-accent font-medium text-accent-foreground",
                )}
              >
                <span className="min-w-0 flex-1">{label}</span>
                {globalPage === null ? null : (
                  <span className="ms-3 shrink-0 tabular-nums text-muted-foreground">
                    {globalPage === "pending" ? (
                      <span aria-label="Page pending">...</span>
                    ) : (
                      globalPage
                    )}
                  </span>
                )}
              </Button>
              {!actionable ? (
                <span id={unavailableId} className="sr-only">
                  {unavailableTargetMessage(point.target, point.resource)}
                </span>
              ) : null}
            </Accordion.Header>
            {point.children.length > 0 ? (
              <Accordion.Panel className="epub-navigator-reader__toc-branch h-(--accordion-panel-height) overflow-hidden data-ending-style:h-0 data-starting-style:h-0">
                <div className="ms-3.5 border-s">
                  {expanded.has(key) ? (
                    <TocLevel
                      points={point.children}
                      current={current}
                      pagination={pagination}
                      onNavigate={onNavigate}
                      path={pointPath}
                      idPrefix={idPrefix}
                      expanded={expanded}
                      onExpandedChange={onExpandedChange}
                    />
                  ) : null}
                </div>
              </Accordion.Panel>
            ) : null}
          </Accordion.Item>
        );
      })}
    </Accordion.Root>
  );
}

function tocGlobalPage(
  point: JoinedTocPoint,
  occurrence: number | null,
  pagination: BookPaginationSnapshot | null,
): number | "pending" | null {
  if (occurrence === null || pagination === null || !isAddressedTarget(point.target)) {
    return null;
  }
  if (pagination.freshness !== "current") return "pending";
  const precedingPages = pagination.pageStart(occurrence);
  if (precedingPages === "pending") return "pending";
  if (precedingPages === null) return null;
  let occurrenceEntry: Extract<
    BookPaginationSnapshot["occurrences"][number],
    { state: "measured" }
  > | null = null;
  const entry = pagination.occurrences[occurrence];
  if (entry?.state === "pending" || entry?.state === "measuring") return "pending";
  if (entry?.state !== "measured") return null;
  occurrenceEntry = entry;
  if (point.target.fragment === null) return precedingPages + 1;
  const target = indexedTocTarget(pagination, occurrence, point.listIndex, point.pointPath);
  if (target?.result.state === "pending") return "pending";
  return target?.result.state === "located" &&
    target.result.physicalPage < (occurrenceEntry?.pageCount ?? 0)
    ? precedingPages + target.result.physicalPage + 1
    : null;
}

const tocTargetIndexes = new WeakMap<
  BookPaginationSnapshot,
  Map<
    number,
    ReadonlyMap<
      string,
      Extract<
        BookPaginationSnapshot["occurrences"][number],
        { state: "measured" }
      >["tocTargets"][number]
    >
  >
>();

function indexedTocTarget(
  pagination: BookPaginationSnapshot,
  occurrence: number,
  listIndex: number,
  pointPath: readonly number[],
) {
  let occurrenceIndexes = tocTargetIndexes.get(pagination);
  if (occurrenceIndexes === undefined) {
    occurrenceIndexes = new Map();
    tocTargetIndexes.set(pagination, occurrenceIndexes);
  }
  let targets = occurrenceIndexes.get(occurrence);
  if (targets === undefined) {
    const entry = pagination.occurrences[occurrence];
    targets = new Map(
      entry?.state === "measured"
        ? entry.tocTargets.map((target) => [
            `${target.listIndex}:${target.pointPath.join("/")}`,
            target,
          ])
        : [],
    );
    occurrenceIndexes.set(occurrence, targets);
  }
  return targets.get(`${listIndex}:${pointPath.join("/")}`);
}

function activeTocAncestorKeys(
  points: readonly JoinedTocPoint[],
  current: PhysicalFrame | null,
  path: readonly number[] = [],
): string[] {
  const keys: string[] = [];
  for (const [index, point] of points.entries()) {
    const pointPath = [...path, index];
    const childKeys = activeTocAncestorKeys(point.children, current, pointPath);
    const childContainsCurrent = point.children.some((child) => tocPointIsCurrent(child, current));
    if (childContainsCurrent || childKeys.length > 0) {
      keys.push(tocPointKey(pointPath));
    }
    keys.push(...childKeys);
  }
  return keys;
}

function tocPointIsCurrent(point: JoinedTocPoint, current: PhysicalFrame | null): boolean {
  const occurrence = tocPointOccurrence(point);
  return (
    occurrence !== null &&
    current?.occurrence === occurrence &&
    current.resource === point.resource &&
    isAddressedTarget(point.target) &&
    point.target.fragment === null
  );
}

function tocPointKey(path: readonly number[]): string {
  return path.join(".");
}
