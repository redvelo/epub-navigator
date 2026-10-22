import type { PublicationTypeface } from "../generated/kernel.js";
import type { ImportWorkerResponse } from "./import-protocol.js";
import type { PublicationPaginationCapabilities } from "../runtime/pagination/index.js";
import type { PublicationSearchCapabilities } from "../runtime/search.js";
import { createLocalSearchCapabilities } from "./search.js";
import {
  createLocalPaginationCache,
  deletePublicationCache,
  isPublicationId,
  listCommittedPublications,
  readCommittedResourceManifest,
  readCommittedPublication,
  readCommittedPublicationSnapshot,
  type LocalPublicationRecord,
  withPublicationLock,
} from "./storage.js";
import type {
  BrowserLocalHost,
  BrowserLocalHostConfig,
  ImportPublicationOptions,
  LocalHostFailureCode,
} from "./types.js";
import { LocalHostError } from "./types.js";
import type {
  LocalServiceWorkerConfiguration,
  LocalServiceWorkerMessage,
} from "./service-worker-protocol.js";

interface ResolvedLocalHostConfig {
  readonly importWorkerUrl: string;
  readonly serviceWorkerUrl: string;
  readonly serviceWorkerScope: string;
  readonly mountBaseUrl: string;
  readonly measurementMountBaseUrl: string;
  readonly contentAgentUrl: string;
  readonly readerFontStylesheetUrl: string | null;
  readonly measurementArtifactDigest: string | null;
}

/** Creates the explicit browser-local host without changing the global service-worker state. */
export function createBrowserLocalHost(config: BrowserLocalHostConfig): BrowserLocalHost {
  return new BrowserLocalHostImpl(config);
}

class BrowserLocalHostImpl implements BrowserLocalHost {
  readonly ready: Promise<void>;
  readonly readerTypefaces: readonly PublicationTypeface[];
  readonly #config: ResolvedLocalHostConfig;
  #registration: ServiceWorkerRegistration | undefined;
  #activeWorker: Worker | undefined;
  #cancelActive: (() => void) | undefined;
  #importActive = false;
  #disposed = false;
  readonly #paginationCapabilities = new Map<string, Set<AbortController>>();
  readonly #searchCapabilities = new Map<string, Set<AbortController>>();
  readonly #publicationGenerations = new Map<string, number>();
  #hostGeneration = 0;

  constructor(config: BrowserLocalHostConfig) {
    this.#config = resolveConfig(config);
    // One stylesheet carries every reader face, so either all are served or none are.
    this.readerTypefaces =
      this.#config.readerFontStylesheetUrl === null ? [] : ["reader-serif", "reader-sans"];
    this.ready = this.#initialize();
  }

