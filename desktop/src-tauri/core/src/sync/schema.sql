CREATE TABLE sync_state (
  binding_id TEXT PRIMARY KEY NOT NULL,
  binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
  site_origin TEXT NOT NULL,
  account_hint TEXT NOT NULL,
  remote_user_id TEXT NOT NULL,
  cookie_ciphertext BLOB,
  cookie_domain TEXT NOT NULL,
  cookie_path TEXT NOT NULL,
  cookie_expires_at INTEGER,
  cookie_secure INTEGER NOT NULL DEFAULT 1, cookie_host_only INTEGER NOT NULL DEFAULT 1,
  cookie_name TEXT NOT NULL, cookie_same_site TEXT NOT NULL DEFAULT 'Lax',
  snapshot_run_id TEXT,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  snapshot_cursor INTEGER CHECK (snapshot_cursor IS NULL OR snapshot_cursor >= 0),
  after_key TEXT,
  status TEXT NOT NULL,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE sync_map (
  binding_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('note','folder','tag')),
  local_id TEXT NOT NULL, remote_id TEXT NOT NULL,
  local_rev INTEGER NOT NULL CHECK (local_rev >= 0),
  remote_rev INTEGER CHECK (remote_rev IS NULL OR remote_rev >= 0),
  sent_local_rev INTEGER CHECK (sent_local_rev IS NULL OR sent_local_rev >= 0),
  last_write_id TEXT, base_payload_json TEXT, base_hash TEXT,
  last_remote_cursor INTEGER CHECK (last_remote_cursor IS NULL OR last_remote_cursor >= 0),
  state TEXT NOT NULL,
  PRIMARY KEY (binding_id, binding_epoch, entity, local_id),
  UNIQUE (binding_id, binding_epoch, entity, remote_id),
  FOREIGN KEY (binding_id) REFERENCES sync_state(binding_id)
);
CREATE TABLE sync_outbox (
  binding_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('note','folder','tag','attachment')),
  write_id TEXT NOT NULL, local_id TEXT,
  local_rev INTEGER NOT NULL CHECK (local_rev >= 0),
  base_remote_rev INTEGER,
  sent_local_rev INTEGER CHECK (sent_local_rev IS NULL OR sent_local_rev >= 0),
  observed_cursor INTEGER NOT NULL CHECK (observed_cursor >= 0),
  ack_prereq TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB NOT NULL, attachment_refs TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL, state TEXT NOT NULL, last_error_code TEXT, recovery_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, binding_epoch, write_id),
  FOREIGN KEY (binding_id) REFERENCES sync_state(binding_id)
);
CREATE TABLE sync_attachment_map (
  binding_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
  local_attachment_id TEXT NOT NULL, remote_attachment_id TEXT,
  sha256 TEXT NOT NULL, size INTEGER NOT NULL CHECK (size >= 0),
  upload_intent_json TEXT, state TEXT NOT NULL,
  PRIMARY KEY (binding_id, binding_epoch, local_attachment_id),
  FOREIGN KEY (binding_id) REFERENCES sync_state(binding_id)
);
CREATE TABLE sync_snapshot (
  binding_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
  run_id TEXT NOT NULL, entity TEXT NOT NULL,
  remote_id TEXT NOT NULL, remote_rev INTEGER, payload_json TEXT NOT NULL,
  PRIMARY KEY(binding_id,binding_epoch,run_id,entity,remote_id)
);
CREATE TABLE sync_conflict (
  id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
  entity TEXT NOT NULL, local_id TEXT, remote_id TEXT,
  local_payload TEXT NOT NULL, remote_payload TEXT NOT NULL,
  reason TEXT NOT NULL, resolved_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX sync_outbox_ready ON sync_outbox(binding_id, binding_epoch, state, next_attempt_at, created_at, write_id);
CREATE INDEX sync_map_remote ON sync_map(binding_id, binding_epoch, remote_id);
