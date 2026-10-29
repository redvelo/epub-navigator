use crate::kernel::{
    AnnotationSelectorKind, KernelError, KernelResource, MAX_ANNOTATION_AGGREGATE_STRING_BYTES,
    MAX_ANNOTATION_SELECTOR_DEPTH, MAX_ANNOTATION_SELECTOR_NODES,
    MAX_ANNOTATION_SELECTOR_VALUE_BYTES, MAX_SELECTION_CAPTURE_AGGREGATE_STRING_BYTES,
    MAX_SELECTION_CAPTURE_EVIDENCE_ITEMS, MAX_SELECTION_CAPTURE_STRING_BYTES, NavigatorLocation,
    PointEvidence, RangeEvidence,
};
use epub_stack::{
    EpubPath,
    annotation::{AnnotationSelector, AnnotationTarget, FragmentConformsTo},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// Empty values carried by a resource selector node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(deny_unknown_fields)]
pub struct AnnotationResourceSelectorValues {}

/// String value carried by fragment and CSS selector nodes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(deny_unknown_fields)]
pub struct AnnotationStringSelectorValues {
    pub value: String,
}

/// JSON-safe rendered-text offsets. Both values are unsigned decimal strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationTextPositionSelectorValues {
    pub start: String,
    pub end: String,
}

/// Diagnostic data for a malformed selector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationInvalidSelectorValues {
    pub message: Option<String>,
}

/// Preserved type information for a selector outside this execution slice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationUnsupportedSelectorValues {
    pub selector_type: Option<String>,
}

/// One recursively executable annotation selector in authored source order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AnnotationSelectorNode {
    Resource {
        path: Vec<u32>,
        values: AnnotationResourceSelectorValues,
        refinements: Vec<AnnotationSelectorNode>,
    },
    HtmlFragment {
        path: Vec<u32>,
        values: AnnotationStringSelectorValues,
        refinements: Vec<AnnotationSelectorNode>,
    },
    Css {
        path: Vec<u32>,
        values: AnnotationStringSelectorValues,
        refinements: Vec<AnnotationSelectorNode>,
    },
    TextPosition {
        path: Vec<u32>,
        values: AnnotationTextPositionSelectorValues,
        refinements: Vec<AnnotationSelectorNode>,
    },
    TextFragment {
        path: Vec<u32>,
        values: AnnotationStringSelectorValues,
        refinements: Vec<AnnotationSelectorNode>,
    },
    Invalid {
        path: Vec<u32>,
        values: AnnotationInvalidSelectorValues,
        refinements: Vec<AnnotationSelectorNode>,
    },
    Unsupported {
        path: Vec<u32>,
        values: AnnotationUnsupportedSelectorValues,
        refinements: Vec<AnnotationSelectorNode>,
    },
}

impl AnnotationSelectorNode {
    pub(in crate::kernel) fn path(&self) -> &[u32] {
        match self {
            Self::Resource { path, .. }
            | Self::HtmlFragment { path, .. }
            | Self::Css { path, .. }
            | Self::TextPosition { path, .. }
            | Self::TextFragment { path, .. }
            | Self::Invalid { path, .. }
            | Self::Unsupported { path, .. } => path,
        }
    }

    pub(in crate::kernel) fn refinements(&self) -> &[Self] {
        match self {
            Self::Resource { refinements, .. }
            | Self::HtmlFragment { refinements, .. }
            | Self::Css { refinements, .. }
            | Self::TextPosition { refinements, .. }
            | Self::TextFragment { refinements, .. }
            | Self::Invalid { refinements, .. }
            | Self::Unsupported { refinements, .. } => refinements,
        }
    }

    pub(in crate::kernel) fn kind(&self) -> AnnotationSelectorKind {
        match self {
            Self::Resource { .. } => AnnotationSelectorKind::Resource,
            Self::HtmlFragment { .. } => AnnotationSelectorKind::HtmlFragment,
            Self::Css { .. } => AnnotationSelectorKind::Css,
            Self::TextPosition { .. } => AnnotationSelectorKind::TextPosition,
            Self::TextFragment { .. } => AnnotationSelectorKind::TextFragment,
            Self::Invalid { .. } => AnnotationSelectorKind::Invalid,
            Self::Unsupported { .. } => AnnotationSelectorKind::Unsupported,
        }
    }

