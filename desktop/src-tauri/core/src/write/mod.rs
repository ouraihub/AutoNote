//! Transactional note writes and post-commit change notifications.
#![allow(
    clippy::missing_errors_doc,
    clippy::too_many_arguments,
    clippy::collapsible_if,
    reason = "write API and derived pipeline mirror the documented transaction contract"
)]
use crate::dto::{Note, NoteSummary};
use crate::error::Error;
use crate::types::{Millis, NoteId, VersionId};
use rusqlite::Transaction;
use serde::Serialize;
use std::sync::Arc;

/// Origin of the transaction for filtering notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOrigin {
    Ui,
    Mcp,
    Sync,
    Import,
}

/// Sync entity kinds whose local edits are pushed by the desktop sync engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DirtyEntity {
    Note,
    Folder,
    Tag,
}
impl DirtyEntity {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Folder => "folder",
            Self::Tag => "tag",
        }
    }
}

/// The final notes and deletions committed by one transaction.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub notes: Vec<NoteSummary>,
    pub deletions: Vec<String>,
    /// Every note, folder and tag row this transaction created, edited or deleted.
    #[serde(skip)]
    pub touched: Vec<(DirtyEntity, String)>,
    #[serde(skip)]
    pub settings_changed: bool,
    /// Bulk import commits are read back from the durable changes feed.
    #[serde(skip)]
    pub import_changed: bool,
    #[serde(skip)]
    pub origin: Option<WriteOrigin>,
}

impl ChangeSet {
    fn touch(&mut self, summary: NoteSummary) {
        if let Some(old) = self.notes.iter_mut().find(|n| n.id == summary.id) {
            *old = summary;
        } else {
            self.notes.push(summary);
        }
    }
    /// Duplicates are harmless: the dirty upsert in `Library::write` is idempotent.
    pub(crate) fn mark(&mut self, entity: DirtyEntity, id: &str) {
        self.touched.push((entity, id.to_owned()));
    }
    /// Whether any folder or tag row changed.
    pub fn organizers_changed(&self) -> bool {
        self.touched
            .iter()
            .any(|(entity, _)| *entity != DirtyEntity::Note)
    }
}

/// A write result on the same change feed as library notifications.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum WriteEvent {
    Pending {
        count: u64,
    },
    Settled {
        write_id: String,
        note_id: NoteId,
        note: Note,
    },
    Recovered {
        write_id: String,
        note_id: NoteId,
        copy: Note,
        reason: &'static str,
    },
    Failed {
        write_id: String,
        note_id: NoteId,
        code: crate::error::ErrorCode,
        retained: bool,
    },
}

/// Post-commit notification target.
pub trait ChangeSink: Send + Sync {
    fn library_changed(&self, changes: ChangeSet);
    fn write_event(&self, event: WriteEvent);
}

/// Encoder for random IDs supplied by SQLite.
pub trait IdSource: Send + Sync {
    fn new_id(&self, now: Millis, random: &[u8; 16]) -> String;
}

/// Production 26-character Crockford encoder.
pub struct RandomIds;
impl IdSource for RandomIds {
    fn new_id(&self, now: Millis, random: &[u8; 16]) -> String {
        crate::id::encode_id(now.get() as u64, random)
    }
}

pub(crate) fn new_id(
    ids: &dyn IdSource,
    now: Millis,
    tx: &Transaction<'_>,
) -> Result<String, Error> {
    let bytes: Vec<u8> = tx.query_row("SELECT randomblob(16)", [], |r| r.get(0))?;
    let random: [u8; 16] = bytes
        .try_into()
        .map_err(|_| Error::Sqlite(rusqlite::Error::InvalidQuery))?;
    let id = ids.new_id(now, &random);
    if !crate::id::is_valid_id(&id) {
        return Err(Error::Sqlite(rusqlite::Error::InvalidQuery));
    }
    let used: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM notes WHERE id=?1
            UNION ALL SELECT 1 FROM folders WHERE id=?1
            UNION ALL SELECT 1 FROM tags WHERE id=?1
            UNION ALL SELECT 1 FROM note_versions WHERE id=?1
            UNION ALL SELECT 1 FROM attachments WHERE id=?1
        )",
        [id.as_str()],
        |row| row.get(0),
    )?;
    if used {
        return Err(Error::Sqlite(rusqlite::Error::InvalidQuery));
    }
    Ok(id)
}

/// The return value and final change set of one committed transaction.
pub struct Written<T> {
    pub value: T,
    pub changes: ChangeSet,
}

pub(crate) struct WriteTx<'a> {
    pub(crate) tx: Transaction<'a>,
    pub(crate) now: Millis,
    pub(crate) ids: Arc<dyn IdSource>,
    pub(crate) changes: ChangeSet,
}
impl WriteTx<'_> {
    pub(crate) fn record_change(&mut self, id: &str, op: &str) -> Result<(), Error> {
        self.tx.execute(
            "INSERT INTO changes (entity, entity_id, op, at) \
             VALUES ('note', ?1, ?2, (SELECT updated_at FROM notes WHERE id=?1))",
            rusqlite::params![id, op],
        )?;
        self.changes.mark(DirtyEntity::Note, id);
        Ok(())
    }
    pub(crate) fn mark(&mut self, entity: DirtyEntity, id: &str) {
        self.changes.mark(entity, id);
    }
    pub(crate) fn id(&self) -> Result<String, Error> {
        new_id(self.ids.as_ref(), self.now, &self.tx)
    }
    pub(crate) fn touch_note(&mut self, note: NoteSummary) {
        self.changes.touch(note);
    }
    pub(crate) fn delete(&mut self, id: String) {
        self.changes.deletions.push(id);
    }
}

