import { replayDeferredLayoutInteraction } from "./deferred-interaction.js";
import type { AgentFixedViewportMessage } from "../../agent-protocol/index.js";
import type { AgentWork } from "../operation-queue.js";
import type { ContentAgentState } from "../state.js";
import type {
  FixedPageGeometry,
  FixedIntrinsicViewport,
  FixedSettlement,
  LayoutMeasurement,
  LayoutResult,
  RequiredAssetSettlement,
} from "../../../generated/kernel.js";
import { CONTENT_AGENT_NAMESPACE } from "../../agent-protocol/index.js";
import { OperationCancelled, ensureActive } from "../operation-queue.js";
import type { OutboundMessageInput } from "../transport.js";
import { post } from "../transport.js";
import {
  captureDocumentGeometry,
  queueLayoutInvalidation,
  scheduleObservation,
} from "../observation/controller.js";
import { layoutSettlementDeadlineMs } from "./constants.js";
import { logicalBlockMetrics } from "./document-scroll.js";
import { nextFrame } from "../layout-settlement.js";
import { readerStyleAvailable } from "./reader-style.js";
import { resolveFixedViewport } from "../fixed-viewport.js";
import { resolveSvgIntrinsicViewport } from "../svg-viewport.js";
import { resolveImageIntrinsicViewport } from "../image-viewport.js";
import { scheduleSelectionSignal } from "../selection/controller.js";
import { settleLayoutEffects } from "./reflow-transaction.js";
import { observeFixedDocument } from "../targets/resolver/observation.js";

export async function runFixedLayoutTransaction(
  state: ContentAgentState,
  operation: number,
  work: AgentWork,
  adapter: "fixed-xhtml" | "fixed-svg" | "fixed-image",
): Promise<LayoutResult | null> {
  void state;
  ensureActive(work);
  const token = ++state.layout.layoutToken;
  state.layout.applyingLayout = true;
  state.observation.observationDeferred = true;
  state.layout.activePresentation = null;
  state.layout.layoutInvalidationPending = false;
  try {
    if (adapter === "fixed-xhtml" && !readerStyleAvailable(state)) {
      return {
        adapter,
        outcome: { status: "unavailable", issue: "agent-style-unavailable" },
      };
    }
    const resolved =
      adapter === "fixed-svg"
        ? resolveSvgIntrinsicViewport(document)
        : adapter === "fixed-image"
          ? resolveImageIntrinsicViewport(document)
          : resolveFixedViewport(document);
    if (resolved.status === "unavailable") {
      return { adapter, outcome: resolved };
    }
    const geometry = await applyFixedViewport(state, operation, resolved.viewport, work);
    ensureActive(work);
    if (geometry === null) {
      return {
        adapter,
        outcome: { status: "unavailable", issue: "final-viewport-unavailable" },
      };
    }
    const viewportApplied = await waitForFixedViewport(resolved.viewport, work);
    ensureActive(work);
    if (!viewportApplied) {
      return {
        adapter,
        outcome: { status: "unavailable", issue: "final-viewport-unavailable" },
      };
    }
    const effects =
      adapter === "fixed-svg"
        ? await settleStaticSvgLayoutEffects(state)
        : await settleLayoutEffects(state);
    ensureActive(work);
    if (token !== state.layout.layoutToken) return null;
    const settlement: FixedSettlement = {
      mode: "contain",
      measurement:
        adapter !== "fixed-xhtml"
          ? measureStaticSvgLayout(state, effects.requiredFonts, effects.requiredResources)
          : measureFixedLayout(state, effects.requiredFonts, effects.requiredResources),
      geometry,
    };
    state.layout.fixedSettlement = settlement;
    state.layout.settledLayout = null;
    state.observation.committedGeometry = captureDocumentGeometry(state);
    return { adapter, outcome: { status: "settled", settlement } };
  } finally {
    if (token === state.layout.layoutToken) {
      state.layout.applyingLayout = false;
      state.layout.layoutInvalidationPending = false;
      const retainedInvalidation = state.layout.layoutReapplyRequested
        ? state.layout.activeLayoutInvalidationCause
        : null;
      state.layout.layoutReapplyRequested = false;
      state.layout.activeLayoutInvalidationCause = null;
      if (retainedInvalidation !== null) queueLayoutInvalidation(state, retainedInvalidation);
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

export async function settleStaticSvgLayoutEffects(state: ContentAgentState): Promise<{
  readonly requiredFonts: RequiredAssetSettlement;
  readonly requiredResources: RequiredAssetSettlement;
}> {
  void state;
  const deadline = performance.now() + layoutSettlementDeadlineMs;
  let requiredResources: RequiredAssetSettlement = "loaded";
  if (document.readyState !== "complete") {
    requiredResources = await waitForStaticSvgDocumentLoad(state, deadline);
  }
  if (state.layout.staticSvgRequiredResources === "failed") requiredResources = "failed";
  let requiredFonts: RequiredAssetSettlement = "loaded";
  const fonts = document.fonts;
  if (fonts?.status === "loading") {
    const remaining = Math.max(0, deadline - performance.now());
    requiredFonts =
      remaining === 0
        ? "timed-out"
        : await Promise.race([
            Promise.resolve(fonts.ready).then<RequiredAssetSettlement, RequiredAssetSettlement>(
              () => "loaded",
              () => "failed",
            ),
            new Promise<RequiredAssetSettlement>((resolve) =>
              setTimeout(() => resolve("timed-out"), remaining),
            ),
          ]);
  }
  fonts?.forEach((font) => {
    if (font.status === "error") requiredFonts = "failed";
  });
  await nextFrame();
  await nextFrame();
  return { requiredFonts, requiredResources };
}

export function waitForStaticSvgDocumentLoad(
  state: ContentAgentState,
  deadline: number,
): Promise<RequiredAssetSettlement> {
  void state;
  const remaining = Math.max(0, deadline - performance.now());
  if (remaining === 0) return Promise.resolve("timed-out");
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (settlement: RequiredAssetSettlement): void => {
      window.removeEventListener("load", loaded);
      if (timer !== null) clearTimeout(timer);
      resolve(settlement);
    };
    const loaded = (): void => finish("loaded");
    window.addEventListener("load", loaded, { once: true });
    timer = setTimeout(() => finish("timed-out"), remaining);
  });
}

export async function applyFixedViewport(
  state: ContentAgentState,
  operation: number,
  intrinsicViewport: FixedIntrinsicViewport,
  work: AgentWork,
): Promise<FixedPageGeometry | null> {
  void state;
  if (state.layout.pendingFixedViewportApplication !== null) {
    throw new Error("a fixed viewport application is already pending");
  }
  return new Promise<FixedPageGeometry | null>((resolve, reject) => {
    const aborted = (): void => {
      if (state.layout.pendingFixedViewportApplication?.operation === operation) {
        state.layout.pendingFixedViewportApplication = null;
      }
      reject(new OperationCancelled());
    };
    state.layout.pendingFixedViewportApplication = {
      operation,
      resolve: (application) => {
        work.controller.signal.removeEventListener("abort", aborted);
        resolve(application.status === "applied" ? application.geometry : null);
      },
      reject,
    };
    work.controller.signal.addEventListener("abort", aborted, { once: true });
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "fixed-viewport",
      operation,
      intrinsicViewport,
    } satisfies OutboundMessageInput<AgentFixedViewportMessage>);
  });
}

