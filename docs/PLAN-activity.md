# Plan: activity capture + fzf history + XP context menu

Reference project: `~/projects/claude-research/screenpipe` — continuous
ScreenCaptureKit capture + OCR with Swift bridges. We adapt the *capture* idea
but trigger **event-driven** (mouse/key gestures) instead of continuous, using
the CGEventTap we already run + the `screencapture` CLI (OS trick). Browser uses
its plugin surface (existing extension); everything else uses OS tricks.

Four asks, one coherent feature: a searchable history of what you interact with.
- A. event-driven screen capture (clicks / dbl / drag-edges / copy / paste)
- B. fzf-style fuzzy search over all events
- C. traversal history (unified timeline)
- D. Windows-XP context-menu replica

## Decision: unify spy + capture + file-opens into ONE event store

Today `spy.rs` owns `spy.db (events)` for browser rows only. fzf (B) and history
(C) want one searchable list, so fold everything into a unified table. `spy.rs`
is absorbed into `activity.rs`; the extension keeps POSTing to `/ingest`, the
handler writes a unified row with `source='browser'`.

### Storage — `activity.db`, one table
```
events(
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,        -- unix ms
  source TEXT NOT NULL,          -- 'browser' | 'os' | 'files'
  kind  TEXT NOT NULL,           -- nav|selection|clipboard | click|dblclick|drag|copy|paste | open
  app   TEXT NOT NULL DEFAULT '',-- frontmost app (os captures)
  url   TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',-- browser title / file name
  text  TEXT NOT NULL DEFAULT '',-- selection/clipboard / file path
  shot  TEXT NOT NULL DEFAULT '' -- screenshot path (os captures)
);
CREATE INDEX idx_events_ts ON events(ts);
```
Prune on insert (RESOLVED — cap by count for shots, ring for text):
- `source='os'` (screenshots): keep newest **2000**; for each row deleted beyond
  the cap, `std::fs::remove_file(shot)` (best-effort). PNGs are heavy → count cap,
  not age.
- `source IN ('browser','files')` (text rows): 7-day ring `DELETE WHERE ts < now - 7d`.

Writes: ingest POST (browser), capture worker (os), file open (files panel →
new `activity_log` command). Reads: `activity_events(limit)` newest-first.
Uniqueness: none enforced; id is the key.

---

## A. Event-driven capture — backend `capture.rs` + tap rework in `lib.rs`

### State (process-lifetime, managed)
```rust
pub struct ActivityDb(pub Mutex<rusqlite::Connection>);       // the unified db
pub struct CaptureEnabled(pub Arc<AtomicBool>);               // default false
```
Gesture state lives in the tap-thread closure (Mutex, because with_enabled takes
`impl Fn`, like the existing `last` cell):
```rust
struct Gesture { last_capture: Option<Instant>, drag_active: bool, last_right_down: Option<Instant> }
const MIN_GAP: Duration = 350ms;   // global throttle across all captures
```

### Tap callback (replaces spawn_right_click_gesture → spawn_input_taps)
Event mask: RightMouseDown (existing summon) + LeftMouseDown + LeftMouseDragged
+ LeftMouseUp + KeyDown. ListenOnly. Reading raw fields only — NO TIS — so the
old rdev keycode-translation crash does not recur.
```rust
// |_proxy, ty, ev| -> CallbackResult::Keep
// match ty {
//   RightMouseDown => existing double-right -> toggle_window (unchanged)
//   LeftMouseDown  => g.drag_active = false
//   LeftMouseDragged => if !g.drag_active { g.drag_active = true; maybe_capture("drag") } // leading edge
//   LeftMouseUp =>
//     if g.drag_active { maybe_capture("drag-end"); g.drag_active = false }      // trailing edge
//     else { let cs = ev.get_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE);
//            maybe_capture(if cs >= 2 {"dblclick"} else {"click"}) }
//   KeyDown => if ev.get_flags().contains(CGEventFlagCommand) {
//                match ev.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) {
//                  8 => maybe_capture("copy"), 9 => maybe_capture("paste"), _ => {} } }
// }
// maybe_capture(kind):
//   if !enabled.load(Relaxed) { return }
//   let now = Instant::now();
//   if let Some(t)=g.last_capture { if now-t < MIN_GAP { return } }  // throttle
//   g.last_capture = Some(now);
//   let app = handle.clone(); thread::spawn(move || capture::take(app, kind));  // OFF the tap thread
```
Edges: drag is a burst → sample only start+end. Clicks/keys → leading edge,
throttled. The capture work (screencapture ~100-300ms) must not run on the tap
thread or it adds input latency → always thread::spawn.

