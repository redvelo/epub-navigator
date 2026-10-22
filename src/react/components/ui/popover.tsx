import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "../../lib/utils.js";

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root {...props} />;
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  portalContainer,
  positionerProps,
  backdrop,
  ...props
}: PopoverPrimitive.Popup.Props & {
  readonly portalContainer?: PopoverPrimitive.Portal.Props["container"] | undefined;
  readonly positionerProps?: PopoverPrimitive.Positioner.Props | undefined;
  readonly backdrop?: boolean | undefined;
}) {
  return (
    <PopoverPrimitive.Portal container={portalContainer}>
      {/* A press on a publication frame lands inside that frame, so a popover over one needs
          something of the reader's for the press to reach. Transparent, but present. */}
      {backdrop === true ? (
        <PopoverPrimitive.Backdrop
          data-slot="popover-backdrop"
          className="absolute inset-0 z-40 bg-transparent"
        />
      ) : null}
      <PopoverPrimitive.Positioner
        data-slot="popover-positioner"
        className="z-50"
        sideOffset={4}
        collisionPadding={8}
        {...positionerProps}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "w-[min(22rem,calc(100cqw-1rem))] overflow-hidden rounded-2xl border border-border bg-popover text-sm text-popover-foreground shadow-none outline-none",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

const PopoverClose = PopoverPrimitive.Close;
const PopoverTitle = PopoverPrimitive.Title;

export { Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger };
