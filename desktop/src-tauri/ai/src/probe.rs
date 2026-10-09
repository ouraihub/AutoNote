//! Model list probing (doc 23 §5). Failures land in [`ProbeResult::error`].

use std::{collections::HashSet, time::Duration};

use futures_util::StreamExt;
use note_core::ai::{AiModel, AiProtocol};
use serde::Serialize;
use serde_json::Value;

use crate::{ANTHROPIC_VERSION, classify, error_body, upstream_message, url::probe_url};

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BODY: usize = 4 * 1024 * 1024;

/// Outcome of [`probe`]: the URL it hit plus models or an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub probe_url: String,
    pub models: Vec<ProbedModel>,
    pub error: Option<ProbeError>,
}

/// One listed model with its inferred metadata and display group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProbedModel {
    #[serde(flatten)]
    pub model: AiModel,
    pub group: Option<String>,
}

/// Why probing failed; `message` is the provider's sanitized error text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProbeError {
    pub kind: ProbeErrorKind,
    pub status: Option<u16>,
    pub message: Option<String>,
}

/// Probe failure class, spelled as on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeErrorKind {
    MissingKey,
    Unauthorized,
    NotFound,
    RateLimited,
    Status,
    Timeout,
    Connect,
    InvalidBody,
}

impl ProbeErrorKind {
    const fn error(self) -> ProbeError {
        ProbeError {
            kind: self,
            status: None,
            message: None,
        }
    }
}

/// Lists the models of an endpoint via `GET {base}/models`.
/// A missing or blank key fails with `missing_key` without any request.
pub async fn probe(base_url: &str, protocol: AiProtocol, key: Option<&str>) -> ProbeResult {
    let probe_url = probe_url(base_url);
    let outcome = match key.filter(|key| !key.trim().is_empty()) {
        None => Err(ProbeErrorKind::MissingKey.error()),
        Some(key) => match fetch(&probe_url, key).await {
            Ok(body) => parse_ids(&body),
            Err(error) => Err(error),
        },
    };
    match outcome {
        Ok(ids) => ProbeResult {
            probe_url,
            models: ids
                .iter()
                .map(|id| ProbedModel {
                    model: classify::infer(id, protocol),
                    group: classify::group_of(id),
                })
                .collect(),
            error: None,
        },
        Err(error) => ProbeResult {
            probe_url,
            models: Vec::new(),
            error: Some(error),
        },
    }
}

async fn fetch(url: &str, key: &str) -> Result<Vec<u8>, ProbeError> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(network)?;
    let mut request = client.get(url).bearer_auth(key);
    if reqwest::Url::parse(url).is_ok_and(|url| url.host_str() == Some("api.anthropic.com")) {
        request = request
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION);
    }
    let response = request.send().await.map_err(network)?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let kind = match status {
            401 | 403 => ProbeErrorKind::Unauthorized,
            404 => ProbeErrorKind::NotFound,
            429 => ProbeErrorKind::RateLimited,
            _ => ProbeErrorKind::Status,
        };
        return Err(ProbeError {
            kind,
            status: Some(status),
            message: upstream_message(&error_body(response).await, key),
        });
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network)?;
        if chunk.len() > MAX_BODY.saturating_sub(body.len()) {
            return Err(ProbeErrorKind::InvalidBody.error());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn network(error: reqwest::Error) -> ProbeError {
    if error.is_timeout() {
        ProbeErrorKind::Timeout.error()
    } else {
        ProbeErrorKind::Connect.error()
    }
}

/// Model ids from `data[].id`, `models[].id` or a string array, deduplicated
/// in order; none is `invalid_body`.
fn parse_ids(body: &[u8]) -> Result<Vec<String>, ProbeError> {
    let invalid = || ProbeErrorKind::InvalidBody.error();
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid())?;
    let ids: Vec<&str> = match &value {
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
        Value::Object(map) => map
            .get("data")
            .or_else(|| map.get("models"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("id")?.as_str())
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let mut seen = HashSet::new();
    let ids: Vec<String> = ids
        .into_iter()
        .map(str::trim)
        .filter(|id| !id.is_empty() && seen.insert(*id))
        .map(str::to_owned)
        .collect();
    if ids.is_empty() {
        Err(invalid())
    } else {
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
    use super::*;

    #[test]
    fn parses_three_body_shapes() {
        for body in [
            r#"{"object":"list","data":[{"id":"gpt-4.1"},{"id":"o3"},{"id":"gpt-4.1"}]}"#,
            r#"{"models":[{"id":"gpt-4.1","name":"x"},{"id":" o3 "}]}"#,
            r#"["gpt-4.1","o3",""]"#,
        ] {
            assert_eq!(
                parse_ids(body.as_bytes()).unwrap(),
                ["gpt-4.1", "o3"],
                "{body}"
            );
        }
    }

    #[test]
    fn empty_or_garbage_is_invalid_body() {
        for body in [r#"{"data":[]}"#, "{}", "<html>", r#"[1,2]"#, "42"] {
            assert_eq!(
                parse_ids(body.as_bytes()).unwrap_err().kind,
                ProbeErrorKind::InvalidBody,
                "{body}"
            );
        }
    }

    #[test]
    fn serializes_wire_shape() {
        let result = ProbeResult {
            probe_url: "https://x/v1/models".into(),
            models: vec![ProbedModel {
                model: classify::infer("o3", AiProtocol::OpenaiChat),
                group: classify::group_of("o3"),
            }],
            error: Some(ProbeError {
                kind: ProbeErrorKind::RateLimited,
                status: Some(429),
                message: Some("slow down".into()),
            }),
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({
                "probeUrl": "https://x/v1/models",
                "models": [{
                    "id": "o3", "modelType": "chat", "typeSource": "inferred",
                    "contextWindow": 400_000, "canVision": true, "group": "gpt"
                }],
                "error": { "kind": "rate_limited", "status": 429, "message": "slow down" }
            })
        );
    }
}
