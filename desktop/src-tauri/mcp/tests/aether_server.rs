#![allow(
    clippy::expect_used,
    clippy::unnecessary_lazy_evaluations,
    reason = "acceptance assertions report concrete failures"
)]
use std::sync::{Arc, OnceLock};

use aether_mcp_server::{McpServer, ServerConfig};
use note_core::Library;
use reqwest::Client;
use serde_json::{Value, json};
use tempfile::tempdir;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("free port")
        .local_addr()
        .expect("local address")
        .port()
}

async fn rpc(
    client: &Client,
    port: u16,
    token: Option<&str>,
    origin: Option<&str>,
    method: &str,
    params: Value,
) -> (u16, Value) {
    let mut request = client
        .post(format!("http://127.0.0.1:{port}/mcp"))
        .header("accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    let response = request.send().await.expect("MCP response");
    let status = response.status().as_u16();
    let text = response.text().await.expect("MCP body");
    let body = serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text));
    (status, body)
}

#[tokio::test(flavor = "multi_thread")]
async fn aether_mcp_real_http_scope_revoke_origin_and_idempotency() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(Library::open(&dir.path().join("library.db")).expect("library"));
    let cell = Arc::new(OnceLock::from(library));
    let port = free_port();
    let server = McpServer::new(
        dir.path(),
        ServerConfig {
            default_port: port,
            token_prefix: "autonote",
        },
        note_mcp::SCOPES.to_vec(),
        note_mcp::exposed_tools(cell),
    )
    .expect("Aether MCP server");
    server
        .set_enabled_scopes(&["notes:read", "notes:write", "notes:trash"])
        .expect("enable scopes");
    let read = server
        .issue_token("read", &["notes:read"])
        .expect("read token");
    let write = server
        .issue_token("write", &["notes:read", "notes:write", "notes:trash"])
        .expect("write token");
    let status = server.start().await.expect("start server");
    let port = status.port;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let client = Client::builder().no_proxy().build().expect("HTTP client");

    let (status, body) = rpc(&client, port, Some(&read.token), None, "initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"acceptance","version":"1"}})).await;
    assert_eq!(status, 200);
    assert!(body["result"]["capabilities"]["tools"].is_object());

    let (status, body) = rpc(
        &client,
        port,
        Some(&read.token),
        None,
        "tools/list",
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    let read_tools = body["result"]["tools"].as_array().expect("read tools");
    assert_eq!(read_tools.len(), 17);
    assert!(read_tools.iter().all(|tool| {
        !tool["name"]
            .as_str()
            .unwrap_or_default()
            .contains("create_note")
    }));

    let (status, body) = rpc(
        &client,
        port,
        Some(&write.token),
        None,
        "tools/list",
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        body["result"]["tools"].as_array().expect("all tools").len(),
        34
    );

    let args =
        json!({"operation_id":"acceptance-create-1","title":"acceptance","content":"loopback"});
    let (status, first) = rpc(
        &client,
        port,
        Some(&write.token),
        None,
        "tools/call",
        json!({"name":"create_note","arguments":args}),
    )
    .await;
    assert_eq!(status, 200);
    let (status, second) = rpc(
        &client,
        port,
        Some(&write.token),
        None,
        "tools/call",
        json!({"name":"create_note","arguments":args}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        first["result"]["structuredContent"],
        second["result"]["structuredContent"]
    );

    let (status, _) = rpc(
        &client,
        port,
        Some(&write.token),
        Some("http://evil.example"),
        "tools/list",
        json!({}),
    )
    .await;
    assert_eq!(status, 403);
    server.revoke_token(&write.record.id).expect("revoke token");
    let (status, _) = rpc(
        &client,
        port,
        Some(&write.token),
        None,
        "tools/list",
        json!({}),
    )
    .await;
    assert_eq!(status, 401);
    server.stop().await.expect("stop server");
}
