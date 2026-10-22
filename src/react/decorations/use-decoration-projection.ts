import { useSetAtom, useStore } from "jotai";
import { useEffect, type RefObject } from "react";
import type { NavigatorAnnotationProjection } from "../../annotations.js";
import type { NavigatorSearchSnapshot } from "../../search.js";
import type { NavigatorRuntime } from "../../runtime/navigator/api.js";
import {
  contextualAnnotationAtom,
  contextualAnnotationIdAtom,
  contextualAnnotationSourceRevisionAtom,
  decorationRevisionAtom,
} from "../annotations/state.js";
import { searchDecorationResultsAtom } from "../search/state.js";
import { decorationProjection } from "./projection.js";

interface DecorationProjectionPort {
  readonly runtime: RefObject<NavigatorRuntime | null>;
  readonly annotations: NavigatorAnnotationProjection | undefined;
  readonly searchSnapshot: NavigatorSearchSnapshot;
  readonly occurrence: number | null;
}

export function useDecorationProjection({
  runtime,
  annotations,
  searchSnapshot,
  occurrence,
}: DecorationProjectionPort): void {
  const store = useStore();
  const setContextualAnnotation = useSetAtom(contextualAnnotationAtom);
  useEffect(() => {
    const current = runtime.current;
    if (current === null) return;
    const nextRevision = store.get(decorationRevisionAtom) + 1;
    const projected = decorationProjection(annotations, searchSnapshot, occurrence, nextRevision);
    current.setDecorationProjection(projected.projection);
    store.set(decorationRevisionAtom, nextRevision);
    store.set(searchDecorationResultsAtom, projected.searchResults);
    const activeAnnotationId = store.get(contextualAnnotationIdAtom);
    if (
      activeAnnotationId !== null &&
      annotations?.records.some((record) => record.id === activeAnnotationId) === true
    ) {
      store.set(contextualAnnotationSourceRevisionAtom, annotations.revision);
      setContextualAnnotation((activation) =>
        activation === null ? null : { ...activation, projectionRevision: nextRevision },
      );
      current.setActiveDecoration(nextRevision, activeAnnotationId);
    }
  }, [annotations, occurrence, runtime, searchSnapshot, setContextualAnnotation, store]);
}
