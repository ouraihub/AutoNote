use rusqlite::{params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::time::Instant;

use crate::db::{Library, rows};
use crate::error::Error;
use crate::markdown::{segment_cjk, to_plain_text, truncate_utf16};

/// Strict search request.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchQuery {
    pub q: String,
    pub limit: Option<i64>,
}
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Fts,
    Like,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub note: crate::dto::NoteSummary,
    pub snippet: String,
    pub score: f64,
}
#[derive(Debug, Serialize)]
pub struct SearchTerms {
    pub text: String,
    pub tags: Vec<String>,
    pub folder: Option<String>,
    pub starred: Option<bool>,
    pub archived: Option<bool>,
}
#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchHit>,
    pub mode: SearchMode,
    pub took: u128,
    pub query: SearchTerms,
}

struct Parsed {
    terms: Vec<String>,
    filters: SearchTerms,
    trash: bool,
}
fn parse(raw: &str) -> Parsed {
    let mut terms = Vec::new();
    let mut tags = Vec::new();
    let mut folder = None;
    let mut starred = None;
    let mut archived = None;
    let mut trash = false;
    let mut chars = raw.chars().peekable();
    while chars.peek().is_some() {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut token = String::new();
        let mut quoted = false;
        while let Some(&c) = chars.peek() {
            if c == '"' {
                quoted = !quoted;
                chars.next();
                continue;
            }
            if !quoted && c.is_whitespace() {
                break;
            }
            token.push(c);
            chars.next();
        }
        if token.is_empty() {
            continue;
        }
        if let Some((key, value)) = token.split_once(':') {
            match key.to_ascii_lowercase().as_str() {
                "tag" if !value.is_empty() => {
                    if tags.len() < 8 && !tags.iter().any(|s| s == value) {
                        tags.push(value.trim_start_matches('#').to_string());
                    }
                    continue;
                }
                "folder" if !value.is_empty() => {
                    folder = Some(value.to_string());
                    continue;
                }
                "is" => match value.to_ascii_lowercase().as_str() {
                    "starred" => {
                        starred = Some(true);
                        continue;
                    }
                    "archived" => {
                        archived = Some(true);
                        continue;
                    }
                    "unarchived" => {
                        archived = Some(false);
                        continue;
                    }
                    _ => (),
                },
                "in" if value.eq_ignore_ascii_case("trash") => {
                    trash = true;
                    continue;
                }
                _ => (),
            }
        }
        if terms.len() < 12 && !terms.contains(&token) {
            terms.push(token);
        }
    }
    Parsed {
        filters: SearchTerms {
            text: terms.join(" "),
            tags,
            folder,
            starred,
            archived,
        },
        terms,
        trash,
    }
}
fn escape_like(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            result.push('\\');
        }
        result.push(c);
    }
    result
}
fn snippet(body: &str, terms: &[String]) -> String {
    let plain = to_plain_text(body);
    let lower = plain.to_lowercase();
    let at = terms
        .iter()
        .filter_map(|t| lower.find(&t.to_lowercase()))
        .min()
        .unwrap_or(0);
    let mut at = at.min(plain.len());
    while !plain.is_char_boundary(at) {
        at -= 1;
    }
    let start = plain[..at]
        .char_indices()
        .rev()
        .nth(69)
        .map_or(0, |(i, _)| i);
    let start = if at > 70 { start } else { 0 };
    let content = truncate_utf16(&plain[start..], 180);
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        content,
        if start + content.len() < plain.len() {
            "…"
        } else {
            ""
        }
    )
}

