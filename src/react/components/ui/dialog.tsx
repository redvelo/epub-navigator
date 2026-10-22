import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "../../lib/utils.js";

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />;
}

function DialogContent({
  className,
  children,
  contained = false,
  backdropClassName,
  viewportClassName,
  viewportStyle,
  portalContainer,
  ...props
}: DialogPrimitive.Popup.Props & {
  readonly children: ReactNode;
  readonly contained?: boolean | undefined;
  readonly backdropClassName?: string | undefined;
  readonly viewportClassName?: string | undefined;
  readonly viewportStyle?: CSSProperties | undefined;
  readonly portalContainer?: DialogPrimitive.Portal.Props["container"] | undefined;
}) {
  return (
    <DialogPrimitive.Portal container={portalContainer}>
      <DialogPrimitive.Backdrop
        data-slot="dialog-backdrop"
        className={cn(
          "fixed inset-0 z-50 bg-background",
          contained && "absolute",
          backdropClassName,
        )}
        style={viewportStyle}
      />
      <DialogPrimitive.Viewport
        data-slot="dialog-viewport"
        className={cn(
          "fixed inset-0 z-50 flex items-center justify-center p-4",
          contained && "absolute",
          viewportClassName,
        )}
        style={viewportStyle}
      >
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className={cn(
            "flex max-h-[calc(100%-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-border bg-popover text-sm text-popover-foreground shadow-none outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}

const DialogClose = DialogPrimitive.Close;
const DialogDescription = DialogPrimitive.Description;
const DialogTitle = DialogPrimitive.Title;

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle };
