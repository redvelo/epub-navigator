import { describe, expect, it } from "vitest";
import {
  CONTENT_AGENT_PROTOCOL_VERSION,
  MAX_MEDIA_OVERLAY_CLASS_TOKENS,
  MAX_MEDIA_OVERLAY_ENTRY_FRAGMENTS,
  buildAgentCancelOperation,
  buildAgentClearSelection,
  buildAgentConfigure,
  buildAgentFixedViewportApplied,
  buildAgentFixedViewportUnavailable,
  buildAgentInitialize,
  buildAgentRelease,
  buildAgentRequest,
  buildAgentReturnFromFootnote,
  buildAgentSetActiveDecoration,
  buildAgentSetMediaOverlayActive,
  buildAgentSetRole,
  normalizeAgentActivation,
  normalizeAgentActivity,
  normalizeAgentAdvancePresentationResult,
  normalizeAgentCancelOperation,
  normalizeAgentClearSelection,
  normalizeAgentConfigure,
  normalizeDocumentObservationRequest,
  normalizeDocumentObservationResult,
  normalizeAgentDecorationActivation,
  normalizeAgentDecorationResult,
  normalizeAgentDocumentObservationResult,
  normalizeAgentFixedViewInteraction,
  normalizeAgentFixedViewport,
  normalizeAgentFixedViewportApplied,
  normalizeAgentFontEvidence,
  normalizeAgentFootnoteReturned,
  normalizeAgentFormSubmission,
  normalizeAgentInitialize,
  normalizeAgentInteraction,
  normalizeAgentLayoutInvalidated,
  normalizeAgentLayoutResult,
  normalizeAgentMediaOverlayActiveApplied,
  normalizeAgentObservation,
  normalizeAgentReady,
  normalizeAgentRelease,
  normalizeAgentReleased,
  normalizeAgentRequest,
  normalizeAgentResult,
  normalizeAgentReturnFromFootnote,
  normalizeAgentRoleChanged,
  normalizeAgentSelectionChanged,
  normalizeAgentSetActiveDecoration,
  normalizeAgentSetMediaOverlayActive,
  normalizeAgentSetRole,
  normalizeAgentTocTargetsResult,
} from "../src/runtime/agent-protocol/index.js";

type Inbound = (event: MessageEvent<unknown>, source: Window, session?: string) => unknown;

const source = {} as Window;
const otherSource = {} as Window;
const session = "0123456789abcdef0123456789abcdef";
const configuration = {
  appearance: { rootScrollbar: "hidden" as const },
  input: {
    keyboardMode: "vim" as const,
    touchZones: true,
    progressionDirection: "rtl" as const,
    selectionMenu: "reader" as const,
  },
};
const defaultConfiguration = {
  appearance: { rootScrollbar: "publisher" },
  input: {
    keyboardMode: "off",
    touchZones: false,
    progressionDirection: "ltr",
    selectionMenu: "native",
  },
};

const wire = <T extends object>(type: string, fields: T = {} as T) => ({
  namespace: "epub-navigator",
  session,
  type,
  ...fields,
});
const event = (data: unknown, from: Window = source) => ({ data, source: from }) as MessageEvent;
const request = (operation: number, value: unknown) =>
  wire("request", { operation, request: value });
const ready = (fields: object = {}) =>
  wire("ready", {
    protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION,
    adapter: "reflowable-xhtml",
    supportedOperations: ["layout"],
    ...fields,
  });
const result = <T extends object>(resultType: string, fields: T, operation = 9) =>
  wire("result", { operation, resultType, ...fields });
const fontEvidence = wire("font-evidence", {
  target: "publication",
  family: "navigator-reader-serif",
  configured: true,
  declared: true,
  loaded: true,
  check: true,
});
const normalizeResult = (data: unknown) => normalizeAgentResult(event(data), source, session);
const anchor = {
  rect: { x: 10, y: 20, width: 30, height: 12 },
  clippingRect: { x: 0, y: 0, width: 320, height: 480 },
  visualViewportOffset: { x: 0, y: 0 },
};
const plan = {
  resource: "EPUB/chapter.xhtml",
  selectors: [{ kind: "css" as const, path: [0], values: { value: "#start" }, refinements: [] }],
};

describe("reader-to-agent messages", () => {
  it("builds and round-trips every lifecycle message", () => {
    const cases: Array<[string, unknown, (value: unknown) => unknown, unknown]> = [
      [
        "default initialization",
        buildAgentInitialize(session, "reflowable-xhtml"),
        normalizeAgentInitialize,
        wire("initialize", {
          protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION,
          adapter: "reflowable-xhtml",
          role: "foreground",
          diagnostics: false,
          observation: false,
          configuration: defaultConfiguration,
        }),
      ],
      [
        "configured initialization",
        buildAgentInitialize(session, "fixed-xhtml", configuration),
        normalizeAgentInitialize,
        wire("initialize", {
          protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION,
          adapter: "fixed-xhtml",
          role: "foreground",
          diagnostics: false,
          observation: false,
          configuration,
        }),
      ],
      [
        "configure",
        buildAgentConfigure(session, configuration),
        normalizeAgentConfigure,
        wire("configure", { configuration }),
      ],
      [
        "clear-selection",
        buildAgentClearSelection(session),
        normalizeAgentClearSelection,
        wire("clear-selection"),
      ],
      ["release", buildAgentRelease(session), normalizeAgentRelease, wire("release")],
      [
        "return-from-footnote",
        buildAgentReturnFromFootnote(session, 4),
        normalizeAgentReturnFromFootnote,
        wire("return-from-footnote", { activationId: 4 }),
      ],
      [
        "set-role",
        buildAgentSetRole(session, "foreground", 9, configuration),
        normalizeAgentSetRole,
        wire("set-role", { role: "foreground", roleChange: 9, configuration }),
      ],
      [
        "cancel-operation",
        buildAgentCancelOperation(session, 7, "layout"),
        normalizeAgentCancelOperation,
        wire("cancel-operation", { operation: 7, operationType: "layout" }),
      ],
      [
        "fixed-viewport-unavailable",
        buildAgentFixedViewportUnavailable(session, 11),
        normalizeAgentFixedViewportApplied,
        wire("fixed-viewport-applied", {
          operation: 11,
          status: "unavailable",
          issue: "final-viewport-unavailable",
        }),
      ],
    ];
    for (const [name, message, normalize, expected] of cases) {
      expect(message, name).toEqual(expected);
      expect(normalize(message), name).toEqual(message);
    }
  });

  it("normalizes initialization roles, adapters, and default diagnostics", () => {
    const initialize = {
      protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION,
      configuration,
    };
    const auxiliary = wire("initialize", {
      ...initialize,
      adapter: "reflowable-xhtml",
      role: "auxiliary",
      diagnostics: true,
    });
    expect(normalizeAgentInitialize(auxiliary)).toEqual({ ...auxiliary, observation: false });
    expect(
      normalizeAgentInitialize(
        wire("initialize", { ...initialize, adapter: "fixed-xhtml", role: "prepared" }),
      ),
    ).toMatchObject({ adapter: "fixed-xhtml", role: "prepared", diagnostics: false });
    expect(
      normalizeAgentInitialize(
        wire("initialize", { ...initialize, adapter: "fixed-svg", role: "foreground" }),
      ),
    ).toMatchObject({ adapter: "fixed-svg" });
  });

  it("rejects invalid lifecycle messages", () => {
    const cases: Array<[string, () => unknown]> = [
      [
        "a newer protocol version",
        () =>
          normalizeAgentInitialize({
            ...buildAgentInitialize(session, "reflowable-xhtml"),
            protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION + 1,
          }),
      ],
      [
        "an unversioned initialization",
        () => {
          const { protocolVersion: _, ...unversioned } = buildAgentInitialize(
            session,
            "reflowable-xhtml",
          );
          return normalizeAgentInitialize(unversioned);
        },
      ],
      [
        "an initialization with unknown fields",
        () =>
          normalizeAgentInitialize({
            ...buildAgentInitialize(session, "reflowable-xhtml"),
            extra: true,
          }),
      ],
      [
        "a sessionless clear-selection",
        () =>
          normalizeAgentClearSelection({ namespace: "epub-navigator", type: "clear-selection" }),
      ],
      [
        "a sessionless release",
        () => normalizeAgentRelease({ namespace: "epub-navigator", type: "release" }),
      ],
      [
        "an unknown keyboard mode",
        () =>
          normalizeAgentConfigure(
            wire("configure", {
              configuration: {
                ...configuration,
                input: { ...configuration.input, keyboardMode: "unknown" },
              },
            }),
          ),
      ],
      [
        "an unknown decoration palette",
        () =>
          normalizeAgentConfigure(
            wire("configure", {
              configuration: {
                ...configuration,
                appearance: { ...configuration.appearance, decorations: "eink" },
              },
            }),
          ),
      ],
    ];
    for (const [name, normalize] of cases) {
      expect(normalize(), name).toBeNull();
    }
  });

  it("carries a declared decoration palette and defaults to none", () => {
    const monochrome = {
      ...configuration,
      appearance: { ...configuration.appearance, decorations: "monochrome" as const },
    };
    const message = buildAgentConfigure(session, monochrome);
    expect(normalizeAgentConfigure(message)).toEqual(message);
    const standard = normalizeAgentConfigure(buildAgentConfigure(session, configuration));
    expect(standard?.configuration.appearance).not.toHaveProperty("decorations");
  });

  it("keeps cancellation ownership distinct by operation kind", () => {
    for (const operationType of [
      "layout",
      "relocate",
      "advance-presentation",
      "measure-toc-targets",
      "capture-selection",
      "generate-annotation-target",
    ] as const) {
      const message = buildAgentCancelOperation(session, 12, operationType);
      expect(message).toMatchObject({ operation: 12, operationType });
      expect(normalizeAgentCancelOperation(message)).toEqual(message);
    }
  });

  it("rejects malformed cancel builder inputs at runtime", () => {
    expect(() => buildAgentCancelOperation("", 1, "layout")).toThrow(TypeError);
    expect(() => buildAgentCancelOperation(session, -1, "layout")).toThrow(TypeError);
    expect(() => buildAgentCancelOperation(session, 1, "unknown" as never)).toThrowError(
      "content-agent operation type is invalid",
    );
  });
});

