export interface EpubEventCapabilities {
  readonly touch: boolean;
  readonly mouse: boolean;
  readonly keyboard: boolean;
}

export function readingSystemFeature(
  feature: string,
  capabilities: EpubEventCapabilities,
): boolean | undefined {
  if (
    feature === "dom-manipulation" ||
    feature === "layout-changes" ||
    feature === "spine-scripting"
  ) {
    return true;
  }
  if (feature === "touch-events") return capabilities.touch;
  if (feature === "mouse-events") return capabilities.mouse;
  if (feature === "keyboard-events") return capabilities.keyboard;
  return undefined;
}
