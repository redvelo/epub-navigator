import type { FixedLayoutIssue, FrameFailureReason, LayoutIssue } from "../../generated/kernel.js";
import type { NavigationTarget } from "../../generated/publication.js";

export function unavailableTargetMessage(
  target: NavigationTarget,
  resource: string | null,
): string {
  if (target.state === "missing-href") return "No destination was provided";
  if (target.state === "invalid") return "The destination is invalid";
  if (target.state === "missing-resource") return "The destination resource is unavailable";
  if (target.state === "unindexed-address") return "The destination is outside this publication";
  if (resource === null) return "The destination resource cannot be opened by this reader";
  return "The destination is not in the reading order";
}

const LAYOUT_ISSUES: Readonly<Record<LayoutIssue, string>> = {
  "publication-continuous-unavailable": "this reader scrolls a section at a time",
  "authored-presentation-ambiguous": "the publication asks for more than one presentation",
  "authored-presentation-unsupported":
    "the publication asks for a presentation this reader has not",
  "incompatible-publisher-css": "the publication's own style cannot be laid out here",
  "agent-style-unavailable": "the reader's own style did not reach the section",
  "reader-font-unavailable": "the reader's font did not arrive",
  "anchor-reconciliation-failed": "the place to return to could not be found again",
};

const FIXED_LAYOUT_ISSUES: Readonly<Record<FixedLayoutIssue, string>> = {
  "intrinsic-viewport-missing": "the page states no size of its own",
  "intrinsic-viewport-ambiguous": "the page states more than one size",
  "intrinsic-viewport-invalid": "the size the page states cannot be read",
  "intrinsic-viewport-unsupported": "the size the page states is one this reader cannot use",
  "final-viewport-unavailable": "no viewport was left to fit the page into",
  "agent-style-unavailable": "the reader's own style did not reach the page",
  "image-load-failed": "the page's image did not load",
};

/**
 * Six reasons and fourteen layout issues used to arrive as one sentence, which said only that
 * something went wrong. The reason a section did not load is the first thing anyone reporting
 * it has to hand, so it is said here.
 */
export function frameFailureMessage(failure: FrameFailureReason): string {
  switch (failure.reason) {
    case "readiness-timeout":
      return "The section did not start its reading agent in time.";
    case "unexpected-navigation":
      return "The section navigated before it became ready.";
    case "load-error":
      return "The section's document could not be fetched.";
    case "effect-execution-failed":
      return `The section could not be prepared: ${failure.message}`;
    case "reflowable-layout-conflict":
    case "reflowable-layout-unavailable":
      return `The section could not be laid out: ${LAYOUT_ISSUES[failure.issue]}.`;
    default:
      return `The section could not be laid out as a fixed page: ${FIXED_LAYOUT_ISSUES[failure.issue]}.`;
  }
}
