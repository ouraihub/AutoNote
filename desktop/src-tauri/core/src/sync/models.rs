use crate::dto::{Folder, Note, SyncDeletion, Tag};
use crate::write::DirtyEntity;
use serde::Serialize;

/// The single remote account this library syncs with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub site_origin: String,
    pub account_hint: String,
    pub remote_user_id: String,
}
/// Encrypted session cookie metadata; the plaintext never reaches note-core.
#[derive(Clone, PartialEq, Eq)]
pub struct SyncCookie {
    pub ciphertext: Vec<u8>,
    pub name: String,
    pub domain: String,
    pub path: String,
    pub expires_at: Option<i64>,
    pub secure: bool,
    pub host_only: bool,
    pub same_site: String,
}
/// The stored binding row.
#[derive(Clone, PartialEq, Eq)]
pub struct BindingState {
    pub binding: Binding,
    pub cookie: SyncCookie,
    /// Last remote change sequence applied in full.
    pub cursor: i64,
    pub last_success_at: Option<i64>,
    pub last_error_code: Option<String>,
}
/// Remote rows applied in one transaction. Note bodies must already reference
/// local attachment ids.
#[derive(Debug, Clone, Default)]
pub struct RemoteBatch {
    pub cursor: i64,
    /// A full snapshot: confirmed local rows absent from it were deleted remotely.
    pub full: bool,
    pub notes: Vec<Note>,
    pub folders: Vec<Folder>,
    pub tags: Vec<Tag>,
    pub deletions: Vec<SyncDeletion>,
}
/// How a remote snapshot compares with local notes, matched by id only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCounts {
    pub local_only: u64,
    pub remote_only: u64,
    pub same: u64,
    pub different: u64,
}
/// Current local state of a dirty row.
#[derive(Debug, Clone)]
pub enum LocalRow {
    Note(Note),
    Folder(Folder),
    Tag(Tag),
    /// Purged note, deleted folder or deleted tag.
    Missing,
}
/// One row awaiting push, in the order of 22 §7.3.
#[derive(Debug, Clone)]
pub struct DirtyItem {
    pub entity: DirtyEntity,
    pub id: String,
    /// Last confirmed remote note rev; `None` means the remote never had it.
    pub remote_rev: Option<i64>,
    pub row: LocalRow,
    /// Local state token: `sync_settle` clears `dirty` only if it is unchanged.
    pub seen: String,
}
