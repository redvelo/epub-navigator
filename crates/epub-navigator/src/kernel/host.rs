use crate::kernel::KernelError;
use serde::{Deserialize, Serialize};
use specta::Type;
use url::Url;

/// Whether authored remote URLs may be requested directly by publication content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteResourcePolicy {
    /// Block direct authored remote requests.
    Blocked,
    /// Allow direct authored remote requests.
    Allowed,
}

/// Browser origin authority provided by a publication host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ContentOriginProfile {
    /// Trusted publication content shares the unprivileged reader origin.
    SharedReaderOrigin,
    /// Publication content retains a dedicated origin isolated from the reader.
    IsolatedPublicationOrigin,
}

/// How a host exposes canonical publication paths to the browser.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationMount {
    /// Absolute, queryless, fragmentless URL ending in `/`.
    pub base_url: String,
    /// Direct authored remote-resource policy.
    pub remote_resources: RemoteResourcePolicy,
    /// Host-selected browser origin authority for publication content.
    pub content_origin: ContentOriginProfile,
}

impl PublicationMount {
    /// Validates the mount independently from any browser route implementation.
    pub fn validate(&self) -> Result<(), KernelError> {
        let url = Url::parse(&self.base_url).map_err(|_| KernelError::InvalidMount)?;
        if url.cannot_be_a_base()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.path().ends_with('/')
            || (self.content_origin == ContentOriginProfile::IsolatedPublicationOrigin
                && url.path() != "/")
        {
            return Err(KernelError::InvalidMount);
        }
        Ok(())
    }
}
