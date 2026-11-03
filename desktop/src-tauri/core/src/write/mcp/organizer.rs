use super::*;

pub(super) fn create_folder(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let fid = args
            .get("folder_id")
            .and_then(Value::as_str)
            .map(|v| v.to_owned())
            .unwrap_or(w.id()?);
        let name = s(args, "name")?.trim();
        if name.is_empty() {
            return Err(bad("name"));
        }
        w.tx.execute(
            "INSERT INTO folders(id,parent_id,name,icon,color,position,created_at,updated_at) \
VALUES(?1,?2,?3,?4,?5,0,?6,?6)",
            params![
                fid,
                args.get("parent_id").and_then(Value::as_str),
                name,
                args.get("icon").and_then(Value::as_str),
                args.get("color").and_then(Value::as_str),
                w.now.get(),
            ],
        )?;
        w.mark(super::super::DirtyEntity::Folder, &fid);
        output(w.tx.query_row(
            &format!("SELECT {FOLDER_COLUMNS} FROM folders f WHERE f.id=?1"),
            [fid],
            folder,
        )?)?
    })
}

pub(super) fn update_folder(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let fid = id(args, "folder_id")?;
        let expected = n(args, "expected_updated_at")?;
        let old: (String, Option<String>, Option<String>, Option<String>, i64) =
            w.tx.query_row(
                "SELECT name,icon,color,parent_id,updated_at FROM folders \
WHERE id=?1 AND deleted_at IS NULL",
                [fid.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?
            .ok_or(Error::NotFound {
                entity: Entity::Folder,
                id: fid.clone(),
            })?;
        if old.4 != expected {
            return Err(bad("expected_updated_at"));
        }
        let now = w.now.get().max(expected + 1);
        w.tx.execute(
            "UPDATE folders SET name=COALESCE(?1,name),icon=CASE WHEN ?2 THEN ?3 ELSE icon END,\
color=CASE WHEN ?4 THEN ?5 ELSE color END,updated_at=?6 WHERE id=?7",
            params![
                args.get("name").and_then(Value::as_str),
                args.get("icon").is_some(),
                args.get("icon").and_then(Value::as_str),
                args.get("color").is_some(),
                args.get("color").and_then(Value::as_str),
                now,
                fid,
            ],
        )?;
        w.mark(super::super::DirtyEntity::Folder, &fid);
        output(w.tx.query_row(
            &format!("SELECT {FOLDER_COLUMNS} FROM folders f WHERE f.id=?1"),
            [fid],
            folder,
        )?)?
    })
}

pub(super) fn create_tag(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let tid = args
            .get("tag_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or(w.id()?);
        let name = s(args, "name")?.trim().trim_start_matches('#');
        if name.is_empty() {
            return Err(bad("name"));
        }
        w.tx.execute(
            "INSERT INTO tags(id,name,color,is_manual,created_at) VALUES(?1,?2,?3,1,?4)",
            params![
                tid,
                name,
                args.get("color").and_then(Value::as_str),
                w.now.get()
            ],
        )?;
        w.mark(super::super::DirtyEntity::Tag, &tid);
        output(w.tx.query_row(
            &format!("SELECT {TAG_COLUMNS} FROM tags t WHERE t.id=?1"),
            [tid],
            tag,
        )?)?
    })
}

pub(super) fn update_tag(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let tid = id(args, "tag_id")?;
        w.tx.query_row(
            "SELECT name,color FROM tags WHERE id=?1",
            [tid.as_str()],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?
        .ok_or(Error::NotFound {
            entity: Entity::Tag,
            id: tid.clone(),
        })?;
        w.tx.execute(
            "UPDATE tags SET name=COALESCE(?1,name),\
color=CASE WHEN ?2 THEN ?3 ELSE color END,is_manual=1 WHERE id=?4",
            params![
                args.get("name").and_then(Value::as_str),
                args.get("color").is_some(),
                args.get("color").and_then(Value::as_str),
                tid,
            ],
        )?;
        w.mark(super::super::DirtyEntity::Tag, &tid);
        output(w.tx.query_row(
            &format!("SELECT {TAG_COLUMNS} FROM tags t WHERE t.id=?1"),
            [tid],
            tag,
        )?)?
    })
}

pub(super) fn delete_tag(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let tid = id(args, "tag_id")?;
        let affected: i64 = w.tx.query_row(
            "SELECT COUNT(*) FROM note_tags WHERE tag_id=?1",
            [tid.as_str()],
            |r| r.get(0),
        )?;
        w.tx.execute("DELETE FROM note_tags WHERE tag_id=?1", [tid.as_str()])?;
        w.tx.execute("DELETE FROM tags WHERE id=?1", [tid.as_str()])?;
        w.mark(super::super::DirtyEntity::Tag, &tid);
        json!({"ok":true,"affected":affected,"tag_id":tid})
    })
}

pub(super) fn remove_folder_and_promote_contents(
    w: &mut WriteTx<'_>,
    args: &Value,
) -> Result<Value, Error> {
    Ok({
        let fid = id(args, "folder_id")?;
        let expected = n(args, "expected_updated_at")?;
        let parent: Option<String> =
            w.tx.query_row(
                "SELECT parent_id FROM folders WHERE id=?1 \
AND deleted_at IS NULL AND updated_at=?2",
                params![fid.as_str(), expected],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| bad("expected_updated_at"))?;
        let ids = |sql: &str| -> Result<Vec<String>, Error> {
            let mut stmt = w.tx.prepare(sql)?;
            let rows = stmt
                .query_map([fid.as_str()], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(rows)
        };
        let children = ids("SELECT id FROM folders WHERE parent_id=?1")?;
        let notes = ids("SELECT id FROM notes WHERE folder_id=?1")?;
        w.tx.execute(
            "UPDATE folders SET parent_id=?1,updated_at=?2 WHERE parent_id=?3",
            params![parent, w.now.get(), fid.as_str()],
        )?;
        w.tx.execute(
            "UPDATE notes SET folder_id=?1,rev=rev+1,updated_at=?2 WHERE folder_id=?3",
            params![parent, w.now.get(), fid.as_str()],
        )?;
        w.tx.execute(
            "UPDATE folders SET deleted_at=?1,updated_at=?1 WHERE id=?2",
            params![w.now.get(), fid.as_str()],
        )?;
        for child in &children {
            w.mark(super::super::DirtyEntity::Folder, child);
        }
        for nid in &notes {
            w.record_change(nid, "upsert")?;
        }
        w.mark(super::super::DirtyEntity::Folder, &fid);
        json!({"folder_id":fid,"deleted":true})
    })
}
