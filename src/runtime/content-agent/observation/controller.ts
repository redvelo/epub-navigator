import type { AgentActivityMessage, AgentObservationMessage } from "../../agent-protocol/index.js";
import type { ContentAgentState } from "../state.js";
import type { LayoutInvalidationCause } from "../../../generated/kernel.js";
import { CONTENT_AGENT_NAMESPACE } from "../../agent-protocol/index.js";
import type { DocumentGeometry } from "../state.js";
import type { OutboundMessageInput } from "../transport.js";
import { post } from "../transport.js";
import {
  cancelSelectionEdgeGesture,
  restoreNativeSelectionEdgeScroll,
  scheduleSelectionSignal,
} from "../selection/controller.js";
import {
  currentObservationViewport,
  lastSpreadFirstPage,
  observeContentDocument,
  postPaginationDiagnostic,
} from "../layout/pagination-geometry.js";
import { decorationMutationIsRuntimeOwned } from "../decorations.js";
import { mediaOverlayMutationIsRuntimeOwned } from "../media-overlays.js";
import { fragmentationMarkerAttribute } from "../layout/constants.js";
import { invalidateDocumentTextIndex } from "../targets/resolver/text-index.js";
import { observeFixedDocument } from "../targets/resolver/observation.js";
import {
  logicalBlockMetrics,
  normalizedScrollPosition,
  paginatedHoldMutationIsRuntimeOwned,
  paginatedMetrics,
} from "../layout/document-scroll.js";
import { readerStyleAvailable } from "../layout/reader-style.js";

export function installDocumentObservers(state: ContentAgentState): void {
  void state;
  window.addEventListener("pointerdown", () => postForegroundActivity(state, "pointer"), {
    capture: true,
    passive: true,
  });
  window.addEventListener(
    "scroll",
    () => {
      scheduleScrollActivity(state);
      if (state.selection.selectionEdgeViewportTransient) {
        restoreNativeSelectionEdgeScroll(state);
        state.selection.selectionEdgeObservationDeferred = true;
        state.selection.selectionEdgeSignalDeferred = true;
        return;
      }
      if (restoreNativeSelectionEdgeScroll(state)) return;
      advanceSelectionGeometryBasis(state);
      scheduleObservation(state);
      scheduleSelectionSignal(state);
    },
    { passive: true },
  );
  window.addEventListener(
    "resize",
    () => {
      if (state.selection.selectionEdgeViewportTransient) cancelSelectionEdgeGesture(state);
      advanceSelectionGeometryBasis(state);
      if (state.lifecycle.documentAdapter !== "fixed-svg") invalidateDocumentTextIndex(document);
      scheduleObservation(state);
      scheduleSelectionSignal(state);
      // Intrinsic fixed-page sizing is part of the active transaction, not a new
      // outer-viewport change that should supersede that transaction.
      if (state.lifecycle.documentAdapter === "reflowable-xhtml" || !state.layout.applyingLayout) {
        queueLayoutInvalidation(state, "viewport");
      }
    },
    { passive: true },
  );
  window.visualViewport?.addEventListener("scroll", () => selectionGeometryChanged(state), {
    passive: true,
  });
  window.visualViewport?.addEventListener("resize", () => selectionGeometryChanged(state), {
    passive: true,
  });
  document.addEventListener("DOMContentLoaded", () => queueLayoutInvalidation(state, "dom"));
  new MutationObserver((records) => handleMutations(state, records)).observe(document, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => queueGeometryObservation(state));
    resizeObserver.observe(document.documentElement);
    if (document.body !== null) resizeObserver.observe(document.body);
  }
  document.fonts?.addEventListener("loadingdone", () => {
    state.layout.layoutSettlement.recordFontSettlement();
    if (state.lifecycle.documentAdapter !== "fixed-svg") invalidateDocumentTextIndex(document);
    scheduleObservation(state);
    queueLayoutInvalidation(state, "fonts");
  });
  document.fonts?.addEventListener("loadingerror", () => {
    state.layout.layoutSettlement.recordFontSettlement();
    if (state.lifecycle.documentAdapter !== "fixed-svg") invalidateDocumentTextIndex(document);
    scheduleObservation(state);
    queueLayoutInvalidation(state, "fonts");
  });
  for (const type of ["load", "error", "loadedmetadata"] as const) {
    document.addEventListener(type, (event) => handleResourceSettlement(state, event), true);
  }
}

export function scheduleScrollActivity(state: ContentAgentState): void {
  void state;
  if (
    state.observation.scrollActivityScheduled ||
    !state.lifecycle.initialized ||
    state.lifecycle.agentRole !== "foreground"
  )
    return;
  state.observation.scrollActivityScheduled = true;
  requestAnimationFrame(() => {
    state.observation.scrollActivityScheduled = false;
    postForegroundActivity(state, "scroll");
  });
}

