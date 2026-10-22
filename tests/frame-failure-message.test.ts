import { expect, it } from "vitest";
import { frameFailureMessage } from "../src/react/status/messages.js";

it("names the reason a section did not load", () => {
  expect(frameFailureMessage({ reason: "readiness-timeout" })).toBe(
    "The section did not start its reading agent in time.",
  );
  expect(frameFailureMessage({ reason: "load-error" })).toBe(
    "The section's document could not be fetched.",
  );
  expect(
    frameFailureMessage({
      reason: "reflowable-layout-unavailable",
      issue: "anchor-reconciliation-failed",
    }),
  ).toBe("The section could not be laid out: the place to return to could not be found again.");
  expect(
    frameFailureMessage({
      reason: "fixed-layout-unavailable",
      issue: "intrinsic-viewport-missing",
    }),
  ).toBe("The section could not be laid out as a fixed page: the page states no size of its own.");
  expect(frameFailureMessage({ reason: "effect-execution-failed", message: "no" })).toBe(
    "The section could not be prepared: no",
  );
});
