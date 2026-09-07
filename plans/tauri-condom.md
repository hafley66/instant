# Tauri condom: the app runs and is tested without Tauri in the loop

1. Goal
2. Coupling, counted
3. Type signatures
4. Pseudo-code bodies
5. Instance lifetimes
6. Storage layout, read/write sequence, uniqueness
7. Lanes and file ownership
8. Deletions
9. Validation

## 1. Goal

One frontend bundle, one Rust command table. Tauri supplies a window and one transport.
A second transport (WebSocket on loopback) serves the same command table from a plain
binary, so Playwright drives `index.html` in Chromium against the real backend, sidebars
and all. No fake backend path survives.

## 2. Coupling, counted (2026-09-07)

| side | surface | count |
| --- | --- | --- |
| frontend | `@tauri-apps/*` direct importers | 9 files |
| frontend | `invoke(` sites, all via `src/reactive/nativeTransport.ts` | 49 in 15 files |
| frontend | `listen`/`emit` sites | 17 |
| backend | `#[tauri::command]` fns | 107 in 20 files |
| backend | `app.emit(` | 16 |
| backend | `app.get_webview_window(` | 10 |
| backend | `app.manage(` | 7 |
| backend | `app.path(` | 1 |
| backend | tray, shortcut, activation policy, exit (shell only, `lib.rs`) | 6 |
| backend | `State<T>` types | 12 |

## 3. Type signatures

```rust
// src-tauri/src/host.rs
pub trait Host: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String>;
    fn window(&self, label: &str) -> Option<Box<dyn HostWindow>>;
    fn app_data_dir(&self) -> Result<PathBuf, String>;
    fn debug_build(&self) -> bool;
}
pub trait HostWindow {
    fn show(&self) -> Result<(), String>;
    fn hide(&self) -> Result<(), String>;
    fn set_focus(&self) -> Result<(), String>;
    fn inner_size(&self) -> Result<(u32, u32), String>;
    fn set_ignore_cursor_events(&self, ignore: bool) -> Result<(), String>;
}
pub struct TauriHost(pub tauri::AppHandle);          // prod
pub struct ServeHost { tx: broadcast::Sender<Event>, data_dir: PathBuf } // instant-serve

// every command: no tauri types in the signature
pub fn run_click(host: &dyn Host, st: &Services, p: RunClickParams) -> Result<String, String>;

// src-tauri/src/services.rs: the twelve State<T> in one struct
pub struct Services { pub pty: PtyStore, pub cdp: CdpStore, pub activity: ActivityDb, /* ... */ }

// src-tauri/src/bin/instant-serve.rs
fn main() -> Result<(), Box<dyn Error>>;   // jsonrpsee ws server on 127.0.0.1:<port>, one method per command name, one subscription "events"
```

```ts
// src/reactive/nativeTransport.ts
export interface NativeTransport {
  invoke<T>(command: CommandName, args?: NativeCommandInput): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<NativeUnlistenFn>;
}
export function tauriTransport(): NativeTransport;
export function wsTransport(url: string): NativeTransport;
export function pickTransport(): NativeTransport; // __TAURI_INTERNALS__ ? tauri : ws(location.search ws=)

// src/reactive/ports.ts: every direct @tauri-apps import lives behind this
export interface RuntimePorts {
  openPath(path: string): Promise<void>;
  revealItemInDir(path: string): Promise<void>;
  window: { hide(): Promise<void>; minimize(): Promise<void>; toggleMaximize(): Promise<void>; startDragging(): Promise<void>; setIgnoreCursorEvents(b: boolean): Promise<void>; setSize(w: number, h: number): Promise<void> };
  webview: { setZoom(z: number): Promise<void>; onDragDrop(cb: (e: DragDropEvent) => void): Promise<() => void> };
}
export function tauriPorts(): RuntimePorts;
export function browserPorts(transport: NativeTransport): RuntimePorts; // window ops become commands or no-ops with a logLine
```

