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

/// Expand a leading `~/` against $HOME.
fn expand(root: &str) -> PathBuf {
    if let Some(rest) = root.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home).join(rest);
        }
    }
    PathBuf::from(root)
}

/// The sprefa daemon socket. The productized daemon is rootless: a singleton
/// at the XDG home (`$XDG_STATE_HOME/sprefa` or `~/.local/state/sprefa`),
/// mirroring sprefa's `daemon_home()`. Falls back to the legacy per-root path
/// `<root>/.dl/daemon.sock` when the XDG socket is absent (a daemon still
/// launched with `--root`).
fn socket_path(root: &str) -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".local/state")))
        .unwrap_or_else(|| PathBuf::from("."));
    let xdg = base.join("sprefa").join("daemon.sock");
    if xdg.exists() {
        return xdg;
    }
    expand(root).join(".dl").join("daemon.sock")
}

/// One `POST /rpc` HTTP/1.1 round-trip over the daemon socket. The daemon
/// serves plain HTTP on the UDS as of the axum arc (the old Content-Length
/// framed wire is gone); `Connection: close` lets us read the response to
/// EOF and split the body off after the header terminator — the same shape
/// as sprefa's own `tests/it/util.rs::uds_rpc`.
fn http_rpc(stream: &mut UnixStream, body: &str) -> Result<String, String> {
    write!(
        stream,
        "POST /rpc HTTP/1.1\r\nHost: dl-daemon\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    if raw.is_empty() {
        return Err("daemon closed connection".into());
    }
    let text = String::from_utf8(raw).map_err(|e| e.to_string())?;
    let header_end = text
        .find("\r\n\r\n")
        .ok_or("malformed HTTP response from daemon")?;
    Ok(text[header_end + 4..].to_string())
}

/// One request/response round-trip against the daemon. Returns the `result`
/// value, or a string carrying the connection or JSON-RPC error.
fn rpc(root: &str, method: &str, params: Value) -> Result<Value, String> {
    rpc_with_timeout(root, method, params, Duration::from_secs(10))
}

fn rpc_with_timeout(
    root: &str,
    method: &str,
    params: Value,
    read_timeout: Duration,
) -> Result<Value, String> {
    let sock = socket_path(root);
    let mut stream = UnixStream::connect(&sock).map_err(|e| {
        format!(
            "no sprefa daemon at {} ({e}). Start it in the repo first.",
            sock.display()
        )
    })?;
    stream
        .set_read_timeout(Some(read_timeout))
        .map_err(|e| e.to_string())?;

    let req = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    let body = http_rpc(&mut stream, &serde_json::to_string(&req).map_err(|e| e.to_string())?)?;
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("rpc error");
        return Err(msg.to_string());
    }
    v.get("result")
        .cloned()
        .ok_or_else(|| "response missing result".to_string())
}

/// Run blocking work (socket rpc, fs scans) off the main thread. A sync
/// `#[tauri::command]` executes ON the main thread; a daemon that answers
/// slowly (engine lock held for a whole tick) would freeze the app for the
/// full read timeout, every poll. Every command below is async and hops
/// through here so the main thread never touches the socket.
async fn run_blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| e.to_string())?
}

/// `{relations: [{name, columns: [{name, ty}], builtin?}]}`.
#[tauri::command]
pub async fn sprefa_schema(root: String) -> Result<Value, String> {
    run_blocking(move || rpc(&root, "schema", json!({}))).await
}

/// Daemon liveness + loaded program: `{ok, root, tick_count, program}`.
/// Tight 1s timeout: the daemon's ping handler is lock-free, so a slow answer
/// means the daemon is wedged and the status row should say so quickly.
#[tauri::command]
pub async fn sprefa_ping(root: String) -> Result<Value, String> {
    run_blocking(move || rpc_with_timeout(&root, "ping", json!({}), Duration::from_secs(1))).await
}

