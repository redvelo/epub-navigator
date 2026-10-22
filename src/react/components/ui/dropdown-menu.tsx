import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Check } from "lucide-react";

import { cn } from "../../lib/utils.js";

function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  portalContainer,
  positionerProps,
  ...props
}: MenuPrimitive.Popup.Props & {
  readonly portalContainer?: MenuPrimitive.Portal.Props["container"] | undefined;
  readonly positionerProps?: MenuPrimitive.Positioner.Props | undefined;
}) {
  return (
    <MenuPrimitive.Portal container={portalContainer}>
      <MenuPrimitive.Positioner
        data-slot="dropdown-menu-positioner"
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        className="z-60 outline-none"
        {...positionerProps}
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            "max-h-[var(--available-height)] min-w-40 overflow-y-auto rounded-2xl border border-border bg-popover p-1 text-sm text-popover-foreground shadow-none outline-none",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { readonly variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        "flex min-h-11 cursor-default items-center gap-2 rounded-xl px-2.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-[var(--reader-selected)] data-highlighted:text-[var(--reader-selected-foreground)] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        variant === "destructive" && "text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "grid min-h-11 cursor-default grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-xl px-2.5 text-sm outline-none select-none data-checked:bg-accent data-checked:font-medium data-disabled:pointer-events-none data-disabled:opacity-40 data-highlighted:bg-[var(--reader-selected)] data-highlighted:text-[var(--reader-selected-foreground)]",
        className,
      )}
      {...props}
    >
      <MenuPrimitive.RadioItemIndicator
        keepMounted
        className="grid size-4 place-items-center opacity-0 data-checked:opacity-100"
      >
        <Check aria-hidden="true" />
      </MenuPrimitive.RadioItemIndicator>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
