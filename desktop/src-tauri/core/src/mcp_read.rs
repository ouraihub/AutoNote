//! Worker-compatible MCP read/preview results. SQL and object reads stay in core.
use serde_json::{Value, json};

use crate::{AppError, Error, Library, NoteId, VersionId};

#[path = "mcp_read/library.rs"]
mod library;
#[path = "mcp_read/retrieval.rs"]
mod retrieval;

fn bad(field: &'static str) -> AppError {
    Error::invalid(field, "invalid MCP argument").into()
}
fn string<'a>(args: &'a Value, field: &'static str) -> Result<&'a str, AppError> {
    args.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(field))
}
fn number(
    args: &Value,
    field: &'static str,
    default: u64,
    min: u64,
    max: u64,
) -> Result<u64, AppError> {
    let value = match args.get(field) {
        None => default,
        Some(v) => v.as_u64().ok_or_else(|| bad(field))?,
    };
    if !(min..=max).contains(&value) {
        return Err(bad(field));
    }
    Ok(value)
}
fn note_id(args: &Value) -> Result<NoteId, AppError> {
    Ok(NoteId::new(string(args, "note_id")?.to_owned())?)
}
fn url(id: impl std::fmt::Display) -> String {
    format!("http://localhost/n/{id}")
}
pub(super) fn iso(millis: i64) -> Result<String, Error> {
    let date = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .map_err(|_| Error::Sqlite(rusqlite::Error::InvalidQuery))?;
    date.format(time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    ))
    .map_err(|_| Error::Sqlite(rusqlite::Error::InvalidQuery))
}
fn owned(lib: &Library, id: &NoteId) -> Result<(), AppError> {
    let exists = lib.read(|conn| {
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1)",
            [id.as_str()],
            |r| r.get::<_, bool>(0),
        )?)
    })?;
    if !exists {
        return Err(Error::NotFound {
            entity: crate::Entity::Note,
            id: id.to_string(),
        }
        .into());
    }
    Ok(())
}

