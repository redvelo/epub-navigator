import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "../../lib/utils.js";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  );
}

function RadioGroupItem({ className, children, ...props }: RadioPrimitive.Root.Props) {
  const labelled = children !== undefined;
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "group/radio-group-item peer relative flex shrink-0 rounded-2xl border border-transparent outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary",
        labelled
          ? "items-center justify-center bg-transparent text-center leading-none"
          : "aspect-square size-4 bg-input/90",
        className,
      )}
      {...props}
    >
      {children ?? (
        <RadioPrimitive.Indicator
          data-slot="radio-group-indicator"
          className="flex size-4 items-center justify-center"
        >
          <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground dark:size-2.5" />
        </RadioPrimitive.Indicator>
      )}
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
