//! rmcp Streamable HTTP transport assembly. The SDK owns JSON-RPC and lifecycle.
use axum::Router;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use crate::{McpConfig, McpServer};

/// Builds the loopback-only rmcp service. The caller owns the listener task.
pub fn router(
    server: Arc<McpServer>,
    config: &McpConfig,
    cancellation: CancellationToken,
) -> Router {
    let session_manager = Arc::new(LocalSessionManager::default());
    let http_config = StreamableHttpServerConfig::default()
        .with_allowed_hosts(["localhost", "127.0.0.1", "[::1]", "::1"])
        .with_allowed_origins(config.trusted_origins.iter().map(String::as_str))
        .enforce_origin_validation()
        .with_max_request_body_bytes(crate::UPLOAD_REQUEST_MAX_BYTES)
        .with_json_response(true)
        .with_cancellation_token(cancellation)
        .with_legacy_session_mode(true);
    let service = StreamableHttpService::new(
        move || Ok(crate::handler::McpHandler::new(server.clone())),
        session_manager,
        http_config,
    );
    Router::new().nest_service("/mcp", service)
}
