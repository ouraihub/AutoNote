//! Streaming chat over the three supported protocols (doc 23 §5).

use std::time::Duration;

use futures_util::StreamExt;
use note_core::{AppError, ErrorCode, ai::AiProtocol};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{ANTHROPIC_VERSION, error_body, json_message, upstream_message, url::api_base};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Limit before the response head and between body chunks.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_MAX_TOKENS: u32 = 4096;

/// Author of a chat message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

/// One message of the conversation, `{ role, content }` on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

/// Conversation sent to the model.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub max_tokens: Option<u32>,
}

/// Streamed output: text deltas, then exactly one `done`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ChatEvent {
    Delta {
        text: String,
    },
    Done {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
}

/// Streams a completion of `request` from `model`, calling `on_event` for
/// every text delta and once with [`ChatEvent::Done`] on success.
///
/// # Errors
/// `unauthenticated` (401/403), `not_found` (404), `too_many_attempts`
/// (429), `internal` (other statuses, stream errors, stream cut before its
/// terminator), `offline` (connect
/// failure), `request_timeout` (60 s without data), `cancelled` when
/// `cancel` fires. Status errors read `"<status>: <upstream message>"`;
/// upstream text is sanitized and never contains the key.
pub async fn chat_stream(
    base_url: &str,
    protocol: AiProtocol,
    key: &str,
    model: &str,
    request: &ChatRequest,
    cancel: &CancellationToken,
    on_event: &mut (dyn FnMut(ChatEvent) + Send),
) -> Result<(), AppError> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(network)?;
    let (path, body) = build_body(protocol, model, request);
    let http = client
        .post(format!("{}/{path}", api_base(base_url)))
        .json(&body);
    let http = match protocol {
        AiProtocol::AnthropicMessages => http
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        AiProtocol::OpenaiChat | AiProtocol::OpenaiResponses => http.bearer_auth(key),
    };
    let response = guard(cancel, http.send()).await?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let code = match status {
            401 | 403 => ErrorCode::Unauthenticated,
            404 => ErrorCode::NotFound,
            429 => ErrorCode::TooManyAttempts,
            _ => ErrorCode::Internal,
        };
        let body = guard(cancel, async { Ok(error_body(response).await) }).await?;
        let message = match upstream_message(&body, key) {
            Some(message) => format!("{status}: {message}"),
            None => format!("AI provider returned HTTP {status}"),
        };
        return Err(AppError::new(code, message));
    }
    let mut decoder = Decoder::new(protocol, key);
    let mut stream = response.bytes_stream();
    while !decoder.finished {
        let Some(chunk) = guard(cancel, async { stream.next().await.transpose() }).await? else {
            return Err(AppError::new(ErrorCode::Internal, "AI stream ended early"));
        };
        decoder.feed(&chunk, on_event)?;
    }
    on_event(decoder.done());
    Ok(())
}

/// Awaits `future` unless `cancel` fires first or it idles past the limit.
async fn guard<T>(
    cancel: &CancellationToken,
    future: impl Future<Output = Result<T, reqwest::Error>>,
) -> Result<T, AppError> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(AppError::new(ErrorCode::Cancelled, "AI request cancelled")),
        result = tokio::time::timeout(IDLE_TIMEOUT, future) => match result {
            Ok(result) => result.map_err(network),
            Err(_) => Err(timed_out()),
        },
    }
}

fn timed_out() -> AppError {
    AppError::new(ErrorCode::RequestTimeout, "AI request timed out")
}

fn network(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        timed_out()
    } else if error.is_connect() {
        AppError::new(ErrorCode::Offline, "AI provider unreachable")
    } else {
        AppError::new(ErrorCode::Internal, "AI request failed")
    }
}

fn stream_error(message: Option<String>) -> AppError {
    AppError::new(
        ErrorCode::Internal,
        message.unwrap_or_else(|| "AI provider reported a stream error".into()),
    )
}

/// Request path below the API base and JSON body for `protocol`.
fn build_body(protocol: AiProtocol, model: &str, request: &ChatRequest) -> (&'static str, Value) {
    let system: Vec<&str> = request
        .messages
        .iter()
        .filter(|message| message.role == ChatRole::System)
        .map(|message| message.content.as_str())
        .collect();
    let system = (!system.is_empty()).then(|| system.join("\n\n"));
    let turns: Vec<&ChatMessage> = request
        .messages
        .iter()
        .filter(|message| message.role != ChatRole::System)
        .collect();
    match protocol {
        AiProtocol::AnthropicMessages => {
            let mut body = json!({
                "model": model,
                "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
                "stream": true,
                "messages": turns,
            });
            if let Some(system) = system {
                body["system"] = json!(system);
            }
            ("messages", body)
        }
        AiProtocol::OpenaiChat => {
            let mut body = json!({
                "model": model,
                "stream": true,
                "stream_options": { "include_usage": true },
                "messages": request.messages,
            });
            if let Some(max) = request.max_tokens {
                body["max_tokens"] = json!(max);
            }
            ("chat/completions", body)
        }
        AiProtocol::OpenaiResponses => {
            let mut body = json!({ "model": model, "stream": true, "input": turns });
            if let Some(system) = system {
                body["instructions"] = json!(system);
            }
            if let Some(max) = request.max_tokens {
                body["max_output_tokens"] = json!(max);
            }
            ("responses", body)
        }
    }
}

