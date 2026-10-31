export const AI_TURN_IMAGES = [
  `CREATE TABLE IF NOT EXISTS ai_turn_images (
    user_id TEXT NOT NULL, turn_id TEXT NOT NULL, idx INTEGER NOT NULL,
    mime TEXT NOT NULL, object_key TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, turn_id, idx)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_turn_images_object ON ai_turn_images(object_key, created_at)`,
]

export const RELAY_TABLES = [
  `CREATE TABLE IF NOT EXISTS relay_access_keys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, revoked_at INTEGER,
    day TEXT, day_requests INTEGER NOT NULL DEFAULT 0, github_run TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_relay_access_keys_user ON relay_access_keys(user_id, revoked_at)`,
  `CREATE INDEX IF NOT EXISTS idx_relay_access_keys_expires ON relay_access_keys(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_relay_access_keys_run ON relay_access_keys(github_run)`,
  `CREATE TABLE IF NOT EXISTS relay_github_repos (
    repo TEXT PRIMARY KEY, user_id TEXT NOT NULL, workflow TEXT NOT NULL, ref TEXT NOT NULL,
    created_at INTEGER NOT NULL, repository_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_relay_github_repos_user ON relay_github_repos(user_id, repo)`,
]

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    login TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'member',
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, parent_id, position)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_sibling
     ON folders(user_id, IFNULL(parent_id, ''), lower(name)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    folder_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    title_key TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    excerpt TEXT NOT NULL DEFAULT '',
    rev INTEGER NOT NULL DEFAULT 1,
    word_count INTEGER NOT NULL DEFAULT 0,
    char_count INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notes_user_updated
     ON notes(user_id, deleted_at, is_archived, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(user_id, folder_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_starred ON notes(user_id, is_starred, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_trash ON notes(user_id, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_title_key
     ON notes(user_id, title_key, deleted_at, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id, id)`,

  `CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    is_manual INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_unique ON tags(user_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_tags_name_nocase ON tags(user_id, name COLLATE NOCASE)`,

  `CREATE TABLE IF NOT EXISTS note_tags (
    note_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (note_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id)`,

  `CREATE TABLE IF NOT EXISTS links (
    source_note_id TEXT NOT NULL,
    target_key TEXT NOT NULL,
    target_title TEXT NOT NULL,
    target_note_id TEXT,
    user_id TEXT NOT NULL,
    PRIMARY KEY (source_note_id, target_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_links_target ON links(user_id, target_key)`,
  `CREATE INDEX IF NOT EXISTS idx_links_target_note ON links(target_note_id)`,

  `CREATE TABLE IF NOT EXISTS note_versions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_versions_note ON note_versions(note_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_user ON note_versions(user_id)`,

  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    note_id TEXT,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    storage TEXT NOT NULL CHECK (storage IN ('r2', 'kv')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_user_sha ON attachments(user_id, sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id)`,

  `CREATE TABLE IF NOT EXISTS attachment_cleanup (
    object_key TEXT PRIMARY KEY CHECK (object_key GLOB 'r2:?*' OR object_key GLOB 'kv:?*'),
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_created
     ON attachment_cleanup(created_at, object_key)`,
  `CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_user
     ON attachment_cleanup(user_id, created_at, object_key)`,

  `CREATE TABLE IF NOT EXISTS import_mappings (
    user_id TEXT NOT NULL,
    entity TEXT NOT NULL CHECK (entity IN ('note', 'attachment')),
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, entity, source_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_import_mappings_target
     ON import_mappings(user_id, entity, target_id)`,

  `CREATE TABLE IF NOT EXISTS backup_targets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    secret TEXT,
    last_run_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_targets_user ON backup_targets(user_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    note_count INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_user ON backup_runs(user_id, started_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS shares (
    slug TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    password_hash TEXT,
    expires_at INTEGER,
    views INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_note ON shares(note_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shares_user_created ON shares(user_id, created_at DESC, slug DESC)`,

  `CREATE TABLE IF NOT EXISTS share_asset_sessions (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_share_asset_sessions_slug
     ON share_asset_sessions(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_share_asset_sessions_expires
     ON share_asset_sessions(expires_at)`,

  `CREATE TABLE IF NOT EXISTS changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    op TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_changes_user ON changes(user_id, seq)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,

  `CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    fails INTEGER NOT NULL DEFAULT 0,
    last_fail_at INTEGER NOT NULL,
    locked_until INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_attempts_last_fail ON login_attempts(last_fail_at)`,

  `CREATE TABLE IF NOT EXISTS totp_credentials (
    user_id TEXT PRIMARY KEY,
    secret_ciphertext TEXT NOT NULL,
    enabled_at INTEGER,
    pending_token_hash TEXT,
    pending_session_id TEXT,
    pending_expires_at INTEGER,
    recovery_generation TEXT NOT NULL DEFAULT '',
    last_used_step INTEGER,
    last_used_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS totp_recovery_codes (
    user_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    generation TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT,
    PRIMARY KEY (user_id, code_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_totp_recovery_codes_user
     ON totp_recovery_codes(user_id, generation, used_at)`,

  `CREATE TABLE IF NOT EXISTS totp_login_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_by TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_totp_challenges_user
     ON totp_login_challenges(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_totp_challenges_expires
     ON totp_login_challenges(expires_at)`,

  `CREATE TABLE IF NOT EXISTS mcp_preferences (
    user_id TEXT PRIMARY KEY,
    write_enabled INTEGER NOT NULL DEFAULT 1 CHECK (write_enabled IN (0, 1)),
    trash_enabled INTEGER NOT NULL DEFAULT 0 CHECK (trash_enabled IN (0, 1)),
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS mcp_operations (
    user_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_operations_created
     ON mcp_operations(created_at)`,

  `CREATE TABLE IF NOT EXISTS mcp_api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL DEFAULT 'notes:read',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_user
     ON mcp_api_keys(user_id, revoked_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_revoked
     ON mcp_api_keys(revoked_at)`,

  `CREATE TABLE IF NOT EXISTS ai_note_embeddings (
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB NOT NULL,
    indexed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, note_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_embeddings_indexed
     ON ai_note_embeddings(user_id, indexed_at)`,

  `CREATE TABLE IF NOT EXISTS ai_index_queue (
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('embed', 'delete')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, note_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_index_queue_due
     ON ai_index_queue(user_id, created_at, note_id)`,

  `CREATE TABLE IF NOT EXISTS fts_index_queue (
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, note_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fts_index_queue_due
     ON fts_index_queue(user_id, created_at, note_id)`,
  `CREATE TABLE IF NOT EXISTS ai_providers (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, notes TEXT NOT NULL DEFAULT '', preset_id TEXT,
    position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_providers_user ON ai_providers(user_id, position, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_providers_preset ON ai_providers(user_id, preset_id) WHERE preset_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ai_endpoints (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    slug TEXT NOT NULL, base_url TEXT NOT NULL, protocol TEXT NOT NULL,
    position INTEGER NOT NULL, image_base_url TEXT, headers TEXT NOT NULL DEFAULT '{}', image_edit_base_url TEXT,
    UNIQUE(user_id, provider_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_endpoints_user ON ai_endpoints(user_id, provider_id, position, id)`,
  `CREATE TABLE IF NOT EXISTS ai_endpoint_keys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
    key_ciphertext TEXT NOT NULL, position INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_endpoint_keys ON ai_endpoint_keys(user_id, endpoint_id, position, id)`,
  ...RELAY_TABLES,
  `CREATE TABLE IF NOT EXISTS ai_models (
    user_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, model_id TEXT NOT NULL,
    model_type TEXT NOT NULL, type_source TEXT NOT NULL, context_window INTEGER,
    can_vision INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL,
    native_web_search INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id, endpoint_id, model_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_roles (
    user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chat','writing','painting')),
    endpoint_id TEXT, model_id TEXT, PRIMARY KEY(user_id, role)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_chat_conversations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, scope TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_chat_conversations_user ON ai_chat_conversations(user_id, scope, updated_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS ai_chat_turns (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
    input TEXT NOT NULL, messages TEXT NOT NULL DEFAULT '[]', model_id TEXT, error_code TEXT,
    input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER NOT NULL,
    UNIQUE(conversation_id, seq)
  )`,
  ...AI_TURN_IMAGES,
  `CREATE TABLE IF NOT EXISTS ai_search_provider_configs (
    user_id TEXT NOT NULL, capability TEXT NOT NULL CHECK (capability IN ('search', 'fetch')),
    provider TEXT NOT NULL, base_url TEXT, basic_username TEXT, PRIMARY KEY(user_id, capability, provider)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_search_defaults (
    user_id TEXT NOT NULL, capability TEXT NOT NULL CHECK (capability IN ('search', 'fetch')),
    provider TEXT NOT NULL, PRIMARY KEY(user_id, capability)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_search_keys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, capability TEXT NOT NULL CHECK (capability IN ('search', 'fetch')),
    provider TEXT NOT NULL, key_ciphertext TEXT NOT NULL, position INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_search_keys_scope ON ai_search_keys(user_id, capability, provider, position, id)`,
  `CREATE TABLE IF NOT EXISTS ai_search_preferences (
    user_id TEXT PRIMARY KEY, preferences TEXT NOT NULL
  )`,
]
