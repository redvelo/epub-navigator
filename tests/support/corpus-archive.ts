import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { contentType } from "../browser/fixture-host.js";
import { corpusPublication, type CatalogPublication } from "../fixtures/epub3-samples/catalog.js";
import corpusMediaTypes from "../fixtures/epub3-samples/media-types.json" with { type: "json" };

const corpusDirectory = new URL("../fixtures/epub3-samples/", import.meta.url);
const archives = new Map<string, Promise<CorpusArchive>>();

export interface CorpusArchive {
  readonly publication: CatalogPublication;
  readonly bytes: Uint8Array;
  readonly resources: ReadonlyMap<string, Uint8Array>;
  mediaType(path: string): string;
}

export async function loadCorpusArchive(id: string): Promise<CorpusArchive> {
  const publication = corpusPublication(id);
  if (publication === undefined) throw new Error(`unknown corpus publication: ${id}`);
  let archive = archives.get(publication.id);
  if (archive === undefined) {
    archive = readCorpusArchive(publication);
    archives.set(publication.id, archive);
  }
  return archive;
}

async function readCorpusArchive(publication: CatalogPublication): Promise<CorpusArchive> {
  const bytes = new Uint8Array(await readFile(new URL(publication.fileName, corpusDirectory)));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== publication.sha256) {
    throw new Error(
      `corpus publication ${publication.id} has SHA-256 ${digest}, expected ${publication.sha256}`,
    );
  }
  const resources = new Map(Object.entries(unzipSync(bytes)));
  const mediaTypes: Readonly<Record<string, string>> = corpusMediaTypes[publication.fileName];
  for (const [path, mediaType] of Object.entries(mediaTypes)) {
    if (!isCanonicalArchivePath(path) || !resources.has(path)) {
      throw new Error(`invalid MIME override path for ${publication.id}: ${path}`);
    }
    if (mediaType.trim().length === 0 || /[\r\n]/u.test(mediaType)) {
      throw new Error(`invalid MIME override value for ${publication.id}: ${path}`);
    }
  }
  return {
    publication,
    bytes,
    resources,
    mediaType: (path) => mediaTypes[path] ?? contentType(path),
  };
}

function isCanonicalArchivePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("?") &&
    !path.includes("#") &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}
