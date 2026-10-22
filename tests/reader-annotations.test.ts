import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  annotationDatabaseName,
  annotationDatabaseVersion,
  createIndexedDbAnnotationRepository,
} from "../reader/src/annotations.js";

const publicationId = "publication-1";
const targetJson = '{"selector":"opaque"}';

describe("reader annotation repository", () => {
  it("loads an empty projection and creates highlights and notes", async () => {
    const { factory, repository } = setup("highlight-1", "note-1");

    await expect(repository.load(publicationId)).resolves.toEqual({ revision: 0, records: [] });
    await expect(
      repository.mutate(publicationId, {
        type: "create-highlight",
        requestId: "request-1",
        basedOnRevision: 0,
        selectionRevision: 7,
        occurrence: 2,
        targetJson,
        excerpt: " exact excerpt ",
        sectionLabel: null,
      }),
    ).resolves.toMatchObject({ status: "committed", revision: 1, recordId: "highlight-1" });

    const note = await repository.mutate(publicationId, {
      type: "create-note",
      requestId: "request-2",
      basedOnRevision: 1,
      selectionRevision: 8,
      occurrence: 3,
      targetJson: " note target ",
      excerpt: null,
      sectionLabel: " Chapter 1 ",
      text: "  note text  ",
    });
    expect(note).toMatchObject({ status: "committed", revision: 2, recordId: "note-1" });
    expect(note.projection.records).toEqual([
      {
        type: "highlight",
        id: "highlight-1",
        targetJson,
        occurrence: 2,
        excerpt: " exact excerpt ",
        sectionLabel: null,
      },
      {
        type: "note",
        id: "note-1",
        targetJson: " note target ",
        occurrence: 3,
        excerpt: null,
        sectionLabel: " Chapter 1 ",
        text: "  note text  ",
      },
    ]);
    await expect(factory.databases()).resolves.toEqual([
      { name: annotationDatabaseName, version: annotationDatabaseVersion },
    ]);
  });

  it("updates only notes and deletes either type while retaining an empty revision", async () => {
    const { factory, repository } = setup("highlight-1", "note-1");
    await createHighlight(repository);
    await createNote(repository, 1);

    await expect(
      repository.mutate(publicationId, {
        type: "update-note",
        requestId: "request-3",
        basedOnRevision: 2,
        recordId: "note-1",
        text: " updated exactly ",
      }),
    ).resolves.toMatchObject({
      status: "committed",
      revision: 3,
      projection: { records: [{ type: "highlight" }, { type: "note", text: " updated exactly " }] },
    });
    await expect(
      repository.mutate(publicationId, {
        type: "update-note",
        requestId: "request-invalid",
        basedOnRevision: 3,
        recordId: "highlight-1",
        text: "not allowed",
      }),
    ).rejects.toThrow("annotation record is not a note");
    await deleteRecord(repository, "highlight-1", 3);
    await deleteRecord(repository, "note-1", 4);

    await expect(repository.load(publicationId)).resolves.toEqual({ revision: 5, records: [] });
    await expect(stored(factory, "annotation-projections")).resolves.toEqual({
      publicationId,
      revision: 5,
      records: [],
    });
  });

  it("atomically retargets either record type while preserving all other fields", async () => {
    const { repository } = setup("highlight-1", "note-1");
    await createHighlight(repository);
    await createNote(repository, 1);

    const result = await repository.mutate(publicationId, {
      type: "retarget-annotation",
      requestId: "retarget-1",
      basedOnRevision: 2,
      recordId: "note-1",
      targetJson: "adjusted target",
      excerpt: "adjusted excerpt",
    });

    expect(result).toMatchObject({ status: "committed", revision: 3, recordId: "note-1" });
    expect(result.projection.records[1]).toEqual({
      type: "note",
      id: "note-1",
      targetJson: "adjusted target",
      occurrence: 0,
      excerpt: "adjusted excerpt",
      sectionLabel: null,
      text: "note",
    });
    await expect(
      repository.mutate(publicationId, {
        type: "retarget-annotation",
        requestId: "retarget-stale",
        basedOnRevision: 2,
        recordId: "note-1",
        targetJson: "must not commit",
        excerpt: "must not commit",
      }),
    ).resolves.toMatchObject({ status: "conflict", revision: 3 });
  });

  it("atomically converts a highlight to a note without changing its identity or target", async () => {
    const { factory, repository, randomUUID } = setup("highlight-1");
    await repository.mutate(publicationId, {
      type: "create-highlight",
      requestId: "create-highlight",
      basedOnRevision: 0,
      selectionRevision: 4,
      occurrence: 7,
      targetJson: " preserved target ",
      excerpt: " preserved excerpt ",
      sectionLabel: " preserved section ",
    });

    const result = await repository.mutate(publicationId, {
      type: "convert-highlight-to-note",
      requestId: "convert-highlight",
      basedOnRevision: 1,
      recordId: "highlight-1",
      text: "  new note  ",
    });

    expect(result).toEqual({
      status: "committed",
      requestId: "convert-highlight",
      basedOnRevision: 1,
      revision: 2,
      recordId: "highlight-1",
      projection: {
        revision: 2,
        records: [
          {
            type: "note",
            id: "highlight-1",
            targetJson: " preserved target ",
            occurrence: 7,
            excerpt: " preserved excerpt ",
            sectionLabel: " preserved section ",
            text: "  new note  ",
          },
        ],
      },
    });
    expect(randomUUID).toHaveBeenCalledOnce();
    await expect(stored(factory, "annotation-projections")).resolves.toEqual({
      publicationId,
      ...result.projection,
    });
  });

  it("rejects conversion of notes and conflicts on stale conversion revisions", async () => {
    const { repository } = setup("note-1");
    await createNote(repository, 0);

    await expect(
      repository.mutate(publicationId, {
        type: "convert-highlight-to-note",
        requestId: "convert-note",
        basedOnRevision: 1,
        recordId: "note-1",
        text: "replacement",
      }),
    ).rejects.toThrow("annotation record is not a highlight");
    await expect(
      repository.mutate(publicationId, {
        type: "convert-highlight-to-note",
        requestId: "convert-missing",
        basedOnRevision: 1,
        recordId: "missing",
        text: "replacement",
      }),
    ).rejects.toThrow("annotation record does not exist");
    await expect(
      repository.mutate(publicationId, {
        type: "convert-highlight-to-note",
        requestId: "stale-conversion",
        basedOnRevision: 0,
        recordId: "note-1",
        text: "replacement",
      }),
    ).resolves.toMatchObject({
      status: "conflict",
      requestId: "stale-conversion",
      revision: 1,
      projection: { revision: 1, records: [{ type: "note", id: "note-1", text: "note" }] },
    });
    await expect(repository.load(publicationId)).resolves.toMatchObject({
      revision: 1,
      records: [{ type: "note", id: "note-1", text: "note" }],
    });
  });

  it("returns conflicts without mutation or ID allocation", async () => {
    const { repository, randomUUID } = setup("highlight-1");
    await createHighlight(repository);

    await expect(
      repository.mutate(publicationId, {
        type: "create-note",
        requestId: "stale-request",
        basedOnRevision: 0,
        selectionRevision: 2,
        occurrence: 0,
        targetJson,
        excerpt: null,
        sectionLabel: null,
        text: "note",
      }),
    ).resolves.toMatchObject({
      status: "conflict",
      requestId: "stale-request",
      revision: 1,
      projection: { revision: 1, records: [{ id: "highlight-1" }] },
    });
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("creates, loads, conflicts, and deletes controlled bookmarks", async () => {
    const { repository, randomUUID } = setup("bookmark-1");
    const created = await repository.mutate(publicationId, {
      type: "create-bookmark",
      requestId: "bookmark-create",
      basedOnRevision: 0,
      locationRevision: 9,
      occurrence: 3,
      targetJson: " exact bookmark target ",
      sectionLabel: " Chapter 4 ",
      label: " My place ",
    });

    expect(created).toMatchObject({ status: "committed", revision: 1, recordId: "bookmark-1" });
    await expect(repository.load(publicationId)).resolves.toEqual({
      revision: 1,
      records: [
        {
          type: "bookmark",
          id: "bookmark-1",
          targetJson: " exact bookmark target ",
          occurrence: 3,
          sectionLabel: " Chapter 4 ",
          label: " My place ",
        },
      ],
    });
    await expect(
      repository.mutate(publicationId, {
        type: "create-bookmark",
        requestId: "bookmark-stale",
        basedOnRevision: 0,
        locationRevision: 10,
        occurrence: 0,
        targetJson,
        sectionLabel: null,
        label: null,
      }),
    ).resolves.toMatchObject({ status: "conflict", revision: 1 });
    expect(randomUUID).toHaveBeenCalledOnce();
    await expect(deleteRecord(repository, "bookmark-1", 1)).resolves.toMatchObject({
      status: "committed",
      revision: 2,
      projection: { records: [] },
    });
  });

  it("rejects bookmark note, conversion, and retarget operations", async () => {
    const { repository } = setup("bookmark-1");
    await repository.mutate(publicationId, {
      type: "create-bookmark",
      requestId: "bookmark-create",
      basedOnRevision: 0,
      locationRevision: 1,
      occurrence: 0,
      targetJson,
      sectionLabel: null,
      label: null,
    });

    await expect(
      repository.mutate(publicationId, {
        type: "update-note",
        requestId: "bookmark-note",
        basedOnRevision: 1,
        recordId: "bookmark-1",
        text: "note",
      }),
    ).rejects.toThrow("annotation record is not a note");
    await expect(
      repository.mutate(publicationId, {
        type: "convert-highlight-to-note",
        requestId: "bookmark-convert",
        basedOnRevision: 1,
        recordId: "bookmark-1",
        text: "note",
      }),
    ).rejects.toThrow("annotation record is not a highlight");
    await expect(
      repository.mutate(publicationId, {
        type: "retarget-annotation",
        requestId: "bookmark-retarget",
        basedOnRevision: 1,
        recordId: "bookmark-1",
        targetJson: "replacement",
        excerpt: "replacement",
      }),
    ).rejects.toThrow("annotation record cannot be retargeted");
  });

  const note = {
    type: "create-note" as const,
    requestId: "request-1",
    basedOnRevision: 0,
    selectionRevision: 0,
    occurrence: 0,
    targetJson,
    excerpt: null,
    sectionLabel: null,
    text: "x",
  };
  const bookmark = {
    type: "create-bookmark" as const,
    requestId: "bookmark-invalid",
    basedOnRevision: 0,
    locationRevision: 0,
    occurrence: 0,
    targetJson,
    sectionLabel: null,
    label: null,
  };
  const conversion = {
    type: "convert-highlight-to-note" as const,
    requestId: "convert-invalid",
    basedOnRevision: 0,
    recordId: "record-1",
    text: "note",
  };
  it.each([
    [{ ...note, text: " \n\t " }, "annotation note text is invalid"],
    [{ ...note, excerpt: "😀".repeat(513) }, "annotation excerpt is invalid"],
    [{ ...note, text: "😀".repeat(4_097) }, "annotation note text is invalid"],
    [{ ...note, targetJson: "é".repeat(524_289) }, "annotation target is invalid"],
    [{ ...note, unexpected: true }, "annotation mutation request is invalid"],
    [{ ...bookmark, occurrence: -1 }, "annotation occurrence is invalid"],
    [{ ...bookmark, basis: {} }, "annotation mutation request is invalid"],
    [{ ...conversion, text: " \n\t " }, "annotation note text is invalid"],
    [{ ...conversion, unexpected: true }, "annotation mutation request is invalid"],
  ])("strictly validates keys, Unicode and UTF-8 limits (%#)", async (request, message) => {
    const { factory, repository } = setup("record-1");
    await expect(repository.mutate(publicationId, request as never)).rejects.toThrow(message);
    await expect(factory.databases()).resolves.toEqual([]);
  });

  it("enforces combined record and aggregate limits", async () => {
    const factory = new IDBFactory();
    const storeProjection = (projection: object) =>
      seed(factory, { "annotation-projections": projection });
    await storeProjection({
      publicationId,
      revision: 500,
      records: Array.from({ length: 500 }, (_, index) => ({
        type: "highlight",
        id: `record-${index}`,
        targetJson: "x",
        occurrence: 0,
        excerpt: null,
        sectionLabel: null,
      })),
    });
    const { repository } = setupWith(factory, "record-new");
    await expect(
      repository.mutate(publicationId, {
        type: "create-highlight",
        requestId: "request-over-limit",
        basedOnRevision: 500,
        selectionRevision: 0,
        occurrence: 0,
        targetJson: "x",
        excerpt: null,
        sectionLabel: null,
      }),
    ).rejects.toThrow("annotation projection has too many records");

    await storeProjection({
      publicationId,
      revision: 1,
      records: [
        {
          type: "bookmark",
          id: "large",
          targetJson: "x".repeat(1_048_576),
          occurrence: 0,
          sectionLabel: null,
          label: null,
        },
      ],
    });
    await expect(
      repository.mutate(publicationId, {
        type: "create-highlight",
        requestId: "request-aggregate",
        basedOnRevision: 1,
        selectionRevision: 0,
        occurrence: 0,
        targetJson: "x",
        excerpt: null,
        sectionLabel: null,
      }),
    ).rejects.toThrow("annotation projection targets are oversized");

    await storeProjection({
      publicationId,
      revision: 1,
      records: ["first", "second"].map((id) => ({
        type: "highlight",
        id,
        targetJson,
        occurrence: 0,
        excerpt: null,
        sectionLabel: null,
      })),
    });
    await expect(repository.load(publicationId)).rejects.toThrow(
      "stored annotation projection is invalid",
    );
  });

  it("observes abort before opening storage", async () => {
    const { factory, repository } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(repository.load(publicationId, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(factory.databases()).resolves.toEqual([]);
  });

  it("saves, loads, and replaces exact durable reading positions", async () => {
    const { repository } = setup();
    await expect(repository.loadReadingPosition(publicationId)).resolves.toBeNull();

    await repository.saveReadingPosition(publicationId, {
      targetJson: '{"target":"first"}',
      occurrenceHint: { occurrence: 2, resource: "EPUB/Text/chapter.xhtml" },
    });
    await expect(repository.loadReadingPosition(publicationId)).resolves.toEqual({
      targetJson: '{"target":"first"}',
      occurrenceHint: { occurrence: 2, resource: "EPUB/Text/chapter.xhtml" },
    });

    await repository.saveReadingPosition(publicationId, {
      targetJson: '{"target":"replacement"}',
      occurrenceHint: null,
    });
    await expect(repository.loadReadingPosition(publicationId)).resolves.toEqual({
      targetJson: '{"target":"replacement"}',
      occurrenceHint: null,
    });
  });

  it("rejects non-position fields, invalid hints, oversized targets, and aborted saves", async () => {
    const { factory, repository } = setup();
    const valid = {
      targetJson,
      occurrenceHint: { occurrence: 0, resource: "EPUB/chapter.xhtml" },
    };

    await expect(
      repository.saveReadingPosition(publicationId, { ...valid, basis: {} } as never),
    ).rejects.toThrow("reading position is invalid");
    await expect(
      repository.saveReadingPosition(publicationId, {
        ...valid,
        occurrenceHint: { occurrence: 0, resource: "EPUB/../chapter.xhtml" },
      }),
    ).rejects.toThrow("reading position occurrence hint is invalid");
    await expect(
      repository.saveReadingPosition(publicationId, {
        ...valid,
        targetJson: "é".repeat(524_289),
      }),
    ).rejects.toThrow("annotation target is invalid");
    const controller = new AbortController();
    controller.abort();
    await expect(
      repository.saveReadingPosition(publicationId, valid, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(factory.databases()).resolves.toEqual([]);
  });

  it("atomically removes current, legacy, and reading-position publication state", async () => {
    const factory = new IDBFactory();
    await seed(factory, {
      "highlight-projections": legacyProjection(),
      "annotation-projections": { publicationId, revision: 2, records: [] },
      "reading-positions": { publicationId, targetJson, occurrenceHint: null },
    });
    const { repository } = setupWith(factory);
    await repository.removePublication(publicationId);
    await expect(stored(factory, "annotation-projections")).resolves.toBeUndefined();
    await expect(stored(factory, "highlight-projections")).resolves.toBeUndefined();
    await expect(stored(factory, "reading-positions")).resolves.toBeUndefined();
  });

  it("lazily migrates a version-1 projection and removes its legacy row atomically", async () => {
    const factory = new IDBFactory();
    await seed(factory, { "highlight-projections": legacyProjection() }, 1);
    const { repository } = setupWith(factory);

    await expect(repository.load(publicationId)).resolves.toEqual({
      revision: 4,
      records: [
        {
          type: "highlight",
          id: "legacy-1",
          targetJson: "legacy target",
          occurrence: 3,
          excerpt: null,
          sectionLabel: null,
        },
      ],
    });
    await expect(stored(factory, "highlight-projections")).resolves.toBeUndefined();
    await expect(stored(factory, "annotation-projections")).resolves.toMatchObject({
      publicationId,
      revision: 4,
    });
    await expect(stored(factory, "reading-positions")).resolves.toBeUndefined();
  });
});

type Repository = ReturnType<typeof createIndexedDbAnnotationRepository>;

function setup(...ids: string[]) {
  return setupWith(new IDBFactory(), ...ids);
}

function setupWith(factory: IDBFactory, ...ids: string[]) {
  let allocated = 0;
  const randomUUID = vi.fn(() => ids[Math.min(allocated++, ids.length - 1)] ?? "unexpected");
  const repository = createIndexedDbAnnotationRepository(factory, randomUUID);
  return { factory, repository, randomUUID };
}

async function createHighlight(repository: Repository): Promise<void> {
  await repository.mutate(publicationId, {
    type: "create-highlight",
    requestId: "create-highlight",
    basedOnRevision: 0,
    selectionRevision: 1,
    occurrence: 0,
    targetJson,
    excerpt: null,
    sectionLabel: null,
  });
}

async function createNote(repository: Repository, revision: number): Promise<void> {
  await repository.mutate(publicationId, {
    type: "create-note",
    requestId: "create-note",
    basedOnRevision: revision,
    selectionRevision: 1,
    occurrence: 0,
    targetJson,
    excerpt: null,
    sectionLabel: null,
    text: "note",
  });
}

async function deleteRecord(repository: Repository, recordId: string, revision: number) {
  return repository.mutate(publicationId, {
    type: "delete-annotation",
    requestId: `delete-${recordId}`,
    basedOnRevision: revision,
    recordId,
  });
}

function legacyProjection() {
  return {
    publicationId,
    revision: 4,
    records: [{ id: "legacy-1", targetJson: "legacy target", occurrence: 3 }],
  };
}

async function seed(
  factory: IDBFactory,
  records: Record<string, object>,
  version = annotationDatabaseVersion,
): Promise<void> {
  const opening = factory.open(annotationDatabaseName, version);
  opening.onupgradeneeded = () => {
    for (const name of Object.keys(records)) {
      opening.result.createObjectStore(name, { keyPath: "publicationId" });
    }
  };
  const database = await request(opening);
  try {
    const transaction = database.transaction(Object.keys(records), "readwrite");
    for (const [name, record] of Object.entries(records)) transaction.objectStore(name).put(record);
    await new Promise((resolve) => (transaction.oncomplete = resolve));
  } finally {
    database.close();
  }
}

async function stored(factory: IDBFactory, storeName: string): Promise<unknown> {
  const database = await request(factory.open(annotationDatabaseName));
  try {
    return await request(database.transaction(storeName).objectStore(storeName).get(publicationId));
  } finally {
    database.close();
  }
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
