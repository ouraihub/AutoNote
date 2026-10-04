use crate::db::Library;
use crate::error::Error;
use crate::types::{FolderId, NoteId};
use rusqlite::{Connection, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphQuery {
    pub mode: Option<String>,
    pub center: Option<NoteId>,
    pub depth: Option<i64>,
    pub q: Option<String>,
    pub folder_id: Option<FolderId>,
    pub tag: Option<String>,
    pub include_orphans: Option<bool>,
    pub include_unresolved: Option<bool>,
    pub limit: Option<i64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphTag {
    pub name: String,
    pub color: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub kind: &'static str,
    pub degree: u64,
    pub in_degree: u64,
    pub out_degree: u64,
    pub folder_id: Option<String>,
    pub folder_name: Option<String>,
    pub folder_color: Option<String>,
    pub tags: Vec<GraphTag>,
}
#[derive(Debug, Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMeta {
    pub mode: String,
    pub center_id: Option<String>,
    pub depth: i64,
    pub total_nodes: usize,
    pub total_edges: usize,
    pub truncated: bool,
    pub limit: i64,
}
#[derive(Debug, Serialize)]
pub struct GraphResponse {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub meta: GraphMeta,
}

const EDGE_LIMIT: i64 = 10_000;
const LINK_SCAN_LIMIT: i64 = 50_000;
const UNRESOLVED_LIMIT: usize = 50;
const DEGREE: &str = "(SELECT COUNT(*) FROM links l WHERE l.target_note_id=n.id AND l.source_note_id<>n.id) + (SELECT COUNT(*) FROM links l WHERE l.source_note_id=n.id AND l.target_note_id IS NOT NULL)";
const BASE: &str = "n.deleted_at IS NULL AND n.is_archived=0";

fn filters(q: &GraphQuery, binds: &mut Vec<Value>) -> String {
    let mut sql = String::from(BASE);
    if let Some(term) = q.q.as_deref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND n.title LIKE ? ESCAPE '\\' COLLATE NOCASE");
        let mut pattern = String::from("%");
        for c in term.chars() {
            if matches!(c, '%' | '_' | '\\') {
                pattern.push('\\');
            }
            pattern.push(c);
        }
        pattern.push('%');
        binds.push(pattern.into());
    }
    if let Some(id) = &q.folder_id {
        sql.push_str(" AND n.folder_id=?");
        binds.push(id.as_str().to_owned().into());
    }
    if let Some(tag) = q.tag.as_deref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND EXISTS(SELECT 1 FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id=n.id AND t.name=? COLLATE NOCASE)");
        binds.push(tag.to_owned().into());
    }
    if q.include_orphans == Some(false) {
        sql.push_str(" AND EXISTS(SELECT 1 FROM links l WHERE l.target_note_id IS NOT NULL AND (l.source_note_id=n.id OR l.target_note_id=n.id))");
    }
    sql
}
fn local_prefix(mode: &str) -> &'static str {
    if mode == "local" {
        "WITH RECURSIVE walk(id,depth) AS (
            SELECT ?1, 0 UNION
            SELECT CASE WHEN l.source_note_id=walk.id THEN l.target_note_id ELSE l.source_note_id END, walk.depth+1
            FROM walk JOIN links l ON l.target_note_id IS NOT NULL AND (l.source_note_id=walk.id OR l.target_note_id=walk.id)
            JOIN notes neighbor ON neighbor.id=CASE WHEN l.source_note_id=walk.id THEN l.target_note_id ELSE l.source_note_id END
              AND neighbor.deleted_at IS NULL AND neighbor.is_archived=0
            WHERE walk.depth<?2
          ), nearby AS (SELECT id,MIN(depth) depth FROM walk GROUP BY id) "
    } else {
        ""
    }
}
fn base_from(mode: &str) -> &'static str {
    if mode == "local" {
        "FROM nearby JOIN notes n ON n.id=nearby.id"
    } else {
        "FROM notes n"
    }
}
fn all_binds(q: &GraphQuery, mode: &str, depth: i64, filters: Vec<Value>) -> Vec<Value> {
    let mut values = Vec::new();
    if mode == "local" {
        values.push(Value::Text(
            q.center.as_ref().map_or(String::new(), ToString::to_string),
        ));
        values.push(depth.into());
    }
    values.extend(filters);
    values
}
fn load_nodes(
    conn: &Connection,
    q: &GraphQuery,
    mode: &str,
    depth: i64,
    limit: i64,
) -> Result<(Vec<GraphNode>, usize), Error> {
    let mut binds = Vec::new();
    let where_sql = filters(q, &mut binds);
    let from = base_from(mode);
    let prefix = local_prefix(mode);
    let base_binds = all_binds(q, mode, depth, binds);
    let count_sql = format!("{prefix}SELECT COUNT(*) {from} WHERE {where_sql}");
    let total: i64 = conn.query_row(&count_sql, params_from_iter(&base_binds), |r| r.get(0))?;
    let sort = if mode == "local" {
        "nearby.depth ASC,"
    } else {
        ""
    };
    let sql = format!(
        "{prefix}SELECT n.id,n.title,n.folder_id,f.name,f.color, \
        (SELECT COUNT(*) FROM links l WHERE l.target_note_id=n.id AND l.source_note_id<>n.id) AS inbound, \
        (SELECT COUNT(*) FROM links l WHERE l.source_note_id=n.id AND l.target_note_id IS NOT NULL) AS outbound \
        {from} LEFT JOIN folders f ON f.id=n.folder_id AND f.deleted_at IS NULL \
        WHERE {where_sql} ORDER BY {sort} {DEGREE} DESC,n.updated_at DESC,n.id ASC LIMIT ?"
    );
    let mut args = base_binds;
    args.push(limit.into());
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(&args), |r| {
        let inbound: i64 = r.get(5)?;
        let outbound: i64 = r.get(6)?;
        Ok(GraphNode {
            id: r.get(0)?,
            title: r.get(1)?,
            kind: "note",
            degree: (inbound + outbound).max(0) as u64,
            in_degree: inbound.max(0) as u64,
            out_degree: outbound.max(0) as u64,
            folder_id: r.get(2)?,
            folder_name: r.get(3)?,
            folder_color: r.get(4)?,
            tags: Vec::new(),
        })
    })?;
    Ok((
        rows.collect::<rusqlite::Result<Vec<_>>>()?,
        total.max(0) as usize,
    ))
}

