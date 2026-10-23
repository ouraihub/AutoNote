CREATE TABLE sync_binding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_origin TEXT NOT NULL,
  account_hint TEXT NOT NULL,
  remote_user_id TEXT NOT NULL,
  cookie_ciphertext BLOB NOT NULL,
  cookie_name TEXT NOT NULL,
  cookie_domain TEXT NOT NULL,
  cookie_path TEXT NOT NULL,
  cookie_expires_at INTEGER,
  cookie_secure INTEGER NOT NULL DEFAULT 1,
  cookie_host_only INTEGER NOT NULL DEFAULT 1,
  cookie_same_site TEXT NOT NULL DEFAULT 'Lax',
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  last_success_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE sync_item (
  entity TEXT NOT NULL CHECK (entity IN ('note','folder','tag')),
  id TEXT NOT NULL,
  remote_rev INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0,1)),
  PRIMARY KEY (entity, id)
);
CREATE INDEX sync_item_dirty ON sync_item(entity) WHERE dirty = 1;
CREATE TABLE sync_attachment (
  local_id TEXT PRIMARY KEY,
  remote_id TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0)
);

-- Only the ciphertext moves; it is never decrypted here.
INSERT INTO sync_binding(id,site_origin,account_hint,remote_user_id,cookie_ciphertext,cookie_name,cookie_domain,cookie_path,cookie_expires_at,cookie_secure,cookie_host_only,cookie_same_site,cursor,last_error_code,created_at)
SELECT 1,site_origin,account_hint,remote_user_id,cookie_ciphertext,cookie_name,cookie_domain,cookie_path,cookie_expires_at,cookie_secure,cookie_host_only,cookie_same_site,cursor,last_error_code,updated_at
FROM sync_state
WHERE cookie_ciphertext IS NOT NULL AND status NOT IN ('quarantined','discarded')
ORDER BY updated_at DESC LIMIT 1;

-- Local rows confirmed by the old binding (same id on both ends) are clean; everything else is pending.
INSERT INTO sync_item(entity,id,remote_rev,dirty)
SELECT 'note', n.id, m.remote_rev, CASE WHEN m.local_id IS NULL OR m.state <> 'synced' THEN 1 ELSE 0 END
FROM notes n LEFT JOIN sync_map m
  ON m.entity='note' AND m.local_id=n.id AND m.remote_id=n.id AND m.remote_rev IS NOT NULL
  AND m.binding_id=(SELECT binding_id FROM sync_state WHERE cookie_ciphertext IS NOT NULL AND status NOT IN ('quarantined','discarded') ORDER BY updated_at DESC LIMIT 1)
  AND EXISTS (SELECT 1 FROM sync_binding);
INSERT INTO sync_item(entity,id,remote_rev,dirty)
SELECT 'folder', f.id, NULL, CASE WHEN m.local_id IS NULL THEN 1 ELSE 0 END
FROM folders f LEFT JOIN sync_map m
  ON m.entity='folder' AND m.local_id=f.id AND m.remote_id=f.id AND m.state='synced'
  AND m.binding_id=(SELECT binding_id FROM sync_state WHERE cookie_ciphertext IS NOT NULL AND status NOT IN ('quarantined','discarded') ORDER BY updated_at DESC LIMIT 1)
  AND EXISTS (SELECT 1 FROM sync_binding);
INSERT INTO sync_item(entity,id,remote_rev,dirty)
SELECT 'tag', t.id, NULL, CASE WHEN m.local_id IS NULL THEN 1 ELSE 0 END
FROM tags t LEFT JOIN sync_map m
  ON m.entity='tag' AND m.local_id=t.id AND m.remote_id=t.id AND m.state='synced'
  AND m.binding_id=(SELECT binding_id FROM sync_state WHERE cookie_ciphertext IS NOT NULL AND status NOT IN ('quarantined','discarded') ORDER BY updated_at DESC LIMIT 1)
  AND EXISTS (SELECT 1 FROM sync_binding)
WHERE t.is_manual = 1;

-- The old engine advanced the cursor without writing pulled rows: a mapped
-- note missing locally means remote rows were skipped, so pull a full snapshot.
UPDATE sync_binding SET cursor = 0
WHERE EXISTS (
  SELECT 1 FROM sync_map m
  WHERE m.entity = 'note'
    AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = m.local_id)
);

DROP TABLE sync_snapshot;
DROP TABLE sync_conflict;
DROP TABLE sync_attachment_map;
DROP TABLE sync_outbox;
DROP TABLE sync_map;
DROP TABLE sync_state;
