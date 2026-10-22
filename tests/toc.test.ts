import { describe, expect, it } from "vitest";
import type { NavigationTarget, PublicationFacts } from "../src/generated/publication";
import {
  type AuthoredNavigationPoint,
  type AuthoredNavigationProjection,
  authoredPageContextTargets,
  authoredPagePredecessorLabel,
  authoredPageRangeAtPages,
  currentAuthoredPageRange,
  currentSectionLabel,
  joinTableOfContents,
  projectAuthoredNavigation,
  tocPointOccurrence,
} from "../src/react/navigation/model";

const target = (
  overrides: Partial<Extract<NavigationTarget, { state: "resource" }>> = {},
): Extract<NavigationTarget, { state: "resource" }> => ({
  state: "resource",
  resource: 0,
  fragment: "part-two",
  ...overrides,
});

function facts(): PublicationFacts {
  const child = {
    label: null,
    authoredHref: null,
    children: [],
    hidden: false,
    semantic: null,
    authoredSemanticTokens: [],
  };
  const point = {
    label: "Chapter",
    authoredHref: "chapter.xhtml#part-two",
    children: [child],
    hidden: false,
    semantic: null,
    authoredSemanticTokens: [],
  };
  return {
    package: {} as PublicationFacts["package"],
    navigation: {
      source: "epub-nav",
      authoredBase: null,
      path: "EPUB/nav.xhtml",
      lists: [
        {
          semantic: "landmarks",
          heading: null,
          hidden: false,
          points: [],
          authoredSemanticTokens: [],
        },
        {
          semantic: "toc",
          heading: null,
          hidden: false,
          points: [point],
          authoredSemanticTokens: [],
        },
      ],
    },
    resources: {
      resources: [
        {
          address: { kind: "local", value: "EPUB/chapter.xhtml" },
          presence: { state: "present", sizeBytes: null },
          declarations: [0],
          hasXhtmlDeclaration: true,
          hasStylesheetDeclaration: false,
          hasSvgDeclaration: false,
          scripted: false,
        },
      ],
      packagePath: "EPUB/package.opf",
      coverPath: null,
      declarations: [],
      readingOrder: [0, 1].map(() => ({
        idref: "chapter",
        target: { state: "declaration", value: 0 },
        resource: 0,
        linear: "yes" as const,
        presentation: {} as PublicationFacts["resources"]["readingOrder"][number]["presentation"],
      })),
      selections: {},
    },
    navigationLoading: {} as PublicationFacts["navigationLoading"],
    navigationTargets: [
      {
        listIndex: 1,
        pointPath: [0],
        authoredHref: "chapter.xhtml#part-two",
        target: target(),
      },
      {
        listIndex: 1,
        pointPath: [0, 0],
        authoredHref: null,
        target: { state: "missing-href" },
      },
    ],
  };
}

function authoredPoint(
  label: string | null,
  options: {
    readonly children?: readonly AuthoredNavigationPoint[];
    readonly fragment?: string | null;
    readonly hidden?: boolean;
    readonly occurrences?: readonly number[];
    readonly pointPath?: readonly number[];
    readonly resource?: string | null;
  } = {},
): AuthoredNavigationPoint {
  return {
    listIndex: 0,
    pointPath: options.pointPath ?? [],
    point: {
      label,
      authoredHref: null,
      children: [],
      hidden: options.hidden ?? false,
      semantic: null,
      authoredSemanticTokens: [],
    },
    target: target({ fragment: options.fragment ?? null }),
    resource: options.resource === undefined ? "EPUB/chapter.xhtml" : options.resource,
    occurrences: options.occurrences ?? [1],
    navigationOccurrence: options.occurrences?.[0] ?? 1,
    children: options.children ?? [],
  };
}

function navigation(
  ...sources: readonly (readonly AuthoredNavigationPoint[])[]
): AuthoredNavigationProjection {
  return {
    contents: sources.map((points, listIndex) => ({
      listIndex,
      list: {
        semantic: "toc",
      } as AuthoredNavigationProjection["contents"][number]["list"],
      points,
    })),
    pages: [],
    landmarks: [],
  };
}

