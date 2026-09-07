// WebSocket tests against the real router on port 0, spoken with the same
// frames src/reactive/wsTransport.ts sends.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::{router, ServeHost, ServeState, Services};
use crate::host::Host;

async fn spin() -> (std::net::SocketAddr, Arc<ServeHost>) {
    // One data dir per call: tests run concurrently and sqlite refuses a dir
    // being deleted under it.
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("instant-serve-tests-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("test data dir");
    let services = Arc::new(Services::boot(&dir).expect("services boot"));
    let host = Arc::new(ServeHost::new(dir.clone()));
    let state = Arc::new(ServeState { host: host.clone(), services });
    let app = router(state, dir); // ws tests never touch the static files
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind port 0");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    (addr, host)
}

struct Client {
    ws: WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
}

impl Client {
    async fn send(&mut self, frame: Value) {
        self.ws
            .send(Message::Text(frame.to_string().into()))
            .await
            .expect("ws send");
    }

    async fn next_frame(&mut self) -> Value {
        let deadline = Duration::from_secs(15);
        loop {
            let msg = tokio::time::timeout(deadline, self.ws.next())
                .await
                .expect("frame timeout")
                .expect("ws closed")
                .expect("ws error");
            if let Message::Text(text) = msg {
                if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                    return frame;
                }
            }
        }
    }
}

async fn connect(addr: std::net::SocketAddr) -> Client {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("ws connect");
    Client { ws }
}

#[tokio::test(flavor = "multi_thread")]
async fn request_returns_result_frame_with_the_same_id() {
    let (addr, _host) = spin().await;
    let mut client = connect(addr).await;
    client
        .send(json!({ "jsonrpc": "2.0", "id": 7, "method": "list_sessions", "params": {} }))
        .await;
    let frame = client.next_frame().await;
    assert_eq!(frame["id"], json!(7), "frame: {frame}");
    assert!(frame.get("result").is_some(), "frame: {frame}");
    assert!(frame.get("error").is_none(), "frame: {frame}");
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_method_returns_error_frame() {
    let (addr, _host) = spin().await;
    let mut client = connect(addr).await;
    client
        .send(json!({ "jsonrpc": "2.0", "id": 8, "method": "no_such_command", "params": {} }))
        .await;
    let frame = client.next_frame().await;
    assert_eq!(frame["id"], json!(8), "frame: {frame}");
    assert_eq!(frame["error"]["code"], json!(-32000), "frame: {frame}");
    let message = frame["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("unknown command"), "frame: {frame}");
}

#[tokio::test(flavor = "multi_thread")]
async fn events_subscription_forwards_host_emits() {
    let (addr, host) = spin().await;
    let mut client = connect(addr).await;
    client.send(json!({ "jsonrpc": "2.0", "method": "events" })).await;
    // Let the server register the subscription before emitting.
    tokio::time::sleep(Duration::from_millis(200)).await;
    host.emit("x", json!(1)).expect("emit");
    let frame = client.next_frame().await;
    assert_eq!(frame["method"], json!("events"), "frame: {frame}");
    assert_eq!(frame["params"]["event"], json!("x"), "frame: {frame}");
    assert_eq!(frame["params"]["payload"], json!(1), "frame: {frame}");
}
