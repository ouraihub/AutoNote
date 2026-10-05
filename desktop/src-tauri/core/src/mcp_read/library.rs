use super::{bad, note_id, number, string};
use crate::{AttachmentId, Error, ErrorCode, FolderId, Library, TagId};
use serde_json::{Value, json};

pub(super) fn folders(lib: &Library) -> Result<Value, crate::AppError> {
    Ok(json!({"folders": lib.list_folders(false)?}))
}
pub(super) fn tags(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let limit = number(args, "limit", 100, 1, 200)? as usize;
    let mut tags = lib.list_tags()?;
    tags.truncate(limit);
    Ok(json!({"tags":tags}))
}
pub(super) fn preview_tag(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let id = TagId::new(string(args, "tag_id")?.to_owned())?;
    let next = args.get("next_name").and_then(Value::as_str);
    let tag = lib
        .list_tags()?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| {
            crate::AppError::from(Error::NotFound {
                entity: crate::Entity::Tag,
                id: id.to_string(),
            })
        })?;
    let affected=lib.read(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id=nt.note_id WHERE nt.tag_id=?1 AND n.deleted_at IS NULL",[id.as_str()],|r|r.get::<_,i64>(0))?))?;
    Ok(json!({"tag":tag,"next_name":next,"affected_notes":affected,"risks":[]}))
}
pub(super) fn preview_folder(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let id = FolderId::new(string(args, "folder_id")?.to_owned())?;
    let folders = lib.list_folders(false)?;
    if !folders.iter().any(|f| f.id == id) {
        return Err(crate::AppError::from(Error::NotFound {
            entity: crate::Entity::Folder,
            id: id.to_string(),
        }));
    }
    let children = folders
        .iter()
        .filter(|f| f.parent_id.as_ref() == Some(&id))
        .map(|f| json!({"id":f.id,"name":f.name}))
        .collect::<Vec<_>>();
    let notes = lib.read(|conn| {
        Ok(conn
            .prepare(
                "SELECT id,title FROM notes WHERE folder_id=?1 AND deleted_at IS NULL ORDER BY id",
            )?
            .query_map([id.as_str()], |r| {
                Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?}))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    Ok(json!({"folder_id":id,"child_folders":children,"notes":notes,"conflicts":[],"risks":[]}))
}
pub(super) fn attachments(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let note = args.get("note_id").and_then(Value::as_str);
    let page = lib.files_list(None)?;
    let files = page
        .files
        .into_iter()
        .filter(|f| {
            note.is_none_or(|id| {
                f.attachment
                    .note_id
                    .as_ref()
                    .is_some_and(|n| n.as_str() == id)
            })
        })
        .take(number(args, "limit", 20, 1, 50).unwrap_or(20) as usize)
        .collect::<Vec<_>>();
    Ok(json!({"files":files,"next_cursor":page.next_cursor}))
}
pub(super) fn attachment(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let id = AttachmentId::new(string(args, "attachment_id")?.to_owned())?;
    let max = number(args, "max_bytes", 262144, 1024, 1048576)? as usize;
    let cursor = number(args, "cursor", 0, 0, u64::MAX)? as usize;
    let (bytes, meta, hash) = lib.files_sync_source(&id)?;
    let end = (cursor + max).min(bytes.len());
    use base64::Engine;
    Ok(
        json!({"attachment_id":id,"filename":meta.filename,"mime":meta.mime,"size":bytes.len(),"data":base64::engine::general_purpose::STANDARD.encode(&bytes[cursor..end]),"next_cursor":(end<bytes.len()).then_some(end),"sha256":hash}),
    )
}
pub(super) fn properties(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let id = note_id(args)?;
    let note = lib.get_note(&id)?;
    Ok(json!({"note_id":id,"rev":note.summary.rev,"properties":frontmatter(&note.content)}))
}
pub(super) fn query_properties(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let conditions = args
        .get("conditions")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("conditions"))?;
    if conditions.is_empty()
        || conditions.len() > 8
        || conditions.iter().any(|condition| {
            condition.get("value").is_some_and(|value| {
                value.to_string().len() > 1000 || value.to_string().matches('[').count() > 4
            })
        })
    {
        return Err(bad("conditions"));
    }
    let limit = number(args, "limit", 20, 1, 50)? as usize;
    let page = lib.list_notes(&crate::ListNotesQuery {
        limit: Some(200),
        ..Default::default()
    })?;
    let mut results = Vec::new();
    for summary in page.notes {
        let note = lib.get_note(&summary.id)?;
        let properties = frontmatter(&note.content);
        if conditions
            .iter()
            .all(|condition| matches_condition(&properties, condition))
        {
            results.push(json!({"id":summary.id,"title":summary.title,"properties":properties}));
            if results.len() >= limit {
                break;
            }
        }
    }
    Ok(json!({"results":results}))
}
pub(super) fn graph(lib: &Library, args: &Value) -> Result<Value, crate::AppError> {
    let id = note_id(args)?;
    let depth = number(args, "depth", 2, 1, 3)? as i64;
    let max = number(args, "max_nodes", 60, 2, 100)? as i64;
    serde_json::to_value(lib.search_graph(&crate::GraphQuery {
        mode: Some("local".into()),
        center: Some(id),
        depth: Some(depth),
        limit: Some(max),
        ..Default::default()
    })?)
    .map_err(|_| crate::AppError::new(ErrorCode::Internal, "Internal error"))
}
fn frontmatter(content: &str) -> Value {
    let Some(rest) = content.strip_prefix("---\n") else {
        return json!({});
    };
    let Some(end) = rest.find("\n---") else {
        return json!({});
    };
    let mut obj = serde_json::Map::new();
    for line in rest[..end].lines() {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            let v = v.trim();
            if v.starts_with('[') && v.ends_with(']') {
                obj.insert(
                    k.into(),
                    Value::Array(
                        v[1..v.len() - 1]
                            .split(',')
                            .map(|s| Value::String(s.trim().trim_matches(['\'', '\"']).to_owned()))
                            .collect(),
                    ),
                );
            } else if let Ok(n) = v.parse::<i64>() {
                obj.insert(k.into(), json!(n));
            } else {
                obj.insert(k.into(), json!(v.trim_matches(['\'', '\"'])));
            }
        }
    }
    Value::Object(obj)
}
fn matches_condition(props: &Value, c: &Value) -> bool {
    let Some(key) = c.get("key").and_then(Value::as_str) else {
        return false;
    };
    let Some(actual) = props.get(key) else {
        return false;
    };
    match c
        .get("operator")
        .and_then(Value::as_str)
        .unwrap_or("equals")
    {
        "contains" => c.get("value").is_some_and(|v| {
            actual
                .to_string()
                .to_lowercase()
                .contains(&v.to_string().to_lowercase())
        }),
        "exists" => true,
        _ => c.get("value") == Some(actual),
    }
}