describe("agent-to-reader trust", () => {
  it("accepts messages only from the expected source and session", () => {
    const cases: Array<[string, Inbound, unknown]> = [
      ["activity", normalizeAgentActivity, wire("activity", { activity: "scroll" })],
      ["font evidence", normalizeAgentFontEvidence, fontEvidence],
      ["readiness", normalizeAgentReady, ready({ adapter: "fixed-xhtml" })],
      ["release acknowledgement", normalizeAgentReleased, wire("released")],
      ["selection change", normalizeAgentSelectionChanged, wire("selection-changed")],
      [
        "media overlay acknowledgement",
        normalizeAgentMediaOverlayActiveApplied,
        wire("media-overlay-active-applied", { commandId: 3, status: "applied", visible: false }),
      ],
      [
        "decoration activation",
        normalizeAgentDecorationActivation,
        wire("decoration-activation", { projectionRevision: 4, ids: ["one"], anchor, link: null }),
      ],
    ];
    for (const [name, normalize, data] of cases) {
      expect(normalize(event(data), source, session), name).toEqual(data);
      expect(normalize(event(data, otherSource), source, session), name).toBeNull();
      expect(normalize(event(data), source, "wrong-session"), name).toBeNull();
    }
  });

  it("checks the source before touching payload data", () => {
    let inspected = false;
    const untrusted = {
      source: otherSource,
      get data() {
        inspected = true;
        throw new Error("must not inspect unrelated traffic");
      },
    } as unknown as MessageEvent<unknown>;
    for (const normalize of [
      normalizeAgentReady,
      normalizeAgentAdvancePresentationResult,
      normalizeAgentLayoutResult,
      normalizeAgentLayoutInvalidated,
      normalizeAgentSelectionChanged,
    ]) {
      expect(normalize(untrusted, source)).toBeNull();
    }
    expect(inspected).toBe(false);
  });

  it("accepts every activity kind and rejects unknown activity", () => {
    for (const activity of ["pointer", "scroll", "presentation"]) {
      const data = wire("activity", { activity });
      expect(normalizeAgentActivity(event(data), source, session)).toEqual(data);
    }
    expect(
      normalizeAgentActivity(event(wire("activity", { activity: "move" })), source),
    ).toBeNull();
  });

  it("rejects malformed font evidence and strips semantic payloads from ambient signals", () => {
    expect(
      normalizeAgentFontEvidence(event({ ...fontEvidence, loaded: "yes" }), source),
    ).toBeNull();
    expect(
      normalizeAgentSelectionChanged(
        event(wire("selection-changed", { selection: "semantic payload is ignored" })),
        source,
      ),
    ).toEqual(wire("selection-changed"));
  });

  it("normalizes readiness capabilities", () => {
    for (const adapter of ["reflowable-xhtml", "fixed-xhtml", "fixed-svg"]) {
      expect(normalizeAgentReady(event(ready({ adapter })), source)).toEqual(ready({ adapter }));
    }
    const operations = ["capture-selection", "generate-annotation-target"];
    expect(
      normalizeAgentReady(event(ready({ supportedOperations: operations })), source),
    ).toMatchObject({ supportedOperations: operations });
    const { protocolVersion: _, ...unversioned } = ready();
    for (const invalid of [
      unversioned,
      ready({ protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION + 1 }),
      ready({ adapter: "fixed-pdf" }),
      ready({ supportedOperations: ["relocate", "relocate"] }),
    ]) {
      expect(normalizeAgentReady(event(invalid), source)).toBeNull();
    }
    expect(normalizeAgentReady(event(ready({ session: undefined })), source, session)).toBeNull();
  });

  it("normalizes role changes and input interactions", () => {
    expect(
      normalizeAgentRoleChanged(
        event(wire("role-changed", { role: "foreground", roleChange: 9 })),
        source,
        session,
      ),
    ).toMatchObject({ role: "foreground", roleChange: 9 });
    const interaction = wire("interaction", { command: "next", source: "keyboard" });
    expect(normalizeAgentInteraction(event(interaction), source)).toEqual(interaction);
    expect(
      normalizeAgentFixedViewInteraction(
        event(
          wire("fixed-view-interaction", {
            action: "zoom",
            source: "touch",
            factor: 1.1,
            focalX: 300,
            focalY: 400,
          }),
        ),
        source,
      ),
    ).toMatchObject({ action: "zoom", factor: 1.1, focalX: 300, focalY: 400 });
    expect(
      normalizeAgentFixedViewInteraction(
        event(
          wire("fixed-view-interaction", {
            action: "pan",
            source: "pointer",
            deltaX: Infinity,
            deltaY: 0,
          }),
        ),
        source,
      ),
    ).toBeNull();
  });
});

