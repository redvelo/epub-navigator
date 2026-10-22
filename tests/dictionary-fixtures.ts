import { vi } from "vitest";
import type {
  NavigatorDictionaryEntry,
  NavigatorDictionaryLookupRequest,
  NavigatorDictionarySectionPage,
  NavigatorDictionaryView,
} from "../src/dictionary.js";
import type { PublicationDictionaryCapabilities } from "../src/runtime/dictionary.js";

export const dictionaryViews: NavigatorDictionaryView[] = [
  {
    viewId: "fr",
    viewType: "monolingual",
    sourceName: "Wiktionary",
    editionLanguage: "fr",
    sourceLanguage: "fr",
    targetLanguage: null,
  },
  {
    viewId: "fr-en",
    viewType: "bilingual",
    sourceName: "Wiktionary",
    editionLanguage: "fr",
    sourceLanguage: "fr",
    targetLanguage: "en",
  },
];

const tagged = { tags: [], rawTags: [], truncated: false };
const bounded = <T>(items: T[], total = items.length) => ({
  offset: 0,
  total,
  items,
});

export function dictionarySense(gloss: string, examples = 0, exampleTotal = examples) {
  return {
    ...tagged,
    glosses: [gloss],
    rawGlosses: [],
    qualifier: null,
    taxonomic: null,
    senseIndex: null,
    notes: [],
    topics: [],
    categories: [],
    formOf: [],
    altOf: [],
    compoundOf: [],
    classifiers: [],
    examples: bounded(
      Array.from({ length: examples }, (_, index) => dictionaryExample(`${gloss} ${index}`)),
      exampleTotal,
    ),
    translations: bounded([]),
    relations: [],
  };
}

export function dictionaryExample(text: string) {
  return {
    ...tagged,
    text,
    textEmphasis: [],
    translation: null,
    translationEmphasis: [],
    romanization: null,
    romanizationEmphasis: [],
    literalMeaning: null,
    reference: null,
    note: null,
    exampleType: null,
    ruby: [],
  };
}

export function dictionaryEntry(handle: string, overrides: Partial<NavigatorDictionaryEntry> = {}) {
  return {
    ...tagged,
    handle,
    headword: "éléphant",
    languageName: "Français",
    languageCode: "fr",
    partOfSpeech: "noun",
    partOfSpeechTitle: "Nom commun",
    literalMeaning: null,
    etymologyNumber: null,
    formOf: [],
    altOf: [],
    classifiers: [],
    etymology: bounded([], 1),
    pronunciations: bounded([
      {
        ...tagged,
        ipa: "\\e.le.fɑ̃\\",
        enpr: null,
        zhPronunciation: null,
        hangeul: null,
        homophone: null,
        romanization: null,
        form: null,
        rhymes: null,
        text: null,
        note: null,
        other: null,
        sense: null,
        alternative: null,
        notSamePronunciation: null,
        audioIpa: null,
        homophones: [],
        hyphenation: [],
        topics: [],
        audio: {
          status: "available",
          handle: "a.fr.RWxlcGhhbnQub2dn",
          durationMs: 900,
          credit: {
            author: "Speaker",
            authorUrls: [],
            license: { shortName: "CC BY-SA 4.0", url: null },
            sourceUrl: null,
            attributionRequired: true,
            modification: "Transcoded to Ogg Opus 24 kbps mono",
          },
        },
      },
    ]),
    hyphenations: bounded([]),
    forms: bounded([]),
    senses: bounded([dictionarySense("Mammifère")], 2),
    translations: bounded([]),
    senseTranslationTotal: 0,
    relations: [],
    descendants: bounded([]),
    notes: bounded([]),
    categories: bounded([]),
    ...overrides,
  } satisfies NavigatorDictionaryEntry;
}

export function dictionaryCapabilities(overrides: Partial<PublicationDictionaryCapabilities> = {}) {
  const controller = new AbortController();
  const value = {
    views: dictionaryViews,
    signal: controller.signal,
    lookup: vi.fn(async (request: NavigatorDictionaryLookupRequest) => ({
      status: "completed" as const,
      lookup: {
        requestId: request.requestId,
        query: request.text,
        views: [
          {
            viewId: "fr",
            outcome: {
              type: "completed" as const,
              truncated: false,
              entries: [
                {
                  matchClass: "authored-headword" as const,
                  entry: dictionaryEntry(`e.${request.text}`),
                },
              ],
            },
          },
          { viewId: "fr-en", outcome: { type: "no-entry" as const } },
        ],
      },
    })),
    entry: vi.fn(async (handle: string) => ({
      status: "completed" as const,
      entry: dictionaryEntry(handle, {
        etymology: bounded(["Du latin elephantus."]),
        senses: bounded([dictionarySense("Mammifère", 1, 3)], 2),
      }),
    })),
    section: vi.fn(
      async (
        _handle: string,
        section: { type: string },
        page: { offset: number; limit: number },
      ): Promise<{
        status: "completed";
        section: NavigatorDictionarySectionPage;
      }> => ({
        status: "completed",
        section:
          section.type === "senses"
            ? {
                type: "senses",
                page: {
                  offset: page.offset,
                  total: 2,
                  items: [dictionarySense("Homme politique")],
                },
              }
            : {
                type: "examples",
                page: {
                  offset: page.offset,
                  total: 3,
                  items: [dictionaryExample("deux"), dictionaryExample("trois")],
                },
              },
      }),
    ),
    audio: vi.fn(async () => ({
      status: "completed" as const,
      blob: new Blob([new Uint8Array([1, 2, 3])], {
        type: "audio/ogg; codecs=opus",
      }),
    })),
    close: vi.fn(),
    ...overrides,
  };
  return { value, controller };
}
