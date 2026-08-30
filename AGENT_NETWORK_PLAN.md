# Agent Network Plan: Marbler-style temporal inter-agent network visualizer for Instant

Status: drafting. Updated after every 3-5 inspection commands.

## TOC

1. Existing Marbler primitives and exact reusable APIs
2. Existing Boop/boop-mux event and relationship contracts
3. Required data model and exact TypeScript/Rust signatures
4. Event normalization and stable identity rules
5. Instance timelines and lifetimes
6. Storage, reads, writes, polling/streaming, ordering, deduplication
7. Visual grammar: nodes, edges, lanes, time, selection, filtering, animation
8. Grid/tree and visualization synchronization
9. Instant panel/tab/plugin composition
10. File-by-file implementation sequence with numeric dependency prefixes
11. Deterministic fixtures, snapshots, image receipts, and gates
12. Performance bounds and failure states
13. Decisions requiring user input

## 1. Existing Marbler primitives and exact reusable APIs

Package: `@hafley66/marbler` at `~/projects/hafley-rxjs/packages/marbler` (read-only).
Deps: `@hafley66/grid` (workspace), `@hafley66/signals` (workspace), `@tanstack/react-table` ^9.1, `pixi.js` ^8.19, `zod` ^4.4, `rxjs` ^7.8, React 19.

### 1.1 Reusable modules (exact paths, exports)

| Module | Exports | Reuse for agent network |
| --- | --- | --- |
| `src/0a_TimeViewport.ts` | `TimeRange`, `TimeViewport {full, visible, followLive}`, `TimelineMark` (dot / span / link), `TimelineGesture` (pan / zoom / brush / fit / follow / full), `eventRange(events)`, `createTimeViewport(full)`, `reduceTimeViewport(state, gesture)`, `densityBuckets(marks, full, count): Uint32Array` | Time axis state machine: pan, cursor-anchored zoom, live-follow, fit, brush. `TimelineMark` already has `dot.variant: "next" \| "complete" \| "error" \| "suppressed"` and `link {from:{time,lane}, to:{time,lane}}` — exactly the spawn/hail/completion edge shape. |
| `src/1b_TimeNavigatorPixi.tsx` | `TimeNavigatorPixi({marks, viewport, highlightedId, laneLabels, onMarkHover, onGesture})` | Overview strip: density histogram, per-lane rows (`laneLabels`), dots with variants (next=blue dot, complete=green tick, error=red x, suppressed=hollow), spans, bezier links between lanes, viewport window + drag pan + wheel zoom + dblclick fit. Cull: marks only drawn when `marks.length <= width * 4`. |
| `src/1a_WaterfallPixi.tsx` | `WaterfallPixi({rows: MarbleEvent[], scroller, domain, onEventHover, onEventSelect})` | Retained WebGL phase-bar renderer, viewport-clipped to scroller, `ROW_HEIGHT=44`, phase colors `queue 0x777f8b, send 0xd59b47, wait 0x8e57bc, receive 0x3f8dbd, work 0x49a56b`. Hit-test by row index + time. |
| `src/0_types.ts` | `PhaseSchema {kind, start, end}`, `MarbleEventSchema {id, name, method, status, type, initiator, size, start, duration, from, to, preview, phases}`, `EventFilter = "all" \| "request" \| "result" \| "tool" \| "note"` | Row contract. `from`/`to`/`initiator` are the sender/receiver fields; `phases` are the per-event timing bars. |
| `src/1_model.ts` | `createMarbler(seed: MarbleEvent[]): Marbler` → `{source, filter, selectedId, hoveredId, viewport, rows, grid}`; `Marbler = ReturnType<typeof createMarbler>` | Signal model: `source: Signal<MarbleEvent[]>`, `filter: Signal<EventFilter>`, `selectedId/hoveredId: Signal<string|null>`, `viewport: Signal<TimeViewport>`, `rows` (filtered), `grid: Grid<MarbleEvent>` via `createGrid` with `mode: "client"`. |
| `src/2_Marbler.tsx` | `MarblerPanel = SignalReact(MarblerView)`; `MarblerView({model})` | Reference composition: toolbar + subtoolbar (filter chips + phase legend) + `TimeNavigatorPixi` + DOM grid rows (from `useGrid(model.grid).getRowModel().rows`) + `WaterfallPixi` overlay + details drawer. |
| `src/2a_DemoViz.tsx` | `GitMergeDemo`, `ObservableKindsDemo`, `TimelineTreeDemo({marks, lanes, full})` | Reference for lane+link topology: lanes array → `laneLabels`, entries → dot marks, edges → `link` marks. `GitMergeDemo` is the closest existing analog of a parent/child spawn graph (main/feature branches with merge links). |
| `src/3_demo.tsx`, `src/3_main.tsx` | demo app entry | Fixture wiring only. |

