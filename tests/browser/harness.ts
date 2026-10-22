import type { KernelSnapshot, PresentationPreferences } from "epub-navigator";
import { openLocalPublication } from "epub-navigator/local";
import { currentFrame, currentObservation } from "../../src/runtime/kernel-view.js";

export const aliceMount = {
  baseUrl: `${location.origin}/publications/alice/`,
  remoteResources: "blocked",
  contentOrigin: "shared-reader-origin",
} as const;

export async function openArchive(url = "/alice.epub") {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} request failed: ${response.status}`);
  return openLocalPublication(await response.arrayBuffer());
}

export function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} is missing`);
  return element;
}

export const singleColumnPreferences: PresentationPreferences = {
  mode: "paginated",
  paginationColumns: "single",
  theme: "original",
  colorScheme: "light",
  typeface: "original",
  fontScale: "100",
  lineHeight: "original",
  letterSpacing: "0",
  wordSpacing: "0",
  paragraphSpacing: "original",
  textIndent: "original",
  measure: "full-width",
  alignment: "original",
  hyphenation: "original",
  rootScrollbar: "hidden",
};

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function delivered(target: Window = window): Promise<void> {
  return new Promise((resolve) => {
    const marker = crypto.randomUUID();
    const listener = (event: MessageEvent) => {
      if (event.data !== marker) return;
      target.removeEventListener("message", listener);
      resolve();
    };
    target.addEventListener("message", listener);
    target.postMessage(marker, location.origin);
  });
}

export async function animationFrames(view: Window = window, count = 2): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise((resolve) => view.requestAnimationFrame(resolve));
  }
}

export async function requestProbe(document: Document, id: string): Promise<void> {
  const image = document.createElement("img");
  const settled = new Promise((resolve) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", resolve, { once: true });
  });
  image.src = `${location.origin}/publications/alice/epub/images/titlepage.svg?request-probe=${id}`;
  document.body.append(image);
  await settled;
  image.remove();
}

export function replacementGeneration(transition: {
  readonly effects: readonly { readonly type: string; readonly frameGeneration?: number }[];
}): number {
  const effect = transition.effects.find((candidate) => candidate.type === "replace-frame");
  if (effect?.frameGeneration === undefined)
    throw new Error("document command emitted no replacement");
  return effect.frameGeneration;
}

export async function waitForCommitted(
  runtime: { snapshot(): KernelSnapshot },
  generation: number,
  timeout = 15_000,
): Promise<KernelSnapshot> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const snapshot = runtime.snapshot();
    if (currentFrame(snapshot)?.generation === generation) return snapshot;
    await new Promise(requestAnimationFrame);
  }
  const snapshot = runtime.snapshot();
  throw new Error(
    `document generation ${generation} did not commit: ${JSON.stringify({ document: snapshot.document, layout: snapshot.layout })}`,
  );
}

export async function waitForObservation(
  runtime: { snapshot(): KernelSnapshot },
  timeout = 15_000,
): Promise<NonNullable<ReturnType<typeof currentObservation>>> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const observation = currentObservation(runtime.snapshot());
    if (observation !== null) return observation;
    await new Promise(requestAnimationFrame);
  }
  throw new Error("the committed document produced no coherent observation");
}
