import type { PublicationMount } from "./generated/kernel.js";
import { publicationResourceUrl } from "./mount.js";

export const MAX_MEDIA_OVERLAY_DECLARATIONS = 100_000;
export const MAX_MEDIA_OVERLAY_TIMELINES = 10_000;
export const MAX_MEDIA_OVERLAY_ASSOCIATIONS = 100_000;
export const MAX_MEDIA_OVERLAY_SEGMENTS = 100_000;
export const MAX_MEDIA_OVERLAY_SEMANTIC_DEPTH = 256;
export const MAX_MEDIA_OVERLAY_TOKENS_PER_NODE = 256;
export const MAX_MEDIA_OVERLAY_COLLECTION_ITEMS = 10_000;
export const MAX_MEDIA_OVERLAY_AMBIGUOUS_CANDIDATES = 256;
export const MAX_MEDIA_OVERLAY_COVERAGE_ENTRIES = 10_000;
export const MAX_MEDIA_OVERLAY_STRING_BYTES = 16_384;

/** Millisecond clock values are decimal strings so the full `u64` domain survives JSON. */
export type NavigatorSmilClock =
  | { readonly state: "absent" }
  | { readonly state: "parsed"; readonly milliseconds: string }
  | { readonly state: "unrecognized" };

export type NavigatorMediaOverlayManifestId =
  | { readonly state: "missing" }
  | { readonly state: "valid"; readonly value: string }
  | { readonly state: "invalid"; readonly value: string };

export interface NavigatorMediaOverlayDeclaration {
  readonly declarationIndex: number;
  readonly authoredId: NavigatorMediaOverlayManifestId;
  readonly authoredHref: string | null;
  readonly canonicalPath: string | null;
  readonly mediaType: string | null;
}

export interface NavigatorMediaOverlayDurationMetadata {
  readonly authored: string;
  readonly clock: NavigatorSmilClock;
  readonly refines: string | null;
  readonly declarationIndexes: readonly number[];
}

export interface NavigatorMediaOverlayPackageMetadata {
  readonly totalDurations: readonly NavigatorMediaOverlayDurationMetadata[];
  readonly itemDurations: readonly NavigatorMediaOverlayDurationMetadata[];
  readonly narrators: readonly string[];
  readonly activeClasses: readonly string[];
  readonly playbackActiveClasses: readonly string[];
}

export type NavigatorMediaOverlayPackageFacts =
  | {
      readonly state: "available";
      readonly declared: boolean;
      readonly declarations: readonly NavigatorMediaOverlayDeclaration[];
      readonly metadata: NavigatorMediaOverlayPackageMetadata;
    }
  | { readonly state: "unavailable"; readonly reason: "representation-limit-exceeded" };

export type NavigatorMediaOverlayAnalysisIssue =
  | "resource-limit"
  | "per-resource-analysis-limit"
  | "total-analysis-limit"
  | "total-fingerprint-limit"
  | "smil-node-limit"
  | "smil-nesting-limit"
  | "missing"
  | "unreadable"
  | "unsupported"
  | "malformed"
  | "random-access-unavailable"
  | "parser-failure";

export type NavigatorMediaOverlayCoverageResult =
  | { readonly state: "complete" }
  | { readonly state: "partial"; readonly issue: NavigatorMediaOverlayAnalysisIssue }
  | { readonly state: "unavailable"; readonly issue: NavigatorMediaOverlayAnalysisIssue };

export interface NavigatorMediaOverlayPathCoverage {
  readonly canonicalPath: string;
  readonly result: NavigatorMediaOverlayCoverageResult;
}

export interface NavigatorMediaOverlayCoverage {
  readonly state: "complete" | "partial" | "unavailable" | "inapplicable";
  readonly packageRelationships: NavigatorMediaOverlayCoverageResult | null;
  readonly smilExtraction: readonly NavigatorMediaOverlayPathCoverage[];
  readonly smilRelationships: readonly NavigatorMediaOverlayPathCoverage[];
  readonly fragmentObservations: readonly NavigatorMediaOverlayPathCoverage[];
  readonly mediaInspection: readonly NavigatorMediaOverlayPathCoverage[];
}