impl Library {
    /// Executes the frozen read/preview tools and returns their actual Worker
    /// `structuredContent` (custom tools wrap their helper result in `data`).
    /// The transport validates the exported schema before entering this method.
    /// # Errors
    /// Invalid cursors/modes/properties, missing resources and storage failures.
    pub fn execute_mcp_read(&self, tool: &str, args: &Value) -> Result<Value, AppError> {
        if !args.is_object() {
            return Err(bad("arguments"));
        }
        let result = match tool {
            "search" | "search_notes" => retrieval::search(self, tool, args)?,
            "fetch" => retrieval::fetch(self, args)?,
            "read_note" => retrieval::read_note(self, args)?,
            "list_notes" => retrieval::list_notes(self, args)?,
            "get_note_context" => retrieval::context(self, args)?,
            "list_folders" => library::folders(self)?,
            "list_tags" => library::tags(self, args)?,
            "list_note_versions" => {
                let id = note_id(args)?;
                owned(self, &id)?;
                let limit = number(args, "limit", 20, 1, 50)? as usize;
                let mut versions = Vec::new();
                for v in self.list_versions(&id)?.into_iter().take(limit) {
                    versions.push(json!({"id":v.id,"note_id":id,"title":v.title,"size":v.size,"created_at":iso(v.created_at.get())?}));
                }
                json!({"versions":versions})
            }
            "read_note_version" => {
                let id = note_id(args)?;
                owned(self, &id)?;
                let v = self.get_version(
                    &id,
                    &VersionId::new(string(args, "version_id")?.to_owned())?,
                )?;
                if v.content.len() > 2 * 1024 * 1024 {
                    return Err(Error::TooLarge {
                        field: "content",
                        limit: 2 * 1024 * 1024,
                    }
                    .into());
                }
                json!({"id":v.meta.id,"note_id":id,"title":v.meta.title,"content":v.content,"size":v.meta.size,"created_at":iso(v.meta.created_at.get())?})
            }
            "preview_tag_change" => library::preview_tag(self, args)?,
            "preview_folder_removal" => library::preview_folder(self, args)?,
            "list_attachments" => library::attachments(self, args)?,
            "read_attachment" => library::attachment(self, args)?,
            "get_note_properties" => library::properties(self, args)?,
            "query_note_properties" => library::query_properties(self, args)?,
            "explore_note_graph" => library::graph(self, args)?,
            _ => return Err(bad("tool")),
        };
        Ok(if matches!(tool, "search" | "fetch") {
            result
        } else {
            json!({"data":result})
        })
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "failed assertions fail the behavioral contract"
)]
mod tests {
    use super::*;
    use crate::{ErrorCode, Note, WriteOrigin};
    fn library() -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(&dir.path().join("library.db")).unwrap();
        (dir, lib)
    }
    fn note(lib: &Library, title: &str, content: &str) -> Note {
        lib.create_note(
            &crate::NewNote {
                id: None,
                title: Some(title.into()),
                content: content.into(),
                folder_id: None,
                is_starred: false,
            },
            WriteOrigin::Ui,
        )
        .unwrap()
        .value
    }
    #[test]
    fn readonly_contract_executes_domain_data_and_worker_envelopes() {
        let (_dir, lib) = library();
        let target = note(
            &lib,
            "Target",
            "---\ncount: 2\nlabels: [red, blue]\n---\n# Intro\nhello 😀 #demo",
        );
        let source = note(&lib, "Source", "[[Target]]");
        let id = target.summary.id;
        let search = lib
            .execute_mcp_read("search", &json!({"query":"hello"}))
            .unwrap();
        assert_eq!(search["mode"], "lexical");
        assert_eq!(search["results"][0]["id"], json!(id));
        assert!(search["data"].is_null());
        let advanced = lib
            .execute_mcp_read("search_notes", &json!({"query":"hello","mode":"auto"}))
            .unwrap();
        assert_eq!(advanced["data"]["results"][0]["source"], "lexical");
        let fetched = lib
            .execute_mcp_read("fetch", &json!({"id":format!("note:{id}")}))
            .unwrap();
        assert_eq!(fetched["metadata"]["rev"], 1);
        assert!(
            fetched["metadata"]["created_at"]
                .as_str()
                .unwrap()
                .ends_with("Z")
        );
        let read = lib
            .execute_mcp_read("read_note", &json!({"note_id":id,"section":"intro"}))
            .unwrap();
        assert_eq!(read["data"]["section"]["slug"], "intro");
        assert!(read["data"]["content"].as_str().unwrap().contains('😀'));
        let context = lib
            .execute_mcp_read("get_note_context", &json!({"note_id":id}))
            .unwrap();
        assert_eq!(
            context["data"]["backlinks"][0]["id"],
            json!(source.summary.id)
        );
        let graph = lib
            .execute_mcp_read("explore_note_graph", &json!({"note_id":id}))
            .unwrap();
        assert_eq!(graph["data"]["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(graph["data"]["edges"].as_array().unwrap().len(), 1);
        let properties = lib
            .execute_mcp_read("get_note_properties", &json!({"note_id":id}))
            .unwrap();
        assert_eq!(properties["data"]["properties"]["count"], 2);
        let matches = lib
            .execute_mcp_read(
                "query_note_properties",
                &json!({"conditions":[{"key":"labels","operator":"contains","value":"red"}]}),
            )
            .unwrap();
        assert_eq!(matches["data"]["results"][0]["id"], json!(id));
        let tags = lib.execute_mcp_read("list_tags", &json!({})).unwrap();
        assert_eq!(tags["data"]["tags"][0]["name"], "demo");
        let preview = lib
            .execute_mcp_read(
                "preview_tag_change",
                &json!({"tag_id":tags["data"]["tags"][0]["id"]}),
            )
            .unwrap();
        assert_eq!(preview["data"]["affected_notes"], 1);
        for tool in ["list_folders", "list_attachments"] {
            assert!(lib.execute_mcp_read(tool, &json!({})).unwrap()["data"].is_object());
        }
        assert_eq!(
            lib.execute_mcp_read("list_note_versions", &json!({"note_id":id}))
                .unwrap()["data"]["versions"],
            json!([])
        );
        for mode in ["semantic", "hybrid"] {
            let error = lib
                .execute_mcp_read("search", &json!({"query":"hello","mode":mode}))
                .unwrap_err();
            assert_eq!(error.code(), ErrorCode::Forbidden);
            assert_eq!(
                serde_json::to_value(error).unwrap()["details"]["reason"],
                "semantic_search_unavailable"
            );
        }
        assert_eq!(
            lib.execute_mcp_read("search", &json!({"query":"hello","mode":"unknown"}))
                .unwrap_err()
                .code(),
            ErrorCode::BadRequest
        );
        assert_eq!(
            lib.execute_mcp_read("list_notes", &json!({"cursor":"k1.bad.invalid"}))
                .unwrap_err()
                .code(),
            ErrorCode::BadRequest
        );
        let nested = json!({"conditions":[{"key":"x","operator":"equals","value":[[[[[1]]]]]}]});
        assert_eq!(
            lib.execute_mcp_read("query_note_properties", &nested)
                .unwrap_err()
                .code(),
            ErrorCode::BadRequest
        );
    }
    #[test]
    fn unicode_continuations_are_lossless_and_lists_use_worker_keyset() {
        let (_dir, lib) = library();
        let original = format!("{}😀tail", "x".repeat(999));
        let first = note(&lib, "First", &original);
        note(&lib, "Second", "second");
        let mut cursor = String::new();
        let mut joined = String::new();
        let mut finished = false;
        for _ in 0..original.encode_utf16().count() {
            let result = lib
                .execute_mcp_read(
                    "read_note",
                    &json!({"note_id":first.summary.id,"cursor":cursor,"max_chars":1000}),
                )
                .unwrap();
            let content = result["data"]["content"].as_str().unwrap();
            joined.push_str(content);
            let Some(next) = result["data"]["next_cursor"].as_str() else {
                finished = true;
                break;
            };
            let before = if cursor.is_empty() {
                0
            } else {
                cursor.parse::<usize>().unwrap()
            };
            let after = next.parse::<usize>().unwrap();
            assert!(
                after > before,
                "continuation cursor must advance: {before} -> {after}"
            );
            assert_eq!(after - before, content.encode_utf16().count());
            cursor = next.into();
        }
        assert!(
            finished,
            "continuation must finish within the source length"
        );
        assert_eq!(joined, original);
        for invalid in ["-1", "abc", "1000", "1006"] {
            assert_eq!(
                lib.execute_mcp_read(
                    "read_note",
                    &json!({"note_id":first.summary.id,"cursor":invalid})
                )
                .unwrap_err()
                .code(),
                ErrorCode::BadRequest
            );
        }
        let end = lib.execute_mcp_read("read_note", &json!({"note_id":first.summary.id,"cursor":original.encode_utf16().count().to_string()})).unwrap();
        assert_eq!(end["data"]["content"], "");
        assert!(end["data"]["next_cursor"].is_null());
        let first = lib
            .execute_mcp_read("list_notes", &json!({"limit":1}))
            .unwrap();
        let cursor = first["data"]["next_cursor"].as_str().unwrap();
        assert!(cursor.starts_with("k1."));
        let next = lib
            .execute_mcp_read("list_notes", &json!({"limit":1,"cursor":cursor}))
            .unwrap();
        assert_ne!(
            first["data"]["notes"][0]["id"],
            next["data"]["notes"][0]["id"]
        );
    }
}
