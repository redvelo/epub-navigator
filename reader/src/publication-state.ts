import { atom, type Atom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomEffect } from "jotai-effect";
import type { BrowserLocalHost } from "epub-navigator/local";
import type { NavigatorAnnotationProjection, NavigatorReadingPosition } from "epub-navigator/react";
import type {
  PublicationPaginationCapabilities,
  PublicationSearchCapabilities,
} from "epub-navigator/runtime";
import type { AnnotationRepository } from "./annotations.js";

export const localHostAtom = atom<BrowserLocalHost | null>(null);
export const annotationRepositoryAtom = atom<AnnotationRepository | null>(null);

/**
 * Every atom keyed by publication, so closing or deleting one can drop its state. All of it is
 * re-derivable: leases re-acquire and stored values reload, so keeping it costs memory and buys
 * only an instant reopen within a single page session.
 */
const publicationScopedFamilies: { readonly remove: (publicationId: string) => void }[] = [];

function publicationFamily<AtomType extends Atom<unknown>>(
  initialize: (publicationId: string) => AtomType,
) {
  const family = atomFamily(initialize);
  publicationScopedFamilies.push(family);
  return family;
}

export function releasePublicationState(publicationId: string): void {
  for (const family of publicationScopedFamilies) family.remove(publicationId);
}

export type Loaded<T> =
  | { readonly status: "pending" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "available";
      readonly value: T;
    };

const pending = { status: "pending" } as const;
const unavailable = { status: "unavailable" } as const;

/**
 * Capability leases are subscriptions, not fetches: the host may abort one at any time and the
 * reader re-acquires. Keying the family by publication makes a stale publication's lease a
 * different atom, so a late acquisition can never land on the wrong book.
 */
function capabilityFamily<T extends { close: () => void; signal: AbortSignal }>(
  acquire: (host: BrowserLocalHost, publicationId: string) => Promise<T>,
) {
  const stateFamily = publicationFamily((_publicationId: string) => atom<Loaded<T>>(pending));
  const effectFamily = publicationFamily((publicationId: string) =>
    atomEffect((get, set) => {
      const host = get(localHostAtom);
      if (host === null) return;
      let active = true;
      let lease: T | null = null;
      const claim = async (): Promise<void> => {
        try {
          const capabilities = await acquire(host, publicationId);
          if (!active) {
            capabilities.close();
            return;
          }
          lease = capabilities;
          capabilities.signal.addEventListener(
            "abort",
            () => {
              if (!active || lease !== capabilities) return;
              lease = null;
              void claim();
            },
            { once: true },
          );
          set(stateFamily(publicationId), { status: "available", value: capabilities });
        } catch {
          if (active) set(stateFamily(publicationId), unavailable);
        }
      };
      void claim();
      return () => {
        active = false;
        lease?.close();
        set(stateFamily(publicationId), pending);
      };
    }),
  );
  return publicationFamily((publicationId: string) =>
    atom((get) => {
      get(effectFamily(publicationId));
      return get(stateFamily(publicationId));
    }),
  );
}

export const paginationCapabilitiesFamily = capabilityFamily<PublicationPaginationCapabilities>(
  (host, publicationId) => host.paginationCapabilities(publicationId),
);

export const searchCapabilitiesFamily = capabilityFamily<PublicationSearchCapabilities>(
  (host, publicationId) => host.searchCapabilities(publicationId),
);

/** Annotations load once per publication and are then replaced by mutation results. */
export const annotationProjectionFamily = publicationFamily((_publicationId: string) =>
  atom<Loaded<NavigatorAnnotationProjection>>(pending),
);

const annotationLoadFamily = publicationFamily((publicationId: string) =>
  atomEffect((get, set) => {
    const repository = get(annotationRepositoryAtom);
    if (repository === null) {
      set(annotationProjectionFamily(publicationId), unavailable);
      return;
    }
    const controller = new AbortController();
    void repository.load(publicationId, controller.signal).then(
      (projection) => {
        if (!controller.signal.aborted) {
          set(annotationProjectionFamily(publicationId), {
            status: "available",
            value: projection,
          });
        }
      },
      () => {
        if (!controller.signal.aborted) set(annotationProjectionFamily(publicationId), unavailable);
      },
    );
    return () => controller.abort();
  }),
);

export const annotationsFamily = publicationFamily((publicationId: string) =>
  atom((get) => {
    get(annotationLoadFamily(publicationId));
    return get(annotationProjectionFamily(publicationId));
  }),
);

const readingPositionStateFamily = publicationFamily((_publicationId: string) =>
  atom<Loaded<NavigatorReadingPosition | null>>(pending),
);

const readingPositionLoadFamily = publicationFamily((publicationId: string) =>
  atomEffect((get, set) => {
    const repository = get(annotationRepositoryAtom);
    if (repository === null) {
      set(readingPositionStateFamily(publicationId), unavailable);
      return;
    }
    const controller = new AbortController();
    void repository.loadReadingPosition(publicationId, controller.signal).then(
      (position) => {
        if (!controller.signal.aborted) {
          set(readingPositionStateFamily(publicationId), { status: "available", value: position });
        }
      },
      () => {
        if (!controller.signal.aborted) set(readingPositionStateFamily(publicationId), unavailable);
      },
    );
    return () => {
      controller.abort();
      set(readingPositionStateFamily(publicationId), pending);
    };
  }),
);

export const readingPositionFamily = publicationFamily((publicationId: string) =>
  atom((get) => {
    get(readingPositionLoadFamily(publicationId));
    return get(readingPositionStateFamily(publicationId));
  }),
);