export type NavigatorMediaOverlayAvailabilityIssue =
  | "analysis-unavailable"
  | "representation-limit-exceeded"
  | "no-playable-segments";

export type NavigatorMediaOverlayTimelineIssue =
  | NavigatorMediaOverlayAvailabilityIssue
  | "audio-preparation-failed";

export type NavigatorMediaOverlayTimelineAvailability =
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: NavigatorMediaOverlayTimelineIssue };

export interface NavigatorMediaOverlayTimelineSummary {
  /** Index valid only within one immutable description. */
  readonly overlayIndex: number;
  readonly canonicalPath: string;
  readonly declarations: readonly NavigatorMediaOverlayDeclaration[];
  readonly skippable: readonly string[];
  readonly escapable: readonly string[];
  readonly segmentCount: number;
  readonly playableSegmentCount: number;
  readonly availability: NavigatorMediaOverlayTimelineAvailability;
}

export type NavigatorMediaOverlayContentTarget =
  | { readonly state: "missing-idref" }
  | { readonly state: "missing-declaration"; readonly authoredIdref: string }
  | {
      readonly state: "ambiguous-declaration";
      readonly authoredIdref: string;
      readonly candidates: readonly NavigatorMediaOverlayDeclaration[];
    }
  | {
      readonly state: "declaration-without-resource";
      readonly declaration: NavigatorMediaOverlayDeclaration;
    }
  | {
      readonly state: "resolved";
      readonly declaration: NavigatorMediaOverlayDeclaration;
      readonly canonicalPath: string;
      readonly bytes: { readonly state: "present" } | { readonly state: "missing" };
    };

export type NavigatorMediaOverlayAssociationState =
  | { readonly state: "not-declared" }
  | { readonly state: "missing-declaration"; readonly authoredIdref: string }
  | {
      readonly state: "ambiguous-declaration";
      readonly authoredIdref: string;
      readonly candidates: readonly NavigatorMediaOverlayDeclaration[];
    }
  | {
      readonly state: "declaration-without-resource";
      readonly declaration: NavigatorMediaOverlayDeclaration;
    }
  | {
      readonly state: "analysis-unavailable";
      readonly declaration: NavigatorMediaOverlayDeclaration;
      readonly overlayIndex: number;
      readonly issue: NavigatorMediaOverlayAnalysisIssue;
    }
  | {
      readonly state: "resolved";
      readonly declaration: NavigatorMediaOverlayDeclaration;
      readonly overlayIndex: number;
    };

export interface NavigatorMediaOverlayAssociation {
  readonly occurrenceIndex: number;
  readonly effectiveLinear: "yes" | "no";
  readonly content: NavigatorMediaOverlayContentTarget;
  readonly overlay: NavigatorMediaOverlayAssociationState;
  /** Candidate segments whose text targets this occurrence's content resource. */
  readonly entrySegmentIndexes: readonly number[];
}

export type NavigatorMediaOverlayPlayback =
  | { readonly state: "absent" }
  | { readonly state: "unavailable"; readonly reason: NavigatorMediaOverlayAvailabilityIssue }
  | {
      readonly state: "available";
      readonly overlays: readonly NavigatorMediaOverlayTimelineSummary[];
      readonly associations: readonly NavigatorMediaOverlayAssociation[];
    };

export interface NavigatorMediaOverlayDescription {
  readonly package: NavigatorMediaOverlayPackageFacts;
  readonly coverage: NavigatorMediaOverlayCoverage;
  readonly playback: NavigatorMediaOverlayPlayback;
}

export type NavigatorMediaOverlayFragmentExistence =
  | { readonly state: "exists" }
  | { readonly state: "ambiguous" }
  | { readonly state: "missing" }
  | { readonly state: "unknown" };

