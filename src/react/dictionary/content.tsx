import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight, CircleDashed, Pause, Volume2 } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  navigatorDictionarySectionKey,
  type NavigatorDictionaryBounded,
  type NavigatorDictionaryEmphasisRange,
  type NavigatorDictionaryEntry,
  type NavigatorDictionaryExample,
  type NavigatorDictionaryLemmaReference,
  type NavigatorDictionaryPronunciation,
  type NavigatorDictionaryRelationGroup,
  type NavigatorDictionaryResult,
  type NavigatorDictionaryRuby,
  type NavigatorDictionarySectionRef,
  type NavigatorDictionarySense,
  type NavigatorDictionarySnapshot,
  type NavigatorDictionaryTranslation,
  type NavigatorDictionaryView,
  type NavigatorDictionaryViewResult,
} from "../../dictionary.js";
import { Button } from "../components/ui/button.js";
import { relationLabel, viewTitle, wordAtPoint } from "./model.js";

export interface DictionaryContentProps {
  readonly snapshot: NavigatorDictionarySnapshot;
  readonly views: readonly NavigatorDictionaryView[];
  readonly onLookup: (text: string, language: string | null) => void;
  readonly onLoadSection: (handle: string, section: NavigatorDictionarySectionRef) => void;
  readonly onPlay: (handle: string) => void;
  readonly onStop: () => void;
}

interface EntryContext {
  readonly result: NavigatorDictionaryResult;
  readonly view: NavigatorDictionaryView;
  readonly entry: NavigatorDictionaryEntry;
  /** Language of glosses and other text written by the source edition. */
  readonly editionLanguage: string | null;
  readonly props: DictionaryContentProps;
}

export function DictionaryContent(props: DictionaryContentProps) {
  const lookup = props.snapshot.lookup;
  if (lookup.state === "idle") return null;
  if (lookup.state === "looking-up") {
    return (
      <p className="epub-navigator-reader__dictionary-status" role="status">
        <CircleDashed aria-hidden="true" />
        Looking up
      </p>
    );
  }
  if (lookup.state === "unavailable") {
    return (
      <p className="epub-navigator-reader__dictionary-status" role="alert">
        {lookup.reason === "snapshot-unavailable"
          ? "Dictionaries changed. Select the text and look it up again."
          : "This dictionary entry is no longer available."}
      </p>
    );
  }
  if (lookup.state === "failed") {
    return (
      <p className="epub-navigator-reader__dictionary-status" role="alert">
        {lookup.message ?? "The dictionary lookup failed."}
      </p>
    );
  }
  const result = lookup.result;
  const views = new Map(props.views.map((view) => [view.viewId, view]));
  const shown = result.lookup.views.filter((view) => view.outcome.type !== "no-entry");
  return (
    // Clicks on words are a pointer shortcut; every term also renders as a focusable button.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="epub-navigator-reader__dictionary"
      onClick={(event) => {
        const word = wordAtPoint(event);
        if (word !== null) props.onLookup(word.text, word.language);
      }}
    >
      {shown.length === 0 ? (
        <p className="epub-navigator-reader__dictionary-status" role="status">
          No dictionary entry for “{result.lookup.query}”.
        </p>
      ) : (
        shown.map((viewResult) => {
          const view = views.get(viewResult.viewId);
          return view === undefined ? null : (
            <DictionaryView
              key={view.viewId}
              result={result}
              view={view}
              viewResult={viewResult}
              props={props}
            />
          );
        })
      )}
    </div>
  );
}

