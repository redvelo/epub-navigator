import type {
  DecorationAppearance,
  DecorationRecordOutcome,
  DecorationRecordResult,
  ProjectedDecorationRecord,
  AnnotationRangeEdge,
  AnnotationRangeMovement,
} from "../../generated/kernel.js";
import { resolveAnnotationTargetInDocument } from "./targets/resolver/annotation.js";
import {
  createDocumentTextSnapshot,
  documentTextSnapshotIsCurrent,
  mapRangeToDocumentText,
} from "./targets/resolver/text-index.js";
import type { CooperativeResolverWork } from "./targets/resolver/types.js";
import type { AgentDecorationPalette } from "../agent-protocol/types.js";

export const decorationStyleAttribute = "data-epub-navigator-decorations";

interface DecorationState {
  readonly names: Set<string>;
  items: CommittedDecoration[];
  projectionRevision: number | null;
  activeName: string | null;
  interactionActive: boolean;
  style: HTMLStyleElement | null;
  sequence: number;
}

interface DecorationStyleState {
  readonly document: Document;
  readonly connected: boolean;
  readonly textContent: string;
}

interface StagedDecoration {
  readonly id?: string;
  readonly appearance: DecorationAppearance;
  readonly range: Range;
}

interface CommittedDecoration {
  readonly id: string;
  readonly appearance: DecorationAppearance;
  readonly range: Range;
  readonly name: string;
  readonly highlight: Highlight;
}

export interface DecorationPointHit {
  readonly ids: readonly string[];
  readonly projectionRevision: number;
  readonly rect: DOMRectReadOnly;
}

export type CommittedDecorationRangeAdjustment =
  | { readonly status: "adjusted"; readonly range: Range; readonly excerpt: string }
  | { readonly status: "unavailable" }
  | { readonly status: "unsupported" }
  | { readonly status: "stale" };

const states = new WeakMap<Document, DecorationState>();
const palettes = new WeakMap<Document, AgentDecorationPalette>();
const decorationStyles = new WeakMap<HTMLStyleElement, DecorationStyleState>();
const highlightNamePrefix = `epub-navigator-decoration-${Math.random().toString(36).slice(2)}`;

/** Restyles live decorations in place: the palette follows the display, not the projection. */
export function setDecorationPalette(document: Document, palette: AgentDecorationPalette): void {
  if ((palettes.get(document) ?? "standard") === palette) return;
  palettes.set(document, palette);
  const state = states.get(document);
  if (state !== undefined) refreshDecorationStyle(state, document);
}

export function decorationApiAvailable(document: Document): boolean {
  const view = document.defaultView;
  return (
    view !== null &&
    "CSS" in view &&
    "highlights" in view.CSS &&
    "Highlight" in view &&
    typeof view.Highlight === "function"
  );
}

export function decorationStyleIsRuntimeOwned(document: Document, node: Node | null): boolean {
  if (!(node instanceof HTMLStyleElement)) return false;
  const expected = decorationStyles.get(node);
  return (
    expected?.document === document &&
    expected.connected === node.isConnected &&
    expected.textContent === node.textContent
  );
}

export function decorationMutationIsRuntimeOwned(
  document: Document,
  record: MutationRecord,
): boolean {
  if (record.type !== "childList") return false;
  const styles = new Set<HTMLStyleElement>();
  if (record.target instanceof HTMLStyleElement && decorationStyles.has(record.target)) {
    styles.add(record.target);
  } else {
    const changed = [...record.addedNodes, ...record.removedNodes];
    if (changed.length === 0) return false;
    for (const node of changed) {
      if (!(node instanceof HTMLStyleElement) || !decorationStyles.has(node)) return false;
      styles.add(node);
    }
  }
  return [...styles].every((style) => decorationStyleIsRuntimeOwned(document, style));
}

