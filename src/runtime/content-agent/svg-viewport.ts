import type { FixedIntrinsicViewport, FixedLayoutOutcome } from "../../generated/kernel.js";

export type SvgViewBoxEvidence = {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
};

export type SvgIntrinsicViewportResolution =
  | {
      readonly status: "resolved";
      readonly viewport: FixedIntrinsicViewport;
      readonly viewBox: SvgViewBoxEvidence;
    }
  | Extract<FixedLayoutOutcome, { status: "unavailable" }>;

const svgNamespace = "http://www.w3.org/2000/svg";
const number = String.raw`[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?`;
const commaWsp = String.raw`(?:[\t\n\r ]*,[\t\n\r ]*|[\t\n\r ]+)`;
const viewBoxPattern = new RegExp(
  String.raw`^[\t\n\r ]*(${number})${commaWsp}(${number})${commaWsp}(${number})${commaWsp}(${number})[\t\n\r ]*$`,
  "u",
);

export function resolveSvgIntrinsicViewport(document: Document): SvgIntrinsicViewportResolution {
  const root = document.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== svgNamespace) {
    return { status: "unavailable", issue: "intrinsic-viewport-unsupported" };
  }

  const authoredViewBox = root.getAttribute("viewBox");
  if (authoredViewBox === null) {
    return { status: "unavailable", issue: "intrinsic-viewport-missing" };
  }

  const match = viewBoxPattern.exec(authoredViewBox);
  if (match === null) {
    return { status: "unavailable", issue: "intrinsic-viewport-invalid" };
  }

  const minX = Number(match[1]);
  const minY = Number(match[2]);
  const width = Number(match[3]);
  const height = Number(match[4]);
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return { status: "unavailable", issue: "intrinsic-viewport-invalid" };
  }

  return {
    status: "resolved",
    viewport: { width, height },
    viewBox: { minX, minY, width, height },
  };
}
