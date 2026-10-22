import { LocationCoordinatorRuntime } from "./location-coordinator.js";
import { type OwnedFrame } from "../navigator/runtime-types.js";
import { intersectRectangles } from "../navigator/runtime-support.js";
import type { NativeSelectionCaptureOutcome } from "../../generated/kernel.js";
import type {
  AgentVisualViewportAnchor,
  AgentVisualViewportRect,
} from "../agent-protocol/index.js";

export abstract class ViewportAnchorRuntime extends LocationCoordinatorRuntime {
  protected _selectionAnchorInReader(
    frame: OwnedFrame,
    anchor: AgentVisualViewportAnchor,
  ): Extract<NativeSelectionCaptureOutcome, { status: "captured" }>["anchor"] | null {
    const readerWindow = this._container.ownerDocument.defaultView;
    const localWidth = frame.iframe.clientWidth;
    const localHeight = frame.iframe.clientHeight;
    if (readerWindow === null || localWidth <= 0 || localHeight <= 0) return null;
    const frameRect = frame.iframe.getBoundingClientRect();
    const scaleX = frameRect.width / localWidth;
    const scaleY = frameRect.height / localHeight;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
      return null;
    }
    const readerViewport = readerWindow.visualViewport;
    const readerOffset = {
      x: readerViewport?.offsetLeft ?? 0,
      y: readerViewport?.offsetTop ?? 0,
    };
    const convert = (rect: AgentVisualViewportRect) => ({
      x: frameRect.left + (rect.x + anchor.visualViewportOffset.x) * scaleX - readerOffset.x,
      y: frameRect.top + (rect.y + anchor.visualViewportOffset.y) * scaleY - readerOffset.y,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    });
    const rect = convert(anchor.rect);
    const localClip = convert(anchor.clippingRect);
    const shell = this._frameStack.getBoundingClientRect();
    const shellClip = {
      x: shell.left - readerOffset.x,
      y: shell.top - readerOffset.y,
      width: shell.width,
      height: shell.height,
    };
    const viewportClip = {
      x: 0,
      y: 0,
      width: readerViewport?.width ?? readerWindow.innerWidth,
      height: readerViewport?.height ?? readerWindow.innerHeight,
    };
    return {
      rect,
      clippingRect: intersectRectangles(intersectRectangles(localClip, shellClip), viewportClip),
    };
  }
}