describe("agent requests", () => {
  const point = {
    kind: "point" as const,
    occurrence: 3,
    resource: "EPUB/chapter.xhtml",
    evidence: [{ kind: "browser-text-position" as const, offset: "12" }],
    observation: { layoutProgression: 0.2, renderedTextProgression: 0.3 },
  };
  const range = {
    kind: "range" as const,
    occurrence: 3,
    resource: "EPUB/chapter.xhtml",
    evidence: [
      { kind: "browser-text-position" as const, start: "12", end: "24" },
      {
        kind: "rendered-text-quote" as const,
        exact: "selected text",
        prefix: "before ",
        suffix: " after",
      },
    ],
    startObservation: { layoutProgression: 0.2, renderedTextProgression: 0.3 },
    endObservation: { layoutProgression: 0.2, renderedTextProgression: 0.4 },
  };
  const presentation = {
    mode: "paginated",
    paginationColumns: "double",
    theme: "light",
    colorScheme: "light",
    typeface: "reader-serif",
    fontScale: "110",
    lineHeight: "1.5",
    letterSpacing: "0.06",
    wordSpacing: "0.08",
    paragraphSpacing: "1",
    textIndent: "0",
    measure: "wide",
    alignment: "start",
    hyphenation: "auto",
    rootScrollbar: "hidden",
    alignXCenter: false,
  } as const;
  const adjustment = {
    type: "adjust-annotation-range" as const,
    projectionRevision: 4,
    recordId: "host-id",
    edge: "start" as const,
    movement: "backward" as const,
  };

  it("builds and round-trips every request kind", () => {
    const cases: Array<[string, Parameters<typeof buildAgentRequest>[2], unknown]> = [
      [
        "resolve-locator",
        { type: "resolve-locator", locator: point },
        { type: "resolve-locator", target: { kind: "point", evidence: point.evidence } },
      ],
      [
        "resolve-annotation-target",
        { type: "resolve-annotation-target", plan },
        { type: "resolve-annotation-target", plan },
      ],
      [
        "reflowable layout",
        {
          adapter: "reflowable-xhtml",
          presentation,
          position: { kind: "progression", normalizedProgression: 0.25 },
        },
        {
          type: "layout",
          adapter: "reflowable-xhtml",
          presentation,
          position: { kind: "progression", normalizedProgression: 0.25 },
        },
      ],
      [
        "fixed XHTML layout",
        { adapter: "fixed-xhtml" },
        { type: "layout", adapter: "fixed-xhtml" },
      ],
      ["fixed SVG layout", { adapter: "fixed-svg" }, { type: "layout", adapter: "fixed-svg" }],
      [
        "advance-presentation",
        { type: "advance-presentation", direction: "backward" },
        { type: "advance-presentation", direction: "backward" },
      ],
      ["capture-selection", { type: "capture-selection" }, { type: "capture-selection" }],
      [
        "capture-current-location",
        { type: "capture-current-location" },
        { type: "capture-current-location" },
      ],
      [
        "generate-annotation-target",
        {
          type: "generate-annotation-target",
          location: range,
          localContentBasis: 17,
          textFragmentPolicy: "include",
        },
        {
          type: "generate-annotation-target",
          target: { kind: "range", evidence: range.evidence },
          localContentBasis: 17,
          textFragmentPolicy: "include",
        },
      ],
      [
        "generate-current-location-annotation-target",
        {
          type: "generate-current-location-annotation-target",
          location: point,
          localContentBasis: 17,
        },
        {
          type: "generate-current-location-annotation-target",
          target: { kind: "point", evidence: point.evidence },
          localContentBasis: 17,
        },
      ],
      ["adjust-annotation-range", adjustment, adjustment],
      [
        "reconcile-decorations",
        {
          type: "reconcile-decorations",
          projectionRevision: 4,
          records: [{ id: "host-id", appearance: "annotation-highlight", plan }],
        },
        {
          type: "reconcile-decorations",
          projectionRevision: 4,
          records: [{ id: "host-id", appearance: "annotation-highlight", plan }],
        },
      ],
      [
        "find-media-overlay-entry",
        { type: "find-media-overlay-entry", fragments: ["a", "b"] },
        { type: "find-media-overlay-entry", fragments: ["a", "b"] },
      ],
    ];
    for (const [name, value, expected] of cases) {
      const message = buildAgentRequest(session, 8, value);
      expect(message, name).toEqual(request(8, expected));
      expect(normalizeAgentRequest({ ...message, ignored: true }), name).toEqual(message);
    }
  });

  it("normalizes wire-only request shapes and strips unknown members", () => {
    const relocate = request(70, {
      type: "relocate",
      target: {
        kind: "range",
        evidence: [
          { kind: "browser-text-position", start: "12", end: "24" },
          {
            kind: "boundaries",
            start: [{ kind: "browser-text-position", offset: "12" }],
            end: [{ kind: "browser-text-position", offset: "24" }],
          },
        ],
      },
    });
    expect(normalizeAgentRequest(relocate)).toEqual(relocate);
    const layout = request(8, {
      type: "layout",
      adapter: "reflowable-xhtml",
      presentation: {
        ...presentation,
        mode: "document-scroll",
        paginationColumns: "auto",
        theme: "original",
        colorScheme: "dark",
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
        rootScrollbar: "publisher",
      },
      position: {
        kind: "exact",
        evidence: [{ kind: "html-fragment", value: "chapter" }],
        fallbackProgression: 0.4,
      },
    });
    expect(normalizeAgentRequest(layout)).toEqual(layout);
    expect(
      normalizeAgentRequest({
        ...request(10, { type: "advance-presentation", direction: "forward", ignored: true }),
        ignored: true,
      }),
    ).toEqual(request(10, { type: "advance-presentation", direction: "forward" }));
    const toc = request(10, {
      type: "measure-toc-targets",
      targets: [
        { listIndex: 0, pointPath: [1, 2], evidence: [{ kind: "html-fragment", value: "s" }] },
      ],
    });
    expect(normalizeAgentRequest(toc)).toEqual(toc);
  });

  const generate = {
    type: "generate-annotation-target",
    target: { kind: "range", evidence: range.evidence },
    localContentBasis: 17,
    textFragmentPolicy: "include",
  };
  it("rejects malformed and unbounded requests", () => {
    const cases: Array<[string, unknown]> = [
      [
        "a non-canonical text position",
        {
          type: "relocate",
          target: {
            kind: "range",
            evidence: [{ kind: "browser-text-position", start: "024", end: "12" }],
          },
        },
      ],
      [
        "a nested annotation refinement",
        {
          type: "resolve-annotation-target",
          plan: {
            ...plan,
            selectors: [{ ...plan.selectors[0], refinements: [plan.selectors[0]] }],
          },
        },
      ],
      ["an unknown layout adapter", { type: "layout", adapter: "fixed-pdf" }],
      [
        "an out-of-range progression",
        {
          type: "layout",
          adapter: "reflowable-xhtml",
          presentation,
          position: { kind: "progression", normalizedProgression: 1.01 },
        },
      ],
      ["an unknown direction", { type: "advance-presentation", direction: "sideways" }],
      [
        "a point generation target",
        {
          ...generate,
          target: { kind: "point", evidence: [{ kind: "html-fragment", value: "p" }] },
        },
      ],
      [
        "an oversized generation quote",
        {
          ...generate,
          target: {
            kind: "range",
            evidence: [
              { kind: "rendered-text-quote", exact: "é".repeat(8193), prefix: "", suffix: "" },
            ],
          },
        },
      ],
      ["an overflowing content basis", { ...generate, localContentBasis: 0x1_0000_0000 }],
      ["an unknown text fragment policy", { ...generate, textFragmentPolicy: "automatic" }],
      [
        "too much generation evidence",
        {
          ...generate,
          target: {
            kind: "range",
            evidence: Array.from({ length: 65 }, () => ({
              kind: "browser-text-position",
              start: "1",
              end: "2",
            })),
          },
        },
      ],
      [
        "an overflowing TOC point path",
        {
          type: "measure-toc-targets",
          targets: [{ listIndex: 0, pointPath: [0x1_0000_0000], evidence: [] }],
        },
      ],
      [
        "too much aggregate TOC evidence",
        {
          type: "measure-toc-targets",
          targets: Array.from({ length: 5 }, (_, index) => ({
            listIndex: 0,
            pointPath: [index],
            evidence: Array.from({ length: 64 }, () => ({
              kind: "document-boundary",
              boundary: "start",
            })),
          })),
        },
      ],
      [
        "too many aggregate TOC evidence bytes",
        {
          type: "measure-toc-targets",
          targets: Array.from({ length: 5 }, (_, index) => ({
            listIndex: 0,
            pointPath: [index],
            evidence: [{ kind: "rendered-text-context", before: "a".repeat(16_384), after: "b" }],
          })),
        },
      ],
      ["an unknown adjustment edge", { ...adjustment, edge: "anchor" }],
      ["an oversized adjustment record ID", { ...adjustment, recordId: "x".repeat(20_000) }],
      ["a forged adjustment plan", { ...adjustment, plan: { resource: "forged" } }],
      [
        "duplicate decoration IDs",
        {
          type: "reconcile-decorations",
          projectionRevision: 4,
          records: [
            { id: "same", appearance: "search-result", plan },
            { id: "same", appearance: "search-result", plan },
          ],
        },
      ],
      [
        "unknown entry lookup members",
        { type: "find-media-overlay-entry", fragments: ["a"], x: 1 },
      ],
    ];
    for (const [name, value] of cases) {
      expect(normalizeAgentRequest(request(31, value)), name).toBeNull();
    }
  });

  it("rejects operation identifiers outside uint32", () => {
    expect(normalizeAgentRequest(request(0x1_0000_0000, { type: "capture-selection" }))).toBeNull();
  });

  it("accepts decoration batches of any size", () => {
    const records = Array.from({ length: 2_000 }, (_, index) => ({
      id: String(index),
      appearance: "search-result",
      plan: {
        ...plan,
        selectors: [{ ...plan.selectors[0], values: { value: `#${"x".repeat(3_000)}` } }],
      },
    }));
    expect(
      normalizeAgentRequest(
        request(9, { type: "reconcile-decorations", projectionRevision: 4, records }),
      )?.request,
    ).toMatchObject({ records: { length: 2_000 } });
    expect(
      normalizeAgentRequest(
        request(9, { type: "reconcile-decorations", projectionRevision: 4, records: [] }),
      ),
    ).toMatchObject({ request: { records: [] } });
  });

  it("rejects invalid builder inputs at runtime", () => {
    expect(() =>
      buildAgentRequest(session, 31, {
        type: "generate-annotation-target",
        location: { ...range, kind: "point" } as never,
        localContentBasis: 17,
        textFragmentPolicy: "include",
      }),
    ).toThrowError("content-agent annotation target generation request is invalid");
    expect(() =>
      buildAgentRequest(session, 1, { type: "find-media-overlay-entry", fragments: [] }),
    ).toThrow(TypeError);
    expect(() =>
      buildAgentRequest(session, 1, {
        type: "find-media-overlay-entry",
        fragments: Array.from(
          { length: MAX_MEDIA_OVERLAY_ENTRY_FRAGMENTS + 1 },
          (_, index) => `f${index}`,
        ),
      }),
    ).toThrow(TypeError);
  });
});

