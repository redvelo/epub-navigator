use epub_stack::analysis::{AnalysisOutcome, ResourceAnalysisRef};
use epub_stack::content::{ContentFacts, DocumentActivities, DocumentActivity, ScriptFact};

use crate::ForegroundPreparationState;

/// An inline script without text never runs, so it is not active content.
fn inert_script(script: &ScriptFact) -> bool {
    matches!(
        script,
        ScriptFact::Inline {
            has_text: false,
            ..
        }
    )
}

fn static_activity(activity: DocumentActivities, scripts: &[ScriptFact]) -> bool {
    activity.iter().all(|activity| {
        activity == DocumentActivity::ScriptElement
            && !scripts.is_empty()
            && scripts.iter().all(inert_script)
    })
}

pub fn foreground_preparation_state(
    resource: ResourceAnalysisRef<'_>,
) -> ForegroundPreparationState {
    match resource.content() {
        AnalysisOutcome::Complete(content) => {
            let static_content = match content {
                ContentFacts::Xhtml(facts) => {
                    if !facts.is_document() {
                        return ForegroundPreparationState::Unknown;
                    }
                    static_activity(facts.activity(), facts.scripts())
                }
                ContentFacts::Svg(facts) => {
                    static_activity(facts.activity(), facts.scripts())
                        && facts.foreign_objects().iter().all(|foreign| {
                            static_activity(foreign.xhtml().activity(), foreign.xhtml().scripts())
                        })
                }
                ContentFacts::Smil(_) | ContentFacts::Css => false,
            };
            if static_content && content.executable_content_detected() == Some(false) {
                ForegroundPreparationState::Eligible
            } else {
                ForegroundPreparationState::Ineligible
            }
        }
        AnalysisOutcome::NotApplicable => ForegroundPreparationState::Ineligible,
        _ => ForegroundPreparationState::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ForegroundPreparationState::{Eligible, Ineligible, Unknown};
    use epub_stack::analysis::AnalysisLimits;
    use epub_stack::{Epub, EpubPath, MemoryResourceProvider};

    fn state_with(
        media_type: &str,
        document: &str,
        limits: AnalysisLimits,
    ) -> ForegroundPreparationState {
        let package = format!(
            r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="page" href="page" media-type="{media_type}"/></manifest><spine><itemref idref="page"/></spine></package>"#
        );
        let provider = MemoryResourceProvider::from_entries([
            ("package.opf", package.into_bytes()),
            ("page", document.as_bytes().to_vec()),
        ])
        .unwrap();
        let book = Epub::from_provider(provider, EpubPath::new("package.opf").unwrap()).unwrap();
        let ordinal = book
            .resources()
            .declaration_by_id("page")
            .and_then(|declaration| declaration.resource())
            .unwrap()
            .ordinal();
        let analysis = book.analyze_with_limits(limits);
        foreground_preparation_state(analysis.resource(ordinal).unwrap())
    }
    fn xhtml(document: &str) -> ForegroundPreparationState {
        state_with("application/xhtml+xml", document, AnalysisLimits::default())
    }
    fn svg(document: &str) -> ForegroundPreparationState {
        state_with("image/svg+xml", document, AnalysisLimits::default())
    }

    #[test]
    fn preparation_excludes_active_and_early_lifecycle_constructs() {
        for construct in [
            "<audio/>",
            "<video/>",
            "<source/>",
            "<track/>",
            "<iframe/>",
            "<object/>",
            "<embed/>",
            "<input autofocus=\"autofocus\"/>",
            "<meta http-equiv=\"refresh\" content=\"0\"/>",
            "<link rel=\"preload\" href=\"image.png\"/>",
            "<link rel=\"prefetch\" href=\"next.xhtml\"/>",
            "<link rel=\"modulepreload\" href=\"module.js\"/>",
            "<link rel=\"preconnect\" href=\"https://example.com\"/>",
            "<link rel=\"dns-prefetch\" href=\"//example.com\"/>",
            "<link rel=\"prerender\" href=\"next.xhtml\"/>",
            "<script>run()</script>",
            "<script type=\"speculationrules\">{}</script>",
            "<script type=\"application/ld+json\">{}</script>",
            "<p onclick=\"run()\">Event</p>",
        ] {
            let document = format!(
                r#"<html xmlns="http://www.w3.org/1999/xhtml"><head>{construct}</head><body><p>Text</p></body></html>"#
            );
            assert_eq!(xhtml(&document), Ineligible, "{construct}");
        }
        for construct in [
            "animate",
            "animateColor",
            "animateMotion",
            "animateTransform",
            "discard",
            "set",
        ] {
            let document = format!(
                r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns="http://www.w3.org/2000/svg"><{construct}/></svg></body></html>"#
            );
            assert_eq!(xhtml(&document), Ineligible, "{construct}");
        }
    }

    #[test]
    fn preparation_uses_normalized_xhtml_and_namespaces() {
        for (document, expected) in [
            (
                r#"<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="book.css"/></head><body><img src="cover.jpg"/><p>Static</p></body></html>"#,
                Eligible,
            ),
            ("<html><body><p>broken</body></html>", Eligible),
            (
                r#"<html xmlns="urn:not-xhtml"><body><p>Text</p></body></html>"#,
                Eligible,
            ),
            (
                r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><custom xmlns="urn:unsupported">Text</custom></body></html>"#,
                Eligible,
            ),
            (
                r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg><math xmlns="http://www.w3.org/1998/Math/MathML"><mn>1</mn></math></body></html>"#,
                Eligible,
            ),
            ("<html><body><script>run()</body></html>", Ineligible),
            (
                r#"<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:body><h:script>run()</h:script></h:body></h:html>"#,
                Ineligible,
            ),
            (
                r#"<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:body><h:iframe/></h:body></h:html>"#,
                Ineligible,
            ),
            (
                r#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:svg="http://www.w3.org/2000/svg"><body><svg:svg><svg:animate/></svg:svg></body></html>"#,
                Ineligible,
            ),
        ] {
            assert_eq!(xhtml(document), expected, "{document}");
        }
    }

    #[test]
    fn empty_inline_scripts_are_not_active_content() {
        for (construct, expected) in [
            ("<script></script>", Eligible),
            ("<script>\n  </script>", Eligible),
            (r#"<script type="text/javascript"></script>"#, Eligible),
            (r#"<script type="module"></script>"#, Eligible),
            (r#"<script src=""></script>"#, Ineligible),
            (r#"<script src="app.js"></script>"#, Ineligible),
            (
                r#"<script type="application/ld+json"></script>"#,
                Ineligible,
            ),
            ("<script></script><script>run()</script>", Ineligible),
            (
                r#"<script></script><p onclick="run()">Event</p>"#,
                Ineligible,
            ),
        ] {
            let document = format!(
                r#"<html xmlns="http://www.w3.org/1999/xhtml"><head>{construct}</head><body><p>Text</p></body></html>"#
            );
            assert_eq!(xhtml(&document), expected, "{construct}");
        }
        for (document, expected) in [
            (
                r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns="http://www.w3.org/2000/svg"><script/></svg></body></html>"#,
                Eligible,
            ),
            (
                r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns="http://www.w3.org/2000/svg"><script>run()</script></svg></body></html>"#,
                Ineligible,
            ),
            (
                r#"<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head><h:script></h:script></h:head><h:body><h:p>Text</h:p></h:body></h:html>"#,
                Eligible,
            ),
            (
                r#"<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head><h:script></h:script><h:script>run()</h:script></h:head><h:body><h:p>Text</h:p></h:body></h:html>"#,
                Ineligible,
            ),
        ] {
            assert_eq!(xhtml(document), expected, "{document}");
        }
        assert_eq!(
            svg(
                r#"<svg xmlns="http://www.w3.org/2000/svg"><script></script><text>Static</text></svg>"#
            ),
            Eligible
        );
    }

    #[test]
    fn preparation_requires_complete_static_svg() {
        for (document, expected) in [
            (
                r#"<svg xmlns="http://www.w3.org/2000/svg"><script>run()</script></svg>"#,
                Ineligible,
            ),
            (
                r#"<svg xmlns="http://www.w3.org/2000/svg"><script href="app.js"/></svg>"#,
                Ineligible,
            ),
            (
                r#"<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="run()"/></svg>"#,
                Ineligible,
            ),
            (
                r#"<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="opacity"/></svg>"#,
                Ineligible,
            ),
            (
                r#"<!DOCTYPE svg [<!ATTLIST svg onload CDATA "run()">]><svg xmlns="http://www.w3.org/2000/svg"/>"#,
                Ineligible,
            ),
            (
                r#"<svg xmlns="http://www.w3.org/2000/svg"><script type="application/ld+json">{}</script><text>Static</text></svg>"#,
                Eligible,
            ),
            (
                r#"<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>Static</p></div></foreignObject></svg>"#,
                Eligible,
            ),
            (
                r#"<svg xmlns="http://www.w3.org/2000/svg"><text>broken</svg>"#,
                Unknown,
            ),
        ] {
            assert_eq!(svg(document), expected, "{document}");
        }
        for construct in [
            "<script>run()</script>",
            "<p onclick=\"run()\">Event</p>",
            "<iframe/>",
            "<link rel=\"preconnect\" href=\"https://example.com\"/>",
        ] {
            let document = format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">{construct}</div></foreignObject></svg>"#
            );
            assert_eq!(svg(&document), Ineligible, "{construct}");
        }
    }

    #[test]
    fn preparation_is_unknown_without_complete_analysis() {
        for (media_type, document) in [
            (
                "application/xhtml+xml",
                r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Static</p></body></html>"#,
            ),
            (
                "image/svg+xml",
                r#"<svg xmlns="http://www.w3.org/2000/svg"><text>Static</text></svg>"#,
            ),
        ] {
            let mut limits = AnalysisLimits::default();
            limits.max_resource_analysis_bytes = Some(1);
            assert_eq!(state_with(media_type, document, limits), Unknown);
        }
    }
}
