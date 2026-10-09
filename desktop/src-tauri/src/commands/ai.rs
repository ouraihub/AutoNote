//! AI model service commands (23 §3). Keys are encrypted here with DPAPI before
//! they reach core, and decrypted only for the probe, chat or reveal that needs them.
use std::sync::Arc;
use std::sync::atomic::Ordering;

use note_core::ai::{
    AiConversation, AiConversationSummary, AiEndpointInput, AiEndpointRow, AiEndpointSecret,
    AiMessageRole, AiMessageStatus, AiModel, AiModelRef, AiProtocol, AiProviderInput,
    AiProviderRow, AiRole, KeyChange,
};
use note_core::{AppError, ErrorCode, Library, parse_input};
use note_sync::SecretStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use zeroize::Zeroizing;

use super::{Ok, ok, run};
use crate::AppContext;

type Ctx<'a> = tauri::State<'a, AppContext>;

const KEY_MAX_LEN: usize = 4096;
const CONTENT_MAX_BYTES: usize = 256 * 1024;
const NOTE_MAX_CHARS: usize = 24_000;
const NOTE_TITLE_MAX_CHARS: usize = 200;
const DEFAULT_CONTEXT_TOKENS: u32 = 32_000;
const DEFAULT_REPLY_TOKENS: u32 = 4096;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpoint {
    id: String,
    slug: String,
    base_url: String,
    protocol: AiProtocol,
    key_masked: Option<String>,
    probe_url: String,
    models: Vec<AiModel>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    id: String,
    name: String,
    endpoints: Vec<AiEndpoint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundModel {
    endpoint_id: String,
    model_id: String,
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRoleBinding {
    role: AiRole,
    binding: Option<BoundModel>,
    is_fallback: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EndpointSave {
    id: Option<String>,
    slug: String,
    base_url: String,
    protocol: AiProtocol,
    api_key: Option<String>,
    models: Vec<AiModel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderSave {
    id: Option<String>,
    name: String,
    endpoints: Vec<EndpointSave>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoteContext {
    title: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatArgs {
    conversation_id: Option<String>,
    #[serde(default)]
    content: String,
    #[serde(default)]
    regenerate: bool,
    role: Option<AiRole>,
    model: Option<AiModelRef>,
    note: Option<NoteContext>,
    max_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AiWriteAction {
    Polish,
    Rewrite,
    Shorten,
    Expand,
    Continue,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteArgs {
    action: AiWriteAction,
    text: String,
    context: Option<String>,
    language: Option<String>,
    note_title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    model: AiModelRef,
    is_fallback: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStarted {
    conversation_id: String,
}

#[derive(Serialize)]
pub struct RevealedKey {
    key: String,
}

fn secrets() -> autonote_shell::credentials::DpapiSecretStore {
    autonote_shell::credentials::DpapiSecretStore
}

fn internal(message: &'static str) -> AppError {
    AppError::new(ErrorCode::Internal, message)
}

/// Keeps the first and last four characters; short keys are fully masked.
fn mask(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "*".repeat(chars.len().max(4));
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}{}{tail}", "*".repeat(chars.len() - 8))
}

fn decrypt(ciphertext: &[u8]) -> Result<Zeroizing<String>, AppError> {
    let plain = Zeroizing::new(secrets().unprotect(ciphertext)?);
    String::from_utf8(plain.to_vec())
        .map(Zeroizing::new)
        .map_err(|_| internal("Stored key is unreadable"))
}

fn endpoint_dto(row: AiEndpointRow) -> AiEndpoint {
    let key_masked = row
        .key_ciphertext
        .as_deref()
        .map(|ciphertext| decrypt(ciphertext).map_or_else(|_| "****".to_owned(), |key| mask(&key)));
    AiEndpoint {
        probe_url: note_ai::probe_url(&row.base_url),
        id: row.id,
        slug: row.slug,
        base_url: row.base_url,
        protocol: row.protocol,
        key_masked,
        models: row.models,
    }
}

fn provider_dtos(rows: Vec<AiProviderRow>) -> Vec<AiProvider> {
    rows.into_iter()
        .map(|row| AiProvider {
            id: row.id,
            name: row.name,
            endpoints: row.endpoints.into_iter().map(endpoint_dto).collect(),
        })
        .collect()
}

fn role_dtos(library: &Library) -> Result<Vec<AiRoleBinding>, note_core::Error> {
    let providers = library.ai_providers()?;
    let label = |reference: &AiModelRef| {
        providers
            .iter()
            .find_map(|provider| {
                provider
                    .endpoints
                    .iter()
                    .find(|endpoint| endpoint.id == reference.endpoint_id)
                    .map(|endpoint| {
                        format!(
                            "{} · {} · {}",
                            provider.name, endpoint.slug, reference.model_id
                        )
                    })
            })
            .unwrap_or_else(|| reference.model_id.clone())
    };
    Ok(library
        .ai_roles()?
        .into_iter()
        .map(|row| AiRoleBinding {
            role: row.role,
            binding: row.binding.map(|binding| BoundModel {
                label: label(&binding),
                endpoint_id: binding.endpoint_id,
                model_id: binding.model_id,
            }),
            is_fallback: row.is_fallback,
        })
        .collect())
}

fn key_change(api_key: Option<String>) -> Result<KeyChange, AppError> {
    let Some(key) = api_key.map(Zeroizing::new) else {
        return Ok(KeyChange::Keep);
    };
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Ok(KeyChange::Clear);
    }
    if trimmed.len() > KEY_MAX_LEN {
        return Err(AppError::from(note_core::Error::invalid(
            "apiKey",
            "is too long",
        )));
    }
    Ok(KeyChange::Set(secrets().protect(trimmed.as_bytes())?))
}

async fn secret_for(
    context: &AppContext,
    endpoint_id: String,
) -> Result<AiEndpointSecret, AppError> {
    run("ai_endpoint_secret", context, move |library| {
        library.ai_endpoint_secret(&endpoint_id)
    })
    .await
}

#[tauri::command]
pub async fn ai_providers_list(context: Ctx<'_>) -> Result<Vec<AiProvider>, AppError> {
    run("ai_providers_list", &context, |library| {
        library.ai_providers()
    })
    .await
    .map(provider_dtos)
}

#[tauri::command]
pub async fn ai_provider_save(
    context: Ctx<'_>,
    provider: Value,
) -> Result<Vec<AiProvider>, AppError> {
    let request: ProviderSave = parse_input(provider).map_err(AppError::from)?;
    let endpoints = request
        .endpoints
        .into_iter()
        .map(|endpoint| {
            Ok(AiEndpointInput {
                key: key_change(endpoint.api_key)?,
                id: endpoint.id,
                slug: endpoint.slug,
                base_url: endpoint.base_url,
                protocol: endpoint.protocol,
                models: endpoint.models,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let input = AiProviderInput {
        id: request.id,
        name: request.name,
        endpoints,
    };
    let now = note_mcp::now_millis();
    run("ai_provider_save", &context, move |library| {
        library.ai_provider_save(input, i64::try_from(now).unwrap_or(i64::MAX))?;
        library.ai_providers()
    })
    .await
    .map(provider_dtos)
}

#[tauri::command]
pub async fn ai_provider_delete(context: Ctx<'_>, id: String) -> Result<Ok<()>, AppError> {
    run("ai_provider_delete", &context, move |library| {
        library.ai_provider_delete(&id)
    })
    .await?;
    Ok(ok(()))
}

#[tauri::command]
pub async fn ai_endpoint_key_reveal(context: Ctx<'_>, id: String) -> Result<RevealedKey, AppError> {
    let secret = secret_for(&context, id).await?;
    let ciphertext = secret
        .key_ciphertext
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Key not set"))?;
    let key = decrypt(&ciphertext)?;
    Ok(RevealedKey {
        key: key.to_string(),
    })
}

#[tauri::command]
pub async fn ai_endpoint_probe(
    context: Ctx<'_>,
    id: String,
) -> Result<note_ai::ProbeResult, AppError> {
    let secret = secret_for(&context, id).await?;
    let key = secret.key_ciphertext.as_deref().map(decrypt).transpose()?;
    let result = note_ai::probe(
        &secret.base_url,
        secret.protocol,
        key.as_deref().map(String::as_str),
    )
    .await;
    if let Some(error) = &result.error {
        tracing::warn!(status = error.status, "ai.probe.failed");
    }
    Ok(result)
}

#[tauri::command]
pub async fn ai_roles_get(context: Ctx<'_>) -> Result<Vec<AiRoleBinding>, AppError> {
    run("ai_roles_get", &context, |library| role_dtos(library)).await
}

#[tauri::command]
pub async fn ai_roles_set(
    context: Ctx<'_>,
    role: AiRole,
    binding: Option<Value>,
) -> Result<Vec<AiRoleBinding>, AppError> {
    let binding: Option<AiModelRef> = binding
        .map(parse_input)
        .transpose()
        .map_err(AppError::from)?;
    run("ai_roles_set", &context, move |library| {
        library.ai_role_set(role, binding)?;
        role_dtos(library)
    })
    .await
}

#[tauri::command]
pub async fn ai_conversations_list(
    context: Ctx<'_>,
) -> Result<Vec<AiConversationSummary>, AppError> {
    run("ai_conversations_list", &context, |library| {
        library.ai_conversations()
    })
    .await
}

#[tauri::command]
pub async fn ai_conversation_get(context: Ctx<'_>, id: String) -> Result<AiConversation, AppError> {
    run("ai_conversation_get", &context, move |library| {
        library.ai_conversation(&id)
    })
    .await
}

#[tauri::command]
pub async fn ai_conversation_delete(context: Ctx<'_>, id: String) -> Result<Ok<()>, AppError> {
    run("ai_conversation_delete", &context, move |library| {
        library.ai_conversation_delete(&id)
    })
    .await?;
    Ok(ok(()))
}

impl WriteArgs {
    fn validate(&self) -> Result<(), AppError> {
        let total = self.text.chars().count()
            + self.context.as_deref().map_or(0, |value| value.chars().count());
        if total > NOTE_MAX_CHARS {
            return Err(AppError::from(note_core::Error::invalid(
                "request",
                "text and context are too large",
            )));
        }
        if matches!(self.action, AiWriteAction::Continue)
            && self.context.as_deref().is_none_or(str::is_empty)
        {
            return Err(AppError::from(note_core::Error::invalid(
                "context",
                "is required for continue",
            )));
        }
        if !matches!(self.action, AiWriteAction::Continue) && self.text.is_empty() {
            return Err(AppError::from(note_core::Error::invalid(
                "text",
                "is required",
            )));
        }
        if self
            .language
            .as_deref()
            .is_some_and(|value| value.chars().count() > 100)
        {
            return Err(AppError::from(note_core::Error::invalid(
                "language",
                "is too long",
            )));
        }
        if self
            .note_title
            .as_deref()
            .is_some_and(|value| value.chars().count() > NOTE_TITLE_MAX_CHARS)
        {
            return Err(AppError::from(note_core::Error::invalid(
                "noteTitle",
                "is too long",
            )));
        }
        Ok(())
    }
}

/// Streams a writing action without creating conversation history.
#[tauri::command]
pub async fn ai_write(
    context: Ctx<'_>,
    job_id: String,
    request: Value,
    on_event: Channel<note_ai::ChatEvent>,
) -> Result<Ok<WriteResult>, AppError> {
    let args: WriteArgs = parse_input(request).map_err(AppError::from)?;
    args.validate()?;
    let flag = context.jobs.start(&job_id)?;
    let result = write(&context, args, flag, on_event).await;
    context.jobs.finish(&job_id);
    if let Err(error) = &result {
        tracing::warn!(command = "ai_write", code = error.code().as_str(), "ipc.command.failed");
    }
    result.map(|(model, is_fallback)| ok(WriteResult { model, is_fallback }))
}

fn write_system(action: &AiWriteAction, language: Option<&str>, title: Option<&str>) -> String {
    let action = match action {
        AiWriteAction::Polish => "Polish the text while preserving its meaning.",
        AiWriteAction::Rewrite => "Rewrite the text clearly while preserving its meaning.",
        AiWriteAction::Shorten => "Shorten the text while preserving its key meaning.",
        AiWriteAction::Expand => "Expand the text with useful detail while preserving its meaning.",
        AiWriteAction::Continue => "Continue writing naturally from the provided text and context.",
    };
    let mut prompt = format!("{action} Return only the resulting text, with no preamble or title.");
    if let Some(language) = language {
        prompt.push_str(&format!(" Write in {language}."));
    }
    if let Some(title) = title {
        prompt.push_str(&format!(" The note is titled {title:?}."));
    }
    prompt
}

async fn write(
    context: &AppContext,
    args: WriteArgs,
    flag: Arc<std::sync::atomic::AtomicBool>,
    on_event: Channel<note_ai::ChatEvent>,
) -> Result<(AiModelRef, bool), AppError> {
    let (secret, model_id, is_fallback) = run("ai_resolve", context, move |library| {
        let binding = library
            .ai_roles()?
            .into_iter()
            .find(|row| row.role == AiRole::Writing)
            .ok_or_else(|| note_core::Error::invalid("ai.role", "not configured"))?;
        let (secret, model_id) = library.ai_resolve(Some(AiRole::Writing), binding.binding.as_ref())?;
        Ok((secret, model_id, binding.is_fallback))
    })
    .await?;
    let model = AiModelRef {
        endpoint_id: secret.endpoint_id.clone(),
        model_id: model_id.clone(),
    };
    let ciphertext = secret
        .key_ciphertext
        .ok_or_else(|| AppError::from(note_core::Error::invalid("apiKey", "not configured")))?;
    let key = decrypt(&ciphertext)?;
    let context_text = args.context.as_deref().unwrap_or("");
    let user = if context_text.is_empty() {
        args.text
    } else if args.text.is_empty() {
        format!("Context:\n{context_text}")
    } else {
        format!("Text:\n{}\n\nContext:\n{context_text}", args.text)
    };
    let request = note_ai::ChatRequest {
        messages: vec![
            note_ai::ChatMessage {
                role: note_ai::ChatRole::System,
                content: write_system(
                    &args.action,
                    args.language.as_deref(),
                    args.note_title.as_deref(),
                ),
            },
            note_ai::ChatMessage {
                role: note_ai::ChatRole::User,
                content: user,
            },
        ],
        max_tokens: Some(2048),
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    let watcher = {
        let (cancel, flag) = (cancel.clone(), flag.clone());
        tauri::async_runtime::spawn(async move {
            while !flag.load(Ordering::Relaxed) && !cancel.is_cancelled() {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            cancel.cancel();
        })
    };
    let mut forward = |event| {
        if on_event.send(event).is_err() {
            flag.store(true, Ordering::Relaxed);
        }
    };
    let result = note_ai::chat_stream(
        &secret.base_url,
        secret.protocol,
        &key,
        &model_id,
        &request,
        &cancel,
        &mut forward,
    )
    .await;
    cancel.cancel();
    let _ = watcher.await;
    result.map(|()| (model, is_fallback))
}

/// Streams one reply over `on_event` and stores both turns; `jobs_cancel(jobId)`
/// stops it and keeps the partial text as `interrupted`.
#[tauri::command]
pub async fn ai_chat(
    context: Ctx<'_>,
    job_id: String,
    request: Value,
    on_event: Channel<note_ai::ChatEvent>,
) -> Result<Ok<ChatStarted>, AppError> {
    let args: ChatArgs = parse_input(request).map_err(AppError::from)?;
    if args.content.len() > CONTENT_MAX_BYTES {
        return Err(AppError::from(note_core::Error::invalid(
            "content",
            "too large",
        )));
    }
    let flag = context.jobs.start(&job_id)?;
    let result = chat(&context, args, flag, on_event).await;
    context.jobs.finish(&job_id);
    if let Err(error) = &result {
        tracing::warn!(
            command = "ai_chat",
            code = error.code().as_str(),
            "ipc.command.failed"
        );
    }
    result.map(|conversation_id| ok(ChatStarted { conversation_id }))
}

fn now() -> i64 {
    i64::try_from(note_mcp::now_millis()).unwrap_or(i64::MAX)
}

fn system_prompt(note: Option<NoteContext>) -> Option<String> {
    let note = note?;
    let title: String = note
        .title
        .trim()
        .chars()
        .take(NOTE_TITLE_MAX_CHARS)
        .collect();
    let content: String = note.content.chars().take(NOTE_MAX_CHARS).collect();
    Some(format!(
        "你在协助用户处理笔记《{title}》。以下是笔记当前内容：\n\n{content}"
    ))
}

async fn chat(
    context: &AppContext,
    args: ChatArgs,
    flag: Arc<std::sync::atomic::AtomicBool>,
    on_event: Channel<note_ai::ChatEvent>,
) -> Result<String, AppError> {
    let (role, model) = (args.role, args.model);
    let (secret, model_id, window) = run("ai_resolve", context, move |library| {
        let (secret, model_id) = library.ai_resolve(role, model.as_ref())?;
        let window = library.ai_context_window(&secret.endpoint_id, &model_id)?;
        Ok((secret, model_id, window))
    })
    .await?;
    let ciphertext = secret
        .key_ciphertext
        .ok_or_else(|| AppError::from(note_core::Error::invalid("apiKey", "not configured")))?;
    let key = decrypt(&ciphertext)?;

    let (conversation, content, regenerate) = (args.conversation_id, args.content, args.regenerate);
    let (conversation_id, history) = run("ai_chat_begin", context, move |library| {
        library.ai_chat_begin(conversation.as_deref(), &content, regenerate, now())
    })
    .await?;

    let system = system_prompt(args.note);
    let reply = args.max_tokens.unwrap_or(DEFAULT_REPLY_TOKENS);
    let budget = window
        .unwrap_or(DEFAULT_CONTEXT_TOKENS)
        .saturating_sub(reply) as usize;
    let budget = budget.saturating_sub(system.as_ref().map_or(0, |s| s.len() / 4));
    let mut messages: Vec<note_ai::ChatMessage> = system
        .into_iter()
        .map(|content| note_ai::ChatMessage {
            role: note_ai::ChatRole::System,
            content,
        })
        .collect();
    messages.extend(
        note_core::ai::ai_trim_history(history, budget)
            .into_iter()
            .map(|(role, content)| note_ai::ChatMessage {
                role: match role {
                    AiMessageRole::User => note_ai::ChatRole::User,
                    AiMessageRole::Assistant => note_ai::ChatRole::Assistant,
                },
                content,
            }),
    );
    let request = note_ai::ChatRequest {
        messages,
        max_tokens: args.max_tokens,
    };

    let cancel = tokio_util::sync::CancellationToken::new();
    let watcher = {
        let (cancel, flag) = (cancel.clone(), flag.clone());
        tauri::async_runtime::spawn(async move {
            while !flag.load(Ordering::Relaxed) && !cancel.is_cancelled() {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            cancel.cancel();
        })
    };
    let mut text = String::new();
    let mut forward = |event: note_ai::ChatEvent| {
        if let note_ai::ChatEvent::Delta { text: delta } = &event {
            text.push_str(delta);
        }
        if on_event.send(event).is_err() {
            flag.store(true, Ordering::Relaxed);
        }
    };
    let result = note_ai::chat_stream(
        &secret.base_url,
        secret.protocol,
        &key,
        &model_id,
        &request,
        &cancel,
        &mut forward,
    )
    .await;
    cancel.cancel();
    let _ = watcher.await;

    let (status, stored) = match &result {
        Result::Ok(()) => (AiMessageStatus::Done, text),
        Err(error) if error.code() == ErrorCode::Cancelled => (AiMessageStatus::Interrupted, text),
        Err(error) => (AiMessageStatus::Failed, error.message().to_owned()),
    };
    let id = conversation_id.clone();
    run("ai_chat_finish", context, move |library| {
        library.ai_chat_finish(&id, status, &stored, &model_id, now())
    })
    .await?;
    result.map(|()| conversation_id)
}

#[cfg(test)]
mod tests {
    use super::{AiWriteAction, WriteArgs, mask, write_system};

    #[test]
    fn mask_keeps_only_edges() {
        assert_eq!(mask("sk-abcdefghijkl"), "sk-a*******ijkl");
        assert_eq!(mask("short"), "*****");
        assert!(!mask("sk-0123456789secret").contains("secret"));
    }

    #[test]
    fn write_validates_continue_and_combined_character_limit() {
        let mut request = WriteArgs {
            action: AiWriteAction::Continue,
            text: String::new(),
            context: None,
            language: None,
            note_title: None,
        };
        assert!(request.validate().is_err());
        request.context = Some("上下文".to_owned());
        assert!(request.validate().is_ok());
        request.text = "a".repeat(super::NOTE_MAX_CHARS);
        assert!(request.validate().is_err());
        assert!(write_system(&request.action, None, None).contains("no preamble or title"));
    }
}