describe("agent results", () => {
  it("strips unknown members from locator and presentation results", () => {
    expect(
      normalizeResult({
        ...result(
          "resolve-locator",
          { status: { status: "resolved", ignored: true } },
          0xffff_ffff,
        ),
        ignored: true,
      }),
    ).toEqual(result("resolve-locator", { status: { status: "resolved" } }, 0xffff_ffff));
    expect(
      normalizeAgentAdvancePresentationResult(
        event({
          ...result("advance-presentation", {
            status: { status: "unavailable", reason: "presentation-unavailable", ignored: true },
          }),
          ignored: true,
        }),
        source,
        session,
      ),
    ).toEqual(
      result("advance-presentation", {
        status: { status: "unavailable", reason: "presentation-unavailable" },
      }),
    );
    expect(
      normalizeAgentAdvancePresentationResult(
        event(
          result("advance-presentation", {
            status: { status: "failed", message: "movement failed" },
          }),
        ),
        source,
      ),
    ).toMatchObject({ status: { status: "failed", message: "movement failed" } });
  });

  it("rejects malformed results", () => {
    const cases: Array<[string, unknown]> = [
      ["a negative operation", result("relocate", { status: { status: "resolved" } }, -1)],
      ["an unknown status", result("relocate", { status: { status: "unknown" } })],
      [
        "presentation results on the generic channel",
        result("advance-presentation", { status: { status: "advanced" } }),
      ],
      [
        "an entry without an index",
        result("find-media-overlay-entry", { outcome: { state: "found" } }),
      ],
      [
        "a missing entry with an index",
        result("find-media-overlay-entry", { outcome: { state: "none", index: 1 } }),
      ],
    ];
    for (const [name, data] of cases) {
      expect(normalizeResult(data), name).toBeNull();
    }
  });

  it("rejects presentation reasons outside the presentation contract", () => {
    expect(
      normalizeAgentAdvancePresentationResult(
        event(
          result("advance-presentation", {
            status: { status: "unavailable", reason: "selection-active" },
          }),
        ),
        source,
      ),
    ).toBeNull();
  });

  it("normalizes media overlay entry lookup results", () => {
    const found = result("find-media-overlay-entry", { outcome: { state: "found", index: 1 } });
    expect(normalizeResult(found)).toEqual(found);
    const none = result("find-media-overlay-entry", { outcome: { state: "none" } });
    expect(normalizeResult(none)).toEqual(none);
  });

  describe("annotation target results", () => {
    const report = {
      path: [0],
      kind: "css" as const,
      outcome: "resolved" as const,
      matchCount: 1,
      segment: { kind: "element" as const, resource: "EPUB/chapter.xhtml" },
      message: null,
    };
    const resolved = { outcome: "resolved", reports: [report], segment: report.segment };
    const annotation = (value: unknown, resultType = "resolve-annotation-target") =>
      result(resultType, { result: value }, 17);
    const pointSegment = { kind: "point", resource: "EPUB/chapter.xhtml" };

    it("normalizes every resolution outcome", () => {
      const cases: Array<[string, unknown]> = [
        ["resolved", resolved],
        [
          "point",
          { ...resolved, reports: [{ ...report, segment: pointSegment }], segment: pointSegment },
        ],
        [
          "unavailable",
          {
            outcome: "unavailable",
            reports: [{ ...report, outcome: "unavailable", matchCount: 0, segment: null }],
            segment: null,
          },
        ],
        ["stale", { outcome: "stale", reports: [{ ...report, outcome: "stale" }], segment: null }],
        ["failed", { outcome: "failed", reports: [], segment: null }],
        [
          "nested stale",
          {
            outcome: "stale",
            reports: [
              { ...report, outcome: "stale" },
              { ...report, path: [0, 0], outcome: "stale" },
            ],
            segment: null,
          },
        ],
        [
          "converged ambiguous",
          { ...resolved, reports: [{ ...report, outcome: "ambiguous", matchCount: 2 }] },
        ],
        [
          "broken",
          {
            outcome: "broken",
            reports: [{ ...report, outcome: "broken", matchCount: 0, segment: null }],
            segment: null,
          },
        ],
      ];
      for (const [name, value] of cases) {
        expect(normalizeResult({ ...annotation(value), ignored: true }), name).toEqual(
          annotation(value),
        );
        expect(normalizeResult(annotation(value, "relocate-annotation-target")), name).toEqual(
          annotation(value, "relocate-annotation-target"),
        );
      }
    });

    it("rejects inconsistent or unbounded reports", () => {
      const cases: Array<[string, unknown]> = [
        ["duplicate reports", { ...resolved, reports: [report, report] }],
        ["an inconsistent outcome", { ...resolved, outcome: "broken", segment: null }],
        [
          "an orphaned refinement report",
          {
            outcome: "broken",
            reports: [{ ...report, path: [0, 0], outcome: "broken", matchCount: 0, segment: null }],
            segment: null,
          },
        ],
        [
          "oversized diagnostics",
          {
            outcome: "broken",
            reports: Array.from({ length: 65 }, (_, index) => ({
              path: [index],
              kind: "invalid",
              outcome: "invalid",
              matchCount: 0,
              segment: null,
              message: "x".repeat(16_384),
            })),
            segment: null,
          },
        ],
      ];
      for (const [name, value] of cases) {
        expect(normalizeResult(annotation(value)), name).toBeNull();
      }
    });
  });

  describe("annotation target generation candidates", () => {
    const candidate = {
      localContentBasis: 17,
      textFragmentPolicy: "include",
      status: {
        status: "generated",
        selectors: {
          css: { value: "#chapter p", start: "12", end: "24" },
          document: { start: "120", end: "132" },
          textFragment: "selected%20text",
        },
      },
    };
    const generated = (value: unknown) =>
      result("generate-annotation-target", { candidate: value }, 31);
    const excluded = (status: unknown) => ({
      localContentBasis: 17,
      textFragmentPolicy: "exclude",
      status,
    });
    const selectors = (value: unknown) => ({
      ...candidate,
      status: { status: "generated", selectors: value },
    });

    it("strips unknown members from generated candidates", () => {
      expect(
        normalizeResult({
          ...generated({
            ...candidate,
            status: {
              status: "generated",
              selectors: {
                css: { ...candidate.status.selectors.css, ignored: true },
                document: { ...candidate.status.selectors.document, ignored: true },
                textFragment: "selected%20text",
                ignored: true,
              },
              ignored: true,
            },
            ignored: true,
          }),
          ignored: true,
        }),
      ).toEqual(generated(candidate));
    });

    it("normalizes every non-generated candidate status", () => {
      for (const status of [
        { status: "unsupported" },
        { status: "ambiguous" },
        { status: "conflict" },
        { status: "stale" },
        { status: "unavailable", reason: "not-authored" },
        { status: "unavailable", reason: "no-exact-selector" },
        { status: "failed", message: null },
        { status: "failed", message: "generation failed" },
      ]) {
        expect(normalizeResult(generated(excluded(status)))).toEqual(generated(excluded(status)));
      }
    });

    it("normalizes current-location candidates", () => {
      const current = result(
        "generate-current-location-annotation-target",
        {
          candidate: {
            localContentBasis: 17,
            status: {
              status: "generated",
              selectors: {
                css: { value: "#chapter", offset: "12" },
                document: { offset: "120" },
                wholeResource: false,
              },
            },
          },
        },
        32,
      );
      expect(normalizeResult(current)).toEqual(current);
    });

    it("rejects invalid candidates", () => {
      const cases: Array<[string, unknown]> = [
        ["a negative content basis", { ...candidate, localContentBasis: -1 }],
        ["an unknown policy", { ...candidate, textFragmentPolicy: "automatic" }],
        ["an unknown unavailable reason", excluded({ status: "unavailable", reason: "empty" })],
        ["a fragment excluded by policy", { ...candidate, textFragmentPolicy: "exclude" }],
        ["no selectors", selectors({ css: null, document: null, textFragment: null })],
        ...[
          ["01", "2"],
          ["2", "2"],
          ["2", "1"],
          ["0", "18446744073709551616"],
        ].map(([start, end]): [string, unknown] => [
          `document position ${start}-${end}`,
          selectors({ css: null, document: { start, end }, textFragment: null }),
        ]),
        [
          "an oversized CSS selector",
          selectors({
            css: { value: "é".repeat(8193), start: "1", end: "2" },
            document: null,
            textFragment: null,
          }),
        ],
        ["an oversized failure", excluded({ status: "failed", message: "é".repeat(8193) })],
      ];
      for (const [name, value] of cases) {
        expect(normalizeResult(generated(value)), name).toBeNull();
      }
    });
  });

  describe("selection capture", () => {
    const basis = { localContentBasis: 1, localGeometryBasis: 2 };
    const captured = {
      status: "captured",
      evidence: [{ kind: "browser-text-position", start: "1", end: "2" }],
      observation: { layoutProgression: null, renderedTextProgression: null },
      direction: "forward",
      language: null,
      anchor: {
        rect: { x: -1, y: -2, width: 3, height: 4 },
        clippingRect: { x: -5, y: -6, width: 7, height: 8 },
        visualViewportOffset: { x: -9, y: 10 },
      },
      gesture: null,
      basis,
    };
    const selection = (outcome: unknown) => result("capture-selection", { outcome }, 21);

    it("keeps only semantic selection fields", () => {
      const normalized = normalizeResult({
        ...selection({
          status: "captured",
          evidence: [
            {
              kind: "boundaries",
              start: [
                { kind: "html-fragment", value: "start", ignored: true },
                { kind: "browser-text-position", offset: "12" },
              ],
              end: [{ kind: "browser-text-position", offset: "24" }],
              ignored: true,
            },
            { kind: "rendered-text-quote", exact: "selected", prefix: "before", suffix: "after" },
          ],
          observation: { layoutProgression: 0.25, renderedTextProgression: 0.5, ignored: true },
          direction: "backward",
          language: "fr-CA",
          gesture: "settled",
          anchor: {
            rect: { x: -10, y: -20, width: 30, height: 40, ignored: true },
            clippingRect: { x: -5, y: 0, width: 20, height: 25 },
            visualViewportOffset: { x: -2.5, y: 3.5, ignored: true },
            ignored: true,
          },
          basis: {
            localContentBasis: 0,
            localGeometryBasis: 0xffff_ffff,
            participant: { kind: "primary", documentGeneration: 1 },
            frameGeneration: 2,
          },
          resource: "must-not-cross-the-wire.xhtml",
          occurrence: 4,
        }),
        ignored: true,
      });
      expect(normalized).toEqual(
        selection({
          status: "captured",
          evidence: [
            {
              kind: "boundaries",
              start: [
                { kind: "html-fragment", value: "start" },
                { kind: "browser-text-position", offset: "12" },
              ],
              end: [{ kind: "browser-text-position", offset: "24" }],
            },
            { kind: "rendered-text-quote", exact: "selected", prefix: "before", suffix: "after" },
          ],
          observation: { layoutProgression: 0.25, renderedTextProgression: 0.5 },
          direction: "backward",
          language: "fr-CA",
          gesture: "settled",
          anchor: {
            rect: { x: -10, y: -20, width: 30, height: 40 },
            clippingRect: { x: -5, y: 0, width: 20, height: 25 },
            visualViewportOffset: { x: -2.5, y: 3.5 },
          },
          basis: { localContentBasis: 0, localGeometryBasis: 0xffff_ffff },
        }),
      );
    });

    it("normalizes every capture outcome", () => {
      for (const outcome of [
        captured,
        { ...captured, language: "fr" },
        ...["collapsed", "unsupported", "ambiguous", "conflict", "stale"].map((status) => ({
          status,
          basis,
        })),
        ...["no-selection", "document-inactive", "layout-unavailable", "geometry-unavailable"].map(
          (reason) => ({ status: "unavailable", reason, basis }),
        ),
        { status: "failed", message: null, basis },
        { status: "failed", message: "capture failed", basis },
      ]) {
        expect(normalizeResult(selection({ ...outcome, ignored: true }))).toEqual(
          selection(outcome),
        );
      }
    });

    it("enforces evidence, string, basis, and geometry limits", () => {
      const cases: Array<[string, unknown]> = [
        ["an empty language", { ...captured, language: "" }],
        ["a missing language", { ...captured, language: undefined }],
        ["no evidence", { ...captured, evidence: [] }],
        [
          "too many boundary items",
          {
            ...captured,
            evidence: [
              {
                kind: "boundaries",
                start: Array.from({ length: 63 }, () => ({
                  kind: "document-boundary",
                  boundary: "start",
                })),
                end: [{ kind: "document-boundary", boundary: "end" }],
              },
            ],
          },
        ],
        [
          "an oversized quote",
          {
            ...captured,
            evidence: [
              { kind: "rendered-text-quote", exact: "é".repeat(8193), prefix: "", suffix: "" },
            ],
          },
        ],
        [
          "too many aggregate evidence bytes",
          {
            ...captured,
            evidence: Array.from({ length: 5 }, () => ({
              kind: "rendered-text-quote",
              exact: "x".repeat(16_384),
              prefix: "",
              suffix: "",
            })),
          },
        ],
        ["a negative basis", { ...captured, basis: { ...basis, localContentBasis: -1 } }],
        ["a fractional basis", { ...captured, basis: { ...basis, localContentBasis: 1.5 } }],
        [
          "an overflowing basis",
          { ...captured, basis: { ...basis, localGeometryBasis: 0x1_0000_0000 } },
        ],
        [
          "a negative rectangle",
          {
            ...captured,
            anchor: { ...captured.anchor, rect: { x: 0, y: 0, width: -1, height: 1 } },
          },
        ],
        [
          "a non-finite rectangle",
          {
            ...captured,
            anchor: { ...captured.anchor, rect: { x: Infinity, y: 0, width: 1, height: 1 } },
          },
        ],
        [
          "a non-finite clipping rectangle",
          {
            ...captured,
            anchor: {
              ...captured.anchor,
              clippingRect: { x: 0, y: 0, width: 1, height: Number.NaN },
            },
          },
        ],
        [
          "a non-finite viewport offset",
          {
            ...captured,
            anchor: { ...captured.anchor, visualViewportOffset: { x: 0, y: Infinity } },
          },
        ],
        [
          "a non-canonical text position",
          { ...captured, evidence: [{ kind: "browser-text-position", start: "02", end: "3" }] },
        ],
        [
          "empty boundaries",
          { ...captured, evidence: [{ kind: "boundaries", start: [], end: [] }] },
        ],
        ["an oversized failure", { status: "failed", message: "é".repeat(8193), basis }],
      ];
      for (const [name, outcome] of cases) {
        expect(normalizeResult(selection(outcome)), name).toBeNull();
      }
    });

    it("normalizes strict current-location captures", () => {
      const current = (outcome: object) =>
        result(
          "capture-current-location",
          {
            outcome: {
              status: "captured",
              observation: { layoutProgression: null, renderedTextProgression: 0.5 },
              basis: { localContentBasis: 3, localGeometryBasis: 4 },
              ...outcome,
            },
          },
          22,
        );
      expect(
        normalizeResult(
          current({
            evidence: [{ kind: "browser-text-position", offset: "7", ignored: true }],
            occurrence: 99,
          }),
        ),
      ).toEqual(current({ evidence: [{ kind: "browser-text-position", offset: "7" }] }));
      expect(normalizeResult(current({ evidence: [] }))).toBeNull();
    });
  });

  it("normalizes TOC target batches and rejects duplicate identities", () => {
    const toc = result(
      "measure-toc-targets",
      {
        results: [
          { listIndex: 0, pointPath: [1, 2], result: { state: "located", physicalPage: 3 } },
        ],
      },
      10,
    );
    const normalize = (data: unknown) => normalizeAgentTocTargetsResult(event(data), source);
    expect(normalize(toc)).toEqual(toc);
    expect(normalize({ ...toc, results: [toc.results[0], toc.results[0]] })).toBeNull();
    expect(
      normalize({
        ...toc,
        results: [{ ...toc.results[0], result: { state: "located", physicalPage: 0x1_0000_0000 } }],
      }),
    ).toBeNull();
  });

  it("normalizes correlated decoration outcomes", () => {
    const adjusted = result("adjust-annotation-range", {
      candidate: {
        projectionRevision: 4,
        recordId: "host-id",
        edge: "start",
        movement: "backward",
        status: {
          status: "generated",
          selectors: { css: null, document: { start: "0", end: "10" }, textFragment: null },
        },
        excerpt: "alpha beta",
      },
    });
    expect(normalizeResult(adjusted)).toEqual(adjusted);
    const reconciled = result("reconcile-decorations", {
      projectionRevision: 4,
      outcomes: [
        { id: "a", outcome: { status: "rendered" } },
        { id: "b", outcome: { status: "unavailable", message: null } },
      ],
    });
    const normalize = (data: unknown) =>
      normalizeAgentDecorationResult(event(data), source, session);
    expect(normalize(reconciled)).toEqual(reconciled);
    expect(
      normalize({ ...reconciled, outcomes: [{ id: "a", outcome: { status: "failed" } }] }),
    ).toBeNull();
  });
});