export type NavigatorMediaOverlayReference =
  | { readonly state: "absent" }
  | {
      readonly state: "local-resource";
      readonly authoredHref: string;
      readonly canonicalPath: string;
      readonly query: string | null;
    }
  | {
      readonly state: "local-fragment";
      readonly authoredHref: string;
      readonly canonicalPath: string;
      readonly query: string | null;
      readonly fragment: string;
      readonly fragmentExists: NavigatorMediaOverlayFragmentExistence;
    }
  | {
      readonly state: "missing-local-resource";
      readonly authoredHref: string;
      readonly canonicalPath: string;
    }
  | {
      readonly state: "indexed-local-resource-unavailable";
      readonly authoredHref: string;
      readonly canonicalPath: string;
      readonly query: string | null;
    }
  | {
      readonly state: "indexed-local-fragment-unavailable";
      readonly authoredHref: string;
      readonly canonicalPath: string;
      readonly query: string | null;
      readonly fragment: string;
      readonly fragmentExists: NavigatorMediaOverlayFragmentExistence;
    }
  | { readonly state: "remote"; readonly authoredHref: string }
  | { readonly state: "data"; readonly authoredHref: string }
  | { readonly state: "external"; readonly authoredHref: string }
  | { readonly state: "invalid"; readonly authoredHref: string };

export type NavigatorMediaOverlayBindingIssue =
  | "missing-reference"
  | "missing-resource"
  | "missing-fragment"
  | "ambiguous-fragment"
  | "unverified-fragment"
  | "resource-bytes-unavailable"
  | "unsupported-target"
  | "unsupported-media-type"
  | "audio-backing-unavailable";

export interface NavigatorMediaOverlayBinding {
  readonly reference: NavigatorMediaOverlayReference;
  readonly availability:
    | { readonly state: "available" }
    | { readonly state: "unavailable"; readonly reason: NavigatorMediaOverlayBindingIssue };
}

export type NavigatorMediaOverlaySegmentPlayability =
  | { readonly state: "playable" }
  | {
      readonly state: "unsupported";
      readonly reason:
        | "text-to-speech-unavailable"
        | "fixed-layout-text"
        | "svg-text"
        | "navigation-document"
        | "unsupported-text-fragment"
        | "unsupported-audio-format";
    }
  | {
      readonly state: "malformed";
      readonly reason:
        | "missing-body"
        | "invalid-sequence-children"
        | "invalid-parallel-children"
        | "missing-text"
        | "multiple-text"
        | "multiple-audio"
        | "unrecognized-clock"
        | "empty-clip"
        | "reversed-clip";
    }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "text-binding-unavailable"
        | "audio-binding-unavailable"
        | "ambiguous-continuation"
        | "numeric-overflow";
    };

export interface NavigatorMediaOverlaySemanticNode {
  readonly kind: "sequence" | "parallel";
  readonly epubTypes: readonly string[];
  readonly textReference: NavigatorMediaOverlayReference | null;
}

export interface NavigatorMediaOverlaySegment {
  /** Index valid only within one timeline; durable locations use the text binding. */
  readonly segmentIndex: number;
  /** Root-to-segment hierarchy, excluding the segment's own parallel node. */
  readonly semanticPath: readonly NavigatorMediaOverlaySemanticNode[];
  readonly text: NavigatorMediaOverlayBinding;
  readonly audio: NavigatorMediaOverlayBinding;
  readonly clipBegin: NavigatorSmilClock;
  readonly clipEnd: NavigatorSmilClock;
  readonly playability: NavigatorMediaOverlaySegmentPlayability;
}

export interface NavigatorMediaOverlayTimeline extends NavigatorMediaOverlayTimelineSummary {
  readonly segments: readonly NavigatorMediaOverlaySegment[];
}

export type NavigatorMediaOverlayTimelineResult =
  | { readonly state: "available"; readonly timeline: NavigatorMediaOverlayTimeline }
  | {
      readonly state: "unavailable";
      readonly summary: NavigatorMediaOverlayTimelineSummary;
      readonly reason: NavigatorMediaOverlayTimelineIssue;
    };

/** Bounded startup availability supplied before the full description is requested. */
export type NavigatorMediaOverlayAvailability =
  | { readonly status: "absent" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "available";
      readonly playableOccurrenceIndexes: readonly number[];
      readonly unavailableOccurrenceCount: number;
    };

export type NavigatorMediaOverlayProviderIssue =
  | "session-replaced"
  | "not-found"
  | "host-unavailable";

export type NavigatorMediaOverlayDescriptionOutcome =
  | { readonly status: "ok"; readonly description: NavigatorMediaOverlayDescription }
  | { readonly status: "unavailable"; readonly reason: NavigatorMediaOverlayProviderIssue };