function pageNavigation(
  ...sources: readonly (readonly AuthoredNavigationPoint[])[]
): AuthoredNavigationProjection {
  return {
    contents: [],
    pages: sources.map((points, listIndex) => ({
      listIndex,
      list: {
        semantic: "page-list",
      } as AuthoredNavigationProjection["pages"][number]["list"],
      points,
    })),
    landmarks: [],
  };
}

describe("joinTableOfContents", () => {
  it("joins the existing TOC hierarchy to separately resolved targets", () => {
    const toc = joinTableOfContents(facts());

    expect(toc?.list.semantic).toBe("toc");
    expect(tocPointOccurrence(toc!.points[0]!)).toBe(0);
    expect(toc?.points[0]).toMatchObject({
      point: { label: "Chapter", authoredHref: "chapter.xhtml#part-two" },
      target: { state: "resource", fragment: "part-two" },
      resource: "EPUB/chapter.xhtml",
      occurrences: [0, 1],
      children: [{ target: { state: "missing-href" }, resource: null, occurrences: [] }],
    });
  });

  it.each([
    { linear: ["no", "yes", "yes"], expected: 1 },
    { linear: ["no", "no", "no"], expected: 0 },
  ] as const)("selects $expected for $linear", ({ linear, expected }) => {
    const value = facts();
    value.package.spine = {
      id: null,
      toc: null,
      pageProgressionDirection: null,
      itemrefs: linear.map((linear) => ({
        id: null,
        idref: "chapter",
        linear,
        properties: [],
      })),
    };
    value.resources.readingOrder.push({ ...value.resources.readingOrder[0]! });
    const point = projectAuthoredNavigation(value).contents[0]!.points[0]!;
    expect(tocPointOccurrence(point)).toBe(expected);
    expect(point.occurrences).toEqual([0, 1, 2]);
  });

  it.each([
    { state: "missing-href" },
    { state: "invalid" },
    { state: "missing-resource", path: "EPUB/missing.xhtml", fragment: null },
    {
      state: "unindexed-address",
      address: { kind: "remote", value: "https://example.invalid/chapter" },
      fragment: null,
    },
  ])("preserves an unavailable target without making it actionable", (unavailable) => {
    const value = facts();
    value.navigationTargets[0]!.target =
      unavailable as (typeof value.navigationTargets)[0]["target"];

    const point = joinTableOfContents(value)!.points[0]!;
    expect(point.target).toEqual(unavailable);
    expect(point.occurrences).toEqual([]);
    expect(tocPointOccurrence(point)).toBeNull();
  });

  it("returns no TOC when the selected navigation has no TOC list", () => {
    const value = facts();
    value.navigation!.lists[1]!.semantic = "landmarks";
    expect(joinTableOfContents(value)).toBeNull();
  });
});

describe("projectAuthoredNavigation", () => {
  it("groups every semantic list in authored order without flattening its hierarchy", () => {
    const value = facts();
    const chapter = value.navigation!.lists[1]!.points[0]!;
    value.navigation!.lists = [
      {
        semantic: "toc",
        heading: { level: 1, text: "Short contents" },
        hidden: false,
        points: [],
        authoredSemanticTokens: [],
      },
      ...value.navigation!.lists,
      {
        semantic: "page-list",
        heading: { level: 2, text: "Pages" },
        hidden: false,
        points: [chapter],
        authoredSemanticTokens: [],
      },
      {
        semantic: "toc",
        heading: { level: 2, text: "Detailed contents" },
        hidden: false,
        points: [chapter],
        authoredSemanticTokens: [],
      },
    ];
    value.navigation!.lists[1]!.points = [chapter];
    value.navigationTargets = [
      { ...value.navigationTargets[0]!, listIndex: 1 },
      { ...value.navigationTargets[1]!, listIndex: 1 },
      { ...value.navigationTargets[0]!, listIndex: 3 },
      { ...value.navigationTargets[1]!, listIndex: 3 },
      { ...value.navigationTargets[0]!, listIndex: 4 },
      { ...value.navigationTargets[1]!, listIndex: 4 },
    ];

    const navigation = projectAuthoredNavigation(value);

    expect(
      navigation.contents.map(({ listIndex, list }) => [listIndex, list.heading?.text]),
    ).toEqual([
      [0, "Short contents"],
      [2, undefined],
      [4, "Detailed contents"],
    ]);
    expect(navigation.pages).toHaveLength(1);
    expect(navigation.pages[0]).toMatchObject({
      listIndex: 3,
      list: { semantic: "page-list", heading: { text: "Pages" } },
      points: [
        {
          listIndex: 3,
          pointPath: [0],
          target: { state: "resource" },
          resource: "EPUB/chapter.xhtml",
          occurrences: [0, 1],
          children: [{ pointPath: [0, 0], target: { state: "missing-href" } }],
        },
      ],
    });
    expect(navigation.landmarks[0]).toMatchObject({
      listIndex: 1,
      list: { semantic: "landmarks" },
      points: [
        {
          listIndex: 1,
          pointPath: [0],
          target: { state: "resource" },
          resource: "EPUB/chapter.xhtml",
          occurrences: [0, 1],
          children: [{ pointPath: [0, 0], target: { state: "missing-href" } }],
        },
      ],
    });
  });

  it("returns empty semantic groups when no navigation document is available", () => {
    const value = facts();
    value.navigation = null;

    expect(projectAuthoredNavigation(value)).toEqual({
      contents: [],
      pages: [],
      landmarks: [],
    });
  });
});

describe("currentSectionLabel", () => {
  it("reports that the section is preparing before a document is committed", () => {
    expect(currentSectionLabel(navigation([authoredPoint("Chapter")]), null, 3)).toBe(
      "Preparing section",
    );
  });

  it("selects the deepest match and preserves authored order for depth ties", () => {
    const projection = navigation(
      [
        authoredPoint("Earlier root"),
        authoredPoint("Parent", {
          children: [authoredPoint("Deep first"), authoredPoint("Deep second")],
        }),
      ],
      [
        authoredPoint("Ignored later source", {
          children: [authoredPoint("Still ignored")],
        }),
      ],
    );

    expect(
      currentSectionLabel(projection, { occurrence: 1, resource: "EPUB/chapter.xhtml" }, 3),
    ).toBe("Deep first");
  });

  it("includes hidden subtrees but ignores fragment targets and nonmatching identities", () => {
    const projection = navigation([
      authoredPoint("Fragment", { fragment: "part-two" }),
      authoredPoint("Hidden", {
        hidden: true,
        children: [authoredPoint("Hidden child")],
      }),
      authoredPoint("Other occurrence", { occurrences: [0] }),
      authoredPoint("Other resource", { resource: "EPUB/other.xhtml" }),
      authoredPoint("   "),
    ]);

    expect(
      currentSectionLabel(projection, { occurrence: 1, resource: "EPUB/chapter.xhtml" }, 4),
    ).toBe("Hidden child");
  });

  it("falls back to reading-order position when no authored point matches", () => {
    expect(
      currentSectionLabel(navigation(), { occurrence: 2, resource: "EPUB/third.xhtml" }, 5),
    ).toBe("Section 3 of 5");
  });
});

