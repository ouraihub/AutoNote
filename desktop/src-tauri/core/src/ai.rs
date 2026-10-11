//! AutoNote AI wire types, product role settings and conversation storage.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::error::{Entity, Error};
use crate::write::{WriteOrigin, new_id};

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