function DictionaryView({
  result,
  view,
  viewResult,
  props,
}: {
  readonly result: NavigatorDictionaryResult;
  readonly view: NavigatorDictionaryView;
  readonly viewResult: NavigatorDictionaryViewResult;
  readonly props: DictionaryContentProps;
}) {
  const outcome = viewResult.outcome;
  const editionLanguage = view.editionLanguage;
  return (
    <section
      className="epub-navigator-reader__dictionary-view"
      lang={editionLanguage ?? undefined}
      aria-label={viewTitle(view)}
    >
      <h3 className="epub-navigator-reader__dictionary-view-title" lang="en">
        {viewTitle(view)}
      </h3>
      {outcome.type === "failed" ? (
        <p className="epub-navigator-reader__dictionary-note" lang="en">
          This dictionary could not be read.
        </p>
      ) : outcome.type === "no-entry" ? null : (
        <>
          {outcome.entries.map(({ entry }) => {
            const context = { result, view, entry, editionLanguage, props };
            return outcome.type === "no-translation" ? (
              <EntryHeading key={entry.handle} context={context} suffix="No translation" />
            ) : (
              <DictionaryEntry key={entry.handle} context={context} />
            );
          })}
          {outcome.type === "completed" && outcome.truncated ? (
            <p className="epub-navigator-reader__dictionary-note" lang="en">
              More entries match than this dictionary returned.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function EntryHeading({
  context,
  suffix,
}: {
  readonly context: EntryContext;
  readonly suffix?: string | undefined;
}) {
  const { entry } = context;
  return (
    <header className="epub-navigator-reader__dictionary-entry-heading">
      <h4 lang={entry.languageCode}>{entry.headword}</h4>
      {entry.partOfSpeechTitle !== null || entry.partOfSpeech !== null ? (
        <span className="epub-navigator-reader__dictionary-pos">
          {entry.partOfSpeechTitle ?? entry.partOfSpeech}
        </span>
      ) : null}
      <Labels values={[...entry.rawTags, ...entry.tags]} />
      {suffix === undefined ? null : (
        <span className="epub-navigator-reader__dictionary-note" lang="en">
          {suffix}
        </span>
      )}
    </header>
  );
}

function DictionaryEntry({ context }: { readonly context: EntryContext }) {
  const { entry, view, result, props } = context;
  const detail = result.details[entry.handle];
  const bilingual = view.viewType === "bilingual";
  const recordings = entry.pronunciations.items.filter(
    (pronunciation) => playableAudio(pronunciation) !== null,
  );
  const ipa = entry.pronunciations.items.find((pronunciation) => pronunciation.ipa !== null)?.ipa;
  const relationTotal = entry.relations.reduce((total, group) => total + group.relations.total, 0);
  return (
    <article className="epub-navigator-reader__dictionary-entry">
      <EntryHeading context={context} />
      {ipa !== undefined || recordings.length > 0 ? (
        <p className="epub-navigator-reader__dictionary-pronunciation">
          {ipa === undefined || ipa === null ? null : <span className="font-mono">{ipa}</span>}
          {recordings[0] === undefined ? null : (
            <PlayButton pronunciation={recordings[0]} props={props} />
          )}
        </p>
      ) : null}
      <LemmaLines context={context} formOf={entry.formOf} altOf={entry.altOf} compoundOf={[]} />
      {detail?.state === "loading" ? (
        <p className="epub-navigator-reader__dictionary-note" role="status" lang="en">
          Loading the full entry
        </p>
      ) : detail?.state === "failed" ? (
        <p className="epub-navigator-reader__dictionary-note" role="alert" lang="en">
          {detail.message ?? "The full entry could not be read."}
        </p>
      ) : null}
      <ol className="epub-navigator-reader__dictionary-senses">
        {entry.senses.items.map((sense, index) => (
          <DictionarySense
            key={index}
            context={context}
            sense={sense}
            index={index + entry.senses.offset}
          />
        ))}
      </ol>
      <MoreButton
        context={context}
        window={entry.senses}
        section={{ type: "senses" }}
        noun="senses"
      />
      {bilingual && entry.translations.total > 0 ? (
        <>
          <TranslationTerms context={context} translations={entry.translations.items} />
          <MoreButton
            context={context}
            window={entry.translations}
            section={{ type: "translations" }}
            noun="translations"
          />
        </>
      ) : null}
      {entry.etymology.total > 0 ? (
        <EntrySection title="Etymology" count={null}>
          {entry.etymology.items.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
          <MoreButton context={context} window={entry.etymology} section={{ type: "etymology" }} />
        </EntrySection>
      ) : null}
      {entry.pronunciations.total > 0 ? (
        <EntrySection title="Pronunciations" count={entry.pronunciations.total}>
          <ul className="epub-navigator-reader__dictionary-list">
            {entry.pronunciations.items.map((pronunciation, index) => (
              <PronunciationItem key={index} context={context} pronunciation={pronunciation} />
            ))}
          </ul>
          <MoreButton
            context={context}
            window={entry.pronunciations}
            section={{ type: "pronunciations" }}
          />
        </EntrySection>
      ) : null}
      {entry.hyphenations.total > 0 ? (
        <EntrySection title="Hyphenation" count={entry.hyphenations.total}>
          <ul className="epub-navigator-reader__dictionary-list">
            {entry.hyphenations.items.map((hyphenation, index) => (
              <li key={index} lang={entry.languageCode}>
                {hyphenation.parts.join("‧")}
                <Labels values={[hyphenation.sense, ...hyphenation.rawTags, ...hyphenation.tags]} />
              </li>
            ))}
          </ul>
          <MoreButton
            context={context}
            window={entry.hyphenations}
            section={{ type: "hyphenations" }}
          />
        </EntrySection>
      ) : null}
      {entry.forms.total > 0 ? (
        <EntrySection title="Forms" count={entry.forms.total}>
          <ul className="epub-navigator-reader__dictionary-list">
            {entry.forms.items.map((form, index) => (
              <li key={index}>
                <Term text={form.form} language={entry.languageCode} props={props} />
                {form.ipa.length > 0 ? (
                  <span className="font-mono"> {form.ipa.join(", ")}</span>
                ) : null}
                <Labels values={[...form.rawTags, ...form.tags, ...form.topics]} />
              </li>
            ))}
          </ul>
          <MoreButton context={context} window={entry.forms} section={{ type: "forms" }} />
        </EntrySection>
      ) : null}
      {relationTotal > 0 ? (
        <EntrySection title="Related words" count={relationTotal}>
          <RelationGroups context={context} groups={entry.relations} sense={null} />
        </EntrySection>
      ) : null}
      {!bilingual && entry.translations.total > 0 ? (
        <EntrySection title="Translations" count={entry.translations.total}>
          <TranslationTerms context={context} translations={entry.translations.items} grouped />
          <MoreButton
            context={context}
            window={entry.translations}
            section={{ type: "translations" }}
          />
        </EntrySection>
      ) : null}
      {entry.descendants.total > 0 ? (
        <EntrySection title="Descendants" count={entry.descendants.total}>
          <ul className="epub-navigator-reader__dictionary-list">
            {entry.descendants.items.map((descendant, index) => (
              <li key={index} style={{ paddingInlineStart: `${descendant.depth}rem` }}>
                {descendant.languageName === null ? null : (
                  <span className="text-muted-foreground">{descendant.languageName}: </span>
                )}
                {descendant.word === null ? null : (
                  <Term text={descendant.word} language={descendant.languageCode} props={props} />
                )}
                <Labels
                  values={[descendant.romanization, ...descendant.rawTags, ...descendant.tags]}
                />
              </li>
            ))}
          </ul>
          <MoreButton
            context={context}
            window={entry.descendants}
            section={{ type: "descendants" }}
          />
        </EntrySection>
      ) : null}
      {entry.notes.total > 0 ? (
        <EntrySection title="Notes" count={entry.notes.total}>
          {entry.notes.items.map((note, index) => (
            <p key={index}>{note}</p>
          ))}
          <MoreButton context={context} window={entry.notes} section={{ type: "notes" }} />
        </EntrySection>
      ) : null}
      {entry.categories.total > 0 ? (
        <EntrySection title="Categories" count={entry.categories.total}>
          <p>{entry.categories.items.join(" · ")}</p>
          <MoreButton
            context={context}
            window={entry.categories}
            section={{ type: "categories" }}
          />
        </EntrySection>
      ) : null}
      {recordings.length > 0 ? (
        <EntrySection title="Audio credits" count={null} plain>
          <ul className="epub-navigator-reader__dictionary-list" lang="en">
            {recordings.map((pronunciation, index) => {
              const credit = playableAudio(pronunciation)?.credit;
              if (credit === undefined) return null;
              return (
                <li key={index}>
                  <PlayButton pronunciation={pronunciation} props={props} />
                  <span>
                    {[
                      credit.author ?? "Unknown author",
                      credit.license.shortName,
                      "Wikimedia Commons",
                      credit.modification,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </span>
                  {credit.sourceUrl === null ? null : (
                    <span className="epub-navigator-reader__dictionary-url">
                      {credit.sourceUrl}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </EntrySection>
      ) : null}
    </article>
  );
}

function DictionarySense({
  context,
  sense,
  index,
}: {
  readonly context: EntryContext;
  readonly sense: NavigatorDictionarySense;
  readonly index: number;
}) {
  const { entry, view } = context;
  const glosses = sense.glosses.length > 0 ? sense.glosses : sense.rawGlosses;
  return (
    <li className="epub-navigator-reader__dictionary-sense">
      {glosses.length > 0 ? (
        <p>
          {glosses.slice(0, -1).map((gloss, glossIndex) => (
            <span key={glossIndex} className="text-muted-foreground">
              {gloss} ›{" "}
            </span>
          ))}
          {glosses.at(-1)}
        </p>
      ) : null}
      <Labels
        values={[
          sense.qualifier,
          ...sense.rawTags,
          ...sense.tags,
          ...sense.topics,
          sense.taxonomic,
        ]}
      />
      <LemmaLines
        context={context}
        formOf={sense.formOf}
        altOf={sense.altOf}
        compoundOf={sense.compoundOf}
      />
      {sense.notes.map((note, noteIndex) => (
        <p key={noteIndex} className="epub-navigator-reader__dictionary-note">
          {note}
        </p>
      ))}
      {sense.examples.items.length > 0 ? (
        <ul className="epub-navigator-reader__dictionary-examples">
          {sense.examples.items.map((example, exampleIndex) => (
            <ExampleItem key={exampleIndex} example={example} language={entry.languageCode} />
          ))}
        </ul>
      ) : null}
      <MoreButton
        context={context}
        window={sense.examples}
        section={{ type: "sense-examples", sense: index }}
        noun="examples"
      />
      {view.viewType === "bilingual" && sense.translations.total > 0 ? (
        <>
          <TranslationTerms context={context} translations={sense.translations.items} />
          <MoreButton
            context={context}
            window={sense.translations}
            section={{ type: "sense-translations", sense: index }}
            noun="translations"
          />
        </>
      ) : null}
      {sense.relations.length > 0 ? (
        <RelationGroups context={context} groups={sense.relations} sense={index} />
      ) : null}
    </li>
  );
}

function ExampleItem({
  example,
  language,
}: {
  readonly example: NavigatorDictionaryExample;
  readonly language: string;
}) {
  return (
    <li>
      {example.text === null ? null : (
        <p lang={language} className="italic">
          <MarkedText text={example.text} emphasis={example.textEmphasis} ruby={example.ruby} />
        </p>
      )}
      {example.romanization === null ? null : (
        <p lang={`${language}-Latn`}>
          <MarkedText
            text={example.romanization}
            emphasis={example.romanizationEmphasis}
            ruby={[]}
          />
        </p>
      )}
      {example.translation === null ? null : (
        <p>
          <MarkedText text={example.translation} emphasis={example.translationEmphasis} ruby={[]} />
        </p>
      )}
      {example.reference === null ? null : (
        <p className="epub-navigator-reader__dictionary-reference">{example.reference}</p>
      )}
    </li>
  );
}

function PronunciationItem({
  context,
  pronunciation,
}: {
  readonly context: EntryContext;
  readonly pronunciation: NavigatorDictionaryPronunciation;
}) {
  const { entry, props } = context;
  const text =
    pronunciation.ipa ??
    pronunciation.enpr ??
    pronunciation.zhPronunciation ??
    pronunciation.romanization ??
    pronunciation.hangeul ??
    pronunciation.text ??
    pronunciation.other;
  return (
    <li>
      {playableAudio(pronunciation) === null ? null : (
        <PlayButton pronunciation={pronunciation} props={props} />
      )}
      {text === null ? null : <span className="font-mono">{text}</span>}
      <Labels
        values={[
          pronunciation.form,
          pronunciation.sense,
          ...pronunciation.rawTags,
          ...pronunciation.tags,
          pronunciation.note,
        ]}
      />
      {pronunciation.rhymes === null ? null : (
        <span className="text-muted-foreground" lang="en">
          {" "}
          Rhymes: <span className="font-mono">{pronunciation.rhymes}</span>
        </span>
      )}
      {pronunciation.homophones.length > 0 || pronunciation.homophone !== null ? (
        <span className="text-muted-foreground">
          {" "}
          <span lang="en">Homophones: </span>
          {[pronunciation.homophone, ...pronunciation.homophones]
            .filter((value): value is string => value !== null)
            .map((value, index) => (
              <Term key={index} text={value} language={entry.languageCode} props={props} />
            ))}
        </span>
      ) : null}
    </li>
  );
}

function PlayButton({
  pronunciation,
  props,
}: {
  readonly pronunciation: NavigatorDictionaryPronunciation;
  readonly props: DictionaryContentProps;
}) {
  const audio = playableAudio(pronunciation);
  if (audio === null) return null;
  const playback = props.snapshot.playback;
  const active = playback?.handle === audio.handle;
  const playing = active && playback.state !== "failed";
  const label = [...pronunciation.rawTags, ...pronunciation.tags].join(", ");
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-rhea-local-action="compact"
      className="epub-navigator-reader__dictionary-play"
      aria-label={label.length > 0 ? `Play pronunciation (${label})` : "Play pronunciation"}
      aria-pressed={playing}
      data-state={active ? playback.state : undefined}
      onClick={(event) => {
        if (!event.isTrusted) return;
        if (playing) props.onStop();
        else props.onPlay(audio.handle);
      }}
    >
      {active && playback.state === "loading" ? (
        <CircleDashed aria-hidden="true" />
      ) : playing ? (
        <Pause aria-hidden="true" />
      ) : (
        <Volume2 aria-hidden="true" />
      )}
    </Button>
  );
}

/** Audio a play button can start, whether it ships in a pack or streams from Commons. */
function playableAudio(pronunciation: NavigatorDictionaryPronunciation) {
  const audio = pronunciation.audio;
  return audio?.status === "available" || audio?.status === "remote" ? audio : null;
}

function LemmaLines({
  context,
  formOf,
  altOf,
  compoundOf,
}: {
  readonly context: EntryContext;
  readonly formOf: readonly NavigatorDictionaryLemmaReference[];
  readonly altOf: readonly NavigatorDictionaryLemmaReference[];
  readonly compoundOf: readonly NavigatorDictionaryLemmaReference[];
}) {
  const lines = [
    ["Form of", formOf],
    ["Alternative of", altOf],
    ["Compound of", compoundOf],
  ] as const;
  return lines.map(([label, references]) =>
    references.length === 0 ? null : (
      <p key={label} className="epub-navigator-reader__dictionary-lemma">
        <span lang="en">{label} </span>
        {references.map((reference, index) => (
          <Term
            key={index}
            text={reference.word}
            language={context.entry.languageCode}
            props={context.props}
          />
        ))}
      </p>
    ),
  );
}

function TranslationTerms({
  context,
  translations,
  grouped = false,
}: {
  readonly context: EntryContext;
  readonly translations: readonly NavigatorDictionaryTranslation[];
  readonly grouped?: boolean | undefined;
}) {
  const words = translations.filter(
    (translation): translation is NavigatorDictionaryTranslation & { word: string } =>
      translation.word !== null,
  );
  if (!grouped) {
    return (
      <p className="epub-navigator-reader__dictionary-terms">
        {words.map((translation, index) => (
          <TranslationTerm key={index} context={context} translation={translation} />
        ))}
      </p>
    );
  }
  const groups = new Map<string, (NavigatorDictionaryTranslation & { word: string })[]>();
  for (const translation of words) {
    const key = translation.languageName ?? translation.languageCode ?? "";
    groups.set(key, [...(groups.get(key) ?? []), translation]);
  }
  return (
    <dl className="epub-navigator-reader__dictionary-groups">
      {[...groups].map(([language, values]) => (
        <div key={language}>
          <dt>{language}</dt>
          <dd>
            {values.map((translation, index) => (
              <TranslationTerm key={index} context={context} translation={translation} />
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TranslationTerm({
  context,
  translation,
}: {
  readonly context: EntryContext;
  readonly translation: NavigatorDictionaryTranslation & { word: string };
}) {
  return (
    <span className="epub-navigator-reader__dictionary-term-group">
      <Term text={translation.word} language={translation.languageCode} props={context.props} />
      <Labels
        values={[
          translation.romanization,
          translation.sense,
          ...translation.rawTags,
          ...translation.tags,
          translation.note,
        ]}
      />
    </span>
  );
}

function RelationGroups({
  context,
  groups,
  sense,
}: {
  readonly context: EntryContext;
  readonly groups: readonly NavigatorDictionaryRelationGroup[];
  readonly sense: number | null;
}) {
  const { entry, props } = context;
  return (
    <dl className="epub-navigator-reader__dictionary-groups">
      {groups.map((group) => (
        <div key={group.kind}>
          <dt lang="en">{relationLabel(group.kind)}</dt>
          <dd>
            {group.relations.items.map((relation, index) =>
              relation.word === null ? null : (
                <span key={index} className="epub-navigator-reader__dictionary-term-group">
                  <Term
                    text={relation.word}
                    language={relation.languageCode ?? entry.languageCode}
                    props={props}
                  />
                  <Labels
                    values={[
                      relation.qualifier,
                      relation.sense,
                      ...relation.rawTags,
                      ...relation.tags,
                      relation.translation,
                    ]}
                  />
                </span>
              ),
            )}
            <MoreButton
              context={context}
              window={group.relations}
              section={
                sense === null
                  ? { type: "relations", kind: group.kind }
                  : { type: "sense-relations", sense, kind: group.kind }
              }
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EntrySection({
  title,
  count,
  plain = false,
  children,
}: {
  readonly title: string;
  readonly count: number | null;
  readonly plain?: boolean | undefined;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible.Root className="epub-navigator-reader__dictionary-section">
      <Collapsible.Trigger className="epub-navigator-reader__dictionary-section-trigger group/dictionary-section">
        <ChevronRight
          className="size-4 shrink-0 group-data-panel-open/dictionary-section:rotate-90"
          aria-hidden="true"
        />
        <span lang="en">{title}</span>
        {count === null ? null : <span className="text-muted-foreground">{count}</span>}
      </Collapsible.Trigger>
      <Collapsible.Panel
        className="epub-navigator-reader__dictionary-section-panel"
        data-dictionary-plain={plain || undefined}
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function MoreButton({
  context,
  window,
  section,
  noun,
}: {
  readonly context: EntryContext;
  readonly window: NavigatorDictionaryBounded<unknown>;
  readonly section: NavigatorDictionarySectionRef;
  readonly noun?: string | undefined;
}) {
  const remaining = window.total - window.offset - window.items.length;
  const detail = context.result.details[context.entry.handle];
  if (remaining <= 0 || detail?.state !== "loaded") return null;
  const state =
    context.result.sections[navigatorDictionarySectionKey(context.entry.handle, section)];
  return (
    <span className="epub-navigator-reader__dictionary-more" lang="en">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-rhea-local-action="compact"
        disabled={state?.state === "loading"}
        aria-busy={state?.state === "loading"}
        onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          if (event.isTrusted) context.props.onLoadSection(context.entry.handle, section);
        }}
      >
        {state?.state === "failed"
          ? "Try again"
          : `Show ${remaining} more${noun === undefined ? "" : ` ${noun}`}`}
      </Button>
      {state?.state === "failed" && state.message !== null ? (
        <span role="alert">{state.message}</span>
      ) : null}
    </span>
  );
}

function Term({
  text,
  language,
  props,
}: {
  readonly text: string;
  readonly language: string | null;
  readonly props: DictionaryContentProps;
}) {
  return (
    <button
      type="button"
      className="epub-navigator-reader__dictionary-term"
      lang={language ?? undefined}
      onClick={(event) => {
        if (!event.isTrusted) return;
        event.stopPropagation();
        props.onLookup(text, language);
      }}
    >
      {text}
    </button>
  );
}

function Labels({ values }: { readonly values: readonly (string | null)[] }) {
  const seen = new Set<string>();
  const labels = values.filter((value): value is string => {
    if (value === null || value.length === 0) return false;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (labels.length === 0) return null;
  return (
    <span className="epub-navigator-reader__dictionary-labels">
      {labels.map((label) => (
        <span key={label} className="epub-navigator-reader__dictionary-label">
          {label}
        </span>
      ))}
    </span>
  );
}

function MarkedText({
  text,
  emphasis,
  ruby,
}: {
  readonly text: string;
  readonly emphasis: readonly NavigatorDictionaryEmphasisRange[];
  readonly ruby: readonly NavigatorDictionaryRuby[];
}) {
  if (ruby.length > 0) return <>{rubyText(text, ruby)}</>;
  const scalars = Array.from(text);
  const ranges = [...emphasis]
    .filter((range) => range.start < range.end && range.end <= scalars.length)
    .sort((left, right) => left.start - right.start);
  const parts: ReactNode[] = [];
  let position = 0;
  for (const range of ranges) {
    if (range.start < position) continue;
    parts.push(scalars.slice(position, range.start).join(""));
    parts.push(<mark key={range.start}>{scalars.slice(range.start, range.end).join("")}</mark>);
    position = range.end;
  }
  parts.push(scalars.slice(position).join(""));
  return <>{parts}</>;
}

function rubyText(text: string, ruby: readonly NavigatorDictionaryRuby[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let position = 0;
  for (const [index, pair] of ruby.entries()) {
    const found = pair.base.length === 0 ? -1 : text.indexOf(pair.base, position);
    if (found < 0) continue;
    parts.push(text.slice(position, found));
    parts.push(
      <ruby key={index}>
        {pair.base}
        <rt>{pair.text}</rt>
      </ruby>,
    );
    position = found + pair.base.length;
  }
  parts.push(text.slice(position));
  return parts;
}
