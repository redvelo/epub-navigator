import type { TextDirection } from "../../generated/publication";

/**
 * How a metadata element reads, as EPUB resolves it: the element's own `dir` when it has
 * one, otherwise the package's, otherwise undeclared.
 *
 * Undeclared is not `auto`. An explicit `auto` asks for the direction to be inferred from
 * the text, while silence leaves the choice to the reading system, and a publication can
 * declare either. The distinction is visible: a right-to-left title written with a Latin
 * prefix reorders differently under each.
 */
export function resolvedMetadataDirection(
  element: TextDirection | null | undefined,
  packageDirection: TextDirection | null | undefined,
): TextDirection | null {
  return element ?? packageDirection ?? null;
}
