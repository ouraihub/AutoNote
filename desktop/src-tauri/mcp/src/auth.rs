//! Local MCP authentication and per-call policy checks.
//!
//! Persistence and OS CSPRNG belong to the desktop composition root. This crate
//! deliberately accepts caller-provided entropy so it cannot silently downgrade
//! token generation to a predictable PRNG.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use note_core::markdown::sha256_hex;

/// Permission attached to an MCP token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Read-only tools.
    Read,
    /// Mutating tools other than trash.
    Write,
    /// Moving notes to trash.
    Trash,
}

impl Scope {
    /// Wire spelling used by the Worker MCP contract.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "notes:read",
            Self::Write => "notes:write",
            Self::Trash => "notes:trash",
        }
    }
}

/// Local MCP feature guards.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Preferences {
    /// Whether write tools are enabled.
    pub write_enabled: bool,
    /// Whether trash_note is enabled.
    pub trash_enabled: bool,
}

/// A non-secret token record. Only the hash is retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenRecord {
    /// Stable key identifier.
    pub id: String,
    /// User-visible key name.
    pub name: String,
    /// SHA-256 digest of the complete bearer token.
    pub token_hash: String,
    /// Granted scopes.
    pub scopes: Vec<Scope>,
    /// Creation timestamp in milliseconds.
    pub created_at: u64,
    /// Last successful authentication timestamp.
    pub last_used_at: Option<u64>,
    /// Revocation timestamp, if revoked.
    pub revoked_at: Option<u64>,
}

/// One-time token returned by [`TokenStore::issue`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedToken {
    /// Non-secret key metadata.
    pub record: TokenRecord,
    /// Complete bearer value. The caller must not persist it.
    pub token: String,
}

/// In-memory token registry used by the service until the core MCP migration is available.
#[derive(Debug, Default)]
pub struct TokenStore {
    records: BTreeMap<String, TokenRecord>,
}

impl TokenStore {
    /// Issues an `ink_` token from caller-provided OS-random entropy.
    ///
    /// # Errors
    /// Returns an error when the name, id, or entropy is invalid.
    pub fn issue(
        &mut self,
        id: String,
        name: String,
        entropy: &[u8],
        scopes: Vec<Scope>,
        now: u64,
    ) -> Result<IssuedToken, AuthError> {
        if id.is_empty() || id.len() > 128 || name.trim().is_empty() || name.len() > 120 {
            return Err(AuthError::InvalidInput);
        }
        if entropy.len() < 24 {
            return Err(AuthError::InsufficientEntropy);
        }
        let token = format!("ink_{}", hex(entropy));
        let record = TokenRecord {
            id: id.clone(),
            name,
            token_hash: sha256_hex(&token),
            scopes,
            created_at: now,
            last_used_at: None,
            revoked_at: None,
        };
        self.records.insert(id, record.clone());
        Ok(IssuedToken { record, token })
    }

    /// Revokes a key. Repeated revocation is harmless and does not reveal state.
    pub fn revoke(&mut self, id: &str, now: u64) {
        if let Some(record) = self.records.get_mut(id) {
            record.revoked_at = Some(now);
        }
    }

    /// Returns non-secret key metadata, never token material.
    #[must_use]
    pub fn records(&self) -> Vec<TokenRecord> {
        self.records.values().cloned().collect()
    }

    /// Authenticates a bearer token and checks the requested permission.
    ///
    /// # Errors
    /// Returns an unauthenticated error when no active token matches, or a forbidden error when its scope is insufficient.
    pub fn authenticate(
        &mut self,
        token: &str,
        required: Scope,
        now: u64,
    ) -> Result<(), AuthError> {
        let supplied = sha256_hex(token);
        let mut matched = false;
        for record in self.records.values_mut() {
            let equal = constant_time_eq(record.token_hash.as_bytes(), supplied.as_bytes());
            if equal && record.revoked_at.is_none() {
                matched = true;
                if record.scopes.contains(&required)
                    && (required != Scope::Write || record.scopes.contains(&Scope::Write))
                {
                    record.last_used_at = Some(now);
                    return Ok(());
                }
            }
        }
        if matched {
            Err(AuthError::Forbidden)
        } else {
            Err(AuthError::Unauthenticated)
        }
    }

    /// Returns whether a token exists and is active without exposing its identity.
    #[must_use]
    pub fn is_active(&self, token: &str) -> bool {
        let supplied = sha256_hex(token);
        self.records.values().any(|record| {
            record.revoked_at.is_none()
                && constant_time_eq(record.token_hash.as_bytes(), supplied.as_bytes())
        })
    }
}

#[derive(Debug)]
pub enum AuthError {
    /// Input is malformed.
    InvalidInput,
    /// Caller did not provide enough entropy.
    InsufficientEntropy,
    /// No active token matched.
    Unauthenticated,
    /// Token matched but lacks the requested scope or preference guard.
    Forbidden,
    /// The loopback listener could not be started.
    Listener,
    /// The configured loopback port is already taken by another process.
    PortInUse,
}

/// Checks a scope plus local feature preferences.
///
/// # Errors
/// Returns [`AuthError::Forbidden`] when a local guard is disabled.
pub fn authorize(scope: Scope, preferences: Preferences) -> Result<(), AuthError> {
    match scope {
        Scope::Read => Ok(()),
        Scope::Write if preferences.write_enabled => Ok(()),
        Scope::Trash if preferences.trash_enabled => Ok(()),
        Scope::Write | Scope::Trash => Err(AuthError::Forbidden),
    }
}

/// Current UNIX milliseconds, saturated at `u64::MAX`.
#[must_use]
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
        .min(u64::MAX as u128) as u64
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

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
