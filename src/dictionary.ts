/** Longest query any installed pack can match; longer text is reported as no entry. */
export const MAX_DICTIONARY_QUERY_BYTES = 4_096;
/** Items requested per section page. */
export const DICTIONARY_SECTION_PAGE_SIZE = 256;

export interface NavigatorDictionaryView {
  readonly viewId: string;
  readonly viewType: "monolingual" | "bilingual";
  /** Display name of the dictionary source, such as `Wiktionary`. */
  readonly sourceName: string;
  /** BCP 47 language of the source edition, such as `fr` for the French Wiktionary. */
  readonly editionLanguage: string | null;
  /** BCP 47 language of the entries. */
  readonly sourceLanguage: string;
  /** BCP 47 language of translations shown by a bilingual view. */
  readonly targetLanguage: string | null;
}

export interface NavigatorDictionaryLookupRequest {
  readonly requestId: string;
  readonly text: string;
  readonly language: string | null;
  readonly initiator: "selection" | "cross-reference";
}

/** A window of one source list: `items` start at `offset` of `total`. */
export interface NavigatorDictionaryBounded<T> {
  readonly offset: number;
  readonly total: number;
  readonly items: readonly T[];
}

export interface NavigatorDictionaryRuby {
  readonly base: string;
  readonly text: string;
}

/** Unicode scalar value offsets into the owning text. */
export interface NavigatorDictionaryEmphasisRange {
  readonly start: number;
  readonly end: number;
}

interface NavigatorDictionaryTagged {
  readonly tags: readonly string[];
  readonly rawTags: readonly string[];
  /** The source item held more values than the projection kept. */
  readonly truncated: boolean;
}

export interface NavigatorDictionaryLemmaReference {
  readonly word: string;
  readonly extra: string | null;
  readonly romanization: string | null;
  readonly tags: readonly string[];
  readonly truncated: boolean;
}

export interface NavigatorDictionaryClassifier extends NavigatorDictionaryTagged {
  readonly classifier: string;
}

export interface NavigatorDictionaryCredit {
  readonly author: string | null;
  readonly authorUrls: readonly string[];
  readonly license: { readonly shortName: string; readonly url: string | null };
  readonly sourceUrl: string | null;
  readonly attributionRequired: boolean | null;
  /** How the played audio differs from the Commons original, or `null` when it is the original. */
  readonly modification: string | null;
}

export type NavigatorDictionaryAudio =
  | {
      readonly status: "available";
      readonly handle: string;
      readonly durationMs: number;
      readonly credit: NavigatorDictionaryCredit;
    }
  | {
      /** Playable by handle; the host fetches it from Wikimedia Commons, so it needs a network. */
      readonly status: "remote";
      readonly handle: string;
      readonly credit: NavigatorDictionaryCredit;
    }
  | {
      readonly status:
        | "unqualified"
        | "missing"
        | "failed"
        | "not-in-collection"
        | "collection-not-installed";
    };

export interface NavigatorDictionaryPronunciation extends NavigatorDictionaryTagged {
  readonly ipa: string | null;
  readonly enpr: string | null;
  readonly zhPronunciation: string | null;
  readonly hangeul: string | null;
  readonly homophone: string | null;
  readonly romanization: string | null;
  readonly form: string | null;
  readonly rhymes: string | null;
  readonly text: string | null;
  readonly note: string | null;
  readonly other: string | null;
  readonly sense: string | null;
  readonly alternative: string | null;
  readonly notSamePronunciation: boolean | null;
  readonly audioIpa: string | null;
  readonly homophones: readonly string[];
  readonly hyphenation: readonly string[];
  readonly topics: readonly string[];
  readonly audio: NavigatorDictionaryAudio | null;
}

export interface NavigatorDictionaryHyphenation extends NavigatorDictionaryTagged {
  readonly parts: readonly string[];
  readonly sense: string | null;
}

