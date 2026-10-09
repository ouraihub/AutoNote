//! Probe and chat against a raw HTTP/1.1 server on loopback.
#![allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]

use std::time::Duration;

use note_ai::{ChatEvent, ChatMessage, ChatRequest, ChatRole, ProbeErrorKind, chat_stream, probe};
use note_core::{ErrorCode, ai::AiProtocol};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

/// Serves one connection: reads the request, writes `parts` with a pause
/// between them, then closes (or holds the socket open when `hold`).
/// Returns the base URL and the received request text.
async fn serve(parts: Vec<&'static str>, hold: bool) -> (String, JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let read = socket.read(&mut chunk).await.unwrap();
            buf.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some(head_end) = text.find("\r\n\r\n") {
                let length = text[..head_end]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if buf.len() >= head_end + 4 + length || read == 0 {
                    break;
                }
            }
        }
        for part in parts {
            socket.write_all(part.as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if hold {
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        String::from_utf8(buf).unwrap()
    });
    (base, handle)
}

const SSE_HEAD: &str =
    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";

fn messages() -> ChatRequest {
    ChatRequest {
        messages: vec![
            ChatMessage {
                role: ChatRole::System,
                content: "Be brief.".into(),
            },
            ChatMessage {
                role: ChatRole::User,
                content: "Hi".into(),
            },
        ],
        max_tokens: None,
    }
}

#[tokio::test]
async fn probe_lists_models() {
    let (base, server) = serve(
        vec![
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            r#"{"data":[{"id":"gpt-4.1"},{"id":"o3"},{"id":"gpt-4.1"}]}"#,
        ],
        false,
    )
    .await;
    let result = probe(&format!("{base}/"), AiProtocol::OpenaiChat, Some("sk-test")).await;
    assert_eq!(result.probe_url, format!("{base}/v1/models"));
    assert_eq!(result.error, None);
    let ids: Vec<_> = result.models.iter().map(|m| m.model.id.as_str()).collect();
    assert_eq!(ids, ["gpt-4.1", "o3"]);
    assert_eq!(result.models[1].group.as_deref(), Some("gpt"));
    let request = server.await.unwrap();
    assert!(request.starts_with("GET /v1/models HTTP/1.1\r\n"));
    assert!(
        request
            .to_lowercase()
            .contains("authorization: bearer sk-test\r\n")
    );
}

#[tokio::test]
async fn probe_reports_unauthorized() {
    let (base, _server) = serve(
        vec!["HTTP/1.1 401 Unauthorized\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret"],
        false,
    )
    .await;
    let result = probe(&base, AiProtocol::AnthropicMessages, Some("sk-test")).await;
    let error = result.error.unwrap();
    assert_eq!(
        (error.kind, error.status),
        (ProbeErrorKind::Unauthorized, Some(401))
    );
    assert!(result.models.is_empty());
}

#[tokio::test]
async fn probe_reports_invalid_body() {
    let (base, _server) = serve(
        vec!["HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\n<html>"],
        false,
    )
    .await;
    let result = probe(&base, AiProtocol::OpenaiChat, Some("sk-test")).await;
    assert_eq!(result.error.unwrap().kind, ProbeErrorKind::InvalidBody);
}

#[tokio::test]
async fn probe_without_key_skips_request() {
    let result = probe("http://127.0.0.1:9", AiProtocol::OpenaiChat, Some("  ")).await;
    assert_eq!(result.error.unwrap().kind, ProbeErrorKind::MissingKey);
    assert_eq!(result.probe_url, "http://127.0.0.1:9/v1/models");
}

