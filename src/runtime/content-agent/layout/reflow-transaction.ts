import { replayDeferredLayoutInteraction } from "./deferred-interaction.js";
import type { AgentWork } from "../operation-queue.js";
import type { ContentAgentState } from "../state.js";
import type { LayoutSettlementVersion } from "../layout-settlement.js";
import type {
  ReflowPositionRequest,
  ReflowableLayoutOutcome,
  ReflowablePresentation,
} from "../../../generated/kernel.js";
import type { PhysicalPaginationMeasurement } from "./pagination-geometry.js";
import { samePresentationValuesExceptTheme } from "../../presentation-keys.js";
import {
  alignXCenterBlockExtent,
  capturePhysicalPaginationGeometry,
  inlinePaginationExtent,
  paginationGeometryDiagnosticsEnabled,
  postPaginationDiagnostic,
  relocatePosition,
  requiredPaginationExtent,
  resetPaginationGeometryDiagnostics,
  scanPhysicalPaginationContentEnd,
  singleColumnPaginationFallbackRequired,
} from "./pagination-geometry.js";
import {
  assessLayoutRepairs,
  clearFragmentationRepairs,
  fragmentationRepairsAreEffective,
  ineffectiveFragmentationRepairs,
  setFragmentationRepairs,
} from "./fragmentation-repair.js";
import {
  captureDocumentGeometry,
  consumeLayoutReapplyRequest,
  queueLayoutInvalidation,
  requestLayoutReapply,
  scheduleObservation,
} from "../observation/controller.js";
import {
  configurationRules,
  presentationRules,
  readerFontStylesheetAvailable,
  readerStyleAvailable,
  updateReaderStyle,
} from "./reader-style.js";
import { currentReflowPosition, measureReflowableSettlement } from "./measurement.js";
import { ensureActive } from "../operation-queue.js";
import { invalidateDocumentTextIndex } from "../targets/resolver/text-index.js";
import {
  layoutEffectSettlementTimedOut,
  mergeLayoutEffectSettlements,
  reconcileLayoutEffectSettlements,
} from "../layout-settlement.js";
import { layoutSettlementDeadlineMs } from "./constants.js";
import { requiredPresentationIsEffective } from "./presentation-verification.js";
import { scheduleSelectionSignal } from "../selection/controller.js";

