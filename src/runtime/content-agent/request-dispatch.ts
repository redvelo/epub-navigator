import type {
  AgentDocumentObservationResultMessage,
  AgentAnnotationPointTargetGenerationResultMessage,
  AgentAnnotationRangeAdjustmentResultMessage,
  AgentAnnotationTargetGenerationResultMessage,
  AgentDecorationResultMessage,
  AgentFootnoteReturnedMessage,
  AgentMediaOverlayActiveAppliedMessage,
  AgentReadyMessage,
  AgentResultMessage,
  AgentRoleChangedMessage,
  AgentSelectionResultMessage,
  AgentTocTargetsResultMessage,
} from "../agent-protocol/index.js";
import type { ContentAgentState } from "./state.js";
import type {
  DecorationRecordResult,
  LayoutResult,
  PublicationTheme,
} from "../../generated/kernel.js";
import { resolveAnnotationTargetInDocument } from "./targets/resolver/annotation.js";
import {
  relocateAnnotationTargetInDocument,
  relocateLocatorInDocument,
  resolveLocatorInDocument,
} from "./targets/resolver/locator.js";
import { documentTextGeneration } from "./targets/resolver/text-index.js";
import {
  hasVisibleReplacedContentWithoutRenderedText,
  observeFixedDocument,
} from "./targets/resolver/observation.js";
import {
  ANNOTATION_RESOLUTION_YIELD_WORK_UNITS,
  MAX_TOC_RESOLUTION_WORK_UNITS,
} from "./targets/resolver/types.js";
import {
  CONTENT_AGENT_NAMESPACE,
  CONTENT_AGENT_PROTOCOL_VERSION,
  normalizeAgentCancelOperation,
  normalizeAgentClearSelection,
  normalizeAgentRelease,
  normalizeAgentConfigure,
  normalizeAgentFixedViewportApplied,
  normalizeAgentInitialize,
  normalizeAgentSetMediaOverlayActive,
  normalizeAgentRequest,
  normalizeAgentReturnFromFootnote,
  normalizeAgentSetActiveDecoration,
  normalizeAgentSetRole,
} from "../agent-protocol/index.js";
import { OperationCancelled, ensureActive } from "./operation-queue.js";
import type { OutboundMessageInput } from "./transport.js";
import { post } from "./transport.js";
import {
  adjustCommittedDecorationRange,
  applyDecorationProjection,
  committedDecorationIsCurrent,
  decorationApiAvailable,
  reconcileDecorationProjection,
  setActiveDecoration,
} from "./decorations.js";
import {
  advancePresentationWithinDocument,
  releaseWhenTouchIdle,
} from "./interaction/controller.js";
import { findMediaOverlayEntry, setMediaOverlayActive } from "./media-overlays.js";
import {
  annotationTargetResult,
  captureDocumentStyleBasis,
  captureRangeScrollRollback,
  unavailableAnnotationTarget,
  unsupportedAnnotationTarget,
} from "./targets/annotation.js";
import { captureSelectionOutcome, selectionCaptureBasis } from "./selection/capture.js";
import { resolveStaticSvgLocator } from "./targets/locator.js";
import { applyConfiguration, installReaderStyle } from "./layout/reader-style.js";
import { cancelSelectionEdgeGesture, scheduleSelectionSignal } from "./selection/controller.js";
import { clearFootnoteNavigation, returnFromFootnote } from "./activation/controller.js";
import {
  currentObservationViewport,
  observeContentDocument,
} from "./layout/pagination-geometry.js";
import {
  flushPendingLayoutInvalidation,
  installDocumentObservers,
  observeDocumentScrollProgression,
  scheduleObservation,
} from "./observation/controller.js";
import {
  generateVerifiedAnnotationPointCandidate,
  generateVerifiedAnnotationRangeCandidate,
} from "./targets/annotation-range-candidate.js";
import { measureTocTargets } from "./targets/measurement.js";
import { observeDocument } from "./document-observation.js";
import { nextFrame } from "./layout-settlement.js";
import { runFixedLayoutTransaction } from "./layout/fixed-transaction.js";
import { runReflowLayoutTransaction } from "./layout/reflow-transaction.js";
import { postRequestFailure } from "./result-failures.js";
import { postReaderSerifFontEvidence } from "./layout/font-evidence.js";
import type {
  AnnotationPointTargetGenerationCandidateStatus,
  AnnotationTargetGenerationCandidate,
  AnnotationTargetGenerationCandidateStatus,
} from "../../generated/kernel.js";
import type { AgentDocumentLocationCaptureOutcome } from "../agent-protocol/index.js";