    fn string_bytes(&self) -> usize {
        match self {
            Self::Resource { .. } => 0,
            Self::HtmlFragment { values, .. }
            | Self::Css { values, .. }
            | Self::TextFragment { values, .. } => values.value.len(),
            Self::TextPosition { values, .. } => {
                values.start.len().saturating_add(values.end.len())
            }
            Self::Invalid { values, .. } => values.message.as_ref().map_or(0, String::len),
            Self::Unsupported { values, .. } => {
                values.selector_type.as_ref().map_or(0, String::len)
            }
        }
    }

    fn has_valid_values(&self) -> bool {
        match self {
            Self::Resource { .. } => true,
            Self::HtmlFragment { values, .. }
            | Self::Css { values, .. }
            | Self::TextFragment { values, .. } => {
                !values.value.is_empty()
                    && values.value.len() <= MAX_ANNOTATION_SELECTOR_VALUE_BYTES
            }
            Self::TextPosition { values, .. } => {
                let Ok(start) = values.start.parse::<u64>() else {
                    return false;
                };
                let Ok(end) = values.end.parse::<u64>() else {
                    return false;
                };
                start.to_string() == values.start && end.to_string() == values.end && start <= end
            }
            Self::Invalid { values, .. } => values
                .message
                .as_ref()
                .is_none_or(|message| message.len() <= MAX_ANNOTATION_SELECTOR_VALUE_BYTES),
            Self::Unsupported { values, .. } => values
                .selector_type
                .as_ref()
                .is_none_or(|value| value.len() <= MAX_ANNOTATION_SELECTOR_VALUE_BYTES),
        }
    }
}

/// Browser execution plan projected from one authored Stack annotation target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationTargetResolutionPlan {
    /// Canonical physical publication resource.
    pub resource: String,
    pub selectors: Vec<AnnotationSelectorNode>,
}

pub(in crate::kernel) struct ProjectedAnnotationTarget {
    pub(in crate::kernel) plan: AnnotationTargetResolutionPlan,
    pub(in crate::kernel) document_text_start: Option<u64>,
}

