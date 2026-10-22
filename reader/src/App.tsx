import type { PublicationTypeface } from "epub-navigator";
import type { BrowserLocalHost, LocalPublicationRecord } from "epub-navigator/local";
import {
  NavigatorReader,
  type NavigatorAnnotationAcknowledgment,
  type NavigatorAnnotationMutationRequest,
  type NavigatorReaderHandle,
  type NavigatorReaderPreferences,
  type NavigatorReadingPosition,
  type NavigatorReaderWorkspaceState,
  type ReaderStore,
} from "epub-navigator/react";
import type {
  NavigatorLocationSnapshot,
  NavigatorDiagnosticEvent,
  NavigatorDiagnostics,
} from "epub-navigator/runtime";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import "epub-navigator/react.css";
import {
  defaultWorkspaceState,
  readerPreferencesAtom,
  readerWorkspaceStatesAtom,
} from "./preferences.js";
import { createIndexedDbAnnotationRepository, type AnnotationRepository } from "./annotations.js";
import {
  annotationProjectionFamily,
  annotationRepositoryAtom,
  localHostAtom,
  annotationsFamily,
  paginationCapabilitiesFamily,
  readingPositionFamily,
  releasePublicationState,
  searchCapabilitiesFamily,
} from "./publication-state.js";

interface AppProps {
  readonly localHost: BrowserLocalHost;
  readonly readerStore: ReaderStore;
}

interface DevelopmentDiagnosticEntry {
  readonly at: number;
  readonly event: NavigatorDiagnosticEvent;
}

const developmentDiagnostics: NavigatorDiagnostics | undefined = import.meta.env.DEV
  ? {
      level: "trace",
      record(event) {
        const scope = window as typeof window & {
          __EPUB_NAVIGATOR_DIAGNOSTICS__?: DevelopmentDiagnosticEntry[] | undefined;
        };
        const entries = (scope.__EPUB_NAVIGATOR_DIAGNOSTICS__ ??= []);
        entries.push({ at: performance.now(), event });
        if (entries.length > 2_000) entries.splice(0, entries.length - 2_000);
      },
    }
  : undefined;

type AppState =
  | { readonly status: "loading" }
  | { readonly status: "importing"; readonly progress: string }
  | {
      readonly status: "library";
      readonly publications: readonly LocalPublicationRecord[];
      readonly message?: string | undefined;
    }
  | {
      readonly status: "reading";
      readonly publication: LocalPublicationRecord;
      readonly publications: readonly LocalPublicationRecord[];
    };

