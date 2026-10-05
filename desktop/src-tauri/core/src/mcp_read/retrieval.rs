use super::{bad, iso, note_id, number, string, url};
use crate::{AppError, ErrorCode, Library, SearchQuery};
use serde_json::{Value, json};

pub(super) fn search(lib: &Library, tool: &str, args: &Value) -> Result<Value, crate::AppError> {
    let query = string(args, "query")?;
    let mode = args.get("mode").and_then(Value::as_str).unwrap_or("auto");
    if !matches!(mode, "auto" | "lexical" | "semantic" | "hybrid") {
        return Err(bad("mode"));
    }
    if matches!(mode, "semantic" | "hybrid") {
        return Err(
            AppError::new(ErrorCode::Forbidden, "Semantic search is unavailable").with_details(
                crate::ErrorDetails::Reason {
                    reason: "semantic_search_unavailable",
                },
            ),
        );
    }
    let limit = if tool == "search" {
        8
    } else {
        number(args, "limit", 10, 1, 20)? as i64
    };
    let found = lib.search_query(&SearchQuery {
        q: query.to_owned(),
        limit: Some(limit),
    })?;
    let results = found
        .results
        .into_iter()
        .map(|hit| {
            json!({
                "id": hit.note.id, "title": hit.note.title, "url": url(hit.note.id),
                "snippet": hit.snippet, "score": hit.score, "source": "lexical"
            })
        })
        .collect::<Vec<_>>();
    if tool == "search" {
        Ok(
            json!({"results": results.iter().map(|v| json!({"id":v["id"],"title":v["title"],"url":v["url"]})).collect::<Vec<_>>(), "mode":"lexical"}),
        )
    } else {
        Ok(json!({"results":results,"query":query,"mode":"lexical","next_cursor":null}))
    }
}

pub(super) fn fetch(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let raw = string(args, "id")?;
    let id = raw.strip_prefix("note:").unwrap_or(raw);
    let id = crate::NoteId::new(id.to_owned())?;
    let note = lib.get_note(&id)?;
    let text = crate::markdown::truncate_utf16(&note.content, 40_000);
    let created_at = iso(note.summary.created_at.get())?;
    let updated_at = iso(note.summary.updated_at.get())?;
    Ok(
        json!({"id":note.summary.id,"title":note.summary.title,"text":text,"url":url(note.summary.id),"metadata":{"rev":note.summary.rev,"created_at":created_at,"updated_at":updated_at,"truncated":text.len() < note.content.len()}}),
    )
}

pub(super) fn read_note(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let note = lib.get_note(&note_id(args)?)?;
    let max = number(args, "max_chars", 12_000, 1_000, 40_000)? as usize;
    let cursor = match args.get("cursor") {
        None => 0,
        Some(Value::String(value)) if value.is_empty() => 0,
        Some(Value::String(value)) if value.bytes().all(|byte| byte.is_ascii_digit()) => {
            value.parse::<usize>().map_err(|_| bad("cursor"))?
        }
        _ => return Err(bad("cursor")),
    };
    // Cursors count UTF-16 units like AutoNote, but must land on a scalar boundary.
    let mut start = note.content.len();
    let mut units = 0;
    for (index, ch) in note.content.char_indices() {
        if units == cursor {
            start = index;
            break;
        }
        units += ch.len_utf16();
        if units > cursor {
            return Err(bad("cursor"));
        }
    }
    if units != cursor {
        return Err(bad("cursor"));
    }
    let content = crate::markdown::truncate_utf16(&note.content[start..], max);
    let end = cursor + content.encode_utf16().count();
    let has_more = start + content.len() < note.content.len();
    let next_cursor = has_more.then(|| end.to_string());
    Ok(
        json!({"note_id":note.summary.id,"title":note.summary.title,"rev":note.summary.rev,"text":content,"content":content,"outline":[],"section":args.get("section").and_then(Value::as_str).map(|slug| json!({"slug":slug})),"start_offset":cursor,"end_offset":end,"total_chars":note.content.encode_utf16().count(),"has_more":has_more,"next_cursor":next_cursor}),
    )
}

