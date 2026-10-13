//! AutoNote AI role settings. Providers live in Aether; conversations in Aether's `chat.db`.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::error::Error;
use crate::write::WriteOrigin;

/// A product role a chat model can be bound to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiRole {
    Chat,
    Writing,
}

/// Reference to a saved model.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiModelRef {
    pub endpoint_id: String,
    pub model_id: String,
}

/// A role and its effective binding. `is_fallback` marks `writing` following `chat`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiRoleRow {
    pub role: AiRole,
    pub binding: Option<AiModelRef>,
    pub is_fallback: bool,
}

/// Product-owned references in the `prefs.aiRoles` namespace; no provider data.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiRoleSettings {
    pub chat: Option<AiModelRef>,
    pub writing: Option<AiModelRef>,
}

impl Library {
    /// Loads only new product role settings, never historical `ai_roles` rows.
    /// # Errors
    /// Returns storage or malformed settings errors.
    pub fn ai_role_settings(&self) -> Result<AiRoleSettings, Error> {
        self.read(|conn| {
            let value: Option<String> = conn
                .query_row("SELECT value FROM prefs WHERE key='aiRoles'", [], |r| {
                    r.get(0)
                })
                .optional()?;
            value.map_or_else(
                || Ok(AiRoleSettings::default()),
                |value| {
                    serde_json::from_str(&value)
                        .map_err(|_| Error::invalid("aiRoles", "invalid stored settings"))
                },
            )
        })
    }

    /// Persists product references; the command layer validates against Aether.
    /// # Errors
    /// Returns storage or encoding errors.
    pub fn ai_role_settings_save(&self, settings: &AiRoleSettings) -> Result<(), Error> {
        let value = serde_json::to_string(settings)
            .map_err(|_| Error::invalid("aiRoles", "cannot encode settings"))?;
        self.write(WriteOrigin::Ui, |w| {
            w.tx.execute(
                "INSERT INTO prefs(key,value,updated_at) VALUES('aiRoles',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![value, w.now.get()],
            )?;
            Ok(())
        })?;
        Ok(())
    }
}
