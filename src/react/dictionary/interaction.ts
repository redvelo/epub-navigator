import { useAtomValue, useSetAtom, useStore } from "jotai";
import { dictionaryCoordinatorAtom, setDictionaryAnchorAtom } from "./state.js";
import { lookUpDictionaryAtom, stopDictionaryAtom } from "./dispatch.js";
import { effectiveCompactSurfaceAtom, setCompactSurfaceAtom } from "../compact/state.js";
import {
  dismissedSelectionRevisionAtom,
  selectionActionAtom,
  useAnnotationState,
} from "../annotations/state.js";
import { selectionExactText, selectionToolbarRects } from "../annotations/helpers.js";
import type { RefObject } from "react";
import type { DocumentObservation } from "../../generated/kernel.js";

export interface DictionaryInteraction {
  readonly lookUpSelection: (event: MouseEvent) => void;
  readonly closeDictionary: () => void;
}

/** Anchors a dictionary lookup to the live selection, in the compact surface or beside the text. */
export function useDictionaryInteraction({
  frameHost,
  compact,
  observation,
}: {
  readonly frameHost: RefObject<HTMLElement | null>;
  readonly compact: boolean;
  readonly observation: DocumentObservation | null;
}): DictionaryInteraction {
  const store = useStore();
  const { selectionSnapshot } = useAnnotationState();
  const compactSurface = useAtomValue(effectiveCompactSurfaceAtom);
  const setCompactSurface = useSetAtom(setCompactSurfaceAtom);
  const setDictionaryAnchor = useSetAtom(setDictionaryAnchorAtom);
  const setDismissedSelectionRevision = useSetAtom(dismissedSelectionRevisionAtom);
  const setSelectionAction = useSetAtom(selectionActionAtom);
  const capturedSelection =
    selectionSnapshot?.selection?.status === "captured" ? selectionSnapshot.selection : null;
  return {
    lookUpSelection: (event) => {
      if (!event.isTrusted || store.get(dictionaryCoordinatorAtom) === null) return;
      if (capturedSelection === null) return;
      const text = selectionExactText(capturedSelection.location);
      const host = frameHost.current;
      if (text === null || host === null) return;
      if (compact) {
        setCompactSurface("dictionary");
      } else {
        const anchor = selectionToolbarRects(capturedSelection.anchor, host)?.anchorRect;
        if (anchor === undefined) return;
        const bounds = host.getBoundingClientRect();
        const view = host.ownerDocument.defaultView;
        const left = bounds.left - (view?.visualViewport?.offsetLeft ?? 0);
        const top = bounds.top - (view?.visualViewport?.offsetTop ?? 0);
        setDictionaryAnchor({
          left: anchor.left + left,
          top: anchor.top + top,
          right: anchor.right + left,
          bottom: anchor.bottom + top,
        });
      }
      if (selectionSnapshot !== null) setDismissedSelectionRevision(selectionSnapshot.revision);
      setSelectionAction(null);
      const language = capturedSelection.language ?? observation?.language ?? null;
      store.set(lookUpDictionaryAtom, { text, language, initiator: "selection" });
    },
    closeDictionary: () => {
      store.set(stopDictionaryAtom);
      setDictionaryAnchor(null);
      if (compactSurface === "dictionary") setCompactSurface(null);
    },
  };
}