/** Resolves and commits one complete decoration projection without modifying publisher markup. */
export async function reconcileDecorationProjection(
  document: Document,
  projectionRevision: number,
  records: readonly ProjectedDecorationRecord[],
  work: CooperativeResolverWork,
): Promise<readonly DecorationRecordResult[]> {
  if (work.signal.aborted) throw new DOMException("operation cancelled", "AbortError");
  if (!decorationApiAvailable(document)) {
    return records.map(({ id }) => ({
      id,
      outcome: { status: "unavailable", message: "CSS Custom Highlights are unavailable" },
    }));
  }
  if (records.length === 0) {
    applyDecorationProjection(document, [], projectionRevision);
    return [];
  }

  const snapshot = createDocumentTextSnapshot(document);
  const staged: StagedDecoration[] = [];
  const outcomes: DecorationRecordResult[] = [];
  for (const record of records) {
    if (work.signal.aborted) throw new DOMException("operation cancelled", "AbortError");
    const resolution = await resolveAnnotationTargetInDocument(
      document,
      record.plan,
      work,
      snapshot,
    );
    if (
      resolution.outcome === "resolved" &&
      resolution.segmentKind === "range" &&
      resolution.range !== null &&
      !resolution.range.collapsed
    ) {
      staged.push({
        id: record.id,
        appearance: record.appearance,
        range: resolution.range.cloneRange(),
      });
      outcomes.push({ id: record.id, outcome: { status: "rendered" } });
    } else {
      outcomes.push({ id: record.id, outcome: decorationOutcome(resolution) });
    }
  }

  if (
    work.signal.aborted ||
    !documentTextSnapshotIsCurrent(snapshot) ||
    work.isCurrent?.() === false
  ) {
    if (work.signal.aborted) throw new DOMException("operation cancelled", "AbortError");
    return records.map(({ id }) => ({ id, outcome: { status: "stale" } }));
  }

  applyDecorationProjection(document, staged, projectionRevision);
  return outcomes;
}

export function applyDecorationProjection(
  document: Document,
  decorations: readonly StagedDecoration[],
  projectionRevision: number | null = null,
): void {
  const view = document.defaultView;
  if (view === null || !decorationApiAvailable(document)) return;
  const state = states.get(document) ?? {
    names: new Set<string>(),
    items: [],
    projectionRevision: null,
    activeName: null,
    interactionActive: false,
    style: null,
    sequence: 0,
  };
  states.set(document, state);

  const next = decorations.map((decoration) => {
    let name: string;
    do {
      state.sequence += 1;
      name = `${highlightNamePrefix}-${state.sequence}`;
    } while (view.CSS.highlights.has(name) && !state.names.has(name));
    return {
      ...decoration,
      id: decoration.id ?? "",
      name,
      highlight: new view.Highlight(decoration.range),
    };
  });

  let style = state.style;
  if (next.length > 0) {
    if (style === null || !style.isConnected) {
      style = document.createElement("style");
      style.setAttribute(decorationStyleAttribute, "");
      // Reuse the established marker so authored-provenance filters ignore this runtime node.
      style.setAttribute("data-epub-navigator-configuration", "decorations");
      (document.head ?? document.documentElement).append(style);
      state.style = style;
    }
    const palette = palettes.get(document) ?? "standard";
    style.textContent = next
      .map(
        ({ name, appearance }) => `::highlight(${name}) { ${appearanceRule(appearance, palette)} }`,
      )
      .join("\n");
    decorationStyles.set(style, {
      document,
      connected: true,
      textContent: style.textContent,
    });
  }

  for (const name of state.names) view.CSS.highlights.delete(name);
  state.names.clear();
  for (const item of next) {
    view.CSS.highlights.set(item.name, item.highlight);
    state.names.add(item.name);
  }
  state.items = next;
  state.projectionRevision = projectionRevision;
  state.activeName = null;
  state.interactionActive = false;
  if (next.length === 0) {
    style?.remove();
    if (style !== null) {
      decorationStyles.set(style, {
        document,
        connected: false,
        textContent: style.textContent,
      });
    }
    state.style = null;
  }
}

/** Returns controlled annotation IDs at one viewport point without exposing registry names. */
export function decorationsAtPoint(
  document: Document,
  clientX: number,
  clientY: number,
): DecorationPointHit | null {
  const state = states.get(document);
  if (state?.projectionRevision === null || state === undefined) return null;
  const annotationItems = state.items.filter(
    ({ appearance }) => appearance === "annotation-highlight" || appearance === "annotation-note",
  );
  if (annotationItems.length === 0) return null;

  const nativeHits = nativeHighlightsAtPoint(document, clientX, clientY);
  const hitItems = annotationItems
    .filter((item) =>
      nativeHits === null
        ? rangeRectAtPoint(item.range, clientX, clientY) !== null
        : nativeHits.has(item.highlight),
    )
    .reverse();
  if (hitItems.length === 0) return null;
  const rect = rangeRectAtPoint(hitItems[0]!.range, clientX, clientY);
  if (rect === null) return null;
  state.interactionActive = true;
  return {
    ids: hitItems.map(({ id }) => id),
    projectionRevision: state.projectionRevision,
    rect,
  };
}

