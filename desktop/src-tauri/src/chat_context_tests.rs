//! Host authorization plus real model requests against a disposable loopback server.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::*;
use aether_chat::{Approver, BoxFuture, CancellationToken, ToolExecutor};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;
use tauri_plugin_aether::KitHost;

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
    let host = AetherHost {
        library: Arc::new(OnceLock::from(library)),
        providers,
        chat_store: Arc::new(LazyChatStore {
            root: dir.path().to_owned(),
            store: Mutex::new(None),
            writing: AtomicU64::new(0),
        }),
    };
    (dir, host, note.summary.id, model)
}

fn request(note: &NoteId, model: &ModelRef) -> tauri_plugin_aether::RunRequest {
    serde_json::from_value(json!({
        "purpose": "chat", "model": model, "skills": [], "context": null,
        "input": "First without payload", "scope": format!("note:{note}"),
        "conversationId": null, "regenerate": false, "language": "en-US"
    }))
    .unwrap()
}

fn error(req: &tauri_plugin_aether::RunRequest, host: &AetherHost) -> Value {
    serde_json::to_value(host.select_model(req).unwrap_err()).unwrap()
}

#[test]
fn note_scope_authorization_survives_null_context() {
    let (_dir, host, note, model) = fixture("http://127.0.0.1:9");
    let (_foreign_dir, foreign, foreign_note, _) = fixture("http://127.0.0.1:9");
    let mut req = request(&note, &model);
    assert_eq!(host.select_model(&req).unwrap(), model);
    assert!(host.context(&req).unwrap().is_none());
    let turn = host
        .chat_store
        .begin_turn(None, req.scope.as_deref(), &req.input)
        .unwrap();
    let conversation_id = turn.conversation_id;
    for conversation in [None, Some(conversation_id.clone())] {
        req.conversation_id = conversation;
        for (kind, id) in [
            ("autonote-note", foreign_note.as_str()),
            ("wrong-kind", note.as_str()),
        ] {
            req.context = Some(tauri_plugin_aether::ContextRef {
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

struct NoTools;
impl ToolExecutor for NoTools {
    fn authorize(
        &self,
        _: &aether_chat::ToolCall,
        _: aether_chat::Approval,
    ) -> aether_chat::Approval {
        aether_chat::Approval::Deny
    }
    fn execute<'life0, 'life1, 'life2, 'async_trait>(
        &'life0 self,
        _: &'life1 aether_chat::ToolCall,
        _: &'life2 CancellationToken,
    ) -> BoxFuture<'async_trait, aether_chat::ToolExecution>
    where
        'life0: 'async_trait,
        'life1: 'async_trait,
        'life2: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async { panic!("no tools are offered") })
    }
}
impl Approver for NoTools {
    fn wait(
        &self,
        _: &str,
        _: &aether_chat::ToolCall,
        _: &CancellationToken,
    ) -> BoxFuture<'_, bool> {
        Box::pin(async { panic!("no approvals are offered") })
    }
}

#[test]
fn dropped_context_reaches_loopback_without_note_body_and_preserves_history() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut seen = Vec::new();
        while seen.len() < 3 {
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
    let mut req = request(&note, &model);
    tauri::async_runtime::block_on(async {
        let runner = aether_chat::Runner::new(aether_chat::AddressPolicy::default()).unwrap();
        for (text, include) in [
            ("First without payload", false),
            ("With payload", true),
            ("Continue without payload", false),
        ] {
            req.input = text.into();
            req.context = include.then(|| tauri_plugin_aether::ContextRef {
                kind: "autonote-note".into(),
                id: note.to_string(),
            });
            let selected = host.select_model(&req).unwrap();
            let connection = host.providers.resolve(&selected).unwrap();
            let budget = aether_chat::Budget::default().for_connection(&connection);
            let mut system = vec![aether_chat::SystemPart::Host(
                host.system_prompt(&req).unwrap(),
            )];
            if let Some(block) = host.context(&req).unwrap() {
                system.push(aether_chat::SystemPart::Context {
                    source: block.source,
                    text: block.text,
                });
            }
            let history = req
                .conversation_id
                .as_ref()
                .map(|id| {
                    aether_chat::trim_history(&host.chat_store.load(id).unwrap().turns, 24_000)
                })
                .unwrap_or_default();
            let turn = host
                .chat_store
                .begin_turn(
                    req.conversation_id.as_deref(),
                    req.scope.as_deref(),
                    &req.input,
                )
                .unwrap();
            req.conversation_id = Some(turn.conversation_id.clone());
            let summary = runner
                .run(
                    aether_chat::RunInput {
                        run_id: turn.turn_id.clone(),
                        connection,
                        system,
                        history,
                        input: req.input.clone(),
                        tools: Vec::new(),
                        budget,
                        reasoning_effort: Default::default(),
                        native_web_search: false,
                    },
                    &NoTools,
                    &NoTools,
                    &CancellationToken::new(),
                    |_| {},
                )
                .await;
            assert_eq!(summary.status, aether_chat::EndStatus::Completed);
            host.chat_store
                .finish_turn(
                    turn,
                    aether_chat::TurnRecord {
                        status: summary.status,
                        messages: summary.messages,
                        model_id: Some(model.model_id.clone()),
                        skills: Vec::new(),
                        error_code: None,
                        input_tokens: summary.usage.input_tokens,
                        output_tokens: summary.usage.output_tokens,
                        cache_read_tokens: summary.usage.cache_read_tokens,
                        cache_write_tokens: summary.usage.cache_write_tokens,
                        reasoning_tokens: summary.usage.reasoning_tokens,
                        context_usage: summary.context_usage,
                        reasoning_effort: None,
                        endpoint_id: Some(model.endpoint_id.clone()),
                    },
                )
                .unwrap();
        }
    });
    let seen = server.join().unwrap();
    assert!(!seen[0].to_string().contains(BODY));
    assert!(seen[1].to_string().contains(BODY));
    assert!(!seen[2].to_string().contains(BODY));
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
