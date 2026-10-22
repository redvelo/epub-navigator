import type { OccurrenceDocumentTarget } from "../../generated/kernel.js";
import type { NavigationPoint, PublicationFacts } from "../../generated/publication.js";
import type { TocTargetMeasurementRequest } from "../agent-protocol/index.js";
import { freezeOccurrence } from "./occurrence-state.js";
import type { OccurrencePagination } from "./types.js";

export function indexTocTargetRequests(
  facts: PublicationFacts,
  documents: readonly OccurrenceDocumentTarget[],
): readonly (readonly TocTargetMeasurementRequest[])[] {
  const requests = facts.resources.readingOrder.map(() => [] as TocTargetMeasurementRequest[]);
  const occurrencesByResource = new Map<number, number[]>();
  for (const [occurrence, document] of documents.entries()) {
    const resource = resourceOrdinalForDocument(facts, document);
    if (resource === null) continue;
    const occurrences = occurrencesByResource.get(resource) ?? [];
    occurrences.push(occurrence);
    occurrencesByResource.set(resource, occurrences);
  }
  const visiblePointPathsByList = new Map<number, ReadonlySet<string>>();
  facts.navigation?.lists.forEach((list, listIndex) => {
    if (list.semantic === "toc") {
      visiblePointPathsByList.set(listIndex, visibleNavigationPointPaths(list.points));
    }
  });
  if (visiblePointPathsByList.size === 0) return Object.freeze(requests);
  for (const navigationTarget of facts.navigationTargets) {
    const href = navigationTarget.target;
    const visiblePointPaths = visiblePointPathsByList.get(navigationTarget.listIndex);
    if (
      href.state !== "resource" ||
      visiblePointPaths === undefined ||
      !visiblePointPaths.has(navigationTarget.pointPath.join("/")) ||
      href.fragment === null
    ) {
      continue;
    }
    const request = Object.freeze({
      listIndex: navigationTarget.listIndex,
      pointPath: Object.freeze(navigationTarget.pointPath.slice()),
      evidence: Object.freeze([{ kind: "html-fragment" as const, value: href.fragment }]),
    });
    for (const occurrence of occurrencesByResource.get(href.resource) ?? []) {
      requests[occurrence]?.push(request);
    }
  }
  return Object.freeze(requests.map((occurrenceRequests) => Object.freeze(occurrenceRequests)));
}

export function initialEntries(
  facts: PublicationFacts,
  documents: readonly OccurrenceDocumentTarget[],
  eligibleResourcePaths: ReadonlySet<string> | null,
): OccurrencePagination[] {
  return Object.freeze(
    facts.resources.readingOrder.map((occurrence, ordinal) => {
      const document = documents[ordinal];
      if (document === undefined || document.state === "unresolved") {
        return freezeOccurrence({
          occurrence: ordinal,
          resource: null,
          state: "unavailable",
          reason: "occurrence-document-unresolved",
        });
      }
      if (document.state === "unavailable") {
        return freezeOccurrence({
          occurrence: ordinal,
          resource: document.resource,
          state: "unavailable",
          reason: document.reason,
        });
      }
      const resourceOrdinal = resourceOrdinalForDocument(facts, document);
      if (resourceOrdinal === null) {
        return freezeOccurrence({
          occurrence: ordinal,
          resource: document.resource,
          state: "unavailable",
          reason: occurrence.target?.state ?? "missing-idref",
        });
      }
      const resource = facts.resources.resources[resourceOrdinal];
      if (
        resource?.address.kind !== "local" ||
        resource.address.value !== document.resource ||
        resource.presence.state !== "present"
      ) {
        return freezeOccurrence({
          occurrence: ordinal,
          resource: document.resource,
          state: "unavailable",
          reason: "resource-unavailable",
        });
      }
      if (resource.scripted) {
        return freezeOccurrence({
          occurrence: ordinal,
          resource: resource.address.value,
          state: "unavailable",
          reason: "declared-scripted",
        });
      }
      if (eligibleResourcePaths !== null && !eligibleResourcePaths.has(resource.address.value)) {
        return freezeOccurrence({
          occurrence: ordinal,
          resource: resource.address.value,
          state: "unavailable",
          reason: "executable-content-detected-or-unknown",
        });
      }
      return freezeOccurrence({
        occurrence: ordinal,
        resource: resource.address.value,
        state: "pending",
      });
    }),
  ) as OccurrencePagination[];
}

export function occurrenceWeights(
  facts: PublicationFacts,
  documents: readonly OccurrenceDocumentTarget[],
): readonly number[] {
  return Object.freeze(
    facts.resources.readingOrder.map((_, ordinal) => {
      const document = documents[ordinal];
      if (document?.state !== "loadable" || document.adapter !== "reflowable-xhtml") return 0;
      const resourceOrdinal = resourceOrdinalForDocument(facts, document);
      const size =
        resourceOrdinal === null
          ? null
          : (() => {
              const presence = facts.resources.resources[resourceOrdinal]?.presence;
              return presence?.state === "present" ? presence.sizeBytes : null;
            })();
      const bytes = size === null || size === undefined ? 0 : Number(size);
      return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    }),
  );
}

function resourceOrdinalForDocument(
  facts: PublicationFacts,
  document: OccurrenceDocumentTarget | undefined,
): number | null {
  if (document?.state !== "loadable") return null;
  const ordinal = facts.resources.resources.findIndex(
    (resource) => resource.address.kind === "local" && resource.address.value === document.resource,
  );
  return ordinal < 0 ? null : ordinal;
}

export function publicationDocuments(facts: PublicationFacts): OccurrenceDocumentTarget[] {
  return facts.resources.readingOrder.map((occurrence) => {
    const value: unknown = occurrence;
    if (!isRecord(value) || !isRecord(value.document)) return { state: "unresolved" };
    const document = value.document;
    if (
      document.state === "loadable" &&
      typeof document.resource === "string" &&
      (document.adapter === "reflowable-xhtml" ||
        document.adapter === "fixed-xhtml" ||
        document.adapter === "fixed-svg" ||
        document.adapter === "fixed-image")
    ) {
      return { state: "loadable", resource: document.resource, adapter: document.adapter };
    }
    if (document.state === "unavailable") {
      const resource = typeof document.resource === "string" ? document.resource : null;
      const reason = document.reason;
      const adapter =
        document.adapter === "reflowable-xhtml" ||
        document.adapter === "fixed-xhtml" ||
        document.adapter === "fixed-svg" ||
        document.adapter === "fixed-image"
          ? document.adapter
          : null;
      if (
        reason === "resource-missing" ||
        reason === "non-local" ||
        reason === "document-adapter-unavailable" ||
        reason === "manifest-fallback-exhausted" ||
        reason === "manifest-fallback-unresolved" ||
        reason === "manifest-fallback-cycle" ||
        reason === "ambiguous-rendition" ||
        reason === "unsupported-rendition"
      ) {
        return { state: "unavailable", resource, adapter, reason };
      }
    }
    return { state: "unresolved" };
  });
}

function visibleNavigationPointPaths(points: readonly NavigationPoint[]): ReadonlySet<string> {
  const paths = new Set<string>();
  const visit = (siblings: readonly NavigationPoint[], parentPath: readonly number[]): void => {
    siblings.forEach((point, index) => {
      if (point.hidden) return;
      const path = [...parentPath, index];
      paths.add(path.join("/"));
      visit(point.children, path);
    });
  };
  visit(points, []);
  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