/** The host acknowledgement can precede resize delivery to an out-of-process iframe. */
export async function waitForFixedViewport(
  viewport: FixedIntrinsicViewport,
  work: AgentWork,
): Promise<boolean> {
  ensureActive(work);
  const matches = () =>
    Math.abs(window.innerWidth - viewport.width) <= 1 &&
    Math.abs(window.innerHeight - viewport.height) <= 1;
  if (matches()) return true;
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("resize", resized);
      work.controller.signal.removeEventListener("abort", aborted);
    };
    const finish = (applied: boolean) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(applied);
    };
    const resized = () => {
      if (matches()) finish(true);
    };
    const aborted = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new OperationCancelled());
    };
    const timer = setTimeout(() => finish(matches()), layoutSettlementDeadlineMs);
    window.addEventListener("resize", resized);
    work.controller.signal.addEventListener("abort", aborted, { once: true });
    if (work.controller.signal.aborted) aborted();
    else resized();
  });
}

export function measureFixedLayout(
  state: ContentAgentState,
  requiredFonts: RequiredAssetSettlement,
  requiredResources: RequiredAssetSettlement,
): LayoutMeasurement {
  void state;
  const observation = observeFixedDocument(document, "fixed-xhtml");
  const horizontal = observation.writingMode === "horizontal-tb";
  const scrolling = document.scrollingElement;
  if (scrolling === null) throw new Error("the content document has no scrolling element");
  const metrics = logicalBlockMetrics(document, observation.writingMode);
  if (metrics === null) throw new Error("document scroll metrics are unavailable");
  return {
    observation,
    logicalViewport: horizontal
      ? { inline: window.innerWidth, block: window.innerHeight }
      : { inline: window.innerHeight, block: window.innerWidth },
    logicalContentExtent: horizontal
      ? { inline: scrolling.scrollWidth, block: scrolling.scrollHeight }
      : { inline: scrolling.scrollHeight, block: scrolling.scrollWidth },
    normalizedPosition: metrics.maximum === 0 ? 0 : metrics.position / metrics.maximum,
    physicalMovement: { x: 0, y: 0 },
    requiredFonts,
    requiredResources,
  };
}

export function measureStaticSvgLayout(
  state: ContentAgentState,
  requiredFonts: RequiredAssetSettlement,
  requiredResources: RequiredAssetSettlement,
): LayoutMeasurement {
  void state;
  const observation = observeFixedDocument(
    document,
    state.lifecycle.documentAdapter === "fixed-image" ? "fixed-image" : "fixed-svg",
  );
  return {
    observation,
    logicalViewport: { inline: window.innerWidth, block: window.innerHeight },
    logicalContentExtent: { inline: window.innerWidth, block: window.innerHeight },
    normalizedPosition: 0,
    physicalMovement: { x: 0, y: 0 },
    requiredFonts,
    requiredResources,
  };
}
