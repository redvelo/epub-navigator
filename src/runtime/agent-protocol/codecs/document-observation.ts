import type {
  AgentDocumentObservationResultMessage,
  DocumentObservationFonts,
  DocumentObservationQuery,
  DocumentObservationQueryResult,
  DocumentObservationRequest,
  DocumentObservationResource,
  DocumentObservationResult,
  DocumentObservationStyleProperty,
} from "../types.js";
import {
  DOCUMENT_OBSERVATION_STYLE_PROPERTIES,
  MAX_OBSERVATION_AGGREGATE_STRING_BYTES,
  MAX_OBSERVATION_ATTRIBUTES,
  MAX_OBSERVATION_FONTS,
  MAX_OBSERVATION_QUERIES,
  MAX_OBSERVATION_QUERY_ID_CODE_UNITS,
  MAX_OBSERVATION_RESOURCES,
  MAX_OBSERVATION_SELECTOR_CODE_UNITS,
  MAX_OBSERVATION_STYLE_PROPERTIES,
  MAX_OBSERVATION_TEXT_CODE_UNITS,
  MAX_OBSERVATION_VALUE_CODE_UNITS,
  MAX_OBSERVATION_WITHIN,
} from "../limits.js";
import { envelope, hasEnvelope } from "./envelope.js";
import {
  hasExactKeys,
  isFiniteNumber,
  isNonnegativeInteger,
  isOperationId,
  isRecord,
  utf8ByteLength,
} from "./primitives.js";

const styleProperties = new Set<string>(DOCUMENT_OBSERVATION_STYLE_PROPERTIES);
const attributeName = /^[A-Za-z_:][\w:.-]{0,63}$/u;
const queryKeys = ["id", "selector", "within", "text", "styles", "rect", "attributes"];

function isStyleProperty(value: unknown): value is DocumentObservationStyleProperty {
  return typeof value === "string" && styleProperties.has(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function normalizeDocumentObservationQuery(value: unknown): DocumentObservationQuery | null {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => queryKeys.includes(key)) ||
    !boundedString(value.id, MAX_OBSERVATION_QUERY_ID_CODE_UNITS) ||
    value.id === "" ||
    !boundedString(value.selector, MAX_OBSERVATION_SELECTOR_CODE_UNITS) ||
    value.selector.trim() === ""
  ) {
    return null;
  }
  const query: {
    id: string;
    selector: string;
    within?: readonly string[];
    text?: boolean;
    styles?: readonly DocumentObservationStyleProperty[];
    rect?: boolean;
    attributes?: readonly string[];
  } = { id: value.id, selector: value.selector };
  if (value.within !== undefined) {
    if (
      !Array.isArray(value.within) ||
      value.within.length === 0 ||
      value.within.length > MAX_OBSERVATION_WITHIN ||
      !value.within.every(
        (selector) =>
          boundedString(selector, MAX_OBSERVATION_SELECTOR_CODE_UNITS) && selector.trim() !== "",
      )
    ) {
      return null;
    }
    query.within = [...value.within];
  }
  for (const flag of ["text", "rect"] as const) {
    if (value[flag] !== undefined) {
      if (typeof value[flag] !== "boolean") return null;
      query[flag] = value[flag];
    }
  }
  if (value.styles !== undefined) {
    if (
      !Array.isArray(value.styles) ||
      value.styles.length === 0 ||
      value.styles.length > MAX_OBSERVATION_STYLE_PROPERTIES ||
      !value.styles.every(isStyleProperty) ||
      !uniqueStrings(value.styles)
    ) {
      return null;
    }
    query.styles = [...value.styles];
  }
  if (value.attributes !== undefined) {
    if (
      !Array.isArray(value.attributes) ||
      value.attributes.length === 0 ||
      value.attributes.length > MAX_OBSERVATION_ATTRIBUTES ||
      !value.attributes.every((name) => typeof name === "string" && attributeName.test(name)) ||
      !uniqueStrings(value.attributes)
    ) {
      return null;
    }
    query.attributes = [...value.attributes];
  }
  return query;
}