/** Applies ephemeral selected styling without changing the controlled projection. */
export function setActiveDecoration(
  document: Document,
  projectionRevision: number,
  id: string | null,
): boolean {
  const state = states.get(document);
  const view = document.defaultView;
  if (state === undefined || view === null || state.projectionRevision !== projectionRevision) {
    return false;
  }
  if (state.activeName !== null) {
    view.CSS.highlights.delete(state.activeName);
    state.names.delete(state.activeName);
    state.activeName = null;
  }
  if (id === null) {
    state.interactionActive = false;
    refreshDecorationStyle(state, document);
    return true;
  }
  const item = state.items.find((candidate) => candidate.id === id);
  if (item === undefined) return false;
  state.sequence += 1;
  const name = `${highlightNamePrefix}-active-${state.sequence}`;
  view.CSS.highlights.set(name, new view.Highlight(item.range));
  state.names.add(name);
  state.activeName = name;
  state.interactionActive = true;
  refreshDecorationStyle(state, document);
  return true;
}

export function activeDecorationProjectionRevision(document: Document): number | null {
  const state = states.get(document);
  return state?.interactionActive === true ? state.projectionRevision : null;
}

export function committedDecorationIsCurrent(
  document: Document,
  projectionRevision: number,
  id: string,
): boolean {
  const state = states.get(document);
  return (
    state?.projectionRevision === projectionRevision &&
    state.items.some(
      (item) =>
        item.id === id &&
        item.range.startContainer.isConnected &&
        item.range.endContainer.isConnected,
    )
  );
}

/** Derives a word-step range from private committed state without changing the highlight. */
export function adjustCommittedDecorationRange(
  document: Document,
  projectionRevision: number,
  id: string,
  edge: AnnotationRangeEdge,
  movement: AnnotationRangeMovement,
): CommittedDecorationRangeAdjustment {
  const state = states.get(document);
  if (state === undefined || state.projectionRevision !== projectionRevision) {
    return { status: "stale" };
  }
  const item = state.items.find((candidate) => candidate.id === id);
  if (item === undefined) return { status: "unavailable" };
  const current = item.range;
  if (
    current.collapsed ||
    !current.startContainer.isConnected ||
    !current.endContainer.isConnected
  ) {
    return { status: "stale" };
  }
  if (typeof Intl.Segmenter !== "function") {
    return { status: "unsupported" };
  }

  const snapshot = createDocumentTextSnapshot(document);
  const mapping = mapRangeToDocumentText(document, current, snapshot);
  if (mapping === null) return { status: "unavailable" };
  const { start, end } = mapping;
  const { text, boundaries } = snapshot.index;
  if (start >= end) return { status: "unavailable" };

  const language = document.documentElement.lang.trim() || undefined;
  const words = [...new Intl.Segmenter(language, { granularity: "word" }).segment(text)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => ({ start: segment.index, end: segment.index + segment.segment.length }));
  let target: number | undefined;
  if (edge === "start") {
    const boundaries = words.map((word) => word.start);
    target =
      movement === "backward"
        ? boundaries.filter((boundary) => boundary < start).at(-1)
        : boundaries.find((boundary) => boundary > start);
    if (target === undefined || target >= end) return { status: "unavailable" };
  } else {
    const boundaries = words.map((word) => word.end);
    target =
      movement === "backward"
        ? boundaries.filter((boundary) => boundary < end).at(-1)
        : boundaries.find((boundary) => boundary > end);
    if (target === undefined || target <= start) return { status: "unavailable" };
  }
  const boundary = boundaries[target];
  if (boundary === undefined) return { status: "unavailable" };
  const adjusted = current.cloneRange();
  if (edge === "start") adjusted.setStart(boundary.node, boundary.offset);
  else adjusted.setEnd(boundary.node, boundary.offset);
  if (adjusted.collapsed || adjusted.toString() === current.toString()) {
    return { status: "unavailable" };
  }
  return { status: "adjusted", range: adjusted, excerpt: boundedExcerpt(adjusted.toString()) };
}

