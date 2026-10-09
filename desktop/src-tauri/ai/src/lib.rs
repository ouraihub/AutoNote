//! AI model client for AutoNote (doc 23): endpoint URLs, model type
//! inference, model list probing and streaming chat. No Tauri, no storage.
//!
//! Errors carry at most a sanitized upstream message, never the key.

use futures_util::StreamExt;
use serde_json::Value;

mod chat;
mod classify;
mod probe;
mod url;

pub use chat::{ChatEvent, ChatMessage, ChatRequest, ChatRole, chat_stream};
pub use classify::{group_of, infer};
pub use probe::{ProbeError, ProbeErrorKind, ProbeResult, ProbedModel, probe};
pub use url::{api_base, probe_url};

const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Most of an error body that is read.
const MAX_ERROR_BODY: usize = 64 * 1024;
/// Longest upstream message kept, in chars.
const MAX_MESSAGE: usize = 300;

/// Up to [`MAX_ERROR_BODY`] bytes of an error response; read errors end it.
async fn error_body(response: reqwest::Response) -> Vec<u8> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(Ok(chunk)) = stream.next().await {
        let room = MAX_ERROR_BODY - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() == MAX_ERROR_BODY {
            break;
        }
    }
    body
}

/// The provider's own error text from an error body: JSON `error.message`,
/// `message` or a string `error`, else short plain text.
fn upstream_message(body: &[u8], key: &str) -> Option<String> {
    match serde_json::from_slice::<Value>(body) {
        Ok(value) => json_message(&value, key),
        Err(_) => {
            let text = std::str::from_utf8(body).ok()?.trim();
            // ponytail: "short and not markup" heuristic for plain-text bodies.
            (text.len() <= MAX_ERROR_BODY / 16 && !text.starts_with('<'))
                .then(|| sanitize(text, key))
                .flatten()
        }
    }
}

/// [`upstream_message`] for an already parsed JSON value.
fn json_message(value: &Value, key: &str) -> Option<String> {
    let text = value["error"]["message"]
        .as_str()
        .or_else(|| value["message"].as_str())
        .or_else(|| value["error"].as_str())
        .or_else(|| value.as_str())?;
    sanitize(text, key)
}

/// Collapses whitespace, masks `key`, caps at [`MAX_MESSAGE`] chars.
fn sanitize(text: &str, key: &str) -> Option<String> {
    let mut text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let key = key.trim();
    if !key.is_empty() {
        text = text.replace(key, "***");
    }
    if text.chars().nth(MAX_MESSAGE).is_some()
        && let Some((cut, _)) = text.char_indices().nth(MAX_MESSAGE - 1)
    {
        text.truncate(cut);
        text.push('…');
    }
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
    use super::*;

    fn message(body: &str) -> Option<String> {
        upstream_message(body.as_bytes(), "sk-secret")
    }

    #[test]
    fn takes_openai_and_anthropic_messages() {
        assert_eq!(
            message(
                r#"{"error":{"message":"No available channel for model gpt-5.4 under group codex (distributor) (request id: 1)","type":"new_api_error","param":"","code":"model_not_found"}}"#
            )
            .as_deref(),
            Some(
                "No available channel for model gpt-5.4 under group codex (distributor) (request id: 1)"
            )
        );
        assert_eq!(
            message(
                r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
            )
            .as_deref(),
            Some("Overloaded")
        );
        assert_eq!(message(r#"{"message":"m"}"#).as_deref(), Some("m"));
        assert_eq!(message(r#"{"error":"e"}"#).as_deref(), Some("e"));
    }

    #[test]
    fn takes_plain_text() {
        assert_eq!(
            message("  quota\n\texceeded \r\n").as_deref(),
            Some("quota exceeded")
        );
    }

    #[test]
    fn redacts_key() {
        assert_eq!(
            message(r#"{"error":{"message":"bad key sk-secret, sk-secret!"}}"#).as_deref(),
            Some("bad key ***, ***!")
        );
    }

    #[test]
    fn truncates_by_chars() {
        let text = message(&"界".repeat(400)).unwrap();
        assert_eq!(text.chars().count(), MAX_MESSAGE);
        assert!(text.ends_with('…'));
        let exact = "界".repeat(MAX_MESSAGE);
        assert_eq!(message(&exact), Some(exact));
    }

    #[test]
    fn garbage_is_none() {
        for body in [
            &b"\xff\xfe\x00bad"[..],
            b"",
            b"   ",
            b"<html><body>502</body></html>",
            b"{}",
            br#"{"error":{"code":1}}"#,
            b"[1,2]",
        ] {
            assert_eq!(upstream_message(body, "k"), None, "{body:?}");
        }
    }
}
