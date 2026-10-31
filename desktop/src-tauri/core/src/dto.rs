//! Serde structs shaped exactly like `@shared/types` / `@shared/backend-types`.
//!
//! Field names are camelCase, nullable TS fields are `Option` serialized as
//! `null`, optional TS fields are skipped when absent. Times are [`Millis`],
//! local revisions [`Rev`], local change positions [`Cursor`]. These structs
//! are the only shapes that leave the crate; SQL rows never do.
//!
//! Input bodies reject unknown fields and use validated newtypes. Entry points
//! decode them with [`parse_input`] so a malformed body becomes `bad_request`
//! instead of a transport-level decode failure.

use serde::de::DeserializeOwned;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::Error;
use crate::types::{AttachmentId, Cursor, FolderId, Millis, NoteId, Rev, TagId, VersionId};

/// Decodes an input body, mapping every shape error to `bad_request`.
///
/// Like worker `readJson` (`lib/request.ts` lines 44–46), the body must be a
/// JSON object; serde would otherwise also accept a positional array. The
/// serde message is dropped on purpose: it can echo user-supplied text.
///
/// # Errors
///
/// `Error::InvalidInput { field: "body" }` when `value` is not an object or
/// does not match `T`, including unknown fields and newtype validation failures.
pub fn parse_input<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, Error> {
    const SHAPE: Error = Error::invalid("body", "must be a JSON object of the expected shape");
    if !value.is_object() {
        return Err(SHAPE);
    }
    serde_json::from_value(value).map_err(|_| SHAPE)
}

/// `None` = field absent, `Some(None)` = explicit `null`, `Some(Some(v))` = value.
/// Use with `#[serde(default, deserialize_with = "double_option")]`.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `NoteSummary`: list/feed view of a note, without its body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: NoteId,
    pub title: String,
    pub excerpt: String,
    pub folder_id: Option<FolderId>,
    pub tags: Vec<String>,
    pub is_pinned: bool,
    pub is_starred: bool,
    pub is_archived: bool,
    pub word_count: u64,
    pub char_count: u64,
    pub rev: Rev,
    pub position: f64,
    pub created_at: Millis,
    pub updated_at: Millis,
    pub deleted_at: Option<Millis>,
}

/// `Note`: a summary plus its Markdown body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[serde(flatten)]
    pub summary: NoteSummary,
    pub content: String,
}

/// `Folder`. Folders carry no `rev` (20 §5.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: FolderId,
    pub parent_id: Option<FolderId>,
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub position: f64,
    pub created_at: Millis,
    pub updated_at: Millis,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_count: Option<u64>,
}

/// `Tag`, with the number of live notes using it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: TagId,
    pub name: String,
    pub color: Option<String>,
    pub count: u64,
    pub created_at: Millis,
}

/// `NoteVersionMeta`: one snapshot in a note's history, without its body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersionMeta {
    pub id: VersionId,
    pub note_id: NoteId,
    pub title: String,
    pub size: u64,
    pub created_at: Millis,
}

/// `NoteVersion`: a snapshot with its body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersion {
    #[serde(flatten)]
    pub meta: NoteVersionMeta,
    pub content: String,
}

/// `Backlink`: a note linking to the requested one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub id: NoteId,
    pub title: String,
    pub context: String,
}

/// `Attachment` metadata. `url` is the worker-style `/api/files/<id>` path;
/// the desktop host rewrites it in `files.resolveUrl`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: AttachmentId,
    pub note_id: Option<NoteId>,
    pub filename: String,
    pub mime: String,
    pub size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub url: String,
    pub created_at: Millis,
}

/// `AttachmentWithUsage`: attachment plus how many notes reference it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentWithUsage {
    #[serde(flatten)]
    pub attachment: Attachment,
    pub references: u64,
}

/// `AttachmentPage`: newest first; `nextCursor` is `<createdAt>.<id>`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPage {
    pub files: Vec<AttachmentWithUsage>,
    pub next_cursor: Option<String>,
}

/// `files.prune()` result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneResult {
    pub removed: u64,
    pub freed_bytes: u64,
}

/// `ListNotesResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListNotesResponse {
    pub notes: Vec<NoteSummary>,
    pub next_cursor: Option<String>,
    pub total: u64,
}

