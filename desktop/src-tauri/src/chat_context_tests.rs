//! Host authorization plus real model requests against a disposable loopback server.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::*;
use aether_runtime::KitHost;
use serde_json::{Value, json};
#[path = "chat_loopback_tests.rs"]
mod loopback;

const BODY: &str = "CURRENT-NOTE-BODY-NOT-IN-DROPPED-REQUEST";

fn fixture(base_url: &str) -> (tempfile::TempDir, AetherHost, NoteId, ModelRef) {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(&dir.path().join("library.db")).unwrap());
    let note = library
        .create_note(
            &note_core::NewNote::from(
                note_core::parse_input::<note_core::CreateNoteBody>(json!({
                    "title": "Plan", "content": BODY
                }))
                .unwrap(),
            ),
            note_core::WriteOrigin::Ui,
        )
        .unwrap()
        .value;
    let providers = Arc::new(ProviderStore::open(dir.path()).unwrap());
    let saved = providers
        .save(
            serde_json::from_value(json!({
                "name": "Loopback", "endpoints": [{
                    "slug": "main", "baseUrl": base_url, "protocol": "openai-chat",
                    "models": [{"id": "m1", "modelType": "chat", "typeSource": "user",
                        "contextWindow": null, "maxOutput": null, "canVision": false,
                        "supportsTools": null}]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
    let model = ModelRef {
        endpoint_id: saved[0].endpoints[0].id.clone(),
        model_id: "m1".into(),
    };
    library
        .ai_role_settings_save(&note_core::ai::AiRoleSettings {
            writing: Some(note_core::ai::AiModelRef {
                endpoint_id: model.endpoint_id.clone(),
                model_id: model.model_id.clone(),
            }),
            ..Default::default()
        })
        .unwrap();
    let host = AetherHost {
        library: Arc::new(OnceLock::from(library)),
        providers,
        skills: skill_runner::SkillRunner::new(
            Arc::new(aether_skills::Store::open(dir.path(), &[]).unwrap()),
            dir.path().to_owned(),
        ),
        chat_store: Arc::new(LazyChatStore {
            root: dir.path().to_owned(),
            store: Mutex::new(None),
            writing: AtomicU64::new(0),
        }),
    };
    (dir, host, note.summary.id, model)
}

fn request(note: &NoteId, model: &ModelRef) -> aether_runtime::RunRequest {
    serde_json::from_value(json!({
        "purpose": "chat", "model": model, "skills": [], "context": null,
        "input": "First without payload", "scope": format!("note:{note}"),
        "conversationId": null, "regenerate": false, "language": "en-US"
    }))
    .unwrap()
}

fn error(req: &aether_runtime::RunRequest, host: &AetherHost) -> Value {
    serde_json::to_value(host.select_model(req).unwrap_err()).unwrap()
}

#[test]
fn note_scope_authorization_survives_null_context() {
    let (_dir, host, note, model) = fixture("http://127.0.0.1:9");
    let (_foreign_dir, foreign, foreign_note, _) = fixture("http://127.0.0.1:9");
    let mut req = request(&note, &model);
    assert_eq!(host.select_model(&req).unwrap(), model);
    let missing = ModelRef {
        endpoint_id: model.endpoint_id.clone(),
        model_id: "gone".into(),
    };
    let explicit = request(&note, &missing);
    assert_eq!(error(&explicit, &host)["details"]["reason"], "model");
    assert!(host.context(&req).unwrap().is_none());
    let turn = reserve(&host, &req);
    let conversation_id = turn.conversation_id;
    for conversation in [None, Some(conversation_id.clone())] {
        req.conversation_id = conversation;
        for (kind, id) in [
            ("autonote-note", foreign_note.as_str()),
            ("wrong-kind", note.as_str()),
        ] {
            req.context = Some(aether_runtime::ContextRef {
                kind: kind.into(),
                id: id.into(),
            });
            assert_eq!(error(&req, &host)["details"]["field"], "context");
        }
        req.context = None;
        assert_eq!(host.select_model(&req).unwrap(), model);
    }
    for scope in [
        None,
        Some("global".to_owned()),
        Some(format!("note:{foreign_note}")),
    ] {
        req.scope = scope;
        assert_eq!(error(&req, &host)["details"]["field"], "scope");
    }
    req.scope = Some(format!("note:{note}"));
    assert_eq!(error(&req, &foreign)["details"]["entity"], "conversation");
    req.conversation_id = None;
    req.scope = Some(format!("note:{foreign_note}"));
    assert_eq!(error(&req, &host)["details"]["entity"], "note");
    req.scope = Some("note:not-a-note-id".into());
    assert_eq!(error(&req, &host)["details"]["entity"], "note");
    host.library
        .get()
        .unwrap()
        .trash_note(&note, note_core::WriteOrigin::Ui)
        .unwrap();
    req.scope = Some(format!("note:{note}"));
    for conversation in [None, Some(conversation_id.clone())] {
        req.conversation_id = conversation;
        assert_eq!(error(&req, &host)["details"]["entity"], "note");
    }
    req.conversation_id = None;
    req.purpose = "writing".into();
    req.scope = Some(format!("note:{note}:writing"));
    req.input = json!({"action":"polish", "noteId":note, "selectedText":"x", "beforeText":"",
        "afterText":"", "cursorOffset":0, "language":"en-US", "title":"Plan"})
    .to_string();
    assert_eq!(error(&req, &host)["details"]["reason"], "required");
    req.purpose = "polish".into();
    assert_eq!(error(&req, &host)["details"]["reason"], "unsupported");
    assert_eq!(
        host.chat_store.load(&conversation_id).unwrap().turns.len(),
        1
    );
}

#[test]
fn permissions_are_desktop_only_and_writing_never_opens_mcp() {
    use aether_runtime::PermissionMode;
    let (_dir, host, note, model) = fixture("http://127.0.0.1:9");
    let mut req = request(&note, &model);
    assert_eq!(host.permission_modes(&req).len(), 5);
    assert!(host.mcp_tools(&req));
    req.purpose = "writing".into();
    req.scope = Some(format!("note:{note}:writing"));
    req.input = json!({
        "action":"polish", "noteId":note, "selectedText":"x", "beforeText":"",
        "afterText":"", "cursorOffset":0, "language":"en-US", "title":"Plan"
    })
    .to_string();
    assert_eq!(host.permission_modes(&req), vec![PermissionMode::Default]);
    assert!(!host.mcp_tools(&req));
    for mode in [
        PermissionMode::Plan,
        PermissionMode::AcceptEdits,
        PermissionMode::Auto,
        PermissionMode::FullAccess,
    ] {
        req.permission_mode = Some(mode);
        assert_eq!(
            validate_writing(&req).unwrap_err().details().reason(),
            Some("not_allowed")
        );
    }
    req.permission_mode = Some(PermissionMode::Default);
    req.skills = vec![aether_runtime::SkillRef {
        id: "not-selected".into(),
        revision: 1,
    }];
    assert_eq!(
        validate_writing(&req).unwrap_err().details().reason(),
        Some("writing_not_allowed")
    );
}

#[test]
fn writing_rejects_every_reply_graph_action() {
    let (_dir, _host, note, model) = fixture("http://127.0.0.1:9");
    let mut req = request(&note, &model);
    req.purpose = "writing".into();
    req.scope = Some(format!("note:{note}:writing"));
    req.input = json!({
        "action":"polish", "noteId":note, "selectedText":"x", "beforeText":"",
        "afterText":"", "cursorOffset":0, "language":"en-US", "title":"Plan"
    })
    .to_string();
    assert!(validate_writing(&req).is_ok());
    for field in [
        "replyToId",
        "retryTurnId",
        "translateTurnId",
        "targetLanguage",
    ] {
        let mut candidate = req.clone();
        match field {
            "replyToId" => candidate.reply_to_id = Some("turn".into()),
            "retryTurnId" => candidate.retry_turn_id = Some("turn".into()),
            "translateTurnId" => candidate.translate_turn_id = Some("turn".into()),
            _ => candidate.target_language = Some("French".into()),
        }
        assert_eq!(
            validate_writing(&candidate).unwrap_err().details().reason(),
            Some("invalid_writing_scope")
        );
    }
}

#[test]
fn maintenance_and_ephemeral_reservations_do_not_open_history() {
    use aether_runtime::conversations::{ResolvedAction, resolve_action};
    let (dir, host, note, model) = fixture("http://127.0.0.1:9");
    assert_eq!(host.chat_store.purge_images(i64::MAX).unwrap(), 0);
    assert!(!dir.path().join("chat.db").exists());
    let (mut action, _) = resolve_action(
        None,
        None,
        Some(format!("note:{note}:writing")),
        "polish".into(),
        Vec::new(),
        false,
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let error = host
        .chat_store
        .reserve_action(&action, &mut |_| Err(aether_runtime::KitError::cancelled()))
        .unwrap_err();
    assert_eq!(serde_json::to_value(error).unwrap()["code"], "cancelled");
    assert_eq!(host.chat_store.writing.load(Ordering::Relaxed), 0);
    action.action = ResolvedAction::Reply {
        parent_id: Some("foreign".into()),
    };
    assert!(
        host.chat_store
            .reserve_action(&action, &mut |_| {
                panic!("unsupported writing action must be rejected before validation")
            })
            .is_err()
    );
    assert!(!dir.path().join("chat.db").exists());
    let mut req = request(&note, &model);
    req.purpose = "writing".into();
    req.scope = Some(format!("note:{note}:writing"));
    req.context = Some(aether_runtime::ContextRef {
        kind: "autonote-note".into(),
        id: note.to_string(),
    });
    req.input = json!({"action":"polish", "noteId":note, "selectedText":"x",
        "beforeText":"", "afterText":"", "cursorOffset":0, "language":"en-US", "title":"Plan"})
    .to_string();
    let turn = reserve(&host, &req);
    let next = reserve(&host, &req);
    assert!(turn.conversation_id.starts_with("writing:"));
    assert_ne!(turn.conversation_id, next.conversation_id);
    assert!(!dir.path().join("chat.db").exists());
}

fn reserve(
    host: &AetherHost,
    req: &aether_runtime::RunRequest,
) -> aether_runtime::conversations::TurnHandle {
    let conversation = req
        .conversation_id
        .as_deref()
        .map(|id| host.chat_store.load(id).unwrap());
    let (action, _) = aether_runtime::conversations::resolve_action(
        conversation.as_ref(),
        req.conversation_id.clone(),
        req.scope.clone(),
        req.input.clone(),
        req.images.clone(),
        req.regenerate,
        req.reply_to_id.clone(),
        req.retry_turn_id.clone(),
        req.translate_turn_id.clone(),
        req.target_language.clone(),
    )
    .unwrap();
    host.chat_store
        .reserve_action(&action, &mut |source| {
            let connection = host.providers.resolve(&host.select_model(req)?).unwrap();
            Ok(aether_chat::RunInput {
                run_id: "reservation-test".into(),
                purpose: req.purpose.clone(),
                permission_mode: req.permission_mode.unwrap_or_default(),
                budget: aether_chat::Budget::default().for_connection(&connection),
                connection,
                system: Vec::new(),
                history: Vec::new(),
                input: source.input.clone(),
                images: source.images.clone(),
                tools: Vec::new(),
                reasoning_effort: Default::default(),
                native_web_search: false,
            })
        })
        .unwrap()
        .handle
}
