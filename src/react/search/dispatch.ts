import { atom } from "jotai";
import { currentFrame } from "../../runtime/kernel-view.js";
import { beginOperation, releaseOperation } from "../lib/operations.js";
import { normalizeError } from "../status/errors.js";
import { setCompactSurfaceAtom } from "../compact/state.js";
import {
  activeRuntimeAtom,
  frameHostElementAtom,
  runtimeViewAtom,
} from "../runtime/projection-state.js";
import { activePublicationFrame } from "../input/focus.js";
import { readerStoreAtom } from "../navigation/navigate-atom.js";
import { closeWorkspaceOverlayAtom } from "../workspace/state.js";
import {
  searchActivationAtom,
  searchActivationOperationAtom,
  searchCoordinatorAtom,
  searchCoordinatorLeaseAtom,
  searchQueryAtom,
  searchScopeAtom,
  searchSnapshotAtom,
} from "./state.js";
import type {
  NavigatorSearchRequest,
  NavigatorSearchResult,
  NavigatorSearchScope,
} from "../../search.js";

/** Scope support is a host capability; the reader publishes it so dispatch can stay in the store. */
export const searchScopeSupportAtom = atom({ publication: false, occurrence: false });

export const runSearchAtom = atom(
  null,
  async (
    get,
    set,
    options: {
      readonly initiator?: NavigatorSearchRequest["initiator"];
      readonly scope?: NavigatorSearchScope["type"];
      readonly query?: string;
    } = {},
  ) => {
    const coordinator = get(searchCoordinatorAtom);
    const query = options.query ?? get(searchQueryAtom);
    if (coordinator === null || query.trim().length === 0) return;
    const support = get(searchScopeSupportAtom);
    const requested = options.scope ?? get(searchScopeAtom);
    const supported =
      requested === "publication" && !support.publication
        ? support.occurrence
          ? "occurrence"
          : null
        : requested === "occurrence" && !support.occurrence
          ? support.publication
            ? "publication"
            : null
          : requested;
    if (supported === null) return;
    const snapshot = get(runtimeViewAtom)?.snapshot ?? null;
    const committed = snapshot === null ? null : currentFrame(snapshot);
    const scope: NavigatorSearchScope =
      supported === "occurrence" && committed !== null
        ? { type: "occurrence", occurrence: committed.occurrence, resource: committed.resource }
        : { type: "publication" };
    set(searchActivationAtom, null);
    try {
      await coordinator.submit(query, scope, options.initiator ?? "query-entry");
    } catch {
      // The coordinator publishes search failures through its local snapshot.
    }
  },
);

export const changeSearchScopeAtom = atom(null, (get, set, scope: NavigatorSearchScope["type"]) => {
  const support = get(searchScopeSupportAtom);
  const next =
    scope === "occurrence" && support.occurrence
      ? "occurrence"
      : support.publication
        ? "publication"
        : "occurrence";
  set(searchScopeAtom, next);
  if (get(searchSnapshotAtom).state !== "idle" && get(searchQueryAtom).trim().length > 0) {
    void set(runSearchAtom, { initiator: "query-entry", scope: next });
  }
});

export const continueSearchAtom = atom(null, (get) => {
  void get(searchCoordinatorAtom)?.continue();
});

export const activateSearchResultAtom = atom(
  null,
  async (get, set, result: NavigatorSearchResult) => {
    const runtime = get(activeRuntimeAtom);
    const coordinator = get(searchCoordinatorAtom);
    const lease = get(searchCoordinatorLeaseAtom);
    if (runtime === null || coordinator === null) return;
    const store = get(readerStoreAtom);
    if (store === null) return;
    const controller = beginOperation(store, searchActivationOperationAtom);
    const snapshot = get(searchSnapshotAtom);
    const session = snapshot.state === "idle" ? null : snapshot.session;
    const previous = session?.selectedResultId ?? null;
    const superseded = () =>
      controller.signal.aborted ||
      get(searchCoordinatorLeaseAtom) !== lease ||
      get(activeRuntimeAtom) !== runtime;
    coordinator.select(result.id);
    set(searchActivationAtom, { resultId: result.id, status: "activating" });
    try {
      const restored = await runtime.restoreAnnotationTarget(
        {
          targetJson: result.targetJson,
          occurrenceHint: {
            occurrence: result.section.occurrence,
            resource: result.section.resource,
          },
        },
        { signal: controller.signal },
      );
      if (superseded()) return;
      if (restored.status === "cancelled") {
        coordinator.select(previous);
        set(searchActivationAtom, null);
        return;
      }
      if (restored.status === "failed") {
        coordinator.select(previous);
        set(searchActivationAtom, {
          resultId: result.id,
          status: "failed",
          message: restored.message,
        });
        return;
      }
      set(searchActivationAtom, null);
      set(setCompactSurfaceAtom, null);
      set(closeWorkspaceOverlayAtom, "navigation");
      const container = get(frameHostElementAtom);
      requestAnimationFrame(() =>
        activePublicationFrame(container)?.focus({ preventScroll: true }),
      );
    } catch (cause) {
      if (superseded()) return;
      coordinator.select(previous);
      set(searchActivationAtom, {
        resultId: result.id,
        status: "failed",
        message: normalizeError(cause, false).message,
      });
    } finally {
      releaseOperation(store, searchActivationOperationAtom, controller);
    }
  },
);