/// `SyncDeletion['entity']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeletedEntity {
    Note,
    Folder,
    Tag,
}

/// `SyncDeletion`: an entity purged since the requested cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeletion {
    pub entity: DeletedEntity,
    pub id: String,
}

/// `SyncResponse` as the local library produces it (`library_changes`,
/// `notes_snapshot`, `autonote://library-changed`). `cursor` is the local
/// change feed position, never a remote cursor or a note rev.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub cursor: Cursor,
    pub full: bool,
    pub has_more: bool,
    pub next_key: Option<String>,
    pub facets_full: bool,
    pub settings_changed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_changed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_changed: Option<bool>,
    pub notes: Vec<NoteSummary>,
    pub folders: Vec<Folder>,
    pub tags: Vec<Tag>,
    pub deletions: Vec<SyncDeletion>,
    pub server_time: Millis,
}

/// `NoteWriteResult` for a committed local write: always `queued: false`
/// (20 §6); the desktop never returns the queued variant.
#[derive(Debug, Clone, PartialEq)]
pub struct NoteWriteResult {
    pub write_id: String,
    pub note: Note,
}

impl Serialize for NoteWriteResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("NoteWriteResult", 3)?;
        state.serialize_field("queued", &false)?;
        state.serialize_field("writeId", &self.write_id)?;
        state.serialize_field("note", &self.note)?;
        state.end()
    }
}

/// `FlushResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushResult {
    pub pending: u64,
    pub failed: u64,
}

/// `ProgressPhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgressPhase {
    Validating,
    Reading,
    Writing,
    Uploading,
    Finalizing,
}

/// `ProgressEvent`, sent over a per-call IPC channel (20 §10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub job_id: String,
    pub phase: ProgressPhase,
    pub completed: u64,
    pub total: Option<u64>,
    pub terminal: bool,
}

/// `CreateNoteBody`. `folder_id` distinguishes absent from `null`.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateNoteBody {
    #[serde(default)]
    pub id: Option<NoteId>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub folder_id: Option<Option<FolderId>>,
    #[serde(default)]
    pub is_starred: Option<bool>,
}

/// `PatchNoteBody`. `rev` is the caller's local rev and is required: a
/// stale value is a `conflict`, never silently rebased (20 §15.2).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchNoteBody {
    pub rev: Rev,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub folder_id: Option<Option<FolderId>>,
    #[serde(default)]
    pub is_pinned: Option<bool>,
    #[serde(default)]
    pub is_starred: Option<bool>,
    #[serde(default)]
    pub is_archived: Option<bool>,
    #[serde(default)]
    pub quiet: Option<bool>,
    #[serde(default)]
    pub preserve_version: Option<bool>,
}

/// `FolderCreate` (`@shared/backend-types`).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderCreate {
    #[serde(default)]
    pub id: Option<FolderId>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub parent_id: Option<FolderId>,
    #[serde(default)]
    pub before_id: Option<FolderId>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// `FolderPatch`: absent = unchanged, `null` = clear (or root/end for parent/before).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub parent_id: Option<Option<FolderId>>,
    #[serde(default, deserialize_with = "double_option")]
    pub before_id: Option<Option<FolderId>>,
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
}

/// `TagCreate`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TagCreate {
    #[serde(default)]
    pub id: Option<TagId>,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

/// `TagPatch`: absent = unchanged, `null` color = clear.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TagPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
}

/// Sample note for tests across the crate.
#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "fixed valid test values")]
pub(crate) fn test_note(rev: i64) -> Note {
    Note {
        summary: NoteSummary {
            id: "01hzx3k8m9n0p1q2r3s4t5v6w7".parse().unwrap(),
            title: "Hello".to_owned(),
            excerpt: "World".to_owned(),
            folder_id: None,
            tags: vec!["inbox".to_owned()],
            is_pinned: false,
            is_starred: true,
            is_archived: false,
            word_count: 2,
            char_count: 10,
            rev: Rev::new(rev).unwrap(),
            position: 0.0,
            created_at: Millis::new(1_700_000_000_000).unwrap(),
            updated_at: Millis::new(1_700_000_000_500).unwrap(),
            deleted_at: None,
        },
        content: "# Hello\n\nWorld".to_owned(),
    }
}
#[cfg(test)]
#[path = "dto_tests.rs"]
mod tests;
