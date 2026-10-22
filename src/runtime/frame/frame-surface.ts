import { FrameRegistryRuntime } from "./frame-registry.js";
import { type OwnedFrame } from "../navigator/runtime-types.js";
import { currentObservation, currentReflowSettlement } from "../kernel-view.js";

/** Logical inline maximum per column. A wider margin is a narrower measure. */
const measureWidths = { narrow: 640, medium: 800, wide: 960 } as const;

export abstract class FrameSurfaceRuntime extends FrameRegistryRuntime {
  protected _hideFrame(frame: OwnedFrame): void {
    const document_ = frame.iframe.ownerDocument;
    if (document_.activeElement === frame.iframe) this._publicationHeldFocus = true;
    frame.iframe.inert = true;
    frame.iframe.tabIndex = -1;
    frame.iframe.setAttribute("aria-hidden", "true");
    frame.iframe.style.opacity = "0";
    frame.iframe.style.pointerEvents = "none";
  }

  protected _showFrame(frame: OwnedFrame): void {
    frame.iframe.inert = false;
    frame.iframe.removeAttribute("tabindex");
    frame.iframe.removeAttribute("aria-hidden");
    frame.iframe.title = this._frameTitle;
    frame.iframe.style.removeProperty("opacity");
    frame.iframe.style.removeProperty("pointer-events");
    if (!this._publicationHeldFocus || frame !== this._committed) return;
    // Only reclaim the focus the reader body inherited: anything focused since is not ours.
    this._publicationHeldFocus = false;
    if (frame.iframe.ownerDocument.activeElement === frame.iframe.ownerDocument.body) {
      frame.iframe.focus({ preventScroll: true });
    }
  }

  protected _syncReaderSurface(): void {
    const snapshot = this._kernel.snapshot();
    const preferences = snapshot.layout.preferences;
    const observation = currentObservation(snapshot);
    const reflow = currentReflowSettlement(snapshot);
    if (preferences.measure === "full-width" || observation === null || reflow === null) {
      this._frameStack.style.maxWidth = "none";
      this._frameStack.style.maxHeight = "none";
      return;
    }
    const columns =
      reflow.mode === "document-scroll" || preferences.paginationColumns === "single" ? 1 : 2;
    const perColumn = measureWidths[preferences.measure];
    const maximum = `${perColumn * columns + (columns === 2 ? 32 : 0)}px`;
    if (observation.writingMode === "horizontal-tb") {
      this._frameStack.style.maxWidth = maximum;
      this._frameStack.style.maxHeight = "none";
    } else {
      this._frameStack.style.maxWidth = "none";
      this._frameStack.style.maxHeight = maximum;
    }
  }
}