### Capture worker (ephemeral thread, one per shot)
```rust
pub fn take(app: AppHandle, kind: &str)
// ts = now_ms(); day = "YYYY-MM-DD"(ts);
// dir = app_data_dir/captures/<day>;  create_dir_all
// shot = dir/<ts>-<kind>.png
// Command::new("/usr/sbin/screencapture").args(["-x","-t","png", &shot]).status()  // silent, full screen
// app_name = frontmost_app();   // best-effort
// { let c = app.state::<ActivityDb>().0.lock(); insert(source='os', kind, app=app_name, shot, ts); prune(c); }
// app.emit("activity-added", row)
fn frontmost_app() -> String
//  lsappinfo front -> ASN ; lsappinfo info -only name <ASN> -> "name"="X"  (parse; "" on failure)
```

### Commands
```rust
#[command] capture_set_enabled(state: State<CaptureEnabled>, on: bool)   // store.persist on front
#[command] capture_enabled(state: State<CaptureEnabled>) -> bool
#[command] activity_events(db: State<ActivityDb>, limit: Option<i64>, source: Option<String>) -> Vec<Event>
#[command] activity_clear(db: State<ActivityDb>)
#[command] activity_log(db, source, kind, title, text)   // files panel logs "open" rows
// /ingest handler -> insert(source='browser', ...)  (moved from spy.rs)
```

### Permissions / safety
- screencapture → Screen Recording permission (granted once, first shot).
- tap → Accessibility/Input Monitoring (already required by summon).
- Capture default **OFF**; user enables in panel; flag persisted.
- KeyDown acted on ONLY for Cmd+C / Cmd+V keycodes — not a keylogger.
- Ring prune deletes rows + orphan PNGs past RETAIN_DAYS.

---

## A2. Browser DOM + tab events — extend the extension (plugin surface)

Browser = plugin surface, so capture richer context than OS tricks can: the DOM
target, link href, modifier keys, and *why* a tab opened (opener). All POST to
`/ingest` with `source='browser'`, new `kind`s, into the same unified table.

### content.js — DOM interaction listeners (per page)
```
click       -> kind 'click'    | ctrl/cmd-click -> kind 'ctrlclick'
dblclick    -> kind 'dblclick'
dragstart   -> kind 'drag'
contextmenu -> kind 'rclick'
copy        -> kind 'clipboard' (existing) ; selectionchange -> 'selection' (existing)
```
payload per event:
- `url` = location.href, `title` = document.title
- `text` = `"${tag}#${id}.${cls}" "${trimmed innerText, 80}" ${href||''} ${mods}`
  where mods = any of [ctrl,cmd,shift,alt] held (from MouseEvent.ctrlKey/metaKey/…)
- throttle per kind in content.js (e.g. 300ms) so click storms don't flood; drag
  fires once on dragstart (edge). relay via chrome.runtime.sendMessage (only the
  worker can reach http-localhost).

### background.js — tab lifecycle ("why a tab opened")
```
chrome.tabs.onCreated(tab)            -> kind 'tabopen'
   url=tab.pendingUrl||tab.url, title=opener url, text=`opened from tab ${tab.openerTabId}`
chrome.webNavigation.onCreatedNavigationTarget(d)  // the real "why": source frame -> new tab
   -> kind 'tabopen', url=d.url, text=`source tab ${d.sourceTabId}`   // ctrl-click / target=_blank / window.open
chrome.tabs.onActivated({tabId})      -> kind 'tabswitch' (throttled)  -> title/url via tabs.get
chrome.tabs.onUpdated complete (existing) -> kind 'nav'
chrome.tabs.onRemoved                 -> kind 'tabclose'
```

### manifest.json deltas
`permissions += ["webNavigation"]` (tabs already present). host_permissions
unchanged. New kinds need no schema change — unified `kind` column is free text.

Activity panel source filter `browser` now shows nav + clicks + ctrl-clicks +
drags + tab opens/switches with their "why" in the text column; fzf searches it.

---

