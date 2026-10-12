//! Provider credentials in the OS credential store.
//!
//! * macOS: Keychain
//! * Windows: Credential Manager
//! * Linux: Secret Service (GNOME Keyring, KWallet, ...)
//!
//! Secrets are written and read only by the backend (`ai.rs`, `chatgpt.rs`).
//! They are never returned to the webview; the frontend only learns whether a
//! credential is stored and a short masked hint. If no secure store is
//! available the credential is not saved anywhere else (no plaintext fallback).

use keyring::Entry;
use serde::Serialize;

use crate::error::{CmdError, CmdResult};

const SERVICE: &str = "app.logica.desktop";

/// Account name suffix for API keys (`openai:api_key`, `anthropic:api_key`).
/// Other methods use their own accounts, e.g. `openai:chatgpt` (see chatgpt.rs).
const API_KEY: &str = "api_key";

/// Windows Credential Manager limits a secret to 2560 bytes; OAuth token sets
/// can be larger, so blobs are split into chunks below that size.
const CHUNK_BYTES: usize = 2000;

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

pub fn store_error(err: keyring::Error) -> CmdError {
    CmdError::new(
        "store_unavailable",
        format!("OS credential store is not available: {err}"),
    )
}

fn entry(provider: &str) -> CmdResult<Entry> {
    Entry::new(SERVICE, &account(provider)?).map_err(store_error)
}

fn named(account: &str) -> CmdResult<Entry> {
    Entry::new(SERVICE, account).map_err(store_error)
}

/// Read a single secure-store entry. Blocking.
pub fn read_entry(account: &str) -> CmdResult<Option<String>> {
    match named(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(store_error(err)),
    }
}

/// Write a single secure-store entry. Blocking.
pub fn write_entry(account: &str, value: &str) -> CmdResult<()> {
    named(account)?.set_password(value).map_err(store_error)
}

/// Delete a single secure-store entry (missing entries are fine). Blocking.
pub fn delete_entry(account: &str) -> CmdResult<()> {
    match named(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(store_error(err)),
    }
}

fn chunk_count(header: Option<String>) -> usize {
    header
        .and_then(|h| h.strip_prefix("chunks:").and_then(|n| n.parse().ok()))
        .unwrap_or(0)
}

/// Store a value of any size as `<account>` (header) plus `<account>#<i>` chunks.
pub fn write_blob(account: &str, value: &str) -> CmdResult<()> {
    let previous = chunk_count(read_entry(account)?);
    let mut chunks = Vec::new();
    let mut rest = value;
    while !rest.is_empty() {
        let mut cut = rest.len().min(CHUNK_BYTES);
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        chunks.push(&rest[..cut]);
        rest = &rest[cut..];
    }
    for (i, chunk) in chunks.iter().enumerate() {
        write_entry(&format!("{account}#{i}"), chunk)?;
    }
    write_entry(account, &format!("chunks:{}", chunks.len()))?;
    for i in chunks.len()..previous {
        delete_entry(&format!("{account}#{i}"))?;
    }
    Ok(())
}

pub fn read_blob(account: &str) -> CmdResult<Option<String>> {
    let Some(header) = read_entry(account)? else {
        return Ok(None);
    };
    let count = chunk_count(Some(header));
    let mut value = String::new();
    for i in 0..count {
        match read_entry(&format!("{account}#{i}"))? {
            Some(chunk) => value.push_str(&chunk),
            None => return Ok(None), // incomplete write: treat as absent
        }
    }
    Ok(Some(value))
}

pub fn delete_blob(account: &str) -> CmdResult<()> {
    let count = chunk_count(read_entry(account)?);
    delete_entry(account)?;
    for i in 0..count {
        delete_entry(&format!("{account}#{i}"))?;
    }
    Ok(())
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

pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a running OS credential store (skipped otherwise).
    #[test]
    fn blobs_larger_than_one_entry_round_trip() {
        let account = format!("test:blob:{}", std::process::id());
        if write_entry(&account, "probe").is_err() {
            eprintln!("no OS credential store; skipping");
            return;
        }
        let big: String = (0..5000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        write_blob(&account, &big).unwrap();
        assert_eq!(read_blob(&account).unwrap().as_deref(), Some(big.as_str()));
        write_blob(&account, "small").unwrap();
        assert_eq!(read_blob(&account).unwrap().as_deref(), Some("small"));
        assert_eq!(read_entry(&format!("{account}#1")).unwrap(), None, "stale chunk left behind");
        delete_blob(&account).unwrap();
        assert_eq!(read_blob(&account).unwrap(), None);
    }
}
