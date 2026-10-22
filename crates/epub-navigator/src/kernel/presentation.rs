use serde::{Deserialize, Serialize};
use specta::Type;

/// Logical direction requested for one content-document presentation advance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PresentationAdvanceDirection {
    Forward,
    Backward,
}

/// Which spread participant a presentation advance addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PresentationAdvanceTarget {
    Primary,
    /// A reflowable companion turns its own pages while the fixed page beside it stays.
    FixedCompanion,
}

/// Why an advertised presentation advance could not currently be performed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PresentationAdvanceUnavailableReason {
    PresentationUnavailable,
    LayoutUnavailable,
}

/// Browser-authoritative outcome of one content-document presentation advance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PresentationAdvanceStatus {
    Advanced,
    Boundary,
    Unavailable {
        reason: PresentationAdvanceUnavailableReason,
    },
    Failed {
        message: String,
    },
}

/// Reader-requested presentation mode for the current session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PresentationMode {
    Auto,
    Paginated,
    DocumentScroll,
}

/// Reader preference for the number of reflowable columns visible per viewport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PaginationColumns {
    Auto,
    Single,
    Double,
}

/// Publication content theme, independent from reader chrome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PublicationTheme {
    Auto,
    Original,
    Light,
    Dark,
}

/// Browser color environment used to resolve system colors and authored media queries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PublicationColorScheme {
    Light,
    Dark,
}

/// Reader-selected semantic publication typeface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PublicationTypeface {
    Original,
    ReaderSerif,
    ReaderSans,
}

/// Bounded root font percentages supported by the layout agent.
///
/// There is no authored-root option: a root percentage always applies, so a publication that
/// fixes its own root size cannot withhold text scaling from the reader.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum FontScale {
    #[serde(rename = "80")]
    Percent80,
    #[serde(rename = "90")]
    Percent90,
    #[serde(rename = "100")]
    Percent100,
    #[serde(rename = "110")]
    Percent110,
    #[serde(rename = "125")]
    Percent125,
    #[serde(rename = "140")]
    Percent140,
    #[serde(rename = "160")]
    Percent160,
    #[serde(rename = "200")]
    Percent200,
}

/// Extra letter spacing as a fraction of font size.
///
/// `None` emits no declaration, so authored tracking inside prose survives until a reader asks
/// for more. The ceiling matches the 0.12em text-spacing override in WCAG 1.4.12.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum LetterSpacing {
    #[serde(rename = "0")]
    None,
    #[serde(rename = "0.03")]
    Em003,
    #[serde(rename = "0.06")]
    Em006,
    #[serde(rename = "0.12")]
    Em012,
}

/// Extra word spacing as a fraction of font size. The ceiling matches WCAG 1.4.12's 0.16em.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum WordSpacing {
    #[serde(rename = "0")]
    None,
    #[serde(rename = "0.04")]
    Em004,
    #[serde(rename = "0.08")]
    Em008,
    #[serde(rename = "0.16")]
    Em016,
}

/// Space between paragraphs as a multiple of font size.
///
/// `Original` keeps the authored margins, which is the only sensible default: a publication
/// separates paragraphs either by blank space or by a first-line indent, and the reading system
/// cannot tell which convention was intended. The ceiling matches WCAG 1.4.12's 2em.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ParagraphSpacing {
    #[serde(rename = "original")]
    Original,
    #[serde(rename = "0")]
    None,
    #[serde(rename = "1")]
    Em1,
    #[serde(rename = "2")]
    Em2,
}

/// First-line indent as a multiple of font size, paired with `ParagraphSpacing` so a reader can
/// reconstruct either paragraph convention rather than having one detected for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum TextIndent {
    #[serde(rename = "original")]
    Original,
    #[serde(rename = "0")]
    None,
    #[serde(rename = "1")]
    Em1,
    #[serde(rename = "2")]
    Em2,
}

/// Reader-selected line-height policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum LineHeight {
    #[serde(rename = "original")]
    Original,
    #[serde(rename = "1.25")]
    OnePointTwoFive,
    #[serde(rename = "1.5")]
    OnePointFive,
    #[serde(rename = "1.75")]
    OnePointSevenFive,
    #[serde(rename = "2")]
    Two,
}

