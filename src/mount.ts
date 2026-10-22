import type { PublicationMount } from "./generated/kernel.js";
import { NavigatorError } from "./runtime.js";

/** Builds one path-preserving browser URL from a mount and canonical publication path. */
export function publicationResourceUrl(mount: PublicationMount, path: string): string {
  const base = validatedMountBase(mount.baseUrl);
  const segments = validateCanonicalPath(path);
  return `${base.href}${segments.map(encodeURIComponent).join("/")}`;
}

/** Decodes one raw host request target into an exact canonical publication path. */
export function decodePublicationRoute(baseUrl: string, requestTarget: string): string {
  const base = validatedMountBase(baseUrl);
  if (
    !requestTarget.startsWith("/") ||
    requestTarget.includes("?") ||
    requestTarget.includes("#")
  ) {
    throw invalidRoute(
      requestTarget,
      "publication routes must be absolute paths without a query or fragment",
    );
  }
  if (!requestTarget.startsWith(base.pathname)) {
    throw invalidRoute(requestTarget, "the route is outside the publication mount");
  }

  const encodedPath = requestTarget.slice(base.pathname.length);
  if (encodedPath.length === 0) {
    throw invalidRoute(requestTarget, "the publication route does not identify a resource");
  }
  const encodedSegments = encodedPath.split("/");
  if (encodedSegments.some((segment) => segment.length === 0)) {
    throw invalidRoute(requestTarget, "the publication route contains an empty path segment");
  }

  const segments = encodedSegments.map((segment) => {
    if (/%(?:2f|5c)/i.test(segment)) {
      throw invalidRoute(requestTarget, "encoded path separators are not allowed");
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw invalidRoute(
        requestTarget,
        "the publication route contains malformed percent encoding",
      );
    }
    if (/%(?:2f|5c|2e)/i.test(decoded)) {
      throw invalidRoute(
        requestTarget,
        "the publication route would change under repeated decoding",
      );
    }
    return decoded;
  });

  const path = segments.join("/");
  validateCanonicalPath(path, requestTarget);
  return path;
}

function validatedMountBase(baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
    void new URL(".", base).href;
  } catch {
    throw new NavigatorError({
      code: "invalid-mount",
      message: "the publication mount is invalid",
    });
  }
  if (base.search.length > 0 || base.hash.length > 0 || !base.pathname.endsWith("/")) {
    throw new NavigatorError({
      code: "invalid-mount",
      message: "the publication mount is invalid",
    });
  }
  return base;
}

function validateCanonicalPath(path: string, route = path): string[] {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    containsControlCharacter(path)
  ) {
    throw invalidRoute(route, "the route does not contain a canonical publication path");
  }
  const segments = path.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    segments[0]?.includes(":")
  ) {
    throw invalidRoute(route, "the route does not contain a canonical publication path");
  }
  return segments;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function invalidRoute(route: string, message: string): NavigatorError {
  return new NavigatorError({ code: "invalid-publication-route", message, route });
}
