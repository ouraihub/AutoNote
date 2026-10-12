//! AutoNote AI wire types and product role settings. Conversations live in Aether's `chat.db`.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::error::Error;
use crate::write::WriteOrigin;

macro_rules! text_enum {
    ($name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        impl $name {
            /// Stable wire and storage text.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }
        impl rusqlite::types::ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }
        impl rusqlite::types::FromSql for $name {
            fn column_result(
                value: rusqlite::types::ValueRef<'_>,
            ) -> rusqlite::types::FromSqlResult<Self> {
                match value.as_str()? {
                    $($text => Ok(Self::$variant),)+
                    _ => Err(rusqlite::types::FromSqlError::InvalidType),
                }
            }
        }
    };
}

/// Wire protocol spoken by an endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiProtocol {
    AnthropicMessages,
    OpenaiChat,
    OpenaiResponses,
}
text_enum!(AiProtocol {
    AnthropicMessages = "anthropic-messages",
    OpenaiChat = "openai-chat",
    OpenaiResponses = "openai-responses",
});

/// What a model is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiModelType {
    Chat,
    Image,
    Video,
    Tts,
    Stt,
    Embedding,
    Rerank,
    Unknown,
}
text_enum!(AiModelType {
    Chat = "chat",
    Image = "image",
    Video = "video",
    Tts = "tts",
    Stt = "stt",
    Embedding = "embedding",
    Rerank = "rerank",
    Unknown = "unknown",
});

/// Whether a model type was inferred from its id or chosen by the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiTypeSource {
    Inferred,
    User,
}
text_enum!(AiTypeSource {
    Inferred = "inferred",
    User = "user",
});

/// A product role a chat model can be bound to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiRole {
    Chat,
    Writing,
}
text_enum!(AiRole {
    Chat = "chat",
    Writing = "writing",
});

/// A model saved on an endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiModel {
    pub id: String,
    pub model_type: AiModelType,
    pub type_source: AiTypeSource,
    pub context_window: Option<u32>,
    pub can_vision: bool,
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
