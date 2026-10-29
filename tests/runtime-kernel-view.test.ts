import { describe, expect, it } from "vitest";
import type {
  AdapterLayoutSettlement,
  KernelSnapshot,
  OccurrenceRenditionSetting,
  ReadingOrderOccurrence,
} from "../src/generated/kernel.js";
import {
  currentDocument,
  committedCurrentLocation,
  currentFixedSettlement,
  currentFrame,
  currentObservation,
  currentPaginatedLayout,
  currentReflowSettlement,
  fixedCompanionDocument,
  fixedCompanionFrame,
  fixedCompanionParticipant,
  fixedCompanionSettlement,
  fixedOrientationsCompatible,
  fixedSpreadPlan,
  foregroundLayoutPending,
  occurrenceAliasesResource,
  primaryParticipant,
} from "../src/runtime/kernel-view.js";
import type { PublicationFacts } from "../src/generated/publication.js";

const frame = {
  generation: 3,
  occurrence: 1,
  resource: "EPUB/chapter.xhtml",
  adapter: "reflowable-xhtml",
} as const;

const observation = {
  writingMode: "horizontal-tb",
  direction: "ltr",
  language: "en",
  viewport: { width: 800, height: 600 },
  canvas: { state: "unavailable" },
  visibleStart: { state: "unavailable" },
  visibleEnd: { state: "unavailable" },
  renderedTextProgression: 0.25,
  layoutProgression: null,
  pagination: null,
} as const;

const settlement = {
  adapter: "reflowable-xhtml",
  requested: {} as never,
  mode: "paginated",
  notice: null,
  alignXCenter: false,
  position: { kind: "progression", normalizedProgression: 0.25 },
  settlement: {
    mode: "paginated",
    measurement: { observation } as never,
    pages: {
      spreadStride: 800,
      columnOrigin: 0,
      columnWidth: 384,
      columnGap: 32,
      columnPitch: 416,
      firstVisiblePage: 2,
      pageCount: 10,
      visiblePageCount: 2,
      columnsPerView: 2,
      layoutRepairs: { status: "no-issues-detected" },
    },
  },
} satisfies AdapterLayoutSettlement;

const fixedSettlement = {
  adapter: "fixed-xhtml",
  settlement: {
    mode: "contain",
    measurement: { observation } as never,
    geometry: {
      intrinsicViewport: observation.viewport,
      containingViewport: observation.viewport,
      scale: 1,
      renderedWidth: observation.viewport.width,
      renderedHeight: observation.viewport.height,
      offsetX: 0,
      offsetY: 0,
    },
  },
} satisfies AdapterLayoutSettlement;

function snapshotWithSettlement(value: AdapterLayoutSettlement = settlement): KernelSnapshot {
  const settledFrame =
    value.adapter === "reflowable-xhtml" ? frame : { ...frame, adapter: value.adapter };
  return {
    document: {
      pending: null,
      committed: {
        generation: 7,
        frame: settledFrame,
        supportedOperations: [],
        layout: {
          state: "dirty",
          layout: { documentGeneration: 7, layoutGeneration: 11, settlement: value },
          observation,
          cause: "viewport",
        },
      },
    },
  } as unknown as KernelSnapshot;
}

