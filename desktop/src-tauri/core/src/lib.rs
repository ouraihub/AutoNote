//! AutoNote domain kernel.
//!
//! Every entry point (Tauri commands, MCP server, sync engine) goes through this
//! crate. None of them may open the SQLite file or write SQL on their own.
//!
//! This file is the crate's only public entry. Modules stay private; their
//! contract types are re-exported below. No connection, transaction or row
//! type is exported.

pub mod ai;
#[path = "db/mod.rs"]
mod db;
mod dto;
mod error;
mod files;
pub mod id;
pub mod markdown;
pub mod mcp;
#[path = "mcp_read.rs"]
mod mcp_read;
mod prefs;
mod query;
pub mod sync;
pub mod transfer;
mod types;
mod write;

pub use db::{Clock, Library, LibraryDeps, SystemClock};
pub use dto::{
    Attachment, AttachmentPage, AttachmentWithUsage, Backlink, CreateNoteBody, DeletedEntity,
    FlushResult, Folder, FolderCreate, FolderPatch, ListNotesResponse, Note, NoteSummary,
    NoteVersion, NoteVersionMeta, NoteWriteResult, PatchNoteBody, ProgressEvent, ProgressPhase,
    PruneResult, SyncDeletion, SyncResponse, Tag, TagCreate, TagPatch, parse_input,
};
pub use error::{AppError, Entity, Error, ErrorCode, ErrorDetails};
pub use files::{CHUNK_MAX_BYTES, UploadBegin};
pub use prefs::{Appearance, Backup, Editor, Preview, Sync, UserSettings};
pub use query::{
    GraphEdge, GraphMeta, GraphNode, GraphQuery, GraphResponse, GraphTag, ListNotesQuery,
    NoteOrder, NoteSort, NoteView, SearchHit, SearchMode, SearchQuery, SearchResponse, SearchTerms,
};
pub use sync::{ConflictSummary, QuarantinedSummary};
pub use types::{
    AttachmentId, Cursor, FolderId, MAX_SAFE_INTEGER, Millis, NoteId, RemoteRev, Rev, TagId,
    VersionId,
};
pub use write::{
    ChangeSet, ChangeSink, FolderDeleteResult, FolderDeleteStrategy, IdSource, NewNote, NotePatch,
    RandomIds, TagPatchResult, TagRemoveResult, WriteEvent, WriteOrigin, Written,
};