export function normalizeDocumentObservationRequest(
  value: unknown,
): DocumentObservationRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["queries", "resources", "fonts"]) ||
    !Array.isArray(value.queries) ||
    value.queries.length > MAX_OBSERVATION_QUERIES ||
    typeof value.resources !== "boolean" ||
    typeof value.fonts !== "boolean"
  ) {
    return null;
  }
  const queries: DocumentObservationQuery[] = [];
  for (const candidate of value.queries) {
    const query = normalizeDocumentObservationQuery(candidate);
    if (query === null) return null;
    queries.push(query);
  }
  if (!uniqueStrings(queries.map((query) => query.id))) return null;
  if (queries.length === 0 && !value.resources && !value.fonts) return null;
  return { queries, resources: value.resources, fonts: value.fonts };
}

interface StringBudget {
  bytes: number;
}

function charge(budget: StringBudget, value: string): boolean {
  budget.bytes += utf8ByteLength(value);
  return budget.bytes <= MAX_OBSERVATION_AGGREGATE_STRING_BYTES;
}

function normalizeRect(
  value: unknown,
): DocumentObservationQueryResult extends infer _
  ? { x: number; y: number; width: number; height: number } | null
  : never {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["x", "y", "width", "height"]) ||
    ![value.x, value.y, value.width, value.height].every(
      (item) => isFiniteNumber(item) && Math.abs(item) <= 1_000_000,
    )
  ) {
    return null;
  }
  return {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
}

function normalizeQueryResult(
  value: unknown,
  budget: StringBudget,
): DocumentObservationQueryResult | null {
  if (!isRecord(value) || !boundedString(value.id, MAX_OBSERVATION_QUERY_ID_CODE_UNITS))
    return null;
  if (!charge(budget, value.id)) return null;
  if ("inaccessible" in value) {
    return hasExactKeys(value, ["id", "inaccessible"]) &&
      (value.inaccessible === "cross-origin" || value.inaccessible === "no-frame")
      ? { id: value.id, inaccessible: value.inaccessible }
      : null;
  }
  if (!hasExactKeys(value, ["id", "matches", "first"]) || !isNonnegativeInteger(value.matches))
    return null;
  if (value.first === null) {
    return value.matches === 0 ? { id: value.id, matches: 0, first: null } : null;
  }
  const first = value.first;
  if (
    !isRecord(first) ||
    value.matches === 0 ||
    !Object.keys(first).every((key) => ["text", "styles", "rect", "attributes"].includes(key))
  ) {
    return null;
  }
  const normalized: {
    text?: string;
    styles?: Readonly<Record<string, string>>;
    rect?: { x: number; y: number; width: number; height: number };
    attributes?: Readonly<Record<string, string | null>>;
  } = {};
  if (first.text !== undefined) {
    if (!boundedString(first.text, MAX_OBSERVATION_TEXT_CODE_UNITS) || !charge(budget, first.text))
      return null;
    normalized.text = first.text;
  }
  if (first.styles !== undefined) {
    if (!isRecord(first.styles)) return null;
    const entries = Object.entries(first.styles);
    if (entries.length === 0 || entries.length > MAX_OBSERVATION_STYLE_PROPERTIES) return null;
    const styles: Record<string, string> = {};
    for (const [property, style] of entries) {
      if (
        !isStyleProperty(property) ||
        !boundedString(style, MAX_OBSERVATION_VALUE_CODE_UNITS) ||
        !charge(budget, style)
      )
        return null;
      styles[property] = style;
    }
    normalized.styles = styles;
  }
  if (first.rect !== undefined) {
    const rect = normalizeRect(first.rect);
    if (rect === null) return null;
    normalized.rect = rect;
  }
  if (first.attributes !== undefined) {
    if (!isRecord(first.attributes)) return null;
    const entries = Object.entries(first.attributes);
    if (entries.length === 0 || entries.length > MAX_OBSERVATION_ATTRIBUTES) return null;
    const attributes: Record<string, string | null> = {};
    for (const [name, attribute] of entries) {
      if (!attributeName.test(name)) return null;
      if (attribute !== null) {
        if (
          !boundedString(attribute, MAX_OBSERVATION_VALUE_CODE_UNITS) ||
          !charge(budget, attribute)
        )
          return null;
      }
      attributes[name] = attribute;
    }
    normalized.attributes = attributes;
  }
  return { id: value.id, matches: value.matches, first: normalized };
}