export type NavigatorMediaOverlayTimelineOutcome =
  | { readonly status: "ok"; readonly result: NavigatorMediaOverlayTimelineResult }
  | { readonly status: "unavailable"; readonly reason: NavigatorMediaOverlayProviderIssue };

/** Resolves a local audio reference to its mounted URL; fragments are never requested. */
export function mediaOverlayAudioUrl(
  mount: PublicationMount,
  reference: NavigatorMediaOverlayReference,
): string | null {
  if (reference.state !== "local-resource" && reference.state !== "local-fragment") return null;
  const url = publicationResourceUrl(mount, reference.canonicalPath);
  return reference.query === null ? url : `${url}?${reference.query}`;
}

/** Parses a clock to finite browser milliseconds, or `null` when absent or not representable. */
export function smilClockMilliseconds(clock: NavigatorSmilClock): number | null {
  if (clock.state !== "parsed") return null;
  const value = Number(clock.milliseconds);
  return Number.isSafeInteger(value) ? value : null;
}

/** An absent `clipBegin` is the start of the audio resource; an absent `clipEnd` is its end. */
export function clipBeginMilliseconds(clock: NavigatorSmilClock): number | null {
  return clock.state === "absent" ? 0 : smilClockMilliseconds(clock);
}

export function isNavigatorMediaOverlayAvailability(
  value: unknown,
): value is NavigatorMediaOverlayAvailability {
  return check(() => {
    const record = object(value);
    if (record.status === "absent" || record.status === "unavailable") {
      exactKeys(record, ["status"]);
      return;
    }
    if (record.status !== "available") fail();
    exactKeys(record, ["status", "playableOccurrenceIndexes", "unavailableOccurrenceCount"]);
    increasingIndexes(record.playableOccurrenceIndexes, MAX_MEDIA_OVERLAY_ASSOCIATIONS);
    index(record.unavailableOccurrenceCount);
  });
}

export function isNavigatorMediaOverlayDescription(
  value: unknown,
): value is NavigatorMediaOverlayDescription {
  return check(() => {
    const record = object(value);
    exactKeys(record, ["package", "coverage", "playback"]);
    const declarations = packageFacts(record.package);
    coverage(record.coverage);
    playback(record.playback, declarations);
  });
}

export function isNavigatorMediaOverlayTimelineResult(
  value: unknown,
): value is NavigatorMediaOverlayTimelineResult {
  return check(() => {
    const record = object(value);
    if (record.state === "available") {
      exactKeys(record, ["state", "timeline"]);
      timeline(record.timeline);
      return;
    }
    if (record.state !== "unavailable") fail();
    exactKeys(record, ["state", "summary", "reason"]);
    const summary = timelineSummary(record.summary);
    const reason = oneOf(record.reason, TIMELINE_ISSUES);
    if (summary.availability.state !== "unavailable" || summary.availability.reason !== reason) {
      fail();
    }
  });
}

/** Reports whether a fetched timeline result belongs to a description summary. */
export function mediaOverlayTimelineMatchesSummary(
  result: NavigatorMediaOverlayTimelineResult,
  summary: NavigatorMediaOverlayTimelineSummary,
): boolean {
  const candidate = result.state === "available" ? result.timeline : result.summary;
  return (
    candidate.overlayIndex === summary.overlayIndex &&
    candidate.canonicalPath === summary.canonicalPath &&
    candidate.segmentCount === summary.segmentCount &&
    candidate.playableSegmentCount === summary.playableSegmentCount &&
    candidate.availability.state === summary.availability.state &&
    sameStrings(candidate.skippable, summary.skippable) &&
    sameStrings(candidate.escapable, summary.escapable)
  );
}

class Invalid extends Error {}

