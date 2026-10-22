import type { NavigatorDiagnosticEvent, NavigatorDiagnostics } from "epub-navigator/runtime";
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, useLayoutEffect } from "react";
import "@fontsource-variable/inter";
import { aliceMount, openArchive, requiredElement } from "../harness.js";
import type {
  PublicationDictionaryCapabilities,
  PublicationSearchCapabilities,
} from "epub-navigator/runtime";
import type { NavigatorDictionaryEntry } from "epub-navigator";
import {
  NavigatorReader,
  type NavigatorAnnotationAcknowledgment,
  type NavigatorAnnotationMutationRequest,
  type NavigatorAnnotationProjection,
  type NavigatorReaderPreferences,
} from "epub-navigator/react";
import "epub-navigator/react.css";
import type { NavigatorLinkActivation } from "epub-navigator/react";
import { defaultPreferences } from "../../../src/react/runtime/preferences-state.js";

const publication = await openArchive();
const root = requiredElement("#root");

const facts = structuredClone(publication.facts);
if (new URLSearchParams(location.search).has("rich-description")) {
  facts.package.metadata.description = [
    {
      ...facts.package.metadata.title[0]!,
      content:
        '<p>An <strong>illustrated</strong> adventure.</p><ul><li>Original drawings</li><li>A curious heroine</li></ul><p><a href="https://example.com/alice">Visit the publisher</a></p><img src="https://example.com/tracker"><script>window.descriptionExecuted = true</script>',
    },
  ];
}
if (new URLSearchParams(location.search).has("page-list")) {
  const resource = facts.resources.resources.findIndex(
    (candidate) =>
      candidate.address.kind === "local" && candidate.address.value === "epub/text/chapter-1.xhtml",
  );
  const lists = facts.navigation?.lists;
  if (resource < 0 || lists === undefined)
    throw new Error("Alice page-list fixture is unavailable");
  const listIndex = lists.length;
  const pages = [
    { label: "1", fragment: "chapter-1" },
    { label: "2", fragment: "illustration-2" },
  ];
  lists.push({
    semantic: "page-list",
    heading: { level: 2, text: "Pages" },
    hidden: false,
    points: pages.map(({ label, fragment }) => ({
      label,
      authoredHref: `text/chapter-1.xhtml#${fragment}`,
      children: [],
      hidden: false,
      semantic: null,
      authoredSemanticTokens: [],
    })),
    authoredSemanticTokens: [],
  });
  facts.navigationTargets.push(
    ...pages.map(({ fragment }, point) => ({
      listIndex,
      pointPath: [point],
      authoredHref: `text/chapter-1.xhtml#${fragment}`,
      target: {
        state: "resource" as const,
        resource,
        fragment,
      },
    })),
  );
}

const mounted = { facts, mount: aliceMount };
const session = {
  id: crypto.randomUUID(),
  publication: mounted,
};
const searchController = new AbortController();
const searchCapabilities: PublicationSearchCapabilities = {
  scopes: ["publication", "occurrence"],
  signal: searchController.signal,
  async search(request) {
    const results =
      request.query.trim().toLocaleLowerCase() === "rabbit" &&
      (request.scope.type === "publication" || request.scope.occurrence === 5)
        ? [
            {
              id: "alice-chapter-1-result",
              section: {
                id: "alice-chapter-1",
                occurrence: 5,
                resource: "epub/text/chapter-1.xhtml",
                label: "I: Down the Rabbit-Hole",
              },
              targetJson: JSON.stringify({
                source: "text/chapter-1.xhtml",
                selector: [
                  {
                    type: "CssSelector",
                    value: "#chapter-1 > p:nth-of-type(5)",
                    refinedBy: { type: "TextPositionSelector", start: 4, end: 10 },
                  },
                ],
              }),
              excerpt: {
                before: "The ",
                match: "rabbit",
                after: "-hole went straight on like a tunnel for some way.",
              },
            },
          ]
        : [];
    return {
      status: "completed",
      batch: {
        requestId: request.requestId,
        results,
        coverage: {
          state: "complete",
          searchedOccurrences: mounted.facts.resources.readingOrder.length,
          totalOccurrences: mounted.facts.resources.readingOrder.length,
        },
        continuation: null,
        totalResultCount: results.length,
      },
    };
  },
  close: () => searchController.abort(),
};

