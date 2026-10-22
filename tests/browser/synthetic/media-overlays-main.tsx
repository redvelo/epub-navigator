import { useRef, useState, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  isNavigatorMediaOverlayDescription,
  isNavigatorMediaOverlayTimelineResult,
  type NavigatorMediaOverlayDescription,
} from "epub-navigator";
import { openArchive } from "../harness.js";
import {
  NavigatorReader,
  type NavigatorReaderHandle,
  type NavigatorReaderPreferences,
} from "epub-navigator/react";
import {
  isNavigatorMediaOverlayRate,
  type NavigatorDiagnosticEvent,
  type NavigatorDiagnostics,
  type PublicationMediaOverlayCapabilities,
} from "epub-navigator/runtime";
import "epub-navigator/react.css";

declare global {
  interface Window {
    mediaOverlayHarness: {
      readonly calls: string[];
      readonly diagnostics: NavigatorDiagnosticEvent[];
      captureReadingPosition?: (() => Promise<unknown>) | undefined;
    };
  }
}

const parameters = new URLSearchParams(location.search);
const rate = parameters.get("rate");
const theme = parameters.get("theme") === "dark" ? "dark" : null;
const isolated = location.pathname.endsWith("/media-overlays-isolated.html");
const calls: string[] = [];
const diagnosticEvents: NavigatorDiagnosticEvent[] = [];
window.mediaOverlayHarness = { calls, diagnostics: diagnosticEvents };
const diagnostics: NavigatorDiagnostics = {
  level: "trace",
  record: (event) => diagnosticEvents.push(event),
};

async function fixture(path: string): Promise<unknown> {
  calls.push(path);
  const response = await fetch(`/media-overlay-fixture/${path}`);
  return response.json();
}

const description = (await (await fetch("/media-overlay-fixture/description.json")).json()) as
  | NavigatorMediaOverlayDescription
  | undefined;
if (
  !isNavigatorMediaOverlayDescription(description) ||
  description.playback.state !== "available"
) {
  throw new Error("the Moby-Dick playback description fixture is invalid");
}
const playableOccurrenceIndexes = description.playback.associations
  .filter((association) => association.overlay.state === "resolved")
  .map((association) => association.occurrenceIndex);

const capabilities: PublicationMediaOverlayCapabilities = {
  availability: {
    status: "available",
    playableOccurrenceIndexes,
    unavailableOccurrenceCount:
      description.playback.associations.length - playableOccurrenceIndexes.length,
  },
  signal: new AbortController().signal,
  async description() {
    const value = await fixture("description.json");
    return isNavigatorMediaOverlayDescription(value)
      ? { status: "ok", description: value }
      : { status: "unavailable", reason: "host-unavailable" };
  },
  async timeline(overlayIndex) {
    const value = await fixture(`timeline-${overlayIndex}.json`);
    return isNavigatorMediaOverlayTimelineResult(value)
      ? { status: "ok", result: value }
      : { status: "unavailable", reason: "not-found" };
  },
  close() {},
};

const publication = await openArchive("/moby-dick-mo.epub");

export function Harness() {
  const reader = useRef<NavigatorReaderHandle>(null);
  useLayoutEffect(() => {
    window.mediaOverlayHarness.captureReadingPosition = () =>
      reader.current!.captureReadingPosition();
  });
  const [preferences, setPreferences] = useState<NavigatorReaderPreferences>({
    colorScheme: theme ?? "light",
    presentationMode: "paginated",
    paginationColumns: "single",
    publicationTheme: theme ?? "original",
    publicationTypeface: "original",
    fontScale: "100",
    lineHeight: "original",
    letterSpacing: "0",
    wordSpacing: "0",
    paragraphSpacing: "original",
    textIndent: "original",
    measure: "full-width",
    alignment: "original",
    hyphenation: "original",
    keyboardMode: "standard",
    touchZones: false,
    narrationRate: isNavigatorMediaOverlayRate(rate) ? rate : "1",
    narrationSkippedTypes: [],
  });
  return (
    <NavigatorReader
      ref={reader}
      session={{
        id: "media-overlays",
        publication: {
          facts: publication.facts,
          mount: isolated
            ? {
                baseUrl: "http://moby.localhost:4174/",
                contentOrigin: "isolated-publication-origin",
                remoteResources: "blocked",
              }
            : {
                baseUrl: `${location.origin}/publications/moby-dick/`,
                contentOrigin: "shared-reader-origin",
                remoteResources: "blocked",
              },
        },
      }}
      preferences={preferences}
      onPreferencesChange={setPreferences}
      mediaOverlays={capabilities}
      diagnostics={diagnostics}
    />
  );
}

createRoot(document.querySelector("#root")!).render(<Harness />);
