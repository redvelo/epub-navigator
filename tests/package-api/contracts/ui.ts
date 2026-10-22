export {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Drawer,
  DrawerContent,
  DrawerTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  NavigatorTheme,
  Popover,
  PopoverContent,
  RadioGroup,
  RadioGroupItem,
  Separator,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from "epub-navigator/ui";
export type { ButtonProps, NavigatorThemeProps } from "epub-navigator/ui";

import type { ButtonProps, NavigatorThemeProps } from "epub-navigator/ui";

export const buttonProps: ButtonProps = {
  children: "Import EPUB",
  variant: "default",
};

export const themeProps: NavigatorThemeProps = {
  children: "Library",
  colorScheme: "system",
  interactionFeedback: "minimal",
};

// @ts-expect-error rendering policy is an invariant, not a theme prop.
export type RemovedNavigatorThemeRenderingProp = NavigatorThemeProps["rendering"];