export function postForegroundActivity(
  state: ContentAgentState,
  activity: AgentActivityMessage["activity"],
): void {
  void state;
  if (!state.lifecycle.initialized || state.lifecycle.agentRole !== "foreground") return;
  post(state, {
    namespace: CONTENT_AGENT_NAMESPACE,
    type: "activity",
    activity,
  } satisfies OutboundMessageInput<AgentActivityMessage>);
}

export function advanceSelectionGeometryBasis(state: ContentAgentState): void {
  void state;
  state.selection.selectionGeometryBasis = Math.min(
    4294967295,
    state.selection.selectionGeometryBasis + 1,
  );
}

export function selectionGeometryChanged(state: ContentAgentState): void {
  void state;
  if (state.selection.selectionEdgeViewportTransient) {
    state.selection.selectionEdgeSignalDeferred = true;
    return;
  }
  advanceSelectionGeometryBasis(state);
  scheduleSelectionSignal(state);
}

export function handleResourceSettlement(state: ContentAgentState, event: Event): void {
  void state;
  if (state.lifecycle.documentAdapter === "fixed-svg") {
    if (event.type === "error") state.layout.staticSvgRequiredResources = "failed";
    scheduleObservation(state);
    if (!state.layout.applyingLayout) queueLayoutInvalidation(state, "dom");
    return;
  }
  state.layout.layoutSettlement.recordResourceSettlement(event);
  const target = event.target instanceof Element ? event.target : null;
  if (
    target?.localName === "link" &&
    target.getAttribute("rel")?.toLowerCase().split(/\s+/u).includes("stylesheet")
  ) {
    queueLayoutInvalidation(state, "stylesheet-link");
    return;
  }
  if (
    target === null ||
    (target.localName !== "img" && target.localName !== "video" && target.localName !== "object")
  ) {
    return;
  }
  invalidateDocumentTextIndex(document);
  scheduleObservation(state);
  if (state.layout.applyingLayout) return;
  queueLayoutInvalidation(state, "dom");
}

export function queueGeometryObservation(state: ContentAgentState): void {
  void state;
  advanceSelectionGeometryBasis(state);
  if (state.lifecycle.documentAdapter !== "fixed-svg") invalidateDocumentTextIndex(document);
  scheduleObservation(state);
  if (state.observation.geometryObservationScheduled) return;
  state.observation.geometryObservationScheduled = true;
  requestAnimationFrame(() => {
    state.observation.geometryObservationScheduled = false;
    const geometry = captureDocumentGeometry(state);
    if (state.layout.applyingLayout || state.observation.committedGeometry === null) return;
    if (!sameDocumentGeometry(state, geometry, state.observation.committedGeometry))
      queueLayoutInvalidation(state, "dom");
    else scheduleSelectionSignal(state);
  });
}

export function captureDocumentGeometry(state: ContentAgentState): DocumentGeometry {
  void state;
  const root = document.documentElement;
  const content = document.scrollingElement ?? root;
  const rectangle = root.getBoundingClientRect();
  return {
    rootWidth: rectangle.width,
    rootHeight: rectangle.height,
    contentWidth: content.scrollWidth,
    contentHeight: content.scrollHeight,
  };
}

export function sameDocumentGeometry(
  state: ContentAgentState,
  left: DocumentGeometry,
  right: DocumentGeometry,
): boolean {
  void state;
  return (
    Math.abs(left.rootWidth - right.rootWidth) <= 1 &&
    Math.abs(left.rootHeight - right.rootHeight) <= 1 &&
    Math.abs(left.contentWidth - right.contentWidth) <= 1 &&
    Math.abs(left.contentHeight - right.contentHeight) <= 1
  );
}

export function handleMutations(state: ContentAgentState, records: MutationRecord[]): void {
  void state;
  const external = records.filter((record) => !mutationIsAgentStyle(state, record));
  if (external.length === 0) return;
  if (state.lifecycle.documentAdapter !== "fixed-svg") invalidateDocumentTextIndex(document);
  scheduleObservation(state);
  const cause = external.reduce<LayoutInvalidationCause>(
    (selected, record) => mutationCause(state, record) ?? selected,
    "dom",
  );
  queueLayoutInvalidation(state, cause);
}

