import type { KernelEvent, PublicationFacts } from "epub-navigator";
import { createNavigatorRuntime } from "epub-navigator/runtime";
import {
  aliceMount,
  delivered,
  openArchive,
  requestProbe,
  requiredElement,
  waitFor,
} from "../harness.js";

const resource = "epub/text/hostile-navigation.xhtml";
const output = requiredElement("#result");
const frameHost = requiredElement("#frame-host");

try {
  const publication = await openArchive();
  const facts = addProbe(publication.facts);
  const events: KernelEvent[] = [];
  const runtime = await createNavigatorRuntime({
    session: {
      id: "hostile-navigation",
      publication: { facts: facts.facts, mount: aliceMount },
    },
    container: frameHost,
  });
  runtime.subscribe((transition) => events.push(...transition.events));
  const triggerResults = new Map<string, (result: string | null) => void>();
  window.addEventListener("message", (event) => {
    if (
      typeof event.data === "object" &&
      event.data !== null &&
      event.data.type === "hostile-navigation-result" &&
      typeof event.data.id === "string" &&
      (typeof event.data.result === "string" || event.data.result === null)
    ) {
      triggerResults.get(event.data.id)?.(event.data.result);
      triggerResults.delete(event.data.id);
    }
  });

  const recover = async () => {
    const generation = runtime
      .open(facts.occurrence)
      .events.find((event) => event.type === "document-pending")?.generation;
    if (generation === undefined) throw new Error("probe open did not become pending");
    await waitFor(
      () => runtime.snapshot().document.committed?.generation === generation,
      "timed out waiting for hostile navigation probe",
    );
    return state();
  };
  const state = () => {
    const frame = frameHost.querySelector<HTMLIFrameElement>("iframe");
    let frameUrl: string | null = null;
    try {
      frameUrl = frame?.contentWindow?.location.href ?? null;
    } catch {
      // A cross-origin document may briefly remain attached before invalidation removes it.
    }
    return {
      readerUrl: location.href,
      frameUrl,
      frameCount: frameHost.querySelectorAll("iframe").length,
      childFrames: frame?.contentDocument?.querySelectorAll("iframe").length ?? null,
      committed: runtime.snapshot().document.committed,
      invalidations: events.filter(
        (event) =>
          event.type === "document-invalidated" && event.reason === "unexpected-navigation",
      ).length,
    };
  };
  const trigger = (kind: HostileNavigationKind, id: string): Promise<string | null> => {
    const frame = frameHost.querySelector<HTMLIFrameElement>("iframe");
    const content = frame?.contentWindow;
    if (frame === null || content == null) {
      throw new Error("the committed probe frame is missing");
    }
    const external = `http://localhost:4174/_hostile-navigation/target/${id}`;
    const attachment = `http://localhost:4174/_hostile-navigation/attachment/${id}`;
    const result = new Promise<string | null>((resolve) => triggerResults.set(id, resolve));
    content.postMessage(
      {
        type: "hostile-navigation-trigger",
        kind,
        id,
        external,
        attachment,
        redirect: `${location.origin}/publications/alice/_hostile-navigation/redirect/${id}`,
        publicationChild: `${location.origin}/publications/alice/epub/text/milestone-1-cross.xhtml`,
      },
      "*",
    );
    return result;
  };

  const settle = async (id: string) => {
    const probe = frameHost.querySelector<HTMLIFrameElement>("iframe")?.contentDocument;
    if (probe == null) throw new Error("the committed probe frame is missing");
    await requestProbe(probe, id);
    await delivered();
    return state();
  };

  await recover();
  window.hostileNavigationFixture = { trigger, recover, state, settle };
  output.textContent = "ready";
  output.dataset.state = "ready";
} catch (error) {
  output.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  output.dataset.state = "failed";
}

function addProbe(source: PublicationFacts): {
  readonly facts: PublicationFacts;
  readonly occurrence: number;
} {
  const facts = structuredClone(source);
  const presentation = structuredClone(facts.resources.readingOrder[0]?.presentation);
  if (presentation === undefined) throw new Error("Alice has no reading-order presentation");
  const declaration = facts.package.manifest.items.length;
  const resourceIndex = facts.resources.resources.length;
  const id = "hostile-navigation-probe";
  facts.package.manifest.items.push({
    fallback: null,
    href: "text/hostile-navigation.xhtml",
    mediaType: "application/xhtml+xml",
    mediaOverlay: null,
    id,
    properties: [],
  });
  facts.resources.resources.push({
    address: { kind: "local", value: resource },
    presence: { state: "present", sizeBytes: null },
    declarations: [declaration],
    hasXhtmlDeclaration: true,
    hasStylesheetDeclaration: false,
    hasSvgDeclaration: false,
    scripted: true,
  });
  facts.resources.declarations.push({
    id: { state: "valid", value: id },
    href: resource.slice("epub/".length),
    target: { state: "resource", resource: resourceIndex },
    mediaType: "application/xhtml+xml",
    fallback: null,
    fallbackTarget: null,
  });
  const occurrence = facts.resources.readingOrder.length;
  facts.package.spine.itemrefs.push({ id: null, idref: id, linear: "yes", properties: [] });
  facts.resources.readingOrder.push({
    idref: id,
    target: { state: "declaration", value: declaration },
    resource: resourceIndex,
    linear: "yes",
    presentation,
  });
  return { facts, occurrence };
}

type HostileNavigationKind =
  | "assign"
  | "replace"
  | "meta-refresh"
  | "redirect"
  | "top"
  | "parent"
  | "blank"
  | "named"
  | "window-open"
  | "download"
  | "attachment"
  | "child-external"
  | "child-publication";

interface HostileNavigationState {
  readonly readerUrl: string;
  readonly frameUrl: string | null;
  readonly frameCount: number;
  readonly childFrames: number | null;
  readonly committed: { readonly generation: number } | null;
  readonly invalidations: number;
}

declare global {
  interface Window {
    hostileNavigationFixture: {
      trigger(kind: HostileNavigationKind, id: string): Promise<string | null>;
      recover(): Promise<HostileNavigationState>;
      state(): HostileNavigationState;
      settle(id: string): Promise<HostileNavigationState>;
    };
  }
}

export {};
