import {
  type CreateNavigatorRuntimeOptions,
  type NavigatorLocationListener,
  type NavigatorSelectionSnapshot,
  type NavigatorRuntime,
  type NavigatorTransitionListener,
  type NavigatorErrorListener,
  type ReaderConfiguration,
  type NavigatorInteractionListener,
  type NavigatorSelectionListener,
  type NavigatorDecorationListener,
  type NavigatorDecorationActivationListener,
  type NavigatorActivationListener,
  type NavigatorExternalFormAttemptListener,
  type NavigatorFootnoteListener,
} from "./api.js";
import {
  type OwnedFrame,
  type OwnedAgentOperation,
  type OwnedLayoutOperation,
  type OwnedObservationOperation,
  type OwnedTocOperation,
  type ActiveFootnoteNavigation,
  type QueuedTransition,
  type PendingPromotion,
  type PendingCompanionActivation,
  type FixedSpreadStage,
  type FixedSpreadSuppression,
  type ResolvedFrameProfile,
} from "./runtime-types.js";
import type {
  ActiveDocumentParticipant,
  DecorationSnapshot,
  DocumentAdapter,
  NavigatorLocationSnapshot,
} from "../../generated/kernel.js";
import { BookPaginationController } from "../pagination/controller.js";
import { DiagnosticsClock } from "../diagnostics-clock.js";
import type {
  ForegroundPreparationClaim,
  PaginationSnapshotListener,
  NavigatorDiagnostics,
} from "../pagination/index.js";
import type { MountedPublication, NavigatorReaderSession } from "../../publication.js";
import type { NavigatorFootnoteReturnResult } from "../../footnotes.js";
import { NavigatorError } from "../../runtime.js";
import type { NavigatorKernelAccess } from "../kernel.js";
import { defaultAgentConfiguration } from "../agent-protocol/index.js";
import { copyConfiguration } from "./runtime-support.js";
import { installAgentMessageTransport } from "../agent/transport.js";
import type { NavigatorPresentationActivityListener } from "./api.js";

export type CreateRuntime = (
  options: CreateNavigatorRuntimeOptions,
  role: "foreground" | "auxiliary",
) => Promise<NavigatorRuntime>;

export abstract class RuntimeState {
  protected abstract _scheduleFixedViewportResize(): void;
  protected abstract _agentMessage(event: MessageEvent<unknown>): void;
  protected abstract _noteForegroundActivity(turn?: "presentation" | "command"): void;
  protected abstract _refreshCapturedSelectionGeometry(): void;
  protected abstract _evictAutomaticPreparation(): void;
  protected abstract _scheduleAdjacentPreparation(): void;

