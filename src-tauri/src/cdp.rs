// CDP (Chrome DevTools Protocol) browser engine.
//
// We launch a dedicated headless Chrome against a *clone* of the user's real
// Chrome profile (cookies + logins, snapshot at first launch) so pages render
// already signed in, without locking or coupling to their daily browser.
//
// Each browser tab in the app maps to one CDP *target* (a Chrome tab). We attach
// to that target's own websocket, run Page.startScreencast, and forward each JPEG
// frame to the webview as a `cdp-frame` event (the frontend draws it to a canvas,
// same surface the kitty overlay used). Input and resize go the other way as
// Input.dispatch* / Emulation.setDeviceMetricsOverride commands.
//
// Threading: one reader thread per target owns its websocket. Outgoing commands
// arrive on an mpsc channel and are drained between reads (the socket has a short
// read timeout so the loop interleaves reads and writes on the single ws object).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;

const CHROME: &str =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT: u16 = 9333;

/// Build the Page.startScreencast params at a given JPEG quality, pinning the
/// frame to the full device-pixel size (width*dpr × height*dpr) so Chrome sends
/// frames at native resolution instead of downscaling. Higher `quality` = less
/// JPEG graininess at the cost of bytes per frame.
fn screencast_params(width: u32, height: u32, dpr: f64, quality: u8) -> Value {
    let max_w = ((width as f64) * dpr).round() as u32;
    let max_h = ((height as f64) * dpr).round() as u32;
    json!({
        "format": "jpeg",
        "quality": quality,
        "maxWidth": max_w,
        "maxHeight": max_h,
        "everyNthFrame": 1
    })
}

/// One attached Chrome tab.
struct CdpTab {
    target_id: String,
    cmd_tx: Sender<String>,
    stop: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
}

#[derive(Default)]
pub struct CdpStore(Mutex<HashMap<String, CdpTab>>);

/// The shared headless Chrome process. Launched lazily on the first cdp_open and
/// reused by every tab; killed on app exit via kill_engine().
#[derive(Default)]
pub struct ChromeEngine(Mutex<Option<std::process::Child>>);

#[derive(Clone, Serialize)]
struct FrameEvent {
    id: String,
    data: String, // base64 JPEG straight from CDP
}

/// Injected into every page: report the CSS cursor of the element under the
/// pointer over the __cursorSync binding, deduped, so the webview canvas mirrors
/// the page's native cursor (beam over text, hand over links, grabbing during a
/// drag). Fires on move, press, release, and scroll — not just move — so a
/// cursor change *caused by* a click (e.g. :active grabbing) or by content
/// shifting under a stationary pointer propagates immediately. Rides the input
/// we already dispatch, no extra round trips.
const CURSOR_SYNC_JS: &str = r#"(() => {
  if (window.__cursorSyncInstalled) return;
  window.__cursorSyncInstalled = true;
  let last = '', lx = 0, ly = 0;
  const read = (el) => { try { return el && el.nodeType === 1 ? getComputedStyle(el).cursor : 'auto'; } catch (_) { return 'auto'; } };
  const send = (c) => { if (c !== last) { last = c; try { window.__cursorSync(c); } catch (_) {} } };
  const fromEvent = (e) => { lx = e.clientX; ly = e.clientY; send(read(e.target)); };
  const fromPoint = () => send(read(document.elementFromPoint(lx, ly)));
  document.addEventListener('mousemove', fromEvent, true);
  document.addEventListener('mousedown', fromEvent, true);
  document.addEventListener('mouseup', () => requestAnimationFrame(fromPoint), true);
  document.addEventListener('scroll', () => requestAnimationFrame(fromPoint), true);
})();"#;

// ---- profile clone -------------------------------------------------------

/// Where the real Chrome stores its profile.
fn real_chrome_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/Google/Chrome"))
}

/// Clone Local State (holds the os_crypt key) + the Default profile into a
/// dedicated user-data-dir, once. Cookies / Login Data / Local Storage carry the
/// signed-in session; same machine + user means Chrome's Keychain key still
/// decrypts them. Uses APFS copy-on-write (`cp -c`) so it's near-instant and
/// adds no real disk, regardless of profile size.
fn ensure_profile(dest: &PathBuf) -> Result<(), String> {
    if dest.join("Default").exists() {
        return Ok(()); // already cloned
    }
    let src = real_chrome_dir().ok_or("no HOME")?;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;

    // Local State sits at the user-data-dir root.
    let local_state = src.join("Local State");
    if local_state.exists() {
        let _ = std::fs::copy(&local_state, dest.join("Local State"));
    }

    // cp -c uses clonefile() on APFS: a COW clone of the whole Default tree,
    // instant and free. Falls back to a normal copy off-APFS.
    let status = std::process::Command::new("cp")
        .args(["-c", "-R"])
        .arg(src.join("Default"))
        .arg(dest.join("Default"))
        .status()
        .map_err(|e| format!("cp: {e}"))?;
    if !status.success() {
        return Err("cp failed cloning Chrome profile".into());
    }
    Ok(())
}

