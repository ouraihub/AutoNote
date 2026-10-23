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
    w.tx.execute("UPDATE notes SET folder_id=?1,title=?2,content=?3,excerpt=?4,word_count=?5,char_count=?6,is_pinned=?7,is_starred=?8,is_archived=?9,rev=?10,content_hash=?11,updated_at=?12 WHERE id=?13 AND rev=?14", params![folder_id,next_title,next_content,derive_excerpt(next_content,220),words as i64,chars as i64,pinned.unwrap_or(old.summary.is_pinned),starred.unwrap_or(old.summary.is_starred),archived.unwrap_or(old.summary.is_archived),rev,sha256_hex(next_content),now,old.summary.id.as_str(),old.summary.rev.get()])?;
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
        let out = self.write(WriteOrigin::Mcp, |w| {
            let existing: Option<(String,String,String,String)> = w.tx.query_row("SELECT tool,request_hash,response_json,status FROM mcp_operations WHERE operation_id=?1", [op], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            if let Some((saved_tool,saved_hash,response,status)) = existing {
                if saved_tool != tool || saved_hash != req_hash { return Err(Error::invalid("operation_id", "operation_id was already used with different arguments")); }
                if status == "completed" { return serde_json::from_str(&response).map_err(|_| bad("response")); }
            }
            let value = match tool {
                "create_note" => { let input = NewNote { id: args.get("note_id").and_then(Value::as_str).map(|v| NoteId::new(v.to_owned())).transpose()?, title: args.get("title").and_then(Value::as_str).map(str::to_owned), content: args.get("content").and_then(Value::as_str).unwrap_or_default().to_owned(), folder_id: args.get("folder_id").and_then(|v| if v.is_null(){None}else{v.as_str().and_then(|s|FolderId::new(s.to_owned()).ok())}), is_starred:false }; let id = input.id.clone().map(|v|v.to_string()).unwrap_or(w.id()?); if note(&w.tx,&id).is_ok() { return Err(Error::Duplicate {entity:Entity::Note}); } let now=w.now.get(); let title=input.title.clone().unwrap_or_default(); let (words,chars)=count_text(&input.content); w.tx.execute("INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,is_starred,position,content_hash,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,1,?6,?7,0,0,?8,?9,?9)",params![id,input.folder_id.as_ref().map(|x|x.as_str()),title,input.content,derive_excerpt(&input.content,220),words as i64,chars as i64,sha256_hex(&input.content),now])?; super::derived::derive(&w.tx,w.ids.as_ref(),&id,&title,&input.content,false,w.now,Some(""))?; w.record_change(&id,"upsert")?; result_note(note(&w.tx,&id)?) }
                "edit_note" => { let nid=id(args,"note_id")?; let old=check_rev(&w.tx,&nid,n(args,"expected_rev")?)?; if old.summary.deleted_at.is_some(){return Err(Error::NoteGone{deletion_cursor:None});} let content=edit(&old.content,s(args,"operation")?,s(args,"text")?,args.get("old_text").and_then(Value::as_str),args.get("section").and_then(Value::as_str))?; result_note(patch_note(w,&old,Some(&content),args.get("title").and_then(Value::as_str),None,None,None,None)?) }
                "organize_note" => { let nid=id(args,"note_id")?; let old=check_rev(&w.tx,&nid,n(args,"expected_rev")?)?; result_note(patch_note(w,&old,None,None,if args.get("folder_id").is_some(){Some(args.get("folder_id").and_then(|v|v.as_str()))}else{None},args.get("starred").and_then(Value::as_bool),args.get("archived").and_then(Value::as_bool),args.get("pinned").and_then(Value::as_bool))?) }
                "trash_note" | "restore_note" => { let nid=id(args,"note_id")?; let old=check_rev(&w.tx,&nid,n(args,"expected_rev")?)?; let trash=tool=="trash_note"; if trash != old.summary.deleted_at.is_none(){return Err(Error::invalid("note_id",if trash{"The note is already in the trash"}else{"The note is not in the trash"}));} let now=w.now.get().max(old.summary.updated_at.get()+1); w.tx.execute("UPDATE notes SET deleted_at=?1,rev=rev+1,updated_at=?1 WHERE id=?2 AND rev=?3",params![if trash {Some(now)} else {None::<i64>},nid,old.summary.rev.get()])?; super::derived::derive(&w.tx,w.ids.as_ref(),&nid,&old.summary.title,&old.content,trash,w.now,Some(&crate::markdown::normalize_link_key(&old.summary.title)))?; w.record_change(&nid,"upsert")?; result_note(note(&w.tx,&nid)?) }
                "duplicate_note" => { let src=live_note(&w.tx,&id(args,"note_id")?)?; let nid=w.id()?; let title=format!("{} copy",truncate_utf16(if src.summary.title.is_empty(){"Untitled note"}else{&src.summary.title},507)); let (words,chars)=count_text(&src.content); let now=w.now.get(); w.tx.execute("INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,is_archived,position,content_hash,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8,0,?9,?10,?10)",params![nid,src.summary.folder_id.as_ref().map(|v|v.as_str()),title,src.content,derive_excerpt(&src.content,220),words as i64,chars as i64,src.summary.is_archived,sha256_hex(&src.content),now])?; super::derived::derive(&w.tx,w.ids.as_ref(),&nid,&title,&src.content,false,w.now,Some(""))?; w.record_change(&nid,"upsert")?; result_note(note(&w.tx,&nid)?) }
                "restore_note_version" => { let nid=id(args,"note_id")?; let old=check_rev(&w.tx,&nid,n(args,"expected_rev")?)?; let vid= id(args,"version_id")?; let (title,content):(String,String)=w.tx.query_row("SELECT title,content FROM note_versions WHERE id=?1 AND note_id=?2",params![vid,nid],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(Error::NotFound{entity:Entity::Version,id:vid})?; result_note(patch_note(w,&old,Some(&content),Some(&title),None,None,None,None)?) }
                "create_folder" => { let fid=args.get("folder_id").and_then(Value::as_str).map(|v|v.to_owned()).unwrap_or(w.id()?); let name=s(args,"name")?.trim(); if name.is_empty(){return Err(bad("name"));} w.tx.execute("INSERT INTO folders(id,parent_id,name,icon,color,position,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,0,?6,?6)",params![fid,args.get("parent_id").and_then(Value::as_str),name,args.get("icon").and_then(Value::as_str),args.get("color").and_then(Value::as_str),w.now.get()])?; w.mark(super::DirtyEntity::Folder,&fid); output(w.tx.query_row(&format!("SELECT {FOLDER_COLUMNS} FROM folders f WHERE f.id=?1"),[fid],folder)?)? }
                "update_folder" => { let fid=id(args,"folder_id")?; let expected=n(args,"expected_updated_at")?; let old:(String,Option<String>,Option<String>,Option<String>,i64)=w.tx.query_row("SELECT name,icon,color,parent_id,updated_at FROM folders WHERE id=?1 AND deleted_at IS NULL",[fid.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?.ok_or(Error::NotFound{entity:Entity::Folder,id:fid.clone()})?; if old.4 != expected{return Err(bad("expected_updated_at"));} let now=w.now.get().max(expected+1); w.tx.execute("UPDATE folders SET name=COALESCE(?1,name),icon=CASE WHEN ?2 THEN ?3 ELSE icon END,color=CASE WHEN ?4 THEN ?5 ELSE color END,updated_at=?6 WHERE id=?7",params![args.get("name").and_then(Value::as_str),args.get("icon").is_some(),args.get("icon").and_then(Value::as_str),args.get("color").is_some(),args.get("color").and_then(Value::as_str),now,fid])?; w.mark(super::DirtyEntity::Folder,&fid); output(w.tx.query_row(&format!("SELECT {FOLDER_COLUMNS} FROM folders f WHERE f.id=?1"),[fid],folder)?)? }
                "create_tag" => { let tid=args.get("tag_id").and_then(Value::as_str).map(str::to_owned).unwrap_or(w.id()?); let name=s(args,"name")?.trim().trim_start_matches('#'); if name.is_empty(){return Err(bad("name"));} w.tx.execute("INSERT INTO tags(id,name,color,is_manual,created_at) VALUES(?1,?2,?3,1,?4)",params![tid,name,args.get("color").and_then(Value::as_str),w.now.get()])?; w.mark(super::DirtyEntity::Tag,&tid); output(w.tx.query_row(&format!("SELECT {TAG_COLUMNS} FROM tags t WHERE t.id=?1"),[tid],tag)?)? }
                "update_tag" => { let tid=id(args,"tag_id")?; w.tx.query_row("SELECT name,color FROM tags WHERE id=?1",[tid.as_str()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).optional()?.ok_or(Error::NotFound{entity:Entity::Tag,id:tid.clone()})?; w.tx.execute("UPDATE tags SET name=COALESCE(?1,name),color=CASE WHEN ?2 THEN ?3 ELSE color END,is_manual=1 WHERE id=?4",params![args.get("name").and_then(Value::as_str),args.get("color").is_some(),args.get("color").and_then(Value::as_str),tid])?; w.mark(super::DirtyEntity::Tag,&tid); output(w.tx.query_row(&format!("SELECT {TAG_COLUMNS} FROM tags t WHERE t.id=?1"),[tid],tag)?)? }
                "delete_tag" => { let tid=id(args,"tag_id")?; let affected:i64=w.tx.query_row("SELECT COUNT(*) FROM note_tags WHERE tag_id=?1",[tid.as_str()],|r|r.get(0))?; w.tx.execute("DELETE FROM note_tags WHERE tag_id=?1",[tid.as_str()])?; w.tx.execute("DELETE FROM tags WHERE id=?1",[tid.as_str()])?; w.mark(super::DirtyEntity::Tag,&tid); json!({"ok":true,"affected":affected,"tag_id":tid}) }
                "remove_folder_and_promote_contents" => { let fid=id(args,"folder_id")?; let expected=n(args,"expected_updated_at")?; let parent:Option<String>=w.tx.query_row("SELECT parent_id FROM folders WHERE id=?1 AND deleted_at IS NULL AND updated_at=?2",params![fid.as_str(),expected],|r|r.get(0)).optional()?.ok_or_else(||bad("expected_updated_at"))?; let ids=|sql:&str|->Result<Vec<String>,Error>{let mut stmt=w.tx.prepare(sql)?;let rows=stmt.query_map([fid.as_str()],|r|r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;Ok(rows)}; let children=ids("SELECT id FROM folders WHERE parent_id=?1")?; let notes=ids("SELECT id FROM notes WHERE folder_id=?1")?; w.tx.execute("UPDATE folders SET parent_id=?1,updated_at=?2 WHERE parent_id=?3",params![parent,w.now.get(),fid.as_str()])?; w.tx.execute("UPDATE notes SET folder_id=?1,rev=rev+1,updated_at=?2 WHERE folder_id=?3",params![parent,w.now.get(),fid.as_str()])?; w.tx.execute("UPDATE folders SET deleted_at=?1,updated_at=?1 WHERE id=?2",params![w.now.get(),fid.as_str()])?; for child in &children { w.mark(super::DirtyEntity::Folder,child); } for nid in &notes { w.record_change(nid,"upsert")?; } w.mark(super::DirtyEntity::Folder,&fid); json!({"folder_id":fid,"deleted":true}) }
                "bulk_organize_notes" => { let items=args.get("items").and_then(Value::as_array).ok_or_else(||bad("items"))?; if items.is_empty() || items.len()>20{return Err(bad("items"));} let mut results=Vec::new(); for item in items { let nid=id(item,"note_id")?; match check_rev(&w.tx,&nid,n(item,"expected_rev")?) { Ok(old)=>match patch_note(w,&old,None,None,if item.get("folder_id").is_some(){Some(item.get("folder_id").and_then(Value::as_str))}else{None},item.get("starred").and_then(Value::as_bool),item.get("archived").and_then(Value::as_bool),item.get("pinned").and_then(Value::as_bool)){Ok(v)=>results.push(json!({"note":v,"ok":true})),Err(e)=>results.push(json!({"ok":false,"error":e.to_string()}))},Err(e)=>results.push(json!({"ok":false,"error":e.to_string()}))} } json!({"results":results}) }
                "update_note_properties" => { let nid=id(args,"note_id")?; let old=check_rev(&w.tx,&nid,n(args,"expected_rev")?)?; let mut props=if args.get("mode").and_then(Value::as_str)==Some("replace"){serde_json::Map::new()}else{frontmatter(&old.content)}; let incoming=args.get("properties").and_then(Value::as_object).ok_or_else(||bad("properties"))?; for (key,value) in incoming { props.insert(key.clone(),value.clone()); } let yaml=yaml_properties(&props)?; let body=old.content.split_once("\n---").map_or(old.content.as_str(),|(_,rest)|rest.trim_start_matches('\n')); let content=if props.is_empty(){body.to_owned()}else{format!("{yaml}{body}")}; result_note(patch_note(w,&old,Some(&content),None,None,None,None,None)?) }
                "upload_attachment" => { let aid=args.get("attachment_id").and_then(Value::as_str).map(str::to_owned).unwrap_or(w.id()?); let bytes=decode_base64(s(args,"data")?)?; let file=self.files.mcp_publish(&w.tx,(&aid,args.get("note_id").and_then(Value::as_str)),s(args,"filename")?,s(args,"mime")?,&bytes,w.now.get())?; output(file)? }
                "delete_attachment" => {
                    let aid=id(args,"attachment_id")?;
                    let referenced:bool=w.tx.query_row("SELECT EXISTS(SELECT 1 FROM notes WHERE instr(content,?1)>0 UNION ALL SELECT 1 FROM note_versions WHERE instr(content,?1)>0)",[format!("/api/files/{aid}")],|r|r.get(0))?;
                    if referenced{return Err(Error::invalid("attachment_id","attachment is referenced"));}
                    if w.tx.execute("DELETE FROM attachments WHERE id=?1",[aid.as_str()])?==0{return Err(Error::NotFound{entity:Entity::Attachment,id:aid});}
                    json!({"ok":true,"attachment_id":aid})
                }
                _ => return Err(bad("tool")),
            };
            let encoded=serde_json::to_string(&value).map_err(|_|bad("result"))?;
            w.tx.execute("INSERT INTO mcp_operations(operation_id,tool,request_hash,response_json,status,created_at) VALUES(?1,?2,?3,?4,'completed',?5) ON CONFLICT(operation_id) DO UPDATE SET response_json=excluded.response_json,status='completed'",params![op,tool,req_hash,encoded,w.now.get()])?;
            Ok(value)
        }).map_err(crate::AppError::from)?;
        Ok(out.value)
    }
}
