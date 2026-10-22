import { createNavigatorRuntime } from "epub-navigator/runtime";
import {
  aliceMount,
  animationFrames,
  delivered,
  openArchive,
  requestProbe,
  requiredElement,
  waitFor,
} from "../harness.js";
import { addRuntimeLifecycleOverlay } from "./runtime-lifecycle-fixture";

const output = requiredElement("#result");
const frameHost = requiredElement("#frame-host");

try {
  const publication = await openArchive();
  try {
    const overlay = addRuntimeLifecycleOverlay(publication.facts);
    const attempts: unknown[] = [];
    const runtime = await createNavigatorRuntime({
      session: {
        id: "form-policy",
        publication: { facts: overlay.facts, mount: aliceMount },
      },
      container: frameHost,
      frameSandbox: { allowForms: true },
    });
    const unsubscribe = runtime.subscribeExternalFormAttempts((attempt) => attempts.push(attempt));
    try {
      const generation = runtime
        .open(overlay.probeOccurrence)
        .events.find((event) => event.type === "document-pending")?.generation;
      if (generation === undefined) throw new Error("form probe open did not become pending");
      await waitFor(
        () => runtime.snapshot().document.committed?.generation === generation,
        "timed out waiting for form probe",
      );
      const frame = frameHost.querySelector<HTMLIFrameElement>("iframe");
      if (frame === null || frame.contentWindow === null)
        throw new Error("form probe frame is missing");
      const content = frame.contentWindow;

      const initialUrl = content.location.href;
      const document = content.document;
      const invalid = requiredForm(document, "invalid-get");
      invalid.querySelector<HTMLButtonElement>("button")?.click();
      invalid.querySelector<HTMLInputElement>("input")!.value = "get-secret";
      invalid.querySelector<HTMLButtonElement>("button")?.click();
      requiredForm(document, "post").querySelector<HTMLButtonElement>("button")?.click();
      requiredForm(document, "request-submit").requestSubmit();
      requiredForm(document, "direct-submit").submit();
      requiredForm(document, "cancelled").requestSubmit();
      await delivered(content);
      await animationFrames(content);
      await requestProbe(document, "form-policy");
      await delivered();

      output.textContent = JSON.stringify({
        sandbox: frame.getAttribute("sandbox"),
        initialUrl,
        finalUrl: content.location.href,
        probe: (content as Window & { formProbe?: unknown }).formProbe,
        attempts,
      });
      output.dataset.state = "ready";
    } finally {
      unsubscribe();
      runtime.close();
    }
  } finally {
    publication.close();
  }
} catch (error) {
  output.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  output.dataset.state = "failed";
}

function requiredForm(document: Document, id: string): HTMLFormElement {
  const form = document.querySelector<HTMLFormElement>(`#${id}`);
  if (form === null) throw new Error(`form ${id} is missing`);
  return form;
}