function fixedSnapshot(
  primary: number,
  count: number,
  options: {
    readonly direction?: "ltr" | "rtl" | "default" | null;
    readonly resources?: readonly string[];
    readonly pageSpreads?: Readonly<Record<number, "left" | "right" | "center" | null>>;
    readonly spread?: "auto" | "both" | "landscape" | "none" | "portrait" | null;
    readonly orientation?: "auto" | "landscape" | "portrait" | null;
    readonly adapters?: readonly ("fixed-xhtml" | "fixed-svg" | "reflowable-xhtml")[];
  } = {},
): KernelSnapshot {
  const readingOrder = Array.from({ length: count }, (_, ordinal) => ({
    ordinal,
    target: { state: "declaration", declaration: ordinal, resource: ordinal },
    selectedDeclaration: ordinal,
    linear: "yes",
    presentation: {
      layout: { state: "unspecified" },
      flow: { state: "unspecified" },
      orientation:
        options.orientation === undefined
          ? { state: "unspecified" }
          : {
              state: "specified",
              value: {
                source: "package-metadata",
                authoredValue: null,
                value: options.orientation,
              },
            },
      spread:
        options.spread === undefined
          ? { state: "unspecified" }
          : {
              state: "specified",
              value: { source: "package-metadata", authoredValue: null, value: options.spread },
            },
      pageSpread:
        ordinal in (options.pageSpreads ?? {})
          ? {
              state: "specified",
              value: {
                source: "item-ref-property",
                authoredValue: null,
                value: options.pageSpreads?.[ordinal] ?? null,
              },
            }
          : { state: "unspecified" },
      pageProgressionDirection: options.direction ?? "ltr",
      alignXCenter: false,
    },
    document: {
      state: "loadable",
      resource: options.resources?.[ordinal] ?? `EPUB/page-${ordinal}.xhtml`,
      adapter: options.adapters?.[ordinal] ?? "fixed-xhtml",
    },
  })) satisfies ReadingOrderOccurrence[];
  const snapshot = snapshotWithSettlement(fixedSettlement);
  snapshot.readingOrder = readingOrder;
  snapshot.document.committed = {
    generation: 7,
    frame: {
      generation: 3,
      occurrence: primary,
      resource:
        readingOrder[primary]!.document.state === "loadable"
          ? readingOrder[primary]!.document.resource
          : "",
      adapter: options.adapters?.[primary] ?? "fixed-xhtml",
    },
    supportedOperations: [],
    layout: {
      state: "settled",
      layout: { documentGeneration: 7, layoutGeneration: 11, settlement: fixedSettlement },
      observation,
    },
  };
  return snapshot;
}