const tagged = { tags: [], rawTags: [], truncated: false };
function dictionaryEntry(headword: string): NavigatorDictionaryEntry {
  const bounded = <T,>(items: T[]) => ({ offset: 0, total: items.length, items });
  return {
    ...tagged,
    handle: `entry.${headword}`,
    headword,
    languageName: "English",
    languageCode: "en",
    partOfSpeech: "noun",
    partOfSpeechTitle: null,
    literalMeaning: null,
    etymologyNumber: null,
    formOf: [],
    altOf: [],
    classifiers: [],
    etymology: bounded(["From Middle English olifaunt."]),
    pronunciations: bounded([]),
    hyphenations: bounded([]),
    forms: bounded([]),
    senses: bounded([
      {
        ...tagged,
        glosses: ["Largest living land mammal"],
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
        examples: bounded([
          {
            ...tagged,
            text: `An example with ${headword}.`,
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
          },
        ]),
        translations: bounded([]),
        relations: [],
      },
    ]),
    translations: bounded([]),
    senseTranslationTotal: 0,
    relations: [],
    descendants: bounded([]),
    notes: bounded([]),
    categories: bounded([]),
  };
}
const dictionaryController = new AbortController();
const dictionaryCapabilities: PublicationDictionaryCapabilities = {
  views: [
    {
      viewId: "en",
      viewType: "monolingual",
      sourceName: "Wiktionary",
      editionLanguage: "en",
      sourceLanguage: "en",
      targetLanguage: null,
    },
  ],
  signal: dictionaryController.signal,
  async lookup(request) {
    return {
      status: "completed",
      lookup: {
        requestId: request.requestId,
        query: request.text,
        views: [
          {
            viewId: "en",
            outcome: {
              type: "completed",
              truncated: false,
              entries: [{ matchClass: "authored-headword", entry: dictionaryEntry(request.text) }],
            },
          },
        ],
      },
    };
  },
  async entry(handle) {
    return { status: "completed", entry: dictionaryEntry(handle.slice("entry.".length)) };
  },
  async section() {
    return { status: "failed", message: null };
  },
  async audio() {
    return { status: "unavailable", reason: "audio-unavailable" };
  },
  close: () => dictionaryController.abort(),
};

declare global {
  interface Window {
    __EPUB_NAVIGATOR_DIAGNOSTICS__?: NavigatorDiagnosticEvent[] | undefined;
    __EPUB_NAVIGATOR_LAST_ACTIVATION__?: NavigatorLinkActivation;
    __EPUB_NAVIGATOR_DUPLICATE_ANNOTATIONS__?: ((count: number) => void) | undefined;
  }
}

const diagnosticEvents: NavigatorDiagnosticEvent[] = [];
window.__EPUB_NAVIGATOR_DIAGNOSTICS__ = diagnosticEvents;
const diagnostics: NavigatorDiagnostics = {
  level: "trace",
  record: (event) => diagnosticEvents.push(event),
};

const preferencesKey = "epub-navigator.preferences";

function storedPreferences(): NavigatorReaderPreferences {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(preferencesKey) ?? "null");
    if (typeof stored === "object" && stored !== null) return { ...defaultPreferences, ...stored };
  } catch {}
  return defaultPreferences;
}

