import type {
  NavigationTarget,
  NavigationList,
  NavigationPoint,
  PublicationFacts,
} from "../../generated/publication.js";
import type { TocTargetMeasurementRequest } from "../../runtime/agent-protocol/index.js";

/** A navigation target that resolved to an address, and therefore carries a fragment. */
export type AddressedNavigationTarget = Extract<
  NavigationTarget,
  { state: "resource" | "missing-resource" | "unindexed-address" }
>;

export function isAddressedTarget(target: NavigationTarget): target is AddressedNavigationTarget {
  return (
    target.state === "resource" ||
    target.state === "missing-resource" ||
    target.state === "unindexed-address"
  );
}

export interface AuthoredNavigationPoint {
  readonly listIndex: number;
  readonly pointPath: readonly number[];
  readonly point: NavigationPoint;
  readonly target: NavigationTarget;
  readonly resource: string | null;
  readonly occurrences: readonly number[];
  readonly navigationOccurrence: number | null;
  readonly children: readonly AuthoredNavigationPoint[];
}

export type JoinedTocPoint = AuthoredNavigationPoint;

export type AuthoredNavigationSemantic = "toc" | "page-list" | "landmarks";

export type AuthoredNavigationListValue<Semantic extends AuthoredNavigationSemantic> =
  NavigationList & {
    readonly semantic: Semantic;
  };

export interface AuthoredNavigationList<Semantic extends AuthoredNavigationSemantic> {
  readonly listIndex: number;
  readonly list: AuthoredNavigationListValue<Semantic>;
  readonly points: readonly AuthoredNavigationPoint[];
}

export interface AuthoredNavigationProjection {
  readonly contents: readonly AuthoredNavigationList<"toc">[];
  readonly pages: readonly AuthoredNavigationList<"page-list">[];
  readonly landmarks: readonly AuthoredNavigationList<"landmarks">[];
}

export interface AuthoredPageRange {
  readonly first: string;
  readonly last: string;
}

export interface AuthoredPageContextTarget {
  readonly request: TocTargetMeasurementRequest;
  readonly label: string;
}

/** A page-list target's zero-based physical page in one settled layout of its document. */
export interface AuthoredPagePosition {
  readonly listIndex: number;
  readonly pointPath: readonly number[];
  readonly physicalPage: number;
}

export interface JoinedToc {
  readonly list: NavigationList;
  readonly points: readonly JoinedTocPoint[];
}

function flattenedPageListPoints(
  projection: AuthoredNavigationProjection,
): readonly AuthoredNavigationPoint[] {
  const points: AuthoredNavigationPoint[] = [];
  const visit = (children: readonly AuthoredNavigationPoint[]): void => {
    for (const point of children) {
      points.push(point);
      visit(point.children);
    }
  };
  visit(projection.pages[0]?.points ?? []);
  return points;
}

function joinNavigationList(
  facts: PublicationFacts,
  list: NavigationList,
  listIndex: number,
  targets: ReadonlyMap<string, NavigationTarget>,
  occurrencesByResource: ReadonlyMap<number, readonly number[]>,
): readonly JoinedTocPoint[] {
  const join = (point: NavigationPoint, pointPath: readonly number[]): JoinedTocPoint => {
    const target = targets.get(`${listIndex}:${pointPath.join("/")}`) ?? { state: "missing-href" };
    const resourceFacts =
      target.state === "resource" ? facts.resources.resources[target.resource] : undefined;
    const resource = resourceFacts?.address.kind === "local" ? resourceFacts.address.value : null;
    const occurrences =
      target.state === "resource" ? (occurrencesByResource.get(target.resource) ?? []) : [];

    return {
      listIndex,
      pointPath,
      point,
      target,
      resource,
      occurrences,
      // Hyperlinks select the first linear instance; context retains every instance.
      navigationOccurrence:
        occurrences.find((ordinal) => facts.package.spine?.itemrefs[ordinal]?.linear !== "no") ??
        occurrences[0] ??
        null,
      children: point.children.map((child, index) => join(child, [...pointPath, index])),
    };
  };

  return list.points.map((point, index) => join(point, [index]));
}