const ANALYSIS_ISSUES = [
  "resource-limit",
  "per-resource-analysis-limit",
  "total-analysis-limit",
  "total-fingerprint-limit",
  "smil-node-limit",
  "smil-nesting-limit",
  "missing",
  "unreadable",
  "unsupported",
  "malformed",
  "random-access-unavailable",
  "parser-failure",
] as const;
const AVAILABILITY_ISSUES = [
  "analysis-unavailable",
  "representation-limit-exceeded",
  "no-playable-segments",
] as const;
const TIMELINE_ISSUES = [...AVAILABILITY_ISSUES, "audio-preparation-failed"] as const;
const BINDING_ISSUES = [
  "missing-reference",
  "missing-resource",
  "missing-fragment",
  "ambiguous-fragment",
  "unverified-fragment",
  "resource-bytes-unavailable",
  "unsupported-target",
  "unsupported-media-type",
  "audio-backing-unavailable",
] as const;
const PLAYABILITY_REASONS = {
  playable: [],
  unsupported: [
    "text-to-speech-unavailable",
    "fixed-layout-text",
    "svg-text",
    "navigation-document",
    "unsupported-text-fragment",
    "unsupported-audio-format",
  ],
  malformed: [
    "missing-body",
    "invalid-sequence-children",
    "invalid-parallel-children",
    "missing-text",
    "multiple-text",
    "multiple-audio",
    "unrecognized-clock",
    "empty-clip",
    "reversed-clip",
  ],
  unavailable: [
    "text-binding-unavailable",
    "audio-binding-unavailable",
    "ambiguous-continuation",
    "numeric-overflow",
  ],
} as const;

const encoder = new TextEncoder();

function check(validate: () => void): boolean {
  try {
    validate();
    return true;
  } catch (error) {
    if (error instanceof Invalid) return false;
    throw error;
  }
}

function fail(): never {
  throw new Invalid();
}

function object(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) fail();
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) fail();
}