impl AnnotationTargetResolutionPlan {
    pub(in crate::kernel) fn validate(&self) -> Result<(), KernelError> {
        validate_resource_path(&self.resource)?;
        if self.selectors.is_empty() || self.selectors.len() > MAX_ANNOTATION_SELECTOR_NODES {
            return Err(KernelError::InvalidAnnotationTarget);
        }
        for (index, selector) in self.selectors.iter().enumerate() {
            let index = u32::try_from(index).map_err(|_| KernelError::InvalidAnnotationTarget)?;
            if selector.path() != [index] {
                return Err(KernelError::InvalidAnnotationTarget);
            }
        }
        let mut pending = self.selectors.iter().collect::<Vec<_>>();
        let mut count = 0usize;
        let mut string_bytes = self.resource.len();
        while let Some(node) = pending.pop() {
            count = count
                .checked_add(1)
                .ok_or(KernelError::InvalidAnnotationTarget)?;
            string_bytes = string_bytes
                .checked_add(node.string_bytes())
                .ok_or(KernelError::InvalidAnnotationTarget)?;
            if count > MAX_ANNOTATION_SELECTOR_NODES
                || node.path().is_empty()
                || node.path().len() > MAX_ANNOTATION_SELECTOR_DEPTH
                || string_bytes > MAX_ANNOTATION_AGGREGATE_STRING_BYTES
                || !node.has_valid_values()
            {
                return Err(KernelError::InvalidAnnotationTarget);
            }
            for (index, refinement) in node.refinements().iter().enumerate() {
                let index =
                    u32::try_from(index).map_err(|_| KernelError::InvalidAnnotationTarget)?;
                let mut expected = node.path().to_vec();
                expected.push(index);
                if refinement.path() != expected {
                    return Err(KernelError::InvalidAnnotationTarget);
                }
            }
            pending.extend(node.refinements());
        }
        Ok(())
    }
}
pub(in crate::kernel) fn validate_selection_locator_limits(
    location: &NavigatorLocation,
) -> Result<(), KernelError> {
    let NavigatorLocation::Range {
        resource, evidence, ..
    } = location
    else {
        return Err(KernelError::InvalidLocator);
    };
    let mut items = evidence.len();
    let mut strings = vec![resource.as_str()];
    for item in evidence {
        match item {
            RangeEvidence::RenderedTextQuote {
                exact,
                prefix,
                suffix,
            } => strings.extend([exact.as_str(), prefix.as_str(), suffix.as_str()]),
            RangeEvidence::Boundaries { start, end } => {
                items = items
                    .checked_add(start.len())
                    .and_then(|items| items.checked_add(end.len()))
                    .ok_or(KernelError::InvalidLocator)?;
                for point in start.iter().chain(end) {
                    match point {
                        PointEvidence::HtmlFragment { value } => strings.push(value),
                        PointEvidence::RenderedTextContext { before, after } => {
                            strings.extend([before.as_str(), after.as_str()]);
                        }
                        PointEvidence::BrowserTextPosition { offset } => strings.push(offset),
                        PointEvidence::DocumentProgression { value } => strings.push(value),
                        PointEvidence::DocumentBoundary { .. } => {}
                    }
                }
            }
            RangeEvidence::BrowserTextPosition { start, end } => {
                strings.extend([start.as_str(), end.as_str()]);
            }
        }
    }
    if items > MAX_SELECTION_CAPTURE_EVIDENCE_ITEMS
        || strings
            .iter()
            .any(|value| value.len() > MAX_SELECTION_CAPTURE_STRING_BYTES)
    {
        return Err(KernelError::InvalidLocator);
    }
    let aggregate = strings.iter().try_fold(0usize, |total, value| {
        total
            .checked_add(value.len())
            .ok_or(KernelError::InvalidLocator)
    })?;
    if aggregate > MAX_SELECTION_CAPTURE_AGGREGATE_STRING_BYTES {
        return Err(KernelError::InvalidLocator);
    }
    Ok(())
}

pub(in crate::kernel) fn validate_nonempty_point_evidence(
    evidence: &[PointEvidence],
) -> Result<(), KernelError> {
    if evidence.is_empty() {
        return Err(KernelError::InvalidLocator);
    }
    for item in evidence {
        item.validate()?;
    }
    Ok(())
}

pub(in crate::kernel) fn project_annotation_selectors(
    selectors: &[AnnotationSelector],
    resource: &KernelResource,
    parent_path: &mut Vec<u32>,
    count: &mut usize,
) -> Result<Vec<AnnotationSelectorNode>, KernelError> {
    selectors
        .iter()
        .enumerate()
        .map(|(index, selector)| {
            *count = count
                .checked_add(1)
                .ok_or(KernelError::InvalidAnnotationTarget)?;
            if *count > MAX_ANNOTATION_SELECTOR_NODES {
                return Err(KernelError::InvalidAnnotationTarget);
            }
            let index = u32::try_from(index).map_err(|_| KernelError::InvalidAnnotationTarget)?;
            parent_path.push(index);
            let node = project_annotation_selector(selector, resource, parent_path, count);
            parent_path.pop();
            node
        })
        .collect()
}

pub(in crate::kernel) fn annotation_document_text_start(target: &AnnotationTarget) -> Option<u64> {
    let mut starts = target.selectors().iter().filter_map(|selector| {
        let AnnotationSelector::TextPosition(position) = selector else {
            return None;
        };
        let (Some(start), Some(end)) = (position.start(), position.end()) else {
            return None;
        };
        (start <= end).then_some(start)
    });
    let start = starts.next()?;
    starts.all(|candidate| candidate == start).then_some(start)
}

