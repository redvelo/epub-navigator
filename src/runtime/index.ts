export { createNavigatorKernel } from "./kernel.js";
export type { NavigatorKernelAccess } from "./kernel.js";
export type {
  NavigatorReaderSession,
  PublicationFrameSandboxCapabilities,
  ReaderSessionId,
} from "../publication.js";
export type {
  AnnotationRangeAdjustmentOutcome,
  AnnotationRangeEdge,
  AnnotationRangeMovement,
  NavigatorLocationCapture,
  NavigatorLocationSnapshot,
  FontScale,
  Hyphenation,
  LineHeight,
  PresentationMode,
  PresentationPreferences,
  PublicationTheme,
  PublicationTypeface,
  ReadingMeasure,
  RootScrollbar,
  TextAlignment,
} from "../generated/kernel.js";
export type { NavigatorFootnoteNavigation, NavigatorFootnoteReturnResult } from "../footnotes.js";
export { createNavigatorRuntime } from "./navigator/browser-runtime.js";
export { CONTENT_AGENT_PROTOCOL_VERSION } from "./agent-protocol/index.js";
export { createNavigatorSearchCoordinator, NavigatorSearchContractError } from "./search.js";
export type {
  CreateNavigatorSearchCoordinatorOptions,
  NavigatorSearchCoordinator,
  PublicationSearchCapabilities,
} from "./search.js";
export {
  createNavigatorDictionaryCoordinator,
  NavigatorDictionaryContractError,
} from "./dictionary.js";
export type {
  CreateNavigatorDictionaryCoordinatorOptions,
  NavigatorDictionaryAudioElement,
  NavigatorDictionaryCoordinator,
  PublicationDictionaryCapabilities,
} from "./dictionary.js";
export type { PublicationMediaOverlayCapabilities } from "./media-overlays/capabilities.js";
export { isPreferenceValue, navigatorReaderPreferenceValues } from "./preference-values.js";
export {
  MEDIA_OVERLAY_RATES,
  createNavigatorMediaOverlayController,
  isNavigatorMediaOverlayRate,
} from "./media-overlays/controller.js";
export type {
  CreateNavigatorMediaOverlayControllerOptions,
  NavigatorMediaOverlayAudio,
  NavigatorMediaOverlayController,
  NavigatorMediaOverlayRate,
  NavigatorMediaOverlayReason,
  NavigatorMediaOverlayRuntime,
  NavigatorMediaOverlaySnapshot,
  NavigatorMediaOverlayState,
  NavigatorMediaOverlayTiming,
} from "./media-overlays/controller.js";
export type {
  BookPaginationSnapshot,
  ForegroundPreparationClaim,
  OccurrencePagination,
  PaginationBasis,
  PaginationCancellationReason,
  PaginationCacheMutation,
  NavigatorDiagnosticEvent,
  NavigatorDiagnostics,
  PaginationMeasurementCache,
  PaginationMeasurementResponses,
  PaginationSnapshotListener,
  PublicationPaginationCapabilities,
  TocTargetPagination,
} from "./pagination/index.js";
export type {
  AgentRole,
  DocumentObservationFonts,
  DocumentObservationQuery,
  DocumentObservationQueryResult,
  DocumentObservationRect,
  DocumentObservationRequest,
  DocumentObservationResource,
  DocumentObservationResult,
  DocumentObservationStyleProperty,
  TocTargetIdentity,
  TocTargetMeasurementRequest,
  TocTargetMeasurementResult,
  TocTargetPageResult,
} from "./agent-protocol/index.js";
export type {
  AgentOperationContext,
  AgentOperationResult,
  AnnotationRangeAdjustment,
  AnnotationTargetGenerationOperationResult,
  AnnotationTargetGenerationOptions,
  AnnotationTargetOperationResult,
  CreateNavigatorRuntimeOptions,
  LocatorResolution,
  MediaOverlayActiveResult,
  MediaOverlayActiveTarget,
  MediaOverlayEntryResult,
  NavigatorActivation,
  NavigatorActivationListener,
  NavigatorDecorationActivation,
  NavigatorDecorationActivationListener,
  NavigatorDecorationListener,
  NavigatorErrorListener,
  NavigatorExternalFormAttempt,
  NavigatorExternalFormAttemptListener,
  NavigatorInteraction,
  NavigatorInteractionListener,
  NavigatorSelectionListener,
  NavigatorLocationListener,
  NavigatorPresentationActivityListener,
  NavigatorReadingPosition,
  NavigatorSelectionSnapshot,
  NavigatorRuntime,
  NavigatorTransitionListener,
  PresentationAdvanceResult,
  ReaderConfiguration,
  RelocationResult,
  RestoreAnnotationTargetOptions,
  RestoreAnnotationTargetResult,
  SelectionCaptureOperationResult,
  DocumentObservationOptions,
  TocTargetMeasurementOptions,
} from "./navigator/api.js";
export type { VisibleCompanionOccurrence, VisibleOccurrenceRange } from "../generated/kernel.js";
