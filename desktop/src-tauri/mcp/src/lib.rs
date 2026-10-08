//! Local MCP service; rmcp owns the protocol and Streamable HTTP lifecycle.
mod auth;
mod handler;
mod schema;
mod transport;

pub use auth::{
    AuthError, IssuedToken, Preferences, Scope, TokenRecord, TokenStore, authorize, now_millis,
};
pub use handler::McpHandler;
use note_core::Library;
pub use schema::{TOOLS, ToolAnnotations, ToolScope, ToolSpec, find_tool};
use std::net::SocketAddr;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Default local MCP port.
pub const DEFAULT_PORT: u16 = 7714;
/// Ordinary request maximum.
pub const REQUEST_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Upload request maximum.
pub const UPLOAD_REQUEST_MAX_BYTES: usize = 48 * 1024 * 1024;

/// Local listener and permission configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpConfig {
    pub port: u16,
    pub enabled: bool,
    pub preferences: Preferences,
    pub trusted_origins: Vec<String>,
}
impl Default for McpConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            enabled: false,
            preferences: Preferences::default(),
            trusted_origins: Vec::new(),
        }
    }
}

struct Listener {
    task: JoinHandle<Result<(), std::io::Error>>,
    cancellation: CancellationToken,
}
/// Local MCP service shared by the desktop composition root.
pub struct McpServer {
    library: Arc<Library>,
    config: Mutex<McpConfig>,
    listener: tokio::sync::Mutex<Option<Listener>>,
    closed: AtomicBool,
}
impl McpServer {
    #[must_use]
    pub fn new(library: Arc<Library>, mut config: McpConfig) -> Self {
        if let Ok(preferences) = library.mcp_preferences() {
            config.preferences = Preferences {
                write_enabled: preferences.write_enabled,
                trash_enabled: preferences.trash_enabled,
            };
        }
        Self {
            library,
            config: Mutex::new(config),
            listener: tokio::sync::Mutex::new(None),
            closed: AtomicBool::new(false),
        }
    }
    /// Shared domain library.
    #[must_use]
    pub fn library(&self) -> &Arc<Library> {
        &self.library
    }
    /// Returns listener configuration.
    /// # Errors
    /// Returns an error on poisoned state.
    pub fn config(&self) -> Result<McpConfig, AuthError> {
        self.config
            .lock()
            .map(|config| config.clone())
            .map_err(|_| AuthError::InvalidInput)
    }
    /// Changes the port while stopped.
    /// # Errors
    /// Returns an error for invalid ports or active listener state.
    pub fn set_port(&self, port: u16) -> Result<(), AuthError> {
        if port < 1024 {
            return Err(AuthError::InvalidInput);
        }
        let mut config = self.config.lock().map_err(|_| AuthError::InvalidInput)?;
        if config.enabled {
            return Err(AuthError::InvalidInput);
        }
        config.port = port;
        Ok(())
    }
    /// Persists local guards without expanding existing token scopes.
    /// # Errors
    /// Returns storage or state errors.
    pub fn set_preferences(&self, preferences: Preferences) -> Result<(), AuthError> {
        let now = timestamp(now_millis())?;
        self.library
            .set_mcp_preferences(
                note_core::mcp::McpPreferences {
                    write_enabled: preferences.write_enabled,
                    trash_enabled: preferences.trash_enabled,
                    updated_at: now,
                },
                now,
            )
            .map_err(|_| AuthError::Listener)?;
        self.config
            .lock()
            .map_err(|_| AuthError::InvalidInput)?
            .preferences = preferences;
        Ok(())
    }
    /// Starts a serialized loopback-only SDK listener.
    /// # Errors
    /// Returns an error on bind failure or after terminal shutdown.
    pub async fn start(self: &Arc<Self>) -> Result<(), AuthError> {
        let mut active = self.listener.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(AuthError::Listener);
        }
        if active
            .as_ref()
            .is_some_and(|listener| !listener.task.is_finished())
        {
            return Ok(());
        }
        let config = self.config()?;
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port))
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied => {
                    AuthError::PortInUse
                }
                _ => AuthError::Listener,
            })?;
        let cancellation = CancellationToken::new();
        let shutdown = cancellation.clone();
        let router = transport::router(self.clone(), &config, cancellation.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await
        });
        *active = Some(Listener { task, cancellation });
        self.config
            .lock()
            .map_err(|_| AuthError::InvalidInput)?
            .enabled = true;
        Ok(())
    }
    /// Stops the listener; SDK cancellation terminates protocol sessions.
    /// # Errors
    /// Returns an error on listener or state failure.
    pub async fn stop(&self) -> Result<(), AuthError> {
        let mut active = self.listener.lock().await;
        if let Some(listener) = active.take() {
            listener.cancellation.cancel();
            listener
                .task
                .await
                .map_err(|_| AuthError::Listener)?
                .map_err(|_| AuthError::Listener)?;
        }
        self.config
            .lock()
            .map_err(|_| AuthError::InvalidInput)?
            .enabled = false;
        Ok(())
    }
    /// Prevents restart and stops protocol acceptance. The host first fences Library writes.
    /// # Errors
    /// Returns an error if listener shutdown fails.
    pub async fn shutdown(&self) -> Result<(), AuthError> {
        self.closed.store(true, Ordering::Release);
        self.stop().await
    }
    /// Actual listener state rather than a preference flag.
    pub async fn is_running(&self) -> bool {
        self.listener
            .lock()
            .await
            .as_ref()
            .is_some_and(|listener| !listener.task.is_finished())
    }
    /// Issues a one-time bearer from host-provided OS entropy and persists only its digest.
    /// # Errors
    /// Returns validation, policy or storage failures.
    pub fn issue_token(
        &self,
        id: String,
        name: String,
        entropy: &[u8],
        scopes: Vec<Scope>,
        now: u64,
    ) -> Result<IssuedToken, AuthError> {
        let preferences = self.config()?.preferences;
        for scope in &scopes {
            authorize(*scope, preferences)?;
        }
        let issued = TokenStore::default().issue(id, name, entropy, scopes, now)?;
        let record = &issued.record;
        self.library
            .mcp_insert_token(&note_core::mcp::McpToken {
                id: record.id.clone(),
                name: record.name.clone(),
                token_hash: record.token_hash.clone(),
                scopes: record
                    .scopes
                    .iter()
                    .map(|scope| scope.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
                created_at: timestamp(now)?,
                last_used_at: None,
                revoked_at: None,
            })
            .map_err(|_| AuthError::Listener)?;
        Ok(issued)
    }
    /// Revokes an existing key immediately.
    /// # Errors
    /// Returns storage failures.
    pub fn revoke_token(&self, id: &str, now: u64) -> Result<(), AuthError> {
        self.library
            .mcp_revoke_token(id, timestamp(now)?)
            .map_err(|_| AuthError::Listener)
    }
    /// Lists durable key metadata, never bearer material.
    /// # Errors
    /// Returns storage failures.
    pub fn token_records(&self) -> Result<Vec<TokenRecord>, AuthError> {
        self.library
            .mcp_tokens()
            .map(|records| {
                records
                    .into_iter()
                    .map(|record| TokenRecord {
                        id: record.id,
                        name: record.name,
                        token_hash: record.token_hash,
                        scopes: record
                            .scopes
                            .split(',')
                            .filter_map(|scope| match scope {
                                "notes:read" => Some(Scope::Read),
                                "notes:write" => Some(Scope::Write),
                                "notes:trash" => Some(Scope::Trash),
                                _ => None,
                            })
                            .collect(),
                        created_at: record.created_at as u64,
                        last_used_at: record.last_used_at.map(|at| at as u64),
                        revoked_at: record.revoked_at.map(|at| at as u64),
                    })
                    .collect()
            })
            .map_err(|_| AuthError::Listener)
    }
    /// Rechecks durable revocation and permissions on every invocation.
    /// # Errors
    /// Returns authentication, policy, or storage failure.
    pub fn authorize(&self, token: &str, scope: Scope, now: u64) -> Result<(), AuthError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(AuthError::Listener);
        }
        if !self
            .library
            .mcp_authenticate(token, "", timestamp(now)?)
            .map_err(|_| AuthError::Listener)?
        {
            return Err(AuthError::Unauthenticated);
        }
        authorize(scope, self.config()?.preferences)?;
        if !self
            .library
            .mcp_authenticate(token, scope.as_str(), timestamp(now)?)
            .map_err(|_| AuthError::Listener)?
        {
            return Err(AuthError::Forbidden);
        }
        Ok(())
    }
    /// Frozen tools.
    #[must_use]
    pub fn tools(&self) -> &'static [ToolSpec; 34] {
        &TOOLS
    }
}
fn timestamp(now: u64) -> Result<i64, AuthError> {
    i64::try_from(now).map_err(|_| AuthError::InvalidInput)
}
/// Rejects nonloopback addresses.
/// # Errors
/// Returns an error for a nonloopback address.
pub fn require_loopback(address: SocketAddr) -> Result<(), AuthError> {
    if address.ip().is_loopback() {
        Ok(())
    } else {
        Err(AuthError::InvalidInput)
    }
}
/// Per-tool body limit.
#[must_use]
pub fn request_limit(tool: &str) -> usize {
    if tool == "upload_attachment" {
        UPLOAD_REQUEST_MAX_BYTES
    } else {
        REQUEST_MAX_BYTES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn busy_port_is_reported_distinctly_and_leaves_service_stopped()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = std::env::temp_dir().join(format!("note-mcp-port-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let library = Arc::new(Library::open(&dir.join("library.db"))?);
        let holder = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        let port = holder.local_addr()?.port();
        let server = Arc::new(McpServer::new(
            library,
            McpConfig {
                port,
                ..McpConfig::default()
            },
        ));
        assert!(matches!(server.start().await, Err(AuthError::PortInUse)));
        assert!(!server.is_running().await);
        drop(holder);
        assert!(server.start().await.is_ok());
        assert!(server.is_running().await);
        assert!(server.stop().await.is_ok());
        drop(server);
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