### 1.2 Grid package APIs used by marbler (exact)

`@hafley66/grid` at `~/projects/hafley-rxjs/packages/grid`:

- `createGrid<TData extends RowData>(config: GridConfig<TData>): Grid<TData>` — `src/2_createGrid.ts:58`. Config: `schema: z.ZodType<TData>`, `rows: Signal<TData[]>`, `columnDefs?: ColumnDef<GridFeatures, TData>[]`, `getRowId`, `getSubRows?`, `getRowCanExpand?`, `mode: "client" | "server"`, `state?: Signal<GridState>`, `sync?: {key}` (URL devalue blob). Client mode sorts rows via `lodash/orderBy` on `state.sorting`.
- `Grid<TData>` — `src/1_types.ts:79`: `schema, state: Signal<GridState>, events: Signal<GridEvent|undefined>, rows: Signal<TData[]>, columns, mode, getRowId, getSubRows?, getRowCanExpand?` + 11 `on*Change` handlers. `GridState` = sorting, columnFilters, globalFilter, columnOrder, columnPinning, columnVisibility, columnSizing, rowPinning, rowSelection, expanded, grouping, pagination.
- `useGrid(grid)` — `src/3_react.ts:6`: `useTable` with `gridFeatures`, `autoResetExpanded: false`, `manualSorting: true`.
- `GridTable({grid, density, maxHeight})` — `src/4_grid.tsx:24`: flat DOM table; column-id conventions `__expand` = depth toggle, `name` = depth indent.
- `GridTree({grid, indentUnit, rowHeight, label, width, onRowClick, renderIcon, renderLabel})` — `src/6_tree.tsx:52`: tree surface for rows with `getSubRows`; requires `TData & {name: string; kind?: string}`; `kind: "folder"|"dir"` renders folder icon, else file/node icon.
- `createDefaultGridState(overrides?)`, `gridStateParam: Param<GridState>` (devalue URL sync) — `src/2_createGrid.ts:14,32`.

### 1.3 Receipt/benchmark conventions (copy for section 11)

- Browser tests: `vitest --config vitest.browser.config.ts` (Playwright chromium), `toMatchScreenshot` PNGs under `src/__screenshots__/<testfile>/<name>-chromium-darwin.png`, viewport 1440×900.
- `2_Marbler.browser.test.tsx`: inline snapshot of canvas/host counts, hover cross-highlight assertions (`model.hoveredId.$()` after pointer events on navigator and waterfall), `data-mark-count` attribute poll after source append.
- `2_TimeNavigator.browser.test.tsx`: 100k-mark chaos, CDP `Performance.getMetrics` heap after `HeapProfiler.collectGarbage`, frame p95 via 90 rAF samples (first 5 discarded).
- `benchmarks/*.md`: table of measurements + raw JSON receipt block. `2_PixiRetained.browser.test.ts` is the executable 10s retained-renderer benchmark (951 changes → 834 renders, 12.3% coalesced, p95 draw 2.2 ms).

### 1.4 What marbler does NOT provide (must be built in Instant)

- No node/agent identity: `MarbleEvent` is a flat event list; lanes are `lane % 5` index, not entities.
- No tree/containment: no `getSubRows` usage; grid rows are flat.
- No edge list as first-class data: `link` marks exist but are hand-built per demo; no from/to edge model with status.
- No live source: seed array only; no polling/streaming adapter.
- No persistence of viewport/filter/selection across reloads (grid `sync` exists but marbler does not use it).

## 2. Existing Boop/boop-mux event and relationship contracts

Boop crate: `~/projects/hafley-rs/crates/boop` (read-only). Store: `~/.agent/boop.db` (SQLite, rusqlite). Library entry: `boop::open_default() -> Result<Store>` (`src/lib.rs:71`). Feature `agent-read` gates the read projections.

### 2.1 SQLite schema (exact DDL, `src/ident.rs:1639-1876`)