  async importPublication(
    source: ArrayBuffer | Uint8Array | Blob,
    options: ImportPublicationOptions = {},
  ): Promise<LocalPublicationRecord> {
    await this.ready;
    this.#assertUsable();
    if (options.signal?.aborted) throw cancelledError();
    if (this.#importActive) {
      throw new LocalHostError("local-import-active", "another EPUB import is already active");
    }
    this.#importActive = true;

    let bytes: Uint8Array;
    try {
      bytes = await sourceBytes(source);
    } catch (cause) {
      this.#importActive = false;
      throw new LocalHostError(
        "local-import-failed",
        errorMessage(cause, "the EPUB source could not be read"),
        { cause },
      );
    }
    if (options.signal?.aborted) {
      this.#importActive = false;
      throw cancelledError();
    }
    if (this.#disposed) {
      this.#importActive = false;
      throw new LocalHostError("local-host-unavailable", "the local host is disposed");
    }
    let worker: Worker;
    try {
      worker = new Worker(this.#config.importWorkerUrl, { type: "module" });
    } catch (cause) {
      this.#importActive = false;
      throw new LocalHostError(
        "local-import-failed",
        errorMessage(cause, "the import worker could not be created"),
        { cause },
      );
    }
    this.#activeWorker = worker;
    let publicationId: string | undefined;
    let settled = false;
    let committed = false;
    let abortListener: (() => void) | undefined;

    return new Promise<LocalPublicationRecord>((resolve, reject) => {
      const cleanup = (): void => {
        if (abortListener !== undefined) {
          options.signal?.removeEventListener("abort", abortListener);
        }
        if (this.#cancelActive === cancel) this.#cancelActive = undefined;
        if (this.#activeWorker === worker) this.#activeWorker = undefined;
        this.#importActive = false;
        worker.terminate();
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const fail = (code: LocalHostFailureCode, message: string, cause?: unknown): void => {
        finish(() => reject(new LocalHostError(code, message, { cause })));
      };
      const cancel = (): void => {
        if (settled || committed) return;
        settled = true;
        worker.terminate();
        const id = publicationId;
        const cleanupCache =
          id === undefined
            ? Promise.resolve()
            : withPublicationLock(id, () => deletePublicationCache(id)).then(() => undefined);
        void cleanupCache
          .catch(() => undefined)
          .finally(() => {
            cleanup();
            reject(new LocalHostError("local-import-cancelled", "the EPUB import was cancelled"));
          });
      };
      this.#cancelActive = cancel;
      abortListener = cancel;
      options.signal?.addEventListener("abort", abortListener, { once: true });

      worker.onmessage = (event: MessageEvent<ImportWorkerResponse>) => {
        const message = event.data;
        if (message.type === "progress") {
          publicationId = message.id ?? publicationId;
          try {
            options.onProgress?.({
              phase: message.phase,
              completed: message.completed,
              total: message.total,
            });
          } catch {
            // Consumer progress callbacks cannot strand the import lifecycle.
          }
          return;
        }
        if (message.type === "error") {
          fail("local-import-failed", message.message);
          return;
        }
        publicationId = message.id;
        committed = true;
        void readCommittedPublication(this.#config.mountBaseUrl, message.id).then(
          (publication) => {
            if (publication === undefined) {
              fail(
                "local-publication-invalid",
                "the import completed without a committed publication",
              );
            } else {
              finish(() => resolve(publication));
            }
          },
          (cause: unknown) => {
            fail(
              "local-import-failed",
              errorMessage(cause, "the imported publication could not be opened"),
              cause,
            );
          },
        );
      };
      worker.onerror = (event) => {
        fail("local-import-failed", event.message || "the import worker failed");
      };

      try {
        worker.postMessage({ type: "import", source: bytes.buffer as ArrayBuffer }, [
          bytes.buffer as ArrayBuffer,
        ]);
      } catch (cause) {
        fail(
          "local-import-failed",
          errorMessage(cause, "the import worker could not receive the EPUB"),
          cause,
        );
      }
    });
  }

  async listPublications(): Promise<readonly LocalPublicationRecord[]> {
    await this.ready;
    this.#assertUsable();
    try {
      return listCommittedPublications(this.#config.mountBaseUrl);
    } catch (cause) {
      throw new LocalHostError(
        "local-storage-failed",
        errorMessage(cause, "local publications could not be listed"),
        { cause },
      );
    }
  }

  async openPublication(id: string): Promise<LocalPublicationRecord> {
    await this.ready;
    this.#assertUsable();
    if (!isPublicationId(id))
      throw new LocalHostError("local-publication-unavailable", "the publication id is invalid");
    try {
      const publication = await readCommittedPublication(this.#config.mountBaseUrl, id);
      if (publication === undefined) {
        throw new LocalHostError(
          "local-publication-unavailable",
          "the local publication is unavailable or outdated; reimport the original EPUB",
        );
      }
      return publication;
    } catch (cause) {
      if (cause instanceof LocalHostError) throw cause;
      throw new LocalHostError(
        "local-storage-failed",
        errorMessage(cause, "the local publication could not be opened"),
        { cause },
      );
    }
  }

  async paginationCapabilities(id: string): Promise<PublicationPaginationCapabilities> {
    await this.ready;
    this.#assertUsable();
    if (!isPublicationId(id)) {
      throw new LocalHostError("local-publication-unavailable", "the publication id is invalid");
    }
    const hostGeneration = this.#hostGeneration;
    const publicationGeneration = this.#publicationGenerations.get(id) ?? 0;
    const publication = await readCommittedPublication(this.#config.mountBaseUrl, id);
    this.#assertCapabilityGeneration(id, hostGeneration, publicationGeneration);
    const manifest = await readCommittedResourceManifest(id);
    this.#assertCapabilityGeneration(id, hostGeneration, publicationGeneration);
    if (publication === undefined || manifest === undefined) {
      throw new LocalHostError(
        "local-publication-unavailable",
        "the local publication is unavailable",
      );
    }
    const controller = new AbortController();
    const controllers = this.#paginationCapabilities.get(id) ?? new Set<AbortController>();
    controllers.add(controller);
    this.#paginationCapabilities.set(id, controllers);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      controller.abort();
      const active = this.#paginationCapabilities.get(id);
      active?.delete(controller);
      if (active?.size === 0) this.#paginationCapabilities.delete(id);
    };
    const cacheIdentity =
      this.#config.measurementArtifactDigest === null
        ? null
        : { measurementArtifactDigest: this.#config.measurementArtifactDigest };
    const resolvedUnscriptedResources = new Set(
      publication.facts.resources.resources.flatMap((resource) =>
        resource.presence.state === "present" &&
        resource.address.kind === "local" &&
        !resource.scripted
          ? [resource.address.value]
          : [],
      ),
    );
    const resolvedStaticXhtml = new Set(
      publication.facts.resources.resources.flatMap((resource) =>
        resource.presence.state === "present" &&
        resource.address.kind === "local" &&
        resource.hasXhtmlDeclaration &&
        !resource.scripted
          ? [resource.address.value]
          : [],
      ),
    );
    return {
      responses: {
        mount: {
          baseUrl: new URL(`${id}/`, this.#config.measurementMountBaseUrl).href,
          remoteResources: publication.mount.remoteResources,
          contentOrigin: "shared-reader-origin",
        },
        eligibleResourcePaths: manifest.resources
          .filter(
            (resource) =>
              resource.executableContent === "analyzed-absent" &&
              resolvedUnscriptedResources.has(resource.path),
          )
          .map((resource) => resource.path),
      },
      foregroundPreparation: {
        eligibleResourcePaths: manifest.resources
          .filter(
            (resource) =>
              resource.foregroundPreparation === "eligible" &&
              (resolvedStaticXhtml.has(resource.path) ||
                (resource.responseInstrumentation === "svg" &&
                  resolvedUnscriptedResources.has(resource.path))),
          )
          .map((resource) => resource.path),
      },
      cache: createLocalPaginationCache(id, controller.signal),
      ...(cacheIdentity === null ? {} : { cacheIdentity }),
      signal: controller.signal,
      close,
    };
  }

  async searchCapabilities(id: string): Promise<PublicationSearchCapabilities> {
    await this.ready;
    this.#assertUsable();
    if (!isPublicationId(id)) {
      throw new LocalHostError("local-publication-unavailable", "the publication id is invalid");
    }
    const hostGeneration = this.#hostGeneration;
    const publicationGeneration = this.#publicationGenerations.get(id) ?? 0;
    const snapshot = await readCommittedPublicationSnapshot(this.#config.mountBaseUrl, id);
    this.#assertCapabilityGeneration(id, hostGeneration, publicationGeneration);
    if (snapshot === undefined) {
      throw new LocalHostError(
        "local-publication-unavailable",
        "the local publication search snapshot is unavailable",
      );
    }
    const { publication, searchDocuments, searchEntries } = snapshot;
    const controller = new AbortController();
    const controllers = this.#searchCapabilities.get(id) ?? new Set<AbortController>();
    controllers.add(controller);
    this.#searchCapabilities.set(id, controllers);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      controller.abort();
      const active = this.#searchCapabilities.get(id);
      active?.delete(controller);
      if (active?.size === 0) this.#searchCapabilities.delete(id);
    };
    return createLocalSearchCapabilities(
      publication.facts,
      publication.searchDocumentStates,
      searchDocuments,
      searchEntries,
      controller,
      close,
    );
  }

  async removePublication(id: string): Promise<void> {
    await this.ready;
    this.#assertUsable();
    if (!isPublicationId(id))
      throw new LocalHostError("local-publication-unavailable", "the publication id is invalid");
    try {
      this.#publicationGenerations.set(id, (this.#publicationGenerations.get(id) ?? 0) + 1);
      this.#revokePaginationCapabilities(id);
      this.#revokeSearchCapabilities(id);
      await withPublicationLock(id, () => deletePublicationCache(id));
    } catch (cause) {
      throw new LocalHostError(
        "local-storage-failed",
        errorMessage(cause, "the local publication could not be removed"),
        { cause },
      );
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#hostGeneration += 1;
    for (const id of this.#paginationCapabilities.keys()) this.#revokePaginationCapabilities(id);
    for (const id of this.#searchCapabilities.keys()) this.#revokeSearchCapabilities(id);
    this.#cancelActive?.();
    this.#activeWorker?.terminate();
    this.#activeWorker = undefined;
    this.#registration = undefined;
  }

  async #initialize(): Promise<void> {
    if (typeof navigator === "undefined" || navigator.serviceWorker === undefined) {
      throw new LocalHostError(
        "local-host-unavailable",
        "service workers are unavailable in this browser",
      );
    }
    try {
      this.#registration = await navigator.serviceWorker.register(this.#config.serviceWorkerUrl, {
        scope: this.#config.serviceWorkerScope,
        type: "module",
      });
      await navigator.serviceWorker.ready;
      await waitForController();
      await configureServiceWorker(this.#registration, {
        type: "configure",
        mountBaseUrl: this.#config.mountBaseUrl,
        measurementMountBaseUrl: this.#config.measurementMountBaseUrl,
        contentAgentUrl: this.#config.contentAgentUrl,
        readerFontStylesheetUrl: this.#config.readerFontStylesheetUrl,
      });
    } catch (cause) {
      if (cause instanceof LocalHostError) throw cause;
      throw new LocalHostError(
        "local-service-worker-failed",
        errorMessage(cause, "the local service worker could not be initialized"),
        { cause },
      );
    }
  }

  #assertUsable(): void {
    if (this.#disposed)
      throw new LocalHostError("local-host-unavailable", "the local host is disposed");
  }

  #revokePaginationCapabilities(id: string): void {
    const controllers = this.#paginationCapabilities.get(id);
    if (controllers === undefined) return;
    this.#paginationCapabilities.delete(id);
    for (const controller of controllers) controller.abort();
  }

  #revokeSearchCapabilities(id: string): void {
    const controllers = this.#searchCapabilities.get(id);
    if (controllers === undefined) return;
    this.#searchCapabilities.delete(id);
    for (const controller of controllers) controller.abort();
  }

  #assertCapabilityGeneration(id: string, host: number, publication: number): void {
    this.#assertUsable();
    if (
      host !== this.#hostGeneration ||
      publication !== (this.#publicationGenerations.get(id) ?? 0)
    ) {
      throw new LocalHostError(
        "local-publication-unavailable",
        "the local publication is unavailable",
      );
    }
  }
}

function resolveConfig(config: BrowserLocalHostConfig): ResolvedLocalHostConfig {
  try {
    const serviceWorker = absoluteUrl(config.serviceWorkerUrl, "service worker URL");
    const scope = absoluteUrl(config.serviceWorkerScope, "service worker scope");
    const mount = absoluteUrl(config.mountBaseUrl, "mount base URL");
    const measurementMount = absoluteUrl(
      config.measurementMountBaseUrl,
      "measurement mount base URL",
    );
    const agent = absoluteUrl(config.contentAgentUrl, "content agent URL");
    const readerFonts =
      config.readerFontStylesheetUrl === undefined
        ? null
        : absoluteUrl(config.readerFontStylesheetUrl, "reader font stylesheet URL");
    if (
      serviceWorker.origin !== location.origin ||
      scope.origin !== location.origin ||
      mount.origin !== location.origin ||
      measurementMount.origin !== location.origin ||
      agent.origin !== location.origin ||
      (readerFonts !== null &&
        (readerFonts.origin !== location.origin ||
          readerFonts.username.length > 0 ||
          readerFonts.password.length > 0)) ||
      mount.search.length > 0 ||
      mount.hash.length > 0 ||
      measurementMount.search.length > 0 ||
      measurementMount.hash.length > 0 ||
      !mount.pathname.endsWith("/") ||
      !measurementMount.pathname.endsWith("/") ||
      !scope.pathname.endsWith("/") ||
      !mount.pathname.startsWith(scope.pathname) ||
      !measurementMount.pathname.startsWith(scope.pathname) ||
      measurementMount.pathname === mount.pathname ||
      measurementMount.pathname.startsWith(mount.pathname) ||
      mount.pathname.startsWith(measurementMount.pathname) ||
      agent.pathname.startsWith(mount.pathname) ||
      agent.pathname.startsWith(measurementMount.pathname) ||
      serviceWorker.pathname.startsWith(mount.pathname)
    ) {
      throw new Error("worker, scope, mount, and agent must be same-origin and scope-compatible");
    }
    return {
      importWorkerUrl: serviceWorkerRelative(config.importWorkerUrl),
      serviceWorkerUrl: serviceWorker.href,
      serviceWorkerScope: scope.href,
      mountBaseUrl: mount.href,
      measurementMountBaseUrl: measurementMount.href,
      contentAgentUrl: agent.href,
      readerFontStylesheetUrl: readerFonts?.href ?? null,
      measurementArtifactDigest: validateOptionalDigest(config.measurementArtifactDigest),
    };
  } catch (cause) {
    if (cause instanceof LocalHostError) throw cause;
    throw new LocalHostError(
      "local-host-configuration-invalid",
      errorMessage(cause, "the local host configuration is invalid"),
      { cause },
    );
  }
}

function absoluteUrl(value: string | URL, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`the ${label} must be an absolute URL`, { cause });
  }
  return url;
}

function serviceWorkerRelative(value: string | URL): string {
  const url = absoluteUrl(value, "import worker URL");
  if (url.origin !== location.origin) throw new Error("the import worker must be same-origin");
  return url.href;
}

async function sourceBytes(source: ArrayBuffer | Uint8Array | Blob): Promise<Uint8Array> {
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  return source instanceof ArrayBuffer ? new Uint8Array(source).slice() : source.slice();
}

function validateOptionalDigest(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("the measurement artifact digest must be a lowercase SHA-256");
  }
  return value;
}

async function waitForController(): Promise<void> {
  if (navigator.serviceWorker.controller !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      reject(
        new LocalHostError(
          "local-service-worker-failed",
          "the service worker does not control this page",
        ),
      );
    }, 5000);
    const onControllerChange = (): void => {
      if (navigator.serviceWorker.controller === null) return;
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    onControllerChange();
  });
}

async function configureServiceWorker(
  registration: ServiceWorkerRegistration,
  message: LocalServiceWorkerConfiguration,
): Promise<void> {
  const target = navigator.serviceWorker.controller ?? registration.active;
  if (target === null || target === undefined) {
    throw new LocalHostError(
      "local-service-worker-failed",
      "the service worker has no active controller",
    );
  }
  const channel = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(
        new LocalHostError(
          "local-service-worker-failed",
          "the service worker did not accept configuration",
        ),
      );
    }, 5000);
    channel.port1.onmessage = (event: MessageEvent<LocalServiceWorkerMessage>) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      if (event.data.type === "configured") {
        resolve();
      } else {
        reject(
          new LocalHostError(
            "local-service-worker-failed",
            event.data.type === "configuration-error"
              ? event.data.message
              : "the service worker rejected its configuration",
          ),
        );
      }
    };
    target.postMessage(message, [channel.port2]);
  });
}

function cancelledError(): LocalHostError {
  return new LocalHostError("local-import-cancelled", "the EPUB import was cancelled");
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
