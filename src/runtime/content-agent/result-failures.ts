import type {
  AgentAnnotationPointTargetGenerationResultMessage,
  AgentAnnotationRangeAdjustmentResultMessage,
  AgentAnnotationTargetGenerationResultMessage,
  AgentDecorationResultMessage,
  AgentRequestMessage,
  AgentResultMessage,
  AgentSelectionResultMessage,
  AgentTocTargetsResultMessage,
} from "../agent-protocol/index.js";
import type { LayoutResult } from "../../generated/kernel.js";
import type { ContentAgentState } from "./state.js";
import type { OutboundMessageInput } from "./transport.js";
import { CONTENT_AGENT_NAMESPACE } from "../agent-protocol/index.js";
import { annotationTargetResult, unsupportedAnnotationTarget } from "./targets/annotation.js";
import { selectionCaptureBasis } from "./selection/capture.js";
import { post } from "./transport.js";

export function postRequestFailure(
  state: ContentAgentState,
  request: AgentRequestMessage,
  cause: unknown,
): void {
  if (request.request.type === "layout") {
    const result: LayoutResult =
      request.request.adapter === "fixed-svg" || request.request.adapter === "fixed-image"
        ? {
            adapter: request.request.adapter,
            outcome: { status: "unavailable", issue: "final-viewport-unavailable" },
          }
        : request.request.adapter === "fixed-xhtml"
          ? {
              adapter: "fixed-xhtml",
              outcome: { status: "unavailable", issue: "agent-style-unavailable" },
            }
          : {
              adapter: "reflowable-xhtml",
              outcome: { status: "unavailable", issue: "agent-style-unavailable" },
            };
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "result",
      operation: request.operation,
      resultType: "layout",
      result,
    });
    return;
  }
  if (request.request.type === "measure-toc-targets") {
    const message = cause instanceof Error ? cause.message : "content-agent operation failed";
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "result",
      operation: request.operation,
      resultType: "measure-toc-targets",
      results: request.request.targets.map((target) => ({
        listIndex: target.listIndex,
        pointPath: target.pointPath,
        result: { state: "failed", message },
      })),
    } satisfies OutboundMessageInput<AgentTocTargetsResultMessage>);
    return;
  }
  if (request.request.type === "reconcile-decorations") {
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "result",
      operation: request.operation,
      resultType: "reconcile-decorations",
      projectionRevision: request.request.projectionRevision,
      outcomes: request.request.records.map(({ id }) => ({
        id,
        outcome: {
          status: "failed",
          message:
            cause instanceof Error && new TextEncoder().encode(cause.message).byteLength <= 16384
              ? cause.message
              : null,
        },
      })),
    } satisfies OutboundMessageInput<AgentDecorationResultMessage>);
    return;
  }
  if (request.request.type === "generate-annotation-target") {
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "result",
      operation: request.operation,
      resultType: "generate-annotation-target",
      candidate: {
        localContentBasis: request.request.localContentBasis,
        textFragmentPolicy: request.request.textFragmentPolicy,
        status: {
          status: "failed",
          message: cause instanceof Error ? cause.message : null,
        },
      },
    } satisfies OutboundMessageInput<AgentAnnotationTargetGenerationResultMessage>);
    return;
  }
  if (request.request.type === "generate-current-location-annotation-target") {
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "result",
      operation: request.operation,
      resultType: "generate-current-location-annotation-target",
      candidate: {
        localContentBasis: request.request.localContentBasis,
        status: { status: "failed", message: cause instanceof Error ? cause.message : null },
      },
    } satisfies OutboundMessageInput<AgentAnnotationPointTargetGenerationResultMessage>);
    return;
  }
  if (request.request.type === "adjust-annotation-range") {
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "result",
      operation: request.operation,
      resultType: "adjust-annotation-range",
      candidate: {
        projectionRevision: request.request.projectionRevision,
        recordId: request.request.recordId,
        edge: request.request.edge,
        movement: request.request.movement,
        status: {
          status: "failed",
          message: cause instanceof Error ? cause.message : null,
        },
        excerpt: null,
      },
    } satisfies OutboundMessageInput<AgentAnnotationRangeAdjustmentResultMessage>);
    return;
  }
  if (
    request.request.type === "resolve-annotation-target" ||
    request.request.type === "relocate-annotation-target"
  ) {
    const message = cause instanceof Error ? cause.message : "content-agent operation failed";
    const base = unsupportedAnnotationTarget(request.request.plan.selectors);
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "result",
      operation: request.operation,
      resultType: request.request.type,
      result: annotationTargetResult(request.request.plan.resource, {
        ...base,
        outcome: "failed",
        reports: base.reports.map((report) => ({ ...report, outcome: "failed", message })),
      }),
    } satisfies OutboundMessageInput<AgentResultMessage>);
    return;
  }
  if (request.request.type === "capture-selection") {
    const basis = selectionCaptureBasis(state);
    const failureMessage =
      cause instanceof Error && new TextEncoder().encode(cause.message).byteLength <= 16384
        ? cause.message
        : null;
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "result",
      operation: request.operation,
      resultType: "capture-selection",
      outcome: {
        status: "failed",
        message: failureMessage,
        basis,
      },
    } satisfies OutboundMessageInput<AgentSelectionResultMessage>);
    return;
  }
  if (request.request.type === "find-media-overlay-entry") {
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "result",
      operation: request.operation,
      resultType: "find-media-overlay-entry",
      outcome: { state: "unavailable" },
    } satisfies OutboundMessageInput<AgentResultMessage>);
    return;
  }
  if (request.request.type === "capture-current-location") {
    post(state, {
      namespace: CONTENT_AGENT_NAMESPACE,
      type: "result",
      operation: request.operation,
      resultType: "capture-current-location",
      outcome: {
        status: "failed",
        message:
          cause instanceof Error && new TextEncoder().encode(cause.message).byteLength <= 16384
            ? cause.message
            : null,
        basis: selectionCaptureBasis(state),
      },
    } satisfies OutboundMessageInput<AgentResultMessage>);
    return;
  }
  if (request.request.type === "observe-document") return;
  post(state, {
    namespace: CONTENT_AGENT_NAMESPACE,
    type: "result",
    operation: request.operation,
    resultType: request.request.type,
    status: {
      status: "failed",
      message: cause instanceof Error ? cause.message : "content-agent operation failed",
    },
  } satisfies OutboundMessageInput<AgentResultMessage>);
}
