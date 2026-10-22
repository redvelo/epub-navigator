import type { ReaderStore } from "./lib/store.js";

export type { ReaderStore };
import type { ReactNode, Ref } from "react";
import type {
  NavigatorAnnotationAcknowledgment,
  NavigatorAnnotationMutationRequest,
  NavigatorAnnotationProjection,
  NavigatorAnnotationRecord,
} from "../annotations.js";
import type {
  AgentOperationCancellationReason,
  AnnotationTargetGenerationOutcome,
  AnnotationTargetGenerationUnavailableReason,
  FontScale,
  Hyphenation,
  LetterSpacing,
  LineHeight,
  ParagraphSpacing,
  NavigatorLocationSnapshot,
  PaginationColumns,
  PresentationMode,
  PublicationTheme,
  PublicationTypeface,
  ReadingMeasure,
  TextIndent,
  WordSpacing,
  TextAlignment,
} from "../generated/kernel.js";
import type {
  NavigatorReaderSession,
  PublicationFrameSandboxCapabilities,
} from "../publication.js";
import type { NavigatorDictionarySnapshot } from "../dictionary.js";
import type { NavigatorSearchSnapshot } from "../search.js";
import type {
  NavigatorDiagnostics,
  PublicationPaginationCapabilities,
} from "../runtime/pagination/index.js";
import type { NavigatorExternalFormAttempt } from "../runtime/navigator/api.js";
import type { PublicationSearchCapabilities } from "../runtime/search.js";
import type { PublicationDictionaryCapabilities } from "../runtime/dictionary.js";
import type { PublicationMediaOverlayCapabilities } from "../runtime/media-overlays/capabilities.js";
import type {
  NavigatorMediaOverlayRate,
  NavigatorMediaOverlayState,
  NavigatorMediaOverlayTiming,
} from "../runtime/media-overlays/controller.js";
import type {
  NavigatorReadingPosition,
  RestoreAnnotationTargetResult,
} from "../runtime/navigator/api.js";

export type {
  NavigatorAnnotationAcknowledgment,
  NavigatorAnnotationMutationRequest,
  NavigatorAnnotationProjection,
  NavigatorAnnotationRecord,
  NavigatorBookmarkAnnotationRecord,
  NavigatorHighlightAnnotationRecord,
  NavigatorNoteAnnotationRecord,
} from "../annotations.js";