#[tokio::test]
async fn chat_streams_openai_deltas_and_usage() {
    let (base, server) = serve(
        vec![
            SSE_HEAD,
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel",
            "lo\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" there\"}}]}\n",
            "\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2}}\n\nda",
            "ta: [DONE]\n\n",
        ],
        false,
    )
    .await;
    let mut events = Vec::new();
    chat_stream(
        &base,
        AiProtocol::OpenaiChat,
        "sk-test",
        "gpt-x",
        &messages(),
        &CancellationToken::new(),
        &mut |event| events.push(event),
    )
    .await
    .unwrap();
    assert_eq!(
        events,
        [
            ChatEvent::Delta {
                text: "Hello".into()
            },
            ChatEvent::Delta {
                text: " there".into()
            },
            ChatEvent::Done {
                input_tokens: Some(4),
                output_tokens: Some(2)
            },
        ]
    );
    let request = server.await.unwrap();
    assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
    assert!(
        request
            .to_lowercase()
            .contains("authorization: bearer sk-test\r\n")
    );
    assert!(request.contains(r#""include_usage":true"#));
}

#[tokio::test]
async fn chat_sends_anthropic_headers() {
    let (base, server) = serve(
        vec![
            SSE_HEAD,
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"ok\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":1}}\n\ndata: {\"type\":\"message_stop\"}\n\n",
        ],
        false,
    )
    .await;
    let mut events = Vec::new();
    chat_stream(
        &format!("{base}/v1"),
        AiProtocol::AnthropicMessages,
        "sk-ant",
        "claude-x",
        &messages(),
        &CancellationToken::new(),
        &mut |event| events.push(event),
    )
    .await
    .unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[1],
        ChatEvent::Done {
            input_tokens: Some(3),
            output_tokens: Some(1)
        }
    );
    let request = server.await.unwrap().to_lowercase();
    assert!(request.starts_with("post /v1/messages http/1.1\r\n"));
    assert!(request.contains("x-api-key: sk-ant\r\n"));
    assert!(request.contains("anthropic-version: 2023-06-01\r\n"));
    assert!(!request.contains("authorization:"));
    assert!(request.contains(r#""system":"be brief.""#));
}

#[tokio::test]
async fn chat_maps_rate_limit_with_upstream_text() {
    let (base, _server) = serve(
        vec!["HTTP/1.1 429 Too Many Requests\r\nContent-Length: 19\r\nConnection: close\r\n\r\nquota left: sk-test"],
        false,
    )
    .await;
    let error = chat_stream(
        &base,
        AiProtocol::OpenaiResponses,
        "sk-test",
        "gpt-x",
        &messages(),
        &CancellationToken::new(),
        &mut |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), ErrorCode::TooManyAttempts);
    assert_eq!(error.message(), "429: quota left: ***");
}

/// Real NewAPI relay body for a model with no channel.
const NO_CHANNEL: &str = concat!(
    "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
    r#"{"error":{"message":"No available channel for model gpt-5.4 under group codex (distributor) (request id: 2026)","type":"new_api_error","param":"","code":"model_not_found"}}"#,
);

#[tokio::test]
async fn probe_reports_upstream_message() {
    let (base, _server) = serve(vec![NO_CHANNEL], false).await;
    let result = probe(&base, AiProtocol::OpenaiChat, Some("sk-test")).await;
    let error = result.error.unwrap();
    assert_eq!(
        (error.kind, error.status),
        (ProbeErrorKind::Status, Some(503))
    );
    assert!(error.message.unwrap().contains("No available channel"));
}

#[tokio::test]
async fn chat_reports_upstream_message() {
    let (base, _server) = serve(vec![NO_CHANNEL], false).await;
    let error = chat_stream(
        &base,
        AiProtocol::OpenaiChat,
        "sk-test",
        "gpt-5.4",
        &messages(),
        &CancellationToken::new(),
        &mut |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), ErrorCode::Internal);
    assert!(
        error.message().starts_with("503: No available channel"),
        "{}",
        error.message()
    );
}

#[tokio::test]
async fn chat_cancels_mid_stream() {
    let (base, _server) = serve(
        vec![
            SSE_HEAD,
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\n\n",
        ],
        true,
    )
    .await;
    let cancel = CancellationToken::new();
    let mut events = Vec::new();
    let error = chat_stream(
        &base,
        AiProtocol::OpenaiResponses,
        "sk-test",
        "gpt-x",
        &messages(),
        &cancel,
        &mut |event| {
            cancel.cancel();
            events.push(event);
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), ErrorCode::Cancelled);
    assert_eq!(
        events,
        [ChatEvent::Delta {
            text: "first".into()
        }]
    );
}

#[tokio::test]
async fn chat_maps_refused_connection_to_offline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let error = chat_stream(
        &base,
        AiProtocol::OpenaiChat,
        "sk-test",
        "gpt-x",
        &messages(),
        &CancellationToken::new(),
        &mut |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), ErrorCode::Offline);
}

#[tokio::test]
async fn chat_rejects_stream_without_terminator() {
    let (base, _server) = serve(
        vec![
            SSE_HEAD,
            "data: {\"choices\":[{\"delta\":{\"content\":\"half\"}}]}\n\n",
        ],
        false,
    )
    .await;
    let error = chat_stream(
        &base,
        AiProtocol::OpenaiChat,
        "sk-test",
        "gpt-x",
        &messages(),
        &CancellationToken::new(),
        &mut |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), ErrorCode::Internal);
}
