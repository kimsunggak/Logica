use serde::Serialize;

/// Error returned to the webview by every command.
///
/// `kind` is a stable machine-readable category that the frontend maps to UI
/// behavior; `message` is human readable. Neither may contain secrets.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    pub kind: &'static str,
    pub message: String,
    /// HTTP status for provider errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Raw (redacted) provider error body, parsed by the provider adapter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

impl CmdError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            status: None,
            body: None,
        }
    }
}

impl From<std::io::Error> for CmdError {
    fn from(err: std::io::Error) -> Self {
        let kind = match err.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            _ => "io",
        };
        CmdError::new(kind, err.to_string())
    }
}

pub type CmdResult<T> = Result<T, CmdError>;
