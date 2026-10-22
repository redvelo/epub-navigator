import type { CreateNavigatorRuntimeOptions, NavigatorRuntime } from "./api.js";
import { resolveFrameProfile } from "../frame-profile.js";
import { createNavigatorKernel } from "../kernel.js";
import { KernelDriverRuntime } from "./kernel-driver.js";
import { createFixedRollRuntime } from "../fixed-layout/roll-runtime.js";

export class BrowserNavigatorRuntime extends KernelDriverRuntime {}

export async function createNavigatorRuntime(
  options: CreateNavigatorRuntimeOptions,
): Promise<NavigatorRuntime> {
  return createNavigatorRuntimeInternal(options, "foreground");
}

async function createNavigatorRuntimeInternal(
  options: CreateNavigatorRuntimeOptions,
  role: "foreground" | "auxiliary",
): Promise<NavigatorRuntime> {
  if (typeof options.session.id !== "string" || options.session.id.length === 0) {
    throw new TypeError("the Navigator reader session ID must be a non-empty string");
  }
  const publication = options.session.publication;
  const frameProfile = resolveFrameProfile(
    publication.mount,
    options.container.ownerDocument,
    role === "foreground" ? options.frameSandbox : undefined,
  );
  const kernel = await createNavigatorKernel(publication);
  if (role === "foreground" && kernel.snapshot().publicationLayout === "roll") {
    return createFixedRollRuntime(options, kernel, createNavigatorRuntimeInternal);
  }
  const runtime = new BrowserNavigatorRuntime(
    kernel,
    options.session,
    options.container,
    options.frameTitle ?? "Publication content",
    frameProfile,
    role,
    options.diagnostics ?? null,
    createNavigatorRuntimeInternal,
    options.documentObservation === true,
  );
  if (options.presentationPreferences !== undefined) {
    runtime.setPresentationPreferences(options.presentationPreferences);
  }
  if (role === "foreground") runtime.setPaginationCapabilities(options.pagination);
  return runtime;
}