export function ReaderFixture() {
  const [annotations, setAnnotations] = useState<NavigatorAnnotationProjection>({
    revision: 0,
    records: [],
  });
  const annotationsRef = useRef(annotations);
  useLayoutEffect(() => {
    annotationsRef.current = annotations;
  });
  useEffect(() => {
    window.__EPUB_NAVIGATOR_DUPLICATE_ANNOTATIONS__ = (count) => {
      setAnnotations((current) => {
        const source = current.records[0];
        if (source === undefined) return current;
        return {
          revision: current.revision + 1,
          records: [
            ...current.records,
            ...Array.from({ length: count }, (_, index) => ({
              ...source,
              id: `${source.id}-fixture-${index}`,
            })),
          ],
        };
      });
    };
    return () => {
      delete window.__EPUB_NAVIGATOR_DUPLICATE_ANNOTATIONS__;
    };
  }, []);
  const [preferences, setPreferences] = useState(storedPreferences);
  const updatePreferences = (value: NavigatorReaderPreferences) => {
    setPreferences(value);
    localStorage.setItem(preferencesKey, JSON.stringify(value));
  };
  const mutateAnnotation = async (
    request: NavigatorAnnotationMutationRequest,
  ): Promise<NavigatorAnnotationAcknowledgment> => {
    const current = annotationsRef.current;
    if (request.basedOnRevision !== current.revision) {
      return {
        status: "rejected",
        requestId: request.requestId,
        reason: "The annotation collection changed. Try again.",
      };
    }
    if (
      request.type === "convert-highlight-to-note" &&
      !current.records.some(
        (record) => record.id === request.recordId && record.type === "highlight",
      )
    ) {
      return {
        status: "rejected",
        requestId: request.requestId,
        reason: "The annotation record is not a highlight.",
      };
    }
    const recordId =
      request.type === "create-highlight" ||
      request.type === "create-note" ||
      request.type === "create-bookmark"
        ? crypto.randomUUID()
        : request.recordId;
    const records =
      request.type === "create-bookmark"
        ? [
            ...current.records,
            {
              type: "bookmark" as const,
              id: recordId,
              targetJson: request.targetJson,
              occurrence: request.occurrence,
              sectionLabel: request.sectionLabel,
              label: request.label,
            },
          ]
        : request.type === "create-highlight" || request.type === "create-note"
          ? [
              ...current.records,
              request.type === "create-highlight"
                ? {
                    type: "highlight" as const,
                    id: recordId,
                    targetJson: request.targetJson,
                    occurrence: request.occurrence,
                    excerpt: request.excerpt,
                    sectionLabel: request.sectionLabel,
                  }
                : {
                    type: "note" as const,
                    id: recordId,
                    targetJson: request.targetJson,
                    occurrence: request.occurrence,
                    excerpt: request.excerpt,
                    sectionLabel: request.sectionLabel,
                    text: request.text,
                  },
            ]
          : request.type === "update-note"
            ? current.records.map((record) =>
                record.id === request.recordId && record.type === "note"
                  ? { ...record, text: request.text }
                  : record,
              )
            : request.type === "convert-highlight-to-note"
              ? current.records.map((record) =>
                  record.id === request.recordId && record.type === "highlight"
                    ? { ...record, type: "note" as const, text: request.text }
                    : record,
                )
              : request.type === "retarget-annotation"
                ? current.records.map((record) =>
                    record.id === request.recordId
                      ? { ...record, targetJson: request.targetJson, excerpt: request.excerpt }
                      : record,
                  )
                : current.records.filter((record) => record.id !== request.recordId);
    const next = { revision: current.revision + 1, records };
    annotationsRef.current = next;
    setAnnotations(next);
    return {
      status: "accepted",
      requestId: request.requestId,
      recordId,
      projectionRevision: next.revision,
    };
  };
  return (
    <NavigatorReader
      session={session}
      preferences={preferences}
      onPreferencesChange={updatePreferences}
      diagnostics={diagnostics}
      annotations={annotations}
      onAnnotationMutation={mutateAnnotation}
      search={searchCapabilities}
      dictionary={dictionaryCapabilities}
      onLibraryRequest={() => {
        document.documentElement.dataset.libraryRequested = "true";
      }}
      onLinkActivation={(activation) => {
        window.__EPUB_NAVIGATOR_LAST_ACTIVATION__ = activation;
      }}
    />
  );
}

createRoot(root).render(<ReaderFixture />);

addEventListener("pagehide", () => publication.close(), { once: true });