export async function runReflowLayoutTransaction(
  state: ContentAgentState,
  presentation: ReflowablePresentation,
  position: ReflowPositionRequest,
  work: AgentWork,
): Promise<ReflowableLayoutOutcome | null> {
  void state;
  ensureActive(work);
  const token = ++state.layout.layoutToken;
  const previousLayout = state.layout.settledLayout;
  const previousBodyInsets = state.layout.authoredBodyInsets;
  const previousCanvasBackground = state.layout.authoredCanvasBackground;
  const previousPaginationEndExtent = state.layout.paginationEndExtent;
  const previousSingleColumnPaginationFallback = state.layout.singleColumnPaginationFallback;
  const previousWideContentSingleColumn = state.layout.wideContentSingleColumn;
  const previousFragmentationRepairs = [...state.layout.fragmentationRepairs];
  const previousLayoutRepairReport = state.layout.layoutRepairReport;
  const livePosition =
    previousLayout === null ? position : currentReflowPosition(state, previousLayout);
  const themeOnlyChange =
    previousLayout !== null &&
    previousLayout.presentation.theme !== presentation.theme &&
    samePresentationExceptTheme(state, previousLayout.presentation, presentation);
  let committed = false;
  let terminalInstability = false;
  let singleColumnPaginationFallbackRequested = false;
  let wideContentSingleColumnRequested = false;
  resetPaginationGeometryDiagnostics(state);
  state.layout.applyingLayout = true;
  state.observation.observationDeferred = true;
  invalidateDocumentTextIndex(document);
  state.layout.activePresentation = presentation;
  state.layout.layoutInvalidationPending = false;
  try {
    ensureActive(work);
    if (!readerStyleAvailable(state)) {
      return { status: "unavailable", issue: "agent-style-unavailable" };
    }
    if (presentation.typeface === "reader-serif" && !readerFontStylesheetAvailable(state)) {
      return { status: "unavailable", issue: "reader-font-unavailable" };
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const themeOnlyAttempt = themeOnlyChange && attempt === 0;
      state.layout.layoutReapplyRequested = false;
      state.layout.activeLayoutInvalidationCause = null;
      const settlementDeadline = performance.now() + layoutSettlementDeadlineMs;
      state.layout.paginationEndExtent = themeOnlyAttempt ? previousPaginationEndExtent : 0;
      state.layout.singleColumnPaginationFallback = themeOnlyAttempt
        ? previousSingleColumnPaginationFallback
        : singleColumnPaginationFallbackRequested;
      state.layout.wideContentSingleColumn = themeOnlyAttempt
        ? previousWideContentSingleColumn
        : wideContentSingleColumnRequested;
      state.layout.authoredBodyInsets = themeOnlyAttempt ? previousBodyInsets : null;
      state.layout.authoredCanvasBackground = themeOnlyAttempt ? previousCanvasBackground : null;
      if (!themeOnlyAttempt) state.layout.alignXCenterBlockExtent = null;
      if (!themeOnlyAttempt) {
        clearFragmentationRepairs(state);
        state.layout.layoutRepairReport = { status: "no-issues-detected" };
      }
      if (presentation.mode === "paginated" && !themeOnlyAttempt) {
        ensureActive(work);
        updateReaderStyle(state, configurationRules(state));
      }
      ensureActive(work);
      updateReaderStyle(state, [
        ...configurationRules(state),
        ...presentationRules(state, presentation),
      ]);
      let effectSettlement = await settleLayoutEffects(state, settlementDeadline);
      ensureActive(work);
      if (token !== state.layout.layoutToken) return null;
      if (!readerStyleAvailable(state)) {
        return { status: "unavailable", issue: "agent-style-unavailable" };
      }
      if (!requiredPresentationIsEffective(state, presentation)) {
        if (state.layout.layoutReapplyRequested && attempt < 2) continue;
        return { status: "conflict", issue: "incompatible-publisher-css" };
      }
      if (presentation.mode === "paginated") {
        if (presentation.alignXCenter && !themeOnlyAttempt) {
          const uncentredExtent = inlinePaginationExtent();
          const centred = alignXCenterBlockExtent(state, presentation);
          if (centred !== null) {
            state.layout.alignXCenterBlockExtent = centred;
            ensureActive(work);
            updateReaderStyle(state, [
              ...configurationRules(state),
              ...presentationRules(state, presentation),
            ]);
            effectSettlement = mergeLayoutEffectSettlements(
              effectSettlement,
              await settleLayoutEffects(state, settlementDeadline),
            );
            ensureActive(work);
            if (token !== state.layout.layoutToken) return null;
            if (!readerStyleAvailable(state)) {
              return { status: "unavailable", issue: "agent-style-unavailable" };
            }
            // Centring moves the page's content; it must never cost the reader a page.
            if (inlinePaginationExtent() > uncentredExtent) {
              state.layout.alignXCenterBlockExtent = null;
              ensureActive(work);
              updateReaderStyle(state, [
                ...configurationRules(state),
                ...presentationRules(state, presentation),
              ]);
              effectSettlement = mergeLayoutEffectSettlements(
                effectSettlement,
                await settleLayoutEffects(state, settlementDeadline),
              );
              ensureActive(work);
              if (token !== state.layout.layoutToken) return null;
              if (!readerStyleAvailable(state)) {
                return { status: "unavailable", issue: "agent-style-unavailable" };
              }
            }
          }
        }
        let measuredPagination: PhysicalPaginationMeasurement | null = null;
        if (!themeOnlyAttempt) {
          const assessmentInvalidationVersion = state.layout.layoutInvalidationVersion;
          const assessmentSettlementVersion = captureSettlementVersion(state);
          const assessment = await assessLayoutRepairs(
            state,
            presentation,
            work,
            assessmentInvalidationVersion,
            assessmentSettlementVersion,
          );
          if (assessment === null) {
            detectSettlementChange(state, assessmentSettlementVersion);
            if (attempt < 2) continue;
            terminalInstability = true;
            return { status: "unavailable", issue: "agent-style-unavailable" };
          }
          // A table two columns cannot hold, that one column could, takes the section to one
          // column: a page that shows its table is worth more than a page that shows two columns.
          if (
            assessment.wideContentFitsOneColumn &&
            !state.layout.wideContentSingleColumn &&
            attempt < 2
          ) {
            wideContentSingleColumnRequested = true;
            continue;
          }
          let unresolvedElements = assessment.unresolvedElements;
          setFragmentationRepairs(state, assessment.repairs);
          if (state.layout.fragmentationRepairs.length > 0) {
            ensureActive(work);
            updateReaderStyle(state, [
              ...configurationRules(state),
              ...presentationRules(state, presentation),
            ]);
            effectSettlement = mergeLayoutEffectSettlements(
              effectSettlement,
              await settleLayoutEffects(state, settlementDeadline),
            );
            ensureActive(work);
            if (token !== state.layout.layoutToken) return null;
            if (!readerStyleAvailable(state)) {
              return { status: "unavailable", issue: "agent-style-unavailable" };
            }
            // A repair the browser would not take is given up on its own; the rest stand. Only a
            // page that still will not settle after that gives up all of them.
            let ineffective = ineffectiveFragmentationRepairs(state);
            if (
              ineffective.length > 0 &&
              ineffective.length < state.layout.fragmentationRepairs.length
            ) {
              if (state.layout.layoutReapplyRequested && attempt < 2) continue;
              const dropped = new Set(ineffective);
              unresolvedElements += ineffective.length;
              setFragmentationRepairs(
                state,
                state.layout.fragmentationRepairs.filter((repair) => !dropped.has(repair)),
              );
              ensureActive(work);
              updateReaderStyle(state, [
                ...configurationRules(state),
                ...presentationRules(state, presentation),
              ]);
              effectSettlement = mergeLayoutEffectSettlements(
                effectSettlement,
                await settleLayoutEffects(state, settlementDeadline),
              );
              ensureActive(work);
              if (token !== state.layout.layoutToken) return null;
              if (!readerStyleAvailable(state)) {
                return { status: "unavailable", issue: "agent-style-unavailable" };
              }
              ineffective = ineffectiveFragmentationRepairs(state);
            }
            if (ineffective.length > 0) {
              if (state.layout.layoutReapplyRequested && attempt < 2) continue;
              unresolvedElements += state.layout.fragmentationRepairs.length;
              clearFragmentationRepairs(state);
              ensureActive(work);
              updateReaderStyle(state, [
                ...configurationRules(state),
                ...presentationRules(state, presentation),
              ]);
              effectSettlement = mergeLayoutEffectSettlements(
                effectSettlement,
                await settleLayoutEffects(state, settlementDeadline),
              );
              ensureActive(work);
              if (token !== state.layout.layoutToken) return null;
              if (!readerStyleAvailable(state)) {
                return { status: "unavailable", issue: "agent-style-unavailable" };
              }
            }
          }
          state.layout.layoutRepairReport =
            unresolvedElements > 0
              ? {
                  status: "unresolved",
                  repairedElements: state.layout.fragmentationRepairs.length,
                  unresolvedElements,
                }
              : state.layout.fragmentationRepairs.length > 0
                ? { status: "repaired", repairedElements: state.layout.fragmentationRepairs.length }
                : { status: "no-issues-detected" };
        }
        if (layoutEffectSettlementTimedOut(effectSettlement)) {
          effectSettlement = reconcileLayoutEffectSettlements(
            effectSettlement,
            await settleLayoutEffects(state, settlementDeadline),
          );
          ensureActive(work);
          if (token !== state.layout.layoutToken) return null;
        }
        const geometry = capturePhysicalPaginationGeometry(state, presentation);
        consumeLayoutReapplyRequest(state);
        let scanSettlementVersion = captureSettlementVersion(state);
        let scanInvalidationVersion = state.layout.layoutInvalidationVersion;
        const previousMetrics = previousLayout?.settlement;
        const extentMeasurement =
          themeOnlyAttempt && previousMetrics?.mode === "paginated"
            ? {
                ...geometry,
                pageCount: previousMetrics.pages.pageCount,
                hasUnpaginatedTextBlockOverflow: false,
              }
            : (measuredPagination = await scanPhysicalPaginationContentEnd(
                state,
                geometry,
                work,
                scanInvalidationVersion,
                scanSettlementVersion,
              ));
        if (extentMeasurement === null) {
          detectSettlementChange(state, scanSettlementVersion);
          if (attempt < 2) continue;
          terminalInstability = true;
          return { status: "unavailable", issue: "agent-style-unavailable" };
        }
        if (
          !themeOnlyAttempt &&
          !state.layout.singleColumnPaginationFallback &&
          singleColumnPaginationFallbackRequired(extentMeasurement)
        ) {
          singleColumnPaginationFallbackRequested = true;
          continue;
        }
        const requiredExtent = requiredPaginationExtent(state, extentMeasurement);
        const scrollingElement = document.scrollingElement;
        const currentExtent =
          geometry.flow.writingMode === "horizontal-tb"
            ? scrollingElement?.scrollWidth
            : scrollingElement?.scrollHeight;
        if (currentExtent !== undefined && requiredExtent > currentExtent + 1) {
          state.layout.paginationEndExtent = requiredExtent;
          ensureActive(work);
          updateReaderStyle(state, [
            ...configurationRules(state),
            ...presentationRules(state, presentation),
          ]);
          effectSettlement = reconcileLayoutEffectSettlements(
            effectSettlement,
            await settleLayoutEffects(state, performance.now() + layoutSettlementDeadlineMs),
          );
          ensureActive(work);
          if (token !== state.layout.layoutToken) return null;
          consumeLayoutReapplyRequest(state);
          scanSettlementVersion = captureSettlementVersion(state);
          scanInvalidationVersion = state.layout.layoutInvalidationVersion;
          measuredPagination = await scanPhysicalPaginationContentEnd(
            state,
            geometry,
            work,
            scanInvalidationVersion,
            scanSettlementVersion,
          );
          if (measuredPagination === null) {
            detectSettlementChange(state, scanSettlementVersion);
            if (attempt < 2) continue;
            terminalInstability = true;
            return { status: "unavailable", issue: "agent-style-unavailable" };
          }
        }
        if (!requiredPresentationIsEffective(state, presentation, requiredExtent)) {
          if (state.layout.layoutReapplyRequested && attempt < 2) continue;
          return { status: "conflict", issue: "incompatible-publisher-css" };
        }
        if (!relocatePosition(state, presentation, livePosition, geometry)) {
          return { status: "unavailable", issue: "anchor-reconciliation-failed" };
        }
        // Auxiliary relocation only changes scroll position; its result is read synchronously below.
        // Foreground and prepared frames retain the visual stabilization required before display.
        if (state.lifecycle.agentRole !== "auxiliary") {
          effectSettlement = reconcileLayoutEffectSettlements(
            effectSettlement,
            await settleLayoutEffects(state, settlementDeadline),
          );
        }
        ensureActive(work);
        if (token !== state.layout.layoutToken) return null;
        if (!readerStyleAvailable(state)) {
          return { status: "unavailable", issue: "agent-style-unavailable" };
        }
        detectSettlementChange(state, scanSettlementVersion);
        if (state.layout.layoutInvalidationVersion !== scanInvalidationVersion) {
          if (attempt < 2) continue;
          terminalInstability = true;
          return { status: "unavailable", issue: "agent-style-unavailable" };
        }
        if (!requiredPresentationIsEffective(state, presentation)) {
          return { status: "conflict", issue: "incompatible-publisher-css" };
        }
        if (!fragmentationRepairsAreEffective(state)) {
          return { status: "conflict", issue: "incompatible-publisher-css" };
        }
        if (measuredPagination === null) {
          measuredPagination = await scanPhysicalPaginationContentEnd(
            state,
            geometry,
            work,
            scanInvalidationVersion,
            scanSettlementVersion,
          );
          if (measuredPagination === null) {
            detectSettlementChange(state, scanSettlementVersion);
            if (attempt < 2) continue;
            terminalInstability = true;
            return { status: "unavailable", issue: "agent-style-unavailable" };
          }
        }
        invalidateDocumentTextIndex(document);
        const settlement = measureReflowableSettlement(
          state,
          presentation,
          measuredPagination,
          effectSettlement.requiredFonts,
          effectSettlement.requiredResources,
        );
        ensureActive(work);
        state.layout.settledLayout = { presentation, settlement };
        state.layout.fixedSettlement = null;
        state.observation.committedGeometry = captureDocumentGeometry(state);
        committed = true;
        return { status: "settled", settlement };
      }
      consumeLayoutReapplyRequest(state);
      const finalSettlementVersion = captureSettlementVersion(state);
      const finalInvalidationVersion = state.layout.layoutInvalidationVersion;
      if (!relocatePosition(state, presentation, livePosition, null)) {
        return { status: "unavailable", issue: "anchor-reconciliation-failed" };
      }
      effectSettlement = reconcileLayoutEffectSettlements(
        effectSettlement,
        await settleLayoutEffects(state, settlementDeadline),
      );
      ensureActive(work);
      if (token !== state.layout.layoutToken) return null;
      if (!readerStyleAvailable(state)) {
        return { status: "unavailable", issue: "agent-style-unavailable" };
      }
      detectSettlementChange(state, finalSettlementVersion);
      if (state.layout.layoutInvalidationVersion !== finalInvalidationVersion) {
        if (attempt < 2) continue;
        terminalInstability = true;
        return { status: "unavailable", issue: "agent-style-unavailable" };
      }
      if (!requiredPresentationIsEffective(state, presentation)) {
        return { status: "conflict", issue: "incompatible-publisher-css" };
      }
      if (!fragmentationRepairsAreEffective(state)) {
        return { status: "conflict", issue: "incompatible-publisher-css" };
      }
      invalidateDocumentTextIndex(document);
      const settlement = measureReflowableSettlement(
        state,
        presentation,
        null,
        effectSettlement.requiredFonts,
        effectSettlement.requiredResources,
      );
      ensureActive(work);
      state.layout.settledLayout = { presentation, settlement };
      state.layout.fixedSettlement = null;
      state.observation.committedGeometry = captureDocumentGeometry(state);
      committed = true;
      return { status: "settled", settlement };
    }
    return { status: "conflict", issue: "incompatible-publisher-css" };
  } finally {
    if (token === state.layout.layoutToken) {
      const rollbackSettlementDeadline = performance.now() + layoutSettlementDeadlineMs;
      if (!committed && previousLayout !== null) {
        state.layout.authoredBodyInsets = previousBodyInsets;
        state.layout.authoredCanvasBackground = previousCanvasBackground;
        state.layout.paginationEndExtent = previousPaginationEndExtent;
        state.layout.singleColumnPaginationFallback = previousSingleColumnPaginationFallback;
        state.layout.wideContentSingleColumn = previousWideContentSingleColumn;
        state.layout.settledLayout = previousLayout;
        state.layout.layoutRepairReport = previousLayoutRepairReport;
        setFragmentationRepairs(state, previousFragmentationRepairs);
        updateReaderStyle(state, [
          ...configurationRules(state),
          ...presentationRules(state, previousLayout.presentation),
        ]);
        await settleLayoutEffects(state, rollbackSettlementDeadline);
        relocatePosition(
          state,
          previousLayout.presentation,
          livePosition,
          previousLayout.presentation.mode === "paginated"
            ? capturePhysicalPaginationGeometry(state, previousLayout.presentation)
            : null,
        );
      } else if (!committed) {
        state.layout.singleColumnPaginationFallback = false;
        state.layout.wideContentSingleColumn = false;
        clearFragmentationRepairs(state);
        state.layout.layoutRepairReport = { status: "no-issues-detected" };
        updateReaderStyle(state, configurationRules(state));
      }
      if (!committed) {
        // Do not expose the frame to queued reads until rollback has reached rendered layout.
        await settleLayoutEffects(state, rollbackSettlementDeadline);
      }
      state.layout.activePresentation = null;
      state.layout.applyingLayout = false;
      state.layout.layoutInvalidationPending = false;
      const retainedInvalidation = state.layout.layoutReapplyRequested
        ? state.layout.activeLayoutInvalidationCause
        : null;
      state.layout.layoutReapplyRequested = false;
      state.layout.activeLayoutInvalidationCause = null;
      if (retainedInvalidation !== null && !terminalInstability) {
        queueLayoutInvalidation(state, retainedInvalidation);
      }
      replayDeferredLayoutInteraction(state);
      if (state.observation.observationDeferred) {
        state.observation.observationDeferred = false;
        scheduleObservation(state);
      }
      if (state.selection.selectionEdgeSignalDeferred) {
        state.selection.selectionEdgeSignalDeferred = false;
        scheduleSelectionSignal(state);
      }
    }
  }
}

