import type { PublicationMount } from "../generated/kernel.js";
import type { PublicationFrameSandboxCapabilities } from "../publication.js";

interface FrameProfile {
  readonly sandbox: string;
  readonly messageOrigin: string;
  readonly targetOrigin: string;
}

export function resolveFrameProfile(
  mount: PublicationMount,
  ownerDocument: Document,
  capabilities: PublicationFrameSandboxCapabilities = {},
): FrameProfile {
  const publicationUrl = new URL(mount.baseUrl);
  const publicationOrigin = publicationUrl.origin;
  const readerOrigin = requiredReaderOrigin(ownerDocument);
  const sandbox = [
    "allow-scripts",
    "allow-same-origin",
    capabilities.allowForms === true ? "allow-forms" : null,
    capabilities.allowModals === true ? "allow-modals" : null,
  ]
    .filter((token): token is string => token !== null)
    .join(" ");

  if (mount.contentOrigin === "shared-reader-origin") {
    if (publicationOrigin !== readerOrigin) {
      throw new Error("a shared-reader-origin mount must use the reader origin");
    }
    return {
      sandbox,
      messageOrigin: publicationOrigin,
      targetOrigin: publicationOrigin,
    };
  }

  if (publicationOrigin === "null" || publicationOrigin === readerOrigin) {
    throw new Error("an isolated publication origin must be distinct from the reader origin");
  }
  if (publicationUrl.pathname !== "/") {
    throw new Error("an isolated publication must be mounted at its origin root");
  }
  return {
    sandbox,
    messageOrigin: publicationOrigin,
    targetOrigin: publicationOrigin,
  };
}

export function postFrameMessage(
  target: Pick<Window, "postMessage">,
  profile: FrameProfile,
  message: unknown,
): void {
  target.postMessage(message, profile.targetOrigin);
}

export function isExpectedFrameMessage(
  event: Pick<MessageEvent, "origin" | "source">,
  source: Window,
  profile: FrameProfile,
): boolean {
  return event.source === source && event.origin === profile.messageOrigin;
}

function requiredReaderOrigin(ownerDocument: Document): string {
  const origin = ownerDocument.defaultView?.location.origin;
  if (origin === undefined || origin === "null") {
    throw new Error("the Navigator reader must have a non-opaque origin");
  }
  return origin;
}