function normalizeResource(
  value: unknown,
  budget: StringBudget,
): DocumentObservationResource | null {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      ["kind", "source", "state", "naturalWidth", "naturalHeight", "readyState"].includes(key),
    ) ||
    (value.kind !== "image" && value.kind !== "media") ||
    !boundedString(value.source, MAX_OBSERVATION_VALUE_CODE_UNITS) ||
    !charge(budget, value.source) ||
    (value.state !== "loaded" && value.state !== "failed" && value.state !== "pending")
  ) {
    return null;
  }
  const resource: {
    kind: "image" | "media";
    source: string;
    state: "loaded" | "failed" | "pending";
    naturalWidth?: number;
    naturalHeight?: number;
    readyState?: number;
  } = { kind: value.kind, source: value.source, state: value.state };
  for (const field of ["naturalWidth", "naturalHeight", "readyState"] as const) {
    const measure = value[field];
    if (measure !== undefined) {
      if (!isNonnegativeInteger(measure) || measure > 1_000_000) return null;
      resource[field] = measure;
    }
  }
  if (value.kind === "image" && value.readyState !== undefined) return null;
  if (
    value.kind === "media" &&
    (value.naturalWidth !== undefined || value.naturalHeight !== undefined)
  )
    return null;
  return resource;
}

function normalizeFonts(value: unknown, budget: StringBudget): DocumentObservationFonts | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "loaded"]) ||
    (value.status !== "loading" && value.status !== "loaded") ||
    !Array.isArray(value.loaded) ||
    value.loaded.length > MAX_OBSERVATION_FONTS ||
    !value.loaded.every(
      (family) => boundedString(family, MAX_OBSERVATION_VALUE_CODE_UNITS) && charge(budget, family),
    )
  ) {
    return null;
  }
  return { status: value.status, loaded: [...value.loaded] };
}

export function normalizeDocumentObservationResult(
  value: unknown,
): DocumentObservationResult | null {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      ["document", "queries", "resources", "fonts"].includes(key),
    ) ||
    !isRecord(value.document) ||
    !hasExactKeys(value.document, [
      "title",
      "lang",
      "dir",
      "readyState",
      "contentType",
      "svgRoot",
    ]) ||
    !Array.isArray(value.queries) ||
    value.queries.length > MAX_OBSERVATION_QUERIES
  ) {
    return null;
  }
  const budget: StringBudget = { bytes: 0 };
  const document = value.document;
  for (const field of ["title", "lang", "dir", "contentType"] as const) {
    const text = document[field];
    if (!boundedString(text, MAX_OBSERVATION_VALUE_CODE_UNITS) || !charge(budget, text))
      return null;
  }
  if (
    (document.readyState !== "loading" &&
      document.readyState !== "interactive" &&
      document.readyState !== "complete") ||
    typeof document.svgRoot !== "boolean"
  ) {
    return null;
  }
  const queries: DocumentObservationQueryResult[] = [];
  for (const candidate of value.queries) {
    const query = normalizeQueryResult(candidate, budget);
    if (query === null) return null;
    queries.push(query);
  }
  if (!uniqueStrings(queries.map((query) => query.id))) return null;
  const result: {
    document: DocumentObservationResult["document"];
    queries: DocumentObservationQueryResult[];
    resources?: DocumentObservationResource[];
    fonts?: DocumentObservationFonts;
  } = {
    document: {
      title: document.title as string,
      lang: document.lang as string,
      dir: document.dir as string,
      readyState: document.readyState,
      contentType: document.contentType as string,
      svgRoot: document.svgRoot,
    },
    queries,
  };
  if (value.resources !== undefined) {
    if (!Array.isArray(value.resources) || value.resources.length > MAX_OBSERVATION_RESOURCES)
      return null;
    const resources: DocumentObservationResource[] = [];
    for (const candidate of value.resources) {
      const resource = normalizeResource(candidate, budget);
      if (resource === null) return null;
      resources.push(resource);
    }
    result.resources = resources;
  }
  if (value.fonts !== undefined) {
    const fonts = normalizeFonts(value.fonts, budget);
    if (fonts === null) return null;
    result.fonts = fonts;
  }
  return result;
}

export function normalizeDocumentObservationResultMessage(
  value: unknown,
): AgentDocumentObservationResultMessage | null {
  if (
    !hasEnvelope(value, "result") ||
    !isOperationId(value.operation) ||
    value.resultType !== "observe-document" ||
    !hasExactKeys(value, ["namespace", "session", "type", "operation", "resultType", "observation"])
  ) {
    return null;
  }
  const observation = normalizeDocumentObservationResult(value.observation);
  return observation === null
    ? null
    : envelope(value.session, {
        type: "result",
        operation: value.operation,
        resultType: "observe-document",
        observation,
      });
}
