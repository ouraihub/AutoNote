//! AI model service configuration: providers, endpoints, saved models and role bindings.
//!
//! Keys are stored only as ciphertext produced by the command layer; this module
//! never sees plaintext. These writes touch no notes, so they emit no library events.
use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::error::{Entity, Error};
use crate::write::{WriteOrigin, new_id};

const MAX_ENDPOINTS: usize = 20;
const MAX_MODELS: usize = 1000;

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

/// A stored endpoint, including its key ciphertext. Not a wire type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiEndpointRow {
    pub id: String,
    pub provider_id: String,
    pub slug: String,
    pub base_url: String,
    pub protocol: AiProtocol,
    pub key_ciphertext: Option<Vec<u8>>,
    pub models: Vec<AiModel>,
}

/// A stored provider with its endpoints in position order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiProviderRow {
    pub id: String,
    pub name: String,
    pub endpoints: Vec<AiEndpointRow>,
}

/// Provider save request; endpoints missing from `endpoints` are deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiProviderInput {
    pub id: Option<String>,
    pub name: String,
    pub endpoints: Vec<AiEndpointInput>,
}

/// Endpoint save request; `models` replaces the saved model list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiEndpointInput {
    pub id: Option<String>,
    pub slug: String,
    pub base_url: String,
    pub protocol: AiProtocol,
    pub key: KeyChange,
    pub models: Vec<AiModel>,
}

/// Three-state key update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyChange {
    Keep,
    Clear,
    /// New key ciphertext.
    Set(Vec<u8>),
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

/// What a network call needs from a stored endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiEndpointSecret {
    pub endpoint_id: String,
    pub base_url: String,
    pub protocol: AiProtocol,
    pub key_ciphertext: Option<Vec<u8>>,
}

impl Library {
    /// Lists providers, endpoints and models in position order.
    /// # Errors
    /// Returns storage errors.
    pub fn ai_providers(&self) -> Result<Vec<AiProviderRow>, Error> {
        self.read(|conn| {
            let mut providers = conn
                .prepare("SELECT id,name FROM ai_providers ORDER BY position,id")?
                .query_map([], |r| {
                    Ok(AiProviderRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        endpoints: Vec::new(),
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let endpoints = conn
                .prepare("SELECT id,provider_id,slug,base_url,protocol,key_ciphertext FROM ai_endpoints ORDER BY position,id")?
                .query_map([], |r| {
                    Ok(AiEndpointRow {
                        id: r.get(0)?,
                        provider_id: r.get(1)?,
                        slug: r.get(2)?,
                        base_url: r.get(3)?,
                        protocol: r.get(4)?,
                        key_ciphertext: r.get(5)?,
                        models: Vec::new(),
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut models = conn.prepare("SELECT model_id,model_type,type_source,context_window,can_vision FROM ai_models WHERE endpoint_id=?1 ORDER BY position")?;
            for mut endpoint in endpoints {
                endpoint.models = models
                    .query_map([&endpoint.id], |r| {
                        Ok(AiModel {
                            id: r.get(0)?,
                            model_type: r.get(1)?,
                            type_source: r.get(2)?,
                            context_window: r.get(3)?,
                            can_vision: r.get(4)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                if let Some(provider) = providers.iter_mut().find(|p| p.id == endpoint.provider_id) {
                    provider.endpoints.push(endpoint);
                }
            }
            Ok(providers)
        })
    }

    /// Creates or updates a provider in one transaction and returns its id.
    /// Endpoints absent from the input are deleted; each endpoint's models are replaced.
    /// Role bindings that no longer point at a saved chat model are dropped.
    /// # Errors
    /// Returns `InvalidInput` for rule violations, `NotFound` for unknown
    /// provider or endpoint ids, and storage errors.
    pub fn ai_provider_save(&self, input: AiProviderInput, now: i64) -> Result<String, Error> {
        validate(&input)?;
        let written = self.write(WriteOrigin::Ui, |w| {
            let tx = &w.tx;
            let name = input.name.trim();
            let provider_id = if let Some(id) = &input.id {
                let changed = tx.execute(
                    "UPDATE ai_providers SET name=?2,updated_at=?3 WHERE id=?1",
                    params![id, name, now],
                )?;
                if changed == 0 {
                    return Err(not_found(Entity::AiProvider, id));
                }
                id.clone()
            } else {
                let id = new_id(w.ids.as_ref(), w.now, tx)?;
                tx.execute(
                    "INSERT INTO ai_providers(id,name,position,created_at,updated_at) VALUES(?1,?2,(SELECT COALESCE(MAX(position)+1,0) FROM ai_providers),?3,?3)",
                    params![id, name, now],
                )?;
                id
            };
            let kept: HashSet<&str> = input
                .endpoints
                .iter()
                .filter_map(|e| e.id.as_deref())
                .collect();
            let existing = tx
                .prepare("SELECT id FROM ai_endpoints WHERE provider_id=?1")?
                .query_map([&provider_id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for id in existing.iter().filter(|id| !kept.contains(id.as_str())) {
                tx.execute("DELETE FROM ai_endpoints WHERE id=?1", [id])?;
            }
            // Park slugs so that swapping two slugs cannot trip UNIQUE(provider_id, slug).
            tx.execute(
                "UPDATE ai_endpoints SET slug=char(0)||id WHERE provider_id=?1",
                [&provider_id],
            )?;
            for (position, endpoint) in (0_i64..).zip(&input.endpoints) {
                let (slug, base_url) = (endpoint.slug.trim(), endpoint.base_url.trim());
                let endpoint_id = if let Some(id) = &endpoint.id {
                    let changed = tx.execute(
                        "UPDATE ai_endpoints SET slug=?3,base_url=?4,protocol=?5,position=?6 WHERE id=?1 AND provider_id=?2",
                        params![id, provider_id, slug, base_url, endpoint.protocol, position],
                    )?;
                    if changed == 0 {
                        return Err(not_found(Entity::AiEndpoint, id));
                    }
                    id.clone()
                } else {
                    let id = new_id(w.ids.as_ref(), w.now, tx)?;
                    tx.execute(
                        "INSERT INTO ai_endpoints(id,provider_id,slug,base_url,protocol,position) VALUES(?1,?2,?3,?4,?5,?6)",
                        params![id, provider_id, slug, base_url, endpoint.protocol, position],
                    )?;
                    id
                };
                let key = match &endpoint.key {
                    KeyChange::Keep => None,
                    KeyChange::Clear => Some(None),
                    KeyChange::Set(ciphertext) => Some(Some(ciphertext)),
                };
                if let Some(key) = key {
                    tx.execute(
                        "UPDATE ai_endpoints SET key_ciphertext=?2 WHERE id=?1",
                        params![endpoint_id, key],
                    )?;
                }
                replace_models(tx, &endpoint_id, &endpoint.models)?;
            }
            tx.execute(
                "DELETE FROM ai_roles WHERE NOT EXISTS (SELECT 1 FROM ai_models m WHERE m.endpoint_id=ai_roles.endpoint_id AND m.model_id=ai_roles.model_id AND m.model_type='chat')",
                [],
            )?;
            Ok(provider_id)
        })?;
        Ok(written.value)
    }

    /// Deletes a provider; its endpoints, models and role bindings cascade.
    /// # Errors
    /// Returns `NotFound` for an unknown id, or storage errors.
    pub fn ai_provider_delete(&self, id: &str) -> Result<(), Error> {
        self.write(WriteOrigin::Ui, |w| {
            if w.tx.execute("DELETE FROM ai_providers WHERE id=?1", [id])? == 0 {
                return Err(not_found(Entity::AiProvider, id));
            }
            Ok(())
        })?;
        Ok(())
    }

    /// Reads what probe, chat and key reveal need from a saved endpoint.
    /// # Errors
    /// Returns `NotFound` for an unknown id, or storage errors.
    pub fn ai_endpoint_secret(&self, endpoint_id: &str) -> Result<AiEndpointSecret, Error> {
        self.read(|conn| endpoint_secret(conn, endpoint_id))
    }

    /// Returns both roles; unbound `writing` follows `chat` with `is_fallback`.
    /// # Errors
    /// Returns storage errors.
    pub fn ai_roles(&self) -> Result<Vec<AiRoleRow>, Error> {
        self.read(|conn| {
            let chat = role_binding(conn, AiRole::Chat)?;
            let writing = role_binding(conn, AiRole::Writing)?;
            let is_fallback = writing.is_none() && chat.is_some();
            Ok(vec![
                AiRoleRow {
                    role: AiRole::Chat,
                    binding: chat.clone(),
                    is_fallback: false,
                },
                AiRoleRow {
                    role: AiRole::Writing,
                    binding: writing.or(chat),
                    is_fallback,
                },
            ])
        })
    }

    /// Binds a role to a saved chat model, or unbinds it with `None`.
    /// # Errors
    /// Returns `NotFound` for an unknown model, `InvalidInput` for a non-chat
    /// model, or storage errors.
    pub fn ai_role_set(&self, role: AiRole, binding: Option<AiModelRef>) -> Result<(), Error> {
        self.write(WriteOrigin::Ui, |w| {
            let Some(binding) = binding else {
                w.tx.execute("DELETE FROM ai_roles WHERE role=?1", [role])?;
                return Ok(());
            };
            if model_type(&w.tx, &binding)? != AiModelType::Chat {
                return Err(Error::invalid("binding", "model is not a chat model"));
            }
            w.tx.execute(
                "INSERT INTO ai_roles(role,endpoint_id,model_id) VALUES(?1,?2,?3) ON CONFLICT(role) DO UPDATE SET endpoint_id=excluded.endpoint_id,model_id=excluded.model_id",
                params![role, binding.endpoint_id, binding.model_id],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    /// Picks the endpoint and model id for a call: `model` wins, then `role`
    /// (default `chat`, `writing` falling back to `chat`).
    /// # Errors
    /// Returns `InvalidInput` on field `ai.role` when nothing is bound,
    /// `NotFound` for an unknown model, or storage errors.
    pub fn ai_resolve(
        &self,
        role: Option<AiRole>,
        model: Option<&AiModelRef>,
    ) -> Result<(AiEndpointSecret, String), Error> {
        self.read(|conn| {
            let chosen = match model {
                Some(model) => model.clone(),
                None => {
                    let role = role.unwrap_or(AiRole::Chat);
                    let bound = match role_binding(conn, role)? {
                        None if role == AiRole::Writing => role_binding(conn, AiRole::Chat)?,
                        bound => bound,
                    };
                    bound.ok_or_else(|| Error::invalid("ai.role", "not configured"))?
                }
            };
            model_type(conn, &chosen)?;
            Ok((endpoint_secret(conn, &chosen.endpoint_id)?, chosen.model_id))
        })
    }

    /// Saved context window of a model, if known.
    /// # Errors
    /// Returns storage errors.
    pub fn ai_context_window(
        &self,
        endpoint_id: &str,
        model_id: &str,
    ) -> Result<Option<u32>, Error> {
        self.read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT context_window FROM ai_models WHERE endpoint_id=?1 AND model_id=?2",
                    [endpoint_id, model_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten())
        })
    }
}

/// A saved chat turn's author.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiMessageRole {
    User,
    Assistant,
}
text_enum!(AiMessageRole {
    User = "user",
    Assistant = "assistant",
});

/// How an assistant turn ended; user turns are always `done`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiMessageStatus {
    Done,
    Failed,
    Interrupted,
}
text_enum!(AiMessageStatus {
    Done = "done",
    Failed = "failed",
    Interrupted = "interrupted",
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStoredMessage {
    pub id: String,
    pub role: AiMessageRole,
    pub content: String,
    pub status: AiMessageStatus,
    pub model_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConversation {
    pub id: String,
    pub title: String,
    pub messages: Vec<AiStoredMessage>,
}

const TITLE_CHARS: usize = 40;
const CONVERSATIONS_LIMIT: i64 = 200;

impl Library {
    /// Recent conversations, newest first.
    /// # Errors
    /// Returns storage errors.
    pub fn ai_conversations(&self) -> Result<Vec<AiConversationSummary>, Error> {
        self.read(|conn| {
            Ok(conn
                .prepare("SELECT id,title,updated_at FROM ai_conversations ORDER BY updated_at DESC,id LIMIT ?1")?
                .query_map([CONVERSATIONS_LIMIT], |r| {
                    Ok(AiConversationSummary { id: r.get(0)?, title: r.get(1)?, updated_at: r.get(2)? })
                })?
                .collect::<rusqlite::Result<_>>()?)
        })
    }

    /// One conversation with all its messages in order.
    /// # Errors
    /// Returns `NotFound` for an unknown id, or storage errors.
    pub fn ai_conversation(&self, id: &str) -> Result<AiConversation, Error> {
        self.read(|conn| {
            let title: String = conn
                .query_row(
                    "SELECT title FROM ai_conversations WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| not_found(Entity::AiConversation, id))?;
            Ok(AiConversation {
                id: id.to_owned(),
                title,
                messages: messages(conn, id)?,
            })
        })
    }

    /// Deletes a conversation and its messages.
    /// # Errors
    /// Returns `NotFound` for an unknown id, or storage errors.
    pub fn ai_conversation_delete(&self, id: &str) -> Result<(), Error> {
        self.write(WriteOrigin::Ui, |w| {
            if w.tx
                .execute("DELETE FROM ai_conversations WHERE id=?1", [id])?
                == 0
            {
                return Err(not_found(Entity::AiConversation, id));
            }
            Ok(())
        })?;
        Ok(())
    }

    /// Opens a turn in one transaction: creates the conversation when `id` is
    /// `None` and stores `content` as a user message, or with `regenerate`
    /// drops the trailing assistant message and re-answers the last user one.
    /// Returns the conversation id and the `done` history to send.
    /// # Errors
    /// Returns `InvalidInput` for empty content or nothing to regenerate,
    /// `NotFound` for an unknown id, or storage errors.
    pub fn ai_chat_begin(
        &self,
        id: Option<&str>,
        content: &str,
        regenerate: bool,
        now: i64,
    ) -> Result<(String, Vec<(AiMessageRole, String)>), Error> {
        let content = content.trim();
        if !regenerate && content.is_empty() {
            return Err(Error::invalid("content", "must not be empty"));
        }
        let written = self.write(WriteOrigin::Ui, |w| {
            let tx = &w.tx;
            let id = match id {
                Some(id) => {
                    if tx.execute("UPDATE ai_conversations SET updated_at=?2 WHERE id=?1", params![id, now])? == 0 {
                        return Err(not_found(Entity::AiConversation, id));
                    }
                    id.to_owned()
                }
                None if regenerate => return Err(Error::invalid("conversationId", "required to regenerate")),
                None => {
                    let id = new_id(w.ids.as_ref(), w.now, tx)?;
                    tx.execute(
                        "INSERT INTO ai_conversations(id,title,created_at,updated_at) VALUES(?1,?2,?3,?3)",
                        params![id, title_of(content), now],
                    )?;
                    id
                }
            };
            if regenerate {
                tx.execute(
                    "DELETE FROM ai_messages WHERE conversation_id=?1 AND role='assistant' AND seq=(SELECT MAX(seq) FROM ai_messages WHERE conversation_id=?1)",
                    [&id],
                )?;
                let last: Option<String> = tx
                    .query_row(
                        "SELECT role FROM ai_messages WHERE conversation_id=?1 ORDER BY seq DESC LIMIT 1",
                        [&id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if last.as_deref() != Some("user") {
                    return Err(Error::invalid("regenerate", "no user message to answer"));
                }
            } else {
                insert_message(w, &id, AiMessageRole::User, content, AiMessageStatus::Done, None, now)?;
            }
            let history = messages(tx, &id)?
                .into_iter()
                .filter(|m| m.status == AiMessageStatus::Done)
                .map(|m| (m.role, m.content))
                .collect();
            Ok((id, history))
        })?;
        Ok(written.value)
    }

    /// Stores how the assistant turn ended and bumps the conversation.
    /// # Errors
    /// Returns `NotFound` for an unknown id, or storage errors.
    pub fn ai_chat_finish(
        &self,
        id: &str,
        status: AiMessageStatus,
        content: &str,
        model_id: &str,
        now: i64,
    ) -> Result<(), Error> {
        self.write(WriteOrigin::Ui, |w| {
            if w.tx.execute(
                "UPDATE ai_conversations SET updated_at=?2 WHERE id=?1",
                params![id, now],
            )? == 0
            {
                return Err(not_found(Entity::AiConversation, id));
            }
            insert_message(
                w,
                id,
                AiMessageRole::Assistant,
                content,
                status,
                Some(model_id),
                now,
            )
        })?;
        Ok(())
    }
}

/// First user message, whitespace collapsed, cut to `TITLE_CHARS`.
fn title_of(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(TITLE_CHARS)
        .collect()
}

fn messages(conn: &Connection, id: &str) -> Result<Vec<AiStoredMessage>, Error> {
    Ok(conn
        .prepare("SELECT id,role,content,status,model_id,created_at FROM ai_messages WHERE conversation_id=?1 ORDER BY seq")?
        .query_map([id], |r| {
            Ok(AiStoredMessage {
                id: r.get(0)?,
                role: r.get(1)?,
                content: r.get(2)?,
                status: r.get(3)?,
                model_id: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn insert_message(
    w: &crate::write::WriteTx<'_>,
    conversation: &str,
    role: AiMessageRole,
    content: &str,
    status: AiMessageStatus,
    model_id: Option<&str>,
    now: i64,
) -> Result<(), Error> {
    let id = new_id(w.ids.as_ref(), w.now, &w.tx)?;
    w.tx.execute(
        "INSERT INTO ai_messages(id,conversation_id,seq,role,content,status,model_id,created_at) VALUES(?1,?2,(SELECT COALESCE(MAX(seq),0)+1 FROM ai_messages WHERE conversation_id=?2),?3,?4,?5,?6,?7)",
        params![id, conversation, role, content, status, model_id, now],
    )?;
    Ok(())
}

/// Keeps the newest turns that fit `budget_tokens` (bytes / 4), always the last one.
#[must_use]
pub fn ai_trim_history(
    history: Vec<(AiMessageRole, String)>,
    budget_tokens: usize,
) -> Vec<(AiMessageRole, String)> {
    let mut used = 0;
    let mut kept: Vec<_> = history
        .into_iter()
        .rev()
        .enumerate()
        .take_while(|(index, (_, text))| {
            used += text.len() / 4 + 1;
            *index == 0 || used <= budget_tokens
        })
        .map(|(_, turn)| turn)
        .collect();
    kept.reverse();
    kept
}

fn not_found(entity: Entity, id: &str) -> Error {
    Error::NotFound {
        entity,
        id: id.to_owned(),
    }
}

fn validate(input: &AiProviderInput) -> Result<(), Error> {
    let name = input.name.trim().chars().count();
    if name == 0 || name > 80 {
        return Err(Error::invalid("name", "must be 1-80 characters"));
    }
    if input.endpoints.len() > MAX_ENDPOINTS {
        return Err(Error::invalid("endpoints", "too many endpoints"));
    }
    let (mut slugs, mut ids) = (HashSet::new(), HashSet::new());
    for endpoint in &input.endpoints {
        let slug = endpoint.slug.trim();
        let slug_len = slug.chars().count();
        if slug_len == 0 || slug_len > 40 {
            return Err(Error::invalid("slug", "must be 1-40 characters"));
        }
        if !slugs.insert(slug) {
            return Err(Error::invalid("slug", "must be unique"));
        }
        if let Some(id) = &endpoint.id
            && !ids.insert(id.as_str())
        {
            return Err(Error::invalid("endpoints", "duplicate endpoint id"));
        }
        let url = endpoint.base_url.trim();
        let host = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"));
        if url.len() > 2048 || host.is_none_or(str::is_empty) {
            return Err(Error::invalid("baseUrl", "must be an http(s) URL"));
        }
        if endpoint.models.len() > MAX_MODELS {
            return Err(Error::invalid("models", "too many models"));
        }
        let mut models = HashSet::new();
        for model in &endpoint.models {
            if model.id.trim().is_empty() {
                return Err(Error::invalid("models", "model id is empty"));
            }
            if !models.insert(model.id.as_str()) {
                return Err(Error::invalid("models", "duplicate model id"));
            }
        }
    }
    Ok(())
}

/// Upserts the given models and deletes the rest, so bindings to kept models survive.
fn replace_models(conn: &Connection, endpoint_id: &str, models: &[AiModel]) -> Result<(), Error> {
    let wanted: HashSet<&str> = models.iter().map(|m| m.id.as_str()).collect();
    let existing = conn
        .prepare("SELECT model_id FROM ai_models WHERE endpoint_id=?1")?
        .query_map([endpoint_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in existing.iter().filter(|id| !wanted.contains(id.as_str())) {
        conn.execute(
            "DELETE FROM ai_models WHERE endpoint_id=?1 AND model_id=?2",
            [endpoint_id, id],
        )?;
    }
    let mut upsert = conn.prepare(
        "INSERT INTO ai_models(endpoint_id,model_id,model_type,type_source,context_window,can_vision,position) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(endpoint_id,model_id) DO UPDATE SET model_type=excluded.model_type,type_source=excluded.type_source,context_window=excluded.context_window,can_vision=excluded.can_vision,position=excluded.position",
    )?;
    for (position, model) in (0_i64..).zip(models) {
        upsert.execute(params![
            endpoint_id,
            model.id,
            model.model_type,
            model.type_source,
            model.context_window,
            model.can_vision,
            position
        ])?;
    }
    Ok(())
}

fn endpoint_secret(conn: &Connection, id: &str) -> Result<AiEndpointSecret, Error> {
    conn.query_row(
        "SELECT base_url,protocol,key_ciphertext FROM ai_endpoints WHERE id=?1",
        [id],
        |r| {
            Ok(AiEndpointSecret {
                endpoint_id: id.to_owned(),
                base_url: r.get(0)?,
                protocol: r.get(1)?,
                key_ciphertext: r.get(2)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| not_found(Entity::AiEndpoint, id))
}

fn role_binding(conn: &Connection, role: AiRole) -> Result<Option<AiModelRef>, Error> {
    Ok(conn
        .query_row(
            "SELECT endpoint_id,model_id FROM ai_roles WHERE role=?1",
            [role],
            |r| {
                Ok(AiModelRef {
                    endpoint_id: r.get(0)?,
                    model_id: r.get(1)?,
                })
            },
        )
        .optional()?)
}

fn model_type(conn: &Connection, model: &AiModelRef) -> Result<AiModelType, Error> {
    conn.query_row(
        "SELECT model_type FROM ai_models WHERE endpoint_id=?1 AND model_id=?2",
        [&model.endpoint_id, &model.model_id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| not_found(Entity::AiModel, &model.model_id))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "a failed unwrap or panic is a failed test"
)]
mod tests {
    use super::*;

    fn library() -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(&dir.path().join("library.db")).unwrap();
        (dir, lib)
    }

    fn model(id: &str, model_type: AiModelType) -> AiModel {
        AiModel {
            id: id.to_owned(),
            model_type,
            type_source: AiTypeSource::Inferred,
            context_window: Some(128_000),
            can_vision: false,
        }
    }

    fn endpoint(slug: &str, key: KeyChange, models: Vec<AiModel>) -> AiEndpointInput {
        AiEndpointInput {
            id: None,
            slug: slug.to_owned(),
            base_url: "https://api.example.com".to_owned(),
            protocol: AiProtocol::OpenaiChat,
            key,
            models,
        }
    }

    fn provider(endpoints: Vec<AiEndpointInput>) -> AiProviderInput {
        AiProviderInput {
            id: None,
            name: "  Example  ".to_owned(),
            endpoints,
        }
    }

    /// Re-submits the saved provider as input, keeping ids.
    fn resubmit(row: &AiProviderRow) -> AiProviderInput {
        AiProviderInput {
            id: Some(row.id.clone()),
            name: row.name.clone(),
            endpoints: row
                .endpoints
                .iter()
                .map(|e| AiEndpointInput {
                    id: Some(e.id.clone()),
                    slug: e.slug.clone(),
                    base_url: e.base_url.clone(),
                    protocol: e.protocol,
                    key: KeyChange::Keep,
                    models: e.models.clone(),
                })
                .collect(),
        }
    }

    fn chat_ref(row: &AiProviderRow, endpoint: usize, model: &str) -> AiModelRef {
        AiModelRef {
            endpoint_id: row.endpoints[endpoint].id.clone(),
            model_id: model.to_owned(),
        }
    }

    #[test]
    fn save_list_delete_roundtrip() {
        let (_dir, lib) = library();
        let input = provider(vec![
            endpoint(
                "main",
                KeyChange::Set(vec![1, 2, 3]),
                vec![
                    model("gpt-4o", AiModelType::Chat),
                    model("text-embedding-3", AiModelType::Embedding),
                ],
            ),
            endpoint("backup", KeyChange::Keep, vec![]),
        ]);
        let id = lib.ai_provider_save(input, 10).unwrap();
        let listed = lib.ai_providers().unwrap();
        assert_eq!(listed.len(), 1);
        let row = &listed[0];
        assert_eq!(
            (row.id.as_str(), row.name.as_str()),
            (id.as_str(), "Example")
        );
        let slugs: Vec<_> = row.endpoints.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(slugs, ["main", "backup"]);
        let main = &row.endpoints[0];
        assert_eq!(main.provider_id, id);
        assert_eq!(main.key_ciphertext.as_deref(), Some(&[1, 2, 3][..]));
        assert_eq!(
            main.models[1],
            model("text-embedding-3", AiModelType::Embedding)
        );

        let second = lib.ai_provider_save(provider(vec![]), 11).unwrap();
        let order: Vec<_> = lib
            .ai_providers()
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(order, [id.clone(), second]);

        lib.ai_provider_delete(&id).unwrap();
        assert_eq!(lib.ai_providers().unwrap().len(), 1);
        assert!(matches!(
            lib.ai_provider_delete(&id),
            Err(Error::NotFound {
                entity: Entity::AiProvider,
                ..
            })
        ));
        let count: i64 = lib
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_models", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn endpoint_removal_cascades_models_and_role() {
        let (_dir, lib) = library();
        lib.ai_provider_save(
            provider(vec![
                endpoint("a", KeyChange::Keep, vec![model("m1", AiModelType::Chat)]),
                endpoint("b", KeyChange::Keep, vec![model("m2", AiModelType::Chat)]),
            ]),
            1,
        )
        .unwrap();
        let row = lib.ai_providers().unwrap().remove(0);
        lib.ai_role_set(AiRole::Chat, Some(chat_ref(&row, 0, "m1")))
            .unwrap();
        lib.ai_role_set(AiRole::Writing, Some(chat_ref(&row, 1, "m2")))
            .unwrap();

        // Updating with unchanged models keeps bindings.
        lib.ai_provider_save(resubmit(&row), 2).unwrap();
        let roles = lib.ai_roles().unwrap();
        assert_eq!(roles[0].binding, Some(chat_ref(&row, 0, "m1")));

        let mut input = resubmit(&row);
        input.endpoints.remove(0);
        lib.ai_provider_save(input, 3).unwrap();
        let after = lib.ai_providers().unwrap().remove(0);
        assert_eq!(after.endpoints.len(), 1);
        let roles = lib.ai_roles().unwrap();
        assert_eq!(roles[0].binding, None);
        assert_eq!(roles[1].binding, Some(chat_ref(&row, 1, "m2")));
        assert!(!roles[1].is_fallback);
        assert!(matches!(
            lib.ai_endpoint_secret(&row.endpoints[0].id),
            Err(Error::NotFound {
                entity: Entity::AiEndpoint,
                ..
            })
        ));
    }

    #[test]
    fn key_change_keep_clear_set() {
        let (_dir, lib) = library();
        lib.ai_provider_save(
            provider(vec![endpoint("a", KeyChange::Set(vec![9]), vec![])]),
            1,
        )
        .unwrap();
        let row = lib.ai_providers().unwrap().remove(0);
        let key = |lib: &Library| {
            lib.ai_endpoint_secret(&row.endpoints[0].id)
                .unwrap()
                .key_ciphertext
        };
        let save = |change: KeyChange| {
            let mut input = resubmit(&row);
            input.endpoints[0].key = change;
            lib.ai_provider_save(input, 2).unwrap();
        };
        save(KeyChange::Keep);
        assert_eq!(key(&lib), Some(vec![9]));
        save(KeyChange::Set(vec![7, 7]));
        assert_eq!(key(&lib), Some(vec![7, 7]));
        save(KeyChange::Clear);
        assert_eq!(key(&lib), None);
        let secret = lib.ai_endpoint_secret(&row.endpoints[0].id).unwrap();
        assert_eq!(secret.base_url, "https://api.example.com");
        assert_eq!(secret.protocol, AiProtocol::OpenaiChat);
    }

    #[test]
    fn roles_require_saved_chat_model_and_writing_falls_back() {
        let (_dir, lib) = library();
        lib.ai_provider_save(
            provider(vec![endpoint(
                "a",
                KeyChange::Keep,
                vec![
                    model("chat", AiModelType::Chat),
                    model("emb", AiModelType::Embedding),
                ],
            )]),
            1,
        )
        .unwrap();
        let row = lib.ai_providers().unwrap().remove(0);
        let roles = lib.ai_roles().unwrap();
        assert!(roles.iter().all(|r| r.binding.is_none() && !r.is_fallback));
        assert!(matches!(
            lib.ai_resolve(None, None),
            Err(Error::InvalidInput {
                field: "ai.role",
                ..
            })
        ));

        assert!(matches!(
            lib.ai_role_set(AiRole::Chat, Some(chat_ref(&row, 0, "emb"))),
            Err(Error::InvalidInput {
                field: "binding",
                ..
            })
        ));
        assert!(matches!(
            lib.ai_role_set(AiRole::Chat, Some(chat_ref(&row, 0, "missing"))),
            Err(Error::NotFound {
                entity: Entity::AiModel,
                ..
            })
        ));

        lib.ai_role_set(AiRole::Chat, Some(chat_ref(&row, 0, "chat")))
            .unwrap();
        let roles = lib.ai_roles().unwrap();
        assert_eq!(roles[1].role, AiRole::Writing);
        assert_eq!(roles[1].binding, Some(chat_ref(&row, 0, "chat")));
        assert!(roles[1].is_fallback);

        let (secret, model_id) = lib.ai_resolve(Some(AiRole::Writing), None).unwrap();
        assert_eq!(
            (secret.base_url.as_str(), model_id.as_str()),
            ("https://api.example.com", "chat")
        );
        let (_, model_id) = lib
            .ai_resolve(Some(AiRole::Chat), Some(&chat_ref(&row, 0, "emb")))
            .unwrap();
        assert_eq!(model_id, "emb");
        assert!(matches!(
            lib.ai_resolve(None, Some(&chat_ref(&row, 0, "missing"))),
            Err(Error::NotFound { .. })
        ));

        // Retyping the bound model away from chat drops the binding.
        let mut input = resubmit(&row);
        input.endpoints[0].models[0].model_type = AiModelType::Image;
        lib.ai_provider_save(input, 2).unwrap();
        assert!(lib.ai_roles().unwrap()[0].binding.is_none());

        lib.ai_role_set(AiRole::Chat, None).unwrap();
    }

    #[test]
    fn validation_rejects_bad_input() {
        let (_dir, lib) = library();
        let field = |input: AiProviderInput| match lib.ai_provider_save(input, 1) {
            Err(Error::InvalidInput { field, .. }) => field,
            other => panic!("expected invalid input, got {:?}", other.map(|_| ())),
        };
        let mut blank = provider(vec![]);
        blank.name = "   ".to_owned();
        assert_eq!(field(blank), "name");
        let dup = vec![
            endpoint("a", KeyChange::Keep, vec![]),
            endpoint(" a ", KeyChange::Keep, vec![]),
        ];
        assert_eq!(field(provider(dup)), "slug");
        let mut url = endpoint("a", KeyChange::Keep, vec![]);
        url.base_url = "ftp://x".to_owned();
        assert_eq!(field(provider(vec![url])), "baseUrl");
        let models = vec![model("m", AiModelType::Chat), model("m", AiModelType::Chat)];
        assert_eq!(
            field(provider(vec![endpoint("a", KeyChange::Keep, models)])),
            "models"
        );
        let many = (0..21)
            .map(|i| endpoint(&format!("e{i}"), KeyChange::Keep, vec![]))
            .collect();
        assert_eq!(field(provider(many)), "endpoints");
        assert!(lib.ai_providers().unwrap().is_empty());

        let mut unknown = provider(vec![]);
        unknown.id = Some("nope".to_owned());
        assert!(matches!(
            lib.ai_provider_save(unknown, 1),
            Err(Error::NotFound {
                entity: Entity::AiProvider,
                ..
            })
        ));
    }

    #[test]
    fn slugs_can_swap_between_endpoints() {
        let (_dir, lib) = library();
        lib.ai_provider_save(
            provider(vec![
                endpoint("a", KeyChange::Keep, vec![]),
                endpoint("b", KeyChange::Keep, vec![]),
            ]),
            1,
        )
        .unwrap();
        let row = lib.ai_providers().unwrap().remove(0);
        let mut input = resubmit(&row);
        input.endpoints[0].slug = "b".to_owned();
        input.endpoints[1].slug = "a".to_owned();
        lib.ai_provider_save(input, 2).unwrap();
        let slugs: Vec<_> = lib
            .ai_providers()
            .unwrap()
            .remove(0)
            .endpoints
            .into_iter()
            .map(|e| e.slug)
            .collect();
        assert_eq!(slugs, ["b", "a"]);
    }

    #[test]
    fn migration_applies_on_existing_v4_library() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.db");
        let lib = Library::open(&path).unwrap();
        lib.conn
            .lock()
            .unwrap()
            .execute_batch(
                "DROP TABLE ai_messages; DROP TABLE ai_conversations;
                 DROP TABLE ai_roles; DROP TABLE ai_models; DROP TABLE ai_endpoints; DROP TABLE ai_providers;
                 DELETE FROM schema_migrations WHERE version IN (5,6);
                 INSERT INTO app_meta(key,value) VALUES('kept','yes');",
            )
            .unwrap();
        assert_eq!(lib.schema_version().unwrap(), 4);
        drop(lib);
        let lib = Library::open(&path).unwrap();
        assert_eq!(lib.schema_version().unwrap(), 6);
        lib.ai_chat_begin(None, "hi", false, 1).unwrap();
        lib.ai_provider_save(provider(vec![]), 1).unwrap();
        assert_eq!(lib.ai_providers().unwrap().len(), 1);
        let kept: String = lib
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT value FROM app_meta WHERE key='kept'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, "yes");
        drop(lib);
        assert_eq!(Library::open(&path).unwrap().schema_version().unwrap(), 6);
    }

    fn roles(lib: &Library, id: &str) -> Vec<(AiMessageRole, AiMessageStatus)> {
        lib.ai_conversation(id)
            .unwrap()
            .messages
            .iter()
            .map(|m| (m.role, m.status))
            .collect()
    }

    #[test]
    fn first_send_creates_conversation_with_collapsed_title() {
        let (_dir, lib) = library();
        let long = format!("  hello\n\n  {}", "x".repeat(60));
        let (id, history) = lib.ai_chat_begin(None, &long, false, 10).unwrap();
        let title = &lib.ai_conversations().unwrap()[0].title;
        assert_eq!(title.chars().count(), TITLE_CHARS);
        assert!(title.starts_with("hello xxx"));
        assert_eq!(history, vec![(AiMessageRole::User, long.trim().to_owned())]);
        assert!(lib.ai_chat_begin(None, "   ", false, 11).is_err());
        assert!(matches!(
            lib.ai_chat_begin(Some("missing"), "hi", false, 11),
            Err(Error::NotFound {
                entity: Entity::AiConversation,
                ..
            })
        ));
        assert_eq!(lib.ai_conversation(&id).unwrap().messages.len(), 1);
    }

    #[test]
    fn failed_and_interrupted_turns_stay_out_of_history() {
        let (_dir, lib) = library();
        let (id, _) = lib.ai_chat_begin(None, "one", false, 1).unwrap();
        lib.ai_chat_finish(&id, AiMessageStatus::Failed, "503: busy", "m", 2)
            .unwrap();
        let (_, history) = lib.ai_chat_begin(Some(&id), "two", false, 3).unwrap();
        assert_eq!(
            history,
            vec![
                (AiMessageRole::User, "one".to_owned()),
                (AiMessageRole::User, "two".to_owned())
            ]
        );
        lib.ai_chat_finish(&id, AiMessageStatus::Interrupted, "partial", "m", 4)
            .unwrap();
        let (_, history) = lib.ai_chat_begin(Some(&id), "three", false, 5).unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(lib.ai_conversations().unwrap()[0].updated_at, 5);
    }

    #[test]
    fn regenerate_replaces_only_the_last_assistant_turn() {
        let (_dir, lib) = library();
        let (id, _) = lib.ai_chat_begin(None, "q1", false, 1).unwrap();
        lib.ai_chat_finish(&id, AiMessageStatus::Done, "a1", "m", 2)
            .unwrap();
        lib.ai_chat_begin(Some(&id), "q2", false, 3).unwrap();
        lib.ai_chat_finish(&id, AiMessageStatus::Done, "a2", "m", 4)
            .unwrap();
        let (_, history) = lib.ai_chat_begin(Some(&id), "", true, 5).unwrap();
        assert_eq!(
            history.last(),
            Some(&(AiMessageRole::User, "q2".to_owned()))
        );
        assert_eq!(history.len(), 3);
        assert_eq!(
            roles(&lib, &id),
            vec![
                (AiMessageRole::User, AiMessageStatus::Done),
                (AiMessageRole::Assistant, AiMessageStatus::Done),
                (AiMessageRole::User, AiMessageStatus::Done),
            ]
        );
        assert!(lib.ai_chat_begin(None, "", true, 6).is_err());
    }

    #[test]
    fn delete_cascades_messages() {
        let (_dir, lib) = library();
        let (id, _) = lib.ai_chat_begin(None, "q", false, 1).unwrap();
        lib.ai_chat_finish(&id, AiMessageStatus::Done, "a", "m", 2)
            .unwrap();
        lib.ai_conversation_delete(&id).unwrap();
        let left: i64 = lib
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
        assert!(lib.ai_conversation_delete(&id).is_err());
    }

    #[test]
    fn trimming_drops_oldest_but_keeps_the_latest_turn() {
        let turn = |text: &str| (AiMessageRole::User, text.to_owned());
        let history = vec![turn(&"a".repeat(400)), turn(&"b".repeat(400)), turn("c")];
        assert_eq!(
            ai_trim_history(history.clone(), 110),
            vec![history[1].clone(), history[2].clone()]
        );
        assert_eq!(ai_trim_history(vec![turn(&"z".repeat(4000))], 1).len(), 1);
    }
}
