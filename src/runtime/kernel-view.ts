import type {
  ActiveDocumentParticipant,
  AdapterLayoutSettlement,
  CommittedDocument,
  DocumentObservation,
  FixedCompanionDocument,
  FixedSettlement,
  FixedSpreadPlacement,
  KernelSnapshot,
  NavigatorLocationBasis,
  NavigatorLocation,
  OccurrenceDocumentTarget,
  OccurrenceRenditionSetting,
  PaginatedLayout,
  PendingDocument,
  PhysicalFrame,
  PreparedFrame,
  PreparedLayout,
  ReadingOrderOccurrence,
  ReflowableSettlement,
} from "../generated/kernel.js";
import type { PublicationFacts } from "../generated/publication.js";

export interface FixedSpreadPlan {
  readonly primaryOccurrence: number;
  readonly primaryPlacement: FixedSpreadPlacement;
  readonly centered: "spread-ineligible" | "page-spread-center" | null;
  readonly companionOccurrence: number | null;
  readonly companionPlacement: Exclude<FixedSpreadPlacement, "center"> | null;
  readonly direction: "ltr" | "rtl";
}

export function currentDocument(snapshot: KernelSnapshot): CommittedDocument | null {
  return snapshot.document.committed;
}

export function currentFrame(snapshot: KernelSnapshot): PhysicalFrame | null {
  return currentDocument(snapshot)?.frame ?? null;
}

export function fixedCompanionDocument(snapshot: KernelSnapshot): FixedCompanionDocument | null {
  return snapshot.document.fixedCompanion;
}

export function fixedCompanionFrame(snapshot: KernelSnapshot): PhysicalFrame | null {
  return fixedCompanionDocument(snapshot)?.frame ?? null;
}

export function fixedCompanionSettlement(snapshot: KernelSnapshot): AdapterLayoutSettlement | null {
  const companion = fixedCompanionDocument(snapshot);
  const settlement = companion?.layout.layout.settlement;
  return companion !== null &&
    settlement !== undefined &&
    settlement.adapter === companion.frame.adapter
    ? settlement
    : null;
}

export function primaryParticipant(
  snapshot: KernelSnapshot,
): Extract<ActiveDocumentParticipant, { kind: "primary" }> | null {
  const document = currentDocument(snapshot);
  return document === null ? null : { kind: "primary", documentGeneration: document.generation };
}

export function fixedCompanionParticipant(
  snapshot: KernelSnapshot,
): Extract<ActiveDocumentParticipant, { kind: "fixed-companion" }> | null {
  const companion = fixedCompanionDocument(snapshot);
  return companion === null
    ? null
    : {
        kind: "fixed-companion",
        ownerDocumentGeneration: companion.ownerDocumentGeneration,
        frameGeneration: companion.frame.generation,
      };
}

export function currentObservation(snapshot: KernelSnapshot): DocumentObservation | null {
  return currentDocument(snapshot)?.layout.observation ?? null;
}

export interface CommittedCurrentLocation {
  readonly location: NavigatorLocation;
  readonly basis: NavigatorLocationBasis;
}

/** Derives a passive point from the first available settled visible boundary. */
export function committedCurrentLocation(
  snapshot: KernelSnapshot,
): CommittedCurrentLocation | null {
  const document = currentDocument(snapshot);
  if (document === null || document.layout.state !== "settled") return null;
  const boundary =
    document.layout.observation.visibleStart.state === "located"
      ? document.layout.observation.visibleStart
      : document.layout.observation.visibleEnd;
  if (boundary.state !== "located") return null;
  return {
    location: {
      kind: "point",
      occurrence: document.frame.occurrence,
      resource: document.frame.resource,
      evidence: [...boundary.evidence],
      observation: {
        layoutProgression: null,
        renderedTextProgression: document.layout.observation.renderedTextProgression,
      },
    },
    basis: {
      documentGeneration: document.generation,
      frameGeneration: document.frame.generation,
      layoutGeneration: document.layout.layout.layoutGeneration,
    },
  };
}

export function currentReflowSettlement(snapshot: KernelSnapshot): ReflowableSettlement | null {
  const settlement = currentDocument(snapshot)?.layout.layout.settlement;
  return settlement?.adapter === "reflowable-xhtml" ? settlement.settlement : null;
}

