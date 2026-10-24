/** Defines the idempotent final D1 schema initialized by every Worker isolate. */
import type { DatabaseState, Env } from '../env'
import { getMeta, setMeta } from './metadata'

const AI_TURN_IMAGES = [
  `CREATE TABLE IF NOT EXISTS ai_turn_images (
    user_id TEXT NOT NULL, turn_id TEXT NOT NULL, idx INTEGER NOT NULL,
    mime TEXT NOT NULL, object_key TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, turn_id, idx)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_turn_images_object ON ai_turn_images(object_key, created_at)`,
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

interface SchemaMigration {
  version: number
  statements: readonly string[]
  skipIfColumnExists?: { table: string; column: string }
}

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at INTEGER NOT NULL
       )`,
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
    ],
  },
  {
    version: 2,
    statements: [
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
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS fts_index_queue (
        user_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, note_id)
      )`,
    ],
  },
  {
    version: 4,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_fts_index_queue_due
         ON fts_index_queue(user_id, created_at, note_id)`,
    ],
  },
  {
    version: 5,
    skipIfColumnExists: { table: 'folders', column: 'color' },
    statements: [
      `ALTER TABLE folders ADD COLUMN color TEXT`,
    ],
  },
  {
    version: 6,
    skipIfColumnExists: { table: 'tags', column: 'is_manual' },
    statements: [
      `ALTER TABLE tags ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 7,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_attachments_user_sha ON attachments(user_id, sha256)`,
    ],
  },
  {
    version: 8,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_ai_index_queue_due
         ON ai_index_queue(user_id, created_at, note_id)`,
    ],
  },
  {
    version: 9,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_user
         ON attachment_cleanup(user_id, created_at, object_key)`,
    ],
  },
  {
    version: 10,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_revoked
         ON mcp_api_keys(revoked_at)`,
    ],
  },
  {
    version: 11,
    statements: [
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
    ],
  },
  {
    version: 12,
    statements: [
      `DROP INDEX IF EXISTS idx_versions_note`,
      `CREATE INDEX idx_versions_note ON note_versions(note_id, created_at DESC, id DESC)`,
      `DROP INDEX IF EXISTS idx_runs_user`,
      `CREATE INDEX idx_runs_user ON backup_runs(user_id, started_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id, id)`,
      `CREATE INDEX IF NOT EXISTS idx_tags_name_nocase ON tags(user_id, name COLLATE NOCASE)`,
      `CREATE INDEX IF NOT EXISTS idx_versions_user ON note_versions(user_id)`,
    ],
  },
  {
    version: 13,
    skipIfColumnExists: { table: 'ai_models', column: 'max_output' },
    statements: [
      `ALTER TABLE ai_models ADD COLUMN max_output INTEGER`,
      `ALTER TABLE ai_models ADD COLUMN supports_tools INTEGER`,
    ],
  },
  {
    version: 14,
    statements: [
      `DROP INDEX IF EXISTS idx_ai_messages_conversation`,
      `DROP INDEX IF EXISTS idx_ai_conversations_user`,
      `DROP TABLE IF EXISTS ai_messages`,
      `DROP TABLE IF EXISTS ai_conversations`,
    ],
  },
  {
    version: 16,
    statements: [
      `ALTER TABLE ai_models ADD COLUMN reasoning TEXT`,
      `ALTER TABLE ai_chat_turns ADD COLUMN cache_read_tokens INTEGER`,
      `ALTER TABLE ai_chat_turns ADD COLUMN cache_write_tokens INTEGER`,
      `ALTER TABLE ai_chat_turns ADD COLUMN reasoning_tokens INTEGER`,
      `ALTER TABLE ai_chat_turns ADD COLUMN reasoning_effort TEXT`,
      `ALTER TABLE ai_chat_turns ADD COLUMN reasoning_text TEXT`,
      `ALTER TABLE ai_chat_turns ADD COLUMN context_usage TEXT`,
      `ALTER TABLE ai_chat_turns ADD COLUMN endpoint_id TEXT`,
    ],
  },
  {
    version: 17,
    statements: [
      `ALTER TABLE ai_chat_conversations ADD COLUMN selected_turn_id TEXT`,
      `ALTER TABLE ai_chat_conversations ADD COLUMN revision TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE ai_chat_turns ADD COLUMN parent_id TEXT`,
      `ALTER TABLE ai_chat_turns ADD COLUMN question_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE ai_chat_turns ADD COLUMN supersedes_id TEXT`,
      `ALTER TABLE ai_chat_turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'reply' CHECK(kind IN ('reply','translation'))`,
      `UPDATE ai_chat_turns SET question_id = id, parent_id = (
        SELECT previous.id FROM ai_chat_turns previous
        WHERE previous.conversation_id = ai_chat_turns.conversation_id AND previous.user_id = ai_chat_turns.user_id
          AND previous.seq < ai_chat_turns.seq ORDER BY previous.seq DESC LIMIT 1
      )`,
      `UPDATE ai_chat_conversations SET selected_turn_id = (
        SELECT id FROM ai_chat_turns WHERE conversation_id = ai_chat_conversations.id
          AND user_id = ai_chat_conversations.user_id AND status = 'completed' ORDER BY seq DESC LIMIT 1
      )`,
    ],
  },
  {
    version: 18,
    skipIfColumnExists: { table: 'ai_models', column: 'native_web_search' },
    statements: [
      `ALTER TABLE ai_models ADD COLUMN native_web_search INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 19,
    statements: AI_TURN_IMAGES,
  },
  {
    version: 20,
    statements: [
      `CREATE TABLE ai_roles_v20 (
        user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chat','writing','painting')),
        endpoint_id TEXT, model_id TEXT, PRIMARY KEY(user_id, role)
      )`,
      `INSERT INTO ai_roles_v20 (user_id, role, endpoint_id, model_id) SELECT user_id, role, endpoint_id, model_id FROM ai_roles`,
      `DROP TABLE ai_roles`,
      `ALTER TABLE ai_roles_v20 RENAME TO ai_roles`,
    ],
  },
  {
    version: 21,
    skipIfColumnExists: { table: 'ai_turn_images', column: 'kind' },
    statements: [
      `ALTER TABLE ai_turn_images ADD COLUMN kind TEXT NOT NULL DEFAULT 'input' CHECK(kind IN ('input','generated'))`,
    ],
  },
  {
    version: 22,
    skipIfColumnExists: { table: 'ai_providers', column: 'enabled' },
    statements: [`ALTER TABLE ai_providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`],
  },
  {
    // Multi-key endpoints (docs/34 §4): drop the single key column; old keys are not migrated.
    version: 23,
    statements: [
      `CREATE TABLE ai_endpoints_v23 (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider_id TEXT NOT NULL,
        slug TEXT NOT NULL, base_url TEXT NOT NULL, protocol TEXT NOT NULL,
        position INTEGER NOT NULL,
        UNIQUE(user_id, provider_id, slug)
      )`,
      `INSERT INTO ai_endpoints_v23 (id, user_id, provider_id, slug, base_url, protocol, position) SELECT id, user_id, provider_id, slug, base_url, protocol, position FROM ai_endpoints`,
      `DROP TABLE ai_endpoints`,
      `ALTER TABLE ai_endpoints_v23 RENAME TO ai_endpoints`,
      `CREATE INDEX IF NOT EXISTS idx_ai_endpoints_user ON ai_endpoints(user_id, provider_id, position, id)`,
    ],
  },
  {
    version: 24,
    skipIfColumnExists: { table: 'ai_endpoints', column: 'image_base_url' },
    statements: [
      `ALTER TABLE ai_endpoints ADD COLUMN image_base_url TEXT`,
      `ALTER TABLE ai_endpoints ADD COLUMN headers TEXT NOT NULL DEFAULT '{}'`,
    ],
  },
  {
    version: 25,
    skipIfColumnExists: { table: 'ai_endpoints', column: 'image_edit_base_url' },
    statements: [`ALTER TABLE ai_endpoints ADD COLUMN image_edit_base_url TEXT`],
  },
  {
    version: 26,
    skipIfColumnExists: { table: 'ai_providers', column: 'notes' },
    statements: [`ALTER TABLE ai_providers ADD COLUMN notes TEXT NOT NULL DEFAULT ''`],
  },
  {
    version: 27,
    skipIfColumnExists: { table: 'ai_providers', column: 'preset_id' },
    statements: [
      `ALTER TABLE ai_providers ADD COLUMN preset_id TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_providers_preset ON ai_providers(user_id, preset_id) WHERE preset_id IS NOT NULL`,
    ],
  },
  {
    version: 28,
    skipIfColumnExists: { table: 'ai_models', column: 'name' },
    statements: [
      `ALTER TABLE ai_models ADD COLUMN name TEXT`,
      `ALTER TABLE ai_models ADD COLUMN group_name TEXT`,
      `ALTER TABLE ai_models ADD COLUMN pricing TEXT`,
      `ALTER TABLE ai_chat_turns ADD COLUMN cost REAL`,
      `ALTER TABLE ai_chat_turns ADD COLUMN cost_currency TEXT`,
    ],
  },
]

const FTS_STATEMENT = `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id,
  user_id UNINDEXED,
  title,
  body,
  tokenize = "unicode61 remove_diacritics 2"
)`

const DATABASE_STATE_KEY = 'database-state-v1'

const TABLE_SCHEMA_STATEMENTS = SCHEMA_STATEMENTS.filter((statement) =>
  /^\s*CREATE TABLE IF NOT EXISTS/.test(statement),
)
const INDEX_SCHEMA_STATEMENTS = SCHEMA_STATEMENTS.filter((statement) =>
  /^\s*CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/.test(statement),
)

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  app_meta: ['key', 'value'],
  schema_migrations: ['version', 'applied_at'],
  users: ['id', 'username', 'password_hash', 'login', 'name', 'avatar_url', 'role', 'settings', 'created_at', 'last_seen_at'],
  folders: ['id', 'user_id', 'parent_id', 'name', 'icon', 'color', 'position', 'created_at', 'updated_at', 'deleted_at'],
  notes: ['id', 'user_id', 'folder_id', 'title', 'title_key', 'content', 'excerpt', 'rev', 'word_count', 'char_count', 'is_pinned', 'is_starred', 'is_archived', 'position', 'content_hash', 'created_at', 'updated_at', 'deleted_at'],
  tags: ['id', 'user_id', 'name', 'color', 'is_manual', 'created_at'],
  note_tags: ['note_id', 'tag_id'],
  links: ['source_note_id', 'target_key', 'target_title', 'target_note_id', 'user_id'],
  note_versions: ['id', 'note_id', 'user_id', 'title', 'content', 'size', 'created_at'],
  attachments: ['id', 'user_id', 'note_id', 'filename', 'mime', 'size', 'sha256', 'width', 'height', 'storage', 'created_at'],
  attachment_cleanup: ['object_key', 'user_id', 'created_at'],
  import_mappings: ['user_id', 'entity', 'source_id', 'target_id', 'updated_at'],
  backup_targets: ['id', 'user_id', 'type', 'name', 'enabled', 'config', 'secret', 'last_run_at', 'last_status', 'last_error', 'created_at', 'updated_at'],
  backup_runs: ['id', 'user_id', 'trigger', 'status', 'started_at', 'finished_at', 'note_count', 'file_count', 'bytes', 'detail'],
  shares: ['slug', 'note_id', 'user_id', 'password_hash', 'expires_at', 'views', 'created_at'],
  share_asset_sessions: ['id', 'slug', 'password_hash', 'expires_at', 'created_at'],
  changes: ['seq', 'user_id', 'entity', 'entity_id', 'op', 'at'],
  sessions: ['id', 'user_id', 'expires_at', 'created_at'],
  login_attempts: ['key', 'fails', 'last_fail_at', 'locked_until'],
  totp_credentials: ['user_id', 'secret_ciphertext', 'enabled_at', 'pending_token_hash', 'pending_session_id', 'pending_expires_at', 'recovery_generation', 'last_used_step', 'last_used_by', 'created_at', 'updated_at'],
  totp_recovery_codes: ['user_id', 'code_hash', 'generation', 'created_at', 'used_at', 'used_by'],
  totp_login_challenges: ['id', 'user_id', 'expires_at', 'claimed_by', 'created_at'],
  mcp_preferences: ['user_id', 'write_enabled', 'trash_enabled', 'updated_at'],
  mcp_operations: ['user_id', 'operation_id', 'tool', 'request_hash', 'response_json', 'created_at'],
  mcp_api_keys: ['id', 'user_id', 'name', 'key_hash', 'scopes', 'created_at', 'last_used_at', 'revoked_at'],
  ai_note_embeddings: ['user_id', 'note_id', 'model', 'vector', 'indexed_at'],
  ai_index_queue: ['user_id', 'note_id', 'kind', 'created_at'],
  fts_index_queue: ['user_id', 'note_id', 'kind', 'created_at'],
  ai_providers: ['id', 'user_id', 'name', 'enabled', 'notes', 'preset_id', 'position', 'created_at', 'updated_at'],
  ai_endpoints: ['id', 'user_id', 'provider_id', 'slug', 'base_url', 'protocol', 'position', 'image_base_url', 'headers', 'image_edit_base_url'],
  ai_endpoint_keys: ['id', 'user_id', 'endpoint_id', 'label', 'enabled', 'key_ciphertext', 'position'],
  ai_models: ['user_id', 'endpoint_id', 'model_id', 'model_type', 'type_source', 'context_window', 'can_vision', 'position', 'max_output', 'supports_tools', 'reasoning', 'native_web_search', 'name', 'group_name', 'pricing'],
  ai_roles: ['user_id', 'role', 'endpoint_id', 'model_id'],
  ai_chat_conversations: ['id', 'user_id', 'title', 'scope', 'created_at', 'updated_at', 'selected_turn_id', 'revision'],
  ai_chat_turns: ['id', 'user_id', 'conversation_id', 'seq', 'status', 'input', 'messages', 'model_id', 'endpoint_id', 'error_code', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'reasoning_effort', 'reasoning_text', 'context_usage', 'created_at', 'parent_id', 'question_id', 'supersedes_id', 'kind', 'cost', 'cost_currency'],
  ai_turn_images: ['user_id', 'turn_id', 'idx', 'mime', 'object_key', 'created_at', 'kind'],
} as const

const REQUIRED_TABLES = [
  'app_meta',
  'schema_migrations',
  'users',
  'folders',
  'notes',
  'tags',
  'note_tags',
  'links',
  'note_versions',
  'attachments',
  'attachment_cleanup',
  'import_mappings',
  'backup_targets',
  'backup_runs',
  'shares',
  'share_asset_sessions',
  'changes',
  'sessions',
  'login_attempts',
  'totp_credentials',
  'totp_recovery_codes',
  'totp_login_challenges',
  'mcp_preferences',
  'mcp_operations',
  'mcp_api_keys',
  'ai_note_embeddings',
  'ai_index_queue',
  'fts_index_queue',
  'ai_providers',
  'ai_endpoints',
  'ai_endpoint_keys',
  'ai_models',
  'ai_roles',
  'ai_chat_conversations',
  'ai_chat_turns',
  'ai_turn_images',
  'ai_search_provider_configs',
  'ai_search_defaults',
  'ai_search_keys',
  'ai_search_preferences',
] as const

const REQUIRED_INDEXES = [
  'idx_folders_user',
  'idx_folders_unique_sibling',
  'idx_notes_user_updated',
  'idx_notes_folder',
  'idx_notes_starred',
  'idx_notes_trash',
  'idx_notes_title_key',
  'idx_notes_user_id',
  'idx_tags_unique',
  'idx_tags_name_nocase',
  'idx_note_tags_tag',
  'idx_links_target',
  'idx_links_target_note',
  'idx_versions_note',
  'idx_versions_user',
  'idx_attachments_user',
  'idx_attachments_user_sha',
  'idx_attachments_note',
  'idx_attachment_cleanup_created',
  'idx_attachment_cleanup_user',
  'idx_import_mappings_target',
  'idx_targets_user',
  'idx_runs_user',
  'idx_shares_note',
  'idx_shares_user_created',
  'idx_share_asset_sessions_slug',
  'idx_share_asset_sessions_expires',
  'idx_changes_user',
  'idx_sessions_user',
  'idx_sessions_expires',
  'idx_login_attempts_last_fail',
  'idx_totp_recovery_codes_user',
  'idx_totp_challenges_user',
  'idx_totp_challenges_expires',
  'idx_mcp_operations_created',
  'idx_mcp_api_keys_user',
  'idx_mcp_api_keys_revoked',
  'idx_ai_embeddings_indexed',
  'idx_ai_index_queue_due',
  'idx_fts_index_queue_due',
  'idx_ai_providers_user',
  'idx_ai_endpoints_user',
  'idx_ai_endpoint_keys',
  'idx_ai_chat_conversations_user',
  'idx_ai_search_keys_scope',
  'idx_ai_turn_images_object',
] as const


const initializationCache = new WeakMap<D1Database, Promise<DatabaseState>>()

export function initializeDatabase(env: Env): Promise<DatabaseState> {
  const existing = initializationCache.get(env.DB)
  if (existing) return existing

  const pending = createSchema(env.DB).catch((error) => {
    initializationCache.delete(env.DB)
    throw error
  })
  initializationCache.set(env.DB, pending)
  return pending
}

async function createSchema(db: D1Database): Promise<DatabaseState> {
  const stored = await readStoredDatabaseState(db)
  if (stored) return stored

  const initialized = await db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'users'`)
    .first<{ present: number }>()
  if (!initialized) {
    await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
  } else {
    await db.batch(TABLE_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
  }
  await applyMigrations(db)
  if (initialized) {
    await db.batch(INDEX_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
  }
  await assertFinalSchema(db)

  let state: DatabaseState
  try {
    await db.prepare(FTS_STATEMENT).run()
    await upgradeFtsIdentifiers(db)
    state = { ftsEnabled: true }
  } catch (error) {
    console.warn(
      '[autonote] Full-text index initialization or upgrade failed; search will use LIKE:',
      error instanceof Error ? error.message : error,
    )
    state = { ftsEnabled: false }
  }
  if (state.ftsEnabled) {
    await setMeta(db, DATABASE_STATE_KEY, JSON.stringify({
      schema: schemaFingerprint(),
      ftsEnabled: true,
    }))
  }
  return state
}

async function upgradeFtsIdentifiers(db: D1Database): Promise<void> {
  const table = await db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'`,
  ).first<{ sql: string }>()
  if (!table || !/note_id\s+UNINDEXED/i.test(table.sql)) return
  await db.batch([
    db.prepare(FTS_STATEMENT.replace('notes_fts', 'notes_fts_identifiers')),
    db.prepare(`INSERT INTO notes_fts_identifiers (rowid, note_id, user_id, title, body)
      SELECT rowid, note_id, user_id, title, body FROM notes_fts`),
    db.prepare(`DROP TABLE notes_fts`),
    db.prepare(`ALTER TABLE notes_fts_identifiers RENAME TO notes_fts`),
  ])
}