function boundedExcerpt(value: string): string {
  const codePoints = Array.from(value).slice(0, 512);
  while (
    codePoints.length > 0 &&
    new TextEncoder().encode(codePoints.join("")).byteLength > 2_048
  ) {
    codePoints.pop();
  }
  return codePoints.join("");
}

function refreshDecorationStyle(state: DecorationState, document: Document): void {
  if (state.style === null) return;
  const palette = palettes.get(document) ?? "standard";
  const rules = state.items.map(
    ({ name, appearance }) => `::highlight(${name}) { ${appearanceRule(appearance, palette)} }`,
  );
  if (state.activeName !== null) {
    const activeRule =
      palette === "monochrome"
        ? monochromeStrongRule
        : "background-color: rgb(255 164 0 / 70%); color: inherit;";
    rules.push(`::highlight(${state.activeName}) { ${activeRule} }`);
  }
  state.style.textContent = rules.join("\n");
  decorationStyles.set(state.style, {
    document,
    connected: true,
    textContent: state.style.textContent,
  });
}

interface PointQueryableHighlightRegistry extends HighlightRegistry {
  readonly highlightsFromPoint?:
    | ((x: number, y: number) => Iterable<{ readonly highlight: Highlight }>)
    | undefined;
}

function nativeHighlightsAtPoint(
  document: Document,
  x: number,
  y: number,
): ReadonlySet<Highlight> | null {
  const registry: PointQueryableHighlightRegistry | undefined =
    document.defaultView?.CSS.highlights;
  if (typeof registry?.highlightsFromPoint !== "function") return null;
  try {
    return new Set([...registry.highlightsFromPoint(x, y)].map(({ highlight }) => highlight));
  } catch {
    return null;
  }
}

function rangeRectAtPoint(range: Range, x: number, y: number): DOMRectReadOnly | null {
  for (const rect of range.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return rect;
  }
  return null;
}

function decorationOutcome(resolution: {
  readonly outcome: string;
  readonly reports: readonly { readonly message?: string }[];
}): DecorationRecordOutcome {
  const message =
    resolution.reports.find((report) => report.message !== undefined)?.message ?? null;
  switch (resolution.outcome) {
    case "broken":
    case "ambiguous":
    case "conflict":
    case "unsupported":
    case "stale":
      return { status: resolution.outcome };
    case "unavailable":
      return { status: "unavailable", message };
    case "failed":
      return { status: "failed", message };
    default:
      return { status: resolution.outcome === "resolved" ? "unsupported" : "broken" };
  }
}

/**
 * A monochrome display keeps lightness and discards hue, so it carries two fill weights rather
 * than five colours: quiet for anything marked, strong for the one the reader is on. Each
 * composites onto one of the panel's sixteen levels instead of dithering between two, three
 * levels below the page for quiet and five for strong. The plain declaration ahead of each
 * `light-dark()` is the fallback for a browser without it.
 */
const monochromeQuietRule =
  "background-color: rgb(245 170 0 / 70%); background-color: light-dark(rgb(245 170 0 / 70%), rgb(245 170 0 / 30%)); color: inherit;";
const monochromeStrongRule =
  "background-color: rgb(240 145 0 / 95%); background-color: light-dark(rgb(240 145 0 / 95%), rgb(255 170 30 / 50%)); color: inherit;";

function appearanceRule(appearance: DecorationAppearance, palette: AgentDecorationPalette): string {
  if (palette === "monochrome") {
    switch (appearance) {
      case "annotation-highlight":
      case "annotation-note":
      case "search-result":
        return monochromeQuietRule;
      case "active-search-result":
      case "temporary-emphasis":
        return monochromeStrongRule;
    }
  }
  switch (appearance) {
    case "annotation-highlight":
      return "background-color: rgb(255 214 10 / 45%); color: inherit;";
    case "annotation-note":
      return "background-color: rgb(190 85 70 / 24%); color: inherit;";
    case "search-result":
      return "background-color: rgb(255 235 59 / 55%); color: inherit;";
    case "active-search-result":
      return "background-color: rgb(255 152 0 / 70%); color: inherit;";
    case "temporary-emphasis":
      return "background-color: rgb(64 156 255 / 35%); color: inherit;";
  }
}
