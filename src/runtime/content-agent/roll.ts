import type { ContentAgentState } from "./state.js";
import { resolveLocatorInDocument } from "./targets/resolver/locator.js";
import { resolveAnnotationTargetInDocument } from "./targets/resolver/annotation.js";
import { rangeRectangle, renderedElementRectangle } from "./targets/resolver/viewport.js";
import {
  ROLL_NAMESPACE,
  ROLL_MAX_DELTA,
  boundedRollTarget,
  rollIdentity,
  rollRecord,
} from "../fixed-layout/roll-protocol.js";
import { CONTENT_AGENT_NAMESPACE, normalizeAgentRequest } from "../agent-protocol/index.js";
import { eligibleInteractionEvent, hasSelection } from "./interaction/controller.js";
import { documentTextGeneration } from "./targets/resolver/text-index.js";
import { annotationTargetResult } from "./targets/annotation.js";
import { isElement } from "./dom.js";

/** Roll geometry is a host-compositor request, not a replacement for kernel layout settlement. */
export function installRollController(state: ContentAgentState): void {
  let enabled = false;
  let request = 0;
  let layoutGeneration = 0;
  let controller: AbortController | null = null;
  let latest: (() => Promise<void>) | null = null;
  let running = false;
  const stop = () => {
    controller?.abort();
    controller = null;
    latest = null;
  };
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (latest !== null) {
        const execute = latest;
        latest = null;
        await execute();
      }
    } finally {
      running = false;
    }
  };
  const send = (value: object) => {
    if (state.transport.readerOrigin === null) return;
    state.transport.reader?.postMessage(
      {
        namespace: ROLL_NAMESPACE,
        session: state.transport.protocolSession,
        layoutGeneration,
        ...value,
      },
      state.transport.readerOrigin,
    );
  };
  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data;
    if (
      !state.lifecycle.initialized ||
      event.source !== state.transport.reader ||
      event.origin !== state.transport.readerOrigin ||
      !rollRecord(message) ||
      message.namespace !== ROLL_NAMESPACE ||
      message.session !== state.transport.protocolSession ||
      (state.lifecycle.documentAdapter !== "fixed-xhtml" &&
        state.lifecycle.documentAdapter !== "fixed-svg" &&
        state.lifecycle.documentAdapter !== "fixed-image")
    )
      return;
    if (message.type === "disable" || message.type === "dispose") {
      enabled = false;
      stop();
      if (message.type === "dispose") state.interaction.fixedGesturePointers.clear();
      return;
    }
    if (message.type === "enable") {
      if (!rollIdentity(message.layoutGeneration)) return;
      if (message.layoutGeneration !== layoutGeneration) stop();
      layoutGeneration = message.layoutGeneration;
      enabled = true;
      return;
    }
    if (!enabled || message.layoutGeneration !== layoutGeneration) return;
    if (message.type === "cancel" && message.operation === request) {
      stop();
      return;
    }
    if (
      message.type !== "target" ||
      !rollIdentity(message.operation) ||
      !boundedRollTarget(message)
    )
      return;
    const normalized = normalizeAgentRequest({
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "request",
      session: message.session,
      operation: message.operation,
      request:
        message.locator !== undefined
          ? { type: "resolve-locator", target: message.locator }
          : { type: "resolve-annotation-target", plan: message.plan },
    });
    if (normalized === null) return;
    if (state.lifecycle.documentAdapter === "fixed-image") {
      const request = normalized.request;
      const sourceOnly =
        request.type === "resolve-annotation-target"
          ? request.plan.selectors.length === 1 &&
            request.plan.selectors[0]?.kind === "resource" &&
            request.plan.selectors[0].refinements.length === 0
          : request.type === "resolve-locator" &&
            request.target.kind === "point" &&
            request.target.evidence.every((item) => item.kind === "document-boundary");
      // The image wrapper is host machinery, not an authored DOM selector target.
      if (!sourceOnly) {
        send({ type: "target-result", operation: message.operation, point: null });
        return;
      }
    }
    const operation = message.operation;
    stop();
    const work = new AbortController();
    controller = work;
    const token = state.layout.layoutToken;
    const contentGeneration = documentTextGeneration(document);
    const generation = layoutGeneration;
    request = operation;
    latest = async () => {
      let point: { x: number; y: number } | null = null;
      let annotation: ReturnType<typeof annotationTargetResult> | undefined;
      try {
        let range: Range | null = null;
        if (normalized.request.type === "resolve-locator") {
          const locator = normalized.request.target;
          range = resolveLocatorInDocument(document, locator).range;
          const boundary =
            locator.kind === "point"
              ? locator.evidence.find((evidence) => evidence.kind === "document-boundary")
              : undefined;
          if (range !== null && boundary?.kind === "document-boundary")
            point = { x: 0, y: boundary.boundary === "start" ? 0 : window.innerHeight };
        } else if (normalized.request.type === "resolve-annotation-target") {
          const resolution = await resolveAnnotationTargetInDocument(
            document,
            normalized.request.plan,
            {
              maximumWorkUnits: 1_000_000,
              yieldEveryWorkUnits: 2_000,
              signal: work.signal,
              isCurrent: () =>
                request === operation &&
                state.layout.layoutToken === token &&
                layoutGeneration === generation &&
                documentTextGeneration(document) === contentGeneration,
            },
          );
          annotation = annotationTargetResult(normalized.request.plan.resource, resolution);
          range = resolution.range;
        }
        if (range !== null && point === null) {
          const rectangle =
            rangeRectangle(range) ??
            (isElement(range.startContainer)
              ? renderedElementRectangle(range.startContainer)
              : null);
          if (rectangle !== null) point = { x: rectangle.left, y: rectangle.top };
        }
      } catch {
        /* Invalid or stale DOM targets do not move the outer reader. */
      }
      if (annotation !== undefined && !boundedRollTarget(annotation)) {
        annotation = undefined;
        point = null;
      }
      if (
        request === operation &&
        !work.signal.aborted &&
        token === state.layout.layoutToken &&
        generation === layoutGeneration &&
        contentGeneration === documentTextGeneration(document)
      )
        send({
          type: "target-result",
          operation,
          point,
          ...(annotation === undefined ? {} : { annotation }),
        });
      if (controller === work) controller = null;
    };
    void drain();
  });
  window.addEventListener("pagehide", () => {
    enabled = false;
    stop();
  });
  const nestedScroller = (event: Event) =>
    event.composedPath().find((item) => {
      if (!(item instanceof Element) || item === document.documentElement || item === document.body)
        return false;
      const style = getComputedStyle(item);
      return (
        (/(auto|scroll)/u.test(style.overflowY) && item.scrollHeight > item.clientHeight) ||
        (/(auto|scroll)/u.test(style.overflowX) && item.scrollWidth > item.clientWidth)
      );
    });
  // The existing fixed-view controller interprets drags and pinches. Remove only gestures
  // belonging to native selection/controls/nested scrolling; do not interpret a second drag.
  window.addEventListener("pointerdown", (event) => {
    if (!enabled) return;
    if (
      nestedScroller(event) ||
      hasSelection(state) ||
      state.interaction.fixedGesturePointers.size > 2
    )
      state.interaction.fixedGesturePointers.delete(event.pointerId);
    else if (state.interaction.fixedGesturePointers.has(event.pointerId))
      send({ type: "gesture", active: true });
  });
  window.addEventListener(
    "pointermove",
    () => {
      if (enabled && hasSelection(state)) state.interaction.fixedGesturePointers.clear();
    },
    { capture: true },
  );
  for (const type of ["pointerup", "pointercancel"] as const)
    window.addEventListener(type, () => {
      if (enabled && state.interaction.fixedGesturePointers.size === 0 && !hasSelection(state))
        send({ type: "gesture", active: false });
    });
  window.addEventListener(
    "wheel",
    (event) => {
      if (
        !enabled ||
        event.ctrlKey ||
        event.metaKey ||
        event.defaultPrevented ||
        !eligibleInteractionEvent(state, event) ||
        hasSelection(state) ||
        nestedScroller(event)
      )
        return;
      event.preventDefault();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? window.innerHeight
            : 1;
      const bound = (value: number) => Math.max(-ROLL_MAX_DELTA, Math.min(ROLL_MAX_DELTA, value));
      send({ type: "scroll", x: bound(event.deltaX * unit), y: bound(event.deltaY * unit) });
    },
    { passive: false },
  );
}
