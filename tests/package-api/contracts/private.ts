// @ts-expect-error Package-private React state is not an exported subpath.
import type {} from "epub-navigator/react/runtime/projection-state";

// @ts-expect-error Package-private primitives are not public deep imports.
import type {} from "epub-navigator/ui/dialog";

export {};