describe("agent layout results", () => {
  const observation = {
    writingMode: "horizontal-tb",
    direction: "ltr",
    language: null,
    viewport: { width: 800, height: 600 },
    canvas: { state: "unavailable" },
    visibleStart: {
      state: "located",
      evidence: [{ kind: "document-boundary", boundary: "start" }],
    },
    visibleEnd: { state: "unavailable" },
    renderedTextProgression: 0,
    pagination: null,
  };
  const measurement = {
    observation,
    logicalViewport: { inline: 800, block: 600 },
    logicalContentExtent: { inline: 2400, block: 600 },
    normalizedPosition: 0.5,
    physicalMovement: { x: 800, y: 0 },
    requiredFonts: "loaded",
    requiredResources: "loaded",
  };
  const pages = {
    spreadStride: 800,
    columnOrigin: 16,
    columnWidth: 368,
    columnGap: 32,
    columnPitch: 400,
    firstVisiblePage: 2,
    pageCount: 3,
    visiblePageCount: 1,
    columnsPerView: 2,
    layoutRepairs: { status: "repaired", repairedElements: 1 },
  };
  const geometry = {
    intrinsicViewport: { width: 600, height: 800 },
    containingViewport: { width: 900, height: 700 },
    scale: 0.875,
    renderedWidth: 525,
    renderedHeight: 700,
    offsetX: 187.5,
    offsetY: 0,
  };
  const layout = (value: unknown) => result("layout", { result: value });
  const paginated = (overrides: { measurement?: object; pages?: object } = {}) =>
    layout({
      adapter: "reflowable-xhtml",
      outcome: {
        status: "settled",
        settlement: {
          mode: "paginated",
          measurement: { ...measurement, ...overrides.measurement },
          pages: { ...pages, ...overrides.pages },
        },
      },
    });
  const fixed = (adapter: string, mode = "contain") =>
    layout({
      adapter,
      outcome: {
        status: "settled",
        settlement: {
          mode,
          measurement: {
            ...measurement,
            observation: { ...observation, viewport: geometry.intrinsicViewport },
          },
          geometry,
        },
      },
    });
  const normalize = (data: unknown) => normalizeAgentLayoutResult(event(data), source);

  it("normalizes settled and fixed layouts", () => {
    const cases: Array<[string, unknown]> = [
      ["paginated", paginated()],
      ...(["loaded", "failed", "timed-out"] as const).map(
        (requiredResources): [string, unknown] => [
          `${requiredResources} resources`,
          paginated({ measurement: { requiredResources } }),
        ],
      ),
      ...(
        [
          { status: "no-issues-detected" },
          { status: "repaired", repairedElements: 0xffff_ffff },
          { status: "unresolved", repairedElements: 0, unresolvedElements: 1 },
          { status: "unresolved", repairedElements: 1, unresolvedElements: 2 },
          { status: "unresolved", repairedElements: 0xffff_ffff, unresolvedElements: 0xffff_ffff },
        ] as const
      ).map((layoutRepairs): [string, unknown] => [
        `text pagination ${JSON.stringify(layoutRepairs)}`,
        paginated({ pages: { layoutRepairs } }),
      ]),
      ["fixed XHTML", fixed("fixed-xhtml")],
      ["fixed SVG", fixed("fixed-svg")],
    ];
    for (const [name, data] of cases) {
      expect(normalize(data), name).toEqual(data);
    }
  });

  it("rejects inconsistent layouts", () => {
    const cases: Array<[string, unknown]> = [
      ["pending resources", paginated({ measurement: { requiredResources: "pending" } })],
      ...(
        [
          { status: "repaired", repairedElements: 0 },
          { status: "repaired", repairedElements: 0x1_0000_0000 },
          { status: "unresolved", repairedElements: 0, unresolvedElements: 0 },
          { status: "unresolved", repairedElements: -1, unresolvedElements: 1 },
          { status: "not-applicable" },
        ] as const
      ).map((layoutRepairs): [string, unknown] => [
        `text pagination ${JSON.stringify(layoutRepairs)}`,
        paginated({ pages: { layoutRepairs } }),
      ]),
      [
        "an inconsistent spread stride",
        paginated({ pages: { columnPitch: 500, spreadStride: 1000 } }),
      ],
      ["too many columns", paginated({ pages: { spreadStride: 0, columnsPerView: 3 } })],
      ["paginated fixed SVG", fixed("fixed-svg", "paginated")],
      [
        "a reflowable issue for fixed SVG",
        layout({
          adapter: "fixed-svg",
          outcome: { status: "unavailable", issue: "publication-continuous-unavailable" },
        }),
      ],
      [
        "an unknown conflict",
        layout({ adapter: "fixed-xhtml", outcome: { status: "conflict", issue: "unknown" } }),
      ],
    ];
    for (const [name, data] of cases) {
      expect(normalize(data), name).toBeNull();
    }
  });

  it("negotiates the fixed viewport", () => {
    const proposal = wire("fixed-viewport", {
      operation: 10,
      intrinsicViewport: geometry.intrinsicViewport,
    });
    expect(normalizeAgentFixedViewport(event(proposal), source)).toEqual(proposal);
    expect(
      normalizeAgentFixedViewport(
        event({ ...proposal, intrinsicViewport: { width: 0, height: 800 } }),
        source,
      ),
    ).toBeNull();
    const applied = buildAgentFixedViewportApplied(session, 10, geometry);
    expect(applied).toEqual(
      wire("fixed-viewport-applied", { operation: 10, status: "applied", geometry }),
    );
    expect(normalizeAgentFixedViewportApplied(applied)).toEqual(applied);
  });

  it("accepts only known layout invalidation causes", () => {
    const invalidated = wire("layout-invalidated", { cause: "fonts" });
    expect(normalizeAgentLayoutInvalidated(event(invalidated), source)).toEqual(invalidated);
    expect(
      normalizeAgentLayoutInvalidated(
        event(wire("layout-invalidated", { cause: "cssom" })),
        source,
      ),
    ).toBeNull();
  });
});

