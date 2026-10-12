//! Provider credentials in the OS credential store.
//!
//! * macOS: Keychain
//! * Windows: Credential Manager
//! * Linux: Secret Service (GNOME Keyring, KWallet, ...)
//!
//! Secrets are written and read only here and in `ai.rs`. They are never
//! returned to the webview; the frontend only learns whether a credential is
//! stored and a short masked hint. If no secure store is available the
//! credential is not saved anywhere else (no plaintext fallback).

use keyring::Entry;
use serde::Serialize;

use crate::error::{CmdError, CmdResult};

const SERVICE: &str = "app.logica.desktop";

/// Authentication methods a provider credential can be stored under.
/// Only API keys are implemented today; the account name leaves room for
/// other official methods (for example OAuth token sets) later.
const API_KEY: &str = "api_key";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    provider: String,
    stored: bool,
    method: Option<&'static str>,
    /// Masked hint such as `…a1b2`; never the secret itself.
    hint: Option<String>,
    store_available: bool,
    error: Option<String>,
}

fn account(provider: &str) -> CmdResult<String> {
    match provider {
        "openai" | "anthropic" => Ok(format!("{provider}:{API_KEY}")),
        _ => Err(CmdError::new("invalid_provider", format!("Unknown provider: {provider}"))),
    }
}

fn store_error(err: keyring::Error) -> CmdError {
    CmdError::new(
        "store_unavailable",
        format!("OS credential store is not available: {err}"),
    )
}

fn entry(provider: &str) -> CmdResult<Entry> {
    Entry::new(SERVICE, &account(provider)?).map_err(store_error)
}

/// Read the stored secret for a provider. Blocking; call from a blocking task.
pub fn read_secret(provider: &str) -> CmdResult<Option<String>> {
    match entry(provider)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(store_error(err)),
    }
}

fn hint(secret: &str) -> String {
    let tail: String = secret.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

fn status_blocking(provider: &str) -> CredentialStatus {
    match read_secret(provider) {
        Ok(secret) => CredentialStatus {
            provider: provider.to_string(),
            stored: secret.is_some(),
            method: secret.as_ref().map(|_| API_KEY),
            hint: secret.as_deref().map(hint),
            store_available: true,
            error: None,
        },
        Err(err) => CredentialStatus {
            provider: provider.to_string(),
            stored: false,
            method: None,
            hint: None,
            store_available: err.kind != "store_unavailable",
            error: Some(err.message),
        },
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CmdError::new("internal", e.to_string()))
}

#[tauri::command]
pub async fn credential_status(provider: String) -> CmdResult<CredentialStatus> {
    account(&provider)?;
    blocking(move || status_blocking(&provider)).await
}

#[tauri::command]
pub async fn credential_set(provider: String, secret: String) -> CmdResult<CredentialStatus> {
    account(&provider)?;
    let secret = secret.trim().to_string();
    if secret.is_empty() || secret.len() > 4096 || secret.chars().any(char::is_whitespace) {
        return Err(CmdError::new("invalid_secret", "The API key format is not valid"));
    }
    blocking(move || {
        entry(&provider)?.set_password(&secret).map_err(store_error)?;
        Ok(status_blocking(&provider))
    })
    .await?
}

/// Remove the stored credential. Called when the user disconnects a provider.
#[tauri::command]
pub async fn credential_delete(provider: String) -> CmdResult<()> {
    account(&provider)?;
    blocking(move || match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(store_error(err)),
    })
    .await?
}