Dictionary tables (all `id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE`): `dict_session`, `dict_harness`, `dict_cwd`, `dict_branch`, `dict_role`, `dict_path`, `dict_verb`, `dict_program`, `dict_url`, `dict_domain`, `dict_netkind`, `dict_skill`, `dict_pr`, `dict_edekind`, `dict_agenttype`, `dict_status`, `dict_pane`, `dict_model`, `dict_service_tier`, `dict_price_source`, `dict_record`, `dict_trace`, `dict_attach`; plus `dict_request(message_id TEXT NOT NULL, request_id TEXT NOT NULL DEFAULT '', UNIQUE(message_id, request_id))`.

Fact tables:

```sql
agent_trace(trace_id INTEGER PRIMARY KEY, root_session_id INTEGER, started_ts INTEGER NOT NULL)
agent_trace_span(session_id INTEGER PRIMARY KEY, trace_id INTEGER NOT NULL,
                 attach_id INTEGER NOT NULL, attached_ts INTEGER NOT NULL)   -- idx_span_trace(trace_id)
agent_lane(spawn_id INTEGER PRIMARY KEY, lane_id INTEGER NOT NULL, trace_id INTEGER,
           harness_id INTEGER, branch_id INTEGER, cwd_id INTEGER, model_id INTEGER,
           parent_lane_id INTEGER, goal TEXT, brief_path_id INTEGER,
           brief_markdown_id INTEGER, spawned_ts INTEGER NOT NULL)
           -- idx_lane_trace(trace_id), idx_lane_lane(lane_id, spawned_ts)
agent_session(session_id INTEGER PRIMARY KEY, harness_id INTEGER NOT NULL,
              nickname TEXT, cwd_id INTEGER, branch_id INTEGER, started_ts INTEGER)
agent_turn(session_id INTEGER NOT NULL, turn INTEGER NOT NULL, ts INTEGER,
           role_id INTEGER NOT NULL, said TEXT, PRIMARY KEY (session_id, turn)) WITHOUT ROWID
agent_edge(parent_session_id INTEGER NOT NULL, child_session_id INTEGER NOT NULL,
           edge_kind_id INTEGER NOT NULL, agent_type_id INTEGER, model_id INTEGER,
           first_ts INTEGER, last_ts INTEGER, n INTEGER NOT NULL DEFAULT 1,
           PRIMARY KEY (parent_session_id, child_session_id, edge_kind_id)) WITHOUT ROWID
agent_usage(session_id, turn, ts, request_ref, model_id, service_tier_id,
            input_tokens, output_tokens, cache_create_5m_tokens,
            cache_create_1h_tokens, cache_read_tokens, is_sidechain,
            cost_usd_recorded, PRIMARY KEY (session_id, turn)) WITHOUT ROWID
           -- UNIQUE idx_usage_request(request_ref); idx_usage_ts(ts); idx_usage_model_ts(model_id, ts)
agent_live(session_id INTEGER PRIMARY KEY, pid INTEGER, tmux_pane_id INTEGER, status_id INTEGER)
agent_live_span(session_id INTEGER NOT NULL, from_ts INTEGER NOT NULL, to_ts INTEGER,
                status_id INTEGER NOT NULL, pid INTEGER, tmux_pane_id INTEGER,
                PRIMARY KEY (session_id, from_ts)) WITHOUT ROWID
           -- [from_ts, to_ts) intervals, open when to_ts IS NULL
sync_cursor(session_id, path_id, offset, record_id_id, turn, timestamp,
            PRIMARY KEY (session_id, path_id)) WITHOUT ROWID
```

Also: `agent_touch`, `agent_cmd`, `agent_fetch`, `agent_skill`, `agent_pr`, `agent_span`, `model_price`, `markdown_cache`, `agent_favorite` (turn-level facts, not needed for the network view except `agent_touch`/`agent_fetch` as optional event detail).

### 2.2 Typed public projections (exact Rust signatures)

`src/_0_session_graph.rs` (feature `agent-read`):