export function mutationIsAgentStyle(state: ContentAgentState, record: MutationRecord): boolean {
  void state;
  // This marker records a host image measurement; changing it cannot change image geometry.
  if (
    state.lifecycle.documentAdapter === "fixed-image" &&
    record.type === "attributes" &&
    record.target === document.documentElement &&
    record.attributeName === "data-epub-navigator-viewport-source" &&
    document.documentElement.getAttribute(record.attributeName) === "image-natural"
  )
    return true;
  if (decorationMutationIsRuntimeOwned(document, record)) return true;
  if (mediaOverlayMutationIsRuntimeOwned(document, record)) return true;
  if (paginatedHoldMutationIsRuntimeOwned(document, record)) return true;
  if (
    record.type === "childList" &&
    [...record.addedNodes, ...record.removedNodes].length > 0 &&
    [...record.addedNodes, ...record.removedNodes].every((node) =>
      state.activation.footnoteFocusAids.has(node),
    )
  ) {
    return true;
  }
  if (
    record.type === "attributes" &&
    record.attributeName === fragmentationMarkerAttribute &&
    record.target instanceof Element
  ) {
    const activeMarker = state.layout.activeFragmentationMarkers.get(record.target);
    if (
      activeMarker !== undefined &&
      record.target.getAttribute(fragmentationMarkerAttribute) === activeMarker
    ) {
      return true;
    }
    const removed = state.layout.removedFragmentationMarkers.get(record.target);
    if (
      removed !== undefined &&
      record.oldValue === removed &&
      !record.target.hasAttribute(fragmentationMarkerAttribute)
    ) {
      state.layout.removedFragmentationMarkers.delete(record.target);
      return true;
    }
  }
  if (
    state.layout.readerStyle !== null &&
    record.type === "childList" &&
    [...record.removedNodes].some((node) => node === state.layout.readerStyle)
  )
    return false;
  if (
    state.layout.readerStyle !== null &&
    (record.target === state.layout.readerStyle || state.layout.readerStyle.contains(record.target))
  ) {
    return readerStyleAvailable(state);
  }
  return (
    state.layout.readerStyle !== null &&
    record.type === "childList" &&
    [...record.addedNodes, ...record.removedNodes].every(
      (node) => node === state.layout.readerStyle,
    )
  );
}

export function mutationCause(
  state: ContentAgentState,
  record: MutationRecord,
): LayoutInvalidationCause | null {
  void state;
  const element = record.target instanceof Element ? record.target : record.target.parentElement;
  if (
    state.layout.readerStyle !== null &&
    record.type === "childList" &&
    [...record.removedNodes].some((node) => node === state.layout.readerStyle)
  )
    return "agent-style";
  if (element === state.layout.readerStyle) return "agent-style";
  if (element?.localName === "style") return "style-element";
  if (
    element?.localName === "link" &&
    element.getAttribute("rel")?.toLowerCase().split(/\s+/u).includes("stylesheet")
  )
    return "stylesheet-link";
  if (record.type === "attributes") {
    if (
      record.attributeName === "dir" ||
      record.attributeName === "writing-mode" ||
      (record.attributeName === "style" &&
        (element === document.documentElement || element === document.body))
    )
      return "writing-mode";
    return "attributes";
  }
  return "dom";
}

export function queueLayoutInvalidation(
  state: ContentAgentState,
  cause: LayoutInvalidationCause,
): void {
  void state;
  cancelSelectionEdgeGesture(state, true);
  if (state.lifecycle.documentAdapter !== "fixed-svg") invalidateDocumentTextIndex(document);
  if (state.layout.applyingLayout) {
    requestLayoutReapply(state, cause);
    return;
  }
  if (state.layout.settledLayout === null && state.layout.fixedSettlement === null) return;
  state.layout.invalidationCause = state.layout.invalidationCause ?? cause;
  if (state.layout.layoutInvalidationPending) return;
  state.layout.layoutInvalidationPending = true;
  state.layout.layoutToken += 1;
  state.layout.applyingLayout = false;
  state.layout.activePresentation = null;
  if (state.layout.invalidationScheduled || !state.lifecycle.initialized) return;
  state.layout.invalidationScheduled = true;
  requestAnimationFrame(() => {
    state.layout.invalidationScheduled = false;
    const pending = state.layout.invalidationCause;
    state.layout.invalidationCause = null;
    if (pending !== null) {
      post(state, {
        namespace: CONTENT_AGENT_NAMESPACE,
        type: "layout-invalidated",
        cause: pending,
      });
    }
  });
}

export function flushPendingLayoutInvalidation(state: ContentAgentState): boolean {
  void state;
  if (!state.layout.layoutInvalidationPending || state.layout.invalidationCause === null)
    return false;
  const pending = state.layout.invalidationCause;
  state.layout.invalidationCause = null;
  state.layout.invalidationScheduled = false;
  post(state, { namespace: CONTENT_AGENT_NAMESPACE, type: "layout-invalidated", cause: pending });
  return true;
}