  protected readonly _kernel: NavigatorKernelAccess;
  protected readonly _session: NavigatorReaderSession;
  protected readonly _publication: MountedPublication;
  protected readonly _container: HTMLElement;
  protected readonly _frameStack: HTMLDivElement;
  protected readonly _frameTitle: string;
  protected readonly _frameProfile: ResolvedFrameProfile;
  protected readonly _role: "foreground" | "auxiliary";
  protected readonly _diagnostics: NavigatorDiagnostics | null;
  protected readonly _diagnosticsClock: DiagnosticsClock;
  protected _pending: OwnedFrame | null = null;
  protected _committed: OwnedFrame | null = null;
  /**
   * Whether the reader held focus inside a publication frame when that frame was hidden.
   *
   * `inert` blurs the element and everything in it, and clearing it does not give the focus back,
   * so hiding the frame a person is reading in hands focus to the reader body. Focus belongs to
   * whichever frame is committed, so it is reclaimed when the next one is shown rather than
   * returned to the frame that lost it: the reader may have moved on to another document.
   */
  protected _publicationHeldFocus = false;
  protected _companion: OwnedFrame | null = null;
  protected readonly _frames = new Map<number, OwnedFrame>();
  protected readonly _locatorOperations = new Map<number, OwnedAgentOperation>();
  protected readonly _layoutOperations = new Map<number, OwnedLayoutOperation>();
  protected readonly _tocOperations = new Map<number, OwnedTocOperation>();
  protected readonly _observationOperations = new Map<number, OwnedObservationOperation>();
  /** Reader-issued operations that bypass the kernel share one id space above the kernel's. */
  protected _nextDirectOperation = 0x8000_0000;
  protected readonly _documentObservation: boolean;
  protected readonly _listeners = new Set<NavigatorTransitionListener>();
  protected readonly _errorListeners = new Set<NavigatorErrorListener>();
  protected readonly _interactionListeners = new Set<NavigatorInteractionListener>();
  protected readonly _selectionListeners = new Set<NavigatorSelectionListener>();
  protected readonly _locationListeners = new Set<NavigatorLocationListener>();
  protected readonly _decorationListeners = new Set<NavigatorDecorationListener>();
  protected readonly _decorationActivationListeners =
    new Set<NavigatorDecorationActivationListener>();
  protected readonly _activationListeners = new Set<NavigatorActivationListener>();
  protected readonly _externalFormAttemptListeners =
    new Set<NavigatorExternalFormAttemptListener>();
  protected readonly _footnoteListeners = new Set<NavigatorFootnoteListener>();
  protected readonly _presentationActivityListeners =
    new Set<NavigatorPresentationActivityListener>();
  protected _activeFootnote: ActiveFootnoteNavigation | null = null;
  protected _pendingFootnoteReturn: {
    readonly participant: ActiveDocumentParticipant | null;
    readonly generation: number | null;
    readonly activationId: number;
    readonly resolve: (result: NavigatorFootnoteReturnResult) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;
  protected readonly _paginationListeners = new Set<PaginationSnapshotListener>();
  protected readonly _transitionQueue: QueuedTransition[] = [];
  protected _applicationDepth = 0;
  protected _publishing = false;
  protected _terminalError: NavigatorError | undefined;
  protected _closed = false;
  protected _restoreController: AbortController | null = null;
  protected _configuration: ReaderConfiguration = copyConfiguration(defaultAgentConfiguration);
  protected readonly _messageController = new AbortController();
  protected _paginationController: BookPaginationController | null = null;
  protected _paginationUnsubscribe: (() => void) | null = null;
  protected _paginationCapabilitySignal: AbortSignal | null = null;
  protected _paginationCapabilityAbortListener: (() => void) | null = null;
  protected _foregroundPreparationPaths: ReadonlySet<string> | null = null;
  protected readonly _preparationClaims = new Map<number, ForegroundPreparationClaim>();
  /** Occurrences whose prepared frame the kernel dropped, keyed to the committed generation. */
  protected readonly _failedPreparations = new Map<
    number,
    { readonly layoutKey: string; readonly drops: number }
  >();
  protected _preparationScheduled = false;
  /** Generation of a freshly committed document whose first observation is still pending. */
  protected _preparationGate: {
    readonly generation: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** Retry budget for a reconciliation the content agent abandoned while the document moved. */
  protected _decorationRetry: {
    readonly generation: number;
    readonly projectionRevision: number;
    readonly attempts: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;
  protected _pendingPromotion: PendingPromotion | null = null;
  protected _pendingCompanionActivation: PendingCompanionActivation | null = null;
  protected _releasedCommitted: {
    readonly occurrence: number;
    readonly adapter: DocumentAdapter;
  } | null = null;
  protected _fixedSpreadStage: FixedSpreadStage | null = null;
  protected _fixedSpreadSuppression: FixedSpreadSuppression | null = null;
  protected _fixedSpreadFallbackInProgress = false;
  protected _nextRoleChange = 1;
  protected readonly _frameStackResizeObserver: ResizeObserver | null;
  protected _frameStackResizeScheduled = false;
  protected _frameStackSize: { readonly width: number; readonly height: number };
  protected _fixedZoom = 1;
  protected _fixedPan = { x: 0, y: 0 };
  protected _selectionSnapshot: NavigatorSelectionSnapshot = Object.freeze({
    revision: 0,
    selection: null,
  });
  protected _selectionKey = "null";
  protected _latestSelectionOperation: number | null = null;
  protected _locationSnapshot: NavigatorLocationSnapshot = Object.freeze({
    revision: 0,
    location: null,
    basis: null,
    visibleOccurrences: null,
  });
  protected _locationKey = JSON.stringify({
    location: null,
    basis: null,
    visibleOccurrences: null,
  });
  protected _selectionSignalParticipant: ActiveDocumentParticipant | null = null;
  protected _selectionSignalRevision = 0;
  protected _selectionRefreshRunning = false;
  protected _decorationSnapshot: DecorationSnapshot;
  protected _decorationKey: string;
  protected readonly _createRuntime: CreateRuntime;

  constructor(
    kernel: NavigatorKernelAccess,
    session: NavigatorReaderSession,
    container: HTMLElement,
    frameTitle: string,
    frameProfile: ResolvedFrameProfile,
    role: "foreground" | "auxiliary",
    diagnostics: NavigatorDiagnostics | null,
    createRuntime: CreateRuntime,
    documentObservation: boolean,
  ) {
    this._kernel = kernel;
    this._session = session;
    this._publication = session.publication;
    this._container = container;
    this._frameTitle = frameTitle;
    this._frameProfile = frameProfile;
    this._role = role;
    this._diagnostics = diagnostics;
    this._diagnosticsClock = new DiagnosticsClock(diagnostics?.now);
    this._createRuntime = createRuntime;
    this._documentObservation = documentObservation;
    this._decorationSnapshot = this._kernel.snapshot().decorations;
    this._decorationKey = JSON.stringify(this._decorationSnapshot);
    const runtimeWindow = container.ownerDocument.defaultView;
    if (runtimeWindow === null) throw new Error("the Navigator container has no owning window");
    this._frameStack = container.ownerDocument.createElement("div");
    if (role === "foreground") this._frameStack.dataset.epubNavigatorFrameStack = "";
    this._frameStack.style.position = "relative";
    this._frameStack.style.width = "100%";
    this._frameStack.style.height = "100%";
    this._frameStack.style.marginInline = "auto";
    this._frameStack.style.colorScheme = this._kernel.snapshot().layout.preferences.colorScheme;
    this._container.append(this._frameStack);
    this._frameStackSize = {
      width: this._frameStack.clientWidth,
      height: this._frameStack.clientHeight,
    };
    this._frameStackResizeObserver =
      typeof runtimeWindow.ResizeObserver === "undefined"
        ? null
        : new runtimeWindow.ResizeObserver(() => this._scheduleFixedViewportResize());
    this._frameStackResizeObserver?.observe(this._frameStack);
    installAgentMessageTransport(runtimeWindow, this._messageController.signal, (event) =>
      this._agentMessage(event),
    );
    container.addEventListener("pointerdown", () => this._noteForegroundActivity(), {
      capture: true,
      passive: true,
      signal: this._messageController.signal,
    });
    for (const type of ["scroll", "resize"] as const) {
      runtimeWindow.visualViewport?.addEventListener(
        type,
        () => this._refreshCapturedSelectionGeometry(),
        { passive: true, signal: this._messageController.signal },
      );
    }
    container.ownerDocument.addEventListener(
      "visibilitychange",
      () => {
        if (container.ownerDocument.hidden) this._evictAutomaticPreparation();
        else this._scheduleAdjacentPreparation();
      },
      { signal: this._messageController.signal },
    );
  }
}
