import { RuntimeState } from "./runtime-state.js";
import type {
  ActiveDocumentParticipant,
  KernelInput,
  KernelSnapshot,
  KernelTransition,
  NativeSelectionCaptureOutcome,
  VisibleOccurrenceRange,
} from "../../generated/kernel.js";
import type {
  NavigatorTransitionListener,
  PresentationAdvanceResult,
  ReaderConfiguration,
} from "./api.js";
import type {
  ActiveFootnoteNavigation,
  ActivationRequest,
  OwnedAgentOperation,
  OwnedFrame,
  OwnedLayoutOperation,
  PendingPromotion,
  PresentationAdvanceCommand,
} from "./runtime-types.js";
import type {
  PaginationCancellationReason,
  NavigatorDiagnosticEvent,
} from "../pagination/index.js";
import type { AgentVisualViewportAnchor, ContentAgentOperation } from "../agent-protocol/index.js";
import type { fixedSpreadPlan } from "../kernel-view.js";

/** Shared runtime state. Capability classes provide the concrete operations. */
export abstract class RuntimeBase extends RuntimeState {
  protected abstract _acceptActivationRequest(
    frame: OwnedFrame,
    participant: ActiveDocumentParticipant,
    activation: ActivationRequest,
  ): void;
  protected abstract _agentConfiguration(): ReaderConfiguration;
  protected abstract _applyTransition(
    transition: KernelTransition,
    beforeEffects?: () => void,
    afterEffects?: () => void,
  ): KernelTransition;
  protected abstract _assertOpen(): void;
  protected abstract _cancelFrame(frameGeneration: number): void;
  protected abstract _cancelLayoutOperation(
    frame: OwnedFrame,
    operation: OwnedLayoutOperation,
    reason?: PaginationCancellationReason,
  ): void;
  protected abstract _cancelLocatorOperation(
    frame: OwnedFrame,
    operationId: number,
    operation: OwnedAgentOperation,
    reason?: PaginationCancellationReason,
  ): void;
  protected abstract _cancelRestore(reason: "superseded" | "replacement" | "close"): void;
  protected abstract _clearAllLayoutOperations(): void;
  protected abstract _clearFixedSpreadStage(): void;
  protected abstract _coordinateFixedSpread(): boolean;
  protected abstract _dispatchAndApply(input: KernelInput): KernelTransition;
  protected abstract _evictPreparedFramesFromKernel(): void;
  protected abstract _fixedSpreadPlan(
    snapshot: KernelSnapshot,
    primaryOccurrence: number,
    viewportWidth: number,
    viewportHeight: number,
    backwardCompanionOccurrence?: number | null,
  ): ReturnType<typeof fixedSpreadPlan>;
  protected abstract _visibleOccurrenceRange(): VisibleOccurrenceRange | null;
  protected abstract _frameForParticipant(
    participant: ActiveDocumentParticipant,
  ): OwnedFrame | null;
  protected abstract _handleBoundaryFailure(cause: unknown): void;
  protected abstract _handlePublicationMessageFailure(cause: unknown): void;
  protected abstract _hideFrame(frame: OwnedFrame): void;
  protected abstract _now(): number;
  protected abstract _participantForFrame(frame: OwnedFrame): ActiveDocumentParticipant | null;
  protected abstract _postOperationCancellation(
    frame: OwnedFrame,
    operation: number,
    operationType: ContentAgentOperation,
  ): void;
  protected abstract _publishQueuedTransitions(): void;
  protected abstract _record(event: NavigatorDiagnosticEvent): void;
  protected abstract _releasePreparationClaim(occurrence: number, preserveAccepted: boolean): void;
  protected abstract _releasePreparationClaims(): void;
  protected abstract _runPresentationOperation(
    request: PresentationAdvanceCommand,
  ): Promise<PresentationAdvanceResult>;
  protected abstract _selectionAnchorInReader(
    frame: OwnedFrame,
    anchor: AgentVisualViewportAnchor,
  ): Extract<NativeSelectionCaptureOutcome, { status: "captured" }>["anchor"] | null;
  protected abstract _setActiveFootnote(active: ActiveFootnoteNavigation | null): void;
  protected abstract _settlePromotionPublication(promotion: PendingPromotion): void;
  protected abstract _showFrame(frame: OwnedFrame): void;
  protected abstract _accepted(transition: KernelTransition): KernelTransition;
  abstract subscribe(listener: NavigatorTransitionListener): () => void;
}
