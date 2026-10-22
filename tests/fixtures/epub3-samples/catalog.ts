export type CompatibilityOutcome = "supported" | "degraded" | "unavailable" | "unsupported";

export interface CorpusScenario {
  readonly id: string;
  readonly kind: "reflowable" | "fixed-xhtml" | "fixed-svg";
  readonly occurrence: number;
  readonly resource: string;
  readonly expectedOutcome: CompatibilityOutcome;
  readonly expectedReason: string | null;
  readonly writingMode?: "horizontal-tb" | "vertical-rl" | "vertical-lr";
  readonly direction?: "ltr" | "rtl";
  readonly language?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
}

export interface CorpusExpectedOutcome {
  readonly outcome: CompatibilityOutcome;
  readonly reason: string | null;
}

export interface CorpusPublication {
  readonly id: string;
  readonly title: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly blake3: string;
  readonly packagePath: string;
  readonly readingOrderLength: number;
  readonly exactResource: { readonly path: string; readonly includes: string };
  readonly scenarios: readonly CorpusScenario[];
}

export const corpusPublications = [
  {
    id: "accessible-epub-3",
    title: "Accessible EPUB 3",
    fileName: "accessible_epub_3.epub",
    sha256: "67f75b8e3cd1abe4bb143d91d5424191d5af3115c9d26ff029a38e19f8d16feb",
    blake3: "828bcbd7d6dc8449aa1e118076d432305b314d6a516d0365551511c20e04f719",
    packagePath: "EPUB/package.opf",
    readingOrderLength: 22,
    exactResource: { path: "EPUB/cover.xhtml", includes: "9781449328030" },
    scenarios: [
      {
        id: "accessible-epub-3.image-cover",
        kind: "reflowable",
        occurrence: 0,
        resource: "EPUB/cover.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        writingMode: "horizontal-tb",
        direction: "ltr",
        language: "en",
      },
      {
        id: "accessible-epub-3.reflowable",
        kind: "reflowable",
        occurrence: 2,
        resource: "EPUB/index.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        writingMode: "horizontal-tb",
        direction: "ltr",
        language: "en",
      },
      {
        id: "accessible-epub-3.navigation-semantics",
        kind: "reflowable",
        occurrence: 3,
        resource: "EPUB/bk01-toc.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        writingMode: "horizontal-tb",
        direction: "ltr",
        language: "en",
      },
    ],
  },
  {
    id: "voyage-of-life",
    title: "Thomas Cole - The Voyage of Life",
    fileName: "cole-voyage-of-life.epub",
    sha256: "e38ed606ff604e638f737efaf66e0fd0b2997c3eab7432bcba9a00a81a925cf3",
    blake3: "275ee5db714c2c338b3fd373e476831ec9fe7d09e1ffb2a3fc526be8192d18e9",
    packagePath: "EPUB/cole.opf",
    readingOrderLength: 10,
    exactResource: { path: "EPUB/xhtml/0-intro.xhtml", includes: "Voyage of Life" },
    scenarios: [
      {
        id: "voyage-of-life.mixed-fixed",
        kind: "fixed-xhtml",
        occurrence: 2,
        resource: "EPUB/xhtml/1b-childhood-painting.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        viewport: { width: 1024, height: 697 },
      },
    ],
  },
  {
    id: "georgia-cfi",
    title: "Georgia",
    fileName: "georgia-cfi.epub",
    sha256: "85d17e1ee1d39d3e9f59ee959e92a808456c5c371036cba560634c01292c5e06",
    blake3: "368b6c7d26984941486fc36d377ee21c0720119ee93b5d3a12da13aa7244e8bb",
    packagePath: "EPUB/package.opf",
    readingOrderLength: 2,
    exactResource: { path: "EPUB/nav.xhtml", includes: "epubcfi(" },
    scenarios: [
      {
        id: "georgia-cfi.reflowable",
        kind: "reflowable",
        occurrence: 1,
        resource: "EPUB/georgia.xhtml",
        expectedOutcome: "degraded",
        expectedReason: "cfi-dom-resolution-unsupported",
        writingMode: "horizontal-tb",
        direction: "ltr",
        language: "en-US",
      },
    ],
  },
  {
    id: "haruko",
    title: "Haruko",
    fileName: "haruko-html-jpeg.epub",
    sha256: "87b5eaff288e238864d817ea54b4600dc8c6f96789d0efb946b8545d7ad2f0c0",
    blake3: "84da1ebee81f57a40798191ac53db90fee220fa39b0e005358db58b9c8656913",
    packagePath: "OPS/package.opf",
    readingOrderLength: 13,
    exactResource: { path: "OPS/xhtml/p01.xhtml", includes: "images/01.jpg" },
    scenarios: [
      {
        id: "haruko.fixed-manga",
        kind: "fixed-xhtml",
        occurrence: 0,
        resource: "OPS/xhtml/p01.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        viewport: { width: 600, height: 837 },
      },
      {
        id: "haruko.fixed-spread",
        kind: "fixed-xhtml",
        occurrence: 1,
        resource: "OPS/xhtml/p02.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        viewport: { width: 600, height: 837 },
      },
      {
        id: "haruko.reflowable-about",
        kind: "reflowable",
        occurrence: 12,
        resource: "OPS/xhtml/AboutThisDocument.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        writingMode: "horizontal-tb",
        direction: "ltr",
        language: "ja",
      },
    ],
  },
  {
    id: "internal-links",
    title: "Internal Links",
    fileName: "internallinks.epub",
    sha256: "deaf03a1843f52cc5e4cedb226ca8659610efe1be5e810fccf615bcb549238aa",
    blake3: "5c307bd9cb938b82a8a5871b048f45c2016e4110f33dfabe6ab4108dae4daee1",
    packagePath: "OEBPS/package.opf",
    readingOrderLength: 7,
    exactResource: { path: "OEBPS/0001.xhtml", includes: "xnotes.xhtml" },
    scenarios: [
      {
        id: "internal-links.navigation",
        kind: "reflowable",
        occurrence: 1,
        resource: "OEBPS/0001.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        writingMode: "horizontal-tb",
        direction: "ltr",
        language: "ja",
      },
    ],
  },
  {
    id: "moby-dick-media-overlays",
    title: "Moby-Dick",
    fileName: "moby-dick-mo.epub",
    sha256: "749a9de094c26bc79351722a2bf320845dc5f6af2d5bf41a96d720d723b29a4c",
    blake3: "87ef7250f3e67b6425442d36a97e6b55a8f5799498fc7daa92d290bb1f1d56c0",
    packagePath: "OPS/package.opf",
    readingOrderLength: 144,
    exactResource: { path: "OPS/chapter_001_overlay.smil", includes: "mobydick_001_002" },
    scenarios: [
      {
        id: "moby-dick-media-overlays.chapter",
        kind: "reflowable",
        occurrence: 6,
        resource: "OPS/chapter_001.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        writingMode: "horizontal-tb",
        direction: "ltr",
      },
      {
        id: "moby-dick-media-overlays.chapter-2",
        kind: "reflowable",
        occurrence: 7,
        resource: "OPS/chapter_002.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        writingMode: "horizontal-tb",
        direction: "ltr",
      },
    ],
  },
  {
    id: "vertical-writing",
    title: "Vertical Writing",
    fileName: "mymedia_lite.epub",
    sha256: "6623732b1aa7cefed26e2db95f7ac14c80360b99d328ed927b93548a96990c62",
    blake3: "c710cb1a894d306b0824b136a5079342e1634822ac2bb33fdb72bea2fe0c81ad",
    packagePath: "OEBPS/mymedia_lite.opf",
    readingOrderLength: 7,
    exactResource: { path: "OEBPS/styles/ebook_style_v.css", includes: "vertical-rl" },
    scenarios: [
      {
        id: "vertical-writing.layout",
        kind: "reflowable",
        occurrence: 1,
        resource: "OEBPS/text/book_0001.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        writingMode: "vertical-rl",
        direction: "ltr",
        language: "ja",
      },
    ],
  },
  {
    id: "page-blanche",
    title: "Page Blanche",
    fileName: "page-blanche.epub",
    sha256: "d2efb562f17d43cef50578d4d67dd7fd991f8f254b6f5a7c28bde7461ea783eb",
    blake3: "2e874f7657da42b30aa9f93a05f3f4a8c4a7bebfad03e55741d4655e3811a95b",
    packagePath: "EPUB/package.opf",
    readingOrderLength: 10,
    exactResource: { path: "EPUB/Content/cover.xhtml", includes: "cover.jpg" },
    scenarios: [
      {
        id: "page-blanche.fixed-layout",
        kind: "fixed-xhtml",
        occurrence: 0,
        resource: "EPUB/Content/cover.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        viewport: { width: 1200, height: 1577 },
      },
    ],
  },
  {
    id: "arabic",
    title: "Regime Anti-Cancer Arabic",
    fileName: "regime-anticancer-arabic.epub",
    sha256: "5d10bf6a73f461b7b23294b6e34b72f2a1184c9543a424b4a0f737ed33967e96",
    blake3: "3ebae6ff0f7864a9f63929e3978af186352a58a05716ba9b6f895ddfac101ebf",
    packagePath: "EPUB/package.opf",
    readingOrderLength: 3,
    exactResource: { path: "EPUB/Content/C_content.xhtml", includes: 'dir="rtl"' },
    scenarios: [
      {
        id: "arabic.rtl-content",
        kind: "reflowable",
        occurrence: 2,
        resource: "EPUB/Content/C_content.xhtml",
        expectedOutcome: "supported",
        expectedReason: null,
        writingMode: "horizontal-tb",
        direction: "rtl",
        language: "ar",
      },
    ],
  },
  {
    id: "svg-in-spine",
    title: "SVG in Spine",
    fileName: "svg-in-spine.epub",
    sha256: "ed6b1b9e99245ac7747ced1a2f90bad1acab558280cffc7daed3e54ee48e49bb",
    blake3: "6036e32321e4c252c292ad451762266945fe31073c64342049bcf24ea13a0051",
    packagePath: "OPS/content.opf",
    readingOrderLength: 6,
    exactResource: { path: "OPS/Images/cover.svg", includes: "<svg" },
    scenarios: [
      {
        id: "svg-in-spine.fixed-svg",
        kind: "fixed-svg",
        occurrence: 0,
        resource: "OPS/Images/cover.svg",
        expectedOutcome: "supported",
        expectedReason: null,
        viewport: { width: 1571, height: 2068 },
      },
    ],
  },
  {
    id: "trees",
    title: "Trees",
    fileName: "trees.epub",
    sha256: "4fbaa5713555ea104b2aed8fc6182700225416b0ab5369f0cb7293d486bb718f",
    blake3: "2cbe47b45b049351174951876f59f7e7e5ad3a98158cd8b8ab274775a2ec7cd2",
    packagePath: "EPUB/package.opf",
    readingOrderLength: 3,
    exactResource: { path: "EPUB/titlepage.xhtml", includes: "canvas" },
    scenarios: [
      {
        id: "trees.publisher-scripts",
        kind: "reflowable",
        occurrence: 0,
        resource: "EPUB/titlepage.xhtml",
        expectedOutcome: "degraded",
        expectedReason: "background-pagination-declared-scripted",
        writingMode: "horizontal-tb",
        direction: "ltr",
        language: "en",
      },
      {
        id: "trees.authored-columns",
        kind: "reflowable",
        occurrence: 1,
        resource: "EPUB/c1.xhtml",
        expectedOutcome: "degraded",
        expectedReason: "background-pagination-declared-scripted",
        writingMode: "horizontal-tb",
        direction: "ltr",
        language: "en",
      },
    ],
  },
] as const satisfies readonly CorpusPublication[];

export type CatalogPublication = (typeof corpusPublications)[number];
export type CatalogScenario = CatalogPublication["scenarios"][number];

export function corpusPublication(id: string): CatalogPublication | undefined {
  return corpusPublications.find((publication) => publication.id === id);
}

export function corpusScenario(
  id: string,
): { readonly publication: CatalogPublication; readonly scenario: CatalogScenario } | undefined {
  for (const publication of corpusPublications) {
    const scenario = publication.scenarios.find((candidate) => candidate.id === id);
    if (scenario !== undefined) return { publication, scenario };
  }
  return undefined;
}
