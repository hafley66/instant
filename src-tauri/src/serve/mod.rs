// serve: the backend over HTTP + one JSON-RPC 2.0 WebSocket, no Tauri app.
// Wire contract: src/reactive/wsTransport.ts; four frame shapes, hand-rolled.

mod host;
mod rpc;

#[cfg(test)]
mod tests;

pub use host::ServeHost;
pub use rpc::dispatch;
pub use crate::services::Services;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

pub struct ServeState {
    pub host: Arc<ServeHost>,
    pub services: Arc<Services>,
}

/// `/ws` upgrade + static `dist`, index.html fallback for every other path.
pub fn router(state: Arc<ServeState>, dist: PathBuf) -> axum::Router {
    let files = tower_http::services::ServeDir::new(&dist)
        .fallback(tower_http::services::ServeFile::new(dist.join("index.html")));
    axum::Router::new()
        .route("/ws", axum::routing::get(upgrade))
        .fallback_service(files)
        .with_state(state)
}

async fn upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServeState>>,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| connection(socket, state))
}

/// One connection: every outbound frame (responses + events) flows through one
/// channel, so a slow command on a blocking thread never delays event delivery.
async fn connection(socket: WebSocket, state: Arc<ServeState>) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel();
    let mut subscribed = false;
    loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Some(frame) => {
                    if sink.send(frame).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            msg = stream.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else {
                        continue;
                    };
                    let method = frame.get("method").and_then(Value::as_str).map(str::to_string);
                    let id = frame.get("id").cloned();
                    match (method, id) {
                        (Some(method), Some(id)) => {
                            spawn_request(state.clone(), out_tx.clone(), method, id, frame.get("params").cloned().unwrap_or(Value::Null));
                        }
                        (Some(method), None) if method == "events" && !subscribed => {
                            subscribed = true;
                            spawn_event_forwarder(state.host.subscribe(), out_tx.clone());
                        }
                        _ => {}
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
        }
    }
}

/// rpc::dispatch may reach async impls through tauri's runtime, which cannot
/// block from inside an async context, so each request runs on a blocking thread.
fn spawn_request(
    state: Arc<ServeState>,
    respond: mpsc::UnboundedSender<Message>,
    method: String,
    id: Value,
    params: Value,
) {
    tokio::spawn(async move {
        let host: Arc<dyn crate::host::Host> = state.host.clone();
        let services = state.services.clone();
        let name = method;
        let outcome = tokio::task::spawn_blocking(move || rpc::dispatch(&name, host, services, params)).await;
        let frame = match outcome {
            Ok(Ok(result)) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Ok(Err(message)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } })
            }
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": format!("dispatch task failed: {e}") } }),
        };
        let _ = respond.send(Message::Text(frame.to_string().into()));
    });
}

/// Forward every Host::emit to one subscribed connection until it closes.
fn spawn_event_forwarder(
    mut rx: broadcast::Receiver<(String, Value)>,
    push: mpsc::UnboundedSender<Message>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok((event, payload)) => {
                    let frame = json!({ "jsonrpc": "2.0", "method": "events", "params": { "event": event, "payload": payload } });
                    if push.send(Message::Text(frame.to_string().into())).is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}
