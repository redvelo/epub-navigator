import type { FixedIntrinsicViewport, FixedLayoutIssue } from "../../generated/kernel.js";

export type FixedViewportResolution =
  | { readonly status: "resolved"; readonly viewport: FixedIntrinsicViewport }
  | { readonly status: "unavailable"; readonly issue: FixedLayoutIssue };

const dimensionPattern = /^(?:\d+(?:\.\d*)?|\.\d+)/u;

export function resolveFixedViewport(document: Document): FixedViewportResolution {
  const declarations = [...document.getElementsByTagName("meta")].filter(
    (element) => element.getAttribute("name")?.trim().toLowerCase() === "viewport",
  );
  if (declarations.length === 0) {
    return { status: "unavailable", issue: "intrinsic-viewport-missing" };
  }
  const values = new Map<string, string>();
  const content = declarations[0]?.getAttribute("content") ?? "";
  for (const match of content.matchAll(/(?:^|[\s,;]+)([^=\s,;]+)\s*=\s*([^\s,;]+)/gu)) {
    const name = (match[1] ?? "").toLowerCase();
    if (name !== "width" && name !== "height") continue;
    if (values.has(name)) continue;
    values.set(name, match[2] ?? "");
  }

  const width = values.get("width");
  const height = values.get("height");
  if (width === undefined || height === undefined || width.length === 0 || height.length === 0) {
    return { status: "unavailable", issue: "intrinsic-viewport-invalid" };
  }
  if (!dimensionPattern.test(width) || !dimensionPattern.test(height)) {
    return { status: "unavailable", issue: "intrinsic-viewport-unsupported" };
  }
  const parsedWidth = Number.parseFloat(width);
  const parsedHeight = Number.parseFloat(height);
  if (
    !Number.isFinite(parsedWidth) ||
    !Number.isFinite(parsedHeight) ||
    parsedWidth <= 0 ||
    parsedHeight <= 0
  ) {
    return { status: "unavailable", issue: "intrinsic-viewport-invalid" };
  }
  return { status: "resolved", viewport: { width: parsedWidth, height: parsedHeight } };
}
