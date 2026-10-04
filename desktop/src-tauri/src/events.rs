//! `TauriChangeSink`: post-commit notifications to every window.
//!
//! `library_changed` runs after commit and lock release (core `Library::write`),
//! so it may read the library again. The payload is the local `SyncResponse`
//! for changes after the last emitted cursor, not the in-memory `ChangeSet`:
//! folders/tags/settings flags and the cursor come from one consistent read.
//! An emit failure is logged and never undoes the commit; windows catch up
//! through `library_changes({since})`.

use std::sync::{Mutex, OnceLock};

use note_core::{AppError, ChangeSet, ChangeSink, Cursor, WriteEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppContext;

pub const LIBRARY_CHANGED: &str = "autonote://library-changed";
pub const WRITE: &str = "autonote://write";

#[derive(Default)]
pub struct TauriChangeSink {
    app: OnceLock<AppHandle>,
    /// Last cursor sent; the lock also serializes emits so cursors arrive in order.
    sent: Mutex<Option<Cursor>>,
}

impl TauriChangeSink {
    /// Bound once the app exists; writes before that have no window to notify.
    /// Starts from the current cursor so the first event is incremental.
    pub fn bind(&self, app: AppHandle) {
        if let (Ok(mut sent), Ok(cursor)) = (
            self.sent.lock(),
            app.state::<AppContext>().library.library_cursor(),
        ) {
            *sent = Some(cursor);
        }
        let _ = self.app.set(app);
    }
}

impl ChangeSink for TauriChangeSink {
    fn library_changed(&self, _: ChangeSet) {
        let Some(app) = self.app.get() else { return };
        let Ok(mut sent) = self.sent.lock() else {
            return;
        };
        let library = &app.state::<AppContext>().library;
        let payload = match *sent {
            Some(since) => library.library_changes(since),
            None => library.notes_snapshot(),
        };
        let result = payload.map_err(AppError::from).and_then(|payload| {
            let cursor = payload.cursor;
            app.emit(LIBRARY_CHANGED, &payload)
                .map_err(|_| AppError::new(note_core::ErrorCode::Internal, "emit failed"))?;
            *sent = Some(cursor);
            Ok(())
        });
        if let Err(error) = result {
            tracing::warn!(code = error.code().as_str(), "ipc.event.failed");
        }
    }

    fn write_event(&self, event: WriteEvent) {
        if let Some(app) = self.app.get()
            && app.emit(WRITE, &event).is_err()
        {
            tracing::warn!("ipc.event.failed");
        }
    }
}