/// Incremental SSE decoder: buffers bytes across chunks, handles one
/// `data:` line at a time. `key` masks echoed keys in error events.
struct Decoder<'a> {
    protocol: AiProtocol,
    key: &'a str,
    buf: Vec<u8>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    finished: bool,
}

impl<'a> Decoder<'a> {
    const fn new(protocol: AiProtocol, key: &'a str) -> Self {
        Self {
            protocol,
            key,
            buf: Vec::new(),
            input_tokens: None,
            output_tokens: None,
            finished: false,
        }
    }

    fn done(&self) -> ChatEvent {
        ChatEvent::Done {
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
        }
    }

    fn feed(&mut self, chunk: &[u8], emit: &mut dyn FnMut(ChatEvent)) -> Result<(), AppError> {
        self.buf.extend_from_slice(chunk);
        let mut start = 0;
        while let Some(end) = self.buf[start..].iter().position(|byte| *byte == b'\n') {
            let line = &self.buf[start..start + end];
            start += end + 1;
            if self.finished {
                break;
            }
            let Some(data) = std::str::from_utf8(line)
                .ok()
                .and_then(|line| line.trim_end().strip_prefix("data:"))
            else {
                continue;
            };
            let data = data.trim_start().to_owned();
            self.data(&data, emit)?;
        }
        self.buf.drain(..start);
        Ok(())
    }

    fn data(&mut self, data: &str, emit: &mut dyn FnMut(ChatEvent)) -> Result<(), AppError> {
        if data == "[DONE]" {
            self.finished = true;
            return Ok(());
        }
        // Non-JSON keep-alives and comments carry nothing.
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            return Ok(());
        };
        let text = match self.protocol {
            AiProtocol::AnthropicMessages => match event["type"].as_str() {
                Some("message_start") => {
                    self.input_tokens = event["message"]["usage"]["input_tokens"].as_u64();
                    None
                }
                Some("content_block_delta") => event["delta"]["text"].as_str(),
                Some("message_delta") => {
                    if let Some(tokens) = event["usage"]["output_tokens"].as_u64() {
                        self.output_tokens = Some(tokens);
                    }
                    None
                }
                Some("message_stop") => {
                    self.finished = true;
                    None
                }
                Some("error") => return Err(stream_error(json_message(&event, self.key))),
                _ => None,
            },
            AiProtocol::OpenaiChat => {
                if event.get("error").is_some() {
                    return Err(stream_error(json_message(&event, self.key)));
                }
                let usage = &event["usage"];
                if usage.is_object() {
                    self.input_tokens = usage["prompt_tokens"].as_u64();
                    self.output_tokens = usage["completion_tokens"].as_u64();
                }
                event["choices"][0]["delta"]["content"].as_str()
            }
            AiProtocol::OpenaiResponses => match event["type"].as_str() {
                Some("response.output_text.delta") => event["delta"].as_str(),
                Some("response.completed" | "response.incomplete") => {
                    let usage = &event["response"]["usage"];
                    self.input_tokens = usage["input_tokens"].as_u64();
                    self.output_tokens = usage["output_tokens"].as_u64();
                    self.finished = true;
                    None
                }
                Some("response.failed") => {
                    return Err(stream_error(json_message(&event["response"], self.key)));
                }
                Some("error") => return Err(stream_error(json_message(&event, self.key))),
                _ => None,
            },
        };
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            emit(ChatEvent::Delta {
                text: text.to_owned(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
    use super::*;

    /// Feeds `stream` split into chunks of every size from 1 to 7 bytes and
    /// checks each split yields the same events.
    fn decode(protocol: AiProtocol, stream: &str) -> Vec<ChatEvent> {
        let mut first: Option<Vec<ChatEvent>> = None;
        for size in 1..=7 {
            let mut decoder = Decoder::new(protocol, "sk-test");
            let mut events = Vec::new();
            for chunk in stream.as_bytes().chunks(size) {
                decoder
                    .feed(chunk, &mut |event| events.push(event))
                    .unwrap();
            }
            events.push(decoder.done());
            match &first {
                Some(first) => assert_eq!(&events, first, "chunk size {size}"),
                None => first = Some(events),
            }
        }
        first.unwrap()
    }

    fn delta(text: &str) -> ChatEvent {
        ChatEvent::Delta { text: text.into() }
    }

    fn done(input: u64, output: u64) -> ChatEvent {
        ChatEvent::Done {
            input_tokens: Some(input),
            output_tokens: Some(output),
        }
    }

    #[test]
    fn decodes_anthropic_stream() {
        let stream = "event: message_start\r\n\
            data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":1}}}\r\n\r\n\
            event: ping\ndata: {\"type\":\"ping\"}\n\n\
            data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hé\"}}\n\n\
            data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"llo 世界\"}}\n\n\
            data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n\
            data: {\"type\":\"message_stop\"}\n\n\
            data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"ignored\"}}\n\n";
        assert_eq!(
            decode(AiProtocol::AnthropicMessages, stream),
            [delta("Hé"), delta("llo 世界"), done(12, 7)]
        );
    }

    #[test]
    fn decodes_openai_chat_stream() {
        let stream = ": keep-alive\n\n\
            data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n\
            data:{\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n\
            data: {\"choices\":[{\"delta\":{\"content\":\", world\"}}],\"usage\":null}\n\n\
            data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":3}}\n\n\
            data: [DONE]\n\n\
            data: {\"choices\":[{\"delta\":{\"content\":\"ignored\"}}]}\n\n";
        assert_eq!(
            decode(AiProtocol::OpenaiChat, stream),
            [delta("你好"), delta(", world"), done(5, 3)]
        );
    }