function App({ localHost, readerStore }: AppProps) {
  const [preferences, setPreferences] = useAtom(readerPreferencesAtom);
  const [workspaceStates, setWorkspaceStates] = useAtom(readerWorkspaceStatesAtom);
  const [state, setState] = useState<AppState>({ status: "loading" });
  const activeImport = useRef<AbortController | null>(null);
  const operation = useRef(0);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        await localHost.ready;
        const publications = await localHost.listPublications();
        const lastId = readLastPublicationId();
        const last =
          lastId === undefined ? undefined : publications.find((item) => item.id === lastId);
        if (current) {
          setState(
            last === undefined
              ? {
                  status: "library",
                  publications,
                  message:
                    lastId === undefined
                      ? undefined
                      : "The last publication is no longer available.",
                }
              : { status: "reading", publication: last, publications },
          );
        }
      } catch (cause) {
        if (current)
          setState({ status: "library", publications: [], message: errorMessage(cause) });
      }
    })();
    return () => {
      current = false;
    };
  }, [localHost]);

  if (state.status === "reading") {
    return (
      <LocalPublicationReader
        readerStore={readerStore}
        publication={state.publication}
        readerTypefaces={localHost.readerTypefaces}
        preferences={preferences}
        onPreferencesChange={setPreferences}
        workspaceState={workspaceStates[state.publication.id] ?? defaultWorkspaceState}
        onWorkspaceStateChange={(workspaceState) =>
          setWorkspaceStates((current) => ({
            ...current,
            [state.publication.id]: workspaceState,
          }))
        }
        localHost={localHost}
        repository={readerAnnotationRepository()}
        onLibraryRequest={() => {
          setWorkspaceStates((current) => {
            const workspace = current[state.publication.id];
            if (
              workspace === undefined ||
              !workspace.navigation.open ||
              workspace.navigation.pinned
            ) {
              return current;
            }
            return {
              ...current,
              [state.publication.id]: {
                ...workspace,
                navigation: { ...workspace.navigation, open: false },
              },
            };
          });
          setState({ status: "library", publications: state.publications });
        }}
      />
    );
  }

  if (state.status === "loading") {
    return <StatusPanel message="Opening local publications..." />;
  }

  if (state.status === "importing") {
    return <StatusPanel message={state.progress} onCancel={() => activeImport.current?.abort()} />;
  }

  const importPublication = async (file: File): Promise<void> => {
    const currentOperation = ++operation.current;
    const controller = new AbortController();
    activeImport.current = controller;
    setState({ status: "importing", progress: "Reading EPUB..." });
    try {
      const publication = await localHost.importPublication(file, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (currentOperation !== operation.current) return;
          setState({
            status: "importing",
            progress:
              progress.total === 0
                ? "Saving publication..."
                : `${progress.phase === "committing" ? "Saving" : "Reading"} ${progress.completed}/${progress.total}`,
          });
        },
      });
      if (currentOperation !== operation.current) return;
      writeLastPublicationId(publication.id);
      setState({
        status: "reading",
        publication,
        publications: upsertPublication(state.publications, publication),
      });
    } catch (cause) {
      if (currentOperation !== operation.current) return;
      const publications = await localHost.listPublications().catch(() => []);
      setState({ status: "library", publications, message: errorMessage(cause) });
    } finally {
      if (activeImport.current === controller) activeImport.current = null;
    }
  };

  const openPublication = async (id: string): Promise<void> => {
    const currentOperation = ++operation.current;
    try {
      const publication = await localHost.openPublication(id);
      if (currentOperation !== operation.current) return;
      writeLastPublicationId(publication.id);
      setState({ status: "reading", publication, publications: state.publications });
    } catch (cause) {
      if (currentOperation !== operation.current) return;
      setState({
        status: "library",
        publications: state.publications,
        message: errorMessage(cause),
      });
    }
  };

  const removePublication = async (id: string): Promise<void> => {
    const currentOperation = ++operation.current;
    try {
      await localHost.removePublication(id);
      let cleanupMessage: string | undefined;
      try {
        await readerAnnotationRepository()?.removePublication(id);
      } catch {
        cleanupMessage = "The publication was removed, but its reader state could not be cleared.";
      }
      setWorkspaceStates((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([publicationId]) => publicationId !== id),
        ),
      );
      releasePublicationState(id);
      if (currentOperation !== operation.current) return;
      const publications = await localHost.listPublications();
      if (readLastPublicationId() === id) writeLastPublicationId(undefined);
      setState({ status: "library", publications, message: cleanupMessage });
    } catch (cause) {
      if (currentOperation !== operation.current) return;
      const publications = await localHost.listPublications().catch(() => state.publications);
      setState({
        status: "library",
        publications,
        message: errorMessage(cause),
      });
    }
  };

  return (
    <main className="epub-navigator-theme min-h-full bg-background p-6 text-foreground">
      <section
        className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-2xl flex-col justify-center"
        aria-labelledby="reader-heading"
      >
        <h1 className="text-2xl font-semibold" id="reader-heading">
          Local publications
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Import an EPUB to keep a browser-local copy for the next visit.
        </p>
        <p
          className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          role="note"
        >
          Unsafe demo mode: publisher scripts share this origin and may access reader data. Import
          only trusted EPUBs.
        </p>
        <label className="mt-6 inline-flex w-fit cursor-pointer rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
          Import EPUB
          <input
            className="sr-only"
            type="file"
            accept=".epub,application/epub+zip"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file !== undefined) void importPublication(file);
            }}
          />
        </label>
        {state.message !== undefined && (
          <p
            className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
            role="alert"
          >
            {state.message}
          </p>
        )}
        {state.publications.length > 0 ? (
          <ul className="mt-8 divide-y divide-border rounded-md border border-border">
            {state.publications.map((publication) => (
              <li className="flex items-center justify-between gap-4 p-4" key={publication.id}>
                <button
                  className="min-w-0 text-left"
                  onClick={() => void openPublication(publication.id)}
                >
                  <span className="block truncate text-sm font-medium">
                    {publicationTitle(publication)}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {publication.id.slice(0, 12)}
                  </span>
                </button>
                <button
                  className="shrink-0 text-sm text-muted-foreground"
                  aria-label={`Remove ${publicationTitle(publication)}`}
                  onClick={() => void removePublication(publication.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-8 text-sm text-muted-foreground">No imported publications yet.</p>
        )}
      </section>
    </main>
  );
}

export function LocalPublicationReader({
  localHost,
  readerStore,
  publication,
  readerTypefaces,
  preferences,
  onPreferencesChange,
  workspaceState,
  onWorkspaceStateChange,
  repository,
  onLibraryRequest,
}: {
  readonly localHost: BrowserLocalHost;
  readonly readerStore: ReaderStore;
  readonly publication: LocalPublicationRecord;
  readonly readerTypefaces: readonly PublicationTypeface[];
  readonly preferences: NavigatorReaderPreferences;
  readonly onPreferencesChange: (preferences: NavigatorReaderPreferences) => void;
  readonly workspaceState: NavigatorReaderWorkspaceState;
  readonly onWorkspaceStateChange: (state: NavigatorReaderWorkspaceState) => void;
  readonly repository: AnnotationRepository | null;
  readonly onLibraryRequest: () => void;
}) {
  const store = useStore();
  useLayoutEffect(() => {
    store.set(localHostAtom, localHost);
    store.set(annotationRepositoryAtom, repository);
  }, [localHost, repository, store]);
  const reader = useRef<NavigatorReaderHandle | null>(null);
  const [sessionState, setSessionState] = useState(() => ({
    facts: publication.facts,
    mount: publication.mount,
    id: crypto.randomUUID(),
  }));
  if (sessionState.facts !== publication.facts || sessionState.mount !== publication.mount) {
    setSessionState({
      facts: publication.facts,
      mount: publication.mount,
      id: crypto.randomUUID(),
    });
  }
  const session = {
    id: sessionState.id,
    publication: { facts: sessionState.facts, mount: sessionState.mount },
  };
  const persistenceOwner = useRef<{
    readonly generation: number;
    readonly controller: AbortController;
    timer: ReturnType<typeof setTimeout> | null;
    capture: AbortController | null;
  } | null>(null);
  const persistenceGeneration = useRef(0);
  useEffect(() => {
    const owner: NonNullable<typeof persistenceOwner.current> = {
      generation: ++persistenceGeneration.current,
      controller: new AbortController(),
      timer: null,
      capture: null,
    };
    persistenceOwner.current = owner;
    return () => {
      if (owner.timer !== null) clearTimeout(owner.timer);
      owner.capture?.abort();
      owner.controller.abort();
      if (persistenceOwner.current === owner) persistenceOwner.current = null;
    };
  }, [publication.id]);
  const currentPagination = useAtomValue(paginationCapabilitiesFamily(publication.id));
  const currentSearch = useAtomValue(searchCapabilitiesFamily(publication.id));
  const currentAnnotations = useAtomValue(annotationsFamily(publication.id));
  const currentReadingPosition = useAtomValue(readingPositionFamily(publication.id));
  const setAnnotationProjection = useSetAtom(annotationProjectionFamily(publication.id));
  const mutateAnnotation = async (
    request: NavigatorAnnotationMutationRequest,
    context: { readonly signal: AbortSignal },
  ): Promise<NavigatorAnnotationAcknowledgment> => {
    if (repository === null) {
      return {
        status: "rejected",
        requestId: request.requestId,
        reason: "Browser annotation storage is unavailable.",
      };
    }
    const result = await repository.mutate(publication.id, request, context.signal);
    if (result.status === "conflict") {
      setAnnotationProjection({ status: "available", value: result.projection });
      return {
        status: "rejected",
        requestId: request.requestId,
        reason: "The annotation collection changed. Try again.",
      };
    }
    setAnnotationProjection({ status: "available", value: result.projection });
    return {
      status: "accepted",
      requestId: request.requestId,
      recordId: result.recordId,
      projectionRevision: result.revision,
    };
  };
  const captureAndSaveReadingPosition = async (reportFailure = false): Promise<void> => {
    const owner = persistenceOwner.current;
    const handle = reader.current;
    if (
      owner === null ||
      handle === null ||
      repository === null ||
      owner.controller.signal.aborted
    ) {
      return;
    }
    owner.capture?.abort();
    const controller = new AbortController();
    owner.capture = controller;
    const abort = () => controller.abort(owner.controller.signal.reason);
    owner.controller.signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await handle.captureReadingPosition({ signal: controller.signal });
      if (
        result.status !== "generated" ||
        controller.signal.aborted ||
        persistenceOwner.current !== owner ||
        owner.generation !== persistenceGeneration.current
      ) {
        if (reportFailure && !controller.signal.aborted && result.status !== "generated") {
          console.warn("Reading position capture failed", result);
        }
        return;
      }
      const position: NavigatorReadingPosition = {
        targetJson: result.targetJson,
        occurrenceHint: result.occurrenceHint,
      };
      await repository.saveReadingPosition(publication.id, position, controller.signal);
    } catch (cause) {
      // A failed or cancelled capture must not replace the last durable position.
      if (reportFailure && !controller.signal.aborted) {
        console.warn("Reading position persistence failed", cause);
      }
    } finally {
      owner.controller.signal.removeEventListener("abort", abort);
      if (owner.capture === controller) owner.capture = null;
    }
  };
  const locationChanged = (snapshot: NavigatorLocationSnapshot): void => {
    const owner = persistenceOwner.current;
    if (owner === null || owner.controller.signal.aborted) return;
    if (owner.timer !== null) clearTimeout(owner.timer);
    owner.timer = null;
    if (snapshot.location?.kind !== "point" || snapshot.basis === null) return;
    owner.timer = setTimeout(() => {
      owner.timer = null;
      void captureAndSaveReadingPosition();
    }, 500);
  };
  const requestLibrary = async (): Promise<void> => {
    const owner = persistenceOwner.current;
    if (owner !== null && owner.timer !== null) {
      clearTimeout(owner.timer);
      owner.timer = null;
    }
    await captureAndSaveReadingPosition(true);
    onLibraryRequest();
  };
  if (currentReadingPosition.status === "pending") {
    return <StatusPanel message="Restoring reading position..." />;
  }
  return (
    <NavigatorReader
      ref={reader}
      store={readerStore}
      session={session}
      initialReadingPosition={
        currentReadingPosition.status === "available" ? currentReadingPosition.value : null
      }
      onInitialRestoration={(result) => {
        if (result.status !== "restored") {
          console.warn("Initial reading position restoration failed", result);
        }
      }}
      onLocationChange={locationChanged}
      pagination={currentPagination.status === "available" ? currentPagination.value : undefined}
      paginationAvailability={
        currentPagination.status === "pending"
          ? "pending"
          : currentPagination.status === "unavailable"
            ? "unavailable"
            : undefined
      }
      diagnostics={developmentDiagnostics}
      search={currentSearch.status === "available" ? currentSearch.value : undefined}
      readerTypefaces={readerTypefaces}
      preferences={preferences}
      onPreferencesChange={onPreferencesChange}
      workspaceState={workspaceState}
      onWorkspaceStateChange={onWorkspaceStateChange}
      onLibraryRequest={() => void requestLibrary()}
      annotations={currentAnnotations.status === "available" ? currentAnnotations.value : undefined}
      annotationAvailability={
        currentAnnotations.status === "available" ? undefined : currentAnnotations.status
      }
      onAnnotationMutation={
        currentAnnotations.status === "available" ? mutateAnnotation : undefined
      }
    />
  );
}

let annotationsRepository: AnnotationRepository | null | undefined;

function readerAnnotationRepository(): AnnotationRepository | null {
  if (annotationsRepository !== undefined) return annotationsRepository;
  annotationsRepository =
    typeof indexedDB === "undefined" ? null : createIndexedDbAnnotationRepository();
  return annotationsRepository;
}

function StatusPanel({
  message,
  onCancel,
}: {
  readonly message: string;
  readonly onCancel?: (() => void) | undefined;
}) {
  return (
    <main className="epub-navigator-theme grid min-h-full place-items-center bg-background p-6 text-foreground">
      <p role="status" className="text-sm text-muted-foreground">
        {message}
      </p>
      {onCancel !== undefined && (
        <button
          className="mt-3 rounded-md border border-border px-3 py-2 text-sm"
          onClick={onCancel}
        >
          Cancel
        </button>
      )}
    </main>
  );
}

function upsertPublication(
  publications: readonly LocalPublicationRecord[],
  next: LocalPublicationRecord,
): readonly LocalPublicationRecord[] {
  return [next, ...publications.filter((publication) => publication.id !== next.id)];
}

function publicationTitle(publication: LocalPublicationRecord): string {
  const title = publication.facts.package.metadata.title[0]?.content;
  return title !== null && title !== undefined && title.length > 0 ? title : publication.id;
}

function readLastPublicationId(): string | undefined {
  try {
    const value = localStorage.getItem("epub-navigator.last-publication");
    return value === null || value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function writeLastPublicationId(id: string | undefined): void {
  try {
    if (id === undefined) localStorage.removeItem("epub-navigator.last-publication");
    else localStorage.setItem("epub-navigator.last-publication", id);
  } catch {
    // Recent-publication selection is best effort.
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "The local publication could not be opened.";
}

export default App;