function string(value: unknown): string {
  if (typeof value !== "string") fail();
  if (value.length > MAX_MEDIA_OVERLAY_STRING_BYTES) fail();
  if (
    value.length * 3 > MAX_MEDIA_OVERLAY_STRING_BYTES &&
    encoder.encode(value).byteLength > MAX_MEDIA_OVERLAY_STRING_BYTES
  ) {
    fail();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function index(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    fail();
  }
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, options: T): T[number] {
  if (typeof value !== "string" || !options.includes(value)) fail();
  return value;
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return value;
}

function strings(value: unknown, max: number): string[] {
  return array(value, max).map(string);
}

function increasingIndexes(
  value: unknown,
  max: number,
  below = Number.POSITIVE_INFINITY,
): number[] {
  const indexes = array(value, max).map(index);
  indexes.forEach((item, position) => {
    if (item >= below || (position > 0 && item <= indexes[position - 1]!)) fail();
  });
  return indexes;
}

function stateless<const T extends readonly string[]>(value: unknown, states: T): T[number] {
  const record = object(value);
  exactKeys(record, ["state"]);
  return oneOf(record.state, states);
}

function clock(value: unknown): NavigatorSmilClock {
  const record = object(value);
  if (record.state === "parsed") {
    exactKeys(record, ["state", "milliseconds"]);
    const milliseconds = string(record.milliseconds);
    if (
      !/^(0|[1-9][0-9]{0,19})$/.test(milliseconds) ||
      BigInt(milliseconds) > 0xffff_ffff_ffff_ffffn
    ) {
      fail();
    }
    return { state: "parsed", milliseconds };
  }
  return { state: stateless(record, ["absent", "unrecognized"]) };
}

function declaration(value: unknown, declarationCount?: number): number {
  const record = object(value);
  exactKeys(record, [
    "declarationIndex",
    "authoredId",
    "authoredHref",
    "canonicalPath",
    "mediaType",
  ]);
  const declarationIndex = index(record.declarationIndex);
  if (declarationCount !== undefined && declarationIndex >= declarationCount) fail();
  const id = object(record.authoredId);
  if (id.state === "missing") exactKeys(id, ["state"]);
  else {
    oneOf(id.state, ["valid", "invalid"]);
    exactKeys(id, ["state", "value"]);
    string(id.value);
  }
  nullableString(record.authoredHref);
  nullableString(record.canonicalPath);
  nullableString(record.mediaType);
  return declarationIndex;
}

function declarationList(value: unknown, max: number, declarationCount?: number): void {
  array(value, max).forEach((item) => declaration(item, declarationCount));
}

function packageFacts(value: unknown): number | undefined {
  const record = object(value);
  if (record.state === "unavailable") {
    exactKeys(record, ["state", "reason"]);
    oneOf(record.reason, ["representation-limit-exceeded"]);
    return undefined;
  }
  if (record.state !== "available") fail();
  exactKeys(record, ["state", "declared", "declarations", "metadata"]);
  if (typeof record.declared !== "boolean") fail();
  const declarations = array(record.declarations, MAX_MEDIA_OVERLAY_DECLARATIONS);
  declarations.forEach((item, position) => {
    if (declaration(item) !== position) fail();
  });
  const metadata = object(record.metadata);
  exactKeys(metadata, [
    "totalDurations",
    "itemDurations",
    "narrators",
    "activeClasses",
    "playbackActiveClasses",
  ]);
  for (const durations of [metadata.totalDurations, metadata.itemDurations]) {
    array(durations, MAX_MEDIA_OVERLAY_COLLECTION_ITEMS).forEach((item) => {
      const duration = object(item);
      exactKeys(duration, ["authored", "clock", "refines", "declarationIndexes"]);
      string(duration.authored);
      clock(duration.clock);
      nullableString(duration.refines);
      increasingIndexes(
        duration.declarationIndexes,
        MAX_MEDIA_OVERLAY_DECLARATIONS,
        declarations.length,
      );
    });
  }
  strings(metadata.narrators, MAX_MEDIA_OVERLAY_COLLECTION_ITEMS);
  strings(metadata.activeClasses, MAX_MEDIA_OVERLAY_COLLECTION_ITEMS);
  strings(metadata.playbackActiveClasses, MAX_MEDIA_OVERLAY_COLLECTION_ITEMS);
  return declarations.length;
}

function coverageResult(value: unknown): void {
  const record = object(value);
  if (record.state === "complete") {
    exactKeys(record, ["state"]);
    return;
  }
  oneOf(record.state, ["partial", "unavailable"]);
  exactKeys(record, ["state", "issue"]);
  oneOf(record.issue, ANALYSIS_ISSUES);
}

function coverage(value: unknown): void {
  const record = object(value);
  exactKeys(record, [
    "state",
    "packageRelationships",
    "smilExtraction",
    "smilRelationships",
    "fragmentObservations",
    "mediaInspection",
  ]);
  oneOf(record.state, ["complete", "partial", "unavailable", "inapplicable"]);
  if (record.packageRelationships !== null) coverageResult(record.packageRelationships);
  for (const entries of [
    record.smilExtraction,
    record.smilRelationships,
    record.fragmentObservations,
    record.mediaInspection,
  ]) {
    array(entries, MAX_MEDIA_OVERLAY_COVERAGE_ENTRIES).forEach((item) => {
      const entry = object(item);
      exactKeys(entry, ["canonicalPath", "result"]);
      string(entry.canonicalPath);
      coverageResult(entry.result);
    });
  }
}

function timelineAvailability(value: unknown): NavigatorMediaOverlayTimelineAvailability {
  const record = object(value);
  if (record.state === "available") {
    exactKeys(record, ["state"]);
    return { state: "available" };
  }
  if (record.state !== "unavailable") fail();
  exactKeys(record, ["state", "reason"]);
  return { state: "unavailable", reason: oneOf(record.reason, TIMELINE_ISSUES) };
}

interface TimelineSummaryFacts {
  readonly overlayIndex: number;
  readonly segmentCount: number;
  readonly playableSegmentCount: number;
  readonly availability: NavigatorMediaOverlayTimelineAvailability;
}

const SUMMARY_KEYS = [
  "overlayIndex",
  "canonicalPath",
  "declarations",
  "skippable",
  "escapable",
  "segmentCount",
  "playableSegmentCount",
  "availability",
] as const;

function summaryFields(
  record: Record<string, unknown>,
  declarationCount?: number,
): TimelineSummaryFacts {
  const overlayIndex = index(record.overlayIndex);
  string(record.canonicalPath);
  declarationList(record.declarations, MAX_MEDIA_OVERLAY_DECLARATIONS, declarationCount);
  strings(record.skippable, MAX_MEDIA_OVERLAY_TOKENS_PER_NODE);
  strings(record.escapable, MAX_MEDIA_OVERLAY_TOKENS_PER_NODE);
  const segmentCount = index(record.segmentCount);
  const playable = index(record.playableSegmentCount);
  const availability = timelineAvailability(record.availability);
  if (segmentCount > MAX_MEDIA_OVERLAY_SEGMENTS || playable > segmentCount) fail();
  if (availability.state === "available" && playable === 0) fail();
  return { overlayIndex, segmentCount, playableSegmentCount: playable, availability };
}

function timelineSummary(value: unknown, declarationCount?: number): TimelineSummaryFacts {
  const record = object(value);
  exactKeys(record, SUMMARY_KEYS);
  return summaryFields(record, declarationCount);
}

function contentTarget(value: unknown, declarationCount?: number): void {
  const record = object(value);
  switch (record.state) {
    case "missing-idref":
      exactKeys(record, ["state"]);
      return;
    case "missing-declaration":
      exactKeys(record, ["state", "authoredIdref"]);
      string(record.authoredIdref);
      return;
    case "ambiguous-declaration":
      exactKeys(record, ["state", "authoredIdref", "candidates"]);
      string(record.authoredIdref);
      declarationList(record.candidates, MAX_MEDIA_OVERLAY_AMBIGUOUS_CANDIDATES, declarationCount);
      return;
    case "declaration-without-resource":
      exactKeys(record, ["state", "declaration"]);
      declaration(record.declaration, declarationCount);
      return;
    case "resolved":
      exactKeys(record, ["state", "declaration", "canonicalPath", "bytes"]);
      declaration(record.declaration, declarationCount);
      string(record.canonicalPath);
      stateless(record.bytes, ["present", "missing"]);
      return;
    default:
      fail();
  }
}

function associationState(
  value: unknown,
  overlayCount: number,
  declarationCount?: number,
): number | null {
  const record = object(value);
  switch (record.state) {
    case "not-declared":
      exactKeys(record, ["state"]);
      return null;
    case "missing-declaration":
    case "ambiguous-declaration":
    case "declaration-without-resource":
      contentTarget(record, declarationCount);
      return null;
    case "analysis-unavailable": {
      exactKeys(record, ["state", "declaration", "overlayIndex", "issue"]);
      declaration(record.declaration, declarationCount);
      if (index(record.overlayIndex) >= overlayCount) fail();
      oneOf(record.issue, ANALYSIS_ISSUES);
      return null;
    }
    case "resolved": {
      exactKeys(record, ["state", "declaration", "overlayIndex"]);
      declaration(record.declaration, declarationCount);
      const overlayIndex = index(record.overlayIndex);
      if (overlayIndex >= overlayCount) fail();
      return overlayIndex;
    }
    default:
      fail();
  }
}

function playback(value: unknown, declarationCount?: number): void {
  const record = object(value);
  if (record.state === "absent") {
    exactKeys(record, ["state"]);
    return;
  }
  if (record.state === "unavailable") {
    exactKeys(record, ["state", "reason"]);
    oneOf(record.reason, AVAILABILITY_ISSUES);
    return;
  }
  if (record.state !== "available") fail();
  exactKeys(record, ["state", "overlays", "associations"]);
  const overlays = array(record.overlays, MAX_MEDIA_OVERLAY_TIMELINES).map((item, position) => {
    const summary = timelineSummary(item, declarationCount);
    if (summary.overlayIndex !== position) fail();
    return summary;
  });
  let previous = -1;
  array(record.associations, MAX_MEDIA_OVERLAY_ASSOCIATIONS).forEach((item) => {
    const association = object(item);
    exactKeys(association, [
      "occurrenceIndex",
      "effectiveLinear",
      "content",
      "overlay",
      "entrySegmentIndexes",
    ]);
    const occurrence = index(association.occurrenceIndex);
    if (occurrence <= previous) fail();
    previous = occurrence;
    oneOf(association.effectiveLinear, ["yes", "no"]);
    contentTarget(association.content, declarationCount);
    const overlayIndex = associationState(association.overlay, overlays.length, declarationCount);
    const segmentCount = overlayIndex === null ? 0 : (overlays[overlayIndex]?.segmentCount ?? 0);
    increasingIndexes(association.entrySegmentIndexes, MAX_MEDIA_OVERLAY_SEGMENTS, segmentCount);
  });
}

function reference(value: unknown): void {
  const record = object(value);
  switch (record.state) {
    case "absent":
      exactKeys(record, ["state"]);
      break;
    case "local-resource":
    case "indexed-local-resource-unavailable":
      exactKeys(record, ["state", "authoredHref", "canonicalPath", "query"]);
      string(record.authoredHref);
      string(record.canonicalPath);
      nullableString(record.query);
      break;
    case "local-fragment":
    case "indexed-local-fragment-unavailable":
      exactKeys(record, [
        "state",
        "authoredHref",
        "canonicalPath",
        "query",
        "fragment",
        "fragmentExists",
      ]);
      string(record.authoredHref);
      string(record.canonicalPath);
      nullableString(record.query);
      string(record.fragment);
      stateless(record.fragmentExists, ["exists", "ambiguous", "missing", "unknown"]);
      break;
    case "missing-local-resource":
      exactKeys(record, ["state", "authoredHref", "canonicalPath"]);
      string(record.authoredHref);
      string(record.canonicalPath);
      break;
    case "remote":
    case "data":
    case "external":
    case "invalid":
      exactKeys(record, ["state", "authoredHref"]);
      string(record.authoredHref);
      break;
    default:
      fail();
  }
}

function binding(value: unknown): NavigatorMediaOverlayBinding["availability"]["state"] {
  const record = object(value);
  exactKeys(record, ["reference", "availability"]);
  reference(record.reference);
  const availability = object(record.availability);
  if (availability.state === "available") {
    exactKeys(availability, ["state"]);
    return "available";
  }
  if (availability.state !== "unavailable") fail();
  exactKeys(availability, ["state", "reason"]);
  oneOf(availability.reason, BINDING_ISSUES);
  return "unavailable";
}

function segment(
  value: unknown,
  position: number,
): NavigatorMediaOverlaySegmentPlayability["state"] {
  const record = object(value);
  exactKeys(record, [
    "segmentIndex",
    "semanticPath",
    "text",
    "audio",
    "clipBegin",
    "clipEnd",
    "playability",
  ]);
  if (index(record.segmentIndex) !== position) fail();
  array(record.semanticPath, MAX_MEDIA_OVERLAY_SEMANTIC_DEPTH).forEach((item) => {
    const node = object(item);
    exactKeys(node, ["kind", "epubTypes", "textReference"]);
    oneOf(node.kind, ["sequence", "parallel"]);
    strings(node.epubTypes, MAX_MEDIA_OVERLAY_TOKENS_PER_NODE);
    if (node.textReference !== null) reference(node.textReference);
  });
  const textAvailability = binding(record.text);
  const audioAvailability = binding(record.audio);
  const begin = clock(record.clipBegin);
  const end = clock(record.clipEnd);
  const playability = object(record.playability);
  const state = oneOf(playability.state, ["playable", "unsupported", "malformed", "unavailable"]);
  if (state === "playable") {
    exactKeys(playability, ["state"]);
    if (
      textAvailability !== "available" ||
      audioAvailability !== "available" ||
      begin.state === "unrecognized" ||
      end.state === "unrecognized"
    ) {
      fail();
    }
    const beginMilliseconds = begin.state === "parsed" ? BigInt(begin.milliseconds) : 0n;
    if (end.state === "parsed" && BigInt(end.milliseconds) <= beginMilliseconds) fail();
  } else {
    exactKeys(playability, ["state", "reason"]);
    oneOf(playability.reason, PLAYABILITY_REASONS[state]);
  }
  return state;
}

function timeline(value: unknown): void {
  const record = object(value);
  exactKeys(record, [...SUMMARY_KEYS, "segments"]);
  const summary = summaryFields(record);
  if (summary.availability.state !== "available") fail();
  const segments = array(record.segments, MAX_MEDIA_OVERLAY_SEGMENTS).map(segment);
  if (
    segments.length !== summary.segmentCount ||
    segments.filter((item) => item === "playable").length !== summary.playableSegmentCount
  ) {
    fail();
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, position) => item === right[position]);
}
