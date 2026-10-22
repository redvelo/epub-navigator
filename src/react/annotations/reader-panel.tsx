import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { recordNavigatorDiagnostic } from "../../runtime/pagination/index.js";
import { AnnotationsPanel } from "../annotations-panel.js";
import {
  activateAnnotationAtom,
  createAnnotationBookmarkAtom,
  deleteAnnotationAtom,
  editAnnotationNoteAtom,
} from "./dispatch.js";
import {
  annotationPositionsAtom,
  annotationRowOperationAtom,
  failedAnnotationDeleteRecordAtom,
} from "./panel-state.js";
import { annotationProjectionAtom, bookmarkCreateAtom, selectedAnnotationIdAtom } from "./state.js";
import { readerRootElementAtom } from "../runtime/projection-state.js";
import type { AnnotationsPanelProps } from "../annotations-panel.js";
import type { NavigatorReaderProps } from "../public-types.js";

/**
 * Connects the presentational panel to the store. Every value it renders and every action it
 * dispatches comes from an atom, so a parent re-render cannot reach it.
 */
export function ReaderAnnotationsPanel({
  availability,
  hostActions,
  diagnostics,
}: {
  readonly availability: NavigatorReaderProps["annotationAvailability"];
  readonly hostActions: AnnotationsPanelProps["hostActions"];
  readonly diagnostics: NavigatorReaderProps["diagnostics"];
}) {
  const renderSequence = useRef(0);
  useEffect(() => {
    renderSequence.current += 1;
    recordNavigatorDiagnostic(diagnostics, {
      type: "annotations-render",
      sequence: renderSequence.current,
    });
  });
  const projection = useAtomValue(annotationProjectionAtom);
  const positions = useAtomValue(annotationPositionsAtom);
  const selectedRecordId = useAtomValue(selectedAnnotationIdAtom);
  const operation = useAtomValue(annotationRowOperationAtom);
  const bookmarkOperation = useAtomValue(bookmarkCreateAtom);
  const failedDeleteRecord = useAtomValue(failedAnnotationDeleteRecordAtom);
  const portalContainer = useAtomValue(readerRootElementAtom);
  const activate = useSetAtom(activateAnnotationAtom);
  const edit = useSetAtom(editAnnotationNoteAtom);
  const remove = useSetAtom(deleteAnnotationAtom);
  const createBookmark = useSetAtom(createAnnotationBookmarkAtom);
  return (
    <AnnotationsPanel
      availability={projection !== undefined ? "available" : (availability ?? "pending")}
      projection={projection}
      positions={positions}
      selectedRecordId={selectedRecordId}
      operation={operation}
      onActivate={activate}
      onEdit={edit}
      onDelete={(record, event) => void remove(record, event)}
      retryDelete={
        failedDeleteRecord === undefined ? null : (event) => void remove(failedDeleteRecord, event)
      }
      bookmarkOperation={bookmarkOperation}
      retryBookmark={
        bookmarkOperation?.status === "failed" ? (event) => void createBookmark(event) : null
      }
      hostActions={hostActions}
      portalContainer={portalContainer}
    />
  );
}