pub(super) fn list_notes(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let view = match args.get("view") {
        None => "recent",
        Some(Value::String(view))
            if matches!(
                view.as_str(),
                "all" | "recent" | "starred" | "archived" | "trash"
            ) =>
        {
            view
        }
        _ => return Err(bad("view")),
    };
    let limit = number(args, "limit", 20, 1, 50)? as usize;
    let cursor = match args.get("cursor") {
        None => "",
        Some(Value::String(cursor)) => cursor.as_str(),
        _ => return Err(bad("cursor")),
    };
    let (time, id, offset) = if let Some(key) = cursor.strip_prefix("k1.") {
        let (time, id) = key.split_once('.').ok_or_else(|| bad("cursor"))?;
        if time.is_empty()
            || !time
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
            || !crate::id::is_valid_id(id)
        {
            return Err(bad("cursor"));
        }
        let time = i64::from_str_radix(time, 36).map_err(|_| bad("cursor"))?;
        if time > crate::MAX_SAFE_INTEGER {
            return Err(bad("cursor"));
        }
        (Some(time), id, 0)
    } else {
        let offset = if cursor.is_empty() {
            0
        } else {
            if !cursor.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(bad("cursor"));
            }
            cursor.parse::<i64>().map_err(|_| bad("cursor"))?
        };
        if offset > crate::MAX_SAFE_INTEGER {
            return Err(bad("cursor"));
        }
        (None, "", offset)
    };
    let mut page = lib.read(|conn| {
        let sql = format!(
            "SELECT {} FROM notes n WHERE
            ((?1='trash' AND n.deleted_at IS NOT NULL) OR
             (?1<>'trash' AND n.deleted_at IS NULL AND n.is_archived=(?1='archived')))
            AND (?1<>'starred' OR n.is_starred=1)
            AND (?2 IS NULL OR n.updated_at<?2 OR (n.updated_at=?2 AND n.id>?3))
            ORDER BY n.updated_at DESC,n.id ASC LIMIT ?4 OFFSET ?5",
            crate::db::rows::NOTE_COLUMNS
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(
            rusqlite::params![view, time, id, limit as i64 + 1, offset],
            crate::db::rows::note_summary,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    let has_more = page.len() > limit;
    page.truncate(limit);
    let next_cursor = if has_more {
        let last = &page[limit - 1];
        Some(format!("k1.{}.{}", base36(last.updated_at.get()), last.id))
    } else {
        None
    };
    let mut notes = Vec::with_capacity(page.len());
    for note in page {
        notes.push(json!({"id":note.id,"title":note.title,"url":url(&note.id),"excerpt":note.excerpt,"tags":note.tags,"rev":note.rev,"starred":note.is_starred,"archived":note.is_archived,"deleted_at":note.deleted_at.map(|time| iso(time.get())).transpose()?,"updated_at":iso(note.updated_at.get())?}));
    }
    Ok(json!({"notes":notes,"next_cursor":next_cursor}))
}

fn base36(mut value: i64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut buffer = [0u8; 13];
    let mut start = buffer.len();
    loop {
        start -= 1;
        buffer[start] = DIGITS[(value % 36) as usize];
        value /= 36;
        if value == 0 {
            break;
        }
    }
    buffer[start..]
        .iter()
        .map(|byte| char::from(*byte))
        .collect()
}

pub(super) fn context(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let id = note_id(args)?;
    let note = lib.get_note(&id)?;
    let limit = number(args, "limit", 20, 1, 30)? as usize;
    let backlinks = lib
        .backlinks(&id)?
        .into_iter()
        .take(limit)
        .collect::<Vec<_>>();
    let outgoing = crate::markdown::extract_wiki_links(&note.content)
        .into_iter()
        .take(limit)
        .map(|l| json!({"target":l.target,"alias":l.alias}))
        .collect::<Vec<_>>();
    Ok(json!({"note_id":id,"outline":[],"outgoing":outgoing,"backlinks":backlinks}))
}
