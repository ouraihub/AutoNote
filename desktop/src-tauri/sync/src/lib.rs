//! Durable synchronization with the existing AutoNote Worker HTTP/WS protocol.
pub mod attachments;
pub mod pull;
pub mod push;
pub mod remote;
pub mod service;
mod session;

pub use remote::{CallOptions, RemoteClient, RemoteError};
pub use service::{
    BindPreview, BindStrategy, LoginReply, SecretStore, StatusSink, SyncService, SyncStatus,
};
pub use session::{SessionCookie, SiteOrigin};