## 4. Pseudo-code bodies

```rust
// tauri wrapper, generated from ipc/commands.json by the same script that emits native.ts
#[tauri::command]
fn run_click(app: AppHandle, st: State<Services>, p: RunClickParams) -> Result<String, String> {
    // host = TauriHost(app); commands::run_click(&host, &st, p)
}

// instant-serve main
// services = Services::boot(data_dir)
// host = ServeHost::new(data_dir)
// module = RpcModule::new((host, services))
// for name in COMMANDS: module.register_method(name, |params, ctx| dispatch(name, ctx.0, ctx.1, params))
// module.register_subscription("events", ..., |sink, ctx| forward ctx.0.rx() into sink)
// serve on 127.0.0.1:port; print port on stdout for playwright's webServer
```

```ts
// wsTransport
// client = new WebSocket(url); pending = Map<id, {resolve, reject}>
// invoke: id++, send {jsonrpc, id, method: command, params: args}, return promise from pending
// listen: on first call subscribe "events"; route by event name to callbacks
// pickTransport: window.__TAURI_INTERNALS__ ? tauriTransport() : wsTransport(new URLSearchParams(location.search).get("ws") ?? "ws://127.0.0.1:47777")
```

## 5. Instance lifetimes

| type | created | lives | dropped |
| --- | --- | --- | --- |
| `Services` | once at boot (Tauri `setup` or serve `main`) | process | process exit |
| `TauriHost` | per command call, wraps a cloned `AppHandle` | one call | end of call |
| `ServeHost` | once in serve `main` | process | exit |
| `NativeTransport` (ts) | once at module load via `pickTransport()` | page | page unload |
| ws connection | on transport creation, reconnects with backoff | page | unload |

## 6. Storage layout, read/write sequence, uniqueness

- No new persistent storage. `Services` owns the same sqlite and tmux state as today, keyed by `app_data_dir()` from the host.
- Sequence per command: transport request -> dispatch by name -> command fn reads/writes `Services` -> result back; events emitted through `Host::emit` during the call reach the same page through the same transport.
- Uniqueness: one `Services` per process; one transport per page; command names unique in `ipc/commands.json` (already enforced by the generator).
- `instant-serve` and the Tauri app must not share a data dir at the same time: serve takes `--data-dir` and Playwright points it at a temp dir per run.

## 7. Lanes and file ownership (disjoint)

| lane | owns | model |
| --- | --- | --- |
| host-trait | `src-tauri/src/host.rs`, `services.rs`, edits in `activity.rs`, `cdp.rs`, `workspace.rs`, `pty.rs`, `favorites.rs`, `fs_watch.rs`, `config.rs`, `capture.rs`, `0_pty_events.rs`, `refresolve.rs`, `meme.rs` | pro4 |
| command-wrappers | `scripts/` generator, `ipc/commands.json`, `src-tauri/src/lib.rs` registration | flash4 |
| serve-bin | `src-tauri/src/bin/instant-serve.rs`, `Cargo.toml` (jsonrpsee) | pro4 |
| ts-transport | `src/reactive/nativeTransport.ts`, `src/reactive/ports.ts`, the 9 direct importers | flash4 |
| playwright-real | `playwright.real.config.ts`, `e2e-real/*.spec.ts` (fork flow, screenshots) | flash4 |

## 8. Deletions

- `browserE2eInvoke` and `__instantE2eNativeResults` in `nativeTransport.ts`.
- `e2e-*.html` pages that only exist to feed that path, once `e2e-real` covers their specs.
- `e2e-native/`, `wdio.native.conf.ts`, `@wdio/*` deps.

## 9. Validation

```
cargo build -p instant --bin instant-serve
cargo test -p instant
pnpm exec tsc --noEmit -p .
pnpm exec vitest run
pnpm exec playwright test -c playwright.real.config.ts   # boots instant-serve, drives index.html in Chromium, writes artifacts/real/*.png
```
