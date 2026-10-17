//! AutoNote role settings over Aether providers, plus endpoint key reveal.
use aether_providers as providers;
use note_core::ai::{AiModelRef, AiRole, AiRoleRow, AiRoleSettings};
use note_core::{AppError, ErrorCode, parse_input};
use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use tauri_plugin_dialog::DialogExt;

use super::run;
use crate::AppContext;

type Ctx<'a> = tauri::State<'a, AppContext>;

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

fn effective_roles(
    settings: &AiRoleSettings,
    options: &[providers::ModelOption],
) -> Vec<AiRoleRow> {
    let valid = |binding: &Option<AiModelRef>, kind: providers::ModelType| {
        binding
            .as_ref()
            .filter(|reference| {
                options.iter().any(|option| {
                    option.endpoint_id == reference.endpoint_id
                        && option.model_id == reference.model_id
                        && option.model_type == kind
                })
            })
            .cloned()
    };
    let chat = valid(&settings.chat, providers::ModelType::Chat);
    let writing = valid(&settings.writing, providers::ModelType::Chat);
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
        AiRoleRow {
            role: AiRole::Painting,
            binding: valid(&settings.painting, providers::ModelType::Image),
            is_fallback: false,
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
        let wanted = if role == AiRole::Painting {
            providers::ModelType::Image
        } else {
            providers::ModelType::Chat
        };
        if option.model_type != wanted {
            return Err(AppError::from(note_core::Error::invalid(
                "binding",
                "model type does not match the role",
            )));
        }
    }
    run("ai_roles_set", &context, move |library| {
        let mut settings = library.ai_role_settings()?;
        match role {
            AiRole::Chat => settings.chat = binding,
            AiRole::Writing => settings.writing = binding,
            AiRole::Painting => settings.painting = binding,
        }
        library.ai_role_settings_save(&settings)
    })
    .await?;
    role_dtos(&context).await
}

#[derive(Serialize)]
pub struct ReplyExport {
    saved: bool,
}

#[tauri::command]
pub async fn ai_reply_export(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    markdown: String,
) -> Result<ReplyExport, AppError> {
    if window.label() != "main" {
        return Err(AppError::new(
            ErrorCode::Forbidden,
            "Export is restricted to the main window",
        ));
    }
    if markdown.len() > 400_000 {
        return Err(AppError::new(
            ErrorCode::PayloadTooLarge,
            "Reply is too large",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Markdown", &["md"])
            .set_file_name("reply.md")
            .blocking_save_file()
        else {
            return Ok(ReplyExport { saved: false });
        };
        let path = path
            .into_path()
            .map_err(|_| internal("Invalid save selection"))?;
        let target = note_core::transfer::AuthorizedOutput::open(&path).map_err(AppError::from)?;
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| internal("Export identifier unavailable"))?;
        let nonce = note_core::id::encode_id(0, &random);
        let (partial, mut file) = target.partial(&nonce).map_err(AppError::from)?;
        let result = file
            .write_all(markdown.as_bytes())
            .and_then(|()| file.sync_all());
        drop(file);
        if let Err(error) = result {
            target.remove(&partial).map_err(AppError::from)?;
            return Err(AppError::from(note_core::Error::from(error)));
        }
        if let Err(error) = target.publish(&partial) {
            target.remove(&partial).map_err(AppError::from)?;
            return Err(AppError::from(error));
        }
        Ok(ReplyExport { saved: true })
    })
    .await
    .map_err(|_| internal("Reply export task failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use note_core::Library;

    #[test]
    #[allow(clippy::unwrap_used, reason = "failed unwrap fails the test")]
    fn roles_follow_saved_chat_models() {
        let dir = tempfile::tempdir().unwrap();
        let store = providers::Store::open(dir.path()).unwrap();
        let library_path = dir.path().join("library.db");
        let library = Library::open(&library_path).unwrap();
        let model =
            |id: &str, model_type, type_source, context_window, can_vision| providers::ModelSave {
                id: id.to_owned(),
                model_type,
                type_source,
                context_window,
                can_vision,
                max_output: None,
                supports_tools: None,
                reasoning: None,
                native_web_search: false,
            };
        let saved = store
            .save(providers::ProviderSave {
                id: None,
                name: "Example".to_owned(),
                enabled: None,
                endpoints: vec![providers::EndpointSave {
                    id: None,
                    slug: "main".to_owned(),
                    base_url: "https://example.com/v1".to_owned(),
                    protocol: providers::Protocol::OpenaiChat,
                    models: vec![
                        model(
                            "chat",
                            providers::ModelType::Chat,
                            providers::TypeSource::User,
                            Some(32000),
                            true,
                        ),
                        model(
                            "emb",
                            providers::ModelType::Embedding,
                            providers::TypeSource::Inferred,
                            None,
                            false,
                        ),
                    ],
                    image_base_url: None,
                    headers: None,
                }],
            })
            .unwrap();
        let endpoint_id = saved[0].endpoints[0].id.clone();
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
            painting: Some(reference.clone()),
        };
        let rows = effective_roles(&settings, &options);
        assert_eq!(rows[1].binding, Some(reference.clone()));
        assert!(rows[1].is_fallback);
        assert_eq!(
            rows[2].binding, None,
            "a chat model is not a painting model"
        );
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
