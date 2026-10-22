import type { ReflowablePresentation } from "../../../generated/kernel.js";
import type { AgentFontEvidenceMessage } from "../../agent-protocol/index.js";
import type { ContentAgentState } from "../state.js";
import type { OutboundMessageInput } from "../transport.js";
import { post } from "../transport.js";

const readerSerifFamily = "Navigator Reader Serif";
const fontQuery = `400 16px "${readerSerifFamily}"`;

export async function postReaderSerifFontEvidence(
  state: ContentAgentState,
  presentation: ReflowablePresentation,
  layoutToken: number,
): Promise<void> {
  if (
    !state.lifecycle.diagnosticsEnabled ||
    state.lifecycle.agentRole !== "foreground" ||
    presentation.typeface !== "reader-serif"
  ) {
    return;
  }

  const evidence = {
    configured: false,
    declared: false,
    loaded: false,
    check: false,
  };
  try {
    const target = renderedTextTarget(document);
    if (target !== null) {
      evidence.configured =
        normalizedFamily(
          (target.ownerDocument.defaultView?.getComputedStyle(target).fontFamily ?? "").split(
            ",",
          )[0] ?? "",
        ) === normalizedFamily(readerSerifFamily);
    }

    const fonts = document.fonts;
    evidence.declared = [...fonts].some(
      (face) => normalizedFamily(face.family) === normalizedFamily(readerSerifFamily),
    );
    try {
      const faces = await fonts.load(fontQuery, "Reading");
      evidence.loaded = faces.some(
        (face) =>
          normalizedFamily(face.family) === normalizedFamily(readerSerifFamily) &&
          face.status === "loaded",
      );
    } catch {
      evidence.loaded = false;
    }
    try {
      evidence.check = fonts.check(fontQuery, "Reading");
    } catch {
      evidence.check = false;
    }
  } catch {
    // Evidence is diagnostic only; unavailable browser APIs are represented by false values.
  }

  if (layoutToken !== state.layout.layoutToken || state.lifecycle.agentRole !== "foreground")
    return;
  post(state, {
    namespace: "epub-navigator",
    type: "font-evidence",
    target: "publication",
    family: "navigator-reader-serif",
    ...evidence,
  } satisfies OutboundMessageInput<AgentFontEvidenceMessage>);
}

function renderedTextTarget(source: Document): Element | null {
  const candidates = source.querySelectorAll("p, li, blockquote, dd, dt, figcaption, body");
  for (const candidate of candidates) {
    if (
      !candidate.isConnected ||
      candidate.textContent?.trim() === "" ||
      candidate.getClientRects().length === 0
    ) {
      continue;
    }
    const style = source.defaultView?.getComputedStyle(candidate);
    if (style === undefined) continue;
    if (style.display !== "none" && style.visibility !== "hidden") return candidate;
  }
  return null;
}

function normalizedFamily(value: string): string {
  return value
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim()
    .toLowerCase();
}
