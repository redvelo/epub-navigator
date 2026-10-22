import { useSetAtom } from "jotai";
import { measuredAuthoredPagesAtom } from "./state.js";
import { useEffect, type RefObject } from "react";
import type { KernelSnapshot } from "../../generated/kernel.js";
import type { ReaderSessionId } from "../../publication.js";
import { currentDocument, currentFrame } from "../../runtime/kernel-view.js";
import { MAX_TOC_TARGETS_PER_OPERATION } from "../../runtime/agent-protocol/index.js";
import type { NavigatorRuntime } from "../../runtime/navigator/api.js";
import {
  authoredPageContextTargets,
  authoredPagePredecessorLabel,
  type AuthoredNavigationProjection,
  type AuthoredPagePosition,
} from "../navigation/model.js";

export interface MeasuredAuthoredPages {
  readonly sessionId: ReaderSessionId;
  readonly occurrence: number;
  readonly documentGeneration: number;
  readonly frameGeneration: number;
  readonly layoutGeneration: number;
  readonly positions: readonly AuthoredPagePosition[] | null;
}

interface AuthoredPageMeasurementPort {
  readonly snapshot: KernelSnapshot | null;
  readonly authoredNavigation: AuthoredNavigationProjection;
  readonly runtime: RefObject<NavigatorRuntime | null>;
  readonly sessionId: ReaderSessionId;
}

export function useAuthoredPageMeasurement({
  snapshot,
  authoredNavigation,
  runtime,
  sessionId,
}: AuthoredPageMeasurementPort) {
  const setMeasuredAuthoredPages = useSetAtom(measuredAuthoredPagesAtom);
  const committedDocument = snapshot === null ? null : currentDocument(snapshot);
  const committed = snapshot === null ? null : currentFrame(snapshot);
  const pageContextLayoutGeneration = committedDocument?.layout.layout.layoutGeneration;
  const pageContextTargets = authoredPageContextTargets(
    authoredNavigation,
    committed?.occurrence ?? null,
  );
  const pageContextPredecessorLabel = authoredPagePredecessorLabel(
    authoredNavigation,
    committed?.occurrence ?? null,
  );
  const occurrence = committed?.occurrence ?? null;
  const documentGeneration = committedDocument?.generation;
  const frameGeneration = committed?.generation;
  useEffect(() => {
    const current = runtime.current;
    if (
      current === null ||
      occurrence === null ||
      documentGeneration === undefined ||
      frameGeneration === undefined ||
      pageContextLayoutGeneration === undefined
    ) {
      return;
    }
    // Recomputed here so the effect keys on the listed navigation and occurrence rather than on
    // the identity of the derived array, which is fresh on every snapshot.
    const targets = authoredPageContextTargets(authoredNavigation, occurrence);
    if (
      targets.every(({ request }) =>
        request.evidence.every((evidence) => evidence.kind === "document-boundary"),
      )
    ) {
      return;
    }
    const controller = new AbortController();
    const basis = {
      sessionId,
      occurrence,
      documentGeneration,
      frameGeneration,
      layoutGeneration: pageContextLayoutGeneration,
    };
    void (async () => {
      const positions: AuthoredPagePosition[] = [];
      const requests = targets.map((target) => target.request);
      for (let offset = 0; offset < requests.length; offset += MAX_TOC_TARGETS_PER_OPERATION) {
        const results = await current.measureTocTargets(
          requests.slice(offset, offset + MAX_TOC_TARGETS_PER_OPERATION),
          { signal: controller.signal },
        );
        for (const result of results) {
          if (result.result.state === "located") {
            positions.push({
              listIndex: result.listIndex,
              pointPath: result.pointPath,
              physicalPage: result.result.physicalPage,
            });
          }
        }
      }
      return positions;
    })().then(
      (positions) => {
        if (!controller.signal.aborted) setMeasuredAuthoredPages({ ...basis, positions });
      },
      () => {
        if (!controller.signal.aborted) setMeasuredAuthoredPages({ ...basis, positions: null });
      },
    );
    return () => controller.abort("owner-superseded");
  }, [
    occurrence,
    documentGeneration,
    frameGeneration,
    pageContextLayoutGeneration,
    authoredNavigation,
    sessionId,
    runtime,
    setMeasuredAuthoredPages,
  ]);

  return {
    committedDocument,
    committed,
    pageContextLayoutGeneration,
    pageContextTargets,
    pageContextPredecessorLabel,
  };
}
