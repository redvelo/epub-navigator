import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils.js";
import { Input } from "./input.js";

function InputGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex h-8 w-full min-w-0 items-center rounded-2xl border border-transparent bg-input/50 outline-none has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30 has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:ring-3 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[>[data-align=inline-end]]:[&>input]:pe-1.5 has-[>[data-align=inline-start]]:[&>input]:ps-1.5 dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50 [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start": "order-first ps-2 has-[>button]:ms-[-0.3rem]",
        "inline-end": "order-last pe-2 has-[>button]:me-[-0.3rem]",
      },
    },
    defaultVariants: { align: "inline-start" },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(event) => {
        const target = event.target;
        if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
        if (target.closest("button")) return;
        event.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupInput };
