//! AutoNote wire adapters over Aether providers and product-owned role settings.
use std::sync::Arc;
use std::sync::atomic::Ordering;

use aether_providers as providers;
use note_core::ai::{
    AiModel, AiModelRef, AiModelType, AiProtocol, AiRole, AiRoleRow, AiRoleSettings, AiTypeSource,
};
use note_core::{AppError, ErrorCode, parse_input};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Ok, ok, run};
use crate::AppContext;

type Ctx<'a> = tauri::State<'a, AppContext>;

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

#[derive(Serialize)]
pub struct RevealedKey {
    key: String,
}

fn internal(message: &'static str) -> AppError {
    AppError::new(ErrorCode::Internal, message)
}

fn provider_error(error: providers::KitError) -> AppError {
    use providers::KitErrorCode as K;
    let code = match error.code() {
        K::BadRequest | K::NeedsConfig => ErrorCode::BadRequest,
        K::NotFound => ErrorCode::NotFound,
        K::Conflict => ErrorCode::Conflict,
        K::Cancelled => ErrorCode::Cancelled,
        K::Unauthorized => ErrorCode::Unauthenticated,
        K::Forbidden => ErrorCode::Forbidden,
        K::RateLimited => ErrorCode::TooManyAttempts,
        K::Timeout => ErrorCode::RequestTimeout,
        K::Network => ErrorCode::Offline,
        K::BudgetExceeded => ErrorCode::PayloadTooLarge,
        K::Upstream => ErrorCode::InvalidResponse,
        K::Unsupported | K::IncompatibleDb | K::Internal => ErrorCode::Internal,
    };
    AppError::new(code, "AI provider operation failed")
}

async fn provider_call<T: Send + 'static>(
    context: &AppContext,
    f: impl FnOnce(&providers::Store) -> Result<T, providers::KitError> + Send + 'static,
) -> Result<T, AppError> {
    let store = context.providers.clone();
    tauri::async_runtime::spawn_blocking(move || f(&store))
        .await
        .map_err(|_| internal("AI provider task failed"))?
        .map_err(provider_error)
}

macro_rules! enum_adapter {
    ($to:ident, $from:ident, $local:ident, $remote:ident, $($variant:ident),+) => {
        fn $to(value: $local) -> providers::$remote {
            match value { $($local::$variant => providers::$remote::$variant),+ }
        }
        fn $from(value: providers::$remote) -> $local {
            match value { $(providers::$remote::$variant => $local::$variant),+ }
        }
    };
}
enum_adapter!(
    protocol_input,
    protocol_dto,
    AiProtocol,
    Protocol,
    AnthropicMessages,
    OpenaiChat,
    OpenaiResponses
);
enum_adapter!(
    type_input,
    type_dto,
    AiModelType,
    ModelType,
    Chat,
    Image,
    Video,
    Tts,
    Stt,
    Embedding,
    Rerank,
    Unknown
);
enum_adapter!(
    source_input,
    source_dto,
    AiTypeSource,
    TypeSource,
    Inferred,
    User
);

fn model_input(model: AiModel) -> providers::Model {
    providers::Model {
        id: model.id,
        model_type: type_input(model.model_type),
        type_source: source_input(model.type_source),
        context_window: model.context_window,
        can_vision: model.can_vision,
        max_output: None,
        supports_tools: None,
    }
}

fn model_dto(model: providers::Model) -> AiModel {
    AiModel {
        id: model.id,
        model_type: type_dto(model.model_type),
        type_source: source_dto(model.type_source),
        context_window: model.context_window,
        can_vision: model.can_vision,
    }
}

fn provider_input(request: ProviderSave) -> providers::ProviderSave {
    providers::ProviderSave {
        id: request.id,
        name: request.name.trim().to_owned(),
        endpoints: request
            .endpoints
            .into_iter()
            .map(|endpoint| providers::EndpointSave {
                id: endpoint.id,
                slug: endpoint.slug.trim().to_owned(),
                base_url: endpoint.base_url.trim().to_owned(),
                protocol: protocol_input(endpoint.protocol),
                api_key: endpoint.api_key.map(|key| key.trim().to_owned()),
                models: endpoint.models.into_iter().map(model_input).collect(),
            })
            .collect(),
    }
}

fn provider_dtos(rows: Vec<providers::Provider>) -> Vec<AiProvider> {
    rows.into_iter()
        .map(|row| AiProvider {
            id: row.id,
            name: row.name,
            endpoints: row
                .endpoints
                .into_iter()
                .map(|endpoint| AiEndpoint {
                    id: endpoint.id,
                    slug: endpoint.slug,
                    base_url: endpoint.base_url,
                    protocol: protocol_dto(endpoint.protocol),
                    key_masked: endpoint
                        .key_masked
                        .or_else(|| endpoint.has_key.then(|| "****".to_owned())),
                    probe_url: endpoint.probe_url,
                    models: endpoint.models.into_iter().map(model_dto).collect(),
                })
                .collect(),
        })
        .collect()
}

fn effective_roles(
    settings: &AiRoleSettings,
    options: &[providers::ModelOption],
) -> Vec<AiRoleRow> {
    let valid = |binding: &Option<AiModelRef>| {
        binding
            .as_ref()
            .filter(|reference| {
                options.iter().any(|option| {
                    option.endpoint_id == reference.endpoint_id
                        && option.model_id == reference.model_id
                        && option.model_type == providers::ModelType::Chat
                })
            })
            .cloned()
    };
    let chat = valid(&settings.chat);
    let writing = valid(&settings.writing);
    let is_fallback = writing.is_none() && chat.is_some();
    vec![
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
    ]
}

async fn role_rows(
    context: &AppContext,
) -> Result<(Vec<AiRoleRow>, Vec<providers::ModelOption>), AppError> {
    let settings = run("ai_role_settings", context, |library| {
        library.ai_role_settings()
    })
    .await?;
    let options = provider_call(context, |store| {
        store.model_options(providers::ModelFilter::default())
    })
    .await?;
    Ok((effective_roles(&settings, &options), options))
}

async fn role_dtos(context: &AppContext) -> Result<Vec<AiRoleBinding>, AppError> {
    let (rows, options) = role_rows(context).await?;
    Ok(rows
        .into_iter()
        .map(|row| AiRoleBinding {
            role: row.role,
            binding: row.binding.map(|reference| BoundModel {
                label: options
                    .iter()
                    .find(|option| {
                        option.endpoint_id == reference.endpoint_id
                            && option.model_id == reference.model_id
                    })
                    .map_or_else(|| reference.model_id.clone(), |option| option.label.clone()),
                endpoint_id: reference.endpoint_id,
                model_id: reference.model_id,
            }),
            is_fallback: row.is_fallback,
        })
        .collect())
}

#[tauri::command]
pub async fn ai_providers_list(context: Ctx<'_>) -> Result<Vec<AiProvider>, AppError> {
    provider_call(&context, providers::Store::list)
        .await
        .map(provider_dtos)
}

#[tauri::command]
pub async fn ai_provider_save(
    context: Ctx<'_>,
    provider: Value,
) -> Result<Vec<AiProvider>, AppError> {
    let input = provider_input(parse_input(provider).map_err(AppError::from)?);
    provider_call(&context, move |store| store.save(input))
        .await
        .map(provider_dtos)
}

#[tauri::command]
pub async fn ai_provider_delete(context: Ctx<'_>, id: String) -> Result<Ok<()>, AppError> {
    provider_call(&context, move |store| store.delete(&id)).await?;
    Ok(ok(()))
}

#[tauri::command]
pub async fn ai_endpoint_key_reveal(context: Ctx<'_>, id: String) -> Result<RevealedKey, AppError> {
    let connection = provider_call(&context, move |store| store.endpoint_connection(&id)).await?;
    let key = connection
        .api_key
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Key not set"))?;
    Ok(RevealedKey {
        key: key.to_string(),
    })
}

fn probe_dto(result: providers::ProbeResult) -> note_ai::ProbeResult {
    use note_ai::ProbeErrorKind as W;
    use providers::ProbeErrorKind as K;
    note_ai::ProbeResult {
        probe_url: result.probe_url,
        models: result
            .models
            .into_iter()
            .map(|model| note_ai::ProbedModel {
                model: model_dto(model.model),
                group: model.group,
            })
            .collect(),
        error: result.error.map(|error| note_ai::ProbeError {
            kind: match error.kind {
                K::MissingKey => W::MissingKey,
                K::Unauthorized => W::Unauthorized,
                K::NotFound => W::NotFound,
                K::RateLimited => W::RateLimited,
                K::Status => W::Status,
                K::Timeout => W::Timeout,
                K::Connect | K::BlockedAddress => W::Connect,
                K::InvalidBody => W::InvalidBody,
            },
            status: error.status,
            message: None,
        }),
    }
}

#[tauri::command]
pub async fn ai_endpoint_probe(
    context: Ctx<'_>,
    id: String,
    job_id: String,
) -> Result<note_ai::ProbeResult, AppError> {
    let flag = context.jobs.start(&job_id)?;
    let cancel = tokio_util::sync::CancellationToken::new();
    let watcher = watch_cancel(flag, cancel.clone());
    let result = context
        .providers
        .probe(providers::ProbeTarget::Saved { endpoint_id: id }, &cancel)
        .await;
    cancel.cancel();
    let _ = watcher.await;
    context.jobs.finish(&job_id);
    result.map(probe_dto).map_err(provider_error)
}

fn watch_cancel(
    flag: Arc<std::sync::atomic::AtomicBool>,
    cancel: tokio_util::sync::CancellationToken,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        while !flag.load(Ordering::Relaxed) && !cancel.is_cancelled() {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        cancel.cancel();
    })
}

#[tauri::command]
pub async fn ai_roles_get(context: Ctx<'_>) -> Result<Vec<AiRoleBinding>, AppError> {
    role_dtos(&context).await
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
    if let Some(reference) = &binding {
        let options = provider_call(&context, |store| {
            store.model_options(providers::ModelFilter::default())
        })
        .await?;
        let option = options
            .iter()
            .find(|option| {
                option.endpoint_id == reference.endpoint_id && option.model_id == reference.model_id
            })
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Model not found"))?;
        if option.model_type != providers::ModelType::Chat {
            return Err(AppError::from(note_core::Error::invalid(
                "binding",
                "model is not a chat model",
            )));
        }
    }
    run("ai_roles_set", &context, move |library| {
        let mut settings = library.ai_role_settings()?;
        match role {
            AiRole::Chat => settings.chat = binding,
            AiRole::Writing => settings.writing = binding,
        }
        library.ai_role_settings_save(&settings)
    })
    .await?;
    role_dtos(&context).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use note_core::Library;

    #[test]
    #[allow(clippy::unwrap_used, reason = "failed unwrap fails the test")]
    fn provider_adapter_and_roles_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = providers::Store::open(dir.path()).unwrap();
        let library_path = dir.path().join("library.db");
        let library = Library::open(&library_path).unwrap();
        let request = serde_json::json!({"name":" Example ","endpoints":[{
            "slug":"main","baseUrl":"https://example.com/v1","protocol":"openai-chat",
            "models":[{"id":"chat","modelType":"chat","typeSource":"user","contextWindow":32000,"canVision":true},
                {"id":"emb","modelType":"embedding","typeSource":"inferred","contextWindow":null,"canVision":false}]
        }]});
        let saved = store
            .save(provider_input(parse_input(request).unwrap()))
            .unwrap();
        let endpoint_id = saved[0].endpoints[0].id.clone();
        let dto = provider_dtos(saved);
        assert_eq!(dto[0].name, "Example");
        assert_eq!(
            dto[0].endpoints[0].models[0].type_source,
            AiTypeSource::User
        );
        assert_eq!(dto[0].endpoints[0].models[0].context_window, Some(32000));
        let reference = AiModelRef {
            endpoint_id,
            model_id: "chat".to_owned(),
        };
        let options = store
            .model_options(providers::ModelFilter::default())
            .unwrap();
        let mut settings = AiRoleSettings {
            chat: Some(reference.clone()),
            writing: None,
        };
        let rows = effective_roles(&settings, &options);
        assert_eq!(rows[1].binding, Some(reference.clone()));
        assert!(rows[1].is_fallback);
        settings.writing = Some(reference.clone());
        assert!(!effective_roles(&settings, &options)[1].is_fallback);
        settings.writing.as_mut().unwrap().model_id = "emb".to_owned();
        assert!(effective_roles(&settings, &options)[1].is_fallback);
        library.ai_role_settings_save(&settings).unwrap();
        drop(library);
        let library = Library::open(&library_path).unwrap();
        assert_eq!(library.ai_role_settings().unwrap(), settings);
        assert!(
            effective_roles(&settings, &[])
                .iter()
                .all(|row| row.binding.is_none())
        );
        let connection = store
            .resolve(&providers::ModelRef {
                endpoint_id: reference.endpoint_id,
                model_id: reference.model_id,
            })
            .unwrap();
        assert_eq!(connection.context_window, Some(32000));
        drop(store);
        assert_eq!(
            providers::Store::open(dir.path())
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
    }
}
