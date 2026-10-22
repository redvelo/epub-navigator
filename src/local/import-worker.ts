import { initializeNavigatorWasm, WasmPublication } from "../wasm.js";
import { openLocalPublication } from "./publication.js";
import { createInitializedNavigatorKernel } from "../runtime/kernel.js";
import type { ImportWorkerRequest, ImportWorkerResponse } from "./import-protocol.js";
import {
  deletePublicationCache,
  localCacheName,
  readCommittedPublication,
  resourceManifestFromFacts,
  withPublicationLock,
  writePublicationCache,
} from "./storage.js";

const worker = globalThis as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ImportWorkerRequest>) => void,
  ): void;
  postMessage(message: ImportWorkerResponse): void;
};
let cancelled = false;
let running = false;

worker.addEventListener("message", (event) => {
  if (event.data.type === "cancel") {
    cancelled = true;
    return;
  }
  if (running) return;
  running = true;
  cancelled = false;
  void importArchive(event.data.source).finally(() => {
    running = false;
  });
});

async function importArchive(sourceBuffer: ArrayBuffer): Promise<void> {
  const source = new Uint8Array(sourceBuffer);
  let publication: Awaited<ReturnType<typeof openLocalPublication>> | undefined;
  try {
    report({ type: "progress", phase: "hashing", completed: 0, total: 1 });
    await initializeNavigatorWasm();
    const id = WasmPublication.hashBlake3(source);
    checkCancelled();
    await withPublicationLock(id, async () => {
      try {
        if (
          (await readCommittedPublication("https://epub-navigator.invalid/publications/", id)) !==
          undefined
        ) {
          worker.postMessage({ type: "done", id });
          return;
        }

        report({ type: "progress", phase: "opening", completed: 0, total: 1, id });
        publication = await openLocalPublication(source);
        checkCancelled();

        const analysis = publication.analysis();
        const kernel = createInitializedNavigatorKernel({
          facts: publication.facts,
          mount: {
            baseUrl: "https://epub-navigator.invalid/publications/",
            contentOrigin: "shared-reader-origin",
            remoteResources: "blocked",
          },
        });
        const readingOrder = kernel.snapshot().readingOrder;
        kernel.close();
        const manifest = resourceManifestFromFacts(
          publication.facts,
          analysis.executableContent,
          analysis.foregroundPreparation,
          readingOrder,
        );
        const resources: Record<string, Uint8Array> = {};
        report({
          type: "progress",
          phase: "resources",
          completed: 0,
          total: manifest.resources.length,
          id,
        });
        for (const resource of manifest.resources) {
          checkCancelled();
          resources[resource.path] = publication.readResource(resource.path);
        }
        const storedManifest = {
          revision: manifest.revision,
          resources: manifest.resources.map((resource) => ({
            ...resource,
            sizeBytes: resources[resource.path]?.byteLength ?? resource.sizeBytes,
          })),
        };

        checkCancelled();
        await deletePublicationCache(id);
        const cache = await caches.open(localCacheName(id));
        report({
          type: "progress",
          phase: "committing",
          completed: 0,
          total: manifest.resources.length,
          id,
        });
        await writePublicationCache(
          cache,
          {
            id,
            source,
            facts: publication.facts,
            searchDocumentStates: analysis.searchDocumentStates,
            searchDocuments: analysis.searchDocuments,
            searchEntries: analysis.searchEntries,
            manifest: storedManifest,
            resources,
            importedAt: Date.now(),
          },
          (written, total) => {
            checkCancelled();
            report({
              type: "progress",
              phase: "committing",
              completed: written,
              total,
              id,
            });
          },
        );
        worker.postMessage({ type: "done", id });
      } catch (cause) {
        await deletePublicationCache(id).catch(() => undefined);
        throw cause;
      }
    });
  } catch (cause) {
    worker.postMessage({ type: "error", message: errorMessage(cause) });
  } finally {
    try {
      publication?.close();
    } catch {
      // The imported cache is already committed or removed; there is no live handle to retain.
    }
  }
}

function checkCancelled(): void {
  if (cancelled) throw new Error("the EPUB import was cancelled");
}

function report(progress: Extract<ImportWorkerResponse, { type: "progress" }>): void {
  worker.postMessage(progress);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "the EPUB import failed";
}
