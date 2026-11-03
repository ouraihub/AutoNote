use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};

impl RemoteClient {
    /// Opens the remote change notification stream.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, authentication, or invalid-response errors.
    pub async fn subscribe_changes(
        &self,
        options: &CallOptions,
    ) -> Result<ChangeSubscription, RemoteError> {
        options
            .run(async {
                let target = self
                    .origin()
                    .as_url()
                    .join("/api/sync/ws")
                    .map_err(|_| RemoteError::new(ErrorCode::BadRequest))?;
                let cookie = self
                    .cookie_header(&target)?
                    .ok_or_else(|| RemoteError::new(ErrorCode::Unauthenticated))?;
                let mut ws = target.clone();
                ws.set_scheme(if target.scheme() == "https" {
                    "wss"
                } else {
                    "ws"
                })
                .map_err(|_| RemoteError::new(ErrorCode::BadRequest))?;
                let mut request = ws
                    .as_str()
                    .into_client_request()
                    .map_err(|_| RemoteError::new(ErrorCode::BadRequest))?;
                request.headers_mut().insert(
                    "Cookie",
                    cookie
                        .parse()
                        .map_err(|_| RemoteError::new(ErrorCode::InvalidResponse))?,
                );
                request.headers_mut().insert(
                    "Origin",
                    self.origin()
                        .as_url()
                        .origin()
                        .ascii_serialization()
                        .parse()
                        .map_err(|_| RemoteError::new(ErrorCode::InvalidResponse))?,
                );
                let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                    .max_message_size(Some(4096))
                    .max_frame_size(Some(4096));
                let (socket, _) =
                    tokio_tungstenite::connect_async_with_config(request, Some(config), false)
                        .await
                        .map_err(|_| RemoteError::new(ErrorCode::Offline))?;
                Ok(ChangeSubscription { socket })
            })
            .await
    }
}

pub struct ChangeSubscription {
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
}
impl ChangeSubscription {
    /// Waits for a change notification or heartbeat response.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, offline, or invalid-response errors.
    pub async fn changed(&mut self, options: &CallOptions) -> Result<bool, RemoteError> {
        options
            .run(async {
                let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
                let mut pong_deadline = tokio::time::Instant::now() + Duration::from_secs(35);
                loop {
                    tokio::select! {
                        _ = heartbeat.tick() => self.socket.send(
                            Message::Text("{\"type\":\"ping\"}".into())
                        ).await.map_err(|_| RemoteError::new(ErrorCode::Offline))?,
                        _ = tokio::time::sleep_until(pong_deadline) => {
                            return Err(RemoteError::new(ErrorCode::RequestTimeout));
                        },
                        message = self.socket.next() => match message {
                            Some(Ok(Message::Text(text))) => {
                                let value: Value = serde_json::from_str(&text)
                                    .map_err(|_| RemoteError::new(ErrorCode::InvalidResponse))?;
                                match value.get("type").and_then(Value::as_str) {
                                    Some("changed") if value.get("cursor")
                                        .and_then(Value::as_i64)
                                        .is_some_and(|cursor| (0..=note_core::MAX_SAFE_INTEGER)
                                            .contains(&cursor)) => return Ok(true),
                                    Some("pong") if value.get("serverTime")
                                        .and_then(Value::as_i64)
                                        .is_some_and(|time| (0..=note_core::MAX_SAFE_INTEGER)
                                            .contains(&time)) => {
                                        pong_deadline = tokio::time::Instant::now()
                                            + Duration::from_secs(35)
                                    },
                                    Some("ping") => self.socket.send(Message::Text(
                                        json!({"type":"pong","serverTime":now()?.get()})
                                            .to_string().into()
                                    )).await.map_err(|_| RemoteError::new(ErrorCode::Offline))?,
                                    _ => return Err(RemoteError::new(ErrorCode::InvalidResponse)),
                                }
                            },
                            Some(Ok(Message::Ping(bytes))) => self.socket.send(
                                Message::Pong(bytes)
                            ).await.map_err(|_| RemoteError::new(ErrorCode::Offline))?,
                            Some(Ok(Message::Pong(_))) => pong_deadline =
                                tokio::time::Instant::now() + Duration::from_secs(35),
                            _ => return Err(RemoteError::new(ErrorCode::Offline)),
                        },
                    }
                }
            })
            .await
    }
}
