//! Atomic MCP mutations. Operation lookup, domain update, and result publication
//! intentionally share the WriteTx transaction.
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{NewNote, WriteOrigin, WriteTx};
use crate::db::{
    Library,
    rows::{FOLDER_COLUMNS, NOTE_COLUMNS_FULL, TAG_COLUMNS, folder, tag},
};
use crate::error::{Entity, Error};
use crate::markdown::{count_text, derive_excerpt, sha256_hex, truncate_utf16};
use crate::types::{FolderId, NoteId, Rev};

mod attachments;
mod notes;
mod organizer;

fn bad(field: &'static str) -> Error {
    Error::invalid(field, "invalid MCP argument")
}
fn s<'a>(a: &'a Value, f: &'static str) -> Result<&'a str, Error> {
    a.get(f).and_then(Value::as_str).ok_or_else(|| bad(f))
}
fn id(a: &Value, f: &'static str) -> Result<String, Error> {
    let v = s(a, f)?;
    if !crate::id::is_valid_id(v) {
        return Err(bad(f));
    }
    Ok(v.to_owned())
}
fn n(a: &Value, f: &'static str) -> Result<i64, Error> {
    a.get(f).and_then(Value::as_i64).ok_or_else(|| bad(f))
}
fn hash(a: &Value) -> Result<String, Error> {
    let raw = serde_json::to_vec(a).map_err(|_| bad("arguments"))?;
    let mut h = Sha256::new();
    h.update(raw);
    Ok(format!("{:x}", h.finalize()))
}
fn note(tx: &rusqlite::Transaction<'_>, id: &str) -> Result<crate::dto::Note, Error> {
    let sql = format!("SELECT {NOTE_COLUMNS_FULL} FROM notes n WHERE n.id=?1");
    tx.query_row(&sql, [id], crate::db::rows::note)
        .optional()?
        .ok_or(Error::NotFound {
            entity: Entity::Note,
            id: id.to_owned(),
        })
}
fn live_note(tx: &rusqlite::Transaction<'_>, id: &str) -> Result<crate::dto::Note, Error> {
    let v = note(tx, id)?;
    if v.summary.deleted_at.is_some() {
        return Err(Error::NoteGone {
            deletion_cursor: None,
        });
    }
    Ok(v)
}
fn output(v: impl serde::Serialize) -> Result<Value, Error> {
    serde_json::to_value(v).map_err(|_| bad("result"))
}
fn frontmatter(content: &str) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let Some(rest) = content.strip_prefix("---\n") else {
        return out;
    };
    let Some(end) = rest.find("\n---") else {
        return out;
    };
    for line in rest[..end].lines() {
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            let value = value.trim();
            if !key.is_empty() {
                out.insert(
                    key.to_owned(),
                    if let Ok(n) = value.parse::<i64>() {
                        json!(n)
                    } else if value.starts_with('[') && value.ends_with(']') {
                        Value::Array(
                            value[1..value.len() - 1]
                                .split(',')
                                .map(|v| {
                                    Value::String(v.trim().trim_matches(['\"', '\'']).to_owned())
                                })
                                .collect(),
                        )
                    } else {
                        json!(value.trim_matches(['\"', '\'']))
                    },
                );
            }
        }
    }
    out
}
fn yaml_properties(properties: &serde_json::Map<String, Value>) -> Result<String, Error> {
    let mut yaml = String::from("---\n");
    for (key, value) in properties {
        if key.is_empty() || key.len() > 120 {
            return Err(bad("properties"));
        }
        let text = match value {
            Value::String(v) => v.clone(),
            Value::Number(v) => v.to_string(),
            Value::Bool(v) => v.to_string(),
            Value::Array(v) => format!(
                "[{}]",
                v.iter()
                    .map(|x| x.as_str().map_or_else(|| x.to_string(), |s| s.to_owned()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Value::Null => "null".to_owned(),
            Value::Object(_) => return Err(bad("properties")),
        };
        yaml.push_str(key);
        yaml.push_str(": ");
        yaml.push_str(&text);
        yaml.push('\n');
    }
    yaml.push_str("---\n");
    Ok(yaml)
}
fn decode_base64(input: &str) -> Result<Vec<u8>, Error> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u8;
    for byte in input.bytes().filter(|b| !b.is_ascii_whitespace()) {
        if byte == b'=' {
            break;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(bad("data")),
        };
        buf = (buf << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}
fn result_note(v: crate::dto::Note) -> Value {
    json!({"note": v})
}
fn check_rev(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    expected: i64,
) -> Result<crate::dto::Note, Error> {
    let v = note(tx, id)?;
    if v.summary.rev.get() != expected {
        return Err(Error::Conflict {
            expected: Rev::new(expected)?,
            server: Box::new(v),
        });
    }
    Ok(v)
}
fn edit(
    content: &str,
    op: &str,
    text: &str,
    old: Option<&str>,
    section: Option<&str>,
) -> Result<String, Error> {
    match op {
        "replace_all" => Ok(text.to_owned()),
        "append" => Ok(format!("{content}{text}")),
        "prepend" => Ok(format!("{text}{content}")),
        "replace" => {
            let old = old.ok_or_else(|| bad("old_text"))?;
            let at = content
                .find(old)
                .ok_or_else(|| Error::invalid("old_text", "text not found"))?;
            if content[at + old.len()..].contains(old) {
                return Err(Error::invalid("old_text", "text is not unique"));
            }
            let mut out = String::with_capacity(content.len() + text.len());
            out.push_str(&content[..at]);
            out.push_str(text);
            out.push_str(&content[at + old.len()..]);
            Ok(out)
        }
        "replace_section" => {
            let name = section.ok_or_else(|| bad("section"))?;
            let mut lines = content
                .split_inclusive('\n')
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let target = format!("# {name}");
            let start = lines
                .iter()
                .position(|line| line.trim_end_matches(['\r', '\n']).trim() == target)
                .ok_or_else(|| Error::NotFound {
                    entity: Entity::Note,
                    id: name.to_owned(),
                })?;
            let mut end = start + 1;
            while end < lines.len() {
                let t = lines[end].trim_start();
                if t.starts_with("# ") {
                    break;
                }
                end += 1;
            }
            let replacement = if text.ends_with('\n') {
                text.to_owned()
            } else {
                format!("{text}\n")
            };
            lines.splice(start..end, [replacement]);
            Ok(lines.concat())
        }
        _ => Err(bad("operation")),
    }
}
fn patch_note(
    w: &mut WriteTx<'_>,
    old: &crate::dto::Note,
    content: Option<&str>,
    title: Option<&str>,
    folder: Option<Option<&str>>,
    starred: Option<bool>,
    archived: Option<bool>,
    pinned: Option<bool>,
) -> Result<crate::dto::Note, Error> {
    let next_content = content.unwrap_or(&old.content);
    let next_title = title
        .map(|v| truncate_utf16(v.trim(), 512))
        .unwrap_or_else(|| old.summary.title.clone());
    if next_content.len() > 2 * 1024 * 1024 {
        return Err(Error::TooLarge {
            field: "content",
            limit: 2 * 1024 * 1024,
        });
    }
    let folder_id = folder
        .map(|f| f.map(str::to_owned))
        .unwrap_or_else(|| old.summary.folder_id.as_ref().map(ToString::to_string));
    if let Some(f) = &folder_id {
        let ok: bool = w.tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1 AND deleted_at IS NULL)",
            [f],
            |r| r.get(0),
        )?;
        if !ok {
            return Err(Error::NotFound {
                entity: Entity::Folder,
                id: f.clone(),
            });
        }
    }
    let changed = next_content != old.content
        || next_title != old.summary.title
        || folder_id.as_deref() != old.summary.folder_id.as_ref().map(|x| x.as_str())
        || starred.is_some_and(|v| v != old.summary.is_starred)
        || archived.is_some_and(|v| v != old.summary.is_archived)
        || pinned.is_some_and(|v| v != old.summary.is_pinned);
    if !changed {
        return Ok(old.clone());
    }
    let now = w.now.get().max(old.summary.updated_at.get() + 1);
    let rev = old.summary.rev.get() + 1;
    let (words, chars) = count_text(next_content);
    if next_content != old.content && !old.content.is_empty() {
        super::versions::snapshot(
            &w.tx,
            old.summary.id.as_str(),
            &old.summary.title,
            &old.content,
            &w.id()?,
            crate::types::Millis::new(now)?,
        )?;
    }
    w.tx.execute(
        "UPDATE notes SET folder_id=?1,title=?2,content=?3,excerpt=?4,word_count=?5,\
char_count=?6,is_pinned=?7,is_starred=?8,is_archived=?9,rev=?10,\
content_hash=?11,updated_at=?12 WHERE id=?13 AND rev=?14",
        params![
            folder_id,
            next_title,
            next_content,
            derive_excerpt(next_content, 220),
            words as i64,
            chars as i64,
            pinned.unwrap_or(old.summary.is_pinned),
            starred.unwrap_or(old.summary.is_starred),
            archived.unwrap_or(old.summary.is_archived),
            rev,
            sha256_hex(next_content),
            now,
            old.summary.id.as_str(),
            old.summary.rev.get(),
        ],
    )?;
    if next_content != old.content || next_title != old.summary.title {
        super::derived::derive(
            &w.tx,
            w.ids.as_ref(),
            old.summary.id.as_str(),
            &next_title,
            next_content,
            old.summary.deleted_at.is_some(),
            w.now,
            Some(&crate::markdown::normalize_link_key(&old.summary.title)),
        )?;
    }
    w.record_change(old.summary.id.as_str(), "upsert")?;
    let sql = format!(
        "SELECT {} FROM notes n WHERE n.id=?1",
        crate::db::rows::NOTE_COLUMNS
    );
    w.touch_note(w.tx.query_row(
        &sql,
        [old.summary.id.as_str()],
        crate::db::rows::note_summary,
    )?);
    note(&w.tx, old.summary.id.as_str())
}

impl Library {
    /// Executes one of the frozen MCP write tools. Idempotency and mutation are
    /// committed by the same SQLite transaction; callers must not preflight it.
    pub fn execute_mcp_write(&self, tool: &str, args: &Value) -> Result<Value, crate::AppError> {
        if !args.is_object() {
            return Err(bad("arguments").into());
        }
        let op = s(args, "operation_id").map_err(crate::AppError::from)?;
        if op.len() < 8
            || op.len() > 128
            || !op
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
        {
            return Err(bad("operation_id").into());
        }
        let req_hash = hash(args).map_err(crate::AppError::from)?;
        let out = self
            .write(WriteOrigin::Mcp, |w| {
                let existing: Option<(String, String, String, String)> =
                    w.tx.query_row(
                        "SELECT tool,request_hash,response_json,status FROM mcp_operations \
WHERE operation_id=?1",
                        [op],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )
                    .optional()?;
                if let Some((saved_tool, saved_hash, response, status)) = existing {
                    if saved_tool != tool || saved_hash != req_hash {
                        return Err(Error::invalid(
                            "operation_id",
                            "operation_id was already used with different arguments",
                        ));
                    }
                    if status == "completed" {
                        return serde_json::from_str(&response).map_err(|_| bad("response"));
                    }
                }
                let value = match tool {
                    "create_note" => notes::create_note(w, args)?,
                    "edit_note" => notes::edit_note(w, args)?,
                    "organize_note" => notes::organize_note(w, args)?,
                    "trash_note" | "restore_note" => notes::trash_note(w, args, tool)?,
                    "duplicate_note" => notes::duplicate_note(w, args)?,
                    "restore_note_version" => notes::restore_note_version(w, args)?,
                    "create_folder" => organizer::create_folder(w, args)?,
                    "update_folder" => organizer::update_folder(w, args)?,
                    "create_tag" => organizer::create_tag(w, args)?,
                    "update_tag" => organizer::update_tag(w, args)?,
                    "delete_tag" => organizer::delete_tag(w, args)?,
                    "remove_folder_and_promote_contents" => {
                        organizer::remove_folder_and_promote_contents(w, args)?
                    }
                    "bulk_organize_notes" => notes::bulk_organize_notes(w, args)?,
                    "update_note_properties" => notes::update_note_properties(w, args)?,
                    "upload_attachment" => attachments::upload_attachment(self, w, args)?,
                    "delete_attachment" => attachments::delete_attachment(w, args)?,
                    _ => return Err(bad("tool")),
                };
                let encoded = serde_json::to_string(&value).map_err(|_| bad("result"))?;
                w.tx.execute(
                    "INSERT INTO mcp_operations(operation_id,tool,request_hash,\
response_json,status,created_at) VALUES(?1,?2,?3,?4,'completed',?5) \
ON CONFLICT(operation_id) DO UPDATE SET \
response_json=excluded.response_json,status='completed'",
                    params![op, tool, req_hash, encoded, w.now.get()],
                )?;
                Ok(value)
            })
            .map_err(crate::AppError::from)?;
        Ok(out.value)
    }
}