export function currentFixedSettlement(snapshot: KernelSnapshot): FixedSettlement | null {
  const settlement = currentDocument(snapshot)?.layout.layout.settlement;
  return settlement !== undefined &&
    isFixedAdapterSettlement(settlement) &&
    currentFrame(snapshot)?.adapter === settlement.adapter
    ? settlement.settlement
    : null;
}

export function currentPaginatedLayout(snapshot: KernelSnapshot): PaginatedLayout | null {
  const settlement = currentReflowSettlement(snapshot);
  if (settlement?.mode !== "paginated") return null;
  const pages = settlement.pages;
  const live = currentObservation(snapshot)?.pagination;
  return live !== null && live !== undefined && live.pageCount === pages.pageCount
    ? {
        ...pages,
        firstVisiblePage: live.firstVisiblePage,
        visiblePageCount: live.visiblePageCount,
      }
    : pages;
}

export function foregroundLayoutPending(snapshot: KernelSnapshot): boolean {
  return snapshot.layout.pending?.owner.kind === "document";
}

export function pendingDocumentFrame(document: PendingDocument): PhysicalFrame {
  return document.state.state === "preparing" || document.state.state === "promotion-acknowledging"
    ? document.state.prepared.frame
    : document.state.frame;
}

export function preparedSettledLayout(prepared: PreparedFrame): PreparedLayout | null {
  return prepared.state.state === "prepared" ? prepared.state.layout : null;
}

export function occurrenceLoadableTarget(
  occurrence: ReadingOrderOccurrence | undefined,
): Extract<OccurrenceDocumentTarget, { state: "loadable" }> | null {
  return occurrence?.document.state === "loadable" ? occurrence.document : null;
}

export function occurrenceAliasesResource(
  facts: PublicationFacts,
  occurrence: ReadingOrderOccurrence | undefined,
  resource: string,
): boolean {
  const effective = occurrenceLoadableTarget(occurrence)?.resource;
  if (effective === resource) return true;
  const target = occurrence?.target;
  if (target?.state !== "declaration" || target.resource === null) return false;
  const original = facts.resources.resources[target.resource];
  return original?.address.kind === "local" && original.address.value === resource;
}

export function fixedSpreadPlan(
  snapshot: KernelSnapshot,
  primaryOrdinal: number,
  viewportWidth: number,
  viewportHeight: number,
): FixedSpreadPlan | null {
  if (!validViewport(viewportWidth, viewportHeight)) return null;
  const primaryOccurrence = snapshot.readingOrder[primaryOrdinal];
  if (primaryOccurrence?.ordinal !== primaryOrdinal) return null;
  if (occurrenceLoadableTarget(primaryOccurrence) === null) return null;
  const direction = progressionDirection(primaryOccurrence);
  const placements = occurrencePlacements(snapshot.readingOrder, direction);
  const primaryPlacement = placements[primaryOrdinal];
  const eligible = fixedSpreadEligible(primaryOccurrence, viewportWidth, viewportHeight);
  if (!eligible || primaryPlacement === null || primaryPlacement === undefined) {
    return {
      primaryOccurrence: primaryOrdinal,
      primaryPlacement: "center",
      centered: "spread-ineligible",
      companionOccurrence: null,
      companionPlacement: null,
      direction,
    };
  }
  if (primaryPlacement === "center") {
    return {
      primaryOccurrence: primaryOrdinal,
      primaryPlacement,
      centered: "page-spread-center",
      companionOccurrence: null,
      companionPlacement: null,
      direction,
    };
  }
  const leading = direction === "ltr" ? "left" : "right";
  const trailing = direction === "ltr" ? "right" : "left";
  const companionOccurrence =
    primaryPlacement === leading ? primaryOrdinal + 1 : primaryOrdinal - 1;
  const companion = snapshot.readingOrder[companionOccurrence];
  if (
    companion?.ordinal !== companionOccurrence ||
    progressionDirection(companion) !== direction ||
    placements[companionOccurrence] !== (primaryPlacement === leading ? trailing : leading) ||
    !fixedOrientationsCompatible(primaryOccurrence, companion) ||
    !fixedSpreadEligible(companion, viewportWidth, viewportHeight)
  ) {
    return {
      primaryOccurrence: primaryOrdinal,
      primaryPlacement,
      centered: null,
      companionOccurrence: null,
      companionPlacement: null,
      direction,
    };
  }
  return {
    primaryOccurrence: primaryOrdinal,
    primaryPlacement,
    centered: null,
    companionOccurrence,
    companionPlacement: placements[companionOccurrence],
    direction,
  };
}