impl Library {
    /// Searches local indexed notes, with a bounded LIKE fallback if FTS is unavailable.
    /// # Errors
    /// Invalid limits and oversized requests return bad_request; database failures propagate.
    pub fn search_query(&self, input: &SearchQuery) -> Result<SearchResponse, Error> {
        let start = Instant::now();
        let limit = input.limit.unwrap_or(50);
        if !(1..=200).contains(&limit) {
            return Err(Error::invalid("limit", "must be between 1 and 200"));
        }
        if input.q.encode_utf16().count() > 512 {
            return Err(Error::invalid("q", "cannot exceed 512 characters"));
        }
        if input.q.trim().is_empty() {
            return Ok(SearchResponse {
                results: Vec::new(),
                mode: SearchMode::Fts,
                took: start.elapsed().as_millis(),
                query: SearchTerms {
                    text: String::new(),
                    tags: Vec::new(),
                    folder: None,
                    starred: None,
                    archived: None,
                },
            });
        }
        let parsed = parse(input.q.trim());
        self.read(|conn| {
            let mut where_sql=String::from(if parsed.trash {"n.deleted_at IS NOT NULL"} else {"n.deleted_at IS NULL"});
            let mut filters=Vec::<Value>::new();
            if let Some(flag)=parsed.filters.starred { where_sql.push_str(" AND n.is_starred=?");filters.push(i64::from(flag).into()); }
            if let Some(flag)=parsed.filters.archived { where_sql.push_str(" AND n.is_archived=?");filters.push(i64::from(flag).into()); }
            for tag in &parsed.filters.tags {where_sql.push_str(" AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id=n.id AND t.name=? COLLATE NOCASE)"); filters.push(tag.clone().into());}
            if let Some(folder)=&parsed.filters.folder {where_sql.push_str(" AND EXISTS (SELECT 1 FROM folders f WHERE f.id=n.folder_id AND f.name=? COLLATE NOCASE)");filters.push(folder.clone().into());}
            let fts_query=parsed.terms.iter().map(|term| {let seg=segment_cjk(term).replace('"',""); let seg=seg.trim().to_owned(); if seg.contains(' ') {format!("\"{seg}\"")} else {format!("\"{seg}\"*")} }).collect::<Vec<_>>().join(" AND ");
            let mut args=filters;
            for term in &parsed.terms {
                where_sql.push_str(" AND (n.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\')");
                let pattern=Value::Text(format!("%{}%",escape_like(term)));
                args.push(pattern.clone());args.push(pattern);
            }
            args.push(limit.into());
            let sql=format!("SELECT {},n.content FROM notes n WHERE {where_sql} ORDER BY n.updated_at DESC,n.id ASC LIMIT ?",rows::NOTE_COLUMNS);
            let mut stmt=conn.prepare(&sql)?;
            let mut results=stmt.query_map(params_from_iter(args), |r| Ok((rows::note_summary(r)?,r.get::<_,String>(15)?)))?
                .map(|row| row.map(|(note,body)| {let score=parsed.terms.iter().map(|t| if note.title.to_lowercase().contains(&t.to_lowercase()) {10.0} else {0.0}).sum();SearchHit{note,snippet:snippet(&body,&parsed.terms),score}}))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut mode=SearchMode::Like;
            if !fts_query.is_empty() && !parsed.trash {
                let sql="SELECT note_id, bm25(notes_fts,0.0,10.0,1.0) FROM notes_fts WHERE notes_fts MATCH ?1 LIMIT 600";
                match conn.prepare(sql).and_then(|mut stmt| stmt.query_map([format!("{{title body}} : ({fts_query})")],|r|Ok((r.get::<_,String>(0)?,r.get::<_,f64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()) {
                    Ok(scores)=>{
                        mode=SearchMode::Fts;
                        let scores:std::collections::HashMap<_,_>=scores.into_iter().collect();
                        for hit in &mut results {
                            if let Some(score) = scores.get(hit.note.id.as_str()) {
                                hit.score = -*score;
                            }
                        }
                    }
                    Err(error)=>tracing::warn!(code=?error.sqlite_error_code(),"search.fts.fallback"),
                }
            }
            Ok(SearchResponse{results,mode,took:start.elapsed().as_millis(),query:parsed.filters})
        })
    }

    /// Rebuilds FTS from committed live notes, in one transaction.
    /// `progress(completed, total)` runs per note; returning an error (e.g.
    /// `Error::Cancelled`) rolls the whole rebuild back.
    /// # Errors
    /// Propagates SQLite failures and the callback's error; changes are atomic.
    pub fn search_reindex(
        &self,
        progress: &mut dyn FnMut(u64, u64) -> Result<(), Error>,
    ) -> Result<u64, Error> {
        let mut conn = self.conn.lock()?;
        let tx = conn.transaction()?;
        let total: i64 = tx.query_row(
            "SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )?;
        tx.execute("DELETE FROM notes_fts", [])?;
        let mut indexed = 0;
        {
            let mut stmt =
                tx.prepare("SELECT id,title,content FROM notes WHERE deleted_at IS NULL")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (id, title, content) = row?;
                tx.execute(
                    "INSERT INTO notes_fts(note_id,title,body) VALUES(?1,?2,?3)",
                    params![
                        id,
                        segment_cjk(&title),
                        segment_cjk(&truncate_utf16(&content, 200_000))
                    ],
                )?;
                indexed += 1;
                progress(indexed, total as u64)?;
            }
        }
        tx.commit()?;
        Ok(indexed)
    }
}
