import { lazy, Suspense } from "react";
import type { ReaderStore } from "epub-navigator/react";

const DevTools = import.meta.env.DEV
  ? lazy(async () => {
      const [{ DevTools: Panel }] = await Promise.all([
        import("jotai-devtools"),
        import("jotai-devtools/styles.css"),
      ]);
      return { default: Panel };
    })
  : null;

/**
 * Atom inspector for the test bench. Excluded from production builds. The reader renders its
 * subtree in its own store, so the inspector has to be given that same store explicitly.
 */
export function ReaderDevTools({ store }: { readonly store: ReaderStore }) {
  if (DevTools === null) return null;
  return (
    <Suspense fallback={null}>
      <DevTools store={store} position="bottom-left" />
    </Suspense>
  );
}
