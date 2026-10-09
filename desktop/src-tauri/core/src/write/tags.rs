use super::{WriteOrigin, Written, derived, versions};
use crate::db::rows::{NOTE_COLUMNS, TAG_COLUMNS, note_summary, tag};
use crate::dto::{Tag, TagCreate, TagPatch};
use crate::error::{Entity, Error};
use crate::markdown::{count_text, derive_excerpt, extract_tags, sha256_hex};
use crate::types::{Rev, TagId};
use rusqlite::{OptionalExtension, Transaction, params};

/// Tag after editing; `renamed` counts note bodies changed in this transaction.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TagPatchResult {
    pub tag: Tag,
    pub renamed: u64,
}

/// Number of note bodies changed when deleting the tag.
pub struct TagRemoveResult {
    pub affected: u64,
}

fn name(raw: &str) -> Result<&str, Error> {
    let name = raw.trim().trim_start_matches('#');
    if name.is_empty()
        || name.encode_utf16().count() > 60
        || name.chars().any(|c| c.is_whitespace() || c == '#')
    {
        return Err(Error::invalid(
            "name",
            "must be 1 to 60 characters without spaces or #",
        ));
    }
    Ok(name)
}
fn color(value: Option<&str>) -> Result<(), Error> {
    if value.is_some_and(|value| {
        !matches!(
            value,
            "#dc2626"
                | "#ea580c"
                | "#ca8a04"
                | "#65a30d"
                | "#059669"
                | "#0891b2"
                | "#4f46e5"
                | "#9333ea"
                | "#db2777"
                | "#64748b"
        )
    }) {
        return Err(Error::invalid("color", "unsupported organizer color"));
    }
    Ok(())
}
fn load(tx: &Transaction<'_>, id: &str) -> Result<Tag, Error> {
    let sql = format!("SELECT {TAG_COLUMNS} FROM tags t WHERE t.id=?1");
    tx.query_row(&sql, [id], tag)
        .optional()?
        .ok_or(Error::NotFound {
            entity: Entity::Tag,
            id: id.into(),
        })
}
fn duplicate(
    tx: &Transaction<'_>,
    value: &str,
    exclude: Option<&str>,
) -> Result<Option<(String, String)>, Error> {
    Ok(tx.query_row("SELECT id,name FROM tags WHERE name=?1 COLLATE NOCASE AND id<>COALESCE(?2,'') ORDER BY created_at,id LIMIT 1",params![value,exclude],|r|Ok((r.get(0)?,r.get(1)?))).optional()?)
}
fn record(w: &mut super::WriteTx<'_>, id: &str, op: &str) -> Result<(), Error> {
    w.tx.execute(
        "INSERT INTO changes(entity,entity_id,op,at) VALUES('tag',?1,?2,?3)",
        params![id, op, w.now.get()],
    )?;
    w.changes.tags_changed = true;
    Ok(())
}

