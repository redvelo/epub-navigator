import type { KernelSnapshot } from "epub-navigator";
import { createNavigatorRuntime, type NavigatorRuntime } from "epub-navigator/runtime";
import { openArchive, requiredElement, waitFor } from "../harness.js";

const publicationOrigin = "http://localhost:4174";
const output = requiredElement("#result");
const frameHost = requiredElement("#frame-host");

try {
  const publication = await openArchive("/host-conformance.epub");
  try {
    let sameOriginRejection: string | null = null;
    try {
      const invalid = await createNavigatorRuntime({
        session: {
          id: "isolated-origin-invalid-mount",
          publication: {
            facts: publication.facts,
            mount: {
              baseUrl: `${location.origin}/publications/alice/`,
              remoteResources: "blocked",
              contentOrigin: "isolated-publication-origin",
            },
          },
        },
        container: frameHost,
      });
      invalid.close();
    } catch (error) {
      sameOriginRejection = error instanceof Error ? error.message : String(error);
    }
    if (sameOriginRejection === null)
      throw new Error("the same-origin isolated mount was accepted");

    const agentMessageOrigins = new Set<string>();
    const runtimeMessageOrigins = new Set<string>();
    const publicationWindows = new Set<MessageEventSource>();
    const reports: HostConformanceReport[] = [];
    const reportErrors: string[] = [];
    let selectionReady = false;
    window.addEventListener("message", (event) => {
      if (
        event.source !== null &&
        publicationWindows.has(event.source) &&
        isRecord(event.data) &&
        event.data.namespace === "epub-navigator"
      ) {
        agentMessageOrigins.add(event.origin);
      }
      if (
        isRecord(event.data) &&
        event.data.type === "fixture-agent-message-origin" &&
        typeof event.data.origin === "string"
      ) {
        runtimeMessageOrigins.add(event.data.origin);
      }
      if (event.origin === publicationOrigin && isHostConformanceReport(event.data)) {
        reports.push(event.data);
      }
      if (
        event.origin === publicationOrigin &&
        isRecord(event.data) &&
        event.data.type === "host-conformance-selection-ready"
      ) {
        selectionReady = true;
      }
      if (
        event.origin === publicationOrigin &&
        isRecord(event.data) &&
        event.data.type === "host-conformance-error"
      ) {
        reportErrors.push(`${String(event.data.name)}: ${String(event.data.message)}`);
      }
    });

    const runtime = await createNavigatorRuntime({
      session: {
        id: "isolated-origin",
        publication: {
          facts: publication.facts,
          mount: {
            baseUrl: `${publicationOrigin}/`,
            remoteResources: "blocked",
            contentOrigin: "isolated-publication-origin",
          },
        },
      },
      container: frameHost,
    });
    try {
      const opened = runtime.open(0);
      const pendingFrame = frameHost.querySelector<HTMLIFrameElement>("iframe");
      if (pendingFrame === null) throw new Error("the isolated pending frame is missing");
      if (pendingFrame.contentWindow !== null) publicationWindows.add(pendingFrame.contentWindow);
      const committed = await waitForCommitted(runtime, openedGeneration(opened));
      const firstReport = await waitForReport(reports, reportErrors, 1);

      const reloaded = runtime.reload();
      const replacementFrame = [...frameHost.querySelectorAll<HTMLIFrameElement>("iframe")].find(
        (frame) => frame !== pendingFrame,
      );
      if (replacementFrame?.contentWindow === null || replacementFrame === undefined) {
        throw new Error("the isolated replacement frame is missing");
      }
      publicationWindows.add(replacementFrame.contentWindow);
      const reloadedSnapshot = await waitForCommitted(runtime, openedGeneration(reloaded));
      const secondReport = await waitForReport(reports, reportErrors, 2);
      const frame = frameHost.querySelector<HTMLIFrameElement>("iframe");
      if (frame === null) throw new Error("the isolated publication frame is missing");
      frame.contentWindow?.postMessage({ hostConformanceSelect: true }, publicationOrigin);
      await waitFor(() => selectionReady, "the isolated selection was not created");
      const selectionCapture = await runtime.captureSelection();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const selectionSnapshot = runtime.currentSelection();
      const annotationTargetGeneration = await runtime.generateSelectionAnnotationTarget(
        selectionSnapshot.revision,
      );

      const beforeSpoof = JSON.stringify(runtime.snapshot().document);
      window.postMessage(
        {
          namespace: "epub-navigator",
          type: "ready",
          supportedOperations: ["resolve-locator", "relocate", "layout"],
        },
        location.origin,
      );
      await new Promise(requestAnimationFrame);

      output.textContent = JSON.stringify({
        readerOrigin: location.origin,
        publicationOrigin,
        sameOriginRejection,
        committed: committed.document.committed,
        reloaded: reloadedSnapshot.document.committed,
        firstReport,
        secondReport,
        frameSrc: frame.src,
        frameSandbox: frame.getAttribute("sandbox"),
        parentCanAccessDocument: frame.contentDocument !== null,
        selectionCapture,
        annotationTargetGeneration,
        agentMessageOrigins: [...agentMessageOrigins],
        runtimeMessageOrigins: [...runtimeMessageOrigins],
        sameOriginSpoofIgnored: JSON.stringify(runtime.snapshot().document) === beforeSpoof,
      });
      output.dataset.state = "ready";
    } finally {
      runtime.close();
    }
  } finally {
    publication.close();
  }
} catch (error) {
  output.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  output.dataset.state = "failed";
}

interface HostConformanceReport {
  readonly type: "host-conformance-report";
  readonly classicScript: string | null;
  readonly staticModule: string;
  readonly dynamicModule: string;
  readonly relativeFetch: string;
  readonly rootRelativeFetch: string;
  readonly previousLocalStorageValue: string | null;
  readonly currentLocalStorageValue: string | null;
  readonly previousIndexedDbValue: string | null;
  readonly dedicatedWorker: string | null;
  readonly dedicatedWorkerStaticModule: string | null;
  readonly serviceWorkerOutcome: string;
  readonly serviceWorkerError: string | null;
  readonly serviceWorkerRegistrationPresent: boolean;
  readonly remoteFetchBlocked: boolean;
  readonly popupBlocked: boolean;
  readonly rangeStatus: number;
  readonly rangeContentRange: string | null;
  readonly rangeBytes: number[];
  readonly stylesheetColor: string;
  readonly imageLoaded: boolean;
}

function openedGeneration(transition: {
  events: readonly { readonly type: string; readonly generation?: number }[];
}): number {
  const pending = transition.events.find((event) => event.type === "document-pending");
  if (pending?.generation === undefined)
    throw new Error("document command emitted no pending event");
  return pending.generation;
}

async function waitForCommitted(
  runtime: Pick<NavigatorRuntime, "snapshot">,
  generation: number,
): Promise<KernelSnapshot> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const snapshot = runtime.snapshot();
    if (snapshot.document.committed?.generation === generation) return snapshot;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(`isolated document generation ${generation} did not commit`);
}

async function waitForReport(
  reports: readonly HostConformanceReport[],
  errors: readonly string[],
  count: number,
): Promise<HostConformanceReport> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const report = reports[count - 1];
    if (report !== undefined) return report;
    if (errors.length > 0) throw new Error(errors.join("; "));
    await new Promise(requestAnimationFrame);
  }
  throw new Error(`host conformance report ${count} was not received`);
}

function isHostConformanceReport(value: unknown): value is HostConformanceReport {
  return isRecord(value) && value.type === "host-conformance-report";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