export function requestLayoutReapply(
  state: ContentAgentState,
  cause: LayoutInvalidationCause,
): void {
  void state;
  state.layout.layoutInvalidationVersion += 1;
  state.layout.layoutReapplyRequested = true;
  state.layout.activeLayoutInvalidationCause ??= cause;
}

export function consumeLayoutReapplyRequest(state: ContentAgentState): void {
  void state;
  state.layout.layoutReapplyRequested = false;
  state.layout.activeLayoutInvalidationCause = null;
}

export function scheduleObservation(state: ContentAgentState): void {
  void state;
  if (state.lifecycle.agentRole !== "foreground") return;
  if (state.selection.selectionEdgeViewportTransient) {
    state.selection.selectionEdgeObservationDeferred = true;
    return;
  }
  if (state.layout.applyingLayout) {
    state.observation.observationDeferred = true;
    return;
  }
  state.observation.invalidation += 1;
  if (state.observation.observationScheduled) return;
  state.observation.observationScheduled = true;
  // After the next frame has been committed, not inside it: a page turn has already scrolled,
  // and the observation's forced layout reads must not delay that frame's paint (e-ink shows
  // every frame late already).
  requestAnimationFrame(() => {
    setTimeout(() => emitObservation(state, state.observation.invalidation), 0);
  });
}

export function emitObservation(state: ContentAgentState, token: number): void {
  void state;
  state.observation.observationScheduled = false;
  try {
    if (state.selection.selectionEdgeViewportTransient) {
      state.selection.selectionEdgeObservationDeferred = true;
      return;
    }
    if (state.layout.applyingLayout) {
      state.observation.observationDeferred = true;
      return;
    }
    if (token !== state.observation.invalidation) {
      scheduleObservation(state);
      return;
    }
    const observationStarted = state.lifecycle.diagnosticsEnabled ? performance.now() : 0;
    const adapter = state.lifecycle.documentAdapter;
    const observation =
      adapter === "fixed-xhtml" || adapter === "fixed-svg" || adapter === "fixed-image"
        ? observeFixedDocument(document, adapter)
        : {
            ...observeContentDocument(state, currentObservationViewport(state)),
            layoutProgression: observeDocumentScrollProgression(state),
            pagination: observePaginationPosition(state),
          };
    if (state.lifecycle.diagnosticsEnabled)
      postPaginationDiagnostic(
        state,
        "live-observation",
        performance.now() - observationStarted,
        0,
        0,
      );
    if (token !== state.observation.invalidation) {
      scheduleObservation(state);
      return;
    }
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "observation",
      ...observation,
    } satisfies OutboundMessageInput<AgentObservationMessage>);
  } catch {
    // A later invalidation retries observation; operational requests still remain available.
  }
}

/**
 * Where a scrolled document currently sits, as its normalized block-scroll position.
 *
 * Reported only for a settled document-scroll layout: a paginated document reports its
 * position through the pagination observation instead.
 */
export function observeDocumentScrollProgression(state: ContentAgentState): number | null {
  void state;
  const current = state.layout.settledLayout;
  if (current === null || current.settlement.mode !== "document-scroll") return null;
  const metrics = logicalBlockMetrics(
    document,
    current.settlement.measurement.observation.writingMode,
  );
  if (metrics === null) return null;
  return normalizedScrollPosition(metrics.position, metrics.maximum);
}

export function observePaginationPosition(
  state: ContentAgentState,
): AgentObservationMessage["pagination"] {
  void state;
  const current = state.layout.settledLayout;
  if (current === null || current.settlement.mode !== "paginated") return null;
  const stored = current.settlement.pages;
  const metrics = paginatedMetrics(
    document,
    current.settlement.measurement.observation.writingMode,
    current.settlement.measurement.observation.direction,
  );
  if (metrics === null) return null;
  const currentSpread = Math.max(0, Math.round(metrics.position / stored.spreadStride));
  const liveLastSpread = Math.max(0, Math.round(metrics.maximum / stored.spreadStride));
  const committedLastSpread = Math.max(0, Math.ceil(stored.pageCount / stored.columnsPerView) - 1);
  if (liveLastSpread !== committedLastSpread) queueLayoutInvalidation(state, "dom");
  const lastFirstVisiblePage = lastSpreadFirstPage(state, stored);
  const pageCount = stored.pageCount;
  const firstVisiblePage = Math.min(lastFirstVisiblePage, currentSpread * stored.columnsPerView);
  return {
    firstVisiblePage,
    pageCount,
    visiblePageCount: Math.min(stored.columnsPerView, pageCount - firstVisiblePage),
  };
}
