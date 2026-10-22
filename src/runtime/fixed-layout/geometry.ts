import type { FixedIntrinsicViewport, FixedPageGeometry } from "../../generated/kernel.js";

export function fixedPageGeometry(
  intrinsicViewport: FixedIntrinsicViewport,
  containingWidth: number,
  containingHeight: number,
): FixedPageGeometry | null {
  if (containingWidth <= 0 || containingHeight <= 0) return null;
  const scale = Math.min(
    containingWidth / intrinsicViewport.width,
    containingHeight / intrinsicViewport.height,
  );
  const renderedWidth = Math.min(containingWidth, intrinsicViewport.width * scale);
  const renderedHeight = Math.min(containingHeight, intrinsicViewport.height * scale);
  return {
    intrinsicViewport,
    containingViewport: { width: containingWidth, height: containingHeight },
    scale,
    renderedWidth,
    renderedHeight,
    offsetX: Math.max(0, (containingWidth - renderedWidth) / 2),
    offsetY: Math.max(0, (containingHeight - renderedHeight) / 2),
  };
}
