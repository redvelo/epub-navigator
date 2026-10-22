import type { PublicationFacts, ReadingOrderPresentation } from "epub-navigator";

export const probeResource = "epub/text/milestone-1.xhtml";
export const operationTimeoutResource = "epub/text/milestone-2-operation-timeout.xhtml";

const xhtml = "application/xhtml+xml";

/** Adds coherent test-only declarations and occurrences without changing Alice's archive. */
export function addRuntimeLifecycleOverlay(source: PublicationFacts) {
  const facts = structuredClone(source);
  const presentation = structuredClone(facts.resources.readingOrder[0]?.presentation);
  if (presentation === undefined) throw new Error("Alice has no reading-order presentation");

  const probe = addResource(facts, probeResource, xhtml);
  addResource(facts, "epub/css/milestone-1.css", "text/css");
  addResource(facts, "epub/fonts/geist.woff2", "font/woff2");
  addResource(facts, "epub/js/milestone-1.js", "text/javascript");
  addResource(facts, "epub/media/milestone-2.mp3", "audio/mpeg");
  const occurrence = (path: string) =>
    addOccurrence(facts, addResource(facts, path, xhtml), presentation);

  return {
    facts,
    probeOccurrence: addOccurrence(facts, probe, presentation),
    duplicateOccurrence: addOccurrence(facts, probe, presentation),
    delayedOccurrence: occurrence("epub/text/milestone-1-delayed.xhtml"),
    missingOccurrence: occurrence("epub/text/milestone-1-missing.xhtml"),
    crossDocumentOccurrence: occurrence("epub/text/milestone-1-cross.xhtml"),
    operationTimeoutOccurrence: occurrence(operationTimeoutResource),
    pendingNavigationOccurrence: occurrence("epub/text/milestone-2-pending-navigation.xhtml"),
    annotationGenerationOccurrence: occurrence("epub/text/milestone-3-generation.xhtml"),
  };
}

interface AddedResource {
  readonly declaration: number;
  readonly resource: number;
  readonly id: string;
}

function addResource(facts: PublicationFacts, path: string, mediaType: string): AddedResource {
  const resource = facts.resources.resources.length;
  const declaration = facts.package.manifest.items.length;
  const id = `navigator-lifecycle-${declaration}`;
  facts.package.manifest.items.push({
    fallback: null,
    href: path.slice("epub/".length),
    mediaType,
    mediaOverlay: null,
    id,
    properties: [],
  });
  facts.resources.resources.push({
    address: { kind: "local", value: path },
    presence: { state: "present", sizeBytes: null },
    declarations: [declaration],
    hasXhtmlDeclaration: mediaType === xhtml,
    hasStylesheetDeclaration: mediaType === "text/css",
    hasSvgDeclaration: false,
    scripted: false,
  });
  facts.resources.declarations.push({
    id: { state: "valid", value: id },
    href: path.slice("epub/".length),
    target: { state: "resource", resource },
    mediaType,
    fallback: null,
    fallbackTarget: null,
  });
  return { declaration, resource, id };
}

function addOccurrence(
  facts: PublicationFacts,
  target: AddedResource,
  presentation: ReadingOrderPresentation,
): number {
  const ordinal = facts.resources.readingOrder.length;
  facts.package.spine.itemrefs.push({ id: null, idref: target.id, linear: "yes", properties: [] });
  facts.resources.readingOrder.push({
    idref: target.id,
    target: { state: "declaration", value: target.declaration },
    resource: target.resource,
    linear: "yes",
    presentation: structuredClone(presentation),
  });
  return ordinal;
}
