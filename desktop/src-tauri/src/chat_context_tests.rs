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
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

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
    let saved = providers.save(serde_json::from_value(json!({
        "name": "Loopback", "endpoints": [{
            "slug": "main", "baseUrl": base_url, "protocol": "openai-chat",
            "models": [{"id": "m1", "modelType": "chat", "typeSource": "user",
                "contextWindow": null, "maxOutput": null, "canVision": false, "supportsTools": null}]
        }]
    })).unwrap()).unwrap();
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
    req.input = json!({"action":"polish", "noteId":note, "selectedText":"x", "beforeText":"", "afterText":"", "cursorOffset":0, "language":"en-US", "title":"Plan"}).to_string();
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
    req.input = json!({"action":"polish", "noteId":note, "selectedText":"x", "beforeText":"", "afterText":"", "cursorOffset":0, "language":"en-US", "title":"Plan"}).to_string();
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

async fn complete_run(
    runs: &Arc<aether_runtime::RunService>,
    owner: &aether_runtime::RunOwner,
    req: aether_runtime::RunRequest,
) -> aether_runtime::RunAccepted {
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let accepted = runs
        .start(
            aether_runtime::RunContext {
                owner: owner.clone(),
                own_mcp_port: None,
            },
            req,
            Arc::new(move |event| {
                sender.send(event).unwrap();
                Ok(())
            }),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let aether_runtime::RunEvent::End { status, error, .. } =
                events.recv().await.unwrap()
            {
                assert_eq!(status, aether_runtime::EndStatus::Completed, "{error:?}");
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        runs.snapshot(owner, &accepted.run_id).unwrap().status,
        aether_runtime::RunStatus::Completed
    );
    accepted
}

#[test]
fn dropped_context_reaches_loopback_without_note_body_and_preserves_history() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut seen = Vec::new();
        while seen.len() < 4 {
            let (mut socket, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "missing model request"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(err) => panic!("loopback accept: {err}"),
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut raw = Vec::new();
            let mut buffer = [0_u8; 4096];
            let (start, length) = loop {
                let n = socket.read(&mut buffer).unwrap();
                assert!(n > 0, "incomplete request");
                raw.extend_from_slice(&buffer[..n]);
                if let Some(end) = raw.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&raw[..end]);
                    assert!(headers.starts_with("POST /v1/chat/completions "));
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if raw.len() >= end + 4 + length {
                        break (end + 4, length);
                    }
                }
            };
            seen.push(serde_json::from_slice::<Value>(&raw[start..start + length]).unwrap());
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"Loopback reply\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
            write!(socket, "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        seen
    });
    let (_dir, host, note, model) = fixture(&base_url);
    let host = Arc::new(host);
    let mut req = request(&note, &model);
    tauri::async_runtime::block_on(async {
        let mut deps = aether_runtime::RunDependencies::new(host.providers.clone());
        deps.conversations = Some(host.chat_store.clone());
        let runs = aether_runtime::RunService::new(
            host.clone(),
            aether_runtime::RunConfig::default(),
            deps,
            aether_runtime::AddressPolicy::default(),
        )
        .unwrap();
        let owner = aether_runtime::RunOwner::new();
        for (text, include) in [
            ("First without payload", false),
            ("With payload", true),
            ("Continue without payload", false),
        ] {
            req.input = text.into();
            req.context = include.then(|| aether_runtime::ContextRef {
                kind: "autonote-note".into(),
                id: note.to_string(),
            });
            let accepted = complete_run(&runs, &owner, req.clone()).await;
            req.conversation_id = accepted.conversation_id;
        }
        let mut writing = request(&note, &model);
        writing.purpose = "writing".into();
        writing.scope = Some(format!("note:{note}:writing"));
        writing.context = Some(aether_runtime::ContextRef {
            kind: "autonote-note".into(),
            id: note.to_string(),
        });
        writing.input = json!({"action":"polish", "noteId":note, "selectedText":"x",
            "beforeText":"", "afterText":"", "cursorOffset":0, "language":"en-US", "title":"Plan"})
        .to_string();
        let accepted = complete_run(&runs, &owner, writing).await;
        assert!(accepted.conversation_id.unwrap().starts_with("writing:"));
        assert!(
            host.chat_store
                .list(Some(&format!("note:{note}:writing")), 20)
                .unwrap()
                .is_empty()
        );
        assert_eq!(host.chat_store.list(None, 20).unwrap().len(), 1);
        runs.shutdown(Duration::from_secs(3)).await;
    });
    let seen = server.join().unwrap();
    assert!(!seen[0].to_string().contains(BODY));
    assert!(seen[1].to_string().contains(BODY));
    assert!(!seen[2].to_string().contains(BODY));
    assert!(seen[3].to_string().contains(BODY));
    assert_eq!(
        &seen[2]["messages"].as_array().unwrap()[1..],
        &[
            json!({"role":"user", "content":"First without payload"}),
            json!({"role":"assistant", "content":"Loopback reply"}),
            json!({"role":"user", "content":"With payload"}),
            json!({"role":"assistant", "content":"Loopback reply"}),
            json!({"role":"user", "content":"Continue without payload"}),
        ]
    );
    let conversation = host
        .chat_store
        .load(req.conversation_id.as_deref().unwrap())
        .unwrap();
    assert_eq!(conversation.summary.scope, req.scope);
    assert_eq!(conversation.turns.len(), 3);
    assert_eq!(
        host.library.get().unwrap().get_note(&note).unwrap().content,
        BODY
    );
}
