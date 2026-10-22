import { StrictMode } from "react";
import { createStore, Provider } from "jotai";
import { createRoot } from "react-dom/client";
import { createBrowserLocalHost } from "epub-navigator/local";
import { applyReaderAppAtomDebugLabels } from "./debug-labels.ts";
import "./index.css";
import App from "./App.tsx";
import { ReaderDevTools } from "./devtools.tsx";

const applicationBase = new URL(import.meta.env.BASE_URL, window.location.origin);

void start();

async function start(): Promise<void> {
  const measurementArtifactDigest = await loadMeasurementArtifactDigest();
  const localHost = createBrowserLocalHost({
    importWorkerUrl: new URL("import-worker.js", applicationBase),
    serviceWorkerUrl: new URL("service-worker.js", applicationBase),
    serviceWorkerScope: applicationBase,
    mountBaseUrl: new URL("publications/", applicationBase).href,
    measurementMountBaseUrl: new URL("measurements/", applicationBase).href,
    contentAgentUrl: new URL("content-agent.js", applicationBase),
    readerFontStylesheetUrl: new URL("reader-fonts/reader-serif.css?v=1", applicationBase),
    ...(measurementArtifactDigest === null ? {} : { measurementArtifactDigest }),
  });

  // jotai-devtools instruments stores by overriding createStore when its module loads, so in
  // development it has to be imported before the reader store exists or it sees no atoms.
  if (import.meta.env.DEV) {
    await import("jotai-devtools");
    const { applyReaderAtomDebugLabels } = await import("epub-navigator/react/debug");
    applyReaderAtomDebugLabels();
    applyReaderAppAtomDebugLabels();
  }
  const readerStore = createStore();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Provider store={readerStore}>
        <App localHost={localHost} readerStore={readerStore} />
      </Provider>
      <ReaderDevTools store={readerStore} />
    </StrictMode>,
  );
}

async function loadMeasurementArtifactDigest(): Promise<string | null> {
  if (!import.meta.env.PROD) return null;
  try {
    const response = await fetch(new URL("measurement-artifacts.json", applicationBase), {
      cache: "no-cache",
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (
      typeof value === "object" &&
      value !== null &&
      "measurementArtifactDigest" in value &&
      typeof value.measurementArtifactDigest === "string" &&
      /^[0-9a-f]{64}$/u.test(value.measurementArtifactDigest)
    ) {
      return value.measurementArtifactDigest;
    }
  } catch {
    // Durable pagination reuse is optional; live measurement remains available.
  }
  return null;
}
