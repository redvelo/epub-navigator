export const MAX_PROTOCOL_STRING = 16_384;
export const MAX_LANGUAGE_STRING = 256;
export const MAX_EVIDENCE_ITEMS = 64;
export const MAX_CAPTURE_AGGREGATE_STRING_BYTES = 65_536;
export const MAX_MEDIA_OVERLAY_ENTRY_FRAGMENTS = 4_096;
export const MAX_MEDIA_OVERLAY_CLASS_TOKENS = 32;
export const MAX_MEDIA_OVERLAY_CLASS_TOKEN_LENGTH = 256;
export const MAX_ANNOTATION_EXCERPT_CODE_POINTS = 512;
export const MAX_ANNOTATION_EXCERPT_BYTES = 2_048;
export const MAX_TOC_TARGETS_PER_OPERATION = 32;
export const MAX_TOC_EVIDENCE_ITEMS_PER_OPERATION = 256;
export const MAX_TOC_EVIDENCE_CODE_UNITS_PER_OPERATION = 65_536;
export const MAX_TOC_POINT_PATH = 32;
// Mirrors the kernel execution capability until capability data is generated for TypeScript.
export const MAX_ANNOTATION_SELECTORS = 4096;
export const MAX_ANNOTATION_DEPTH = 128;
export const MAX_ANNOTATION_AGGREGATE_STRING_BYTES = 1024 * 1024;

export const MAX_OBSERVATION_QUERIES = 64;
export const MAX_OBSERVATION_QUERY_ID_CODE_UNITS = 64;
export const MAX_OBSERVATION_SELECTOR_CODE_UNITS = 512;
export const MAX_OBSERVATION_WITHIN = 4;
export const MAX_OBSERVATION_STYLE_PROPERTIES = 32;
export const MAX_OBSERVATION_ATTRIBUTES = 16;
export const MAX_OBSERVATION_TEXT_CODE_UNITS = 1024;
export const MAX_OBSERVATION_VALUE_CODE_UNITS = 512;
export const MAX_OBSERVATION_RESOURCES = 64;
export const MAX_OBSERVATION_FONTS = 32;
export const MAX_OBSERVATION_AGGREGATE_STRING_BYTES = 65_536;
/** The computed properties a document observation may ask about: what EPUB tests ask about. */
export const DOCUMENT_OBSERVATION_STYLE_PROPERTIES = [
  "display",
  "visibility",
  "direction",
  "unicode-bidi",
  "writing-mode",
  "text-orientation",
  "text-combine-upright",
  "text-emphasis-style",
  "text-emphasis-position",
  "text-emphasis-color",
  "text-decoration-line",
  "text-underline-position",
  "text-align-last",
  "text-transform",
  "hyphens",
  "line-break",
  "word-break",
  "font-family",
  "font-style",
  "font-weight",
  "font-size",
  "color",
  "background-color",
  "column-count",
  "width",
  "height",
  "fill",
  "stroke",
  "stroke-width",
] as const;
