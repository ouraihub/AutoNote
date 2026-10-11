//! AutoNote MCP tool registry adapted to Aether's MCP server.
mod schema;

pub use schema::{SCOPES, TOOLS, ToolAnnotations, ToolScope, ToolSpec, exposed_tools, find_tool};