describe("kernel view", () => {
  it("matches original and effective fallback resource aliases", () => {
    const occurrence = {
      ordinal: 0,
      target: { state: "declaration", declaration: 0, resource: 0 },
      selectedDeclaration: 1,
      document: {
        state: "loadable",
        resource: "EPUB/fallback.xhtml",
        adapter: "reflowable-xhtml",
      },
    } as ReadingOrderOccurrence;
    const facts = {
      resources: {
        resources: [
          { address: { kind: "local", value: "EPUB/original.bin" } },
          { address: { kind: "local", value: "EPUB/fallback.xhtml" } },
        ],
      },
    } as PublicationFacts;

    expect(occurrenceAliasesResource(facts, occurrence, "EPUB/original.bin")).toBe(true);
    expect(occurrenceAliasesResource(facts, occurrence, "EPUB/fallback.xhtml")).toBe(true);
    expect(occurrenceAliasesResource(facts, occurrence, "EPUB/other.xhtml")).toBe(false);
  });
  it("selects physical and structural committed state", () => {
    const snapshot = snapshotWithSettlement();

    expect(currentDocument(snapshot)?.generation).toBe(7);
    expect(currentFrame(snapshot)).toBe(frame);
    expect(currentObservation(snapshot)).toBe(observation);
    expect(currentReflowSettlement(snapshot)).toBe(settlement.settlement);
    expect(currentPaginatedLayout(snapshot)?.pageCount).toBe(10);
    expect(primaryParticipant(snapshot)).toEqual({ kind: "primary", documentGeneration: 7 });
  });

  it("derives current location only from a settled primary visible start", () => {
    const snapshot = snapshotWithSettlement();
    const committed = snapshot.document.committed!;
    committed.layout = {
      state: "settled",
      layout: committed.layout.layout,
      observation: {
        ...observation,
        visibleStart: {
          state: "located",
          evidence: [{ kind: "browser-text-position", offset: "12" }],
        },
      },
    };
    snapshot.document.fixedCompanion = {
      ownerDocumentGeneration: 7,
      frame: { ...frame, generation: 4, occurrence: 2 },
      placement: "right",
      supportedOperations: [],
      layout: {
        state: "settled",
        layout: {} as never,
        observation: {
          document: {
            ...observation,
            visibleStart: {
              state: "located",
              evidence: [{ kind: "browser-text-position", offset: "999" }],
            },
          },
        },
      },
    };

    expect(committedCurrentLocation(snapshot)).toEqual({
      location: {
        kind: "point",
        occurrence: 1,
        resource: "EPUB/chapter.xhtml",
        evidence: [{ kind: "browser-text-position", offset: "12" }],
        observation: { layoutProgression: null, renderedTextProgression: 0.25 },
      },
      basis: { documentGeneration: 7, frameGeneration: 3, layoutGeneration: 11 },
    });
    committed.layout = { ...committed.layout, state: "updating" };
    expect(committedCurrentLocation(snapshot)).toBeNull();
  });

  it("uses the visible end when the visible start has no authored point", () => {
    const snapshot = snapshotWithSettlement();
    const committed = snapshot.document.committed!;
    committed.layout = {
      state: "settled",
      layout: committed.layout.layout,
      observation: {
        ...observation,
        visibleEnd: {
          state: "located",
          evidence: [{ kind: "browser-text-position", offset: "24" }],
        },
      },
    };

    expect(committedCurrentLocation(snapshot)?.location.evidence).toEqual([
      { kind: "browser-text-position", offset: "24" },
    ]);
  });

  it("selects a fixed companion without changing primary selectors", () => {
    const snapshot = snapshotWithSettlement();
    const companionFrame = { ...frame, generation: 4, occurrence: 2 };
    snapshot.document.fixedCompanion = {
      ownerDocumentGeneration: 7,
      frame: companionFrame,
      placement: "right",
      supportedOperations: [],
      layout: {} as never,
    };

    expect(currentFrame(snapshot)).toBe(frame);
    expect(fixedCompanionDocument(snapshot)?.placement).toBe("right");
    expect(fixedCompanionFrame(snapshot)).toBe(companionFrame);
    expect(fixedCompanionParticipant(snapshot)).toEqual({
      kind: "fixed-companion",
      ownerDocumentGeneration: 7,
      frameGeneration: 4,
    });
  });

  it("retains and validates a fixed SVG companion settlement adapter", () => {
    const snapshot = fixedSnapshot(0, 2, { adapters: ["fixed-xhtml", "fixed-svg"] });
    const companionFrame = {
      generation: 4,
      occurrence: 1,
      resource: "EPUB/page-1.svg",
      adapter: "fixed-svg",
    } as const;
    const companionSettlement = {
      adapter: "fixed-svg",
      settlement: fixedSettlement.settlement,
    } as const;
    snapshot.document.fixedCompanion = {
      ownerDocumentGeneration: 7,
      frame: companionFrame,
      placement: "right",
      supportedOperations: [],
      layout: {
        state: "settled",
        layout: {
          ownerDocumentGeneration: 7,
          frameGeneration: 4,
          layoutGeneration: 12,
          settlement: companionSettlement,
        },
        observation: { document: observation },
      },
    };

    expect(fixedCompanionSettlement(snapshot)).toBe(companionSettlement);
    snapshot.document.fixedCompanion.layout.layout.settlement = fixedSettlement;
    expect(fixedCompanionSettlement(snapshot)).toBeNull();
  });

  it("uses live page position while retaining settled page count and geometry", () => {
    const snapshot = snapshotWithSettlement();
    const committed = snapshot.document.committed;
    if (committed === null) throw new Error("expected a committed document");
    committed.layout.observation = {
      ...observation,
      pagination: { firstVisiblePage: 6, pageCount: 10, visiblePageCount: 2 },
    };

    expect(currentPaginatedLayout(snapshot)).toEqual({
      ...settlement.settlement.pages,
      firstVisiblePage: 6,
      visiblePageCount: 2,
    });

    committed.layout.observation = {
      ...observation,
      pagination: { firstVisiblePage: 6, pageCount: 12, visiblePageCount: 2 },
    };
    expect(currentPaginatedLayout(snapshot)).toBe(settlement.settlement.pages);
  });

  it("rejects adapter and mode mismatches", () => {
    const scrolling = {
      ...settlement,
      mode: "document-scroll",
      settlement: {
        mode: "document-scroll",
        measurement: { observation } as never,
      },
    } satisfies AdapterLayoutSettlement;

    expect(currentReflowSettlement(snapshotWithSettlement(fixedSettlement))).toBeNull();
    expect(currentFixedSettlement(snapshotWithSettlement(fixedSettlement))).toBe(
      fixedSettlement.settlement,
    );
    expect(
      currentFixedSettlement(
        snapshotWithSettlement({
          ...fixedSettlement,
          adapter: "fixed-svg",
        } satisfies AdapterLayoutSettlement),
      ),
    ).toBe(fixedSettlement.settlement);
    expect(currentPaginatedLayout(snapshotWithSettlement(scrolling))).toBeNull();
  });

  it("distinguishes foreground layout from prepared-frame work", () => {
    const snapshot = snapshotWithSettlement();
    snapshot.layout = {
      ...snapshot.layout,
      pending: {
        operation: 13,
        frameGeneration: 4,
        layoutGeneration: 12,
        owner: { kind: "prepared-frame" },
        adapter: {} as never,
      },
    };
    expect(foregroundLayoutPending(snapshot)).toBe(false);

    const preparedPending = snapshot.layout.pending;
    if (preparedPending === null) throw new Error("expected pending prepared layout");
    snapshot.layout.pending = {
      ...preparedPending,
      owner: { kind: "document", documentGeneration: 7, phase: "update" },
    };
    expect(foregroundLayoutPending(snapshot)).toBe(true);
  });

  it("plans LTR and RTL fixed pairs from occurrence order", () => {
    expect(fixedSpreadPlan(fixedSnapshot(1, 5), 1, 1200, 800)).toMatchObject({
      primaryOccurrence: 1,
      primaryPlacement: "left",
      companionOccurrence: 2,
      companionPlacement: "right",
      direction: "ltr",
    });
    expect(fixedSpreadPlan(fixedSnapshot(1, 5, { direction: "rtl" }), 1, 1200, 800)).toMatchObject({
      primaryPlacement: "right",
      companionOccurrence: 2,
      companionPlacement: "left",
      direction: "rtl",
    });
  });

  it("pairs an authored reflowable page spread and leaves unauthored reflowables full width", () => {
    const snapshot = fixedSnapshot(1, 5, {
      adapters: [
        "fixed-xhtml",
        "reflowable-xhtml",
        "fixed-xhtml",
        "reflowable-xhtml",
        "fixed-xhtml",
      ],
      pageSpreads: { 1: "left", 4: "left" },
    });
    expect(fixedSpreadPlan(snapshot, 1, 1200, 800)).toMatchObject({
      primaryPlacement: "left",
      centered: null,
      companionOccurrence: 2,
      companionPlacement: "right",
    });
    expect(fixedSpreadPlan(snapshot, 3, 1200, 800)).toMatchObject({
      primaryPlacement: "center",
      centered: "spread-ineligible",
      companionOccurrence: null,
    });
    expect(fixedSpreadPlan(snapshot, 4, 1200, 800)).toMatchObject({
      primaryPlacement: "left",
      centered: null,
      companionOccurrence: null,
    });
  });

  it.each(["ltr", "rtl"] as const)(
    "uses first recognized itemref overrides for %s fixed spreads",
    (direction) => {
      const snapshot = fixedSnapshot(0, 2, { direction });
      const candidates = <T>(
        values: readonly (readonly [string, T | null])[],
      ): OccurrenceRenditionSetting<T> => ({
        state: "ambiguous",
        value: values.map(([authoredValue, value]) => ({
          source: "item-ref-property",
          authoredValue,
          value,
        })),
      });
      for (const [index, occurrence] of snapshot.readingOrder.entries()) {
        const side = (index === 0) === (direction === "ltr") ? "left" : "right";
        const opposite = side === "left" ? "right" : "left";
        occurrence.presentation.pageSpread = candidates([
          ["page-spread-unknown", null],
          ["rendition:page-spread-unknown", null],
          [`${index === 0 ? "" : "rendition:"}page-spread-${side}`, side],
          [`${index === 0 ? "rendition:" : ""}page-spread-${opposite}`, opposite],
        ]);
        occurrence.presentation.spread = candidates([
          ["rendition:spread-unknown", null],
          ["rendition:spread-both", "both"],
          ["rendition:spread-none", "none"],
        ]);
        occurrence.presentation.orientation = candidates([
          ["rendition:orientation-unknown", null],
          ["rendition:orientation-portrait", "portrait"],
          ["rendition:orientation-landscape", "landscape"],
        ]);
      }
      const evidence = structuredClone(snapshot.readingOrder);
      expect(fixedSpreadPlan(snapshot, 0, 800, 1200)).toMatchObject({
        primaryPlacement: direction === "ltr" ? "left" : "right",
        companionPlacement: direction === "ltr" ? "right" : "left",
        companionOccurrence: 1,
        centered: null,
      });
      expect(snapshot.readingOrder).toEqual(evidence);
      const spread = snapshot.readingOrder[0]!.presentation.spread;
      if (spread.state !== "ambiguous") throw new Error("expected authored ambiguity");
      spread.value.reverse();
      expect(fixedSpreadPlan(snapshot, 0, 800, 1200)).toMatchObject({
        centered: "spread-ineligible",
      });
    },
  );

  it.each(["spread", "orientation"] as const)(
    "does not choose the first ambiguous package %s",
    (field) => {
      const snapshot = fixedSnapshot(1, 3);
      snapshot.readingOrder[1]!.presentation[field] = {
        state: "ambiguous",
        value: ["auto", "auto"].map(() => ({
          source: "package-metadata",
          authoredValue: "auto",
          value: "auto",
        })),
      };
      expect(fixedSpreadPlan(snapshot, 1, 1200, 800)).toMatchObject({
        centered: "spread-ineligible",
        companionOccurrence: null,
      });
    },
  );

  it("pairs a trailing reflowable page with the fixed page before it from either side", () => {
    const rtl = fixedSnapshot(0, 2, {
      direction: "rtl",
      adapters: ["fixed-xhtml", "reflowable-xhtml"],
      pageSpreads: { 0: "right", 1: "left" },
    });
    expect(fixedSpreadPlan(rtl, 0, 1200, 800)).toMatchObject({
      primaryPlacement: "right",
      centered: null,
      companionOccurrence: 1,
      companionPlacement: "left",
    });
    expect(fixedSpreadPlan(rtl, 1, 1200, 800)).toMatchObject({
      primaryPlacement: "left",
      centered: null,
      companionOccurrence: 0,
      companionPlacement: "right",
    });
  });

  it("keeps a complementary preceding fixed page available for backward entry", () => {
    const snapshot = fixedSnapshot(11, 13, { direction: "rtl" });
    snapshot.readingOrder[12]!.document = {
      state: "loadable",
      resource: "EPUB/about.xhtml",
      adapter: "reflowable-xhtml",
    };

    const primary = fixedSpreadPlan(snapshot, 11, 1200, 800);
    const preceding = fixedSpreadPlan(snapshot, 10, 1200, 800);

    expect(primary).toMatchObject({
      primaryOccurrence: 11,
      primaryPlacement: "right",
      companionOccurrence: null,
      direction: "rtl",
    });
    expect(preceding).toMatchObject({
      primaryOccurrence: 10,
      primaryPlacement: "left",
      centered: null,
      direction: "rtl",
    });
  });

  it("plans every exact fixed XHTML and SVG companion combination", () => {
    for (const adapters of [
      ["fixed-xhtml", "fixed-xhtml"],
      ["fixed-xhtml", "fixed-svg"],
      ["fixed-svg", "fixed-xhtml"],
      ["fixed-svg", "fixed-svg"],
    ] as const) {
      expect(
        fixedSpreadPlan(
          fixedSnapshot(0, 2, { adapters, pageSpreads: { 0: "left" } }),
          0,
          1200,
          800,
        ),
      ).toMatchObject({
        primaryOccurrence: 0,
        primaryPlacement: "left",
        companionOccurrence: 1,
        companionPlacement: "right",
      });
    }
  });

  it("keeps standalone first, final leading, and center-reset pages unpaired", () => {
    expect(fixedSpreadPlan(fixedSnapshot(0, 5), 0, 1200, 800)).toMatchObject({
      primaryPlacement: "right",
      companionOccurrence: null,
    });
    expect(fixedSpreadPlan(fixedSnapshot(4, 5), 4, 1200, 800)).toMatchObject({
      primaryOccurrence: 4,
      companionOccurrence: 3,
    });
    expect(fixedSpreadPlan(fixedSnapshot(3, 4), 3, 1200, 800)).toMatchObject({
      primaryPlacement: "left",
      companionOccurrence: null,
    });
    const centered = { pageSpreads: { 1: "center" as const } };
    expect(fixedSpreadPlan(fixedSnapshot(1, 6, centered), 1, 1200, 800)).toMatchObject({
      primaryPlacement: "center",
      centered: "page-spread-center",
    });
    expect(fixedSpreadPlan(fixedSnapshot(2, 6, centered), 2, 1200, 800)).toMatchObject({
      primaryPlacement: "right",
      companionOccurrence: null,
    });
    expect(fixedSpreadPlan(fixedSnapshot(3, 6, centered), 3, 1200, 800)).toMatchObject({
      primaryOccurrence: 3,
      companionOccurrence: 4,
    });
  });

  it("uses explicit sides as resets and rejects an incompatible authored candidate side", () => {
    expect(
      fixedSpreadPlan(fixedSnapshot(0, 3, { pageSpreads: { 0: "left" } }), 0, 1200, 800),
    ).toMatchObject({ primaryPlacement: "left", companionOccurrence: 1 });
    expect(
      fixedSpreadPlan(fixedSnapshot(0, 3, { pageSpreads: { 0: "left", 1: "left" } }), 0, 1200, 800),
    ).toMatchObject({ primaryPlacement: "left", companionOccurrence: null });
    expect(
      fixedSpreadPlan(fixedSnapshot(1, 4, { pageSpreads: { 0: null } }), 1, 1200, 800),
    ).toMatchObject({ primaryPlacement: "center", centered: "spread-ineligible" });
  });

  it("applies spread and orientation eligibility without guessing unsupported values", () => {
    expect(fixedSpreadPlan(fixedSnapshot(1, 4), 1, 800, 1200)).toMatchObject({
      primaryPlacement: "center",
      centered: "spread-ineligible",
      companionOccurrence: null,
    });
    expect(
      fixedSpreadPlan(fixedSnapshot(1, 4, { spread: "portrait" }), 1, 800, 1200),
    ).toMatchObject({
      primaryPlacement: "left",
      companionOccurrence: 2,
    });
    const orientationMismatch = fixedSnapshot(1, 4, {
      spread: "both",
      orientation: "portrait",
    });
    expect(fixedSpreadPlan(orientationMismatch, 1, 1200, 800)).toMatchObject({
      companionOccurrence: 2,
    });
    orientationMismatch.readingOrder[2]!.presentation.orientation = {
      state: "specified",
      value: { source: "package-metadata", authoredValue: null, value: "landscape" },
    };
    expect(fixedSpreadPlan(orientationMismatch, 1, 1200, 800)).toMatchObject({
      companionOccurrence: null,
    });
    expect(fixedSpreadPlan(fixedSnapshot(1, 4, { spread: null }), 1, 1200, 800)).toMatchObject({
      primaryPlacement: "center",
    });
    expect(fixedSpreadPlan(fixedSnapshot(1, 4, { orientation: null }), 1, 1200, 800)).toMatchObject(
      { primaryPlacement: "center" },
    );
    expect(
      fixedOrientationsCompatible(
        orientationMismatch.readingOrder[1]!,
        orientationMismatch.readingOrder[2]!,
      ),
    ).toBe(false);
  });

  it("restores the same fixed pair after repeated orientation eligibility changes", () => {
    const snapshot = fixedSnapshot(1, 4, { direction: "rtl" });
    const sizes = [
      [800, 1200],
      [1200, 800],
      [800, 1200],
      [1200, 800],
    ] as const;

    expect(
      sizes.map(
        ([width, height]) => fixedSpreadPlan(snapshot, 1, width, height)?.companionOccurrence,
      ),
    ).toEqual([null, 2, null, 2]);
  });

  it("pairs duplicate resources by occurrence identity", () => {
    const plan = fixedSpreadPlan(
      fixedSnapshot(1, 4, { resources: ["same.xhtml", "same.xhtml", "same.xhtml", "same.xhtml"] }),
      1,
      1200,
      800,
    );
    expect(plan).toMatchObject({ primaryOccurrence: 1, companionOccurrence: 2 });
  });
});