    #[test]
    fn decodes_openai_responses_stream() {
        let stream = "event: response.created\ndata: {\"type\":\"response.created\"}\n\n\
            event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Ω mega\"}\n\n\
            data: {\"type\":\"response.output_text.delta\",\"delta\":\"!\"}\n\n\
            data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":2}}}\n\n";
        assert_eq!(
            decode(AiProtocol::OpenaiResponses, stream),
            [delta("Ω mega"), delta("!"), done(9, 2)]
        );
    }

    #[test]
    fn stream_error_events_carry_sanitized_upstream_text() {
        for (protocol, data, expected) in [
            (
                AiProtocol::AnthropicMessages,
                r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded sk-test"}}"#,
                "Overloaded ***",
            ),
            (
                AiProtocol::OpenaiChat,
                r#"{"error":{"message":"Bad  sk-test"}}"#,
                "Bad ***",
            ),
            (
                AiProtocol::OpenaiResponses,
                r#"{"type":"response.failed","response":{"error":{"code":"server_error","message":"Boom"}}}"#,
                "Boom",
            ),
            (
                AiProtocol::OpenaiResponses,
                r#"{"type":"error","code":"x","message":"Nope"}"#,
                "Nope",
            ),
            (
                AiProtocol::OpenaiResponses,
                r#"{"type":"response.failed"}"#,
                "AI provider reported a stream error",
            ),
        ] {
            let error = Decoder::new(protocol, "sk-test")
                .feed(format!("data: {data}\n").as_bytes(), &mut |_| {})
                .unwrap_err();
            assert_eq!(error.code(), ErrorCode::Internal);
            assert_eq!(error.message(), expected);
        }
    }

    fn request() -> ChatRequest {
        let message = |role, content: &str| ChatMessage {
            role,
            content: content.into(),
        };
        ChatRequest {
            messages: vec![
                message(ChatRole::System, "Be brief."),
                message(ChatRole::User, "Hi"),
                message(ChatRole::Assistant, "Hello"),
                message(ChatRole::System, "No lists."),
                message(ChatRole::User, "Why?"),
            ],
            max_tokens: None,
        }
    }

    fn turns() -> Value {
        json!([
            { "role": "user", "content": "Hi" },
            { "role": "assistant", "content": "Hello" },
            { "role": "user", "content": "Why?" },
        ])
    }

    #[test]
    fn builds_anthropic_body() {
        let (path, body) = build_body(AiProtocol::AnthropicMessages, "claude-x", &request());
        assert_eq!(path, "messages");
        assert_eq!(
            body,
            json!({
                "model": "claude-x", "max_tokens": 4096, "stream": true,
                "system": "Be brief.\n\nNo lists.", "messages": turns(),
            })
        );
    }

    #[test]
    fn builds_openai_chat_body() {
        let mut request = request();
        request.max_tokens = Some(64);
        let (path, body) = build_body(AiProtocol::OpenaiChat, "gpt-x", &request);
        assert_eq!(path, "chat/completions");
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["stream_options"], json!({ "include_usage": true }));
        assert_eq!(body["max_tokens"], json!(64));
        assert_eq!(body["messages"].as_array().unwrap().len(), 5);
        assert_eq!(
            body["messages"][0],
            json!({ "role": "system", "content": "Be brief." })
        );
        let (_, body) = build_body(AiProtocol::OpenaiChat, "gpt-x", &ChatRequest::default());
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn builds_openai_responses_body() {
        let (path, body) = build_body(AiProtocol::OpenaiResponses, "gpt-x", &request());
        assert_eq!(path, "responses");
        assert_eq!(
            body,
            json!({
                "model": "gpt-x", "stream": true,
                "instructions": "Be brief.\n\nNo lists.", "input": turns(),
            })
        );
    }

    #[test]
    fn serializes_events() {
        assert_eq!(
            serde_json::to_value(delta("a")).unwrap(),
            json!({ "kind": "delta", "text": "a" })
        );
        assert_eq!(
            serde_json::to_value(ChatEvent::Done {
                input_tokens: Some(1),
                output_tokens: None
            })
            .unwrap(),
            json!({ "kind": "done", "inputTokens": 1, "outputTokens": null })
        );
    }
}
