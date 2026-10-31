import { AI_TURN_IMAGES, RELAY_TABLES } from './schema-statements'
interface SchemaMigration {
  version: number
  statements: readonly string[]
  skipIfColumnExists?: { table: string; column: string }
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS mcp_preferences (
         user_id TEXT PRIMARY KEY,
         write_enabled INTEGER NOT NULL DEFAULT 1 CHECK (` +
           `write_enabled IN (0, 1)),
         trash_enabled INTEGER NOT NULL DEFAULT 0 CHECK (` +
           `trash_enabled IN (0, 1)),
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
    statements: [`ALTER TABLE folders ADD COLUMN color TEXT`],
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
      `CREATE INDEX IF NOT EXISTS idx_attachments_user_sha ` +
        `ON attachments(user_id, sha256)`,
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
      `CREATE INDEX idx_versions_note ON note_versions(` +
        `note_id, created_at DESC, id DESC)`,
      `DROP INDEX IF EXISTS idx_runs_user`,
      `CREATE INDEX idx_runs_user ON backup_runs(` +
        `user_id, started_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id, id)`,
      `CREATE INDEX IF NOT EXISTS idx_tags_name_nocase ON tags(` +
        `user_id, name COLLATE NOCASE)`,
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
      `ALTER TABLE ai_chat_conversations ADD COLUMN revision ` +
        `TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE ai_chat_turns ADD COLUMN parent_id TEXT`,
      `ALTER TABLE ai_chat_turns ADD COLUMN question_id ` +
        `TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE ai_chat_turns ADD COLUMN supersedes_id TEXT`,
      `ALTER TABLE ai_chat_turns ADD COLUMN kind TEXT NOT NULL ` +
        `DEFAULT 'reply' CHECK(kind IN ('reply','translation'))`,
      `UPDATE ai_chat_turns SET question_id = id, parent_id = (` +
        `SELECT previous.id FROM ai_chat_turns previous ` +
        `WHERE previous.conversation_id = ai_chat_turns.conversation_id ` +
        `AND previous.user_id = ai_chat_turns.user_id ` +
        `AND previous.seq < ai_chat_turns.seq ORDER BY previous.seq DESC ` +
        `LIMIT 1)`,
      `UPDATE ai_chat_conversations SET selected_turn_id = (` +
        `SELECT id FROM ai_chat_turns ` +
        `WHERE conversation_id = ai_chat_conversations.id ` +
        `AND user_id = ai_chat_conversations.user_id ` +
        `AND status = 'completed' ORDER BY seq DESC LIMIT 1)`,
    ],
  },
  {
    version: 18,
    skipIfColumnExists: { table: 'ai_models', column: 'native_web_search' },
    statements: [
      `ALTER TABLE ai_models ADD COLUMN native_web_search ` +
        `INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 19,
    statements: AI_TURN_IMAGES,
  },
  {
    version: 20,
    statements: [
      `CREATE TABLE ai_roles_v20 (` +
        `user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(` +
        `role IN ('chat','writing','painting')), endpoint_id TEXT, ` +
        `model_id TEXT, PRIMARY KEY(user_id, role))`,
      `INSERT INTO ai_roles_v20 (user_id, role, endpoint_id, model_id) ` +
        `SELECT user_id, role, endpoint_id, model_id FROM ai_roles`,
      `DROP TABLE ai_roles`,
      `ALTER TABLE ai_roles_v20 RENAME TO ai_roles`,
    ],
  },
  {
    version: 21,
    skipIfColumnExists: { table: 'ai_turn_images', column: 'kind' },
    statements: [
      `ALTER TABLE ai_turn_images ADD COLUMN kind TEXT NOT NULL ` +
        `DEFAULT 'input' CHECK(kind IN ('input','generated'))`,
    ],
  },
  {
    version: 22,
    skipIfColumnExists: { table: 'ai_providers', column: 'enabled' },
    statements: [
      `ALTER TABLE ai_providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
    ],
  },
  {
    // Multi-key endpoints (docs/34 §4): drop the single key column; old
    // keys are not migrated.
    version: 23,
    statements: [
      `CREATE TABLE ai_endpoints_v23 (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider_id TEXT NOT NULL,
        slug TEXT NOT NULL, base_url TEXT NOT NULL, protocol TEXT NOT NULL,
        position INTEGER NOT NULL,
        UNIQUE(user_id, provider_id, slug)
      )`,
      `INSERT INTO ai_endpoints_v23 (id, user_id, provider_id, slug, ` +
        `base_url, protocol, position) SELECT id, user_id, provider_id, ` +
        `slug, base_url, protocol, position FROM ai_endpoints`,
      `DROP TABLE ai_endpoints`,
      `ALTER TABLE ai_endpoints_v23 RENAME TO ai_endpoints`,
      `CREATE INDEX IF NOT EXISTS idx_ai_endpoints_user ` +
        `ON ai_endpoints(user_id, provider_id, position, id)`,
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
    skipIfColumnExists: {
      table: 'ai_endpoints',
      column: 'image_edit_base_url',
    },
    statements: [
      `ALTER TABLE ai_endpoints ADD COLUMN image_edit_base_url TEXT`,
    ],
  },
  {
    version: 26,
    skipIfColumnExists: { table: 'ai_providers', column: 'notes' },
    statements: [
      `ALTER TABLE ai_providers ADD COLUMN notes TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 27,
    skipIfColumnExists: { table: 'ai_providers', column: 'preset_id' },
    statements: [
      `ALTER TABLE ai_providers ADD COLUMN preset_id TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_providers_preset ` +
        `ON ai_providers(user_id, preset_id) WHERE preset_id IS NOT NULL`,
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
  {
    version: 29,
    skipIfColumnExists: { table: 'ai_endpoints', column: 'key_strategy' },
    statements: [
      `ALTER TABLE ai_endpoints ADD COLUMN key_strategy TEXT NOT NULL ` +
        `DEFAULT 'round_robin' CHECK(key_strategy IN ` +
        `('round_robin','fill_first'))`,
      `ALTER TABLE ai_endpoint_keys ADD COLUMN exhausted_until INTEGER`,
      `ALTER TABLE ai_endpoint_keys ADD COLUMN exhausted_reason TEXT`,
    ],
  },
  {
    version: 30,
    statements: RELAY_TABLES,
  },
]