// ---- engine lifecycle ----------------------------------------------------

/// Remove session-restore artifacts so the headless instance starts blank
/// instead of reopening the user's real tabs. Run before every launch (the
/// running engine rewrites these as it lives).
fn clear_session(profile: &PathBuf) {
    let d = profile.join("Default");
    for f in ["Current Session", "Current Tabs", "Last Session", "Last Tabs"] {
        let _ = std::fs::remove_file(d.join(f));
    }
    let _ = std::fs::remove_dir_all(d.join("Sessions"));
}

/// Kill any headless Chrome we previously launched (matched by our profile dir)
/// that outlived the app — e.g. after a SIGTERM that skipped the exit handler.
pub fn reap_orphans() {
    let _ = std::process::Command::new("pkill")
        .args(["-f", "user-data-dir=.*cdp-chrome"])
        .status();
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Minimal HTTP/1.1 client for the DevTools endpoint. Chrome's DevTools server
/// ignores `Connection: close` and keeps the socket open, so we must read by
/// Content-Length rather than to EOF (else every call blocks until timeout).
/// Avoids pulling in an http-client crate for four trivial localhost calls.
fn http(method: &str, path: &str) -> Result<String, String> {
    let mut stream =
        TcpStream::connect(("127.0.0.1", DEBUG_PORT)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{DEBUG_PORT}\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    // Read until end of headers.
    let head_end = loop {
        if let Some(p) = find_sub(&buf, b"\r\n\r\n") {
            break p + 4;
        }
        let n = stream.read(&mut tmp).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("http {method} {path}: connection closed in headers"));
        }
        buf.extend_from_slice(&tmp[..n]);
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let status = head.lines().next().unwrap_or("");
    if !status.contains(" 200") && !status.contains(" 201") {
        return Err(format!("http {method} {path}: {status}"));
    }
    let clen: usize = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case("content-length").then(|| v.trim().parse().ok())?
        })
        .unwrap_or(0);

    // Read the body up to Content-Length.
    while buf.len() < head_end + clen {
        let n = stream.read(&mut tmp).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    Ok(String::from_utf8_lossy(&buf[head_end..(head_end + clen).min(buf.len())]).to_string())
}

fn http_get(path: &str) -> Result<String, String> {
    http("GET", path)
}