describe("agent observations and navigation", () => {
  const observation = wire("observation", {
    writingMode: "vertical-rl",
    direction: "rtl",
    language: "ja",
    viewport: { width: 800, height: 600 },
    canvas: { state: "solid-color", cssColor: "rgb(248, 245, 237)" },
    visibleStart: { state: "located", evidence: [{ kind: "html-fragment", value: "p1" }] },
    visibleEnd: { state: "located", evidence: [{ kind: "document-boundary", boundary: "end" }] },
    renderedTextProgression: 0.5,
    pagination: null,
  });
  const normalize = (data: unknown) => normalizeAgentObservation(event(data), source);
  const pagination = { firstVisiblePage: 2, pageCount: 5, visiblePageCount: 2 };

  it("normalizes observations", () => {
    expect(normalize(observation)).toEqual(observation);
    expect(normalize({ ...observation, pagination })).toEqual({ ...observation, pagination });
    expect(
      normalize({ ...observation, visibleEnd: { state: "unavailable", evidence: [] } }),
    ).toEqual({ ...observation, visibleEnd: { state: "unavailable" } });
  });

  it("rejects invalid observations", () => {
    const cases: Array<[string, object]> = [
      ["non-finite progression", { renderedTextProgression: Number.NaN }],
      [
        "an oversized canvas color",
        { canvas: { state: "solid-color", cssColor: "x".repeat(257) } },
      ],
      ["located without evidence", { visibleEnd: { state: "located", evidence: [] } }],
      ["too many visible pages", { pagination: { ...pagination, visiblePageCount: 4 } }],
    ];
    for (const [name, fields] of cases) {
      expect(normalize({ ...observation, ...fields }), name).toBeNull();
    }
  });

  it("normalizes activations, form submissions, and footnote returns", () => {
    const activation = wire("activation", {
      href: "next.xhtml#here",
      resolvedUrl: "https://book.invalid/next.xhtml#here",
      target: null,
      download: "",
    });
    const footnote = {
      activationId: 7,
      originEvidence: [{ kind: "document-boundary", boundary: "start" }],
    };
    expect(normalizeAgentActivation(event(activation), source)).toEqual({
      ...activation,
      footnote: null,
    });
    // An agent that says nothing about what it did navigated, which is what it always did.
    expect(normalizeAgentActivation(event({ ...activation, footnote }), source)).toEqual({
      ...activation,
      footnote: {
        ...footnote,
        disposition: "navigated",
        referenceRect: null,
        referenceLabel: null,
      },
    });
    const reported = {
      ...footnote,
      disposition: "reported",
      referenceRect: { x: 1, y: 2, width: 3, height: 4 },
      referenceLabel: "2",
    };
    expect(normalizeAgentActivation(event({ ...activation, footnote: reported }), source)).toEqual({
      ...activation,
      footnote: reported,
    });
    expect(
      normalizeAgentActivation(
        event({ ...activation, footnote: { ...reported, referenceRect: { x: 1, y: 2 } } }),
        source,
      ),
    ).toEqual({ ...activation, footnote: { ...reported, referenceRect: null } });
    // A marker is what the publication printed, not a passage smuggled across as one.
    expect(
      normalizeAgentActivation(
        event({ ...activation, footnote: { ...reported, referenceLabel: "x".repeat(9) } }),
        source,
      ),
    ).toEqual({ ...activation, footnote: { ...reported, referenceLabel: null } });
    expect(
      normalizeAgentActivation(event({ ...activation, footnote: { activationId: -1 } }), source),
    ).toEqual({ ...activation, footnote: null });

    const submission = wire("form-submission", {
      action: "https://forms.invalid/submit",
      resolvedUrl: "https://forms.invalid/submit",
      method: "post",
      target: null,
    });
    expect(
      normalizeAgentFormSubmission(
        event({ ...submission, values: "must not cross the protocol boundary" }),
        source,
      ),
    ).toEqual(submission);

    const returned = wire("footnote-returned", { activationId: 7, status: "returned" });
    expect(normalizeAgentFootnoteReturned(event(returned), source)).toEqual(returned);
  });

  it("normalizes revision-bound decoration activation", () => {
    const activation = wire("decoration-activation", {
      projectionRevision: 4,
      ids: ["note", "highlight"],
      anchor,
      link: {
        href: "chapter-2.xhtml",
        resolvedUrl: "https://reader.invalid/book/chapter-2.xhtml",
        target: null,
        download: null,
      },
    });
    const normalize = (data: unknown) =>
      normalizeAgentDecorationActivation(event(data), source, session);
    expect(normalize(activation)).toEqual(activation);
    expect(normalize({ ...activation, ids: [] })).toMatchObject({ ids: [] });
    expect(normalize({ ...activation, ids: ["same", "same"] })).toBeNull();
    expect(normalize({ ...activation, link: { href: 4 } })).toBeNull();
  });
});

