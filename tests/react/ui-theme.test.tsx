// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { expect, it } from "vitest";
import { NavigatorTheme } from "../../src/ui/index.js";

it("owns the shared semantic theme attributes", () => {
  render(
    <NavigatorTheme colorScheme="dark" data-testid="theme">
      Library
    </NavigatorTheme>,
  );

  const theme = screen.getByTestId("theme");
  expect(theme).toHaveClass("epub-navigator-theme");
  expect(theme).toHaveAttribute("data-navigator-color-scheme", "dark");
});
