// Sprefa plugin Tauri commands.
//
// Talks to a running sprefa-v5 daemon over its unix socket at
// `<root>/.dl/daemon.sock`. The wire codec is Content-Length-framed JSON-RPC
// 2.0 (LSP-style), mirrored from sprefa/v5/src/rpc.rs. We re-implement the
// framing here (a few lines) instead of linking sprefa-v5 as a crate, to keep
// instant's build independent of the engine.
//
// Start the daemon on the sprefa side (e.g. `dl daemon` in the repo root); these
// commands only connect, they do not spawn it.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

/// `<root>/.dl/daemon.sock`, with `~` expanded against $HOME.
fn socket_path(root: &str) -> PathBuf {
    let expanded = if let Some(rest) = root.strip_prefix("~/") {
        match std::env::var_os("HOME") {
            Some(home) => Path::new(&home).join(rest),
            None => PathBuf::from(root),
        }
    } else {
        PathBuf::from(root)
    };
    expanded.join(".dl").join("daemon.sock")
}

/// Write one Content-Length-framed message.
fn write_frame(stream: &mut UnixStream, body: &str) -> Result<(), String> {
    write!(stream, "Content-Length: {}\r\n\r\n{}", body.len(), body).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())
}

/// Read one Content-Length-framed message body.
fn read_frame(stream: &mut UnixStream) -> Result<String, String> {
    let mut content_length: Option<usize> = None;
    let mut line = Vec::<u8>::new();
    loop {
        line.clear();
        let mut byte = [0u8; 1];
        loop {
            let n = stream.read(&mut byte).map_err(|e| e.to_string())?;
            if n == 0 {
                if content_length.is_some() || !line.is_empty() {
                    return Err("unexpected EOF mid-frame".into());
                }
                return Err("daemon closed connection".into());
            }
            line.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        let trimmed: &[u8] = {
            let mut end = line.len();
            while end > 0 && (line[end - 1] == b'\n' || line[end - 1] == b'\r') {
                end -= 1;
            }
            &line[..end]
        };
        if trimmed.is_empty() {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix(b"Content-Length:") {
            let s = std::str::from_utf8(rest).map_err(|e| e.to_string())?.trim();
            content_length = Some(s.parse().map_err(|_| "bad Content-Length".to_string())?);
        }
    }
    let len = content_length.ok_or("missing Content-Length header")?;
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).map_err(|e| e.to_string())?;
    String::from_utf8(body).map_err(|e| e.to_string())
}

/// One request/response round-trip against the daemon. Returns the `result`
/// value, or a string carrying the connection or JSON-RPC error.
fn rpc(root: &str, method: &str, params: Value) -> Result<Value, String> {
    let sock = socket_path(root);
    let mut stream = UnixStream::connect(&sock).map_err(|e| {
        format!(
            "no sprefa daemon at {} ({e}). Start it in the repo first.",
            sock.display()
        )
    })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;

    let req = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    write_frame(&mut stream, &serde_json::to_string(&req).map_err(|e| e.to_string())?)?;

    let body = read_frame(&mut stream)?;
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("rpc error");
        return Err(msg.to_string());
    }
    v.get("result")
        .cloned()
        .ok_or_else(|| "response missing result".to_string())
}

/// `{relations: [{name, columns: [{name, ty}], builtin?}]}`.
#[tauri::command]
pub fn sprefa_schema(root: String) -> Result<Value, String> {
    rpc(&root, "schema", json!({}))
}

/// Daemon liveness + loaded program: `{ok, root, tick_count, program}`.
#[tauri::command]
pub fn sprefa_ping(root: String) -> Result<Value, String> {
    rpc(&root, "ping", json!({}))
}

/// Raw parameterized SQL: `{rows: [[Value]]}`.
#[tauri::command]
pub fn sprefa_query_sql(root: String, sql: String, params: Vec<Value>) -> Result<Value, String> {
    rpc(&root, "query_sql", json!({"sql": sql, "params": params}))
}