export function samePresentationExceptTheme(
  state: ContentAgentState,
  left: ReflowablePresentation,
  right: ReflowablePresentation,
): boolean {
  void state;
  return samePresentationValuesExceptTheme(left, right);
}

export function settleLayoutEffects(
  state: ContentAgentState,
  deadline = performance.now() + layoutSettlementDeadlineMs,
) {
  const started = paginationGeometryDiagnosticsEnabled(state) ? performance.now() : 0;
  return state.layout.layoutSettlement.settleLayoutEffects(deadline).then((settlement) => {
    if (paginationGeometryDiagnosticsEnabled(state)) {
      const durationMs = Math.max(0, performance.now() - started);
      const diagnostics = window.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__;
      if (diagnostics?.enabled === true) {
        (diagnostics.phases ??= []).push({ phase: "settlement", durationMs });
      }
      postPaginationDiagnostic(state, "settlement", durationMs, 0, 0);
    }
    return settlement;
  });
}

export function captureSettlementVersion(state: ContentAgentState): LayoutSettlementVersion {
  void state;
  return state.layout.layoutSettlement.captureVersion();
}

export function detectSettlementChange(
  state: ContentAgentState,
  version: LayoutSettlementVersion,
): void {
  void state;
  if (state.layout.layoutSettlement.versionChanged(version)) requestLayoutReapply(state, "fonts");
}

export function layoutSnapshotIsCurrent(
  state: ContentAgentState,
  invalidationVersion: number,
  settlementVersion: LayoutSettlementVersion,
): boolean {
  void state;
  const currentSettlement = captureSettlementVersion(state);
  return (
    invalidationVersion === state.layout.layoutInvalidationVersion &&
    settlementVersion.fonts === currentSettlement.fonts &&
    settlementVersion.fontStatus === currentSettlement.fontStatus &&
    settlementVersion.resources === currentSettlement.resources
  );
}

export async function yieldLayoutWork(state: ContentAgentState, work: AgentWork): Promise<void> {
  void state;
  ensureActive(work);
  const diagnostics = window.__EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__;
  if (diagnostics?.enabled === true) {
    diagnostics.cooperativeYieldCount = (diagnostics.cooperativeYieldCount ?? 0) + 1;
  }
  const scheduling = (
    globalThis as typeof globalThis & {
      readonly scheduler?: {
        readonly yield?: (() => Promise<void>) | undefined;
      };
    }
  ).scheduler;
  if (scheduling?.yield !== undefined) await scheduling.yield();
  else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  ensureActive(work);
}
