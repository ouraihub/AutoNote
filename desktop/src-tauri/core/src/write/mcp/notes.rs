use super::*;

pub(super) fn create_note(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let input = NewNote {
            id: args
                .get("note_id")
                .and_then(Value::as_str)
                .map(|v| NoteId::new(v.to_owned()))
                .transpose()?,
            title: args.get("title").and_then(Value::as_str).map(str::to_owned),
            content: args
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            folder_id: args.get("folder_id").and_then(|v| {
                if v.is_null() {
                    None
                } else {
                    v.as_str().and_then(|s| FolderId::new(s.to_owned()).ok())
                }
            }),
            is_starred: false,
        };
        let id = input.id.clone().map(|v| v.to_string()).unwrap_or(w.id()?);
        if note(&w.tx, &id).is_ok() {
            return Err(Error::Duplicate {
                entity: Entity::Note,
            });
        }
        let now = w.now.get();
        let title = input.title.clone().unwrap_or_default();
        let (words, chars) = count_text(&input.content);
        w.tx.execute(
            "INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,\
is_starred,position,content_hash,created_at,updated_at) \
VALUES(?1,?2,?3,?4,?5,1,?6,?7,0,0,?8,?9,?9)",
            params![
                id,
                input.folder_id.as_ref().map(|x| x.as_str()),
                title,
                input.content,
                derive_excerpt(&input.content, 220),
                words as i64,
                chars as i64,
                sha256_hex(&input.content),
                now,
            ],
        )?;
        super::super::derived::derive(
            &w.tx,
            w.ids.as_ref(),
            &id,
            &title,
            &input.content,
            false,
            w.now,
            Some(""),
        )?;
        w.record_change(&id, "upsert")?;
        result_note(note(&w.tx, &id)?)
    })
}

pub(super) fn edit_note(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let nid = id(args, "note_id")?;
        let old = check_rev(&w.tx, &nid, n(args, "expected_rev")?)?;
        if old.summary.deleted_at.is_some() {
            return Err(Error::NoteGone {
                deletion_cursor: None,
            });
        }
        let content = edit(
            &old.content,
            s(args, "operation")?,
            s(args, "text")?,
            args.get("old_text").and_then(Value::as_str),
            args.get("section").and_then(Value::as_str),
        )?;
        result_note(patch_note(
            w,
            &old,
            Some(&content),
            args.get("title").and_then(Value::as_str),
            None,
            None,
            None,
            None,
        )?)
    })
}

pub(super) fn organize_note(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let nid = id(args, "note_id")?;
        let old = check_rev(&w.tx, &nid, n(args, "expected_rev")?)?;
        result_note(patch_note(
            w,
            &old,
            None,
            None,
            if args.get("folder_id").is_some() {
                Some(args.get("folder_id").and_then(|v| v.as_str()))
            } else {
                None
            },
            args.get("starred").and_then(Value::as_bool),
            args.get("archived").and_then(Value::as_bool),
            args.get("pinned").and_then(Value::as_bool),
        )?)
    })
}

pub(super) fn trash_note(w: &mut WriteTx<'_>, args: &Value, tool: &str) -> Result<Value, Error> {
    Ok({
        let nid = id(args, "note_id")?;
        let old = check_rev(&w.tx, &nid, n(args, "expected_rev")?)?;
        let trash = tool == "trash_note";
        if trash != old.summary.deleted_at.is_none() {
            return Err(Error::invalid(
                "note_id",
                if trash {
                    "The note is already in the trash"
                } else {
                    "The note is not in the trash"
                },
            ));
        }
        let now = w.now.get().max(old.summary.updated_at.get() + 1);
        w.tx.execute(
            "UPDATE notes SET deleted_at=?1,rev=rev+1,updated_at=?1 WHERE id=?2 AND rev=?3",
            params![
                if trash { Some(now) } else { None::<i64> },
                nid,
                old.summary.rev.get()
            ],
        )?;
        super::super::derived::derive(
            &w.tx,
            w.ids.as_ref(),
            &nid,
            &old.summary.title,
            &old.content,
            trash,
            w.now,
            Some(&crate::markdown::normalize_link_key(&old.summary.title)),
        )?;
        w.record_change(&nid, "upsert")?;
        result_note(note(&w.tx, &nid)?)
    })
}