export interface NavigatorDictionaryForm extends NavigatorDictionaryTagged {
  readonly form: string;
  readonly romanization: string | null;
  readonly ipa: readonly string[];
  readonly hiragana: string | null;
  readonly article: string | null;
  readonly literalMeaning: string | null;
  readonly source: string | null;
  readonly sense: string | null;
  readonly senseIndex: string | null;
  readonly pronouns: readonly string[];
  readonly ruby: readonly NavigatorDictionaryRuby[];
  readonly topics: readonly string[];
}

export interface NavigatorDictionaryTranslation extends NavigatorDictionaryTagged {
  readonly word: string | null;
  readonly languageName: string | null;
  readonly languageCode: string | null;
  readonly alt: string | null;
  readonly translation: string | null;
  readonly note: string | null;
  readonly sense: string | null;
  readonly senseIndex: string | null;
  readonly taxonomic: string | null;
  readonly romanization: string | null;
  readonly traditionalWriting: string | null;
  readonly other: string | null;
  readonly source: string | null;
  readonly uncertain: boolean | null;
  readonly ruby: readonly NavigatorDictionaryRuby[];
  readonly topics: readonly string[];
}

export interface NavigatorDictionaryExample extends NavigatorDictionaryTagged {
  readonly text: string | null;
  readonly textEmphasis: readonly NavigatorDictionaryEmphasisRange[];
  readonly translation: string | null;
  readonly translationEmphasis: readonly NavigatorDictionaryEmphasisRange[];
  readonly romanization: string | null;
  readonly romanizationEmphasis: readonly NavigatorDictionaryEmphasisRange[];
  readonly literalMeaning: string | null;
  readonly reference: string | null;
  readonly note: string | null;
  readonly exampleType: string | null;
  readonly ruby: readonly NavigatorDictionaryRuby[];
}

export const NAVIGATOR_DICTIONARY_RELATION_KINDS = [
  "synonyms",
  "antonyms",
  "hypernyms",
  "hyponyms",
  "holonyms",
  "meronyms",
  "troponyms",
  "paronyms",
  "coordinate-terms",
  "instances",
  "derived",
  "related",
  "compounds",
  "abbreviations",
  "contractions",
  "proverbs",
  "idioms",
  "expressions",
  "collocations",
  "phrases",
  "cognates",
  "morphologies",
  "anagrams",
  "various",
] as const;

export type NavigatorDictionaryRelationKind = (typeof NAVIGATOR_DICTIONARY_RELATION_KINDS)[number];

export interface NavigatorDictionaryRelation extends NavigatorDictionaryTagged {
  readonly word: string | null;
  readonly alt: string | null;
  readonly translation: string | null;
  readonly extra: string | null;
  readonly qualifier: string | null;
  readonly romanization: string | null;
  readonly sense: string | null;
  readonly senseIndex: string | null;
  readonly note: string | null;
  readonly alternativeSpelling: string | null;
  readonly literalMeaning: string | null;
  readonly taxonomic: string | null;
  readonly source: string | null;
  readonly languageName: string | null;
  readonly languageCode: string | null;
  readonly ruby: readonly NavigatorDictionaryRuby[];
  readonly topics: readonly string[];
}

export interface NavigatorDictionaryRelationGroup {
  readonly kind: NavigatorDictionaryRelationKind;
  readonly relations: NavigatorDictionaryBounded<NavigatorDictionaryRelation>;
}

export interface NavigatorDictionaryDescendant extends NavigatorDictionaryTagged {
  readonly depth: number;
  readonly word: string | null;
  readonly languageName: string | null;
  readonly languageCode: string | null;
  readonly romanization: string | null;
  readonly sense: string | null;
  readonly senseIndex: string | null;
  readonly ruby: readonly NavigatorDictionaryRuby[];
}

