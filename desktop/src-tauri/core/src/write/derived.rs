use crate::error::Error;
use crate::markdown::{
    extract_tags, extract_wiki_links, normalize_link_key, segment_cjk, truncate_utf16,
};
use crate::types::Millis;
use rusqlite::{OptionalExtension, Transaction, params};

pub(crate) fn derive(
    tx: &Transaction<'_>,
    ids: &dyn super::IdSource,
    id: &str,
    title: &str,
    content: &str,
    deleted: bool,
    now: Millis,
    old_key: Option<&str>,
) -> Result<(), Error> {
    let title_key = normalize_link_key(title);
    tx.execute(
        "UPDATE notes SET title_key=?1 WHERE id=?2",
        params![title_key, id],
    )?;
    tx.execute("DELETE FROM note_tags WHERE note_id=?1", [id])?;
    for name in extract_tags(content) {
        let tag_id: Option<String> = tx.query_row("SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE ORDER BY CASE WHEN name=?1 COLLATE BINARY THEN 0 ELSE 1 END, created_at, id LIMIT 1", [name.as_str()], |r| r.get(0)).optional()?;
        let tag_id = match tag_id {
            Some(v) => v,
            None => {
                let v = super::new_id(ids, now, tx)?;
                tx.execute(
                    "INSERT INTO tags(id,name,is_manual,created_at) VALUES(?1,?2,0,?3)",
                    params![v, name, now.get()],
                )?;
                v
            }
        };
        tx.execute(
            "INSERT OR IGNORE INTO note_tags(note_id,tag_id) VALUES(?1,?2)",
            params![id, tag_id],
        )?;
    }
    tx.execute("DELETE FROM links WHERE source_note_id=?1", [id])?;
    if !deleted {
        for link in extract_wiki_links(content) {
            let target: Option<String> = tx.query_row("SELECT id FROM notes WHERE title_key=?1 AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1",[link.key.as_str()],|r|r.get(0)).optional()?;
            tx.execute("INSERT INTO links(source_note_id,target_key,target_title,target_note_id) VALUES(?1,?2,?3,?4)",params![id,link.key,link.target,target])?;
        }
    }
    if let Some(old_key) = old_key {
        for key in [old_key, &title_key] {
            tx.execute("UPDATE links SET target_note_id=(SELECT id FROM notes WHERE title_key=?1 AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1) WHERE target_key=?1",[key])?;
        }
    }
    tx.execute("DELETE FROM notes_fts WHERE note_id=?1", [id])?;
    if !deleted {
        tx.execute(
            "INSERT INTO notes_fts(note_id,title,body) VALUES(?1,?2,?3)",
            params![
                id,
                segment_cjk(title),
                segment_cjk(&truncate_utf16(content, 200_000))
            ],
        )?;
    }
    tx.execute(
        "DELETE FROM tags WHERE is_manual=0 AND id NOT IN (SELECT tag_id FROM note_tags)",
        [],
    )?;
    Ok(())
}

pub(crate) fn rewrite_wiki_targets(content: &str, from_title: &str, to_title: &str) -> String {
    let from_key = normalize_link_key(from_title);
    let mut result = String::with_capacity(content.len());
    let mut fence: Option<(u8, usize)> = None;
    let mut front = content.starts_with("---\n") || content.starts_with("---\r\n");
    for line in content.split_inclusive('\n') {
        if front {
            result.push_str(line);
            if line.trim_end_matches(['\r', '\n']) == "---" && result.len() > line.len() {
                front = false;
            }
            continue;
        }
        let trimmed = line.trim_start_matches([' ', '\t']);
        let indent = line.len() - trimmed.len();
        if indent <= 3 {
            let marker = trimmed.as_bytes().first().copied();
            if let Some(ch @ (b'`' | b'~')) = marker {
                let n = trimmed.bytes().take_while(|byte| *byte == ch).count();
                if n >= 3 {
                    match fence {
                        Some((old, length)) if old == ch && n >= length => fence = None,
                        None => fence = Some((ch, n)),
                        _ => {}
                    }
                    result.push_str(line);
                    continue;
                }
            }
        }
        if fence.is_some() {
            result.push_str(line);
            continue;
        }
        let mut index = 0;
        while index < line.len() {
            if line[index..].starts_with('`') {
                let count = line[index..].bytes().take_while(|b| *b == b'`').count();
                let delimiter = "`".repeat(count);
                if let Some(end) = line[index + count..].find(&delimiter) {
                    let upto = index + count + end + count;
                    result.push_str(&line[index..upto]);
                    index = upto;
                    continue;
                }
            }
            if line[index..].starts_with("[[") {
                if let Some(close) = line[index + 2..].find("]]") {
                    let end = index + 2 + close;
                    let inner = &line[index + 2..end];
                    let target = inner.split('|').next().unwrap_or("");
                    let split = target.split_once('#').map_or(target, |(n, _)| n);
                    let note = split.trim();
                    if !note.is_empty() && normalize_link_key(note) == from_key {
                        result.push_str("[[");
                        result.push_str(to_title);
                        result.push_str(&target[split.len()..]);
                        result.push_str(&inner[target.len()..]);
                        result.push_str("]]");
                        index = end + 2;
                        continue;
                    }
                }
            }
            let ch = line[index..].chars().next().unwrap_or_default();
            result.push(ch);
            index += ch.len_utf8();
        }
    }
    result
}
