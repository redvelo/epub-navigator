import { createNavigatorRuntime } from "epub-navigator/runtime";
import { currentFrame, currentPaginatedLayout } from "../../../src/runtime/kernel-view.js";
import {
  aliceMount,
  delivered,
  openArchive,
  requiredElement,
  singleColumnPreferences,
  waitFor,
} from "../harness.js";

interface RetiredFrameHarness {
  open(occurrence: number): Promise<number>;
  scroll(): Promise<void>;
  participants(): readonly string[];
  interactions(): number;
  flush(): Promise<void>;
  position(): {
    readonly occurrence: number | null;
    readonly page: number | null;
    readonly pageCount: number | null;
  };
}

declare global {
  interface Window {
    __EPUB_RETIRED_FRAME__?: RetiredFrameHarness;
  }
}

const publication = await openArchive();
const container = requiredElement("#frame-host");

const runtime = await createNavigatorRuntime({
  session: {
    id: "retired-frame",
    publication: { facts: publication.facts, mount: aliceMount },
  },
  container,
});
runtime.configure({
  appearance: { rootScrollbar: "hidden" },
  input: {
    keyboardMode: "standard",
    touchZones: true,
    progressionDirection: "ltr",
    selectionMenu: "native",
  },
});
runtime.setPresentationPreferences(singleColumnPreferences);

const waitForCommitted = (occurrence: number) =>
  waitFor(
    () => currentFrame(runtime.snapshot())?.occurrence === occurrence,
    `occurrence ${occurrence} did not commit`,
  );

let interactions = 0;
runtime.subscribeInteractions((interaction) => {
  interactions += 1;
  if (interaction.command === "next") runtime.next();
  else if (interaction.command === "previous") runtime.previous();
});
runtime.open(0);
await waitForCommitted(0);

window.__EPUB_RETIRED_FRAME__ = {
  async scroll() {
    runtime.setPresentationPreferences({ ...singleColumnPreferences, mode: "document-scroll" });
    await waitFor(
      () => currentPaginatedLayout(runtime.snapshot()) === null,
      "the document did not settle as scrolled",
    );
  },
  async open(occurrence) {
    runtime.open(occurrence);
    await waitForCommitted(occurrence);
    return occurrence;
  },
  participants: () =>
    [...container.querySelectorAll<HTMLIFrameElement>("iframe")].map(
      (frame) => frame.dataset.epubNavigatorParticipant ?? "",
    ),
  interactions: () => interactions,
  async flush() {
    const frames = [...container.querySelectorAll<HTMLIFrameElement>("iframe")];
    await Promise.all(
      frames.flatMap((frame) => (frame.contentWindow ? [delivered(frame.contentWindow)] : [])),
    );
    await delivered();
  },
  position: () => {
    const snapshot = runtime.snapshot();
    return {
      occurrence: currentFrame(snapshot)?.occurrence ?? null,
      page: currentPaginatedLayout(snapshot)?.firstVisiblePage ?? null,
      pageCount: currentPaginatedLayout(snapshot)?.pageCount ?? null,
    };
  },
};
