import type { ContentAgentState } from "../state.js";
import { resolveLocatorInDocument } from "./resolver/locator.js";
import type { DocumentLocatorTarget } from "../../agent-protocol/index.js";
import type { LocatorResolutionStatus, PointEvidence } from "../../../generated/kernel.js";

export function resolveStaticSvgLocator(
  _state: ContentAgentState,
  target: DocumentLocatorTarget,
): LocatorResolutionStatus {
  const unsupportedPoint = (evidence: readonly PointEvidence[]): boolean =>
    evidence.some(
      (item) =>
        item.kind === "rendered-text-context" ||
        (item.kind === "html-fragment" && item.value.startsWith("svgView(")),
    );
  const unsupported =
    target.kind === "point"
      ? unsupportedPoint(target.evidence)
      : target.evidence.some(
          (item) =>
            item.kind === "rendered-text-quote" ||
            (item.kind === "boundaries" &&
              (unsupportedPoint(item.start) || unsupportedPoint(item.end))),
        );
  if (unsupported) {
    return {
      status: "unsupported-evidence",
      message: "standalone SVG supports only element ID fragments and document boundaries",
    };
  }
  return resolveLocatorInDocument(document, target).status;
}