export interface NavigatorDictionarySense extends NavigatorDictionaryTagged {
  readonly glosses: readonly string[];
  readonly rawGlosses: readonly string[];
  readonly qualifier: string | null;
  readonly taxonomic: string | null;
  readonly senseIndex: string | null;
  readonly notes: readonly string[];
  readonly topics: readonly string[];
  readonly categories: readonly string[];
  readonly formOf: readonly NavigatorDictionaryLemmaReference[];
  readonly altOf: readonly NavigatorDictionaryLemmaReference[];
  readonly compoundOf: readonly NavigatorDictionaryLemmaReference[];
  readonly classifiers: readonly NavigatorDictionaryClassifier[];
  readonly examples: NavigatorDictionaryBounded<NavigatorDictionaryExample>;
  readonly translations: NavigatorDictionaryBounded<NavigatorDictionaryTranslation>;
  readonly relations: readonly NavigatorDictionaryRelationGroup[];
}

export interface NavigatorDictionaryEntry extends NavigatorDictionaryTagged {
  /** Opaque provider-owned identity for entry and section reads. */
  readonly handle: string;
  readonly headword: string;
  readonly languageName: string | null;
  readonly languageCode: string;
  readonly partOfSpeech: string | null;
  readonly partOfSpeechTitle: string | null;
  readonly literalMeaning: string | null;
  readonly etymologyNumber: string | null;
  readonly formOf: readonly NavigatorDictionaryLemmaReference[];
  readonly altOf: readonly NavigatorDictionaryLemmaReference[];
  readonly classifiers: readonly NavigatorDictionaryClassifier[];
  readonly etymology: NavigatorDictionaryBounded<string>;
  readonly pronunciations: NavigatorDictionaryBounded<NavigatorDictionaryPronunciation>;
  readonly hyphenations: NavigatorDictionaryBounded<NavigatorDictionaryHyphenation>;
  readonly forms: NavigatorDictionaryBounded<NavigatorDictionaryForm>;
  readonly senses: NavigatorDictionaryBounded<NavigatorDictionarySense>;
  readonly translations: NavigatorDictionaryBounded<NavigatorDictionaryTranslation>;
  /** Translations across every sense that match a bilingual view's target language. */
  readonly senseTranslationTotal: number;
  readonly relations: readonly NavigatorDictionaryRelationGroup[];
  readonly descendants: NavigatorDictionaryBounded<NavigatorDictionaryDescendant>;
  readonly notes: NavigatorDictionaryBounded<string>;
  readonly categories: NavigatorDictionaryBounded<string>;
}

export type NavigatorDictionaryMatchClass =
  | "authored-headword"
  | "nfc-headword"
  | "folded-headword"
  | "authored-form"
  | "nfc-form"
  | "folded-form";

export interface NavigatorDictionaryMatch {
  readonly matchClass: NavigatorDictionaryMatchClass;
  readonly entry: NavigatorDictionaryEntry;
}

export type NavigatorDictionaryViewOutcome =
  | {
      readonly type: "completed";
      readonly entries: readonly NavigatorDictionaryMatch[];
      /** More entries matched than were returned. */
      readonly truncated: boolean;
    }
  | {
      readonly type: "no-translation";
      readonly entries: readonly NavigatorDictionaryMatch[];
    }
  | { readonly type: "no-entry" }
  | { readonly type: "failed" };

export interface NavigatorDictionaryViewResult {
  readonly viewId: string;
  readonly outcome: NavigatorDictionaryViewOutcome;
}

export interface NavigatorDictionaryLookup {
  readonly requestId: string;
  /** The text the provider looked up, which may differ from the request by edge punctuation. */
  readonly query: string;
  readonly views: readonly NavigatorDictionaryViewResult[];
}

export type NavigatorDictionarySectionRef =
  | {
      readonly type:
        | "etymology"
        | "pronunciations"
        | "hyphenations"
        | "forms"
        | "senses"
        | "translations"
        | "descendants"
        | "notes"
        | "categories";
    }
  | {
      readonly type: "relations";
      readonly kind: NavigatorDictionaryRelationKind;
    }
  | {
      readonly type: "sense-examples" | "sense-translations";
      readonly sense: number;
    }
  | {
      readonly type: "sense-relations";
      readonly sense: number;
      readonly kind: NavigatorDictionaryRelationKind;
    };

