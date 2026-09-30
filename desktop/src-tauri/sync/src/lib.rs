//! Sync with an AutoNote Web / AutoNote instance.
//!
//! Speaks the existing `/api/sync`, `/api/notes` and `/api/sync/ws` protocol as
//! a cookie-session client; the server needs no changes. All local reads and
//! writes go through `note-core`. Implemented in milestone D5.