// Replace only tags recognized by the same extractor used by derive(). In
// particular, skip fenced/inline code, URLs, and arbitrary YAML structures.
// An ambiguous body is rejected below rather than silently losing associations.
fn replace_tag(content: &str, from: &str, to: Option<&str>) -> String {
    let mut out = String::with_capacity(content.len());
    let mut front = false;
    let mut fence: Option<(char, usize)> = None;
    let mut in_front = content.starts_with("---\n") || content.starts_with("---\r\n");
    for line in content.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if in_front && !front {
            front = true;
            out.push_str(line);
            continue;
        }
        if in_front {
            if bare.trim() == "---" || bare.trim() == "..." {
                in_front = false;
                out.push_str(line);
                continue;
            }
            let trimmed = bare.trim_start();
            if let Some((key, _value)) = trimmed.split_once(':') {
                if key == "tag" || key == "tags" {
                    let prefix_len = line.len() - line.trim_start().len() + key.len() + 1;
                    out.push_str(&line[..prefix_len]);
                    let source = &line[prefix_len..];
                    let mut cursor = 0;
                    for (i, part) in source
                        .split_inclusive([',', ' ', '\t', '[', ']', '\r', '\n'])
                        .enumerate()
                    {
                        let _ = i;
                        let core = part.trim_end_matches([',', ' ', '\t', '[', ']', '\r', '\n']);
                        let normalized = core.trim_start_matches('#');
                        if normalized == from {
                            let start = cursor;
                            if let Some(to) = to {
                                if core.starts_with('#') {
                                    out.push('#');
                                }
                                out.push_str(to);
                            }
                            out.push_str(&part[core.len()..]);
                            cursor = start + part.len();
                        } else {
                            out.push_str(part);
                            cursor += part.len();
                        }
                    }
                    continue;
                }
            }
            out.push_str(line);
            continue;
        }
        let trimmed = bare.trim_start();
        let marker = trimmed.chars().next().unwrap_or(' ');
        let count = trimmed.chars().take_while(|ch| *ch == marker).count();
        if (marker == '`' || marker == '~') && count >= 3 {
            match fence {
                Some((open, len)) if open == marker && count >= len => fence = None,
                None => fence = Some((marker, count)),
                _ => {}
            }
            out.push_str(line);
            continue;
        }
        if fence.is_some() {
            out.push_str(line);
            continue;
        }
        let mut cursor = 0;
        let mut code = false;
        for (index, ch) in line.char_indices() {
            if ch == '`' {
                code = !code;
            }
            if code || ch != '#' {
                continue;
            }
            let before = line[..index].chars().next_back();
            if before.is_some_and(|c| {
                !c.is_whitespace()
                    && !matches!(
                        c,
                        '(' | '（'
                            | '['
                            | '【'
                            | '>'
                            | '「'
                            | '『'
                            | '，'
                            | ','
                            | '、'
                            | ';'
                            | '；'
                    )
            }) {
                continue;
            }
            let start = index + ch.len_utf8();
            let end = start
                + line[start..]
                    .char_indices()
                    .take_while(|(_, c)| c.is_alphanumeric() || matches!(c, '_' | '-' | '/' | '·'))
                    .map(|(_, c)| c.len_utf8())
                    .sum::<usize>();
            if start > cursor && &line[start..end] == from {
                out.push_str(&line[cursor..index]);
                if let Some(to) = to {
                    out.push('#');
                    out.push_str(to);
                }
                cursor = end;
            }
        }
        out.push_str(&line[cursor..]);
    }
    out
}

