//! `NotesPort` commands; envelopes follow the Web worker `routes/notes.ts`.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use note_core::{
    AppError, Backlink, CreateNoteBody, Error, FlushResult, ListNotesQuery, ListNotesResponse,
    NewNote, Note, NoteId, NotePatch, NoteVersion, NoteVersionMeta, NoteWriteResult, PatchNoteBody,
    Rev, SyncResponse, VersionId, WriteOrigin, parse_input,
};

use super::{Ok, ok, run};
use crate::AppContext;

type Ctx<'a> = tauri::State<'a, AppContext>;

#[tauri::command]
pub async fn notes_snapshot(context: Ctx<'_>) -> Result<SyncResponse, AppError> {
    run("notes_snapshot", &context, |lib| lib.notes_snapshot()).await
}

#[tauri::command]
pub async fn notes_list(context: Ctx<'_>, query: Value) -> Result<ListNotesResponse, AppError> {
    run("notes_list", &context, move |lib| {
        lib.list_notes(&parse_input::<ListNotesQuery>(query)?)
    })
    .await
}

#[tauri::command]
pub async fn notes_get(context: Ctx<'_>, id: String) -> Result<Note, AppError> {
    run("notes_get", &context, move |lib| lib.get_note(&id.parse()?)).await
}

#[tauri::command]
pub async fn notes_create(context: Ctx<'_>, body: Value) -> Result<Note, AppError> {
    run("notes_create", &context, move |lib| {
        let input = NewNote::from(parse_input::<CreateNoteBody>(body)?);
        Ok(lib.create_note(&input, WriteOrigin::Ui)?.value)
    })
    .await
}

#[tauri::command]
pub async fn notes_patch(
    context: Ctx<'_>,
    id: String,
    body: Value,
    write_id: String,
) -> Result<NoteWriteResult, AppError> {
    run("notes_patch", &context, move |lib| {
        let patch = NotePatch::from(parse_input::<PatchNoteBody>(body)?);
        let note = lib
            .patch_note_with_write_id(&id.parse()?, &patch, &write_id, WriteOrigin::Ui)?
            .value;
        Ok(NoteWriteResult { write_id, note })
    })
    .await
}

#[tauri::command]
pub async fn notes_remove(context: Ctx<'_>, id: String) -> Result<Note, AppError> {
    run("notes_remove", &context, move |lib| {
        Ok(lib.trash_note(&id.parse()?, WriteOrigin::Ui)?.value)
    })
    .await
}

#[tauri::command]
pub async fn notes_restore(context: Ctx<'_>, id: String) -> Result<Note, AppError> {
    run("notes_restore", &context, move |lib| {
        Ok(lib.restore_note(&id.parse()?, WriteOrigin::Ui)?.value)
    })
    .await
}

#[derive(Serialize)]
pub struct CursorBody {
    cursor: note_core::Cursor,
}

#[tauri::command]
pub async fn notes_purge(context: Ctx<'_>, id: String) -> Result<Ok<CursorBody>, AppError> {
    run("notes_purge", &context, move |lib| {
        let cursor = lib.purge_note(&id.parse()?, WriteOrigin::Ui)?.value;
        Ok(ok(CursorBody { cursor }))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DuplicateBody {
    #[serde(default)]
    id: Option<NoteId>,
}

#[tauri::command]
pub async fn notes_duplicate(
    context: Ctx<'_>,
    id: String,
    body: Option<Value>,
) -> Result<Note, AppError> {
    run("notes_duplicate", &context, move |lib| {
        let copy = match body {
            Some(body) => parse_input::<DuplicateBody>(body)?.id,
            None => None,
        };
        Ok(lib
            .duplicate_note(&id.parse()?, copy.as_ref(), WriteOrigin::Ui)?
            .value)
    })
    .await
}

#[derive(Serialize)]
pub struct Purged {
    purged: u64,
}

#[tauri::command]
pub async fn notes_empty_trash(context: Ctx<'_>) -> Result<Purged, AppError> {
    run("notes_empty_trash", &context, |lib| {
        Ok(Purged {
            purged: lib.empty_trash(WriteOrigin::Ui)?.value,
        })
    })
    .await
}

#[tauri::command]
pub async fn notes_versions(
    context: Ctx<'_>,
    id: String,
) -> Result<Vec<NoteVersionMeta>, AppError> {
    run("notes_versions", &context, move |lib| {
        lib.list_versions(&id.parse()?)
    })
    .await
}

#[tauri::command]
pub async fn notes_version(
    context: Ctx<'_>,
    id: String,
    version_id: String,
) -> Result<NoteVersion, AppError> {
    run("notes_version", &context, move |lib| {
        lib.get_version(&id.parse()?, &version_id.parse::<VersionId>()?)
    })
    .await
}

/// The adapter reads the current rev first (21 §4); core CAS rejects later edits.
#[tauri::command]
pub async fn notes_restore_version(
    context: Ctx<'_>,
    id: String,
    version_id: String,
    rev: Value,
) -> Result<Note, AppError> {
    run("notes_restore_version", &context, move |lib| {
        let rev = Rev::new(
            rev.as_i64()
                .ok_or(Error::invalid("rev", "must be an integer"))?,
        )?;
        let version = version_id.parse::<VersionId>()?;
        Ok(lib
            .restore_version(&id.parse()?, &version, rev, WriteOrigin::Ui)?
            .value)
    })
    .await
}

#[tauri::command]
pub async fn notes_backlinks(context: Ctx<'_>, id: String) -> Result<Vec<Backlink>, AppError> {
    run("notes_backlinks", &context, move |lib| {
        lib.backlinks(&id.parse()?)
    })
    .await
}

/// Every desktop write commits before its command resolves, so nothing is
/// ever pending; the id is still validated like any other input.
#[tauri::command]
pub async fn notes_flush(
    context: Ctx<'_>,
    note_id: Option<String>,
) -> Result<FlushResult, AppError> {
    run("notes_flush", &context, move |library| {
        if let Some(id) = note_id {
            id.parse::<NoteId>()?;
        }
        library.library_cursor()?;
        Ok(FlushResult {
            pending: 0,
            failed: 0,
        })
    })
    .await
}
