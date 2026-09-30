//! AutoNote domain kernel.
//!
//! Every entry point (Tauri commands, MCP server, sync engine) goes through this
//! crate. None of them may open the SQLite file or write SQL on their own.

pub mod db;
pub mod error;

pub use db::Library;
pub use error::AppError;
