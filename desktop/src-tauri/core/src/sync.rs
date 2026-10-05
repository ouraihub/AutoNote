//! Durable D5 binding, staging, mapping and outbox state.
//! Network code stays outside note-core; every operation is epoch-scoped.
use crate::dto::{Folder, Note, SyncDeletion, Tag};
use crate::error::{Entity, Error};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub binding_id: String,
    pub binding_epoch: i64,
    pub site_origin: String,
    pub account_hint: String,
    pub remote_user_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCookie {
    pub ciphertext: Option<Vec<u8>>,
    pub domain: String,
    pub path: String,
    pub expires_at: Option<i64>,
    pub secure: bool,
    pub host_only: bool,
    pub name: String,
    pub same_site: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub binding: Binding,
    pub cookie: SyncCookie,
    pub cursor: i64,
    pub snapshot_cursor: Option<i64>,
    pub after_key: Option<String>,
    pub snapshot_run_id: Option<String>,
    pub status: String,
    pub last_error_code: Option<String>,
    pub updated_at: i64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindPolicy {
    ExportLocal,
    ImportCopies,
    Merge,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncEntity {
    Note,
    Folder,
    Tag,
    Attachment,
}
impl SyncEntity {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Folder => "folder",
            Self::Tag => "tag",
            Self::Attachment => "attachment",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxState {
    Pending,
    Sending,
    Acked,
    Blocked,
    Quarantined,
    Deferred,
    Error,
    Recovery,
}
impl OutboxState {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sending => "sending",
            Self::Acked => "acked",
            Self::Blocked => "blocked",
            Self::Quarantined => "quarantined",
            Self::Deferred => "deferred",
            Self::Error => "error",
            Self::Recovery => "recovery",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxKind {
    Create,
    Patch,
    Trash,
    Restore,
    Purge,
    Metadata,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentState {
    Pending,
    Uploading,
    UnknownOutcome,
    Ready,
    Error,
}
impl AttachmentState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Uploading => "uploading",
            Self::UnknownOutcome => "unknown_outcome",
            Self::Ready => "ready",
            Self::Error => "error",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMap {
    pub binding_id: String,
    pub binding_epoch: i64,
    pub entity: SyncEntity,
    pub local_id: String,
    pub remote_id: String,
    pub local_rev: i64,
    pub remote_rev: Option<i64>,
    pub sent_local_rev: Option<i64>,
    pub last_write_id: Option<String>,
    pub base_payload: Option<Value>,
    pub base_hash: Option<String>,
    pub last_remote_cursor: Option<i64>,
    pub state: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    pub binding_id: String,
    pub binding_epoch: i64,
    pub entity: SyncEntity,
    pub write_id: String,
    pub local_id: Option<String>,
    pub local_rev: i64,
    pub base_remote_rev: Option<i64>,
    pub sent_local_rev: Option<i64>,
    pub observed_cursor: i64,
    pub ack_prereq: Value,
    pub kind: OutboxKind,
    pub payload: Value,
    pub attachment_refs: Vec<String>,
    pub attempt_count: i64,
    pub next_attempt_at: i64,
    pub state: OutboxState,
    pub last_error_code: Option<String>,
    pub recovery_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMap {
    pub binding_id: String,
    pub binding_epoch: i64,
    pub local_attachment_id: String,
    pub remote_attachment_id: Option<String>,
    pub sha256: String,
    pub size: i64,
    pub upload_intent: Option<Value>,
    pub state: AttachmentState,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: Option<SyncState>,
    pub pending: u64,
    pub blocked: u64,
    pub conflicts: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSummary {
    pub id: String,
    pub binding_id: String,
    pub binding_epoch: i64,
    pub entity: String,
    pub local_id: Option<String>,
    pub remote_id: Option<String>,
    pub reason: String,
    pub created_at: i64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedSummary {
    pub binding_id: String,
    pub binding_epoch: i64,
    pub pending: u64,
}
/// Initial remote data used to confirm a binding.
pub struct BindingSnapshot {
    pub notes: Vec<Note>,
    pub folders: Vec<Folder>,
    pub tags: Vec<Tag>,
    pub cursor: i64,
}
// Summary DTOs intentionally omit payloads and credentials.

struct MetadataMapping {
    remote_id: String,
    base_payload_json: Option<String>,
    base_hash: Option<String>,
    last_remote_cursor: Option<i64>,
}
type ConflictSnapshots = (String, String, String, String, String);

fn apply_conflict_note(
    w: &mut crate::write::WriteTx<'_>,
    id: &str,
    note: &Note,
    old: Option<&Note>,
) -> Result<i64, Error> {
    use crate::markdown::{count_text, derive_excerpt, normalize_link_key, sha256_hex};
    if note.content.len() > 2 * 1024 * 1024 {
        return Err(Error::TooLarge {
            field: "content",
            limit: 2 * 1024 * 1024,
        });
    }
    if note.summary.title.encode_utf16().count() > 512 {
        return Err(Error::invalid(
            "title",
            "remote title exceeds 512 UTF-16 units",
        ));
    }
    let rev =
        crate::types::Rev::new(old.map_or(1, |old| old.summary.rev.get().saturating_add(1)))?.get();
    let now = crate::types::Millis::new(old.map_or(w.now.get(), |old| {
        w.now
            .get()
            .max(old.summary.updated_at.get().saturating_add(1))
    }))?
    .get();
    let (words, chars) = count_text(&note.content);
    let deleted = old.and(note.summary.deleted_at).map(|_| now);
    if let Some(old) = old {
        if w.tx.execute("UPDATE notes SET folder_id=?1,title=?2,content=?3,excerpt=?4,rev=?5,word_count=?6,char_count=?7,is_pinned=?8,is_starred=?9,is_archived=?10,content_hash=?11,updated_at=?12,deleted_at=?13 WHERE id=?14 AND rev=?15",params![note.summary.folder_id.as_ref().map(|f|f.as_str()),note.summary.title,note.content,derive_excerpt(&note.content,220),rev,words as i64,chars as i64,note.summary.is_pinned,note.summary.is_starred,note.summary.is_archived,sha256_hex(&note.content),now,deleted,id,old.summary.rev.get()])? != 1 { return Err(Error::Conflict { expected: old.summary.rev, server: Box::new(old.clone()) }); }
    } else {
        w.tx.execute("INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,is_pinned,is_starred,is_archived,position,content_hash,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?12,?12)",params![id,note.summary.folder_id.as_ref().map(|f|f.as_str()),note.summary.title,note.content,derive_excerpt(&note.content,220),rev,words as i64,chars as i64,note.summary.is_pinned,note.summary.is_starred,note.summary.is_archived,now,sha256_hex(&note.content)])?;
    }
    let old_key = old.map_or_else(String::new, |old| normalize_link_key(&old.summary.title));
    crate::write::derived::derive(
        &w.tx,
        w.ids.as_ref(),
        id,
        &note.summary.title,
        &note.content,
        deleted.is_some(),
        w.now,
        Some(&old_key),
    )?;
    w.record_change(id, "upsert")?;
    let summary = w.tx.query_row(
        &format!(
            "SELECT {} FROM notes n WHERE n.id=?1",
            crate::db::rows::NOTE_COLUMNS
        ),
        [id],
        crate::db::rows::note_summary,
    )?;
    w.touch_note(summary);
    Ok(rev)
}

fn apply_conflict_metadata(
    w: &mut crate::write::WriteTx<'_>,
    binding: &Binding,
    entity: &str,
    local: &str,
    desired: &Value,
    base: &Value,
) -> Result<(), Error> {
    let current: Option<Value> = if entity == "folder" {
        w.tx.query_row(
            &format!(
                "SELECT {} FROM folders f WHERE f.id=?1 AND f.deleted_at IS NULL",
                crate::db::rows::FOLDER_COLUMNS
            ),
            [local],
            crate::db::rows::folder,
        )
        .optional()?
        .map(serde_json::to_value)
        .transpose()
    } else {
        w.tx.query_row(
            &format!(
                "SELECT {} FROM tags t WHERE t.id=?1",
                crate::db::rows::TAG_COLUMNS
            ),
            [local],
            crate::db::rows::tag,
        )
        .optional()?
        .map(serde_json::to_value)
        .transpose()
    }
    .map_err(|_| Error::invalid("conflict", "cannot encode current metadata"))?;
    if let Some(current) = &current
        && desired.get("method").and_then(Value::as_str) != Some("DELETE")
        && !desired
            .get("input")
            .and_then(Value::as_object)
            .is_some_and(|input| {
                input.iter().all(|(key, value)| {
                    matches!(key.as_str(), "id" | "beforeId") || current.get(key) == Some(value)
                })
            })
    {
        return Err(Error::invalid(
            "conflict",
            "local metadata changed since the frozen write",
        ));
    }
    if desired.get("method").and_then(Value::as_str) == Some("DELETE") && current.is_some() {
        return Err(Error::invalid(
            "conflict",
            "local metadata was recreated after deletion",
        ));
    }
    if current.is_none() && desired.get("method").and_then(Value::as_str) != Some("DELETE") {
        return Err(Error::invalid(
            "conflict",
            "local metadata was removed after the frozen write",
        ));
    }
    if entity == "tag" {
        let old_name = current
            .as_ref()
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str);
        let saved = if base.is_null() {
            None
        } else {
            Some(
                serde_json::from_value::<Tag>(base.clone())
                    .map_err(|_| Error::invalid("conflict", "invalid remote tag"))?,
            )
        };
        if let Some(tag) = &saved {
            if tag.name.is_empty()
                || tag.name.encode_utf16().count() > 60
                || tag.name.chars().any(|c| c.is_whitespace() || c == '#')
            {
                return Err(Error::invalid("name", "invalid remote tag name"));
            }
            crate::write::folders::color(tag.color.as_deref())?;
            let duplicate: bool = w.tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM tags WHERE id<>?1 AND name=?2 COLLATE NOCASE)",
                params![local, tag.name],
                |r| r.get(0),
            )?;
            if duplicate {
                return Err(Error::Duplicate {
                    entity: Entity::Tag,
                });
            }
        }
        if let Some(old_name) = old_name {
            let next = saved.as_ref().map(|tag| tag.name.as_str());
            if next != Some(old_name) {
                crate::write::tags::rewrite(w, local, old_name, next)?;
            }
        }
        if let Some(tag) = saved {
            // derive() can create the new name while rewriting bodies; keep the mapped local identity.
            let derived: Option<String> =
                w.tx.query_row(
                    "SELECT id FROM tags WHERE name=?1 AND id<>?2",
                    params![tag.name, local],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(derived) = derived {
                w.tx.execute("INSERT OR IGNORE INTO note_tags(note_id,tag_id) SELECT note_id,?1 FROM note_tags WHERE tag_id=?2",params![local,derived])?;
                w.tx.execute("DELETE FROM note_tags WHERE tag_id=?1", [&derived])?;
                w.tx.execute("DELETE FROM tags WHERE id=?1", [derived])?;
            }
            w.tx.execute("INSERT INTO tags(id,name,color,is_manual,created_at) VALUES(?1,?2,?3,1,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,is_manual=1",params![local,tag.name,tag.color,tag.created_at.get()])?;
        } else {
            w.tx.execute("DELETE FROM note_tags WHERE tag_id=?1", [local])?;
            w.tx.execute("DELETE FROM tags WHERE id=?1", [local])?;
        }
        w.changes.tags_changed = true;
    } else if !base.is_null() {
        let mut folder: Folder = serde_json::from_value(base.clone())
            .map_err(|_| Error::invalid("conflict", "invalid remote folder"))?;
        if let Some(parent) = &folder.parent_id {
            let mapped: Option<String> = w.tx.query_row("SELECT local_id FROM sync_map WHERE binding_id=?1 AND binding_epoch=?2 AND entity='folder' AND remote_id=?3",params![binding.binding_id,binding.binding_epoch,parent.as_str()],|r|r.get(0)).optional()?;
            folder.parent_id = Some(mapped.unwrap_or_else(|| parent.to_string()).parse()?);
        }
        let id = local.parse()?;
        crate::write::folders::name(&folder.name)?;
        crate::write::folders::color(folder.color.as_deref())?;
        crate::write::folders::check_parent(&w.tx, folder.parent_id.as_ref(), Some(&id))?;
        crate::write::folders::check_name(
            &w.tx,
            folder.parent_id.as_ref(),
            &folder.name,
            Some(local),
        )?;
        if !folder.position.is_finite()
            || crate::write::folders::depth(&w.tx, folder.parent_id.as_ref())?
                + crate::write::folders::height(&w.tx, local)?.max(1)
                > 12
        {
            return Err(Error::invalid("folder", "invalid position or depth"));
        }
        w.tx.execute("INSERT INTO folders(id,parent_id,name,icon,color,position,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,icon=excluded.icon,color=excluded.color,position=excluded.position,updated_at=MAX(folders.updated_at+1,excluded.updated_at),deleted_at=NULL",params![local,folder.parent_id.as_ref().map(|p|p.as_str()),folder.name,folder.icon.map(|v|crate::markdown::truncate_utf16(&v,8)),folder.color,folder.position,folder.created_at.get(),folder.updated_at.get()])?;
        w.changes.folders_changed = true;
    } else {
        // A missing remote folder cannot authorize deletion or relocation of its local contents.
        let used: bool = w.tx.query_row("SELECT EXISTS(SELECT 1 FROM notes WHERE folder_id=?1 UNION ALL SELECT 1 FROM folders WHERE parent_id=?1 AND deleted_at IS NULL)",[local],|r|r.get(0))?;
        if used {
            return Err(Error::invalid(
                "conflict",
                "remote folder deletion requires organizing local contents first",
            ));
        }
        w.tx.execute(
            "UPDATE folders SET deleted_at=?1,updated_at=MAX(updated_at+1,?1) WHERE id=?2",
            params![w.now.get(), local],
        )?;
        w.changes.folders_changed = true;
    }
    w.tx.execute(
        "INSERT INTO changes(entity,entity_id,op,at) VALUES(?1,?2,?3,?4)",
        params![
            entity,
            local,
            if base.is_null() { "delete" } else { "upsert" },
            w.now.get()
        ],
    )?;
    Ok(())
}

fn valid_binding(binding: &Binding) -> Result<(), Error> {
    if binding.binding_id.is_empty() || binding.binding_id.len() > 256 {
        return Err(Error::invalid("bindingId", "must be 1 to 256 characters"));
    }
    if binding.binding_epoch < 1 {
        return Err(Error::invalid("bindingEpoch", "must be at least 1"));
    }
    if binding.site_origin.is_empty() || binding.site_origin.len() > 2048 {
        return Err(Error::invalid("siteOrigin", "is required"));
    }
    Ok(())
}

pub(crate) fn require_binding(conn: &rusqlite::Connection, binding: &Binding) -> Result<(), Error> {
    valid_binding(binding)?;
    let active: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_state WHERE binding_id=?1 AND binding_epoch=?2 AND site_origin=?3 AND remote_user_id=?4 AND status NOT IN ('quarantined','discarded'))",
        params![binding.binding_id, binding.binding_epoch, binding.site_origin, binding.remote_user_id], |r| r.get(0))?;
    if !active {
        return Err(Error::invalid("binding", "inactive or stale binding"));
    }
    Ok(())
}

// Counts describe note usage, not metadata edits; compare all other fields.
fn metadata_base(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(fields) = value.as_object_mut() {
        fields.remove("count");
        fields.remove("noteCount");
    }
    value
}
fn row_state(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncState> {
    let binding = Binding {
        binding_id: row.get(0)?,
        binding_epoch: row.get(1)?,
        site_origin: row.get(2)?,
        account_hint: row.get(3)?,
        remote_user_id: row.get(4)?,
    };
    Ok(SyncState {
        binding,
        cookie: SyncCookie {
            ciphertext: row.get(5)?,
            domain: row.get(6)?,
            path: row.get(7)?,
            expires_at: row.get(8)?,
            secure: row.get::<_, i64>(9)? != 0,
            host_only: row.get::<_, i64>(10)? != 0,
            name: row.get(11)?,
            same_site: row.get(12)?,
        },
        cursor: row.get(13)?,
        snapshot_cursor: row.get(14)?,
        after_key: row.get(15)?,
        snapshot_run_id: row.get(16)?,
        status: row.get(17)?,
        last_error_code: row.get(18)?,
        updated_at: row.get(19)?,
    })
}
fn load_state(
    conn: &rusqlite::Connection,
    binding: Option<&Binding>,
) -> Result<Option<SyncState>, Error> {
    let sql = "SELECT binding_id,binding_epoch,site_origin,account_hint,remote_user_id,cookie_ciphertext,cookie_domain,cookie_path,cookie_expires_at,cookie_secure,cookie_host_only,cookie_name,cookie_same_site,cursor,snapshot_cursor,after_key,snapshot_run_id,status,last_error_code,updated_at FROM sync_state";
    Ok(match binding {
        Some(b) => conn
            .query_row(
                &format!("{sql} WHERE binding_id=?1 AND binding_epoch=?2"),
                params![b.binding_id, b.binding_epoch],
                row_state,
            )
            .optional()?,
        None => conn
            .query_row(
                &format!("{sql} ORDER BY updated_at DESC LIMIT 1"),
                [],
                row_state,
            )
            .optional()?,
    })
}
impl crate::db::Library {
    /// Allocates a valid local identifier.
    ///
    /// # Errors
    /// Returns an error if identifier generation or database access fails.
    pub fn sync_new_id(&self) -> Result<String, Error> {
        let conn = self.conn.lock()?;
        let tx = conn.unchecked_transaction()?;
        let id = crate::write::new_id(self.ids.as_ref(), self.clock.now()?, &tx)?;
        tx.commit()?;
        Ok(id)
    }
    /// Returns the current binding, if one exists.
    ///
    /// # Errors
    /// Returns an error if the database lock or query fails.
    pub fn sync_current_binding(&self) -> Result<Option<SyncState>, Error> {
        let c = self.conn.lock()?;
        load_state(&c, None)
    }
    /// Loads state for a binding.
    ///
    /// # Errors
    /// Returns an error if validation, database access, or binding lookup fails.
    pub fn sync_state(&self, binding: &Binding) -> Result<SyncState, Error> {
        valid_binding(binding)?;
        let c = self.conn.lock()?;
        load_state(&c, Some(binding))?.ok_or_else(|| Error::NotFound {
            entity: Entity::Note,
            id: binding.binding_id.clone(),
        })
    }
    /// Creates or replaces a binding.
    ///
    /// # Errors
    /// Returns an error if validation or database access fails.
    pub fn sync_bind(&self, binding: &Binding, cookie: &SyncCookie) -> Result<SyncState, Error> {
        valid_binding(binding)?;
        if cookie.name.is_empty() || cookie.domain.is_empty() || cookie.path.is_empty() {
            return Err(Error::invalid(
                "cookie",
                "name, domain and path are required",
            ));
        }
        let mut c = self.conn.lock()?;
        let tx = c.transaction()?;
        let now = chrono_free_now();
        tx.execute("UPDATE sync_state SET status='quarantined',updated_at=?1 WHERE binding_id<>?2 AND status NOT IN ('quarantined','discarded')",params![now,binding.binding_id])?;
        tx.execute("INSERT INTO sync_state(binding_id,binding_epoch,site_origin,account_hint,remote_user_id,cookie_ciphertext,cookie_domain,cookie_path,cookie_expires_at,cookie_secure,cookie_host_only,cookie_name,cookie_same_site,status,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'bound',?14) ON CONFLICT(binding_id) DO UPDATE SET binding_epoch=excluded.binding_epoch,site_origin=excluded.site_origin,account_hint=excluded.account_hint,remote_user_id=excluded.remote_user_id,cookie_ciphertext=excluded.cookie_ciphertext,cookie_domain=excluded.cookie_domain,cookie_path=excluded.cookie_path,cookie_expires_at=excluded.cookie_expires_at,cookie_secure=excluded.cookie_secure,cookie_host_only=excluded.cookie_host_only,cookie_name=excluded.cookie_name,cookie_same_site=excluded.cookie_same_site,status='bound',updated_at=excluded.updated_at",params![binding.binding_id,binding.binding_epoch,binding.site_origin,binding.account_hint,binding.remote_user_id,cookie.ciphertext,cookie.domain,cookie.path,cookie.expires_at,cookie.secure,cookie.host_only,cookie.name,cookie.same_site,now])?;
        tx.commit()?;
        drop(c);
        let c = self.conn.lock()?;
        load_state(&c, Some(binding))?.ok_or_else(|| Error::NotFound {
            entity: Entity::Note,
            id: binding.binding_id.clone(),
        })
    }
    /// Confirms a binding and records its initial remote snapshot.
    ///
    /// # Errors
    /// Rejects invalid binding/cookie data and propagates serialization,
    /// transaction, or state lookup failures.
    pub fn sync_confirm_binding(
        &self,
        binding: &Binding,
        cookie: &SyncCookie,
        policy: BindPolicy,
        snapshot: &BindingSnapshot,
    ) -> Result<SyncState, Error> {
        self.sync_bind(binding, cookie)?;
        let mut c = self.conn.lock()?;
        let tx = c.transaction()?;
        for folder in &snapshot.folders {
            tx.execute("INSERT OR IGNORE INTO sync_map(binding_id,binding_epoch,entity,local_id,remote_id,local_rev,state,base_payload_json) VALUES(?1,?2,'folder',?3,?3,0,'synced',?4)",params![binding.binding_id,binding.binding_epoch,folder.id.as_str(),serde_json::to_string(folder).map_err(|_|Error::invalid("folder","cannot encode"))?])?;
        }
        for tag in &snapshot.tags {
            tx.execute("INSERT OR IGNORE INTO sync_map(binding_id,binding_epoch,entity,local_id,remote_id,local_rev,state,base_payload_json) VALUES(?1,?2,'tag',?3,?3,0,'synced',?4)",params![binding.binding_id,binding.binding_epoch,tag.id.as_str(),serde_json::to_string(tag).map_err(|_|Error::invalid("tag","cannot encode"))?])?;
        }
        for note in &snapshot.notes {
            let id = note.summary.id.as_str();
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1)",
                [id],
                |r| r.get(0),
            )?;
            let dirty:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND entity='note' AND local_id=?3 AND state NOT IN ('acked','quarantined'))",params![binding.binding_id,binding.binding_epoch,id],|r|r.get(0))?;
            if !exists && matches!(policy, BindPolicy::ImportCopies | BindPolicy::Merge) {
                let hash = crate::markdown::sha256_hex(&note.content);
                tx.execute("INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,is_pinned,is_starred,is_archived,position,content_hash,created_at,updated_at,deleted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",params![id,note.summary.folder_id.as_ref().map(|x|x.as_str()),note.summary.title,note.content,note.summary.excerpt,note.summary.rev.get(),note.summary.word_count as i64,note.summary.char_count as i64,note.summary.is_pinned,note.summary.is_starred,note.summary.is_archived,note.summary.position,hash,note.summary.created_at.get(),note.summary.updated_at.get(),note.summary.deleted_at.map(|x|x.get())])?;
            }
            tx.execute("INSERT OR REPLACE INTO sync_map(binding_id,binding_epoch,entity,local_id,remote_id,local_rev,remote_rev,last_remote_cursor,state,base_payload_json) VALUES(?1,?2,'note',?3,?3,COALESCE((SELECT rev FROM notes WHERE id=?3),0),?4,?5,?6,?7)",params![binding.binding_id,binding.binding_epoch,id,note.summary.rev.get(),snapshot.cursor,if dirty{"dirty"}else{"synced"},serde_json::to_string(note).map_err(|_|Error::invalid("note","cannot encode"))?])?;
        }
        tx.execute("UPDATE sync_state SET status='active',cursor=?1,updated_at=?2 WHERE binding_id=?3 AND binding_epoch=?4",params![snapshot.cursor,chrono_free_now(),binding.binding_id,binding.binding_epoch])?;
        tx.commit()?;
        drop(c);
        let c = self.conn.lock()?;
        load_state(&c, Some(binding))?.ok_or_else(|| Error::NotFound {
            entity: Entity::Note,
            id: binding.binding_id.clone(),
        })
    }
    /// Updates a binding status.
    ///
    /// # Errors
    /// Returns an error if validation, database access, or binding lookup fails.
    pub fn sync_set_status(
        &self,
        binding: &Binding,
        status: &str,
        code: Option<&str>,
    ) -> Result<(), Error> {
        valid_binding(binding)?;
        let c = self.conn.lock()?;
        if c.execute("UPDATE sync_state SET status=?1,last_error_code=?2,updated_at=?3 WHERE binding_id=?4 AND binding_epoch=?5",params![status,code,chrono_free_now(),binding.binding_id,binding.binding_epoch])?==0{return Err(Error::NotFound{entity:Entity::Note,id:binding.binding_id.clone()})}
        Ok(())
    }
    /// Updates a binding cookie.
    ///
    /// # Errors
    /// Returns an error if validation or database access fails.
    pub fn sync_update_cookie(&self, binding: &Binding, cookie: &SyncCookie) -> Result<(), Error> {
        valid_binding(binding)?;
        let c = self.conn.lock()?;
        c.execute("UPDATE sync_state SET cookie_ciphertext=?1,cookie_domain=?2,cookie_path=?3,cookie_expires_at=?4,cookie_secure=?5,cookie_host_only=?6,cookie_name=?7,cookie_same_site=?8,updated_at=?9 WHERE binding_id=?10 AND binding_epoch=?11",params![cookie.ciphertext,cookie.domain,cookie.path,cookie.expires_at,cookie.secure,cookie.host_only,cookie.name,cookie.same_site,chrono_free_now(),binding.binding_id,binding.binding_epoch])?;
        Ok(())
    }
    /// Loads the current binding and its pending, blocked and conflict counts.
    /// # Errors
    /// Propagates database locking, query and row decoding failures.
    pub fn sync_status(&self) -> Result<SyncStatus, Error> {
        let c = self.conn.lock()?;
        let state = load_state(&c, None)?;
        let prefix = state
            .as_ref()
            .map(|s| (s.binding.binding_id.clone(), s.binding.binding_epoch));
        let (pending, blocked, conflicts): (i64, i64, i64) = if let Some((id, e)) = prefix {
            c.query_row("SELECT COALESCE(SUM(state IN ('pending','sending','deferred','recovery')),0),COALESCE(SUM(state='blocked'),0),(SELECT COUNT(*) FROM sync_conflict WHERE binding_id=?1 AND binding_epoch=?2 AND resolved_at IS NULL) FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2",params![id,e],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?
        } else {
            (0, 0, 0)
        };
        Ok(SyncStatus {
            state,
            pending: pending.max(0) as u64,
            blocked: blocked.max(0) as u64,
            conflicts: conflicts.max(0) as u64,
        })
    }
    /// Stages one snapshot page without advancing the confirmed cursor.
    /// # Errors
    /// Rejects invalid bindings and propagates serialization and database failures.
    pub fn sync_stage_page(
        &self,
        binding: &Binding,
        run_id: &str,
        first: bool,
        snapshot_cursor: i64,
        after_key: Option<&str>,
        notes: &[Note],
    ) -> Result<(), Error> {
        valid_binding(binding)?;
        let mut c = self.conn.lock()?;
        let tx = c.transaction()?;
        if first {
            tx.execute(
                "DELETE FROM sync_snapshot WHERE binding_id=?1 AND binding_epoch=?2 AND run_id=?3",
                params![binding.binding_id, binding.binding_epoch, run_id],
            )?;
        }
        for n in notes {
            tx.execute("INSERT OR REPLACE INTO sync_snapshot(binding_id,binding_epoch,run_id,entity,remote_id,remote_rev,payload_json) VALUES(?1,?2,?3,'note',?4,?5,?6)",params![binding.binding_id,binding.binding_epoch,run_id,n.summary.id.as_str(),n.summary.rev.get(),serde_json::to_string(n).map_err(|_|Error::invalid("snapshot","cannot encode"))?])?;
        }
        tx.execute("UPDATE sync_state SET snapshot_run_id=?1,snapshot_cursor=?2,after_key=?3,updated_at=?4 WHERE binding_id=?5 AND binding_epoch=?6",params![run_id,snapshot_cursor,after_key,chrono_free_now(),binding.binding_id,binding.binding_epoch])?;
        tx.commit()?;
        Ok(())
    }
    /// Confirms a staged snapshot cursor and removes its staging rows.
    /// # Errors
    /// Rejects invalid bindings and propagates transaction failures.
    pub fn sync_commit_snapshot(
        &self,
        binding: &Binding,
        run_id: &str,
        cursor: i64,
    ) -> Result<(), Error> {
        valid_binding(binding)?;
        let mut c = self.conn.lock()?;
        let tx = c.transaction()?;
        tx.execute("UPDATE sync_state SET cursor=?1,snapshot_run_id=NULL,snapshot_cursor=NULL,after_key=NULL,status='active',updated_at=?2 WHERE binding_id=?3 AND binding_epoch=?4 AND snapshot_run_id=?5",params![cursor,chrono_free_now(),binding.binding_id,binding.binding_epoch,run_id])?;
        tx.execute(
            "DELETE FROM sync_snapshot WHERE binding_id=?1 AND binding_epoch=?2 AND run_id=?3",
            params![binding.binding_id, binding.binding_epoch, run_id],
        )?;
        tx.commit()?;
        Ok(())
    }
    /// Applies one remote change page to local mappings and conflict records.
    /// # Errors
    /// Rejects invalid or missing bindings and propagates encoding and SQL failures.
    pub fn sync_apply_page(
        &self,
        binding: &Binding,
        cursor: i64,
        notes: &[Note],
        folders: &[Folder],
        tags: &[Tag],
        deletions: &[SyncDeletion],
    ) -> Result<(), Error> {
        valid_binding(binding)?;
        let mut c = self.conn.lock()?;
        let tx = c.transaction()?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_state WHERE binding_id=?1 AND binding_epoch=?2)",
            params![binding.binding_id, binding.binding_epoch],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::NotFound {
                entity: Entity::Note,
                id: binding.binding_id.clone(),
            });
        }
        for n in notes {
            let id = n.summary.id.as_str();
            let dirty:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND entity='note' AND local_id=?3 AND state NOT IN ('acked','quarantined'))",params![binding.binding_id,binding.binding_epoch,id],|r|r.get(0))?;
            if !dirty {
                let hash = crate::markdown::sha256_hex(&n.content);
                tx.execute("INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,is_pinned,is_starred,is_archived,position,content_hash,created_at,updated_at,deleted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,content=excluded.content,excerpt=excluded.excerpt,rev=excluded.rev,word_count=excluded.word_count,char_count=excluded.char_count,is_pinned=excluded.is_pinned,is_starred=excluded.is_starred,is_archived=excluded.is_archived,position=excluded.position,content_hash=excluded.content_hash,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at",params![id,n.summary.folder_id.as_ref().map(|x|x.as_str()),n.summary.title,n.content,n.summary.excerpt,n.summary.rev.get(),n.summary.word_count as i64,n.summary.char_count as i64,n.summary.is_pinned,n.summary.is_starred,n.summary.is_archived,n.summary.position,hash,n.summary.created_at.get(),n.summary.updated_at.get(),n.summary.deleted_at.map(|x|x.get())])?;
                crate::write::derived::derive(
                    &tx,
                    self.ids.as_ref(),
                    id,
                    &n.summary.title,
                    &n.content,
                    n.summary.deleted_at.is_some(),
                    self.clock.now()?,
                    None,
                )?;
                tx.execute(
                    "INSERT INTO changes(entity,entity_id,op,at) VALUES('note',?1,'upsert',?2)",
                    params![id, n.summary.updated_at.get()],
                )?;
            }
            let p =
                serde_json::to_string(n).map_err(|_| Error::invalid("note", "cannot encode"))?;
            tx.execute("INSERT OR REPLACE INTO sync_map(binding_id,binding_epoch,entity,local_id,remote_id,local_rev,remote_rev,last_remote_cursor,state,base_payload_json) VALUES(?1,?2,'note',?3,?3,COALESCE((SELECT rev FROM notes WHERE id=?3),0),?4,?5,?6,?7)",params![binding.binding_id,binding.binding_epoch,id,n.summary.rev.get(),cursor,if dirty{"dirty"}else{"synced"},p])?;
        }
        for f in folders {
            let p =
                serde_json::to_string(f).map_err(|_| Error::invalid("folder", "cannot encode"))?;
            tx.execute("INSERT OR REPLACE INTO sync_map(binding_id,binding_epoch,entity,local_id,remote_id,local_rev,last_remote_cursor,state,base_payload_json) VALUES(?1,?2,'folder',?3,?3,0,?4,'synced',?5)",params![binding.binding_id,binding.binding_epoch,f.id.as_str(),cursor,p])?;
        }
        for t in tags {
            let p = serde_json::to_string(t).map_err(|_| Error::invalid("tag", "cannot encode"))?;
            tx.execute("INSERT OR REPLACE INTO sync_map(binding_id,binding_epoch,entity,local_id,remote_id,local_rev,last_remote_cursor,state,base_payload_json) VALUES(?1,?2,'tag',?3,?3,0,?4,'synced',?5)",params![binding.binding_id,binding.binding_epoch,t.id.as_str(),cursor,p])?;
        }
        for d in deletions {
            let entity = match d.entity {
                crate::dto::DeletedEntity::Note => "note",
                crate::dto::DeletedEntity::Folder => "folder",
                crate::dto::DeletedEntity::Tag => "tag",
            };
            tx.execute("UPDATE sync_map SET state='deleted',last_remote_cursor=?1 WHERE binding_id=?2 AND binding_epoch=?3 AND entity=?4 AND remote_id=?5",params![cursor,binding.binding_id,binding.binding_epoch,entity,d.id])?;
            if entity == "note" {
                let dirty:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND entity='note' AND local_id=?3 AND state NOT IN ('acked','quarantined'))",params![binding.binding_id,binding.binding_epoch,d.id],|r|r.get(0))?;
                if !dirty {
                    tx.execute(
                        "UPDATE notes SET deleted_at=?1 WHERE id=?2",
                        params![chrono_free_now(), d.id],
                    )?;
                }
            }
        }
        tx.execute("UPDATE sync_state SET cursor=MAX(cursor,?1),updated_at=?2 WHERE binding_id=?3 AND binding_epoch=?4",params![cursor,chrono_free_now(),binding.binding_id,binding.binding_epoch])?;
        tx.commit()?;
        self.sink
            .library_changed(crate::write::ChangeSet::default());
        Ok(())
    }
    /// Loads attachment mappings for a binding epoch.
    /// # Errors
    /// Rejects invalid bindings and propagates query and row decoding failures.
    pub fn sync_attachment_maps(&self, binding: &Binding) -> Result<Vec<AttachmentMap>, Error> {
        valid_binding(binding)?;
        let c = self.conn.lock()?;
        let mut s=c.prepare("SELECT binding_id,binding_epoch,local_attachment_id,remote_attachment_id,sha256,size,upload_intent_json,state FROM sync_attachment_map WHERE binding_id=?1 AND binding_epoch=?2")?;
        let mut out = Vec::new();
        for row in s.query_map(params![binding.binding_id, binding.binding_epoch], |r| {
            let raw: Option<String> = r.get(6)?;
            Ok(AttachmentMap {
                binding_id: r.get(0)?,
                binding_epoch: r.get(1)?,
                local_attachment_id: r.get(2)?,
                remote_attachment_id: r.get(3)?,
                sha256: r.get(4)?,
                size: r.get(5)?,
                upload_intent: raw.and_then(|x| serde_json::from_str(&x).ok()),
                state: match r.get::<_, String>(7)?.as_str() {
                    "pending" => AttachmentState::Pending,
                    "uploading" => AttachmentState::Uploading,
                    "unknown_outcome" => AttachmentState::UnknownOutcome,
                    "ready" => AttachmentState::Ready,
                    _ => AttachmentState::Error,
                },
            })
        })? {
            out.push(row?)
        }
        Ok(out)
    }
    /// Persists an attachment mapping for a binding epoch.
    /// # Errors
    /// Rejects invalid bindings and propagates encoding and database failures.
    pub fn sync_put_attachment_map(
        &self,
        binding: &Binding,
        map: &AttachmentMap,
    ) -> Result<(), Error> {
        valid_binding(binding)?;
        let c = self.conn.lock()?;
        c.execute("INSERT INTO sync_attachment_map(binding_id,binding_epoch,local_attachment_id,remote_attachment_id,sha256,size,upload_intent_json,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(binding_id,binding_epoch,local_attachment_id) DO UPDATE SET remote_attachment_id=excluded.remote_attachment_id,sha256=excluded.sha256,size=excluded.size,upload_intent_json=excluded.upload_intent_json,state=excluded.state",params![binding.binding_id,binding.binding_epoch,map.local_attachment_id,map.remote_attachment_id,map.sha256,map.size,map.upload_intent.as_ref().map(serde_json::to_string).transpose().map_err(|_|Error::invalid("attachment","cannot encode"))?,map.state.as_str()])?;
        Ok(())
    }
    /// Finds the mapping for one local entity in a binding epoch.
    /// # Errors
    /// Rejects invalid bindings and propagates query and row decoding failures.
    pub fn sync_map_for_local(
        &self,
        binding: &Binding,
        entity: SyncEntity,
        local: &str,
    ) -> Result<Option<SyncMap>, Error> {
        valid_binding(binding)?;
        let c = self.conn.lock()?;
        let row=c.query_row("SELECT binding_id,binding_epoch,entity,local_id,remote_id,local_rev,remote_rev,sent_local_rev,last_write_id,base_payload_json,base_hash,last_remote_cursor,state FROM sync_map WHERE binding_id=?1 AND binding_epoch=?2 AND entity=?3 AND local_id=?4",params![binding.binding_id,binding.binding_epoch,entity.as_str(),local],|r|{let raw:Option<String>=r.get(9)?;Ok(SyncMap{binding_id:r.get(0)?,binding_epoch:r.get(1)?,entity,local_id:r.get(3)?,remote_id:r.get(4)?,local_rev:r.get(5)?,remote_rev:r.get(6)?,sent_local_rev:r.get(7)?,last_write_id:r.get(8)?,base_payload:raw.and_then(|x|serde_json::from_str(&x).ok()),base_hash:r.get(10)?,last_remote_cursor:r.get(11)?,state:r.get(12)?})}).optional()?;
        Ok(row)
    }
    /// Claims a bounded batch of due writes and increments their attempt counts.
    /// # Errors
    /// Rejects invalid bindings and propagates malformed payload or SQL errors.
    pub fn sync_claim_outbox(
        &self,
        binding: &Binding,
        limit: i64,
    ) -> Result<Vec<OutboxItem>, Error> {
        valid_binding(binding)?;
        let c = self.conn.lock()?;
        let mut s=c.prepare("SELECT binding_id,binding_epoch,entity,write_id,local_id,local_rev,base_remote_rev,sent_local_rev,observed_cursor,ack_prereq,kind,payload,attachment_refs,attempt_count,next_attempt_at,state,last_error_code,recovery_id FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND state IN ('pending','deferred','error','recovery') AND next_attempt_at<=?3 ORDER BY created_at,write_id LIMIT ?4")?;
        let mut out = Vec::new();
        for row in s.query_map(
            params![
                binding.binding_id,
                binding.binding_epoch,
                chrono_free_now(),
                limit.max(1)
            ],
            |r| {
                let entity = entity_parse(&r.get::<_, String>(2)?)?;
                let kind = kind_parse(&r.get::<_, String>(10)?)?;
                let state = state_parse(&r.get::<_, String>(15)?)?;
                let payload: Value = serde_json::from_slice(&r.get::<_, Vec<u8>>(11)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                let prereq: Value = serde_json::from_str(&r.get::<_, String>(9)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                let refs: Vec<String> = serde_json::from_str(&r.get::<_, String>(12)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(OutboxItem {
                    binding_id: r.get(0)?,
                    binding_epoch: r.get(1)?,
                    entity,
                    write_id: r.get(3)?,
                    local_id: r.get(4)?,
                    local_rev: r.get(5)?,
                    base_remote_rev: r.get(6)?,
                    sent_local_rev: r.get(7)?,
                    observed_cursor: r.get(8)?,
                    ack_prereq: prereq,
                    kind,
                    payload,
                    attachment_refs: refs,
                    attempt_count: r.get(13)?,
                    next_attempt_at: r.get(14)?,
                    state,
                    last_error_code: r.get(16)?,
                    recovery_id: r.get(17)?,
                })
            },
        )? {
            let item = row?;
            c.execute("UPDATE sync_outbox SET state='sending',attempt_count=attempt_count+1 WHERE binding_id=?1 AND binding_epoch=?2 AND write_id=?3",params![binding.binding_id,binding.binding_epoch,item.write_id])?;
            out.push(item);
        }
        Ok(out)
    }
    /// Records the state and safe error code for a retained write.
    /// # Errors
    /// Propagates database locking and update failures.
    pub fn sync_error_outbox(
        &self,
        binding: &Binding,
        id: &str,
        state: OutboxState,
        code: &str,
    ) -> Result<(), Error> {
        let c = self.conn.lock()?;
        c.execute("UPDATE sync_outbox SET state=?1,last_error_code=?2 WHERE binding_id=?3 AND binding_epoch=?4 AND write_id=?5",params![state.as_str(),code,binding.binding_id,binding.binding_epoch,id])?;
        Ok(())
    }
    /// Retains the frozen write and the attempt count already incremented by claim.
    /// # Errors
    /// Rejects invalid retry times, stale bindings and completed/missing writes;
    /// propagates database locking and update failures.
    pub fn sync_defer_outbox(
        &self,
        binding: &Binding,
        write: &str,
        at: i64,
        code: &str,
    ) -> Result<(), Error> {
        crate::types::Millis::new(at)?;
        let c = self.conn.lock()?;
        require_binding(&c, binding)?;
        if c.execute("UPDATE sync_outbox SET state='deferred',next_attempt_at=?1,last_error_code=?2 WHERE binding_id=?3 AND binding_epoch=?4 AND write_id=?5 AND state NOT IN ('acked','quarantined')",
            params![at, code, binding.binding_id, binding.binding_epoch, write])? != 1 {
            return Err(Error::invalid("writeId", "write is missing or no longer pending"));
        }
        Ok(())
    }
    /// Checks whether every attachment prerequisite has a confirmed remote mapping.
    /// # Errors
    /// Returns errors for missing writes, malformed references or SQL failures.
    pub fn sync_ack_prerequisites(&self, binding: &Binding, id: &str) -> Result<bool, Error> {
        let c = self.conn.lock()?;
        let refs:String=c.query_row("SELECT attachment_refs FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND write_id=?3",params![binding.binding_id,binding.binding_epoch,id],|r|r.get(0))?;
        let ids: Vec<String> = serde_json::from_str(&refs)
            .map_err(|_| Error::invalid("outbox", "invalid attachment refs"))?;
        for local in ids {
            let ready:bool=c.query_row("SELECT state='ready' AND remote_attachment_id IS NOT NULL FROM sync_attachment_map WHERE binding_id=?1 AND binding_epoch=?2 AND local_attachment_id=?3",params![binding.binding_id,binding.binding_epoch,local],|r|r.get(0))?;
            if !ready {
                return Ok(false);
            }
        }
        Ok(true)
    }
    /// Acknowledges a frozen note write and its remote mapping atomically.
    /// # Errors
    /// Propagates transaction and database locking failures.
    pub fn sync_ack_outbox(
        &self,
        binding: &Binding,
        write: &str,
        sent: i64,
        remote: &str,
        rev: Option<i64>,
    ) -> Result<(), Error> {
        let mut c = self.conn.lock()?;
        let tx = c.transaction()?;
        tx.execute("UPDATE sync_outbox SET state='acked',last_error_code=NULL WHERE binding_id=?1 AND binding_epoch=?2 AND write_id=?3 AND sent_local_rev=?4",params![binding.binding_id,binding.binding_epoch,write,sent])?;
        tx.execute("UPDATE sync_map SET remote_id=?1,remote_rev=?2,sent_local_rev=?3,last_write_id=?4,state='synced' WHERE binding_id=?5 AND binding_epoch=?6 AND local_id=(SELECT local_id FROM sync_outbox WHERE binding_id=?5 AND binding_epoch=?6 AND write_id=?4)",params![remote,rev,sent,write,binding.binding_id,binding.binding_epoch])?;
        tx.commit()?;
        Ok(())
    }
    /// Rebases the retained network write and stores its remote conflict snapshot.
    /// # Errors
    /// Propagates serialization, database locking and update failures.
    pub fn sync_rebase_outbox(
        &self,
        binding: &Binding,
        id: &str,
        rev: i64,
        server: &Note,
    ) -> Result<(), Error> {
        let c = self.conn.lock()?;
        c.execute("UPDATE sync_outbox SET base_remote_rev=?1,payload=json_set(payload,'$.preserveVersion',true),state='pending' WHERE binding_id=?2 AND binding_epoch=?3 AND write_id=?4",params![rev,binding.binding_id,binding.binding_epoch,id])?;
        let remote = server.summary.id.as_str();
        let raw = serde_json::to_string(server)
            .map_err(|_| Error::invalid("conflict", "cannot encode"))?;
        c.execute("INSERT OR REPLACE INTO sync_conflict(id,binding_id,binding_epoch,entity,local_id,remote_id,local_payload,remote_payload,reason,created_at) SELECT 'conflict-'||?4,?2,?3,'note',local_id,?5,payload,?6,'remote_changed',?7 FROM sync_outbox WHERE binding_id=?2 AND binding_epoch=?3 AND write_id=?4",params![rev,binding.binding_id,binding.binding_epoch,id,remote,raw,chrono_free_now()])?;
        Ok(())
    }
    /// Lists unresolved conflict summaries without payloads.
    /// # Errors
    /// Propagates database locking, query and row decoding failures.
    pub fn sync_conflicts(&self) -> Result<Vec<ConflictSummary>, Error> {
        let c = self.conn.lock()?;
        let mut s=c.prepare("SELECT id,binding_id,binding_epoch,entity,local_id,remote_id,reason,created_at FROM sync_conflict WHERE resolved_at IS NULL ORDER BY created_at,id")?;
        let mut out = Vec::new();
        for row in s.query_map([], |r| {
            Ok(ConflictSummary {
                id: r.get(0)?,
                binding_id: r.get(1)?,
                binding_epoch: r.get(2)?,
                entity: r.get(3)?,
                local_id: r.get(4)?,
                remote_id: r.get(5)?,
                reason: r.get(6)?,
                created_at: r.get(7)?,
            })
        })? {
            out.push(row?)
        }
        Ok(out)
    }
    /// Resolves an epoch-scoped conflict without discarding its retained snapshots.
    /// `local` retries the frozen write against the retained remote baseline;
    /// `remote` adopts that baseline; `keep-both` keeps local and copies the remote note.
    ///
    /// # Errors
    /// Rejects stale bindings, invalid choices, unsupported conflict payloads,
    /// newer local edits and unsafe metadata changes. SQL, ID allocation and
    /// derived-data failures roll back the resolution and its domain changes.
    pub fn sync_resolve_conflict(
        &self,
        binding: &Binding,
        id: &str,
        choice: &str,
    ) -> Result<(), Error> {
        if id.is_empty() || !matches!(choice, "local" | "remote" | "keep-both") {
            return Err(Error::invalid("conflict", "invalid resolution"));
        }
        self.write(crate::write::WriteOrigin::Sync, |w| {
            require_binding(&w.tx, binding)?;
            let conflict: Option<ConflictSnapshots> = w.tx.query_row(
                "SELECT entity,local_id,remote_id,CAST(local_payload AS TEXT),CAST(remote_payload AS TEXT) FROM sync_conflict WHERE id=?1 AND binding_id=?2 AND binding_epoch=?3 AND resolved_at IS NULL",
                params![id, binding.binding_id, binding.binding_epoch], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
            let (entity, local, remote, local_raw, remote_raw) = conflict.ok_or_else(|| Error::invalid("conflict", "missing, resolved or from another binding"))?;
            let desired: Value = serde_json::from_str(&local_raw).map_err(|_| Error::invalid("conflict", "invalid local snapshot"))?;
            let base: Value = serde_json::from_str(&remote_raw).map_err(|_| Error::invalid("conflict", "invalid remote snapshot"))?;
            let writes: Vec<(String, Value, String, i64)> = {
                let mut stmt = w.tx.prepare("SELECT write_id,CAST(payload AS BLOB),state,local_rev FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND entity=?3 AND local_id=?4 AND state NOT IN ('acked','quarantined')")?;
                let rows = stmt.query_map(params![binding.binding_id,binding.binding_epoch,entity,local], |r| Ok((r.get::<_,String>(0)?, r.get::<_,Vec<u8>>(1)?, r.get::<_,String>(2)?, r.get::<_,i64>(3)?)))?;
                rows.map(|row| { let (id, raw, state, rev) = row?; let value = serde_json::from_slice(&raw).map_err(|_| Error::invalid("outbox", "invalid frozen snapshot"))?; Ok((id,value,state,rev)) }).collect::<Result<_,Error>>()?
            };
            let mut remote_rev = None;
            let mut local_rev = 0;
            match entity.as_str() {
                "note" => {
                    let retained: Note = serde_json::from_value(desired.clone()).map_err(|_| Error::invalid("conflict", "invalid local note"))?;
                    let mut server: Note = serde_json::from_value(base.clone()).map_err(|_| Error::invalid("conflict", "invalid remote note"))?;
                    if retained.summary.id.as_str() != local || server.summary.id.as_str() != remote { return Err(Error::invalid("conflict", "note identity mismatch")); }
                    remote_rev = Some(server.summary.rev.get());
                    let current: Note = w.tx.query_row(&format!("SELECT {} FROM notes n WHERE n.id=?1",crate::db::rows::NOTE_COLUMNS_FULL), [&local], crate::db::rows::note)?;
                    local_rev = current.summary.rev.get();
                    if choice == "remote" && current.summary.rev != retained.summary.rev { return Err(Error::Conflict { expected: retained.summary.rev, server: Box::new(current) }); }
                    if choice != "local" {
                        // Conflict snapshots are transport data: never persist a dangling remote folder or file URL.
                        if let Some(folder) = &server.summary.folder_id {
                            let mapped: Option<String> = w.tx.query_row("SELECT local_id FROM sync_map WHERE binding_id=?1 AND binding_epoch=?2 AND entity='folder' AND remote_id=?3",params![binding.binding_id,binding.binding_epoch,folder.as_str()],|r|r.get(0)).optional()?;
                            let folder = mapped.unwrap_or_else(||folder.to_string());
                            let exists: bool = w.tx.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1 AND deleted_at IS NULL)",[&folder],|r|r.get(0))?;
                            if !exists { return Err(Error::invalid("conflict", "remote folder is not available locally")); }
                            server.summary.folder_id = Some(folder.parse()?);
                        }
                        for range in crate::markdown::attachment_references(&server.content).into_iter().rev() {
                            let remote_file = &server.content[range.clone()];
                            let mapped: Option<String> = w.tx.query_row("SELECT local_attachment_id FROM sync_attachment_map WHERE binding_id=?1 AND binding_epoch=?2 AND remote_attachment_id=?3 AND state='ready'",params![binding.binding_id,binding.binding_epoch,remote_file],|r|r.get(0)).optional()?;
                            let local_file = mapped.unwrap_or_else(||remote_file.to_owned());
                            let available: bool = w.tx.query_row("SELECT EXISTS(SELECT 1 FROM attachments WHERE id=?1)",[&local_file],|r|r.get(0))?;
                            if !available { return Err(Error::invalid("conflict", "pull remote attachments before resolving this snapshot")); }
                            server.content.replace_range(range,&local_file);
                        }
                        if server.content.starts_with("---") && server.content.contains("/api/files/") { return Err(Error::invalid("conflict","front-matter attachments require a pulled local snapshot")); }
                        let target = if choice == "keep-both" { w.id()? } else { local.clone() };
                        if choice == "remote" {
                            let version = w.id()?;
                            crate::write::versions::snapshot(&w.tx,&local,&current.summary.title,&current.content,&version,w.now)?;
                        }
                        local_rev = apply_conflict_note(w,&target,&server,if choice == "remote" { Some(&current) } else { None })?;
                        if choice == "keep-both" { local_rev = current.summary.rev.get(); }
                    }
                }
                "folder" | "tag" => {
                    if choice == "keep-both" { return Err(Error::invalid("choice", "keep-both requires a note conflict")); }
                    if !matches!(desired.get("method").and_then(Value::as_str),Some("POST"|"PATCH"|"DELETE")) { return Err(Error::invalid("conflict","unsupported metadata method")); }
                    if !base.is_null() && base.get("id").and_then(Value::as_str) != Some(remote.as_str()) { return Err(Error::invalid("conflict", "metadata identity mismatch")); }
                    if choice == "remote" { apply_conflict_metadata(w,binding,&entity,&local,&desired,&base)?; }
                }
                _ => return Err(Error::invalid("conflict", "unsupported entity")),
            }
            if choice == "local" && !writes.iter().any(|(_,payload,_,rev)| if entity == "note" { *rev == desired.get("rev").and_then(Value::as_i64).unwrap_or(-1) && payload.as_object().is_some_and(|fields|fields.iter().all(|(key,value)|key=="preserveVersion" || desired.get(key)==Some(value))) } else { *payload==desired }) {
                return Err(Error::invalid("conflict","the retained write is no longer available to retry"));
            }
            for (write, mut payload, state, rev) in writes {
                let matches = if entity == "note" { rev == desired.get("rev").and_then(Value::as_i64).unwrap_or(-1) && payload.as_object().is_some_and(|fields|fields.iter().all(|(key,value)|key=="preserveVersion" || desired.get(key)==Some(value))) } else { payload == desired };
                if !matches { if choice == "remote" { return Err(Error::invalid("conflict", "newer queued write must be resolved separately")); } continue; }
                if state == "sending" { return Err(Error::invalid("conflict", "write is still in flight")); }
                if choice == "remote" {
                    w.tx.execute("UPDATE sync_outbox SET state='quarantined',last_error_code='conflict_remote' WHERE binding_id=?1 AND binding_epoch=?2 AND write_id=?3",params![binding.binding_id,binding.binding_epoch,write])?;
                } else {
                    if entity == "note" { payload["preserveVersion"] = json!(true); }
                    else {
                        payload["base"] = metadata_base(&base);
                        if payload.get("method").and_then(Value::as_str) == Some("POST") && !base.is_null() { payload["method"] = json!("PATCH"); }
                        if base.is_null() && payload.get("method").and_then(Value::as_str) != Some("POST") { return Err(Error::invalid("conflict", "remote metadata was deleted; create it explicitly")); }
                    }
                    w.tx.execute("UPDATE sync_outbox SET payload=?1,base_remote_rev=?2,state='pending',next_attempt_at=0,last_error_code=NULL WHERE binding_id=?3 AND binding_epoch=?4 AND write_id=?5",params![serde_json::to_vec(&payload).map_err(|_|Error::invalid("conflict","cannot encode retry"))?,remote_rev,binding.binding_id,binding.binding_epoch,write])?;
                }
            }
            let dirty: bool = w.tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND entity=?3 AND local_id=?4 AND state NOT IN ('acked','quarantined'))",params![binding.binding_id,binding.binding_epoch,entity,local],|r|r.get(0))?;
            w.tx.execute("INSERT INTO sync_map(binding_id,binding_epoch,entity,local_id,remote_id,local_rev,remote_rev,base_payload_json,base_hash,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(binding_id,binding_epoch,entity,local_id) DO UPDATE SET remote_id=excluded.remote_id,local_rev=excluded.local_rev,remote_rev=excluded.remote_rev,base_payload_json=excluded.base_payload_json,base_hash=excluded.base_hash,state=excluded.state",params![binding.binding_id,binding.binding_epoch,entity,local,remote,local_rev,remote_rev,base.to_string(),crate::markdown::sha256_hex(&metadata_base(&base).to_string()),if dirty { "dirty" } else if base.is_null() { "deleted" } else { "synced" }])?;
            w.tx.execute("UPDATE sync_conflict SET resolved_at=?1 WHERE id=?2 AND binding_id=?3 AND binding_epoch=?4 AND resolved_at IS NULL",params![w.now.get(),id,binding.binding_id,binding.binding_epoch])?;
            Ok(())
        })?;
        Ok(())
    }
    /// Lists quarantined binding epochs and their retained write counts.
    /// # Errors
    /// Propagates database locking, query and row decoding failures.
    pub fn sync_quarantined(&self) -> Result<Vec<QuarantinedSummary>, Error> {
        let c = self.conn.lock()?;
        let mut s=c.prepare("SELECT binding_id,binding_epoch,COUNT(*) FROM sync_outbox WHERE state='quarantined' GROUP BY binding_id,binding_epoch")?;
        let mut out = Vec::new();
        for row in s.query_map([], |r| {
            Ok(QuarantinedSummary {
                binding_id: r.get(0)?,
                binding_epoch: r.get(1)?,
                pending: r.get::<_, i64>(2)?.max(0) as u64,
            })
        })? {
            out.push(row?)
        }
        Ok(out)
    }
    /// Quarantines a binding and its remaining writes.
    /// # Errors
    /// Rejects invalid bindings and propagates SQL failures.
    pub fn sync_quarantine(&self, binding: &Binding) -> Result<(), Error> {
        valid_binding(binding)?;
        let c = self.conn.lock()?;
        c.execute("UPDATE sync_state SET status='quarantined',updated_at=?1 WHERE binding_id=?2 AND binding_epoch=?3",params![chrono_free_now(),binding.binding_id,binding.binding_epoch])?;
        c.execute("UPDATE sync_outbox SET state='quarantined' WHERE binding_id=?1 AND binding_epoch=?2 AND state NOT IN ('acked','quarantined')",params![binding.binding_id,binding.binding_epoch])?;
        Ok(())
    }
    /// Exports retained quarantined writes for a binding epoch.
    /// # Errors
    /// Propagates database locking, query and row decoding failures.
    pub fn sync_export_outbox(&self, id: &str, epoch: i64) -> Result<Value, Error> {
        let c = self.conn.lock()?;
        let mut s=c.prepare("SELECT write_id,entity,local_id,local_rev,payload,state,last_error_code FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND state='quarantined' ORDER BY created_at,write_id")?;
        let mut items = Vec::new();
        for row in s.query_map(params![id,epoch],|r|Ok(json!({"writeId":r.get::<_,String>(0)?,"entity":r.get::<_,String>(1)?,"localId":r.get::<_,Option<String>>(2)?,"localRev":r.get::<_,i64>(3)?,"payload":serde_json::from_slice::<Value>(&r.get::<_,Vec<u8>>(4)?).unwrap_or(Value::Null),"state":r.get::<_,String>(5)?,"error":r.get::<_,Option<String>>(6)?})))?{items.push(row?)}
        Ok(json!({"bindingId":id,"bindingEpoch":epoch,"items":items}))
    }
    /// Discards only quarantined writes and marks that binding epoch discarded.
    /// # Errors
    /// Propagates transaction and database locking failures.
    pub fn sync_discard_outbox(&self, id: &str, epoch: i64) -> Result<(), Error> {
        let mut c = self.conn.lock()?;
        let tx = c.transaction()?;
        tx.execute("DELETE FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND state='quarantined'",params![id,epoch])?;
        tx.execute("UPDATE sync_state SET status='discarded',updated_at=?1 WHERE binding_id=?2 AND binding_epoch=?3",params![chrono_free_now(),id,epoch])?;
        tx.commit()?;
        Ok(())
    }
    /// Allocates once inside the same transaction that durably records recovery.
    /// # Errors
    /// Rejects stale bindings and invalid persisted recovery IDs; propagates
    /// missing-write, ID allocation and transaction failures.
    pub fn sync_mark_recovery(&self, binding: &Binding, write: &str) -> Result<String, Error> {
        let mut c = self.conn.lock()?;
        let tx = c.transaction()?;
        require_binding(&tx, binding)?;
        let found: Option<String> = tx.query_row("SELECT recovery_id FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND write_id=?3 AND entity='note' AND state NOT IN ('acked','quarantined')",
            params![binding.binding_id, binding.binding_epoch, write], |r| r.get(0))?;
        let id = match found {
            Some(id) => {
                if !crate::id::is_valid_id(&id) {
                    return Err(Error::invalid(
                        "recoveryId",
                        "invalid persisted recovery id",
                    ));
                }
                id
            }
            None => crate::write::new_id(self.ids.as_ref(), self.clock.now()?, &tx)?,
        };
        tx.execute("UPDATE sync_outbox SET recovery_id=?1,state='recovery' WHERE binding_id=?2 AND binding_epoch=?3 AND write_id=?4",
            params![id, binding.binding_id, binding.binding_epoch, write])?;
        tx.commit()?;
        Ok(id)
    }

    /// Compares the queued baseline before a non-CAS metadata request.
    /// Known changes are blocked with both snapshots retained for user resolution.
    /// # Errors
    /// Rejects stale bindings, malformed baselines/methods and mismatched remote
    /// IDs; propagates missing-write, conflict allocation and SQL failures.
    pub fn sync_metadata_guard(
        &self,
        binding: &Binding,
        write: &str,
        latest: &Value,
    ) -> Result<bool, Error> {
        let mut c = self.conn.lock()?;
        let tx = c.transaction()?;
        require_binding(&tx, binding)?;
        let (entity, local, raw, observed): (String, String, Vec<u8>, i64) = tx.query_row("SELECT entity,local_id,payload,observed_cursor FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND write_id=?3 AND entity IN ('folder','tag') AND kind='metadata' AND state NOT IN ('acked','quarantined','blocked')",
            params![binding.binding_id, binding.binding_epoch, write], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        let payload: Value = serde_json::from_slice(&raw)
            .map_err(|_| Error::invalid("outbox", "invalid metadata snapshot"))?;
        let mapping: Option<MetadataMapping> = tx.query_row("SELECT remote_id,base_payload_json,base_hash,last_remote_cursor FROM sync_map WHERE binding_id=?1 AND binding_epoch=?2 AND entity=?3 AND local_id=?4",
            params![binding.binding_id, binding.binding_epoch, entity, local], |r| Ok(MetadataMapping { remote_id: r.get(0)?, base_payload_json: r.get(1)?, base_hash: r.get(2)?, last_remote_cursor: r.get(3)? })).optional()?;
        let remote = mapping
            .as_ref()
            .map_or(local.as_str(), |m| m.remote_id.as_str());
        if !latest.is_null() && latest.get("id").and_then(Value::as_str) != Some(remote) {
            return Err(Error::invalid("metadata", "remote id mismatch"));
        }
        // A pull after enqueue may replace the mapping baseline; never treat that
        // newer snapshot as permission to overwrite a known remote edit.
        let queued_mapping = mapping
            .as_ref()
            .filter(|m| m.last_remote_cursor.is_none_or(|cursor| cursor <= observed));
        let confirmed = queued_mapping
            .and_then(|m| m.base_payload_json.as_deref())
            .map(serde_json::from_str::<Value>)
            .transpose()
            .map_err(|_| Error::invalid("metadata", "invalid confirmed baseline"))?;
        let base = payload
            .get("base")
            .or_else(|| payload.get("before"))
            .or(confirmed.as_ref());
        let current = metadata_base(latest);
        let unchanged = match payload.get("method").and_then(Value::as_str) {
            Some("POST") => {
                latest.is_null()
                    || payload
                        .get("input")
                        .and_then(Value::as_object)
                        .is_some_and(|fields| {
                            fields
                                .iter()
                                .all(|(key, value)| key == "id" || latest.get(key) == Some(value))
                        })
            }
            Some("PATCH" | "DELETE") => {
                base.is_some_and(|base| !base.is_null() && metadata_base(base) == current)
                    || (base.is_none()
                        && queued_mapping
                            .and_then(|m| m.base_hash.as_ref())
                            .is_some_and(|hash| {
                                !latest.is_null()
                                    && *hash == crate::markdown::sha256_hex(&current.to_string())
                            }))
            }
            _ => return Err(Error::invalid("outbox", "unsupported metadata method")),
        };
        if !unchanged {
            let conflict = crate::write::new_id(self.ids.as_ref(), self.clock.now()?, &tx)?;
            tx.execute("INSERT INTO sync_conflict(id,binding_id,binding_epoch,entity,local_id,remote_id,local_payload,remote_payload,reason,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'metadata_conflict',?9)",
                params![conflict, binding.binding_id, binding.binding_epoch, entity, local, remote, payload.to_string(), latest.to_string(), chrono_free_now()])?;
            tx.execute("UPDATE sync_outbox SET state='blocked',last_error_code='metadata_conflict' WHERE binding_id=?1 AND binding_epoch=?2 AND write_id=?3", params![binding.binding_id, binding.binding_epoch, write])?;
            tx.execute("UPDATE sync_map SET state='conflict' WHERE binding_id=?1 AND binding_epoch=?2 AND entity=?3 AND local_id=?4", params![binding.binding_id, binding.binding_epoch, entity, local])?;
        }
        tx.commit()?;
        Ok(unchanged)
    }

    /// Commits only this frozen write and its confirmed remote baseline; no cursor ACK.
    /// # Errors
    /// Rejects stale bindings, invalid revisions/timestamps and malformed remote
    /// replies; propagates missing frozen-write and transaction failures.
    pub fn sync_ack_metadata(
        &self,
        binding: &Binding,
        write: &str,
        sent: i64,
        remote: &str,
        response: &Value,
        at: i64,
    ) -> Result<(), Error> {
        crate::types::Millis::new(at)?;
        let mut c = self.conn.lock()?;
        let tx = c.transaction()?;
        require_binding(&tx, binding)?;
        let (entity, local, raw): (String, String, Vec<u8>) = tx.query_row("SELECT entity,local_id,payload FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND write_id=?3 AND entity IN ('folder','tag') AND kind='metadata' AND sent_local_rev=?4 AND local_rev=?4 AND state NOT IN ('quarantined','blocked')",
            params![binding.binding_id, binding.binding_epoch, write, sent], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        if sent != 0 || !crate::id::is_valid_id(remote) {
            return Err(Error::invalid("metadata", "invalid revision or remote id"));
        }
        let payload: Value = serde_json::from_slice(&raw)
            .map_err(|_| Error::invalid("outbox", "invalid metadata snapshot"))?;
        let deleted = payload.get("method").and_then(Value::as_str) == Some("DELETE");
        if deleted {
            if response.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(Error::invalid("metadata", "invalid deletion response"));
            }
        } else {
            let id = match entity.as_str() {
                "folder" => {
                    serde_json::from_value::<Folder>(response.clone()).map(|f| f.id.to_string())
                }
                _ => serde_json::from_value::<Tag>(response.clone()).map(|t| t.id.to_string()),
            }
            .map_err(|_| Error::invalid("metadata", "invalid saved metadata"))?;
            if id != remote {
                return Err(Error::invalid("metadata", "remote id mismatch"));
            }
        }
        let base = if deleted {
            Value::Null
        } else {
            metadata_base(response)
        };
        let hash = crate::markdown::sha256_hex(&base.to_string());
        tx.execute("UPDATE sync_outbox SET state='acked',last_error_code=NULL WHERE binding_id=?1 AND binding_epoch=?2 AND write_id=?3 AND sent_local_rev=?4", params![binding.binding_id, binding.binding_epoch, write, sent])?;
        let dirty: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox WHERE binding_id=?1 AND binding_epoch=?2 AND entity=?3 AND local_id=?4 AND state NOT IN ('acked','quarantined'))",
            params![binding.binding_id, binding.binding_epoch, entity, local], |r| r.get(0))?;
        tx.execute("INSERT INTO sync_map(binding_id,binding_epoch,entity,local_id,remote_id,local_rev,remote_rev,sent_local_rev,last_write_id,base_payload_json,base_hash,state) VALUES(?1,?2,?3,?4,?5,0,NULL,?6,?7,?8,?9,?10) ON CONFLICT(binding_id,binding_epoch,entity,local_id) DO UPDATE SET remote_id=excluded.remote_id,remote_rev=NULL,sent_local_rev=excluded.sent_local_rev,last_write_id=excluded.last_write_id,base_payload_json=excluded.base_payload_json,base_hash=excluded.base_hash,state=excluded.state",
            params![binding.binding_id, binding.binding_epoch, entity, local, remote, sent, write, base.to_string(), hash, if dirty { "dirty" } else if deleted { "deleted" } else { "synced" }])?;
        tx.commit()?;
        Ok(())
    }
}
fn entity_parse(value: &str) -> rusqlite::Result<SyncEntity> {
    match value {
        "note" => Ok(SyncEntity::Note),
        "folder" => Ok(SyncEntity::Folder),
        "tag" => Ok(SyncEntity::Tag),
        "attachment" => Ok(SyncEntity::Attachment),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
fn kind_parse(value: &str) -> rusqlite::Result<OutboxKind> {
    match value {
        "create" => Ok(OutboxKind::Create),
        "patch" => Ok(OutboxKind::Patch),
        "trash" => Ok(OutboxKind::Trash),
        "restore" => Ok(OutboxKind::Restore),
        "purge" => Ok(OutboxKind::Purge),
        "metadata" => Ok(OutboxKind::Metadata),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
fn state_parse(value: &str) -> rusqlite::Result<OutboxState> {
    match value {
        "pending" => Ok(OutboxState::Pending),
        "sending" => Ok(OutboxState::Sending),
        "acked" => Ok(OutboxState::Acked),
        "blocked" => Ok(OutboxState::Blocked),
        "quarantined" => Ok(OutboxState::Quarantined),
        "deferred" => Ok(OutboxState::Deferred),
        "error" => Ok(OutboxState::Error),
        "recovery" => Ok(OutboxState::Recovery),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
fn chrono_free_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis().min(i64::MAX as u128) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::write::{ChangeSet, ChangeSink, IdSource, NewNote, WriteEvent, WriteOrigin};
    use crate::{Clock, Library, LibraryDeps, Millis};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    };

    struct FixedClock;
    impl Clock for FixedClock {
        fn now(&self) -> Result<Millis, Error> {
            Millis::new(1000)
        }
    }
    struct SequentialIds(AtomicU64);
    impl IdSource for SequentialIds {
        fn new_id(&self, _: Millis, _: &[u8; 16]) -> String {
            format!("{:026}", self.0.fetch_add(1, Ordering::Relaxed))
        }
    }
    #[derive(Default)]
    struct Sink(Mutex<Vec<ChangeSet>>);
    impl ChangeSink for Sink {
        fn library_changed(&self, changes: ChangeSet) {
            if let Ok(mut events) = self.0.lock() {
                events.push(changes);
            }
        }
        fn write_event(&self, _: WriteEvent) {}
    }

    #[test]
    fn conflict_resolution_is_epoch_scoped_retains_snapshots_and_rolls_back() -> Result<(), Error> {
        let sink = Arc::new(Sink::default());
        let lib = Library::open_in_memory(
            crate::db::test_files_dir(),
            LibraryDeps {
                clock: Arc::new(FixedClock),
                ids: Arc::new(SequentialIds(AtomicU64::new(1))),
                sink: sink.clone(),
            },
        )?;
        let binding = Binding {
            binding_id: "binding".into(),
            binding_epoch: 1,
            site_origin: "https://example.test".into(),
            account_hint: "test".into(),
            remote_user_id: "user".into(),
        };
        let cookie = SyncCookie {
            ciphertext: None,
            domain: "example.test".into(),
            path: "/".into(),
            expires_at: None,
            secure: true,
            host_only: true,
            name: "session".into(),
            same_site: "Lax".into(),
        };
        lib.sync_bind(&binding, &cookie)?;
        let local = lib
            .create_note(
                &NewNote {
                    id: None,
                    title: Some("Local".into()),
                    content: "local body".into(),
                    folder_id: None,
                    is_starred: false,
                },
                WriteOrigin::Ui,
            )?
            .value;
        let mut remote = local.clone();
        remote.content = "remote body #remote".into();
        remote.summary.title = "Remote".into();
        remote.summary.rev = crate::types::Rev::new(9)?;
        let local_raw =
            serde_json::to_string(&local).map_err(|_| Error::invalid("test", "cannot encode"))?;
        let remote_raw =
            serde_json::to_string(&remote).map_err(|_| Error::invalid("test", "cannot encode"))?;
        lib.conn.lock()?.execute("INSERT INTO sync_outbox(binding_id,binding_epoch,entity,write_id,local_id,local_rev,sent_local_rev,observed_cursor,ack_prereq,kind,payload,attachment_refs,next_attempt_at,state,created_at) VALUES('binding',1,'note','write',?1,1,1,0,'{}','patch',?2,'[]',0,'blocked',1000)",params![local.summary.id.as_str(),local_raw.as_bytes()])?;
        let stage = |id: &str| -> Result<(), Error> {
            lib.conn.lock()?.execute("INSERT INTO sync_conflict(id,binding_id,binding_epoch,entity,local_id,remote_id,local_payload,remote_payload,reason,created_at) VALUES(?1,'binding',1,'note',?2,?2,?3,?4,'remote_changed',1000)",params![id,local.summary.id.as_str(),local_raw,remote_raw])?;
            Ok(())
        };
        stage("both")?;
        assert!(
            lib.sync_resolve_conflict(
                &Binding {
                    binding_epoch: 2,
                    ..binding.clone()
                },
                "both",
                "keep-both"
            )
            .is_err()
        );
        assert!(
            lib.sync_resolve_conflict(&binding, "both", "keep-local")
                .is_err()
        );
        lib.conn.lock()?.execute_batch("CREATE TRIGGER reject_resolution BEFORE UPDATE OF resolved_at ON sync_conflict BEGIN SELECT RAISE(ABORT,'test rollback'); END;")?;
        assert!(
            lib.sync_resolve_conflict(&binding, "both", "keep-both")
                .is_err()
        );
        assert_eq!(
            lib.conn
                .lock()?
                .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))?,
            1
        );
        assert_eq!(lib.sync_conflicts()?.len(), 1);
        lib.conn
            .lock()?
            .execute_batch("DROP TRIGGER reject_resolution;")?;
        lib.sync_resolve_conflict(&binding, "both", "keep-both")?;
        assert_eq!(lib.get_note(&local.summary.id)?, local);
        let copy: Note = lib.conn.lock()?.query_row(
            &format!(
                "SELECT {} FROM notes n WHERE n.id<>?1",
                crate::db::rows::NOTE_COLUMNS_FULL
            ),
            [local.summary.id.as_str()],
            crate::db::rows::note,
        )?;
        assert!(crate::id::is_valid_id(copy.summary.id.as_str()));
        assert_eq!(copy.content, remote.content);
        assert_eq!(copy.summary.rev.get(), 1);
        assert!(copy.summary.tags.iter().any(|t| t == "remote"));
        assert!(lib.sync_conflicts()?.is_empty());
        assert_eq!(lib.sync_status()?.conflicts, 0);
        let (raw,rev,base,state):(Vec<u8>,i64,i64,String)=lib.conn.lock()?.query_row("SELECT payload,local_rev,base_remote_rev,state FROM sync_outbox WHERE write_id='write'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        let retained: Note = serde_json::from_slice(&raw)
            .map_err(|_| Error::invalid("test", "invalid retained note"))?;
        assert_eq!(retained, local);
        assert_eq!(rev, 1);
        assert_eq!(base, 9);
        assert_eq!(state, "pending");
        stage("remote")?;
        lib.sync_resolve_conflict(&binding, "remote", "remote")?;
        let adopted = lib.get_note(&local.summary.id)?;
        assert_eq!(adopted.content, remote.content);
        assert_eq!(adopted.summary.rev.get(), 2);
        assert_eq!(
            lib.conn.lock()?.query_row(
                "SELECT state FROM sync_outbox WHERE write_id='write'",
                [],
                |r| r.get::<_, String>(0)
            )?,
            "quarantined"
        );
        assert_eq!(
            lib.conn.lock()?.query_row(
                "SELECT local_payload FROM sync_conflict WHERE id='remote'",
                [],
                |r| r.get::<_, String>(0)
            )?,
            local_raw
        );
        assert!(
            sink.0
                .lock()?
                .iter()
                .any(|event| event.notes.iter().any(|n| n.id == copy.summary.id))
        );
        let tag = lib
            .create_tag(
                &crate::dto::TagCreate {
                    id: None,
                    name: "localtag".into(),
                    color: None,
                },
                WriteOrigin::Ui,
            )?
            .value;
        let tagged = lib
            .create_note(
                &NewNote {
                    id: None,
                    title: Some("Tagged".into()),
                    content: "#localtag".into(),
                    folder_id: None,
                    is_starred: false,
                },
                WriteOrigin::Ui,
            )?
            .value;
        let tag_base = json!({"id":tag.id,"name":"oldtag","color":null,"count":0,"createdAt":1000});
        let payload = json!({"method":"PATCH","input":{"name":"localtag"},"base":tag_base});
        lib.conn.lock()?.execute("INSERT INTO sync_outbox(binding_id,binding_epoch,entity,write_id,local_id,local_rev,sent_local_rev,observed_cursor,ack_prereq,kind,payload,attachment_refs,next_attempt_at,state,created_at) VALUES('binding',1,'tag','metadata',?1,0,0,0,'{}','metadata',?2,'[]',0,'pending',1000)",params![tag.id.as_str(),payload.to_string().as_bytes()])?;
        let latest =
            json!({"id":tag.id,"name":"remotetag","color":null,"count":0,"createdAt":1000});
        assert!(!lib.sync_metadata_guard(&binding, "metadata", &latest)?);
        let conflict = lib
            .sync_conflicts()?
            .into_iter()
            .next()
            .ok_or_else(|| Error::invalid("test", "missing metadata conflict"))?;
        assert!(
            lib.sync_resolve_conflict(&binding, &conflict.id, "keep-both")
                .is_err()
        );
        lib.sync_resolve_conflict(&binding, &conflict.id, "local")?;
        assert!(lib.sync_metadata_guard(&binding, "metadata", &latest)?);
        let newer = json!({"id":tag.id,"name":"newremote","color":null,"count":0,"createdAt":1000});
        assert!(!lib.sync_metadata_guard(&binding, "metadata", &newer)?);
        let conflict = lib
            .sync_conflicts()?
            .into_iter()
            .next()
            .ok_or_else(|| Error::invalid("test", "missing metadata conflict"))?;
        lib.sync_resolve_conflict(&binding, &conflict.id, "remote")?;
        let rewritten = lib.get_note(&tagged.summary.id)?;
        assert_eq!(rewritten.content, "#newremote");
        assert_eq!(rewritten.summary.rev.get(), 2);
        assert!(
            rewritten
                .summary
                .tags
                .iter()
                .any(|name| name == "newremote")
        );
        assert_eq!(lib.sync_state(&binding)?.cursor, 0);
        Ok(())
    }
}