function occurrencePlacements(
  readingOrder: readonly ReadingOrderOccurrence[],
  direction: "ltr" | "rtl",
): readonly (FixedSpreadPlacement | null)[] {
  const initial = direction === "ltr" ? "right" : "left";
  let automatic: "left" | "right" | null = initial;
  return readingOrder.map((occurrence) => {
    const authored = effectiveRenditionValue(occurrence.presentation.pageSpread);
    if (authored === null) {
      automatic = null;
      return null;
    }
    if (authored === "center") {
      automatic = initial;
      return "center";
    }
    if (authored === "left" || authored === "right") {
      automatic = oppositePlacement(authored);
      return authored;
    }
    // A reflowable page only joins a synthetic spread when the itemref says so.
    if (occurrenceLoadableTarget(occurrence)?.adapter === "reflowable-xhtml") {
      automatic = initial;
      return null;
    }
    if (automatic === null) return null;
    const placement = automatic;
    automatic = oppositePlacement(placement);
    return placement;
  });
}

function fixedSpreadEligible(
  occurrence: ReadingOrderOccurrence,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  if (occurrenceLoadableTarget(occurrence) === null) return false;
  const orientation =
    viewportWidth > viewportHeight
      ? "landscape"
      : viewportHeight > viewportWidth
        ? "portrait"
        : null;
  if (orientationValue(occurrence) === null) return false;
  const value = effectiveRenditionValue(occurrence.presentation.spread);
  if (value === undefined) return orientation === "landscape";
  if (value === null || value === "none") return false;
  if (value === "both") return true;
  if (value === "auto") return orientation === "landscape";
  return value === orientation;
}

export function fixedOrientationsCompatible(
  primary: ReadingOrderOccurrence,
  companion: ReadingOrderOccurrence,
): boolean {
  const primaryOrientation = orientationValue(primary);
  const companionOrientation = orientationValue(companion);
  if (primaryOrientation === null || companionOrientation === null) return false;
  return (
    primaryOrientation === undefined ||
    primaryOrientation === "auto" ||
    companionOrientation === undefined ||
    companionOrientation === "auto" ||
    primaryOrientation === companionOrientation
  );
}

function orientationValue(
  occurrence: ReadingOrderOccurrence,
): "auto" | "landscape" | "portrait" | null | undefined {
  return effectiveRenditionValue(occurrence.presentation.orientation);
}

function effectiveRenditionValue<T>(setting: OccurrenceRenditionSetting<T>): T | null | undefined {
  if (setting.state === "unspecified") return undefined;
  if (setting.state === "specified") return setting.value.value;
  // Preserve package ambiguity and authored evidence; only itemref overrides are ordered choices.
  return (
    setting.value.find(
      (candidate) => candidate.source === "item-ref-property" && candidate.value !== null,
    )?.value ?? null
  );
}

function progressionDirection(occurrence: ReadingOrderOccurrence): "ltr" | "rtl" {
  return occurrence.presentation.pageProgressionDirection === "rtl" ? "rtl" : "ltr";
}

function oppositePlacement(placement: "left" | "right"): "left" | "right" {
  return placement === "left" ? "right" : "left";
}

function validViewport(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

type FixedDocumentAdapter = "fixed-xhtml" | "fixed-svg" | "fixed-image";

function isFixedAdapter(adapter: string): adapter is FixedDocumentAdapter {
  return adapter === "fixed-xhtml" || adapter === "fixed-svg" || adapter === "fixed-image";
}

function isFixedAdapterSettlement(
  settlement: AdapterLayoutSettlement,
): settlement is Extract<AdapterLayoutSettlement, { adapter: FixedDocumentAdapter }> {
  return isFixedAdapter(settlement.adapter);
}