## B. fzf-style search — frontend `src/fuzzy.ts`
```ts
export function fuzzyScore(query: string, text: string): number | null
//  subsequence match, case-insensitive; null if not all query chars match in order.
//  bonuses: consecutive run, word-start (after / _ - space . or camelHump), prefix.
//  penalty: leading gap, total gaps. higher = better.
export function fuzzyFilter<T>(query: string, rows: T[], key: (r: T) => string): T[]
//  if !query.trim() return rows;  map->score->filter(non-null)->sort desc->return rows
```
Applied client-side over the loaded events (cap ~2000) in the Activity panel. A
search input filters live on input. True fzf feel without SQLite FTS; revisit FTS
only if histories blow past a few thousand rows.

---

## C. traversal history — the Activity panel IS the timeline
One panel, replaces the "Spy" panel/toggle (renamed **Activity**):
- top bar: search input (B) + source filter chips [all|browser|os|files] +
  Recording ON/OFF toggle (capture_set_enabled) + Clear + count.
- table (renderTable): time · source · kind · app/source · title/text. Newest
  first; fuzzy-filtered.
- preview pane: if row.shot → read_image(shot) thumbnail; if browser → url/title.
- row click pastes text/url into active terminal (existing pasteToActive);
  dbl-click on a file/open row → browseTo / reveal.
- files panel opens call `activity_log(source='files', kind='open', ...)` so file
  references join the same history.

### state.ts deltas
```ts
type Panel = "terminal" | "worktrees" | "files" | "activity";   // spy -> activity
interface Event { id; ts; source; kind; app; url; title; text; shot }
AppState += {
  activity: Event[];            // runtime
  activitySource: "all"|"browser"|"os"|"files";  // persisted
  activityQuery: string;        // runtime (search box)
  captureEnabled: boolean;      // persisted (mirror of backend flag)
}
PERSIST += ["activitySource","captureEnabled"]
```
Listener `activity-added` prepends (cap 2000). Lazy load on panel open.

---

## D. Windows-XP context menu — frontend `src/ctxmenu.ts`
Suppress the webview's native menu; render our own, styled per skin (XP = classic
raised white menu, blue hover; P5/AC3 themed via tokens).
```ts
type CtxItem = { label: string; action: () => void; disabled?: boolean } | { sep: true };
export function showContextMenu(x: number, y: number, items: CtxItem[]): void
//  build #ctx-menu div, abs-position (flip near right/bottom edge), render items,
//  outside-click / Esc / scroll / blur -> dismiss.
function ctxItemsFor(target: HTMLElement): CtxItem[]
//  terminal  -> [Paste, Clear, sep, Screenshot region]
//  file row  -> [Open, Paste path, Reveal in Finder(opener), sep, Copy path]
//  event row -> [Paste text/url, Copy, sep, Open shot]
//  default   -> [New session, sep, Cycle skin, Toggle dark]
```
Wire once in main: `document.addEventListener("contextmenu", e => { e.preventDefault();
showContextMenu(e.clientX, e.clientY, ctxItemsFor(e.target)) })`. Note: the
global right-click *gesture* tap is ListenOnly and independent of the webview
contextmenu; double-right still summons.

### styles.css — `.ctx-menu`
XP: `background:#fff; border:1px solid #aca899; box-shadow:2px 2px 2px rgba(0,0,0,.3);`
item `padding:3px 24px; font-size:11px;` hover `background:#316ac5; color:#fff;`
sep `border-top:1px solid #d4d0c8`. P5/AC3: token-driven (frame, row-active-bg).

---

## Commit slices (each: tsc + cargo clean, app alive, commit)
1. `activity.rs`: unified db, absorb spy ingest, activity_events/clear/log + migrate frontend Spy→Activity panel (no capture yet).
2. capture: CaptureEnabled + tap rework + capture::take + Recording toggle + shot preview + setup card (Screen Recording perm).
3. `fuzzy.ts` + search box + source chips.
4. `ctxmenu.ts` + XP context menu + styles.
5. files panel logs `open` rows into activity.

## Resolved decisions
- **Unify**: yes — one `activity.db`, spy.rs absorbed, Spy panel → Activity.
- **Retention**: os shots capped by count = newest **2000** (delete row + PNG
  beyond cap); browser/files text rows = 7-day ring.
- **App name**: yes — tag each shot via `lsappinfo front` → name (best-effort).

## Still open (decide at build, non-blocking)
- Capture all displays vs main only: `screencapture -x` = main display; multi-display later.
- fzf over SQLite FTS only if histories exceed a few thousand rows (client-side until then).
