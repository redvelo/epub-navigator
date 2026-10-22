import type { ContentAgentState } from "./state.js";
import { createReadingSystem } from "./reading-system.js";
import { installActivationController } from "./activation/controller.js";
import { installInteractionController } from "./interaction/controller.js";
import { installRequestDispatch } from "./request-dispatch.js";
import { installSelectionController } from "./selection/controller.js";
import { createContentAgentState } from "./state.js";
import { installRollController } from "./roll.js";
import type { PaginationGeometryDiagnostics } from "./state.js";

declare global {
  interface Navigator {
    readonly epubReadingSystem?: {
      readonly name: string;
      readonly version: string;
      readonly layoutStyle: "paginated" | "scrolling";
      hasFeature(feature: string, version?: string): boolean | undefined;
    };
  }

  interface Window {
    __EPUB_NAVIGATOR_GEOMETRY_DIAGNOSTICS__?: PaginationGeometryDiagnostics;
  }
}

function installReadingSystem(state: ContentAgentState): void {
  if (document.readyState !== "loading") state.targets.annotationAuthoredProvenance.finalize();

  if (navigator.epubReadingSystem === undefined) {
    Object.defineProperty(navigator, "epubReadingSystem", {
      configurable: false,
      enumerable: true,
      value: createReadingSystem(state),
      writable: false,
    });
  }
}

export function bootstrapContentAgent(): void {
  const state = createContentAgentState();
  installReadingSystem(state);
  installRequestDispatch(state);
  installActivationController(state);
  installSelectionController(state);
  installInteractionController(state);
  installRollController(state);
}
