import type { PublicationTypeface } from "../generated/kernel.js";
import type { LocalPublicationRecord } from "./storage.js";
import type { PublicationPaginationCapabilities } from "../runtime/pagination/index.js";
import type { PublicationSearchCapabilities } from "../runtime/search.js";

export interface BrowserLocalHostConfig {
  readonly importWorkerUrl: string | URL;
  readonly serviceWorkerUrl: string | URL;
  readonly serviceWorkerScope: string | URL;
  readonly mountBaseUrl: string;
  readonly measurementMountBaseUrl: string;
  readonly contentAgentUrl: string | URL;
  readonly readerFontStylesheetUrl?: (string | URL) | undefined;
  /** SHA-256 of the deployed artifacts that can affect pagination measurement. */
  readonly measurementArtifactDigest?: string | undefined;
}

export interface ImportProgress {
  readonly phase: "hashing" | "opening" | "resources" | "committing";
  readonly completed: number;
  readonly total: number;
}

export interface ImportPublicationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: ImportProgress) => void) | undefined;
}

export type LocalHostFailureCode =
  | "local-host-unavailable"
  | "local-host-configuration-invalid"
  | "local-service-worker-failed"
  | "local-import-active"
  | "local-import-cancelled"
  | "local-import-failed"
  | "local-storage-failed"
  | "local-publication-unavailable"
  | "local-publication-invalid";

export class LocalHostError extends Error {
  readonly code: LocalHostFailureCode;

  constructor(code: LocalHostFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalHostError";
    this.code = code;
  }
}

export interface BrowserLocalHost {
  readonly ready: Promise<void>;
  readonly readerTypefaces: readonly PublicationTypeface[];
  importPublication(
    source: ArrayBuffer | Uint8Array | Blob,
    options?: ImportPublicationOptions,
  ): Promise<LocalPublicationRecord>;
  listPublications(): Promise<readonly LocalPublicationRecord[]>;
  openPublication(id: string): Promise<LocalPublicationRecord>;
  paginationCapabilities(id: string): Promise<PublicationPaginationCapabilities>;
  searchCapabilities(id: string): Promise<PublicationSearchCapabilities>;
  removePublication(id: string): Promise<void>;
  dispose(): void;
}