pub(crate) fn rewrite(
    w: &mut super::WriteTx<'_>,
    tag_id: &str,
    from: &str,
    to: Option<&str>,
) -> Result<u64, Error> {
    let notes = {
        let mut stmt=w.tx.prepare("SELECT n.id,n.title,n.content,n.rev,n.updated_at,n.deleted_at FROM notes n JOIN note_tags nt ON nt.note_id=n.id WHERE nt.tag_id=?1 AND n.deleted_at IS NULL ORDER BY n.id")?;
        let rows = stmt.query_map([tag_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut changed = 0;
    for (id, title, content, rev, updated) in notes {
        let next = replace_tag(&content, from, to);
        if next == content || extract_tags(&next).iter().any(|tag| tag == from) {
            return Err(Error::Duplicate {
                entity: Entity::Tag,
            });
        }
        if next.len() > 2 * 1024 * 1024 {
            return Err(Error::TooLarge {
                field: "content",
                limit: 2 * 1024 * 1024,
            });
        }
        let now = w.now.get().max(updated.saturating_add(1));
        let version = w.id()?;
        versions::snapshot(
            &w.tx,
            &id,
            &title,
            &content,
            &version,
            crate::types::Millis::new(now)?,
        )?;
        let (words, chars) = count_text(&next);
        w.tx.execute("UPDATE notes SET content=?1,excerpt=?2,word_count=?3,char_count=?4,content_hash=?5,rev=?6,updated_at=?7 WHERE id=?8 AND rev=?9",params![next,derive_excerpt(&next,220),words as i64,chars as i64,sha256_hex(&next),Rev::new(rev+1)?.get(),now,id,rev])?;
        derived::derive(
            &w.tx,
            w.ids.as_ref(),
            &id,
            &title,
            &next,
            false,
            w.now,
            None,
        )?;
        let remaining: bool = w.tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM note_tags WHERE note_id=?1 AND tag_id=?2)",
            params![id, tag_id],
            |r| r.get(0),
        )?;
        if remaining {
            return Err(Error::Duplicate {
                entity: Entity::Tag,
            });
        }
        w.record_change(&id, "upsert")?;
        let sql = format!("SELECT {NOTE_COLUMNS} FROM notes n WHERE n.id=?1");
        w.touch_note(w.tx.query_row(&sql, [id], note_summary)?);
        changed += 1;
    }
    Ok(changed)
}

impl crate::db::Library {
    /// Lists all tags with their current live-note usage counts.
    /// # Errors
    /// Returns a database or row-decoding error.
    pub fn list_tags(&self) -> Result<Vec<Tag>, Error> {
        self.read(|db| {
            let sql =
                format!("SELECT {TAG_COLUMNS} FROM tags t ORDER BY t.name COLLATE NOCASE,t.id");
            let mut stmt = db.prepare(&sql)?;
            Ok(stmt
                .query_map([], tag)?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }
    /// Mirrors Web `POST /tags`: an existing `id` is returned as-is.
    /// # Errors
    /// Rejects invalid or duplicate names and database failures.
    pub fn create_tag(
        &self,
        input: &TagCreate,
        origin: WriteOrigin,
    ) -> Result<Written<Tag>, Error> {
        self.write(origin, |w| {
            if let Some(id) = &input.id {
                if let Ok(existing) = load(&w.tx, id.as_str()) {
                    return Ok(existing);
                }
            }
            let next = name(&input.name)?;
            color(input.color.as_deref())?;
            if duplicate(&w.tx, next, None)?.is_some() {
                return Err(Error::Duplicate {
                    entity: Entity::Tag,
                });
            }
            let id = match &input.id {
                Some(id) => id.to_string(),
                None => w.id()?,
            };
            w.tx.execute(
                "INSERT INTO tags(id,name,color,is_manual,created_at) VALUES(?1,?2,?3,1,?4)",
                params![id, next, input.color, w.now.get()],
            )?;
            record(w, &id, "upsert")?;
            load(&w.tx, &id)
        })
    }
    /// Renames a tag and rewrites affected note bodies atomically; absent fields stay.
    /// # Errors
    /// Rejects malformed inputs or unsafe rewrites; all partial changes roll back.
    pub fn patch_tag(
        &self,
        id: &TagId,
        input: &TagPatch,
        origin: WriteOrigin,
    ) -> Result<Written<TagPatchResult>, Error> {
        self.write(origin, |w| {
            let old=load(&w.tx,id.as_str())?;
            let next=match &input.name { Some(n) => name(n)?, None => old.name.as_str() };
            let next_color=match &input.color { Some(c) => { color(c.as_deref())?; c.clone() } None => old.color.clone() };
            let destination=duplicate(&w.tx,next,Some(id.as_str()))?;
            let destination_name = destination.as_ref().map_or(next, |(_, value)| value.as_str());
            let renamed=if next!=old.name { rewrite(w,id.as_str(),&old.name,Some(destination_name))? } else {0};
            if let Some((other,_))=destination {
                w.tx.execute("INSERT OR IGNORE INTO note_tags(note_id,tag_id) SELECT note_id,?1 FROM note_tags WHERE tag_id=?2",params![other,id.as_str()])?;
                w.tx.execute("DELETE FROM note_tags WHERE tag_id=?1",[id.as_str()])?;
                w.tx.execute("DELETE FROM tags WHERE id=?1",[id.as_str()])?;
                record(w,id.as_str(),"delete")?;
                record(w,&other,"upsert")?;
                return Ok(TagPatchResult{tag:load(&w.tx,&other)?,renamed});
            }
            if next!=old.name || next_color!=old.color {
                w.tx.execute("UPDATE tags SET name=?1,color=?2,is_manual=1 WHERE id=?3",params![next,next_color,id.as_str()])?;
                record(w,id.as_str(),"upsert")?;
            }
            Ok(TagPatchResult{tag:load(&w.tx,id.as_str())?,renamed})
        })
    }
    /// Removes the tag after safely editing every live note that references it.
    /// # Errors
    /// Rejects unsafe rewrites; all body and derived-data changes roll back.
    pub fn remove_tag(
        &self,
        id: &TagId,
        origin: WriteOrigin,
    ) -> Result<Written<TagRemoveResult>, Error> {
        self.write(origin, |w| {
            let old = load(&w.tx, id.as_str())?;
            let affected = rewrite(w, id.as_str(), &old.name, None)?;
            w.tx.execute("DELETE FROM note_tags WHERE tag_id=?1", [id.as_str()])?;
            w.tx.execute("DELETE FROM tags WHERE id=?1", [id.as_str()])?;
            record(w, id.as_str(), "delete")?;
            Ok(TagRemoveResult { affected })
        })
    }
}
