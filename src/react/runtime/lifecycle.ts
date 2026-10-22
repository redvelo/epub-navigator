import { atom } from "jotai";
import type { NavigatorAnnotationProjection } from "../../annotations.js";
import type { PresentationPreferences } from "../../generated/kernel.js";
import type { PublicationPaginationCapabilities } from "../../runtime/pagination/index.js";
import type { NavigatorRuntime } from "../../runtime/navigator/api.js";
import { currentFrame } from "../../runtime/kernel-view.js";
import {
  abortAnnotationOperationsAtom,
  contextualAnnotationSourceRevisionAtom,
  decorationRevisionAtom,
} from "../annotations/state.js";
import { decorationProjection } from "../decorations/projection.js";
import { navigationIntentAtom, presentationAdvanceAtom } from "../navigation/state.js";
import { searchDecorationResultsAtom, searchSnapshotAtom } from "../search/state.js";
import {
  presentationPreferencesAtom,
  readerConfigurationAtom,
  samePresentationPreferences,
} from "./preferences-state.js";
import { activeRuntimeAtom } from "./projection-state.js";

/** Decoration revisions restart with each runtime, so the first projection it is given is 1. */
const FIRST_DECORATION_REVISION = 1;

export interface RuntimeAdoption {
  readonly runtime: NavigatorRuntime;
  /**
   * The values the runtime was constructed with. Construction is asynchronous, so anything that
   * changed while it was in flight has to be pushed afterwards, and only then.
   */
  readonly constructedWith: {
    readonly presentation: PresentationPreferences;
    readonly pagination: PublicationPaginationCapabilities | undefined;
  };
  readonly pagination: PublicationPaginationCapabilities | undefined;
  readonly annotations: NavigatorAnnotationProjection | undefined;
}

/**
 * Publishes a newly constructed runtime and catches it up on everything it was not built with.
 * One write, so nothing observes it half-adopted.
 */
export const adoptRuntimeAtom = atom(null, (get, set, adoption: RuntimeAdoption) => {
  const { runtime, constructedWith, pagination, annotations } = adoption;
  set(activeRuntimeAtom, runtime);
  set(contextualAnnotationSourceRevisionAtom, null);
  // Nothing is mid-flight for a runtime this new, so the presentation gate starts open.
  set(presentationAdvanceAtom, Promise.resolve());

  runtime.configure(get(readerConfigurationAtom));
  const presentation = get(presentationPreferencesAtom);
  if (!samePresentationPreferences(presentation, constructedWith.presentation)) {
    runtime.setPresentationPreferences(presentation);
  }
  if (pagination !== constructedWith.pagination) runtime.setPaginationCapabilities(pagination);

  const projected = decorationProjection(
    annotations,
    get(searchSnapshotAtom),
    currentFrame(runtime.snapshot())?.occurrence ?? null,
    FIRST_DECORATION_REVISION,
  );
  runtime.setDecorationProjection(projected.projection);
  set(decorationRevisionAtom, FIRST_DECORATION_REVISION);
  set(searchDecorationResultsAtom, projected.searchResults);
});

/**
 * Abandons the work in flight for a session being torn down. The runtime itself belongs to the
 * caller, which still has to drop its reference and close it.
 */
export const abandonRuntimeWorkAtom = atom(null, (_get, set) => {
  set(abortAnnotationOperationsAtom);
  set(navigationIntentAtom, null);
  set(presentationAdvanceAtom, Promise.resolve());
});
