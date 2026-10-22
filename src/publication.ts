import type { PublicationMount } from "./generated/kernel.js";
import type { PublicationFacts } from "./generated/publication.js";

/** The source facts and browser transport for one publication session. */
export interface MountedPublication {
  readonly facts: PublicationFacts;
  readonly mount: PublicationMount;
}

/**
 * Optional browser capabilities granted to every publication frame, including loading and
 * prepared frames, for one reader session. Matching host CSP remains required.
 */
export interface PublicationFrameSandboxCapabilities {
  /** Grants the iframe sandbox's browser form-submission capability; Navigator does not mediate it. */
  readonly allowForms?: boolean | undefined;
  /** Grants authored browser modal behavior; Navigator does not mediate it. */
  readonly allowModals?: boolean | undefined;
}

/** Host-issued identity for one foreground logical reader and its auxiliary runtimes. */
export type ReaderSessionId = string;

/**
 * The identity and mounted publication for one logical reader session.
 * Facts and mount remain immutable until the host issues a new ID.
 */
export interface NavigatorReaderSession {
  readonly id: ReaderSessionId;
  readonly publication: MountedPublication;
}