pub(super) fn duplicate_note(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let src = live_note(&w.tx, &id(args, "note_id")?)?;
        let nid = w.id()?;
        let title = format!(
            "{} copy",
            truncate_utf16(
                if src.summary.title.is_empty() {
                    "Untitled note"
                } else {
                    &src.summary.title
                },
                507
            )
        );
        let (words, chars) = count_text(&src.content);
        let now = w.now.get();
        w.tx.execute(
            "INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,\
is_archived,position,content_hash,created_at,updated_at) \
VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8,0,?9,?10,?10)",
            params![
                nid,
                src.summary.folder_id.as_ref().map(|v| v.as_str()),
                title,
                src.content,
                derive_excerpt(&src.content, 220),
                words as i64,
                chars as i64,
                src.summary.is_archived,
                sha256_hex(&src.content),
                now,
            ],
        )?;
        super::super::derived::derive(
            &w.tx,
            w.ids.as_ref(),
            &nid,
            &title,
            &src.content,
            false,
            w.now,
            Some(""),
        )?;
        w.record_change(&nid, "upsert")?;
        result_note(note(&w.tx, &nid)?)
    })
}

pub(super) fn restore_note_version(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let nid = id(args, "note_id")?;
        let old = check_rev(&w.tx, &nid, n(args, "expected_rev")?)?;
        let vid = id(args, "version_id")?;
        let (title, content): (String, String) =
            w.tx.query_row(
                "SELECT title,content FROM note_versions WHERE id=?1 AND note_id=?2",
                params![vid, nid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(Error::NotFound {
                entity: Entity::Version,
                id: vid,
            })?;
        result_note(patch_note(
            w,
            &old,
            Some(&content),
            Some(&title),
            None,
            None,
            None,
            None,
        )?)
    })
}

pub(super) fn bulk_organize_notes(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let items = args
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("items"))?;
        if items.is_empty() || items.len() > 20 {
            return Err(bad("items"));
        }
        let mut results = Vec::new();
        for item in items {
            let nid = id(item, "note_id")?;
            match check_rev(&w.tx, &nid, n(item, "expected_rev")?) {
                Ok(old) => match patch_note(
                    w,
                    &old,
                    None,
                    None,
                    if item.get("folder_id").is_some() {
                        Some(item.get("folder_id").and_then(Value::as_str))
                    } else {
                        None
                    },
                    item.get("starred").and_then(Value::as_bool),
                    item.get("archived").and_then(Value::as_bool),
                    item.get("pinned").and_then(Value::as_bool),
                ) {
                    Ok(v) => results.push(json!({"note":v,"ok":true})),
                    Err(e) => results.push(json!({"ok":false,"error":e.to_string()})),
                },
                Err(e) => results.push(json!({"ok":false,"error":e.to_string()})),
            }
        }
        json!({"results":results})
    })
}

pub(super) fn update_note_properties(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let nid = id(args, "note_id")?;
        let old = check_rev(&w.tx, &nid, n(args, "expected_rev")?)?;
        let mut props = if args.get("mode").and_then(Value::as_str) == Some("replace") {
            serde_json::Map::new()
        } else {
            frontmatter(&old.content)
        };
        let incoming = args
            .get("properties")
            .and_then(Value::as_object)
            .ok_or_else(|| bad("properties"))?;
        for (key, value) in incoming {
            props.insert(key.clone(), value.clone());
        }
        let yaml = yaml_properties(&props)?;
        let body = old
            .content
            .split_once("\n---")
            .map_or(old.content.as_str(), |(_, rest)| {
                rest.trim_start_matches('\n')
            });
        let content = if props.is_empty() {
            body.to_owned()
        } else {
            format!("{yaml}{body}")
        };
        result_note(patch_note(
            w,
            &old,
            Some(&content),
            None,
            None,
            None,
            None,
            None,
        )?)
    })
}
