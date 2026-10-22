import type {
  NavigatorMediaOverlayAvailability,
  NavigatorMediaOverlayDescriptionOutcome,
  NavigatorMediaOverlayTimelineOutcome,
} from "../../media-overlays.js";

/** Optional host capability for one mounted publication's authored Media Overlays. */
export interface PublicationMediaOverlayCapabilities {
  readonly availability: NavigatorMediaOverlayAvailability;
  /** Aborts when the host revokes the publication-scoped provider. */
  readonly signal: AbortSignal;
  description(context: {
    readonly signal: AbortSignal;
  }): Promise<NavigatorMediaOverlayDescriptionOutcome>;
  timeline(
    overlayIndex: number,
    context: { readonly signal: AbortSignal },
  ): Promise<NavigatorMediaOverlayTimelineOutcome>;
  /** Releases the publication-scoped provider. Must be safe to call more than once. */
  close(): void;
}
