import type { NavigatorLocation, NavigatorLocationBasis } from "../../generated/kernel.js";

type LocationBasis = Pick<
  NavigatorLocationBasis,
  "documentGeneration" | "frameGeneration" | "layoutGeneration"
>;

export function sameDurablePoint(
  leftLocation: NavigatorLocation | null,
  leftBasis: LocationBasis | null,
  rightLocation: NavigatorLocation | null,
  rightBasis: LocationBasis | null,
): boolean {
  return (
    leftLocation?.kind === "point" &&
    rightLocation?.kind === "point" &&
    leftBasis !== null &&
    rightBasis !== null &&
    leftLocation.occurrence === rightLocation.occurrence &&
    leftLocation.resource === rightLocation.resource &&
    JSON.stringify(stableEvidence(leftLocation)) ===
      JSON.stringify(stableEvidence(rightLocation)) &&
    leftLocation.observation.renderedTextProgression ===
      rightLocation.observation.renderedTextProgression &&
    leftBasis.documentGeneration === rightBasis.documentGeneration &&
    leftBasis.frameGeneration === rightBasis.frameGeneration &&
    leftBasis.layoutGeneration === rightBasis.layoutGeneration
  );
}

function stableEvidence(location: Extract<NavigatorLocation, { kind: "point" }>) {
  return location.evidence.filter((evidence) => evidence.kind !== "rendered-text-context");
}
