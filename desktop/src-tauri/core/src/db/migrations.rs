//! Append-only library schema migrations. A released SQL entry must never change.

pub(super) struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

pub(super) const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: "CREATE TABLE app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );",
    },
    Migration {
        version: 2,
        sql: r#"
CREATE TABLE folders (
  id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
  icon TEXT, color TEXT, position REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX idx_folders_parent ON folders(parent_id, position);
CREATE UNIQUE INDEX idx_folders_unique_sibling
  ON folders(IFNULL(parent_id, ''), lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE notes (
  id TEXT PRIMARY KEY, folder_id TEXT,
  title TEXT NOT NULL DEFAULT '', title_key TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 1,
  word_count INTEGER NOT NULL DEFAULT 0, char_count INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0, is_starred INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX idx_notes_updated ON notes(deleted_at, is_archived, updated_at DESC);
CREATE INDEX idx_notes_folder ON notes(folder_id, updated_at DESC);
CREATE INDEX idx_notes_starred ON notes(is_starred, updated_at DESC);
CREATE INDEX idx_notes_trash ON notes(deleted_at);
CREATE INDEX idx_notes_title_key ON notes(title_key, deleted_at, created_at, id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT,
  is_manual INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_tags_unique ON tags(name);
CREATE INDEX idx_tags_name_nocase ON tags(name COLLATE NOCASE);

CREATE TABLE note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (note_id, tag_id));
CREATE INDEX idx_note_tags_tag ON note_tags(tag_id);

CREATE TABLE links (
  source_note_id TEXT NOT NULL, target_key TEXT NOT NULL,
  target_title TEXT NOT NULL, target_note_id TEXT,
  PRIMARY KEY (source_note_id, target_key)
);
CREATE INDEX idx_links_target ON links(target_key);
CREATE INDEX idx_links_target_note ON links(target_note_id);

CREATE TABLE note_versions (
  id TEXT PRIMARY KEY, note_id TEXT NOT NULL, title TEXT NOT NULL,
  content TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_versions_note ON note_versions(note_id, created_at DESC, id DESC);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY, note_id TEXT, filename TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, width INTEGER, height INTEGER,
  storage TEXT NOT NULL DEFAULT 'local' CHECK (storage IN ('local')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_attachments_created ON attachments(created_at DESC);
CREATE INDEX idx_attachments_sha ON attachments(sha256);
CREATE INDEX idx_attachments_note ON attachments(note_id);

CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('note','folder','tag','settings')),
  entity_id TEXT NOT NULL, op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  note_id UNINDEXED, title, body, tokenize = "unicode61 remove_diacritics 2"
);

CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
"#,
    },
    Migration {
        version: 3,
        sql: include_str!("../sync/schema.sql"),
    },
    Migration {
        version: 4,
        sql: r#"
CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_used_at INTEGER, revoked_at INTEGER
);
CREATE TABLE mcp_preferences (
  id INTEGER PRIMARY KEY CHECK(id=1), write_enabled INTEGER NOT NULL DEFAULT 0,
  trash_enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
INSERT INTO mcp_preferences(id,write_enabled,trash_enabled,updated_at) VALUES(1,0,0,unixepoch('subsec') * 1000);
CREATE TABLE mcp_operations (
  operation_id TEXT PRIMARY KEY, tool TEXT NOT NULL,
  request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed','expired')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mcp_operations_created ON mcp_operations(created_at);
"#,
    },
    Migration {
        version: 5,
        sql: r#"
CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE ai_endpoints (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, base_url TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('anthropic-messages','openai-chat','openai-responses')),
  key_ciphertext BLOB, position INTEGER NOT NULL,
  UNIQUE (provider_id, slug)
);
CREATE TABLE ai_models (
  endpoint_id TEXT NOT NULL REFERENCES ai_endpoints(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, model_type TEXT NOT NULL, type_source TEXT NOT NULL,
  context_window INTEGER, can_vision INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL,
  PRIMARY KEY (endpoint_id, model_id)
);
CREATE TABLE ai_roles (
  role TEXT PRIMARY KEY CHECK (role IN ('chat','writing')),
  endpoint_id TEXT NOT NULL, model_id TEXT NOT NULL,
  FOREIGN KEY (endpoint_id, model_id) REFERENCES ai_models(endpoint_id, model_id) ON DELETE CASCADE
);
"#,
    },
    Migration {
        version: 6,
        sql: r"
CREATE TABLE ai_conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE ai_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN('user','assistant')), content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('done','failed','interrupted')), model_id TEXT, created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, seq));
CREATE INDEX idx_ai_conversations_updated ON ai_conversations(updated_at DESC);
",
    },
    Migration {
        version: 7,
        sql: include_str!("../sync/migrate_v7.sql"),
    },
];