/// Block until the DevTools HTTP endpoint answers (Chrome finished booting).
fn wait_devtools(secs: u64) -> Result<(), String> {
    for _ in 0..(secs * 10) {
        if http_get("/json/version").is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("Chrome DevTools port never came up".into())
}

/// Launch the shared Chrome if it isn't already running.
fn ensure_engine(app: &AppHandle) -> Result<(), String> {
    // Already up? (our child this session, or a leftover on the port)
    {
        let eng = app.state::<ChromeEngine>();
        if eng.0.lock().unwrap().is_some() {
            return Ok(());
        }
    }
    if http_get("/json/version").is_ok() {
        return Ok(()); // someone's already serving the port
    }

    let profile = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cdp-chrome");
    ensure_profile(&profile)?;
    clear_session(&profile); // don't restore the user's real tabs each launch

    let child = std::process::Command::new(CHROME)
        .args([
            "--headless=new",
            &format!("--remote-debugging-port={DEBUG_PORT}"),
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check",
            "--no-startup-window",
            "--disable-session-crashed-bubble",
            "--hide-crash-restore-bubble",
            "--disable-features=Translate",
            "--hide-scrollbars",
        ])
        .arg(format!("--user-data-dir={}", profile.display()))
        .spawn()
        .map_err(|e| format!("launch chrome: {e}"))?;

    let eng = app.state::<ChromeEngine>();
    *eng.0.lock().unwrap() = Some(child);
    wait_devtools(15)
}

/// Kill the shared Chrome (called on app exit).
pub fn kill_engine(app: &AppHandle) {
    let child = {
        let eng = app.state::<ChromeEngine>();
        let taken = eng.0.lock().unwrap().take();
        taken
    };
    if let Some(mut c) = child {
        let _ = c.kill();
    }
}

// ---- per-target attach ---------------------------------------------------

/// Create a fresh target (tab) and return (target_id, ws_url).
fn new_target(url: &str) -> Result<(String, String), String> {
    // Newer Chrome wants PUT for /json/new; the query is the start URL.
    let resp = http("PUT", &format!("/json/new?{url}"))?;
    let v: Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    let tid = v["id"].as_str().ok_or("no target id")?.to_string();
    let ws = v["webSocketDebuggerUrl"]
        .as_str()
        .ok_or("no ws url")?
        .to_string();
    Ok((tid, ws))
}

fn set_read_timeout(ws: &tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) {
    if let MaybeTlsStream::Plain(s) = ws.get_ref() {
        let _ = s.set_read_timeout(Some(Duration::from_millis(20)));
    }
}

/// True when a ws read error is just the idle read-timeout (no data this tick).
fn is_timeout(e: &tungstenite::Error) -> bool {
    if let tungstenite::Error::Io(io) = e {
        matches!(
            io.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        )
    } else {
        false
    }
}

// ---- commands ------------------------------------------------------------

/// Thin command: returns immediately. The heavy work (profile clone, Chrome
/// launch, DevTools wait, ws connect) runs on a worker thread so the Tauri main
/// thread never blocks — non-async commands run on the main thread, and blocking
/// it spins the whole UI. Frames/errors arrive later via events.
#[tauri::command]
pub fn cdp_open(
    app: AppHandle,
    store: State<CdpStore>,
    id: String,
    url: String,
    width: u32,
    height: u32,
    dpr: f64,
    quality: u8,
) -> Result<(), String> {
    if store.0.lock().unwrap().contains_key(&id) {
        return Ok(());
    }
    std::thread::spawn(move || {
        if let Err(e) = attach(app.clone(), id.clone(), url, width, height, dpr, quality) {
            let _ = app.emit("cdp-error", json!({ "id": id, "error": e }));
        }
    });
    Ok(())
}

/// Blocking attach, run off the main thread by cdp_open.
fn attach(
    app: AppHandle,
    id: String,
    url: String,
    width: u32,
    height: u32,
    dpr: f64,
    quality: u8,
) -> Result<(), String> {
    ensure_engine(&app)?;
    let store = app.state::<CdpStore>();
    if store.0.lock().unwrap().contains_key(&id) {
        return Ok(());
    }
    let (target_id, ws_url) = new_target(&url)?;
    // Chrome 111+ rejects the DevTools ws unless the Origin is allowlisted (we
    // launch with --remote-allow-origins=*); tungstenite sends none by default.
    let mut req = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    req.headers_mut()
        .insert("Origin", "http://localhost".parse().unwrap());
    let (mut ws, _) = tungstenite::connect(req).map_err(|e| e.to_string())?;
    set_read_timeout(&ws);

    let (cmd_tx, cmd_rx) = channel::<String>();
    let stop = Arc::new(AtomicBool::new(false));
    let next_id = Arc::new(AtomicU64::new(1));

    // Boot sequence: enable Page, set the viewport, start the JPEG screencast.
    let boot_id = next_id.clone();
    let mut send_boot = |method: &str, params: Value| {
        let n = boot_id.fetch_add(1, Ordering::Relaxed);
        let _ = ws.send(Message::Text(
            json!({ "id": n, "method": method, "params": params }).to_string().into(),
        ));
    };
    send_boot("Page.enable", json!({}));
    // Headless tabs aren't "focused" by default, so keyboard input is dropped;
    // bringToFront gives the page input focus.
    send_boot("Page.bringToFront", json!({}));
    // Native cursor mirroring: a page binding + a mousemove listener report the
    // CSS cursor under the pointer. addBinding must precede the script that calls
    // it; addScriptToEvaluateOnNewDocument covers future navigations, and the
    // evaluate installs it on the already-loaded current document.
    send_boot("Runtime.enable", json!({}));
    send_boot("Runtime.addBinding", json!({ "name": "__cursorSync" }));
    send_boot(
        "Page.addScriptToEvaluateOnNewDocument",
        json!({ "source": CURSOR_SYNC_JS }),
    );
    send_boot("Runtime.evaluate", json!({ "expression": CURSOR_SYNC_JS }));
    send_boot(
        "Emulation.setDeviceMetricsOverride",
        json!({ "width": width, "height": height, "deviceScaleFactor": dpr, "mobile": false }),
    );
    send_boot("Page.startScreencast", screencast_params(width, height, dpr, quality));
    let _ = boot_id; // (silence move warnings)

    let app2 = app.clone();
    let id2 = id.clone();
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        loop {
            if stop2.load(Ordering::Relaxed) {
                let _ = ws.send(Message::Text(
                    json!({ "id": 999999, "method": "Page.stopScreencast" }).to_string().into(),
                ));
                let _ = ws.close(None);
                break;
            }
            // Drain outgoing commands.
            while let Ok(msg) = cmd_rx.try_recv() {
                let _ = ws.send(Message::Text(msg.into()));
            }
            match ws.read() {
                Ok(Message::Text(txt)) => {
                    if let Ok(v) = serde_json::from_str::<Value>(txt.as_str()) {
                        if v["method"] == "Runtime.bindingCalled"
                            && v["params"]["name"] == "__cursorSync"
                        {
                            let c = v["params"]["payload"].as_str().unwrap_or("default");
                            let _ = app2.emit(
                                "cdp-cursor",
                                json!({ "id": id2.clone(), "cursor": c }),
                            );
                        } else if v["method"] == "Page.frameNavigated"
                            && v["params"]["frame"]["parentId"].is_null()
                        {
                            // Main-frame full navigation (link click, redirect,
                            // form submit). parentId null = top frame.
                            if let Some(u) = v["params"]["frame"]["url"].as_str() {
                                let _ = app2.emit(
                                    "cdp-url",
                                    json!({ "id": id2.clone(), "url": u }),
                                );
                            }
                        } else if v["method"] == "Page.navigatedWithinDocument" {
                            // SPA / history.pushState same-document navigation.
                            if let Some(u) = v["params"]["url"].as_str() {
                                let _ = app2.emit(
                                    "cdp-url",
                                    json!({ "id": id2.clone(), "url": u }),
                                );
                            }
                        } else if v["method"] == "Page.screencastFrame" {
                            let data = v["params"]["data"].as_str().unwrap_or("");
                            let session = v["params"]["sessionId"].clone();
                            let _ = app2.emit(
                                "cdp-frame",
                                FrameEvent { id: id2.clone(), data: data.to_string() },
                            );
                            // Ack so Chrome keeps sending frames.
                            let _ = ws.send(Message::Text(
                                json!({
                                    "id": 999998,
                                    "method": "Page.screencastFrameAck",
                                    "params": { "sessionId": session }
                                })
                                .to_string()
                                .into(),
                            ));
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(e) if is_timeout(&e) => {}
                Err(_) => break,
            }
        }
    });

    store.0.lock().unwrap().insert(
        id,
        CdpTab { target_id, cmd_tx, stop, next_id },
    );
    Ok(())
}

/// Generic CDP command pump for a tab (frontend builds Input.dispatch*, etc.).
#[tauri::command]
pub fn cdp_send(
    store: State<CdpStore>,
    id: String,
    method: String,
    params: Value,
) -> Result<(), String> {
    let map = store.0.lock().unwrap();
    let tab = map.get(&id).ok_or("no such cdp tab")?;
    let n = tab.next_id.fetch_add(1, Ordering::Relaxed);
    let msg = json!({ "id": n, "method": method, "params": params }).to_string();
    tab.cmd_tx.send(msg).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cdp_resize(
    store: State<CdpStore>,
    id: String,
    width: u32,
    height: u32,
    dpr: f64,
    quality: u8,
) -> Result<(), String> {
    let map = store.0.lock().unwrap();
    let tab = map.get(&id).ok_or("no such cdp tab")?;
    let send = |method: &str, params: Value| {
        let n = tab.next_id.fetch_add(1, Ordering::Relaxed);
        let _ = tab
            .cmd_tx
            .send(json!({ "id": n, "method": method, "params": params }).to_string());
    };
    send(
        "Emulation.setDeviceMetricsOverride",
        json!({ "width": width, "height": height, "deviceScaleFactor": dpr, "mobile": false }),
    );
    // Restart the screencast so frames come at the new size/quality immediately.
    send("Page.stopScreencast", json!({}));
    send("Page.startScreencast", screencast_params(width, height, dpr, quality));
    Ok(())
}

#[tauri::command]
pub fn cdp_navigate(store: State<CdpStore>, id: String, url: String) -> Result<(), String> {
    cdp_send(store, id, "Page.navigate".into(), json!({ "url": url }))
}

#[tauri::command]
pub fn cdp_close(app: AppHandle, store: State<CdpStore>, id: String) {
    // Setting stop makes the reader thread close its ws and exit promptly. The
    // /json/close HTTP call can block (DevTools is occasionally slow to answer),
    // so run it on a worker thread — this command runs on the Tauri main thread
    // and blocking it freezes the whole UI (the "spinning beachball" on close).
    if let Some(tab) = store.0.lock().unwrap().remove(&id) {
        tab.stop.store(true, Ordering::Relaxed);
        let target_id = tab.target_id;
        std::thread::spawn(move || {
            let _ = http_get(&format!("/json/close/{}", target_id));
        });
        let _ = app; // engine stays up for other tabs
    }
}