export type NavigatorDictionarySectionPage =
  | {
      readonly type: "etymology" | "notes" | "categories";
      readonly page: NavigatorDictionaryBounded<string>;
    }
  | {
      readonly type: "pronunciations";
      readonly page: NavigatorDictionaryBounded<NavigatorDictionaryPronunciation>;
    }
  | {
      readonly type: "hyphenations";
      readonly page: NavigatorDictionaryBounded<NavigatorDictionaryHyphenation>;
    }
  | {
      readonly type: "forms";
      readonly page: NavigatorDictionaryBounded<NavigatorDictionaryForm>;
    }
  | {
      readonly type: "senses";
      readonly page: NavigatorDictionaryBounded<NavigatorDictionarySense>;
    }
  | {
      readonly type: "translations";
      readonly page: NavigatorDictionaryBounded<NavigatorDictionaryTranslation>;
    }
  | {
      readonly type: "relations";
      readonly page: NavigatorDictionaryBounded<NavigatorDictionaryRelation>;
    }
  | {
      readonly type: "descendants";
      readonly page: NavigatorDictionaryBounded<NavigatorDictionaryDescendant>;
    }
  | {
      readonly type: "examples";
      readonly page: NavigatorDictionaryBounded<NavigatorDictionaryExample>;
    }
  | { readonly type: "no-such-sense" };

export type NavigatorDictionaryUnavailableReason =
  | "snapshot-unavailable"
  | "entry-unavailable"
  | "audio-unavailable";

export type NavigatorDictionaryProviderOutcome<T> =
  | ({ readonly status: "completed" } & T)
  | {
      readonly status: "unavailable";
      readonly reason: NavigatorDictionaryUnavailableReason;
    }
  | { readonly status: "failed"; readonly message: string | null };

export type NavigatorDictionaryEntryState =
  | { readonly state: "loading" }
  | { readonly state: "loaded" }
  | { readonly state: "failed"; readonly message: string | null };

export type NavigatorDictionarySectionState =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string | null };

/** One lookup and every detail and section page loaded into it. */
export interface NavigatorDictionaryResult {
  readonly request: NavigatorDictionaryLookupRequest;
  readonly lookup: NavigatorDictionaryLookup;
  /** Detail reads keyed by entry handle; loaded detail replaces the entry in `lookup`. */
  readonly details: Readonly<Record<string, NavigatorDictionaryEntryState>>;
  /** Pending or failed section reads keyed by `navigatorDictionarySectionKey`. */
  readonly sections: Readonly<Record<string, NavigatorDictionarySectionState>>;
}

export type NavigatorDictionaryLookupState =
  | { readonly state: "idle" }
  | {
      readonly state: "looking-up";
      readonly request: NavigatorDictionaryLookupRequest;
    }
  | { readonly state: "ready"; readonly result: NavigatorDictionaryResult }
  | {
      readonly state: "unavailable";
      readonly reason: NavigatorDictionaryUnavailableReason;
      readonly request: NavigatorDictionaryLookupRequest | null;
    }
  | {
      readonly state: "failed";
      readonly message: string | null;
      readonly request: NavigatorDictionaryLookupRequest;
    };

export interface NavigatorDictionaryPlayback {
  readonly handle: string;
  readonly state: "loading" | "playing" | "failed";
}

export interface NavigatorDictionarySnapshot {
  readonly lookup: NavigatorDictionaryLookupState;
  /** Earlier results, oldest first, restored by going back. */
  readonly history: readonly NavigatorDictionaryResult[];
  readonly playback: NavigatorDictionaryPlayback | null;
}

export function navigatorDictionarySectionKey(
  handle: string,
  section: NavigatorDictionarySectionRef,
): string {
  const parts: (string | number)[] = [handle, section.type];
  if ("sense" in section) parts.push(section.sense);
  if ("kind" in section) parts.push(section.kind);
  return JSON.stringify(parts);
}
