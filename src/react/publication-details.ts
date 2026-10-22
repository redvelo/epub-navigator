import type { Metadata, TextDirection } from "../generated/publication.js";
import { publicationResourceUrl } from "../mount.js";
import type { MountedPublication } from "../publication.js";
import { resolvedMetadataDirection } from "./lib/metadata-direction.js";

/** One metadata value and the direction the publication says it reads. */
export interface PublicationDetailValue {
  readonly content: string;
  readonly direction: TextDirection | null;
}

export interface PublicationDetail {
  readonly label: string;
  readonly values: readonly PublicationDetailValue[];
}

/**
 * Publication metadata, each value carrying its own direction.
 *
 * The direction cannot be inferred from the text: a title like `CSS: <hebrew>` starts
 * with a Latin letter and would infer left-to-right, which is the opposite of what such a
 * publication usually declares. Only a value that declares nothing is left to inference.
 */
export function publicationDetails(
  metadata: Metadata,
  packageDirection: TextDirection | null,
): readonly PublicationDetail[] {
  const fields: readonly [
    string,
    readonly { readonly content: string | null; readonly dir?: TextDirection | null }[],
  ][] = [
    ["Title", metadata.title],
    ["Creator", metadata.creator],
    ["Contributor", metadata.contributor],
    ["Language", metadata.language],
    ["Publisher", metadata.publisher],
    ["Date", metadata.date],
    ["Identifier", metadata.identifier],
    ["Description", metadata.description],
    ["Subject", metadata.subject],
    ["Rights", metadata.rights],
    ["Format", metadata.format],
  ];

  return fields.flatMap(([label, elements]) => {
    const values = elements.flatMap(({ content, dir }) =>
      content === null || content.trim() === ""
        ? []
        : [{ content, direction: resolvedMetadataDirection(dir, packageDirection) }],
    );
    return values.length === 0 ? [] : [{ label, values }];
  });
}

export function publicationCoverUrl(publication: MountedPublication): string | null {
  const coverPath = publication.facts.resources.coverPath;
  return coverPath === null ? null : publicationResourceUrl(publication.mount, coverPath);
}