describe("agent presentation commands", () => {
  it("builds and normalizes ephemeral active-decoration messages", () => {
    const message = buildAgentSetActiveDecoration(session, 4, "host-id");
    expect(normalizeAgentSetActiveDecoration(message)).toEqual(message);
    expect(normalizeAgentSetActiveDecoration({ ...message, id: "" })).toBeNull();
  });

  it("round-trips narration target commands", () => {
    const active = buildAgentSetMediaOverlayActive(
      session,
      7,
      "c01w00001",
      ["-epub-media-overlay-active"],
      ["playing"],
    );
    expect(normalizeAgentSetMediaOverlayActive({ ...active, extra: true })).toEqual(active);
    const clear = buildAgentSetMediaOverlayActive(session, 8, null, [], []);
    expect(normalizeAgentSetMediaOverlayActive(clear)).toEqual(clear);
    expect(normalizeAgentSetMediaOverlayActive({ ...clear, commandId: -1 })).toBeNull();
  });

  it("rejects unbounded or malformed narration target commands", () => {
    expect(() => buildAgentSetMediaOverlayActive(session, 1, "", [], [])).toThrow(TypeError);
    expect(() => buildAgentSetMediaOverlayActive(session, 1, "a", ["two words"], [])).toThrow(
      TypeError,
    );
    expect(() =>
      buildAgentSetMediaOverlayActive(
        session,
        1,
        "a",
        Array.from({ length: MAX_MEDIA_OVERLAY_CLASS_TOKENS + 1 }, (_, index) => `c${index}`),
        [],
      ),
    ).toThrow(TypeError);
    expect(
      normalizeAgentMediaOverlayActiveApplied(
        event(
          wire("media-overlay-active-applied", {
            commandId: 3,
            status: "rendered",
            visible: false,
          }),
        ),
        source,
      ),
    ).toBeNull();
  });
});

