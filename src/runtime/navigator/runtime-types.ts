import type { DocumentObservationResult } from "../agent-protocol/index.js";
import type {
  ActiveDocumentParticipant,
  AgentOperationFailure,
  AgentRequest,
  NavigatorCommand,
  AgentOperationKind,
  AnnotationSelectorExecutionReport,
  AnnotationSelectorNode,
  AnnotationRangeAdjustmentOutcome,
  AnnotationTargetGenerationOutcome,
  AnnotationTargetReconciliationResult,
  DecorationRecordResult,
  DocumentAdapter,
  FixedIntrinsicViewport,
  FixedPageGeometry,
  KernelEffect,
  KernelTransition,
  LayoutInvalidationCause,
  LayoutPhase,
  LocatorResolutionStatus,
  NativeSelectionCaptureOutcome,
  PresentationAdvanceStatus,
  NavigatorLocation,
} from "../../generated/kernel.js";
import { resolveFrameProfile } from "../frame-profile.js";
import type {
  AgentActivationMessage,
  AgentRole,
  TocTargetMeasurementResult,
} from "../agent-protocol/index.js";
import type {
  CurrentLocationCaptureOutcome,
  MediaOverlayEntryOutcome,
} from "../../generated/kernel.js";

export type ActivationRequest = Pick<
  AgentActivationMessage,
  "href" | "resolvedUrl" | "target" | "download" | "footnote"
>;

export interface OwnedFrame {
  readonly iframe: HTMLIFrameElement;
  readonly frameGeneration: number;
  readonly occurrence: number;
  readonly resource: string;
  readonly adapter: DocumentAdapter;
  readonly controller: AbortController;
  readonly session: string;
  fixedViewport: FixedIntrinsicViewport | null;
  fixedGeometry: FixedPageGeometry | null;
  documentGeneration: number | null;
  role: AgentRole;
  phase:
    | "loading"
    | "agent-initializing"
    | "presentation-initializing"
    | "prepared"
    | "promotion-acknowledging"
    | "committed";
  readinessTimer: ReturnType<typeof setTimeout> | null;
  window: Window | null;
  invalidated: boolean;
  readonly diagnosticsCreatedAt: number;
  diagnosticsLoadedAt: number | null;
  diagnosticsAgentReadyAt: number | null;
  diagnosticsTerminal: boolean;
}

export interface OwnedAgentOperation {
  readonly participant: ActiveDocumentParticipant;
  readonly generation: number;
  readonly occurrence: number;
  readonly resource: string;
  readonly frameGeneration: number;
  readonly type: AgentOperationKind;
  readonly annotationSelectors: ReadonlyMap<string, string> | null;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly promise: Promise<AgentOperationOutcome>;
  cancellationSent: boolean;
  finish(outcome: AgentOperationOutcome): void;
}

export function annotationSelectorMap(
  selectors: readonly AnnotationSelectorNode[],
  result = new Map<string, string>(),
): ReadonlyMap<string, string> {
  for (const selector of selectors) {
    result.set(selector.path.join("."), selector.kind);
    annotationSelectorMap(selector.refinements, result);
  }
  return result;
}

export function annotationReportsMatch(
  expected: ReadonlyMap<string, string> | null,
  reports: readonly AnnotationSelectorExecutionReport[],
): boolean {
  if (expected === null) return false;
  return reports.every((report) => expected.get(report.path.join(".")) === report.kind);
}

export interface OwnedLayoutOperation {
  readonly operation: number;
  readonly frameGeneration: number;
  readonly participant: ActiveDocumentParticipant | null;
  readonly documentGeneration: number | null;
  readonly layoutGeneration: number;
  readonly phase: LayoutPhase | "prepared";
  readonly adapter: DocumentAdapter;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly startedAt: number;
  cancellationSent: boolean;
}

export interface OwnedObservationOperation {
  readonly frameGeneration: number;
  readonly generation: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | null;
  readonly abortListener: (() => void) | null;
  finish(result: DocumentObservationResult): void;
  fail(error: Error): void;
}

export interface OwnedTocOperation {
  readonly owner: "committed" | "prepared";
  readonly generation: number | null;
  readonly occurrence: number;
  readonly frameGeneration: number;
  readonly layoutGeneration: number;
  readonly pageCount: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly identities: ReadonlySet<string>;
  readonly signal: AbortSignal | null;
  readonly abortListener: (() => void) | null;
  cancellationSent: boolean;
  finish(result: readonly TocTargetMeasurementResult[]): void;
  fail(error: Error): void;
}

export type AgentOperationOutcome =
  | {
      readonly outcome: "completed";
      readonly status: LocatorResolutionStatus | PresentationAdvanceStatus;
    }
  | {
      readonly outcome: "completed";
      readonly result:
        | AnnotationTargetReconciliationResult
        | AnnotationTargetGenerationOutcome
        | AnnotationRangeAdjustmentOutcome;
    }
  | { readonly outcome: "completed"; readonly selection: NativeSelectionCaptureOutcome }
  | {
      readonly outcome: "completed";
      readonly locationCapture: CurrentLocationCaptureOutcome;
    }
  | {
      readonly outcome: "completed";
      readonly mediaOverlayEntry: MediaOverlayEntryOutcome;
    }
  | {
      readonly outcome: "completed";
      readonly projectionRevision: number;
      readonly decorations: readonly DecorationRecordResult[];
    }
  | { readonly outcome: "failed"; readonly failure: AgentOperationFailure };

export type LocatorAgentRequest = Extract<AgentRequest, { type: "resolve-locator" | "relocate" }>;

export type AnnotationAgentRequest = Extract<
  AgentRequest,
  { type: "resolve-annotation-target" | "relocate-annotation-target" }
>;

export type PresentationAdvanceCommand = Extract<
  NavigatorCommand,
  { type: "advance-presentation" }
>;

export interface ActiveFootnoteNavigation {
  readonly activationId: number;
  readonly participant: ActiveDocumentParticipant | null;
  readonly source: Extract<NavigatorLocation, { kind: "point" }>;
  readonly destinationOccurrence: number;
  readonly destinationResource: string;
  readonly pendingGeneration: number | null;
}

export interface QueuedTransition {
  readonly transition: KernelTransition;
  complete: boolean;
}

export interface PendingPromotion {
  readonly target: OwnedFrame;
  readonly outgoing: OwnedFrame | null;
  readonly effect: Extract<KernelEffect, { type: "promote-frame" }>;
  readonly roleChange: number;
  readonly timer: ReturnType<typeof setTimeout>;
  queued: QueuedTransition | null;
}

export interface PendingCompanionActivation {
  readonly target: OwnedFrame;
  readonly participant: Extract<ActiveDocumentParticipant, { kind: "fixed-companion" }>;
  roleChange: number;
  deferredInvalidation: LayoutInvalidationCause | null;
  queued: QueuedTransition | null;
}

export interface FixedSpreadStage {
  readonly documentGeneration: number;
  readonly primary: OwnedFrame;
  readonly companionOccurrence: number;
  readonly timer: ReturnType<typeof setTimeout>;
  viewportInvalidated: boolean;
}

export interface FixedSpreadSuppression {
  readonly documentGeneration: number;
  readonly companionOccurrence: number;
  readonly reason: "failure" | "resize";
}

export type ResolvedFrameProfile = ReturnType<typeof resolveFrameProfile>;