export interface NavigatorAnnotationAction {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface NavigatorReaderHostControls {
  readonly quickMenu?: ReactNode | undefined;
  readonly deviceSettings?: ReactNode | undefined;
  // Absent: the reader uses the browser's Fullscreen API on its own element. `null`: none offered.
  readonly fullscreen?: NavigatorFullscreenController | null | undefined;
  /**
   * Reads one note out of the publication, so the reader can show it where the reader is rather
   * than taking the page to it. A host that cannot read notes leaves this out, and a reference
   * goes on navigating to its note as before.
   */
  readonly readNote?: ReadNote | undefined;
}

export interface NavigatorFullscreenController {
  readonly active: boolean;
  readonly toggle: () => void;
}

/** One note, as the host read it out of the publication the reader is showing. */
export interface NavigatorNote {
  /** The note element's content, which the reader sanitizes before rendering it. */
  readonly markup: string;
  readonly direction: "ltr" | "rtl" | "auto" | null;
  readonly language: string | null;
}

export type ReadNote = (
  request: { readonly resource: string; readonly fragment: string },
  signal: AbortSignal,
) => Promise<NavigatorNote | null>;

export interface NavigatorReaderProps {
  readonly interactionFeedback?: "standard" | "minimal" | undefined;
  readonly onReadingActivityChange?:
    | ((activity: {
        available: boolean;
        location: string;
        layout: string;
        pages: readonly string[];
      }) => void)
    | undefined;
  readonly onReadingSummaryChange?: ((summary: NavigatorReadingSummary) => void) | undefined;
  readonly ref?: Ref<NavigatorReaderHandle> | undefined;
  /** Host-owned immutable publication and lifetime identity for this reader runtime. */
  readonly session: NavigatorReaderSession;
  readonly initialReadingPosition?: (NavigatorReadingPosition | null) | undefined;
  /** Reports durable point or visible-occurrence changes, coalescing evidence-only revisions. */
  readonly onLocationChange?: ((snapshot: NavigatorLocationSnapshot) => void) | undefined;
  readonly onInitialRestoration?: ((result: RestoreAnnotationTargetResult) => void) | undefined;
  /** Store backing this reader. Supply one to inspect or drive reader state from the host. */
  readonly store?: ReaderStore | undefined;
  readonly className?: string | undefined;
  /** Which reader faces the host serves. A face the host cannot serve is not offered. */
  readonly readerTypefaces?: readonly PublicationTypeface[] | undefined;
  readonly selectionMenu?: ("auto" | "native" | "reader") | undefined;
  /** Controlled when present; controlledness must remain stable for this reader session. */
  readonly preferences?: NavigatorReaderPreferences | undefined;
  readonly onPreferencesChange?: ((preferences: NavigatorReaderPreferences) => void) | undefined;
  /** Controlled when present; controlledness must remain stable for this reader session. */
  readonly workspaceState?: NavigatorReaderWorkspaceState | undefined;
  readonly onWorkspaceStateChange?: ((state: NavigatorReaderWorkspaceState) => void) | undefined;
  readonly onLinkActivation?: ((activation: NavigatorLinkActivation) => void) | undefined;
  /** Reports bounded metadata for an external form attempt, never field values or user intent. */
  readonly onExternalFormAttempt?: ((attempt: NavigatorExternalFormAttempt) => void) | undefined;
  /** Immutable browser capabilities granted to publication frames for this reader session. */
  readonly frameSandbox?: PublicationFrameSandboxCapabilities | undefined;
  readonly onLibraryRequest?: (() => void) | undefined;
  readonly hostControls?: NavigatorReaderHostControls | undefined;
  /** Browser-observed publication traffic, supplied by the trusted host; not permission state. */
  readonly networkActivity?: {
    readonly sessionId: NavigatorReaderSession["id"];
    /** Unix epoch milliseconds of the last observation, not the last polling response. */
    readonly lastObservedAt: number;
  } | null;
  readonly annotations?: NavigatorAnnotationProjection | undefined;
  readonly onAnnotationMutation?:
    | ((
        request: NavigatorAnnotationMutationRequest,
        context: { readonly signal: AbortSignal },
      ) => Promise<NavigatorAnnotationAcknowledgment>)
    | undefined;
  readonly annotationAvailability?: ("pending" | "unavailable") | undefined;
  /** Host-owned entries appended to each annotation's action menu. */
  readonly annotationActions?:
    | ((record: NavigatorAnnotationRecord) => readonly NavigatorAnnotationAction[])
    | undefined;
  readonly search?: PublicationSearchCapabilities | undefined;
  readonly onSearchSnapshotChange?: ((snapshot: NavigatorSearchSnapshot) => void) | undefined;
  /** Host-owned offline dictionaries. Omission removes the Look up action. */
  readonly dictionary?: PublicationDictionaryCapabilities | undefined;
  readonly onDictionarySnapshotChange?:
    | ((snapshot: NavigatorDictionarySnapshot) => void)
    | undefined;
  /** Host-authored Media Overlay playback. Omission means narration is unavailable. */
  readonly mediaOverlays?: PublicationMediaOverlayCapabilities | undefined;
  /** Reports narration state, section, timing, and rate changes, such as for native media controls. */
  readonly onNarrationChange?: ((narration: NavigatorNarrationStatus) => void) | undefined;
  readonly pagination?: PublicationPaginationCapabilities | undefined;
  /** Passive reader lifecycle diagnostics. Omission disables diagnostics. */
  readonly diagnostics?: NavigatorDiagnostics | undefined;
  /** Operational state while a host acquires an optional pagination capability. */
  readonly paginationAvailability?: ("pending" | "unavailable") | undefined;
}

export interface NavigatorReadingSummary {
  readonly chapter: string | null;
  readonly pages: {
    readonly current: number;
    readonly total: number;
    readonly accuracy: "exact" | "calibrated";
  } | null;
}

export interface NavigatorReadingPositionCaptureOptions {
  readonly signal?: AbortSignal | undefined;
}

export type NavigatorReadingPositionCaptureResult =
  | ({ readonly status: "generated" } & NavigatorReadingPosition)
  | {
      readonly status: "unavailable";
      readonly reason:
        | "runtime-unavailable"
        | "current-location-unavailable"
        | AnnotationTargetGenerationUnavailableReason;
    }
  | Exclude<
      AnnotationTargetGenerationOutcome,
      { readonly status: "generated" | "unavailable" | "failed" }
    >
  | { readonly status: "failed"; readonly message: string | null }
  | {
      readonly status: "cancelled";
      readonly reason: AgentOperationCancellationReason | "abort" | "replacement";
    };

export interface NavigatorReaderHandle {
  /**
   * Leaves the reader's topmost surface, returning to the one it was opened from where there is
   * one. Reports whether a surface was there to leave, so a host's own Back can fall through.
   */
  dismissSurface(): boolean;
  /**
   * Moves the reading position one page, the way the reader's own page controls do. For a host
   * whose device turns pages with hardware its browser never sees, such as the side buttons of
   * an e-reader, which is why this does not depend on the keyboard preference or on focus.
   */
  turnPage(direction: "forward" | "backward"): void;
  captureReadingPosition(
    options?: NavigatorReadingPositionCaptureOptions,
  ): Promise<NavigatorReadingPositionCaptureResult>;
  /** Pauses narration when it is playing; resuming stays a reader action. */
  pauseNarration(): void;
  /** Starts or resumes narration for a user action outside the reader, such as a media notification. */
  playNarration(): void;
  nextNarrationSegment(): void;
  previousNarrationSegment(): void;
}

export interface NavigatorNarrationStatus {
  readonly state: NavigatorMediaOverlayState;
  /** Authored navigation label for the current section, when one exists. */
  readonly section: string | null;
  /** Section narration time when reported; hosts extrapolate it while playing. */
  readonly timing: NavigatorMediaOverlayTiming | null;
  readonly rate: NavigatorMediaOverlayRate;
}

export type {
  NavigatorReadingPosition,
  RestoreAnnotationTargetResult,
} from "../runtime/navigator/api.js";

export interface NavigatorReaderWorkspacePanelState {
  readonly open: boolean;
  readonly pinned: boolean;
  readonly width: number;
}

export interface NavigatorReaderWorkspaceState {
  readonly navigation: NavigatorReaderWorkspacePanelState;
  readonly annotations: NavigatorReaderWorkspacePanelState;
}

export interface NavigatorReaderPreferences {
  readonly colorScheme: "system" | "light" | "dark";
  readonly presentationMode: PresentationMode;
  readonly paginationColumns: PaginationColumns;
  readonly publicationTheme: PublicationTheme;
  readonly publicationTypeface: PublicationTypeface;
  readonly fontScale: FontScale;
  readonly lineHeight: LineHeight;
  readonly letterSpacing: LetterSpacing;
  readonly wordSpacing: WordSpacing;
  readonly paragraphSpacing: ParagraphSpacing;
  readonly textIndent: TextIndent;
  readonly measure: ReadingMeasure;
  readonly alignment: TextAlignment;
  readonly hyphenation: Hyphenation;
  readonly keyboardMode: "off" | "standard" | "vim";
  readonly touchZones: boolean;
  readonly clickZones?: boolean;
  /** Pitch-preserving Media Overlay playback rate. */
  readonly narrationRate: NavigatorMediaOverlayRate;
  /** Skippable structure types, such as `pagebreak`, that narration omits. */
  readonly narrationSkippedTypes: readonly string[];
}

export interface NavigatorLinkActivation {
  readonly href: string;
  readonly resolvedUrl: string;
  readonly target: string | null;
  readonly download: string | null;
  readonly internal: boolean;
  /**
   * Set when the publication authored this link as a reference to a note. `referenceRect` is the
   * reference's box in the document's own viewport, which a reader anchors its note surface to.
   */
  readonly note: {
    readonly referenceRect: { x: number; y: number; width: number; height: number } | null;
    /** What the publication printed as the reference, such as a number or a dagger. */
    readonly referenceLabel: string | null;
  } | null;
}

export type {
  MountedPublication,
  NavigatorReaderSession,
  ReaderSessionId,
} from "../publication.js";
