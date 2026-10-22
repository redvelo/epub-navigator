import type { MouseEvent as ReactMouseEvent } from "react";
import type {
  NavigatorDictionaryRelationKind,
  NavigatorDictionarySnapshot,
  NavigatorDictionaryView,
} from "../../dictionary.js";

export function dictionaryTitle(snapshot: NavigatorDictionarySnapshot): string {
  const lookup = snapshot.lookup;
  if (lookup.state === "ready") return lookup.result.lookup.query;
  if (lookup.state === "looking-up" || lookup.state === "failed") return lookup.request.text;
  if (lookup.state === "unavailable" && lookup.request !== null) return lookup.request.text;
  return "Dictionary";
}

const relationLabels: Record<NavigatorDictionaryRelationKind, string> = {
  synonyms: "Synonyms",
  antonyms: "Antonyms",
  hypernyms: "Hypernyms",
  hyponyms: "Hyponyms",
  holonyms: "Holonyms",
  meronyms: "Meronyms",
  troponyms: "Troponyms",
  paronyms: "Paronyms",
  "coordinate-terms": "Coordinate terms",
  instances: "Instances",
  derived: "Derived terms",
  related: "Related terms",
  compounds: "Compounds",
  abbreviations: "Abbreviations",
  contractions: "Contractions",
  proverbs: "Proverbs",
  idioms: "Idioms",
  expressions: "Expressions",
  collocations: "Collocations",
  phrases: "Phrases",
  cognates: "Cognates",
  morphologies: "Morphology",
  anagrams: "Anagrams",
  various: "Other",
};

export function relationLabel(kind: NavigatorDictionaryRelationKind): string {
  return relationLabels[kind];
}

export function viewTitle(view: NavigatorDictionaryView): string {
  const edition =
    view.editionLanguage === null
      ? view.sourceName
      : `${languageName(view.editionLanguage)} ${view.sourceName}`;
  const source =
    view.editionLanguage !== null &&
    primarySubtag(view.editionLanguage) === primarySubtag(view.sourceLanguage)
      ? edition
      : `${edition} · ${languageName(view.sourceLanguage)}`;
  return view.targetLanguage === null ? source : `${source} → ${languageName(view.targetLanguage)}`;
}

let displayNames: Intl.DisplayNames | null | undefined;

function languageName(code: string): string {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      displayNames = null;
    }
  }
  try {
    return displayNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function primarySubtag(language: string): string {
  return language.split("-")[0]?.toLowerCase() ?? "";
}

/** The word under a click on dictionary text, with the language of its text. */
export function wordAtPoint(
  event: ReactMouseEvent<HTMLElement>,
): { readonly text: string; readonly language: string | null } | null {
  if (!event.isTrusted || event.button !== 0 || event.defaultPrevented) return null;
  const container = event.currentTarget;
  const target = event.target instanceof Element ? event.target : null;
  if (
    target === null ||
    target.closest("button, a, input, textarea, [data-dictionary-plain]") !== null
  ) {
    return null;
  }
  const document = container.ownerDocument;
  const selection = document.getSelection();
  if (selection !== null && !selection.isCollapsed) return null;
  const boundary = caretAtPoint(document, event.clientX, event.clientY);
  if (boundary === null || !(boundary.node instanceof Text) || !container.contains(boundary.node)) {
    return null;
  }
  const parent = boundary.node.parentElement;
  if (parent === null || !target.contains(boundary.node)) return null;
  const language = parent.closest("[lang]")?.getAttribute("lang") ?? null;
  const text = boundary.node.data;
  if (typeof Intl.Segmenter !== "function") return null;
  const segments = [
    ...new Intl.Segmenter(language ?? undefined, {
      granularity: "word",
    }).segment(text),
  ];
  const word =
    segments.find(
      (segment) =>
        segment.isWordLike === true &&
        boundary.offset >= segment.index &&
        boundary.offset < segment.index + segment.segment.length,
    ) ??
    segments.find(
      (segment) =>
        segment.isWordLike === true && boundary.offset === segment.index + segment.segment.length,
    );
  return word === undefined ? null : { text: word.segment, language };
}

function caretAtPoint(
  document: Document,
  x: number,
  y: number,
): { readonly node: Node; readonly offset: number } | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(x, y);
    return position === null ? null : { node: position.offsetNode, offset: position.offset };
  }
  const legacy = document as Document & {
    caretRangeFromPoint?: ((x: number, y: number) => Range | null) | undefined;
  };
  const range = legacy.caretRangeFromPoint?.(x, y) ?? null;
  return range === null ? null : { node: range.startContainer, offset: range.startOffset };
}
