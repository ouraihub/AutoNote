use axum::http::request::Parts;
use std::future::Future;
use std::sync::{Arc, LazyLock};

use rmcp::{
    ErrorData as McpError, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool, ToolAnnotations,
    },
    service::{RequestContext, RoleServer},
};
use serde_json::{Value, json};

use crate::{McpServer, Scope, TOOLS, find_tool};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../fixtures/mcp-tools.json"))
        .unwrap_or_else(|_| json!({}))
});

/// rmcp handler for the frozen local tool registry.
pub struct McpHandler {
    server: Arc<McpServer>,
}

impl McpHandler {
    pub(crate) fn new(server: Arc<McpServer>) -> Self {
        Self { server }
    }

    fn tool_definition(name: &str) -> Option<Tool> {
        let spec = find_tool(name)?;
        let entry = FIXTURE
            .get("tools")?
            .as_array()?
            .iter()
            .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))?;
        let schema = entry.get("inputSchema")?.as_object()?.clone();
        let annotations = ToolAnnotations::new()
            .read_only(spec.annotations.read_only_hint)
            .destructive(spec.annotations.destructive_hint)
            .idempotent(spec.annotations.idempotent_hint);
        Some(
            Tool::new(
                name.to_owned(),
                "AutoNote local knowledge-base operation",
                schema,
            )
            .with_annotations(annotations),
        )
    }

    fn error(code: &str, message: &str) -> CallToolResponse {
        CallToolResult::structured_error(json!({ "error": { "code": code, "message": message } }))
            .into()
    }

    async fn call_domain(
        server: Arc<McpServer>,
        name: String,
        args: Value,
        write: bool,
    ) -> Result<Value, (String, String)> {
        let result = tokio::task::spawn_blocking(move || {
            if write {
                server.library().execute_mcp_write(&name, &args)
            } else {
                server.library().execute_mcp_read(&name, &args)
            }
        })
        .await
        .map_err(|_| ("internal".into(), "Internal error".into()))?;
        result.map_err(|error| (error.code().as_str().to_owned(), error.message().to_owned()))
    }
}

impl ServerHandler for McpHandler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(rmcp::model::Implementation::new(
                "autonote",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions("AutoNote local knowledge base")
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, McpError>> + rmcp::service::MaybeSendFuture + '_
    {
        let tools = TOOLS
            .iter()
            .filter_map(|spec| Self::tool_definition(spec.name))
            .collect();
        std::future::ready(Ok(ListToolsResult::with_all_items(tools)))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        Self::tool_definition(name)
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, McpError>> + rmcp::service::MaybeSendFuture + '_
    {
        let name = request.name.to_string();
        let args = Value::Object(request.arguments.unwrap_or_default());
        let server = self.server.clone();
        let result = async move {
            if context.ct.is_cancelled() {
                return Ok(Self::error("cancelled", "request cancelled"));
            }
            let spec =
                find_tool(&name).ok_or_else(|| McpError::invalid_params("unknown tool", None))?;
            if serde_json::to_vec(&args)
                .map_or(true, |body| body.len() > crate::request_limit(&name))
            {
                return Ok(Self::error(
                    "payload_too_large",
                    "Request exceeds the allowed size",
                ));
            }
            let scope = match spec.scope {
                crate::ToolScope::Read => Scope::Read,
                crate::ToolScope::Write => Scope::Write,
                crate::ToolScope::Trash => Scope::Trash,
            };
            let token = context
                .extensions
                .get::<Parts>()
                .and_then(|parts| parts.headers.get(axum::http::header::AUTHORIZATION))
                .and_then(|header| header.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
                .filter(|token| !token.is_empty())
                .unwrap_or_default();
            if token.is_empty() {
                return Ok(Self::error("unauthenticated", "authentication required"));
            }
            if let Err(error) = server.authorize(token, scope, crate::now_millis()) {
                let code = match error {
                    crate::AuthError::Forbidden => "forbidden",
                    _ => "unauthenticated",
                };
                return Ok(Self::error(code, "MCP authorization failed"));
            }
            let write = !matches!(spec.scope, crate::ToolScope::Read);
            match Self::call_domain(server, name.clone(), args, write).await {
                Ok(value) => {
                    let value = if write || !matches!(name.as_str(), "search" | "fetch") {
                        json!({"data": value})
                    } else {
                        value
                    };
                    Ok(CallToolResult::structured(value).into())
                }
                Err((code, message)) => Ok(Self::error(&code, &message)),
            }
        };
        Box::pin(result)
    }
}