fn project_annotation_selector(
    selector: &AnnotationSelector,
    resource: &KernelResource,
    path: &mut Vec<u32>,
    count: &mut usize,
) -> Result<AnnotationSelectorNode, KernelError> {
    let current_path = path.clone();
    let invalid = |message: &str, refinements| AnnotationSelectorNode::Invalid {
        path: current_path.clone(),
        values: AnnotationInvalidSelectorValues {
            message: Some(message.to_string()),
        },
        refinements,
    };
    match selector {
        AnnotationSelector::Fragment(selector) => {
            let value = selector.value().unwrap_or_default();
            let refinements =
                project_annotation_selectors(selector.refined_by(), resource, path, count)?;
            if value.trim().is_empty() || value.len() > MAX_ANNOTATION_SELECTOR_VALUE_BYTES {
                return Ok(invalid("fragment selector value is invalid", refinements));
            }
            match selector.conforms_to() {
                None | Some(FragmentConformsTo::Html) if resource.has_xhtml_declaration => {
                    let Some(value) = selector.decoded_value() else {
                        return Ok(invalid(
                            "HTML fragment contains invalid percent encoding",
                            refinements,
                        ));
                    };
                    Ok(AnnotationSelectorNode::HtmlFragment {
                        path: current_path,
                        values: AnnotationStringSelectorValues { value },
                        refinements,
                    })
                }
                Some(FragmentConformsTo::TextFragment) if resource.has_xhtml_declaration => {
                    Ok(AnnotationSelectorNode::TextFragment {
                        path: current_path,
                        values: AnnotationStringSelectorValues {
                            value: value.to_string(),
                        },
                        refinements,
                    })
                }
                _ => Ok(AnnotationSelectorNode::Unsupported {
                    path: current_path,
                    values: AnnotationUnsupportedSelectorValues {
                        selector_type: Some("FragmentSelector".to_string()),
                    },
                    refinements,
                }),
            }
        }
        AnnotationSelector::Css(selector) => {
            let value = selector.value().unwrap_or_default();
            let refinements =
                project_annotation_selectors(selector.refined_by(), resource, path, count)?;
            if value.trim().is_empty() || value.len() > MAX_ANNOTATION_SELECTOR_VALUE_BYTES {
                return Ok(invalid("CSS selector value is invalid", refinements));
            }
            if resource.has_xhtml_declaration || resource.has_svg_declaration {
                Ok(AnnotationSelectorNode::Css {
                    path: current_path,
                    values: AnnotationStringSelectorValues {
                        value: value.to_string(),
                    },
                    refinements,
                })
            } else {
                Ok(AnnotationSelectorNode::Unsupported {
                    path: current_path,
                    values: AnnotationUnsupportedSelectorValues {
                        selector_type: Some("CssSelector".to_string()),
                    },
                    refinements,
                })
            }
        }
        AnnotationSelector::TextPosition(selector) => {
            let refinements =
                project_annotation_selectors(selector.refined_by(), resource, path, count)?;
            let (Some(start), Some(end)) = (selector.start(), selector.end()) else {
                return Ok(invalid("text-position offsets are missing", refinements));
            };
            if start > end {
                return Ok(invalid("text-position start follows its end", refinements));
            }
            if resource.has_xhtml_declaration {
                Ok(AnnotationSelectorNode::TextPosition {
                    path: current_path,
                    values: AnnotationTextPositionSelectorValues {
                        start: start.to_string(),
                        end: end.to_string(),
                    },
                    refinements,
                })
            } else {
                Ok(AnnotationSelectorNode::Unsupported {
                    path: current_path,
                    values: AnnotationUnsupportedSelectorValues {
                        selector_type: Some("TextPositionSelector".to_string()),
                    },
                    refinements,
                })
            }
        }
        AnnotationSelector::Unknown(selector) => {
            let selector_type = selector
                .selector_type()
                .and_then(Value::as_str)
                .map(str::to_string);
            if selector_type.is_some() {
                Ok(AnnotationSelectorNode::Unsupported {
                    path: current_path,
                    values: AnnotationUnsupportedSelectorValues { selector_type },
                    refinements: Vec::new(),
                })
            } else {
                Ok(invalid("selector type is missing or malformed", Vec::new()))
            }
        }
    }
}

pub(in crate::kernel) fn validate_resource_path(path: &str) -> Result<(), KernelError> {
    EpubPath::new(path)
        .map(|_| ())
        .map_err(|_| KernelError::InvalidLocator)
}