/**
 * Whether narration can mark this document. A fixed page and an SVG document both have elements
 * that carry a class, so they bind the way a reflowing document does. An image page has nothing
 * to mark: it is one picture, with no element a reference can name.
 */
function narratableDocument(state: ContentAgentState): boolean {
  const adapter = state.lifecycle.documentAdapter;
  return adapter !== "fixed-image";
}

/**
 * The palette the document is being shown with. `activePresentation` holds only a layout still
 * in flight and is cleared once it settles, so the settled layout is what the reader is looking
 * at; a document with neither is being shown as the publication wrote it.
 */
function narrationTheme(state: ContentAgentState): PublicationTheme {
  return (
    state.layout.settledLayout?.presentation.theme ??
    state.layout.activePresentation?.theme ??
    "original"
  );
}

/** Whether the layout this document is measured against has settled, per adapter. */
function narrationLayoutSettled(state: ContentAgentState): boolean {
  if (state.layout.applyingLayout || state.layout.layoutInvalidationPending) return false;
  return state.lifecycle.documentAdapter === "reflowable-xhtml"
    ? state.layout.settledLayout !== null
    : state.layout.fixedSettlement !== null;
}

export function installRequestDispatch(state: ContentAgentState): void {
  window.addEventListener("message", (event) => {
    if (!state.lifecycle.initialized) {
      if (event.source !== window.parent) return;
      const initialize = normalizeAgentInitialize(event.data);
      if (initialize === null || event.source === null || !("postMessage" in event.source)) return;
      state.transport.reader = event.source;
      state.transport.readerOrigin = event.origin;
      state.transport.protocolSession = initialize.session;
      state.lifecycle.initialized = true;
      state.lifecycle.documentAdapter = initialize.adapter;
      state.lifecycle.agentRole = initialize.role;
      state.lifecycle.diagnosticsEnabled = initialize.diagnostics;
      state.lifecycle.observationEnabled = initialize.observation;
      if (initialize.adapter !== "fixed-svg") state.layout.readerStyle = installReaderStyle(state);
      applyConfiguration(state, initialize.configuration);
      installDocumentObservers(state);
      post(state, {
        namespace: CONTENT_AGENT_NAMESPACE,
        type: "ready",
        protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION,
        adapter: initialize.adapter,
        supportedOperations: [
          "resolve-locator",
          "relocate",
          "resolve-annotation-target",
          "relocate-annotation-target",
          "capture-selection",
          "capture-current-location",
          "generate-annotation-target",
          "generate-current-location-annotation-target",
          "advance-presentation",
          "layout",
          ...(initialize.adapter === "fixed-image" ? [] : (["measure-toc-targets"] as const)),
          ...(initialize.observation ? (["observe-document"] as const) : []),
          ...(initialize.adapter === "reflowable-xhtml" && decorationApiAvailable(document)
            ? (["reconcile-decorations", "adjust-annotation-range"] as const)
            : []),
          ...(initialize.adapter === "fixed-image" ? [] : (["find-media-overlay-entry"] as const)),
        ],
      } satisfies OutboundMessageInput<AgentReadyMessage>);
      scheduleObservation(state);
      return;
    }
    if (event.source !== state.transport.reader || event.origin !== state.transport.readerOrigin)
      return;
    const role = normalizeAgentSetRole(event.data);
    if (role !== null && role.session === state.transport.protocolSession) {
      state.operations.operationQueue.enqueue(() => {
        if (role.role === "foreground" && flushPendingLayoutInvalidation(state)) return;
        applyConfiguration(state, role.configuration);
        if (role.role !== "foreground") {
          cancelSelectionEdgeGesture(state, true);
          clearFootnoteNavigation(state);
        }
        state.lifecycle.agentRole = role.role;
        post(state, {
          namespace: CONTENT_AGENT_NAMESPACE,
          type: "role-changed",
          role: role.role,
          roleChange: role.roleChange,
        } satisfies OutboundMessageInput<AgentRoleChangedMessage>);
        scheduleObservation(state);
        if (role.role === "foreground" && state.selection.selectionEdgeSignalDeferred) {
          state.selection.selectionEdgeSignalDeferred = false;
          scheduleSelectionSignal(state);
        }
      });
      return;
    }
    const configure = normalizeAgentConfigure(event.data);
    if (configure !== null && configure.session === state.transport.protocolSession) {
      state.operations.operationQueue.enqueue(() =>
        applyConfiguration(state, configure.configuration),
      );
      return;
    }
    const release = normalizeAgentRelease(event.data);
    if (release !== null && release.session === state.transport.protocolSession) {
      releaseWhenTouchIdle(state);
      return;
    }
    const clearSelection = normalizeAgentClearSelection(event.data);
    if (clearSelection !== null && clearSelection.session === state.transport.protocolSession) {
      cancelSelectionEdgeGesture(state);
      window.getSelection()?.removeAllRanges();
      scheduleSelectionSignal(state);
      return;
    }
    const footnoteReturn = normalizeAgentReturnFromFootnote(event.data);
    if (footnoteReturn !== null && footnoteReturn.session === state.transport.protocolSession) {
      const status = returnFromFootnote(state, footnoteReturn.activationId);
      post(state, {
        namespace: CONTENT_AGENT_NAMESPACE,
        type: "footnote-returned",
        activationId: footnoteReturn.activationId,
        status,
      } satisfies OutboundMessageInput<AgentFootnoteReturnedMessage>);
      return;
    }
    const mediaOverlayActive = normalizeAgentSetMediaOverlayActive(event.data);
    if (
      mediaOverlayActive !== null &&
      mediaOverlayActive.session === state.transport.protocolSession
    ) {
      const applied = narratableDocument(state)
        ? setMediaOverlayActive(document, mediaOverlayActive, narrationTheme(state))
        : { status: "unsupported" as const, visible: false };
      post(state, {
        namespace: CONTENT_AGENT_NAMESPACE,
        type: "media-overlay-active-applied",
        commandId: mediaOverlayActive.commandId,
        ...applied,
      } satisfies OutboundMessageInput<AgentMediaOverlayActiveAppliedMessage>);
      return;
    }
    const activeDecoration = normalizeAgentSetActiveDecoration(event.data);
    if (activeDecoration !== null && activeDecoration.session === state.transport.protocolSession) {
      setActiveDecoration(document, activeDecoration.projectionRevision, activeDecoration.id);
      return;
    }
    const cancellation = normalizeAgentCancelOperation(event.data);
    if (cancellation !== null && cancellation.session === state.transport.protocolSession) {
      state.operations.operationQueue.cancel(cancellation.operationType, cancellation.operation);
      return;
    }
    const fixedViewport = normalizeAgentFixedViewportApplied(event.data);
    if (fixedViewport !== null && fixedViewport.session === state.transport.protocolSession) {
      const pending = state.layout.pendingFixedViewportApplication;
      if (pending?.operation === fixedViewport.operation) {
        state.layout.pendingFixedViewportApplication = null;
        pending.resolve(fixedViewport);
      }
      return;
    }
    const request = normalizeAgentRequest(event.data);
    if (request === null || request.session !== state.transport.protocolSession) return;
    const work = state.operations.operationQueue.begin(request.request.type, request.operation);
    if (work === null) return;
    state.operations.operationQueue.enqueue(async () => {
      try {
        ensureActive(work);
        if (request.request.type === "layout") {
          if (request.request.adapter !== state.lifecycle.documentAdapter) return;
          let result: LayoutResult | null;
          if (request.request.adapter === "reflowable-xhtml") {
            const outcome = await runReflowLayoutTransaction(
              state,
              request.request.presentation,
              request.request.position,
              work,
            );
            result = outcome === null ? null : { adapter: "reflowable-xhtml", outcome };
          } else {
            result = await runFixedLayoutTransaction(
              state,
              request.operation,
              work,
              request.request.adapter,
            );
          }
          ensureActive(work);
          if (result !== null) {
            post(state, {
              namespace: CONTENT_AGENT_NAMESPACE,
              type: "result",
              operation: request.operation,
              resultType: "layout",
              result,
            } satisfies OutboundMessageInput<AgentResultMessage>);
            if (
              request.request.adapter === "reflowable-xhtml" &&
              result.adapter === "reflowable-xhtml" &&
              result.outcome.status === "settled"
            ) {
              void postReaderSerifFontEvidence(
                state,
                request.request.presentation,
                state.layout.layoutToken,
              );
            }
          }
        } else if (request.request.type === "advance-presentation") {
          // The reader's page zones and its own page commands move the text, not the reading
          // order, so they advance along the block axis.
          const status = advancePresentationWithinDocument(
            state,
            request.request.direction,
            "block",
          );
          ensureActive(work);
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: "advance-presentation",
            status,
          } satisfies OutboundMessageInput<AgentResultMessage>);
        } else if (
          request.request.type === "resolve-annotation-target" ||
          request.request.type === "relocate-annotation-target"
        ) {
          const contentGeneration = documentTextGeneration(document);
          const styleBasis = captureDocumentStyleBasis(state, document);
          const relocation = { rollback: null as (() => void) | null };
          const resolverWork = {
            signal: work.controller.signal,
            maximumWorkUnits: MAX_TOC_RESOLUTION_WORK_UNITS,
            yieldEveryWorkUnits: ANNOTATION_RESOLUTION_YIELD_WORK_UNITS,
            isCurrent: () =>
              documentTextGeneration(document) === contentGeneration &&
              captureDocumentStyleBasis(state, document) === styleBasis,
          };
          const resolution =
            styleBasis === null
              ? unavailableAnnotationTarget(
                  request.request.plan.selectors,
                  "document style state is too large to verify coherently",
                )
              : state.lifecycle.documentAdapter !== "reflowable-xhtml"
                ? unsupportedAnnotationTarget(request.request.plan.selectors)
                : request.request.type === "resolve-annotation-target"
                  ? await resolveAnnotationTargetInDocument(
                      document,
                      request.request.plan,
                      resolverWork,
                    )
                  : await relocateAnnotationTargetInDocument(
                      document,
                      request.request.plan,
                      resolverWork,
                      state.layout.settledLayout?.presentation.mode === "paginated"
                        ? {
                            mode: "paginated",
                            spreadStride:
                              state.layout.settledLayout.settlement.mode === "paginated"
                                ? state.layout.settledLayout.settlement.pages.spreadStride
                                : undefined,
                          }
                        : { mode: "document-scroll" },
                      (range) => {
                        relocation.rollback = captureRangeScrollRollback(document, range);
                        return relocation.rollback;
                      },
                    );
          if (
            request.request.type === "relocate-annotation-target" &&
            resolution.outcome === "resolved"
          ) {
            await nextFrame();
          }
          try {
            ensureActive(work);
          } catch (cause) {
            relocation.rollback?.();
            throw cause;
          }
          const current =
            documentTextGeneration(document) === contentGeneration &&
            captureDocumentStyleBasis(state, document) === styleBasis;
          if (!current) relocation.rollback?.();
          const coherentResolution = current
            ? resolution
            : {
                ...resolution,
                outcome: "stale" as const,
                reports: resolution.reports.map((report) => ({
                  ...report,
                  outcome: "stale" as const,
                  message: "document content changed during annotation resolution",
                })),
                segmentKind: null,
                range: null,
              };
          const result = annotationTargetResult(request.request.plan.resource, coherentResolution);
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: request.request.type,
            result,
          } satisfies OutboundMessageInput<AgentResultMessage>);
          if (
            request.request.type === "relocate-annotation-target" &&
            result.outcome === "resolved"
          ) {
            scheduleObservation(state);
          }
        } else if (request.request.type === "reconcile-decorations") {
          const contentGeneration = documentTextGeneration(document);
          const styleBasis = captureDocumentStyleBasis(state, document);
          let outcomes: readonly DecorationRecordResult[];
          if (state.lifecycle.documentAdapter !== "reflowable-xhtml") {
            outcomes = request.request.records.map(({ id }) => ({
              id,
              outcome: { status: "unsupported" },
            }));
          } else if (styleBasis === null && request.request.records.length > 0) {
            applyDecorationProjection(document, [], request.request.projectionRevision);
            outcomes = request.request.records.map(({ id }) => ({
              id,
              outcome: {
                status: "unavailable",
                message: "document style state is too large to verify coherently",
              },
            }));
          } else {
            outcomes = await reconcileDecorationProjection(
              document,
              request.request.projectionRevision,
              request.request.records,
              {
                signal: work.controller.signal,
                maximumWorkUnits: MAX_TOC_RESOLUTION_WORK_UNITS,
                yieldEveryWorkUnits: ANNOTATION_RESOLUTION_YIELD_WORK_UNITS,
                isCurrent: () =>
                  documentTextGeneration(document) === contentGeneration &&
                  captureDocumentStyleBasis(state, document) === styleBasis,
              },
            );
          }
          ensureActive(work);
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: "reconcile-decorations",
            projectionRevision: request.request.projectionRevision,
            outcomes,
          } satisfies OutboundMessageInput<AgentDecorationResultMessage>);
        } else if (request.request.type === "generate-annotation-target") {
          const { localContentBasis, textFragmentPolicy } = request.request;
          const generation = await generateVerifiedAnnotationRangeCandidate(
            document,
            { evidence: request.request.target.evidence },
            state.targets.annotationAuthoredProvenance,
            {
              expectedDocumentTextGeneration: localContentBasis,
              isCurrent: () =>
                !work.controller.signal.aborted &&
                documentTextGeneration(document) === localContentBasis,
            },
            textFragmentPolicy === "include",
          );
          ensureActive(work);
          const status: AnnotationTargetGenerationCandidate["status"] =
            generation.status === "generated"
              ? {
                  status: "generated",
                  selectors: {
                    css: generation.candidate.css,
                    document: generation.candidate.document,
                    textFragment: generation.candidate.textFragment ?? null,
                  },
                }
              : generation;
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: "generate-annotation-target",
            candidate: { localContentBasis, textFragmentPolicy, status },
          } satisfies OutboundMessageInput<AgentAnnotationTargetGenerationResultMessage>);
        } else if (request.request.type === "generate-current-location-annotation-target") {
          const { localContentBasis } = request.request;
          const wholeResource =
            state.lifecycle.documentAdapter !== "reflowable-xhtml" ||
            (request.request.target.evidence.some(
              (evidence) => evidence.kind === "document-boundary",
            ) &&
              hasVisibleReplacedContentWithoutRenderedText(document));
          const generation = !wholeResource
            ? await generateVerifiedAnnotationPointCandidate(
                document,
                request.request.target.evidence,
                state.targets.annotationAuthoredProvenance,
                {
                  expectedDocumentTextGeneration: localContentBasis,
                  isCurrent: () =>
                    !work.controller.signal.aborted &&
                    documentTextGeneration(document) === localContentBasis,
                },
              )
            : ({
                status: "generated",
                candidate: { css: null, document: null },
              } as const);
          ensureActive(work);
          const status: AnnotationPointTargetGenerationCandidateStatus =
            generation.status === "generated"
              ? {
                  status: "generated",
                  selectors: {
                    css: generation.candidate.css,
                    document: generation.candidate.document,
                    wholeResource,
                  },
                }
              : generation;
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: "generate-current-location-annotation-target",
            candidate: { localContentBasis, status },
          } satisfies OutboundMessageInput<AgentAnnotationPointTargetGenerationResultMessage>);
        } else if (request.request.type === "adjust-annotation-range") {
          const { projectionRevision, recordId, edge, movement } = request.request;
          const adjustment = adjustCommittedDecorationRange(
            document,
            projectionRevision,
            recordId,
            edge,
            movement,
          );
          let status: AnnotationTargetGenerationCandidateStatus;
          let excerpt: string | null = null;
          if (adjustment.status === "adjusted") {
            const localContentBasis = documentTextGeneration(document);
            const generation = await generateVerifiedAnnotationRangeCandidate(
              document,
              { range: adjustment.range },
              state.targets.annotationAuthoredProvenance,
              {
                expectedDocumentTextGeneration: localContentBasis,
                isCurrent: () =>
                  !work.controller.signal.aborted &&
                  documentTextGeneration(document) === localContentBasis &&
                  committedDecorationIsCurrent(document, projectionRevision, recordId),
              },
              false,
            );
            status =
              generation.status === "generated"
                ? {
                    status: "generated",
                    selectors: {
                      css: generation.candidate.css,
                      document: generation.candidate.document,
                      textFragment: null,
                    },
                  }
                : generation;
            if (generation.status === "generated") excerpt = adjustment.excerpt;
          } else if (adjustment.status === "unavailable") {
            status = { status: "unavailable", reason: "no-exact-movement" };
          } else {
            status = { status: adjustment.status };
          }
          ensureActive(work);
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: "adjust-annotation-range",
            candidate: { projectionRevision, recordId, edge, movement, status, excerpt },
          } satisfies OutboundMessageInput<AgentAnnotationRangeAdjustmentResultMessage>);
        } else if (request.request.type === "capture-selection") {
          const outcome = captureSelectionOutcome(state);
          ensureActive(work);
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: "capture-selection",
            outcome,
          } satisfies OutboundMessageInput<AgentSelectionResultMessage>);
        } else if (request.request.type === "capture-current-location") {
          const basis = selectionCaptureBasis(state);
          let outcome: AgentDocumentLocationCaptureOutcome;
          if (
            state.layout.applyingLayout ||
            state.layout.layoutInvalidationPending ||
            (state.layout.settledLayout === null && state.layout.fixedSettlement === null)
          ) {
            outcome = { status: "unavailable", basis };
          } else {
            try {
              const adapter = state.lifecycle.documentAdapter;
              const observation =
                adapter === "fixed-xhtml" || adapter === "fixed-svg" || adapter === "fixed-image"
                  ? observeFixedDocument(document, adapter)
                  : observeContentDocument(state, currentObservationViewport(state), true);
              const currentBasis = selectionCaptureBasis(state);
              const boundary =
                observation.visibleStart.state === "located"
                  ? observation.visibleStart
                  : observation.visibleEnd.state === "located"
                    ? observation.visibleEnd
                    : null;
              if (
                currentBasis.localContentBasis !== basis.localContentBasis ||
                currentBasis.localGeometryBasis !== basis.localGeometryBasis
              ) {
                outcome = { status: "stale", basis };
              } else if (boundary !== null) {
                outcome = {
                  status: "captured",
                  evidence: boundary.evidence,
                  observation: {
                    layoutProgression: observeDocumentScrollProgression(state),
                    renderedTextProgression: observation.renderedTextProgression,
                  },
                  basis,
                };
              } else {
                outcome = { status: "unavailable", basis };
              }
            } catch (cause) {
              outcome = {
                status: "failed",
                message: cause instanceof Error && cause.message.length > 0 ? cause.message : null,
                basis,
              };
            }
          }
          ensureActive(work);
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: "capture-current-location",
            outcome,
          } satisfies OutboundMessageInput<AgentResultMessage>);
        } else if (request.request.type === "find-media-overlay-entry") {
          const outcome = !narratableDocument(state)
            ? { state: "unsupported" as const }
            : !narrationLayoutSettled(state)
              ? { state: "unavailable" as const }
              : findMediaOverlayEntry(document, request.request.fragments);
          ensureActive(work);
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: "find-media-overlay-entry",
            outcome,
          } satisfies OutboundMessageInput<AgentResultMessage>);
        } else if (request.request.type === "observe-document") {
          if (!state.lifecycle.observationEnabled) return;
          await nextFrame();
          await nextFrame();
          const observation = observeDocument(document, request.request.observation);
          ensureActive(work);
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: "observe-document",
            observation,
          } satisfies OutboundMessageInput<AgentDocumentObservationResultMessage>);
        } else if (request.request.type === "measure-toc-targets") {
          const results = await measureTocTargets(state, request.request.targets, work);
          ensureActive(work);
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: "measure-toc-targets",
            results,
          } satisfies OutboundMessageInput<AgentTocTargetsResultMessage>);
        } else if (
          request.request.type === "resolve-locator" ||
          request.request.type === "relocate"
        ) {
          let status;
          let relocationStart: {
            left: number;
            top: number;
          } | null = null;
          if (request.request.type === "resolve-locator") {
            status =
              state.lifecycle.documentAdapter === "fixed-svg"
                ? resolveStaticSvgLocator(state, request.request.target)
                : resolveLocatorInDocument(document, request.request.target).status;
          } else {
            const scrolling = document.scrollingElement;
            relocationStart =
              scrolling === null ? null : { left: scrolling.scrollLeft, top: scrolling.scrollTop };
            status =
              state.lifecycle.documentAdapter === "fixed-svg"
                ? resolveStaticSvgLocator(state, request.request.target)
                : relocateLocatorInDocument(
                    document,
                    request.request.target,
                    state.layout.settledLayout?.presentation.mode === "paginated"
                      ? {
                          mode: "paginated",
                          spreadStride:
                            state.layout.settledLayout.settlement.mode === "paginated"
                              ? state.layout.settledLayout.settlement.pages.spreadStride
                              : undefined,
                        }
                      : { mode: "document-scroll" },
                  );
            if (status.status === "resolved") await nextFrame();
          }
          try {
            ensureActive(work);
          } catch (cause) {
            const scrolling = document.scrollingElement;
            if (relocationStart !== null && scrolling !== null) {
              scrolling.scrollLeft = relocationStart.left;
              scrolling.scrollTop = relocationStart.top;
            }
            throw cause;
          }
          post(state, {
            namespace: CONTENT_AGENT_NAMESPACE,
            type: "result",
            operation: request.operation,
            resultType: request.request.type,
            status,
          } satisfies OutboundMessageInput<AgentResultMessage>);
          if (request.request.type === "relocate" && status.status === "resolved") {
            scheduleObservation(state);
          }
        } else {
          throw new Error("unsupported content-agent operation");
        }
      } catch (cause) {
        if (work.controller.signal.aborted || cause instanceof OperationCancelled) return;
        postRequestFailure(state, request, cause);
      } finally {
        state.operations.operationQueue.complete(work);
      }
    });
  });
}
