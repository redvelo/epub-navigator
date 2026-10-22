import { openArchive, requiredElement } from "../harness.js";
import { createNavigatorRuntime } from "epub-navigator/runtime";
import type { KernelSnapshot } from "epub-navigator";

const output = document.querySelector<HTMLPreElement>("#result")!;
try {
  const publication = await openArchive("/authored-links.epub");
  const runtime = await createNavigatorRuntime({
    session: {
      id: "authored-links",
      publication: {
        facts: publication.facts,
        mount: {
          baseUrl: `${location.origin}/publications/authored-links/`,
          remoteResources: "blocked",
          contentOrigin: "shared-reader-origin",
        },
      },
    },
    container: requiredElement("#frame-host"),
  });
  window.authoredLinks = {
    open: (occurrence) => {
      runtime.open(occurrence);
    },
    snapshot: () => runtime.snapshot(),
  };
  runtime.open(0);
  output.textContent = "ready";
} catch (cause) {
  output.textContent = String(cause);
}

declare global {
  interface Window {
    authoredLinks: {
      open(occurrence: number): void;
      snapshot(): KernelSnapshot;
    };
  }
}
