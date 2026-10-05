//! Frozen desktop MCP tool contract copied from Worker `server.ts`.
//!
//! This is deliberately dependency-free: the actual JSON Schema and protocol
//! encoding are owned by the MCP SDK once the locked dependency is available.

/// Tool permission class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolScope {
    /// Read-only operation.
    Read,
    /// Mutating operation.
    Write,
    /// Destructive trash operation.
    Trash,
}

/// MCP annotations used by clients for planning and display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolAnnotations {
    /// Whether the operation only reads data.
    pub read_only_hint: bool,
    /// Whether it can destroy or remove data.
    pub destructive_hint: bool,
    /// Whether repeating the same request is safe.
    pub idempotent_hint: bool,
}

/// A frozen tool entry. `input_schema` points at the fixture's JSON Schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolSpec {
    /// Worker-compatible name.
    pub name: &'static str,
    /// Scope checked before invocation.
    pub scope: ToolScope,
    /// Annotation metadata.
    pub annotations: ToolAnnotations,
    /// JSON pointer in `fixtures/mcp-tools.json`.
    pub input_schema: &'static str,
}

const READ: ToolAnnotations = ToolAnnotations {
    read_only_hint: true,
    destructive_hint: false,
    idempotent_hint: true,
};
const WRITE: ToolAnnotations = ToolAnnotations {
    read_only_hint: false,
    destructive_hint: false,
    idempotent_hint: true,
};
const DESTRUCTIVE: ToolAnnotations = ToolAnnotations {
    read_only_hint: false,
    destructive_hint: true,
    idempotent_hint: true,
};

/// Exactly the 34 local knowledge-base tools; cloud backup/share tools are excluded.
pub const TOOLS: [ToolSpec; 34] = [
    ToolSpec {
        name: "search",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/search/inputSchema",
    },
    ToolSpec {
        name: "fetch",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/fetch/inputSchema",
    },
    ToolSpec {
        name: "search_notes",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/search_notes/inputSchema",
    },
    ToolSpec {
        name: "list_notes",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/list_notes/inputSchema",
    },
    ToolSpec {
        name: "read_note",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/read_note/inputSchema",
    },
    ToolSpec {
        name: "get_note_context",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/get_note_context/inputSchema",
    },
    ToolSpec {
        name: "list_folders",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/list_folders/inputSchema",
    },
    ToolSpec {
        name: "list_tags",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/list_tags/inputSchema",
    },
    ToolSpec {
        name: "create_note",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/create_note/inputSchema",
    },
    ToolSpec {
        name: "edit_note",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/edit_note/inputSchema",
    },
    ToolSpec {
        name: "organize_note",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/organize_note/inputSchema",
    },
    ToolSpec {
        name: "trash_note",
        scope: ToolScope::Trash,
        annotations: DESTRUCTIVE,
        input_schema: "#/tools/trash_note/inputSchema",
    },
    ToolSpec {
        name: "restore_note",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/restore_note/inputSchema",
    },
    ToolSpec {
        name: "duplicate_note",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/duplicate_note/inputSchema",
    },
    ToolSpec {
        name: "list_note_versions",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/list_note_versions/inputSchema",
    },
    ToolSpec {
        name: "read_note_version",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/read_note_version/inputSchema",
    },
    ToolSpec {
        name: "restore_note_version",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/restore_note_version/inputSchema",
    },
    ToolSpec {
        name: "create_folder",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/create_folder/inputSchema",
    },
    ToolSpec {
        name: "update_folder",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/update_folder/inputSchema",
    },
    ToolSpec {
        name: "create_tag",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/create_tag/inputSchema",
    },
    ToolSpec {
        name: "update_tag",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/update_tag/inputSchema",
    },
    ToolSpec {
        name: "preview_tag_change",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/preview_tag_change/inputSchema",
    },
    ToolSpec {
        name: "delete_tag",
        scope: ToolScope::Write,
        annotations: DESTRUCTIVE,
        input_schema: "#/tools/delete_tag/inputSchema",
    },
    ToolSpec {
        name: "preview_folder_removal",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/preview_folder_removal/inputSchema",
    },
    ToolSpec {
        name: "remove_folder_and_promote_contents",
        scope: ToolScope::Write,
        annotations: DESTRUCTIVE,
        input_schema: "#/tools/remove_folder_and_promote_contents/inputSchema",
    },
    ToolSpec {
        name: "bulk_organize_notes",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/bulk_organize_notes/inputSchema",
    },
    ToolSpec {
        name: "list_attachments",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/list_attachments/inputSchema",
    },
    ToolSpec {
        name: "read_attachment",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/read_attachment/inputSchema",
    },
    ToolSpec {
        name: "upload_attachment",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/upload_attachment/inputSchema",
    },
    ToolSpec {
        name: "delete_attachment",
        scope: ToolScope::Write,
        annotations: DESTRUCTIVE,
        input_schema: "#/tools/delete_attachment/inputSchema",
    },
    ToolSpec {
        name: "get_note_properties",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/get_note_properties/inputSchema",
    },
    ToolSpec {
        name: "update_note_properties",
        scope: ToolScope::Write,
        annotations: WRITE,
        input_schema: "#/tools/update_note_properties/inputSchema",
    },
    ToolSpec {
        name: "query_note_properties",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/query_note_properties/inputSchema",
    },
    ToolSpec {
        name: "explore_note_graph",
        scope: ToolScope::Read,
        annotations: READ,
        input_schema: "#/tools/explore_note_graph/inputSchema",
    },
];

/// Looks up a frozen tool by exact name.
#[must_use]
pub fn find_tool(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|tool| tool.name == name)
}