async function applyMigrations(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  ).run()
  const { results } = await db.prepare(`SELECT version FROM schema_migrations`).all<{ version: number }>()
  const applied = new Set(results.map((row) => row.version))

  for (const migration of SCHEMA_MIGRATIONS) {
    if (applied.has(migration.version)) continue
    let migrationStatements = migration.statements
    if (migration.skipIfColumnExists) {
      const { table, column } = migration.skipIfColumnExists
      const { results: columns } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
      if (columns.some((entry) => entry.name === column)) migrationStatements = []
    }
    const statements = migrationStatements.map((statement) => db.prepare(statement))
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)`)
        .bind(migration.version, Date.now()),
    )
    await db.batch(statements)
  }
}

async function readStoredDatabaseState(db: D1Database): Promise<DatabaseState | null> {
  try {
    const raw = await getMeta(db, DATABASE_STATE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as { schema?: unknown; ftsEnabled?: unknown }
    if (value.schema !== schemaFingerprint() || value.ftsEnabled !== true) return null
    return { ftsEnabled: true }
  } catch {
    return null
  }
}

function schemaFingerprint(): string {
  const migrationSource = SCHEMA_MIGRATIONS.map((migration) => JSON.stringify({
    version: migration.version,
    statements: migration.statements,
    skipIfColumnExists: migration.skipIfColumnExists ?? null,
  }))
  const source = [...SCHEMA_STATEMENTS, FTS_STATEMENT, ...migrationSource].join('\n')
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

async function assertFinalSchema(db: D1Database): Promise<void> {
  const { results: tableRows } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all<{ name: string }>()
  const tables = new Set(tableRows.map((row) => row.name))
  const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table))
  if (missingTables.length) {
    throw new Error(
      `The database migration did not produce the required tables: ${missingTables.join(', ')}`,
    )
  }

  const { results: indexRows } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
    .all<{ name: string }>()
  const indexes = new Set(indexRows.map((row) => row.name))
  const missingIndexes = REQUIRED_INDEXES.filter((index) => !indexes.has(index))
  if (missingIndexes.length) {
    throw new Error(
      `The database migration did not produce the required indexes: ${missingIndexes.join(', ')}`,
    )
  }

  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    const columns = new Set(results.map((row) => row.name))
    const missing = required.filter((column) => !columns.has(column))
    if (missing.length) {
      throw new Error(
        `The database schema is incompatible (${table} is missing ${missing.join(', ')})`,
      )
    }
  }
}