```rust
pub const AGENT_SESSION_GRAPH_SCHEMA_VERSION: u32 = 1;
pub struct AgentSessionGraphQuery { pub cwd: Option<PathBuf>, pub include_history: bool }
pub type LoadAgentSessionGraph = fn(&Store, AgentSessionGraphQuery) -> Result<AgentSessionGraph>;
pub struct AgentSessionIdentity { pub harness: String, pub id: String }   // harness-qualified key
pub struct AgentSessionGraph {
    pub schema_version: u32,
    pub sessions: Vec<AgentSessionNode>,
    pub edges: Vec<AgentSessionEdge>,
    pub shells: Vec<AgentShellNode>,
}
pub struct AgentSessionNode {
    pub session: AgentSessionIdentity, pub cwd: Option<PathBuf>,
    pub tmux: Option<String>, pub state: Option<String>, pub last_activity_ts: Option<u64>,
}
pub struct AgentSessionEdge { pub parent: AgentSessionIdentity, pub child: AgentSessionIdentity, pub kind: String } // kind: "spawned"
pub struct AgentShellNode {
    pub lane: String, pub parent_lane: Option<String>, pub harness: Option<String>,
    pub mode: Option<String>, pub session_id: Option<String>, pub cwd: Option<PathBuf>,
    pub tmux: Option<String>, pub pid: Option<u32>, pub state: String, // live | dead | unknown
}
pub fn load_agent_session_graph(store: &Store, query: AgentSessionGraphQuery) -> Result<AgentSessionGraph>;
pub fn load_agent_session_graph_with_runtime(store: &Store, query: AgentSessionGraphQuery,
    runtime: AgentSessionGraphRuntime<'_>) -> Result<AgentSessionGraph>;
pub struct AgentSessionGraphRuntime<'a> {
    pub routes: &'a BTreeMap<String, Route>, pub messages: &'a [Message],
    pub multiplexer: &'a dyn Multiplexer, pub tmux_socket: Option<&'a str>,
    pub processes: &'a dyn ProcReader,
}
```

Session SQL joins `agent_session` + `dict_session/dict_harness/dict_cwd` + `agent_live` + `dict_pane/dict_status`, scopes by cwd and `state <> 'dead'` unless history; `last_activity_ts = MAX(MAX(agent_turn.ts), MAX(agent_usage.ts))` scoped to included sessions (plan asserts no full-corpus scans). Edge SQL requires both endpoints in the filtered graph. Shell SQL reads `agent_lane` rows where `harness_id IS NULL`.

`src/runtime.rs`: `pub fn runtime_snapshot(input: RuntimeSnapshotInput<'_>) -> Result<Vec<AgentRuntimeRow>>` and `runtime_snapshot_now(...)`. `AgentRuntimeRow { lane, trace, root_session, session, parent, route: Option<ResolvedRoute>, cwd, tmux_target, tmux_pane, pid, reported_status, liveness: RuntimeLiveness {tmux: TmuxLiveness, process: ProcessLiveness}, completion: Option<CompletionRecord>, mailbox: MailboxCounts {inbox, outbox, unacknowledged}, worktree: WorktreeCoordinates {route_cwd, process_cwd}, diagnostics: Vec<RuntimeDiagnostic> }`. `ResolvedRoute { lane, kind, harness, tmux, cwd, model, mode, session_id, source_path, parent, goal, registered_at }`. `CompletionRecord { id, from, to, timestamp, body, exit_code }`.

`src/rows.rs` (flat public rows): `SessionRow {session, nickname, harness, cwd, branch, started_ts, turns, last_ts}`, `StatusRow {session, nickname, harness, cwd, parent_session, last_turn_ts, turns, calls_in_window, tokens_in_window, lane, state, pid, tmux_pane, rss_kb, cpu_pct, uptime_sec, first_seen_ts, last_seen_ts, died_ts}`, `LiveSpanRow {session, status, from_ts, to_ts, pid, tmux_pane}`, `TurnRow {session, harness, turn, ts, role, said}`, `EdgeRow {parent, child, edge, first_ts, last_ts, n}`, `UsageRow`, `FactCursor {harness, session, transcript, byte_offset, record_id, turn, timestamp}`.

`src/bus.rs` (bus-compatible registry + mailboxes, same files as retired `bus` CLI at `~/.agent/mail/`):

```rust
pub struct Message { pub id: String, pub from: String, pub to: String,
    pub from_timestamp: String, pub to_timestamp: Option<String>, // ack = delivered
    pub kind: String, // "hail" | "send" | "request" | "result" | "note" (default "note")
    pub reply_to: Option<String>, pub body: String, pub r#ref: Option<String> }
pub struct Route { pub kind: String, // "lane" | "shell" | ...
    pub harness: Option<String>, pub tmux: Option<String>, pub cwd: Option<String>,
    pub model: Option<String>, pub mode: Option<String>, pub session_id: Option<String>,
    pub source_path: Option<String>, pub parent: Option<String>, pub goal: Option<String>,
    pub registered_at: Option<String>, pub base_sha: Option<String>, pub worktree_dir: Option<String> }
pub fn read_routes(dir: &Path) -> Result<BTreeMap<String, Route>>;   // registry.json
pub fn read_boxes(dir: &Path) -> Result<Vec<PathBuf>>;               // *.ndjson
pub fn parse_box(path: &Path) -> Vec<Message>;
pub fn parse_line(line: &str) -> Option<Message>;
pub fn fold(rows: &[Message]) -> Vec<Message>;   // last row per id wins; ack (to_timestamp) survives resend
pub fn unacked(rows: &[Message]) -> Vec<Message>;
pub fn message_line(&Message) -> String;         // stable NDJSON key order
pub fn injected_line(&Message) -> String;        // "[bus <id>] <body>" proof-of-read text
pub fn cas_update_json(path, mutate) -> Result<()>;  // content-hashed CAS, 5 attempts
```