describe("document observation", () => {
  const observation = {
    queries: [
      { id: "marker", selector: "#scripting_support", text: true, styles: ["display"] as const },
      { id: "nested", selector: "p", within: ["iframe"], rect: true, attributes: ["lang"] },
    ],
    resources: true,
    fonts: false,
  };
  const observed = {
    document: {
      title: "scr-support",
      lang: "en",
      dir: "",
      readyState: "complete",
      contentType: "application/xhtml+xml",
      svgRoot: false,
    },
    queries: [
      {
        id: "marker",
        matches: 1,
        first: { text: "This reading system supports scripting.", styles: { display: "block" } },
      },
      { id: "nested", inaccessible: "cross-origin" },
    ],
    resources: [
      {
        kind: "image",
        source: "../images/figure.png",
        state: "loaded",
        naturalWidth: 10,
        naturalHeight: 4,
      },
    ],
  };

  it("builds and normalizes an observation request only in its bounded shape", () => {
    const message = buildAgentRequest(session, 7, { type: "observe-document", observation });
    expect(message.request).toEqual({ type: "observe-document", observation });
    expect(normalizeAgentRequest(message)).toEqual(message);
    for (const [name, invalid] of [
      ["nothing asked", { queries: [], resources: false, fonts: false }],
      [
        "unknown style",
        { ...observation, queries: [{ id: "a", selector: "p", styles: ["cursor"] }] },
      ],
      [
        "duplicate ids",
        {
          ...observation,
          queries: [
            { id: "a", selector: "p" },
            { id: "a", selector: "b" },
          ],
        },
      ],
      ["empty selector", { ...observation, queries: [{ id: "a", selector: "  " }] }],
      [
        "too deep within",
        {
          ...observation,
          queries: [{ id: "a", selector: "p", within: ["i", "i", "i", "i", "i"] }],
        },
      ],
      ["unknown field", { ...observation, queries: [{ id: "a", selector: "p", html: true }] }],
      [
        "bad attribute",
        { ...observation, queries: [{ id: "a", selector: "p", attributes: ["on click"] }] },
      ],
      [
        "too many queries",
        {
          ...observation,
          queries: Array.from({ length: 65 }, (_, i) => ({ id: `q${i}`, selector: "p" })),
        },
      ],
    ] as const) {
      expect(normalizeDocumentObservationRequest(invalid), name).toBeNull();
      expect(
        () =>
          buildAgentRequest(session, 7, {
            type: "observe-document",
            observation: invalid as never,
          }),
        name,
      ).toThrow(TypeError);
    }
  });

  it("normalizes observation results and refuses unbounded or malformed ones", () => {
    expect(normalizeDocumentObservationResult(observed)).toEqual(observed);
    const message = result("observe-document", { observation: observed });
    expect(normalizeAgentDocumentObservationResult(event(message), source, session)).toEqual(
      message,
    );
    expect(
      normalizeAgentDocumentObservationResult(event(message, otherSource), source, session),
    ).toBeNull();
    expect(
      normalizeAgentDocumentObservationResult(event(message), source, "f".repeat(32)),
    ).toBeNull();
    for (const [name, invalid] of [
      [
        "unknown style in result",
        { ...observed, queries: [{ id: "a", matches: 1, first: { styles: { cursor: "auto" } } }] },
      ],
      ["match without first", { ...observed, queries: [{ id: "a", matches: 1, first: null }] }],
      [
        "first without match",
        { ...observed, queries: [{ id: "a", matches: 0, first: { text: "x" } }] },
      ],
      [
        "oversized text",
        { ...observed, queries: [{ id: "a", matches: 1, first: { text: "x".repeat(1025) } }] },
      ],
      [
        "duplicate ids",
        {
          ...observed,
          queries: [
            { id: "a", matches: 0, first: null },
            { id: "a", matches: 0, first: null },
          ],
        },
      ],
      [
        "image with readyState",
        {
          ...observed,
          resources: [{ kind: "image", source: "a", state: "loaded", readyState: 1 }],
        },
      ],
      ["bad ready state", { ...observed, document: { ...observed.document, readyState: "done" } }],
      [
        "aggregate budget",
        {
          ...observed,
          queries: Array.from({ length: 64 }, (_, i) => ({
            id: `q${i}`,
            matches: 1,
            first: { text: "y".repeat(1024) },
          })),
        },
      ],
    ] as const) {
      expect(normalizeDocumentObservationResult(invalid), name).toBeNull();
    }
  });

  it("advertises and cancels the observation operation like any other", () => {
    expect(
      normalizeAgentReady(
        event(ready({ supportedOperations: ["layout", "observe-document"] })),
        source,
        session,
      ),
    ).not.toBeNull();
    expect(buildAgentCancelOperation(session, 3, "observe-document").operationType).toBe(
      "observe-document",
    );
  });
});
