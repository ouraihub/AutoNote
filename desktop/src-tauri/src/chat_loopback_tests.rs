use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;
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
            let body = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"Loopback reply\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            );
            write!(
                socket,
                concat!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n",
                    "content-length: {}\r\nconnection: close\r\n\r\n{body}"
                ),
                body.len(),
                body = body
            )
            .unwrap();
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
