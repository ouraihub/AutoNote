use super::*;
/// Remote folders ordered so every parent present in the batch precedes its children.
fn parents_first(folders: &[Folder]) -> Vec<&Folder> {
    let mut pending: Vec<&Folder> = folders.iter().collect();
    let mut ordered = Vec::with_capacity(pending.len());
    while !pending.is_empty() {
        let before = pending.len();
        let ids: HashSet<&str> = pending.iter().copied().map(|f| f.id.as_str()).collect();
        pending.retain(|folder| {
            let ready = folder
                .parent_id
                .as_ref()
                .is_none_or(|parent| !ids.contains(parent.as_str()));
            if ready {
                ordered.push(*folder);
            }
            !ready
        });
        if pending.len() == before {
            // A remote cycle: put_folder drops the invalid parent.
            ordered.append(&mut pending);
        }
    }
    ordered
}

fn entity_of(entity: &DeletedEntity) -> DirtyEntity {
    match entity {
        DeletedEntity::Note => DirtyEntity::Note,
        DeletedEntity::Folder => DirtyEntity::Folder,
        DeletedEntity::Tag => DirtyEntity::Tag,
    }
}

/// Applies a remote deletion to a clean local row (22 §7.2): live notes and
/// folders go to the trash, a note already in the trash is purged, tags go.
fn delete_local(w: &mut WriteTx<'_>, entity: DirtyEntity, id: &str) -> Result<(), Error> {
    match entity {
        DirtyEntity::Note => {
            let Some(note) = load_note(&w.tx, id)? else {
                return Ok(());
            };
            if note.summary.deleted_at.is_some() {
                crate::write::notes::purge_tx(w, id)?;
            } else {
                let mut trashed = note.clone();
                trashed.summary.deleted_at = Some(w.now);
                trashed.summary.updated_at =
                    crate::types::Millis::new(w.now.get().max(note.summary.updated_at.get() + 1))?;
                put_note(w, id, &trashed)?;
            }
        }
        DirtyEntity::Folder => {
            let parent: Option<Option<String>> =
                w.tx.query_row(
                    "SELECT parent_id FROM folders WHERE id=?1 AND deleted_at IS NULL",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(parent) = parent else {
                return Ok(());
            };
            // Contents the remote did not already move go up a level, as `strategy=move-up` does.
            let notes: Vec<String> = {
                let mut stmt = w.tx.prepare("SELECT id FROM notes WHERE folder_id=?1")?;
                stmt.query_map([id], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            for note in &notes {
                w.tx.execute(
                    "UPDATE notes SET folder_id=?1,rev=rev+1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",
                    params![parent, w.now.get(), note],
                )?;
                w.record_change(note, "upsert")?;
            }
            let children: Vec<String> = {
                let mut stmt = w
                    .tx
                    .prepare("SELECT id FROM folders WHERE parent_id=?1 AND deleted_at IS NULL")?;
                stmt.query_map([id], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            for child in &children {
                w.tx.execute(
                    "UPDATE folders SET parent_id=?1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",
                    params![parent, w.now.get(), child],
                )?;
                record_organizer(w, "folder", child, "upsert")?;
            }
            w.tx.execute(
                "UPDATE folders SET deleted_at=?1,updated_at=MAX(updated_at+1,?1) WHERE id=?2",
                params![w.now.get(), id],
            )?;
            record_organizer(w, "folder", id, "delete")?;
            w.delete(id.to_owned());
        }
        DirtyEntity::Tag => {
            if w.tx.execute("DELETE FROM tags WHERE id=?1", [id])? > 0 {
                w.tx.execute("DELETE FROM note_tags WHERE tag_id=?1", [id])?;
                record_organizer(w, "tag", id, "delete")?;
            }
        }
    }
    forget(&w.tx, entity, id)
}

/// 22 §7.2 step 3 in the caller's transaction. With `bind`, a differing dirty
/// note is first saved as a conflict copy and organizers take the remote version (§6.4).
fn apply_batch(w: &mut WriteTx<'_>, batch: &RemoteBatch, bind: bool) -> Result<(), Error> {
    for folder in parents_first(&batch.folders) {
        if bind || !is_dirty(&w.tx, DirtyEntity::Folder, folder.id.as_str())? {
            put_folder(w, folder)?;
            set_item(&w.tx, DirtyEntity::Folder, folder.id.as_str(), None, false)?;
        }
    }
    for tag in &batch.tags {
        if bind || !is_dirty(&w.tx, DirtyEntity::Tag, tag.id.as_str())? {
            put_tag(w, tag)?;
            set_item(&w.tx, DirtyEntity::Tag, tag.id.as_str(), None, false)?;
        }
    }
    for remote in &batch.notes {
        let id = remote.summary.id.as_str();
        let dirty = is_dirty(&w.tx, DirtyEntity::Note, id)?;
        // Pull keeps a dirty note; its push gets 409 and resolves there (§7.3).
        if dirty && !bind {
            continue;
        }
        match load_note(&w.tx, id)? {
            Some(local) if same_note(&local, remote) => {}
            Some(local) if dirty => {
                fork_copy(w, &local)?;
                put_note(w, id, remote)?;
            }
            _ => put_note(w, id, remote)?,
        }
        set_item(
            &w.tx,
            DirtyEntity::Note,
            id,
            Some(remote.summary.rev.get()),
            false,
        )?;
    }
    let mut gone: Vec<(DirtyEntity, String)> = batch
        .deletions
        .iter()
        .map(|d| (entity_of(&d.entity), d.id.clone()))
        .collect();
    if batch.full {
        // Rows the remote once confirmed (clean items) but no longer has.
        let present: HashSet<(DirtyEntity, &str)> = batch
            .notes
            .iter()
            .map(|n| (DirtyEntity::Note, n.summary.id.as_str()))
            .chain(
                batch
                    .folders
                    .iter()
                    .map(|f| (DirtyEntity::Folder, f.id.as_str())),
            )
            .chain(batch.tags.iter().map(|t| (DirtyEntity::Tag, t.id.as_str())))
            .collect();
        let mut stmt =
            w.tx.prepare("SELECT entity,id FROM sync_item WHERE dirty=0")?;
        let clean = stmt
            .query_map([], |r| {
                Ok((
                    entity_parse(&r.get::<_, String>(0)?)?,
                    r.get::<_, String>(1)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        gone.extend(
            clean
                .into_iter()
                .filter(|(entity, id)| !present.contains(&(*entity, id.as_str()))),
        );
    }
    for (entity, id) in gone {
        if !is_dirty(&w.tx, entity, &id)? {
            delete_local(w, entity, &id)?;
        }
    }
    w.tx.execute(
        "UPDATE sync_binding SET cursor=?1 WHERE id=1",
        [batch.cursor],
    )?;
    Ok(())
}