describe("currentAuthoredPageRange", () => {
  it("returns the authored page at the logical start of a fixed spread", () => {
    const projection = pageNavigation([
      authoredPoint("37", { occurrences: [1] }),
      authoredPoint("38", {
        occurrences: [2],
        resource: "EPUB/chapter-2.xhtml",
      }),
    ]);

    expect(currentAuthoredPageRange(projection, 1, null)).toEqual({
      first: "37",
      last: "37",
    });
    expect(
      currentAuthoredPageRange(projection, 1, {
        firstOccurrence: 1,
        lastOccurrence: 2,
      }),
    ).toEqual({ first: "37", last: "37" });
  });

  it("allows hidden document targets to contribute authored page context", () => {
    const projection = pageNavigation([authoredPoint("xii", { hidden: true })]);

    expect(currentAuthoredPageRange(projection, 1, null)).toEqual({
      first: "xii",
      last: "xii",
    });
  });

  it("falls back when the authored page context is not unambiguous", () => {
    expect(
      currentAuthoredPageRange(pageNavigation([authoredPoint("37"), authoredPoint("38")]), 1, null),
    ).toBeNull();
    expect(
      currentAuthoredPageRange(
        pageNavigation([authoredPoint("37", { fragment: "page-37" })]),
        1,
        null,
      ),
    ).toBeNull();
    expect(currentAuthoredPageRange(pageNavigation([authoredPoint("   ")]), 1, null)).toBeNull();
    expect(
      currentAuthoredPageRange(
        pageNavigation([authoredPoint("37")], [authoredPoint("Thirty-seven")]),
        1,
        null,
      ),
    ).toBeNull();
    expect(currentAuthoredPageRange(pageNavigation([authoredPoint("37")]), null, null)).toBeNull();
  });
});

describe("authored page-list live context", () => {
  it("projects current-occurrence fragments and maps measured identities back to labels", () => {
    const projection = pageNavigation([
      authoredPoint("37", { fragment: "page_37", pointPath: [0] }),
      authoredPoint("38", { fragment: "page_38", pointPath: [1] }),
      authoredPoint("Other occurrence", {
        fragment: "page_39",
        occurrences: [2],
        pointPath: [2],
      }),
    ]);

    const targets = authoredPageContextTargets(projection, 1);
    expect(targets).toEqual([
      {
        request: {
          listIndex: 0,
          pointPath: [0],
          evidence: [{ kind: "html-fragment", value: "page_37" }],
        },
        label: "37",
      },
      {
        request: {
          listIndex: 0,
          pointPath: [1],
          evidence: [{ kind: "html-fragment", value: "page_38" }],
        },
        label: "38",
      },
    ]);
    const positions = [
      { listIndex: 0, pointPath: [0], physicalPage: 0 },
      { listIndex: 0, pointPath: [1], physicalPage: 2 },
    ];
    for (const [first, last, expected] of [
      [0, 0, { first: "37", last: "37" }],
      [1, 1, { first: "37", last: "37" }],
      [1, 2, { first: "37", last: "38" }],
      [3, 3, { first: "38", last: "38" }],
    ] as const) {
      expect(authoredPageRangeAtPages(targets, positions, { first, last })).toEqual(expected);
    }
    expect(authoredPageRangeAtPages(targets, [positions[1]!], { first: 0, last: 0 })).toBeNull();
  });

  it("carries the preceding authored page through a document prefix", () => {
    const projection = pageNavigation([
      authoredPoint("xi", {
        fragment: "page_xi",
        occurrences: [0],
        pointPath: [0],
      }),
      authoredPoint("1", {
        fragment: "page_1",
        occurrences: [1],
        pointPath: [1],
      }),
      authoredPoint("2", {
        fragment: "page_2",
        occurrences: [1],
        pointPath: [2],
      }),
    ]);
    const targets = authoredPageContextTargets(projection, 1);

    expect(authoredPagePredecessorLabel(projection, 1)).toBe("xi");
    const positions = [
      { listIndex: 0, pointPath: [1], physicalPage: 2 },
      { listIndex: 0, pointPath: [2], physicalPage: 5 },
    ];
    expect(authoredPageRangeAtPages(targets, positions, { first: 0, last: 0 }, "xi")).toEqual({
      first: "xi",
      last: "xi",
    });
    expect(authoredPageRangeAtPages(targets, positions, { first: 1, last: 2 }, "xi")).toEqual({
      first: "xi",
      last: "1",
    });
    expect(authoredPageRangeAtPages(targets, positions, { first: 0, last: 0 })).toBeNull();
    expect(authoredPageRangeAtPages(targets, [], { first: 4, last: 4 }, "xi")).toEqual({
      first: "xi",
      last: "xi",
    });
  });
});