export function projectAuthoredNavigation(facts: PublicationFacts): AuthoredNavigationProjection {
  const contents: AuthoredNavigationList<"toc">[] = [];
  const pages: AuthoredNavigationList<"page-list">[] = [];
  const landmarks: AuthoredNavigationList<"landmarks">[] = [];
  const { targets, occurrencesByResource } = navigationIndexes(facts);

  facts.navigation?.lists.forEach((list, listIndex) => {
    const points = joinNavigationList(facts, list, listIndex, targets, occurrencesByResource);
    switch (list.semantic) {
      case "toc":
        contents.push({ listIndex, list: { ...list, semantic: "toc" }, points });
        break;
      case "page-list":
        pages.push({ listIndex, list: { ...list, semantic: "page-list" }, points });
        break;
      case "landmarks":
        landmarks.push({ listIndex, list: { ...list, semantic: "landmarks" }, points });
        break;
      default:
        break;
    }
  });

  return { contents, pages, landmarks };
}

/** Uses the same single authored TOC source measured by the pagination coordinator. */
export function progressMarkerPoints(
  projection: AuthoredNavigationProjection,
): readonly AuthoredNavigationPoint[] {
  return projection.contents[0]?.points ?? [];
}

export function currentSectionLabel(
  projection: AuthoredNavigationProjection,
  current: { readonly occurrence: number; readonly resource: string } | null,
  readingOrderLength: number,
): string {
  if (current === null) return "Preparing section";

  return authoredSectionLabel(projection, current, readingOrderLength);
}

export function authoredSectionLabel(
  projection: AuthoredNavigationProjection,
  section: { readonly occurrence: number; readonly resource: string },
  readingOrderLength: number,
): string {
  const selected: { point: AuthoredNavigationPoint | null; depth: number } = {
    point: null,
    depth: 0,
  };
  const visit = (points: readonly AuthoredNavigationPoint[], depth: number): void => {
    for (const point of points) {
      if (
        isAddressedTarget(point.target) &&
        point.target.fragment === null &&
        point.resource === section.resource &&
        point.occurrences.includes(section.occurrence) &&
        depth > selected.depth
      ) {
        selected.point = point;
        selected.depth = depth;
      }
      visit(point.children, depth + 1);
    }
  };
  visit(projection.contents[0]?.points ?? [], 1);

  const label = selected.point?.point.label;
  return label !== null && label !== undefined && label.trim().length > 0
    ? label
    : `Section ${section.occurrence + 1} of ${readingOrderLength}`;
}

/** Returns the authored page at the logical start of the visible content. */
export function currentAuthoredPageRange(
  projection: AuthoredNavigationProjection,
  currentOccurrence: number | null,
  visibleRange: { readonly firstOccurrence: number; readonly lastOccurrence: number } | null,
): AuthoredPageRange | null {
  if (currentOccurrence === null || projection.pages.length !== 1) return null;
  const firstOccurrence = visibleRange?.firstOccurrence ?? currentOccurrence;
  const lastOccurrence = visibleRange?.lastOccurrence ?? currentOccurrence;
  if (
    firstOccurrence > lastOccurrence ||
    currentOccurrence < firstOccurrence ||
    currentOccurrence > lastOccurrence
  ) {
    return null;
  }

  const points = flattenedPageListPoints(projection);

  const labelForOccurrence = (occurrence: number): string | null => {
    const matching = points.filter((point) => point.occurrences.includes(occurrence));
    if (matching.length !== 1) return null;
    const point = matching[0];
    if (point === undefined || !isAddressedTarget(point.target) || point.target.fragment !== null)
      return null;
    const label = point.point.label;
    return label !== null && label.trim().length > 0 ? label : null;
  };

  const first = labelForOccurrence(firstOccurrence);
  return first === null ? null : { first, last: first };
}

