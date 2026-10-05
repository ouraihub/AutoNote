//! Persistent local MCP credentials, preferences, and idempotency records.
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{db::Library, error::Error};

/// A persisted MCP bearer key without secret material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToken {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub scopes: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

/// Persistent local MCP feature gates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPreferences {
    pub write_enabled: bool,
    pub trash_enabled: bool,
    pub updated_at: i64,
}

/// One idempotent MCP operation record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOperation {
    pub operation_id: String,
    pub tool: String,
    pub request_hash: String,
    pub response_json: String,
    pub status: String,
    pub created_at: i64,
}

/// Result of checking an operation before executing its domain mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpOperationLookup {
    New,
    Replay(String),
    Conflict,
    Expired,
}

impl Library {
    /// Lists persisted MCP keys. Secret bearer values are never returned.
    /// # Errors
    /// Returns storage errors.
    pub fn mcp_tokens(&self) -> Result<Vec<McpToken>, Error> {
        self.read(|conn| {
            let mut statement = conn.prepare("SELECT id,name,token_hash,scopes,created_at,last_used_at,revoked_at FROM mcp_tokens ORDER BY created_at,id")?;
            Ok(statement
                .query_map([], |row| Ok(McpToken {
                    id: row.get(0)?, name: row.get(1)?, token_hash: row.get(2)?, scopes: row.get(3)?,
                    created_at: row.get(4)?, last_used_at: row.get(5)?, revoked_at: row.get(6)?,
                }))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Persists a newly issued key hash.
    /// # Errors
    /// Returns storage or validation errors.
    pub fn mcp_insert_token(&self, token: &McpToken) -> Result<(), Error> {
        if token.id.is_empty()
            || token.id.len() > 128
            || token.name.trim().is_empty()
            || token.name.len() > 120
        {
            return Err(Error::invalid("token", "invalid token metadata"));
        }
        self.write(crate::write::WriteOrigin::Mcp, |tx| {
            tx.tx.execute("INSERT INTO mcp_tokens(id,name,token_hash,scopes,created_at,last_used_at,revoked_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![token.id, token.name, token.token_hash, token.scopes, token.created_at, token.last_used_at, token.revoked_at])?;
            Ok(())
        })?;
        Ok(())
    }

    /// Revokes a key immediately; repeated revocation is harmless.
    /// # Errors
    /// Returns storage errors.
    pub fn mcp_revoke_token(&self, id: &str, now: i64) -> Result<(), Error> {
        self.write(crate::write::WriteOrigin::Mcp, |tx| {
            tx.tx.execute(
                "UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,?2) WHERE id=?1",
                params![id, now],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    /// Authenticates a bearer by constant-time hash comparison in Rust.
    /// # Errors
    /// Returns storage errors; callers map no-match to unauthenticated.
    pub fn mcp_authenticate(
        &self,
        token: &str,
        required_scope: &str,
        now: i64,
    ) -> Result<bool, Error> {
        let hash = sha256_hex(token);
        self.write(crate::write::WriteOrigin::Mcp, |tx| {
            let records = {
                let mut statement = tx
                    .tx
                    .prepare("SELECT id,token_hash,scopes,revoked_at FROM mcp_tokens")?;
                let rows = statement.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (id, stored, scopes, revoked) in records {
                if constant_time_eq(hash.as_bytes(), stored.as_bytes()) && revoked.is_none() {
                    if required_scope.is_empty()
                        || scopes.split(',').any(|scope| scope == required_scope)
                    {
                        tx.tx.execute(
                            "UPDATE mcp_tokens SET last_used_at=?2 WHERE id=?1",
                            params![id, now],
                        )?;
                        return Ok(true);
                    }
                    return Ok(false);
                }
            }
            Ok(false)
        })
        .map(|written| written.value)
    }
    /// # Errors
    /// Returns storage errors.
    pub fn mcp_preferences(&self) -> Result<McpPreferences, Error> {
        self.read(|conn| {
            conn.query_row(
                "SELECT write_enabled,trash_enabled,updated_at FROM mcp_preferences WHERE id=1",
                [],
                |row| {
                    Ok(McpPreferences {
                        write_enabled: row.get::<_, i64>(0)? != 0,
                        trash_enabled: row.get::<_, i64>(1)? != 0,
                        updated_at: row.get(2)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| Error::invalid("mcp_preferences", "missing preferences"))
        })
    }

    /// Updates local MCP feature gates without changing key scopes.
    /// # Errors
    /// Returns storage errors.
    pub fn set_mcp_preferences(&self, preferences: McpPreferences, now: i64) -> Result<(), Error> {
        self.write(crate::write::WriteOrigin::Mcp, |tx| {
            tx.tx.execute("INSERT INTO mcp_preferences(id,write_enabled,trash_enabled,updated_at) VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET write_enabled=excluded.write_enabled,trash_enabled=excluded.trash_enabled,updated_at=excluded.updated_at", params![i64::from(preferences.write_enabled), i64::from(preferences.trash_enabled), now])?;
            Ok(())
        })?;
        Ok(())
    }

    /// Checks an operation id and request hash before executing a write.
    /// # Errors
    /// Returns storage errors.
    pub fn mcp_operation_lookup(
        &self,
        operation_id: &str,
        tool: &str,
        request_hash: &str,
        now: i64,
    ) -> Result<McpOperationLookup, Error> {
        self.read(|conn| {
            let existing: Option<(String, String, String, String, i64)> = conn.query_row("SELECT tool,request_hash,response_json,status,created_at FROM mcp_operations WHERE operation_id=?1", [operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).optional()?;
            let Some((saved_tool, saved_hash, result, status, created)) = existing else { return Ok(McpOperationLookup::New); };
            if saved_tool != tool || saved_hash != request_hash { return Ok(McpOperationLookup::Conflict); }
            if status == "expired" || now.saturating_sub(created) > 7 * 24 * 60 * 60 * 1000 { return Ok(McpOperationLookup::Expired); }
            Ok(McpOperationLookup::Replay(result))
        })
    }

    /// Stores an operation result. The caller must invoke this in the same domain transaction when atomicity is required.
    /// # Errors
    /// Returns storage errors.
    pub fn mcp_store_operation(&self, operation: &McpOperation) -> Result<(), Error> {
        self.write(crate::write::WriteOrigin::Mcp, |tx| {
            tx.tx.execute("INSERT INTO mcp_operations(operation_id,tool,request_hash,response_json,status,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![operation.operation_id, operation.tool, operation.request_hash, operation.response_json, operation.status, operation.created_at])?;
            Ok(())
        })?;
        Ok(())
    }
}

fn sha256_hex(value: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}