/// Values required to create one local note.
pub struct NewNote {
    pub id: Option<NoteId>,
    pub title: Option<String>,
    pub content: String,
    pub folder_id: Option<crate::types::FolderId>,
    pub is_starred: bool,
}
impl From<crate::dto::CreateNoteBody> for NewNote {
    fn from(input: crate::dto::CreateNoteBody) -> Self {
        Self {
            id: input.id,
            title: input.title,
            content: input.content.unwrap_or_default(),
            folder_id: input.folder_id.flatten(),
            is_starred: input.is_starred.unwrap_or(false),
        }
    }
}
impl crate::db::Library {
    pub fn create_note(
        &self,
        input: &NewNote,
        origin: WriteOrigin,
    ) -> Result<Written<Note>, Error> {
        notes::create_note(self, input, origin)
    }
    pub fn patch_note(
        &self,
        id: &NoteId,
        patch: &NotePatch,
        origin: WriteOrigin,
    ) -> Result<Written<Note>, Error> {
        notes::patch_note(self, id, patch, origin)
    }
    /// Saves a note with a client write ID and emits the write outcome on the same sink.
    pub fn patch_note_with_write_id(
        &self,
        id: &NoteId,
        patch: &NotePatch,
        write_id: &str,
        origin: WriteOrigin,
    ) -> Result<Written<Note>, Error> {
        if write_id.is_empty() || write_id.len() > 128 {
            return Err(Error::invalid("writeId", "must be 1 to 128 characters"));
        }
        self.sink.write_event(WriteEvent::Pending { count: 1 });
        let result = notes::patch_note(self, id, patch, origin);
        match &result {
            Ok(saved) => self.sink.write_event(WriteEvent::Settled {
                write_id: write_id.to_owned(),
                note_id: id.clone(),
                note: saved.value.clone(),
            }),
            Err(error) => self.sink.write_event(WriteEvent::Failed {
                write_id: write_id.to_owned(),
                note_id: id.clone(),
                code: match error {
                    Error::InvalidInput { .. } => crate::error::ErrorCode::BadRequest,
                    Error::TooLarge { .. } => crate::error::ErrorCode::PayloadTooLarge,
                    Error::NotFound { .. } | Error::NoteGone { .. } => {
                        crate::error::ErrorCode::NotFound
                    }
                    Error::Conflict { .. } | Error::Duplicate { .. } => {
                        crate::error::ErrorCode::Conflict
                    }
                    Error::Cancelled => crate::error::ErrorCode::Cancelled,
                    Error::Offline => crate::error::ErrorCode::Offline,
                    Error::Sqlite(_)
                    | Error::Io(_)
                    | Error::Poisoned
                    | Error::SchemaTooNew { .. } => crate::error::ErrorCode::StorageUnavailable,
                },
                retained: true,
            }),
        }
        result
    }
    pub fn trash_note(&self, id: &NoteId, origin: WriteOrigin) -> Result<Written<Note>, Error> {
        lifecycle::trash_note(self, id, origin)
    }
    pub fn restore_note(&self, id: &NoteId, origin: WriteOrigin) -> Result<Written<Note>, Error> {
        lifecycle::restore_note(self, id, origin)
    }
    pub fn purge_note(
        &self,
        id: &NoteId,
        origin: WriteOrigin,
    ) -> Result<Written<crate::types::Cursor>, Error> {
        lifecycle::purge_note(self, id, origin)
    }
    pub fn empty_trash(&self, origin: WriteOrigin) -> Result<Written<u64>, Error> {
        lifecycle::empty_trash(self, origin)
    }
    pub fn duplicate_note(
        &self,
        id: &NoteId,
        copy_id: Option<&NoteId>,
        origin: WriteOrigin,
    ) -> Result<Written<Note>, Error> {
        lifecycle::duplicate_note(self, id, copy_id, origin)
    }
    pub fn restore_version(
        &self,
        id: &NoteId,
        version: &VersionId,
        rev: crate::types::Rev,
        origin: WriteOrigin,
    ) -> Result<Written<Note>, Error> {
        lifecycle::restore_version(self, id, version, rev, origin)
    }
}
/// Local revision and fields to patch; an absent field is unchanged.
pub struct NotePatch {
    pub rev: crate::types::Rev,
    pub title: Option<String>,
    pub content: Option<String>,
    pub folder_id: Option<Option<crate::types::FolderId>>,
    pub is_pinned: Option<bool>,
    pub is_starred: Option<bool>,
    pub is_archived: Option<bool>,
    pub quiet: bool,
    pub preserve_version: bool,
}
impl From<crate::dto::PatchNoteBody> for NotePatch {
    fn from(input: crate::dto::PatchNoteBody) -> Self {
        Self {
            rev: input.rev,
            title: input.title,
            content: input.content,
            folder_id: input.folder_id,
            is_pinned: input.is_pinned,
            is_starred: input.is_starred,
            is_archived: input.is_archived,
            quiet: input.quiet.unwrap_or(false),
            preserve_version: input.preserve_version.unwrap_or(false),
        }
    }
}

pub(crate) mod derived;
pub(crate) mod lifecycle;
pub(crate) mod notes;
pub(crate) mod versions;
pub use folders::{FolderDeleteResult, FolderDeleteStrategy};
pub use tags::{TagPatchResult, TagRemoveResult};
pub(crate) mod folders;
pub(crate) mod mcp;
#[cfg(test)]
mod organization_tests;
pub(crate) mod tags;

#[cfg(test)]
mod tests;