export function authoredPageContextTargets(
  projection: AuthoredNavigationProjection,
  occurrence: number | null,
): readonly AuthoredPageContextTarget[] {
  if (occurrence === null || projection.pages.length !== 1) return [];
  const targets: AuthoredPageContextTarget[] = [];
  const visit = (points: readonly AuthoredNavigationPoint[]): void => {
    for (const point of points) {
      const label = point.point.label;
      if (
        point.occurrences.includes(occurrence) &&
        label !== null &&
        label.trim().length > 0 &&
        isAddressedTarget(point.target)
      ) {
        targets.push({
          request: {
            listIndex: point.listIndex,
            pointPath: point.pointPath,
            evidence: [
              point.target.fragment === null
                ? { kind: "document-boundary", boundary: "start" }
                : { kind: "html-fragment", value: point.target.fragment },
            ],
          },
          label,
        });
      }
      visit(point.children);
    }
  };
  visit(projection.pages[0]?.points ?? []);
  return targets;
}

export function authoredPagePredecessorLabel(
  projection: AuthoredNavigationProjection,
  occurrence: number | null,
): string | null {
  if (occurrence === null || projection.pages.length !== 1) return null;
  const points = flattenedPageListPoints(projection);
  const firstLocalIndex = points.findIndex(
    (point) =>
      point.target.state === "resource" &&
      point.occurrences.length === 1 &&
      point.occurrences[0] === occurrence,
  );
  if (firstLocalIndex <= 0) return null;
  const predecessor = points[firstLocalIndex - 1];
  if (
    predecessor?.target.state !== "resource" ||
    predecessor.occurrences.length !== 1 ||
    predecessor.occurrences[0]! >= occurrence
  ) {
    return null;
  }
  const label = predecessor.point.label;
  return label !== null && label.trim().length > 0 ? label : null;
}

export function authoredPageRangeAtPages(
  targets: readonly AuthoredPageContextTarget[],
  positions: readonly AuthoredPagePosition[],
  visiblePages: { readonly first: number; readonly last: number },
  predecessorLabel: string | null = null,
): AuthoredPageRange | null {
  const labelAt = (page: number): string | null => {
    let best: { readonly physicalPage: number; readonly label: string } | null = null;
    for (const target of targets) {
      const position = positions.find(
        (candidate) =>
          candidate.listIndex === target.request.listIndex &&
          candidate.pointPath.length === target.request.pointPath.length &&
          candidate.pointPath.every((value, index) => value === target.request.pointPath[index]),
      );
      if (
        position !== undefined &&
        position.physicalPage <= page &&
        (best === null || position.physicalPage >= best.physicalPage)
      ) {
        best = { physicalPage: position.physicalPage, label: target.label };
      }
    }
    return best?.label ?? predecessorLabel;
  };
  const first = labelAt(visiblePages.first);
  if (first === null) return null;
  const last = labelAt(Math.max(visiblePages.first, visiblePages.last)) ?? first;
  return { first, last };
}

export function joinTableOfContents(facts: PublicationFacts): JoinedToc | null {
  const document = facts.navigation;
  if (document === null) return null;
  const listIndex = document.lists.findIndex((list) => list.semantic === "toc");
  const list = document.lists[listIndex];
  if (list === undefined) return null;
  const { targets, occurrencesByResource } = navigationIndexes(facts);

  return {
    list,
    points: joinNavigationList(facts, list, listIndex, targets, occurrencesByResource),
  };
}

function navigationIndexes(facts: PublicationFacts): {
  readonly targets: ReadonlyMap<string, NavigationTarget>;
  readonly occurrencesByResource: ReadonlyMap<number, readonly number[]>;
} {
  const targets = new Map(
    facts.navigationTargets.map(
      (target) => [`${target.listIndex}:${target.pointPath.join("/")}`, target.target] as const,
    ),
  );
  const occurrencesByResource = new Map<number, number[]>();
  facts.resources.readingOrder.forEach((occurrence, ordinal) => {
    if (occurrence.resource === null) return;
    const occurrences = occurrencesByResource.get(occurrence.resource) ?? [];
    occurrences.push(ordinal);
    occurrencesByResource.set(occurrence.resource, occurrences);
  });
  return { targets, occurrencesByResource };
}

export function tocPointOccurrence(point: JoinedTocPoint): number | null {
  return point.navigationOccurrence;
}
