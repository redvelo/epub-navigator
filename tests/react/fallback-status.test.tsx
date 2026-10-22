// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicationStatus } from "../../src/react/status/publication-status.js";
import { normalizeError } from "../../src/react/status/errors.js";
import { NavigatorError } from "../../src/runtime.js";

afterEach(cleanup);

const renderStatus = (props: Partial<ComponentProps<typeof PublicationStatus>> = {}) =>
  render(
    <PublicationStatus
      committed={null}
      initialRestorationPending={false}
      readingSurfaceRetained={false}
      error={null}
      retry={vi.fn()}
      layoutRepairsUnresolved={false}
      footnoteReturn={null}
      onReturnFromFootnote={vi.fn()}
      onDismissFootnoteReturn={vi.fn()}
      {...props}
    />,
  );

it.each([
  ["manifest-fallback-exhausted", "no XHTML or SVG document"],
  ["manifest-fallback-unresolved", "reference cannot be resolved"],
  ["manifest-fallback-cycle", "contains a cycle"],
] as const)("presents deterministic %s failures as terminal alerts", (reason, message) => {
  const error = new NavigatorError({
    code: "occurrence-unavailable",
    message: "raw kernel message",
    occurrence: 0,
    reason,
  });
  renderStatus({ error: normalizeError(error, false) });

  expect(screen.getByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
});

it("blocks the surface while a publication is still opening", async () => {
  renderStatus();
  // The surface covers from the first frame; it only names the wait once there is one to read.
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Opening publication"));
});

it("keeps the reading surface once a scroll-following layout has committed a page", () => {
  renderStatus({ readingSurfaceRetained: true });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
