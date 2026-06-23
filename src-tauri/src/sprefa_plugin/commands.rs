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

/// `<root>/.dl/daemon.sock`, with `~` expanded against $HOME.
fn socket_path(root: &str) -> PathBuf {
    expand(root).join(".dl").join("daemon.sock")
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

/// Evaluate a scratch `.dl` snippet against a throwaway engine (runtime-only
/// relations; nothing persists). Returns `{ok, results: [{rel, columns, rows}],
/// diagnostics: [...]}`.
#[tauri::command]
pub fn sprefa_eval(root: String, text: String) -> Result<Value, String> {
    rpc(&root, "eval", json!({ "text": text }))
}

/// Raw parameterized SQL: `{rows: [[Value]]}`.
#[tauri::command]
pub fn sprefa_query_sql(root: String, sql: String, params: Vec<Value>) -> Result<Value, String> {
    rpc(&root, "query_sql", json!({"sql": sql, "params": params}))
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
pub fn sprefa_rel_source(root: String, rel: String) -> Result<Vec<RelSite>, String> {
    let base = expand(&root);
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