/// Reader-owned logical maximum inline measure.
///
/// The reader chooses this as a margin, so a narrower measure is presented as a wider margin;
/// the variants name the measure because that is what the host clamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ReadingMeasure {
    Narrow,
    Medium,
    Wide,
    FullWidth,
}

/// Reader-selected paragraph alignment policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum TextAlignment {
    Original,
    Start,
    Justify,
}

/// Reader-selected word hyphenation policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum Hyphenation {
    Original,
    Auto,
    Off,
}

/// Reader control over the document root scrollbar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum RootScrollbar {
    Publisher,
    Hidden,
}

/// Validated session preferences used for every presentation resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationPreferences {
    pub mode: PresentationMode,
    pub pagination_columns: PaginationColumns,
    pub theme: PublicationTheme,
    pub color_scheme: PublicationColorScheme,
    pub typeface: PublicationTypeface,
    pub font_scale: FontScale,
    pub line_height: LineHeight,
    pub letter_spacing: LetterSpacing,
    pub word_spacing: WordSpacing,
    pub paragraph_spacing: ParagraphSpacing,
    pub text_indent: TextIndent,
    pub measure: ReadingMeasure,
    pub alignment: TextAlignment,
    pub hyphenation: Hyphenation,
    pub root_scrollbar: RootScrollbar,
}

impl Default for PresentationPreferences {
    fn default() -> Self {
        Self {
            mode: PresentationMode::Auto,
            pagination_columns: PaginationColumns::Auto,
            theme: PublicationTheme::Original,
            color_scheme: PublicationColorScheme::Light,
            typeface: PublicationTypeface::Original,
            font_scale: FontScale::Percent100,
            line_height: LineHeight::Original,
            letter_spacing: LetterSpacing::None,
            word_spacing: WordSpacing::None,
            paragraph_spacing: ParagraphSpacing::Original,
            text_indent: TextIndent::Original,
            measure: ReadingMeasure::FullWidth,
            alignment: TextAlignment::Original,
            hyphenation: Hyphenation::Original,
            root_scrollbar: RootScrollbar::Publisher,
        }
    }
}

/// Reflowable layout mode selected for an XHTML adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ReflowableLayoutMode {
    Paginated,
    DocumentScroll,
}

/// Typed explanation for adapter layout planning or execution failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutIssue {
    PublicationContinuousUnavailable,
    AuthoredPresentationAmbiguous,
    AuthoredPresentationUnsupported,
    IncompatiblePublisherCss,
    AgentStyleUnavailable,
    ReaderFontUnavailable,
    AnchorReconciliationFailed,
}

/// Adapter-specific work selected before a browser layout transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "adapter",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AdapterLayoutPlan {
    ReflowableXhtml {
        requested: PresentationPreferences,
        mode: ReflowableLayoutMode,
        notice: Option<LayoutIssue>,
        align_x_center: bool,
    },
    FixedXhtml,
    FixedSvg,
    FixedImage,
}

impl AdapterLayoutPlan {
    pub(in crate::kernel) fn requested(self) -> Option<PresentationPreferences> {
        match self {
            Self::ReflowableXhtml { requested, .. } => Some(requested),
            Self::FixedXhtml | Self::FixedSvg | Self::FixedImage => None,
        }
    }
}

/// Compact presentation values sent to the content agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReflowablePresentation {
    pub mode: ReflowableLayoutMode,
    pub pagination_columns: PaginationColumns,
    pub theme: PublicationTheme,
    pub color_scheme: PublicationColorScheme,
    pub typeface: PublicationTypeface,
    pub font_scale: FontScale,
    pub line_height: LineHeight,
    pub letter_spacing: LetterSpacing,
    pub word_spacing: WordSpacing,
    pub paragraph_spacing: ParagraphSpacing,
    pub text_indent: TextIndent,
    pub measure: ReadingMeasure,
    pub alignment: TextAlignment,
    pub hyphenation: Hyphenation,
    pub root_scrollbar: RootScrollbar,
    pub align_x_center: bool,
}
