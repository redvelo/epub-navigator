import { useAtomValue } from "jotai";
import {
  currentFixedSettlement,
  currentObservation,
  currentPaginatedLayout,
  foregroundLayoutPending,
  pendingDocumentFrame,
} from "../../runtime/kernel-view.js";
import { publicationThemeFallback } from "./preferences.js";
import { navigationIntentAtom } from "../navigation/state.js";
import { activeRuntimeAtom } from "./projection-state.js";
import type {
  CommittedDocument,
  CommittedLayout,
  DocumentAdapter,
  DocumentObservation,
  KernelSnapshot,
  LayoutIssue,
  OccurrenceUnavailableReason,
  PaginatedLayout,
  PendingDocument,
  PhysicalFrame,
  ReflowableLayoutMode,
} from "../../generated/kernel.js";
import type { MountedPublication } from "../../publication.js";
import type { NavigatorReaderPreferences } from "../public-types.js";

export interface DocumentView {
  readonly pending: PendingDocument | null;
  readonly committedLayout: CommittedLayout | null;
  readonly readingOrderLength: number;
  readonly observation: DocumentObservation | null;
  readonly paginatedLayout: PaginatedLayout | null;
  readonly localPagination: {
    readonly firstVisiblePage: number;
    readonly visiblePageCount: number;
    readonly pageCount: number;
  } | null;
  readonly pendingForegroundLayout: boolean;
  readonly foregroundOccurrence: number | null;
  readonly documentAdapter: DocumentAdapter | undefined;
  readonly layoutSettlement: ReflowableLayoutMode | "contain" | "unavailable" | undefined;
  readonly layoutIssue: LayoutIssue | OccurrenceUnavailableReason | undefined;
  readonly presentationMode: ReflowableLayoutMode | "fixed" | "unavailable" | undefined;
  readonly publicationSurround: string;
  readonly publicationCanvasUnavailable: boolean;
  readonly progressionDirection: "ltr" | "rtl";
}

export function useDocumentView({
  snapshot,
  committed,
  committedDocument,
  facts,
  preferences,
}: {
  readonly snapshot: KernelSnapshot | null;
  readonly committed: PhysicalFrame | null;
  readonly committedDocument: CommittedDocument | null;
  readonly facts: MountedPublication["facts"];
  readonly preferences: NavigatorReaderPreferences;
}): DocumentView {
  const navigationIntent = useAtomValue(navigationIntentAtom);
  const activeRuntime = useAtomValue(activeRuntimeAtom);
  const pending = snapshot?.document.pending ?? null;
  const pendingFrame = pending === null ? null : pendingDocumentFrame(pending);
  const observation = snapshot === null ? null : currentObservation(snapshot);
  const paginatedLayout = snapshot === null ? null : currentPaginatedLayout(snapshot);
  const adapterSettlement = committedDocument?.layout.layout?.settlement ?? null;
  const fixedSettlement = snapshot === null ? null : currentFixedSettlement(snapshot);
  const unavailableOccurrence = snapshot?.readingOrder.findIndex(
    (occurrence) => occurrence.document.state === "unavailable",
  );
  const intendedOccurrence =
    navigationIntent !== null && navigationIntent.runtime === activeRuntime
      ? navigationIntent.occurrence
      : null;
  const foregroundOccurrence =
    pendingFrame?.occurrence ??
    committed?.occurrence ??
    intendedOccurrence ??
    (unavailableOccurrence !== undefined && unavailableOccurrence >= 0
      ? unavailableOccurrence
      : null);
  const foregroundTarget =
    foregroundOccurrence === null
      ? null
      : (snapshot?.readingOrder[foregroundOccurrence]?.document ?? null);
  const layoutSettlement =
    adapterSettlement?.adapter === "reflowable-xhtml"
      ? adapterSettlement.settlement.mode
      : adapterSettlement?.adapter === "fixed-xhtml" || adapterSettlement?.adapter === "fixed-svg"
        ? adapterSettlement.settlement.mode
        : foregroundTarget?.state === "unavailable"
          ? "unavailable"
          : undefined;
  const publicationCanvas = observation?.canvas;
  const observedCanvasColor =
    publicationCanvas?.state === "solid-color" ? publicationCanvas.cssColor : undefined;
  const themeCanvasFallback = publicationThemeFallback(preferences.publicationTheme);
  return {
    pending,
    committedLayout: committedDocument?.layout.layout ?? null,
    readingOrderLength: snapshot?.readingOrderLength ?? facts.resources.readingOrder.length,
    observation,
    paginatedLayout,
    localPagination:
      paginatedLayout ??
      (fixedSettlement === null
        ? null
        : { firstVisiblePage: 0, visiblePageCount: 1, pageCount: 1 }),
    pendingForegroundLayout: snapshot !== null && foregroundLayoutPending(snapshot),
    foregroundOccurrence,
    documentAdapter:
      committed?.adapter ??
      pendingFrame?.adapter ??
      (foregroundTarget?.state === "loadable" || foregroundTarget?.state === "unavailable"
        ? (foregroundTarget.adapter ?? undefined)
        : undefined),
    layoutSettlement,
    layoutIssue:
      adapterSettlement?.adapter === "reflowable-xhtml"
        ? (adapterSettlement.notice ?? undefined)
        : foregroundTarget?.state === "unavailable"
          ? foregroundTarget.reason
          : undefined,
    presentationMode:
      adapterSettlement?.adapter === "reflowable-xhtml"
        ? adapterSettlement.settlement.mode
        : adapterSettlement?.adapter === "fixed-xhtml" || adapterSettlement?.adapter === "fixed-svg"
          ? "fixed"
          : layoutSettlement === "unavailable"
            ? "unavailable"
            : undefined,
    publicationSurround:
      preferences.publicationTheme === "original"
        ? (observedCanvasColor ?? themeCanvasFallback)
        : themeCanvasFallback,
    publicationCanvasUnavailable:
      preferences.publicationTheme === "original" &&
      preferences.measure === "wide" &&
      publicationCanvas?.state === "unavailable",
    progressionDirection:
      committed === null
        ? "ltr"
        : facts.resources.readingOrder[committed.occurrence]?.presentation
              .pageProgressionDirection === "rtl"
          ? "rtl"
          : "ltr",
  };
}