`src-tauri`-side note: `boop-mux` (`crates/boop-mux/src/lib.rs`) is the tmux control layer: `pub trait Multiplexer { current_pane, session_of_pane, pane_pid, live_sessions -> Option<LiveSessions>, has_session, kill_session, target_alive, capture_pane, new_detached_session, new_bare_session, send_keys_literal, send_text, send_key_named, new_window, swap_windows, kill_window }` with one impl `Tmux`. It is the runtime-observation seam passed into `AgentSessionGraphRuntime.multiplexer`.

### 2.3 Existing Instant-side consumers (from `plans/2026-08-15-instant-agent-projection.md` + audit)

| Consumer | Current input |
|---|---|
| `src/boopAgents.ts` | `beep lane list`, `beep ps`, `beep pstree`, `db session list`, `db usage`; polls runtime every tick, sessions/usage every 5th tick |
| `src-tauri/src/harness.rs` | direct Claude/Codex/OpenCode/Kimi stores; `harness_trace_rows` via `HarnessStore::trace_sessions` → `src-tauri/src/0a_harness_trace_index.rs` |
| `src-tauri/src/ledger.rs` | direct harness transcripts: user/assistant/reasoning/tool-call/tool-result rows |
| `src/plugins/harnessTrace/0_mail.ts` | mail registry + bus NDJSON: route/session fallback, parent sender, dispatch reason, `settleRoutedStatus` |
| `src/plugins/harnessTrace/2_join.ts` | tmux pane cwd + foreground process: `assignTmuxPanes`, `joinTmuxSessions` |
| `src/plugins/harnessTrace/0_tree.ts` | `toAgentNodes`: `HarnessTraceRow` → `AgentSessionNode`, `parentId`/`parentKind` |
| `src/plugins/harnessTrace/0_strip.ts` | `nativeSessionIds`, `inScope` descendant closure, `external`/`history` split |
| `src/plugins/cass/` | `cass swarm status` |

Planned CLI (stable JSON contract): `boop agent sessions [--cwd <path>] [--history] --format json` → one `AgentSessionGraph` JSON document.

### 2.4 Contract gaps relevant to this plan (from `plans/2026-08-15-agent-session-graph.md` open findings)

1. Canonical session key: `{harness, id}` pair is the public key; storage `dict_session` is a bare string (cross-harness collisions already merged, unrecoverable).
2. `agent_edge` kinds: `spawned` is the only kind written today by sync (`ident.rs::add_edge`); `EdgeRow.edge` is the public spelling. `first_ts`/`last_ts`/`n` separate one structural spawn from repeated communication.
3. `agent_live.tmux_pane_id` currently holds a tmux *target*, not a pane id (audit finding 4).
4. `include_history=false`: keep discovered native sessions except observed `dead`; shell rows require current route/lane evidence + live pane.
5. `Route.registered_at` is the wait since-boundary that skips a previous run's result rows (mid-turn vs next-turn delivery boundary candidate).
6. `Message.to_timestamp` presence = acknowledged/delivered; `fold` preserves ack across resend.
7. `CompletionRecord` (from/to/timestamp/exit_code) is the completion/death evidence for a lane.

## 3. Required data model and exact TypeScript/Rust signatures

_PENDING_

## 4. Event normalization and stable identity rules

_PENDING_

## 5. Instance timelines and lifetimes

_PENDING_

## 6. Storage, reads, writes, polling/streaming, ordering, deduplication

_PENDING_

## 7. Visual grammar: nodes, edges, lanes, time, selection, filtering, animation

_PENDING_

## 8. Grid/tree and visualization synchronization

_PENDING_

## 9. Instant panel/tab/plugin composition

_PENDING_

## 10. File-by-file implementation sequence with numeric dependency prefixes

_PENDING_

## 11. Deterministic fixtures, snapshots, image receipts, and gates

_PENDING_

## 12. Performance bounds and failure states

_PENDING_

## 13. Decisions requiring user input

_PENDING_
