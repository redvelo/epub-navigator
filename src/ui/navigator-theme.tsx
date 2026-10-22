import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../react/lib/utils.js";

export interface NavigatorThemeProps extends ComponentPropsWithoutRef<"div"> {
  /** Interface color policy. System follows the user's active color-scheme preference. */
  readonly colorScheme?: "system" | "light" | "dark";
  /**
   * How much motion and feedback the display can carry. A reader sets it for its own surface;
   * setting it here covers host surfaces drawn with the same components.
   */
  readonly interactionFeedback?: "standard" | "minimal";
}

/** Shared semantic theme boundary for Navigator and host-owned application surfaces. */
export function NavigatorTheme({
  colorScheme = "system",
  interactionFeedback,
  className,
  ...props
}: NavigatorThemeProps) {
  return (
    <div
      {...props}
      className={cn("epub-navigator-theme", className)}
      data-navigator-color-scheme={colorScheme}
      data-interaction-feedback={interactionFeedback}
    />
  );
}
