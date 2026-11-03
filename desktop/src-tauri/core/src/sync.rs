//! Desktop sync state (22 §6): one binding, a dirty flag and confirmed remote
//! rev per row, and attachment id maps. Network code stays in note-sync; every
//! method is one short transaction and never hands out the connection.

mod apply;
mod attachments;
mod binding;
mod models;
mod queue;
mod storage;
#[cfg(test)]
mod tests;

pub use models::{
    Binding, BindingState, DirtyItem, LocalRow, MergeCounts, RemoteBatch, SyncCookie,
};
/// Whether a remote note already carries this local state (used after a lost response).
#[must_use]
pub fn notes_match(local: &crate::dto::Note, remote: &crate::dto::Note) -> bool {
    storage::same_note(local, remote)
}
pub(crate) use attachments::insert_attachment_map;
pub(crate) use storage::mark_dirty;