/// Evaluate a scratch `.dl` snippet against a throwaway engine (runtime-only
/// relations; nothing persists). Returns `{ok, results: [{rel, columns, rows}],
/// diagnostics: [...]}`.
#[tauri::command]
pub async fn sprefa_eval(root: String, text: String) -> Result<Value, String> {
    run_blocking(move || rpc(&root, "eval", json!({ "text": text }))).await
}

/// Raw parameterized SQL: `{rows: [[Value]]}`.
#[tauri::command]
pub async fn sprefa_query_sql(
    root: String,
    sql: String,
    params: Vec<Value>,
) -> Result<Value, String> {
    run_blocking(move || rpc(&root, "query_sql", json!({"sql": sql, "params": params}))).await
}

/// One source site for a relation: a `.dl` declaration / rule head, or a Rust
/// emit site for a builtin relation.
#[derive(serde::Serialize)]
pub struct RelSite {
    file: String,
    line: usize,
    text: String,
    kind: String, // "decl" | "rule" | "rust"
}

/// Recursively collect files with one of `exts` under `dir`, skipping heavy
/// dirs. Bounded by `budget` to keep a large repo from stalling the scan.
fn collect(dir: &Path, exts: &[&str], out: &mut Vec<PathBuf>, budget: &mut usize) {
    if *budget == 0 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for ent in entries.flatten() {
        let p = ent.path();
        let name = ent.file_name();
        let name = name.to_string_lossy();
        if p.is_dir() {
            if matches!(name.as_ref(), "target" | "node_modules" | ".git" | "dist") {
                continue;
            }
            collect(&p, exts, out, budget);
        } else if exts.iter().any(|e| name.ends_with(e)) {
            out.push(p);
            *budget -= 1;
            if *budget == 0 {
                return;
            }
        }
    }
}

/// Where a relation is produced. Scans `.dl` files under `<root>` for the
/// `rel <name>(` declaration and `<name>(` rule heads, then `<root>/src/*.rs`
/// for `"<name>"` literals (builtin relations are emitted from Rust). Returns
/// up to 60 sites, decls and rule heads first.
#[tauri::command]
pub async fn sprefa_rel_source(root: String, rel: String) -> Result<Vec<RelSite>, String> {
    run_blocking(move || rel_source_blocking(&root, &rel)).await
}

fn rel_source_blocking(root: &str, rel: &str) -> Result<Vec<RelSite>, String> {
    let base = expand(root);
    let mut sites: Vec<RelSite> = Vec::new();

    let mut dl_files = Vec::new();
    let mut budget = 4000usize;
    collect(&base, &[".dl"], &mut dl_files, &mut budget);
    let decl = format!("rel {rel}(");
    let head_paren = format!("{rel}(");
    for f in &dl_files {
        let txt = match std::fs::read_to_string(f) {
            Ok(t) => t,
            Err(_) => continue,
        };
        for (i, raw) in txt.lines().enumerate() {
            let line = raw.trim_start();
            let kind = if line.starts_with(&decl) || line.starts_with(&format!("rel {rel} ")) {
                Some("decl")
            } else if line.starts_with(&head_paren) {
                // statement head: a fact `rel(..)` or a rule `rel(..) <-`
                Some("rule")
            } else {
                None
            };
            if let Some(k) = kind {
                sites.push(RelSite {
                    file: f.to_string_lossy().to_string(),
                    line: i + 1,
                    text: raw.trim_end().to_string(),
                    kind: k.to_string(),
                });
            }
        }
    }

    // No Rust fallback: builtin relations (`_file`, `call_site`, …) are emitted
    // by the engine and have no single definition line; grepping the bare name
    // returns scattered, meaningless string-literal hits. An empty result means
    // "engine-emitted builtin, no .dl rule" — the frontend says so.
    let order = |k: &str| match k {
        "decl" => 0,
        _ => 1, // rule
    };
    sites.sort_by_key(|s| order(&s.kind));
    sites.truncate(20);
    Ok(sites)
}
