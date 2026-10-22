import { openArchive, requiredElement } from "../harness.js";
import { createNavigatorRuntime, type NavigatorRuntime } from "epub-navigator/runtime";
import { captureReadingPosition } from "../../../src/react/runtime/reading-position.js";
import { RollChildRuntime } from "../../../src/runtime/fixed-layout/roll-child.js";

declare global {
  interface Window {
    roll: NavigatorRuntime;
    captureRoll: () => ReturnType<typeof captureReadingPosition>;
    rollGeometry: { pending: boolean; release(): void; delayNext(): void };
  }
}
try {
  const publication = await openArchive("/roll.epub");
  const isolatedOrigin = new URLSearchParams(location.search).get("publication-origin");
  const runtime = await createNavigatorRuntime({
    session: {
      id: "official-w3c-roll",
      publication: {
        facts: publication.facts,
        mount: {
          baseUrl:
            isolatedOrigin === null ? `${location.origin}/roll-publication/` : `${isolatedOrigin}/`,
          contentOrigin:
            isolatedOrigin === null ? "shared-reader-origin" : "isolated-publication-origin",
          remoteResources: "blocked",
        },
      },
    },
    container: requiredElement("#frame-host"),
  });
  window.roll = runtime;
  window.rollGeometry = {
    pending: false,
    release() {},
    delayNext() {
      const original = RollChildRuntime.prototype.targetPoint;
      RollChildRuntime.prototype.targetPoint = async function (...args) {
        RollChildRuntime.prototype.targetPoint = original;
        const point = await original.apply(this, args);
        return new Promise((resolve) => {
          window.rollGeometry.pending = true;
          window.rollGeometry.release = () => {
            window.rollGeometry.pending = false;
            resolve(point);
          };
        });
      };
    },
  };
  window.captureRoll = () => captureReadingPosition({ current: runtime });
  runtime.subscribeErrors((error) => {
    document.querySelector("#result")!.textContent = error.message;
  });
  runtime.subscribeInteractions((interaction) => {
    if (interaction.command === "fixed-pan") runtime.panFixedBy(interaction.delta, true);
    else if (interaction.command === "fixed-zoom")
      runtime.setFixedZoom(
        (runtime.fixedViewState()?.zoom ?? 1) * interaction.factor,
        interaction.focal,
      );
    else if (interaction.command === "fixed-reset") runtime.setFixedZoom(1);
    else if (interaction.command === "next" || interaction.command === "previous")
      void runtime.advancePresentation(interaction.command === "next" ? "forward" : "backward");
  });
  runtime.open(0);
  document.querySelector("#result")!.textContent = "ready";
  publication.close();
} catch (error) {
  document.querySelector("#result")!.textContent = String(error);
}