impl Library {
    /// Returns bounded graph nodes and edges; counts include nodes beyond the output limit.
    /// # Errors
    /// Invalid filters are rejected and database errors propagate.
    pub fn search_graph(&self, q: &GraphQuery) -> Result<GraphResponse, Error> {
        let mode = q.mode.as_deref().unwrap_or("global");
        if !matches!(mode, "global" | "local") {
            return Err(Error::invalid("mode", "unknown graph mode"));
        }
        let depth = q.depth.unwrap_or(1);
        let limit = q.limit.unwrap_or(350);
        if !(1..=3).contains(&depth) {
            return Err(Error::invalid("depth", "must be between 1 and 3"));
        }
        if !(50..=600).contains(&limit) {
            return Err(Error::invalid("limit", "must be between 50 and 600"));
        }
        if mode == "local" && q.center.is_none() {
            return Err(Error::invalid("center", "local graph requires center"));
        }
        if q.q
            .as_deref()
            .is_some_and(|s| s.encode_utf16().count() > 200)
        {
            return Err(Error::invalid("q", "graph search too long"));
        }
        if q.tag
            .as_deref()
            .is_some_and(|s| s.encode_utf16().count() > 60)
        {
            return Err(Error::invalid("tag", "tag too long"));
        }
        self.read(|conn| {
            if mode=="local" && let Some(center)=&q.center {
                let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1 AND deleted_at IS NULL AND is_archived=0)",[center.as_str()],|r|r.get(0))?;
                if !exists {return Err(Error::invalid("center","center note unavailable"));}
            }
            let note_limit=if q.include_unresolved==Some(true) {(limit-50).max(1)} else {limit};
            let (mut nodes,total)=load_nodes(conn,q,mode,depth,note_limit+1)?;
            let mut truncated=nodes.len()>note_limit as usize || total>note_limit as usize;
            nodes.truncate(note_limit as usize);
            let ids:HashSet<String>=nodes.iter().map(|n|n.id.clone()).collect();
            let mut edges=Vec::new();let mut unresolved=HashMap::<String,(String,HashSet<String>)>::new();
            if !nodes.is_empty() {
                let mut stmt=conn.prepare("SELECT source_note_id,target_note_id,target_key,target_title FROM links WHERE source_note_id=?1 ORDER BY target_key LIMIT ?2")?;
                let mut scanned=0_i64;let mut candidates=0_i64;let mut seen=HashSet::new();
                for node in &nodes {
                    let links=stmt.query_map(params![node.id,LINK_SCAN_LIMIT+1],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?;
                    for link in links {
                        let (source,target,key,title)=link?;
                        scanned+=1;if scanned>LINK_SCAN_LIMIT {truncated=true;break;}
                        if target.as_ref().is_some_and(|id|ids.contains(id.as_str())) || (target.is_none() && q.include_unresolved==Some(true)) {
                            candidates+=1;if candidates>EDGE_LIMIT {truncated=true;break;}
                            match target {
                                Some(target) if source!=target => {if seen.insert((source.clone(),target.clone())) {edges.push(GraphEdge{source,target});}},
                                None => {if unresolved.len()>=UNRESOLVED_LIMIT && !unresolved.contains_key(&key) {truncated=true;continue;}unresolved.entry(key).or_insert_with(||(title,HashSet::new())).1.insert(source);},
                                Some(_) => {},
                            }
                        }
                    }
                    if scanned>LINK_SCAN_LIMIT || candidates>EDGE_LIMIT {break;}
                }
            }
            let mut tag_stmt=conn.prepare("SELECT t.name,t.color FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id=?1 ORDER BY t.name COLLATE NOCASE")?;
            for node in &mut nodes {
                node.tags=tag_stmt.query_map([&node.id],|r|Ok(GraphTag{name:r.get(0)?,color:r.get(1)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
            }
            let unresolved_count=unresolved.len();
            for (key,(title,sources)) in unresolved {
                let id=format!("unresolved:{key}");
                for source in &sources {edges.push(GraphEdge{source:source.clone(),target:id.clone()});}
                nodes.push(GraphNode{id,title,kind:"unresolved",degree:sources.len() as u64,in_degree:sources.len() as u64,out_degree:0,folder_id:None,folder_name:None,folder_color:None,tags:Vec::new()});
            }
            let total_edges=edges.len();
            Ok(GraphResponse{nodes,edges,meta:GraphMeta{mode:mode.to_owned(),center_id:if mode=="local" {q.center.as_ref().map(ToString::to_string)}else{None},depth,total_nodes:total+unresolved_count,total_edges,truncated,limit}})
        })
    }
}
