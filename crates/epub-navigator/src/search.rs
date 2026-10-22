use epub_stack::{
    PublicationAnalysis,
    content::{
        ContentFacts, FragmentAttribute,
        text::{TextRange, TextRole, TextSpanRef},
    },
    resource::ResourceRef,
};
use std::{borrow::Cow, collections::HashMap};

pub struct SearchTextEntry<'a> {
    pub resource: ResourceRef<'a>,
    pub range: TextRange,
    pub text: Cow<'a, str>,
    pub fragment: Option<&'a str>,
}

pub fn search_text_entries(
    analysis: &PublicationAnalysis,
) -> impl Iterator<Item = SearchTextEntry<'_>> {
    analysis.analyzed_resources().flat_map(|resource| {
        let Some(facts) = resource.content().value().and_then(ContentFacts::as_xhtml) else {
            return Vec::new();
        };
        let mut ids = HashMap::new();
        for fragment in facts
            .fragments()
            .iter()
            .filter(|fragment| fragment.attribute() == FragmentAttribute::Id)
        {
            *ids.entry(fragment.id()).or_insert(0usize) += 1;
        }
        let stream = facts.text_stream();
        let mut spans = stream.spans().peekable();
        let mut ancestors: Vec<TextSpanRef<'_>> = Vec::new();
        let mut offset = 0;
        let mut entries: Vec<SearchTextEntry<'_>> = Vec::new();
        for line in stream.text().split_inclusive('\n') {
            let text = line.strip_suffix('\n').unwrap_or(line);
            let end = offset + text.chars().count() as u64;
            ancestors.retain(|span| span.range().end() > offset);
            while spans
                .peek()
                .is_some_and(|span| span.range().start() <= offset)
            {
                let span = spans.next().unwrap();
                if span.range().end() > offset {
                    ancestors.push(span);
                }
            }
            let fragment = ancestors
                .iter()
                .rev()
                .filter(|span| span.range().end() >= end)
                .filter_map(|span| span.origin().fragment())
                .find(|fragment| {
                    fragment.attribute() == FragmentAttribute::Id
                        && ids.get(fragment.id()) == Some(&1)
                })
                .map(|fragment| fragment.id());
            if !text.is_empty() {
                let continuation = entries.last_mut().filter(|previous| {
                    previous.range.end() + 1 == offset
                        && ancestors.iter().any(|span| {
                            matches!(
                                span.role(),
                                TextRole::Body
                                    | TextRole::Heading { .. }
                                    | TextRole::FigureCaption
                                    | TextRole::TableCaption
                            ) && span.range().start() <= previous.range.start()
                                && span.range().end() >= end
                        })
                });
                if let Some(previous) = continuation {
                    previous.text.to_mut().push(' ');
                    previous.text.to_mut().push_str(text);
                    previous.range = TextRange::new(previous.range.start(), end).unwrap();
                    if previous.fragment != fragment {
                        previous.fragment = None;
                    }
                } else {
                    entries.push(SearchTextEntry {
                        resource: resource.resource(),
                        range: TextRange::new(offset, end).unwrap(),
                        text: Cow::Borrowed(text),
                        fragment,
                    });
                }
            }
            offset = end + u64::from(line.ends_with('\n'));
        }
        entries
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use epub_stack::content::XhtmlFacts;
    use epub_stack::{Epub, EpubPath, MemoryResourceProvider};

    #[test]
    fn indexing_covers_loose_text_once_and_keeps_only_unambiguous_html_scopes() {
        let package = br#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="page" href="page.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="page"/></spine></package>"#;
        let document = br#"<html><body>Loose<figure><figcaption id="caption">Before<h2>Inside</h2>After</figcaption></figure><p id="duplicate">One</p><p id="duplicate">Two</p><p xml:id="xml">Three</p><img alt="Alternative"/>Tail<p id="phrase">Hello<br/><em>world</em><br/>again</p><p>Separate</p></body></html>"#;
        let provider = MemoryResourceProvider::from_entries([
            ("package.opf", package.to_vec()),
            ("page.xhtml", document.to_vec()),
        ])
        .unwrap();
        let analysis = Epub::from_provider(provider, EpubPath::new("package.opf").unwrap())
            .unwrap()
            .analyze();
        let entries = search_text_entries(&analysis).collect::<Vec<_>>();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.text.as_ref())
                .collect::<Vec<_>>(),
            [
                "Loose",
                "Before Inside After",
                "One",
                "Two",
                "Three",
                "Tail",
                "Hello world again",
                "Separate"
            ]
        );
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.fragment)
                .collect::<Vec<_>>(),
            [
                None,
                Some("caption"),
                None,
                None,
                None,
                None,
                Some("phrase"),
                None
            ]
        );
        let stream = analysis
            .resource(entries[0].resource.ordinal())
            .unwrap()
            .content()
            .value()
            .and_then(ContentFacts::as_xhtml)
            .map(XhtmlFacts::text_stream)
            .unwrap();
        for entry in entries {
            assert_eq!(
                stream
                    .text_for_range(entry.range)
                    .unwrap()
                    .replace('\n', " "),
                entry.text
            );
        }
    }
}
