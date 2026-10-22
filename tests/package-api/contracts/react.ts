export { NavigatorReader } from "epub-navigator/react";
import type {
  NavigatorReaderHostControls as HostControls,
  NavigatorReaderPreferences as ReaderPreferences,
  NavigatorReaderProps as ReaderProps,
} from "epub-navigator/react";
export type {
  MountedPublication,
  NavigatorReaderSession,
  ReaderSessionId,
  NavigatorAnnotationAcknowledgment,
  NavigatorAnnotationMutationRequest,
  NavigatorAnnotationProjection,
  NavigatorAnnotationRecord,
  NavigatorBookmarkAnnotationRecord,
  NavigatorHighlightAnnotationRecord,
  NavigatorLinkActivation,
  NavigatorNarrationStatus,
  NavigatorNoteAnnotationRecord,
  NavigatorReaderHandle,
  NavigatorReaderHostControls,
  NavigatorReaderPreferences,
  NavigatorReaderProps,
  NavigatorReaderWorkspacePanelState,
  NavigatorReaderWorkspaceState,
  NavigatorReadingPosition,
  NavigatorReadingPositionCaptureOptions,
  NavigatorReadingPositionCaptureResult,
  RestoreAnnotationTargetResult,
} from "epub-navigator/react";

export type NavigatorReaderSessionProp = ReaderProps["session"];
export type NavigatorReaderHostControlsProp = ReaderProps["hostControls"];
export type NavigatorReaderQuickMenuControl = HostControls["quickMenu"];
export type NavigatorReaderDeviceSettingsControl = HostControls["deviceSettings"];
declare const readerPreferences: ReaderPreferences;
export const authoredPresentation: ReaderPreferences = {
  ...readerPreferences,
  presentationMode: "auto",
};
// @ts-expect-error ungrouped quick-menu controls are not part of the React API.
export type RemovedNavigatorReaderQuickMenuControlsProp = ReaderProps["quickMenuControls"];
// @ts-expect-error ungrouped settings controls are not part of the React API.
export type RemovedNavigatorReaderSettingsControlsProp = ReaderProps["settingsControls"];
// @ts-expect-error rendering policy is an invariant, not a reader prop.
export type RemovedNavigatorReaderRenderingProp = ReaderProps["rendering"];
// @ts-expect-error rendering policy is not a persisted reader preference.
export type RemovedNavigatorReaderRenderingPreference = ReaderPreferences["renderingMode"];
// @ts-expect-error publication-only construction is not part of the React API.
export type RemovedNavigatorReaderPublicationProp = ReaderProps["publication"];
