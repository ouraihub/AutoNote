//! AutoNote model classification and probing adapter.
use futures_util::StreamExt;
use serde_json::Value;

mod classify;
mod probe;
mod url;

pub use classify::{group_of, infer};
pub use probe::{ProbeError, ProbeErrorKind, ProbeResult, ProbedModel, probe};
pub use url::{api_base, probe_url};

const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_ERROR_BODY: usize = 64 * 1024;
const MAX_MESSAGE: usize = 300;

async fn error_body(response: reqwest::Response) -> Vec<u8> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(Ok(chunk)) = stream.next().await {
        let room = MAX_ERROR_BODY.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() == MAX_ERROR_BODY {
            break;
        }
    }
    body
}

fn upstream_message(body: &[u8], key: &str) -> Option<String> {
    match serde_json::from_slice::<Value>(body) {
        Ok(value) => json_message(&value, key),
        Err(_) => {
            let text = std::str::from_utf8(body).ok()?.trim();
            (text.len() <= MAX_ERROR_BODY / 16 && !text.starts_with('<'))
                .then(|| sanitize(text, key))
                .flatten()
        }
    }
}

fn json_message(value: &Value, key: &str) -> Option<String> {
    let text = value["error"]["message"]
        .as_str()
        .or_else(|| value["message"].as_str())
        .or_else(|| value["error"].as_str())
        .or_else(|| value.as_str())?;
    sanitize(text, key)
}

fn sanitize(text: &str, key: &str) -> Option<String> {
    let mut text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if !key.trim().is_empty() {
        text = text.replace(key.trim(), "***");
    }
    if text.chars().nth(MAX_MESSAGE).is_some()
        && let Some((cut, _)) = text.char_indices().nth(MAX_MESSAGE - 1)
    {
        text.truncate(cut);
        text.push('…');
    }
    (!text.is_empty()).then_some(text)
}
