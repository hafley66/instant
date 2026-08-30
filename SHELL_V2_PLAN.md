# SHELL_V2_PLAN.md — Boop-powered external agent shells panel v2

Status: recon complete; implementation-ready pending the §10 decisions
(§10.1 panel coexistence and §10.3/§10.4 shortcut conflicts are the blockers)

## 1. Current paths, symbols, signatures, call sites, shortcuts

Repo root: `/Users/chrishafley/projects/instant/.boop-worktrees/chore/shell-v2-recon-q38c`

### Boop data source (already merged, lane/boop-shell-v2)
- `src/boopAgents.ts` (507 lines) — data source for the Agents (boop) panel.
  Shells out to the boop binary exclusively (no scripts/bus.ts, no raw tmux);
  parses text/TSV/ndjson output into plain row objects. Parsers are pure and
  fixture-tested; the client takes an injected runner so the tauri boundary
  stays out of this file.
  - `BOOP_BIN = "/Users/chrishafley/projects/claude-research/bin/boop"` (line 7-8)
  - `RunCommand = (commandLine: string) => Promise<string>` (line 396)
  - `shellQuote(s)` (398), `quoteArg(a)` (402, bare if `/^[A-Za-z0-9_./-]+$/`)
  - `class BoopClient` (406): fields `sessions`, `costUsd`, `calls`;
    ctor `(run: RunCommand, bin: string = BOOP_BIN)`;
    `cmd(args: string[])` joins `[bin, ...args.map(quoteArg)]` into one
    command line (416-418);
    `poll(tick: number): Promise<BoopSnap>` (420) runs:
      - `beep lane list` -> `parseLaneList`
      - `beep ps` -> `parsePs`
      - `beep pstree --all --format ndjson` -> `parsePstree`
      - throws `boop returned lanes without a pstree projection` (425)
      - every 5th tick: `db session list --limit 8 --format ndjson` ->
        `parseSessions`; `db usage --limit 1 --format ndjson` -> `parseUsage`
        (failures keep last values, 427-444)
      - returns `{ lanes: mergeLanes(...), tree: buildLaneTree(lanes, pstree),
        sessions, costUsd, calls }` (446)
    `route(lane): Promise<LaneDetail>` (449): `beep lane get <lane>` +
    `beep lane route <lane>` (both failure-tolerant);
    `hail(lane, body, from?): Promise<string>` (476): `beep hail <lane> --body <body> [--from <from>]`
  - `startBoopPolling(client, onSnap, intervalMs = 1500): () => void` (483):
    tick counter, `running` re-entrancy guard, transient failures keep last
    snap, returns `clearInterval` stop fn.
  - Parsers (pure): `parseLaneList(text): LaneInfo[]` (20, whitespace-split,
    needs >=6 fields: state lane harness mode model tmux cwd...);
    `parsePs(text): Record<string, PsInfo>` (48, TSV: lane pid rssKb cpuPct
    uptimeSec children, skips `lane\t` header);
    `parsePstree(text): PstreeInfo[]` (80, ndjson: lane parent inferred pid
    state goal children[]);
    `parseSessions(text): BoopSession[]` (113, ndjson: session nickname
    harness cwd turns started_ts last_ts);
    `parseLaneGet(text): Partial<LaneDetail>` (147, single JSON: lane state
    harness tmux cwd model mode session_id);
    `parseLaneRoute(text): string | null` (166, regex `->\s+(\S+)`);
    `parseUsage(text): { costUsd: number | null; calls: number }` (171, first
    ndjson line with numeric `calls`, `cost_usd`).
  - Row model: `LaneRow` (186, kind "lane": id lane state harness mode model
    tmux cwd pid rssKb cpuPct uptimeSec children sessions route parent inferred
    goal childPids childLanes? addressable); `RouteRow` (211, kind "route");
    `SessionRow` (222, kind "session"); `SessionGroupRow` (233, kind
    "session-group"); `AgentsRow = LaneRow | RouteRow | SessionRow |
    SessionGroupRow` (241).
  - `sessionTree(sessions): SessionGroupRow[]` (243): groups by harness,
    sorted by lastTs desc, id `session:<id>`, group id `sessions:<harness>`,
    label `<harness> chats`.
  - `mergeLanes(lanes, ps, sessions): LaneRow[]` (268): per-harness session
    counts; addressable: true.
  - `buildLaneTree(lanes, edges): LaneRow[]` (305): merges pstree edges into
    lane rows (missing lanes synthesized as addressable: false), roots =
    no-parent/self-parent, childLanes attached.
  - `subRowsFor(row): AgentsRow[] | undefined` (344): session-group ->
    children; lane -> childLanes + synthetic RouteRow from row.route.
  - `withLaneRoute(rows, lane, route): LaneRow[]` (363): recursive route
    stamp.
  - `findLane(rows, lane): LaneRow | undefined` (371): DFS.
  - `BoopSnap { lanes: LaneRow[]; tree: LaneRow[]; sessions: BoopSession[];
    costUsd: number | null; calls: number }` (380).
  - `boopAgents = Signal<BoopSnap>` (388) from `@hafley66/signals`.

- `src/boopAgents.test.ts` — inline-fixture parsing tests (no toBeDefined).
  Fixtures: `beep lane list` text row (state lane harness mode model tmux
  cwd...), `beep ps` TSV row, pstree ndjson lines, `parseLaneRoute`
  `resolved boop-shell-v2 -> ses_abc` -> `ses_abc` (line 234), shellout argv
  fixtures starting `"boop"` (lines 284, 295, 312).

### Agents panel v1 (the v2 panel this brief builds on)
- `src/agentsPanelV2.tsx` (220 lines) — Agents (boop) panel on the grid stack.
  NOTE: uses the PUBLISHED grid package, not src/treetable.tsx:
  `import { createGrid } from "@hafley66/grid"; import { GridTable } from
  "@hafley66/grid/react";` (lines 6-7). Grid: `createGrid<AgentsRow>({
  schema: z.custom<AgentsRow>(), rows: agentsRows, mode: "client",
  getRowId: (row) => row.id, getSubRows: (row) => agentsBridge?.getSubRows(row),
  columnDefs: [...] })` (131-178). Columns: __expand, dot, name (lane),
  harness, state, pid, rss, cpu, hail.
  - `AgentsBridge { onShow?; open(row); canExpand(row); getSubRows(row);
    onToggle(lane, willExpand); hail(lane, body): Promise<void> }` (19-26)
  - `setAgentsPanel(b: AgentsBridge)` (29), module-level `agentsBridge` (28)
  - `agentsRows = Signal<AgentsRow[]>(() => [...boopAgents.$().tree,
    ...sessionTree(boopAgents.$().sessions)])` (127-130)
  - `AgentsPanelV2()` (180): act-bar with `agents · boop` title + count line
    (`{live} live / {total} lanes · {sessions} chats · $cost`), filter input
    -> `agentsGrid.onGlobalFilterChange(value)`, empty state `no boop lanes —
    is the registry reachable?`, `<GridTable grid={agentsGrid}
    density="compact" maxHeight={720} />` (215).
  - `HailCell` (79): inline input, Enter -> `agentsBridge?.hail(row.lane, b)`.
  - `OpenCell` (62): openable when session row, or lane live + tmux.

### main.ts wiring (588 lines, composition root)
- `registerAgentsPanel()` (130-173):
  - `new BoopClient((line) => invoke<string>("run_click", { command: line, cwd: "" }))`
    (131) — tauri command `run_click` is the shellout runner.
  - `startBoopPolling(client, (snap) => boopAgents.$(snap), 1500)` (132);
    stop on `beforeunload` (133).
  - `expand(lane)` (134-143): `client.route(lane)` then stamps `route` into
    lanes + `withLaneRoute` into tree.
  - `setAgentsPanel({ onShow, open, canExpand, getSubRows, onToggle, hail })`
    (144-172):
    - `open(row)`: lane live + tmux -> `openTab(row.tmux, { viewer: true })`;
      session -> `openTab("chat-<harness>-<sessionId>", { cwd, command:
      harnessAdapter(harness).resume(row.sessionId) })` (148-161).
    - `canExpand`: lane && (addressable || childLanes) (162).
    - `onToggle(lane, willExpand)`: findLane + expand when expanding
      addressable (164-167).
    - `hail` -> `client.hail(lane, body, "instant")` (168-171).
  - Called at boot: `registerAgentsPanel()` (353).
- `toggleTermSidebar()` (177-182): per-terminal sidebar state in
  `store.get().termSidebar[id] ?? { open: false, width: 264 }`.
- `toggleTermStrip()` (185-189): `toggleTermStripFor(id)` from
  `./plugins/harnessTrace/InTabStrip`.
- `toggleNetwork()` (192-196): `toggleNetworkFor(id)`.
- `TAB_COMMANDS: Command[]` (198-260) — the command table; palette lists
  titled commands.
- Shortcuts (218-220):
  - `term.sidebar` `$mod+Shift+Backslash` -> toggleTermSidebar
  - `term.strip` `$mod+Shift+x`, `$mod+Shift+Period` -> toggleTermStrip
  - `term.network` `$mod+Shift+N` -> toggleNetwork
- Keymap install (500-507): `installKeymap([...TAB_COMMANDS,
  ...pluginCommands(), ...panelCommands])`; `panelCommands` = one
  `panel.<id>` "Toggle <title>" per `allPanels()` entry via `togglePanel(p.id)`.
- Boot order (262+): setHomeDir -> refreshConfig -> preview init -> store
  subs -> setDockHooks (284-292) -> registerBuiltin (314) -> registerRulesPlugin
  -> registerMetricsPlugin -> registerHarnessTracePlugin -> registerFilesPlugin
  (318) -> registerNav -> installMdviewHost (325-348, includes
  readPluginState/savePluginState/FileTree/PanZoomViewport) -> registerMdview
  -> registerPaint -> registerV2Bridges (351) -> registerActivityBridge ->
  registerAgentsPanel (353) -> refreshFavorites -> initRail (355) ->
  startReactiveRuntime (356) -> anchor polyfill -> wireChrome -> wireDomCmdClick
  -> mountReactDock (374) -> wireWindowResize -> wireRailResize -> wireOsDrop
  -> wireContextMenu -> refreshSessions (389) -> scanWorktrees (392) ->
  refreshRogue + 8s interval (396-397) -> Tauri event listeners (pty-data-batch
  399, pty-graphics 407, cdp-error 412, cdp-url 420, activity-added 439,
  capture-status 447, favorites-changed 454, frontmost-app 461, summoned 467)
  -> tab restore from store.openTabs (428-435, `openTab(t.name, { command,
  cwd, graphics, viewer })`) -> Esc hides window (490-492) -> installKeymap
  (507) -> overlay apply (511-518) -> send-highlight-text (523) ->
  toggle-record (531) -> toggle-ai (535) -> focus/blur hide (545-557).
- Terminal module imports (55-69): `tabs, openTab, activate, onTermShown,
  onTermClosed, fitTerm, zoomGesture, zoomResetGesture, sendTextToTab,
  setReplaying, observeTerminalOutput, tabMetaById, getFocusedTermId` from
  `./terminal`.
- `harnessAdapter, harnessIds` from `./harness` (125).
- `installKeymap, type Command` from `./keymap` (36).

### Keymap (src/keymap.ts, 70 lines)
- tinykeys-based. `$mod` = Cmd on mac / Ctrl elsewhere. Prefer
  KeyboardEvent.code names (BracketRight, Digit1) over characters.
- `Command { id, keys: string[], run, title?, group? }` (14-23).
- `installKeymap(commands, target = window)` (40): binds via tinykeys with
  `ignore: () => false`; stashes `registered` + single-press `presses`.
- `runMatchingCommand(e): boolean` (61): xterm passthrough matcher; returns
  true to swallow (no pty write).
- `paletteCommands()` (28): titled commands only.

### Panel registry (src/plugin.tsx, 391 lines)
- `PanelDef { id, railParent?, title, icon, iconUrl?, iconLabel, html? (vestigial),
  component: ComponentType<IDockviewPanelProps>, keepAlive?, onRemove?,
  onDiscard?, onShow?, railChildren?, bottomStrip? }` (25-47).
- `PanelInstanceDef { id, prefix, componentName, component, restorable?,
  keepAlive?, onRemove?, onDiscard? }` (49-62).
- `Plugin { id, panels, instances?, options?, status?, commands?, routes?,
  tabOverrides? }` (119-128).
- `registerPlugin(p)` (139): merges by plugin id (panels/instances/options/
  status/commands/routes/tabOverrides concatenated).
- `allPanels()` (228), `panelIds()` (216), `railPanelIds()` (220, excludes
  railParent), `railChildPanels(parentId)` (224), `getPanel(id)` (204),
  `panelInstanceForId(panelId)` (212, prefix match).
- `dockComponents()` (301): wraps every panel in a PanelErrorBoundary
  (class, getDerivedStateFromError; retry remounts via key).
- `buildActivityRail(order?)` (324): DOM rail buttons `#<id>-toggle`,
  popover tips, anchor-positioning rules.
- `StatusProbe { id, label, check(): Promise<StatusReport> }` (99-103);
  `statusProbes()` (194); `ConfigOption { id, label, hint?, get, set }`
  (69-75); `configOptions()` (200).

### panels.ts (109 lines) — builtin rail panels
- `registerBuiltin()`: plugin `builtin` with options [showToolbar, xpPixel,
  cdpPerf] + panels:
  - `sessions` (title "tmux", TmuxPanelV2, onShow refreshSessions)
  - `worktrees` (WorktreesPanelV2, onShow scanWorktreesIfNeeded)
  - `activity` (ActivityPanelV2)
  - `agents` (AgentsPanelV2, no onShow)
- `registerFavoritesPlugin()` between; second `builtin` registration adds
  `config` (ConfigPanelV2) + `status` (StatusPanelV2); `registerBuiltinStatus()`.

### pluginState (src/pluginState.ts, 16 lines)
- `readPluginState<T>(pluginId, fallback): T` from `store.get().pluginState[pluginId]`.
- `savePluginState<T extends object>(pluginId, patch: Partial<T>): void` (merge).

### Files plugin (src/plugins/files/)
- `index.ts` (21): `registerFilesPlugin()` -> plugin `files`, panel `files`
  (title "Files", icon 📁 / Explorer100_32x32_4.png, component FilesPanel).
- `3_FilesPanel.tsx` (29): `PLUGIN_ID = "files"`; root from
  `readPluginState<FilesUi>("files", {}).root || store.get().scanRoot ||
  getHomeDir() || "/"`; renders act-bar `Files` + `<FileExplorer root
  onRootChange={(path) => savePluginState<FilesUi>(PLUGIN_ID, { root: path })} />`.
- `2_FileExplorer.tsx` (87): `FileExplorerProps { root, onRootChange,
  onSelect? }`; default `onSelect = openPreviewPanel`; root listing via
  `invoke("list_dir", { path: root })` -> `{ path, entries: FsEntry[] }`;
  up-parent button, path input (Enter re-lists via revision), refresh button;
  lazy nested `<FileTree rootPath rootEntries listCommand="list_dir"
  onSelect searchPlaceholder="filter files…" />`.
- `1_FileTree.tsx` (153), `4_FileSearchTree.tsx` (63, exports
  `FileSearchTree, filesystemSearchSource`), `0_FileTreeModel.ts` (25),
  `0_types.ts` (3, `FilesUi`), `1_FileTree.test.ts` (46).

### Shortcuts summary (current vs wanted)
| combo | current | wanted (v2) |
|---|---|---|
| Cmd+Shift+Period | Toggle Relations Strip (term.strip) | shells |
| Cmd+Shift+Backslash | Toggle Session Sidebar (term.sidebar) | files |
| Cmd+Shift+x | Toggle Relations Strip (2nd binding) | (unspecified) |

### Session sidebar (current Cmd+Shift+Backslash target)
- `src/sessionSidebar.tsx` (629 lines) — per-terminal right sidebar (file
  explorer), react-resizable-panels split with persisted sizes (comment line
  7, import line 15). Per-terminal state `store.termSidebar[id] = { open,
  width }` (width default 264).

### Splits
- `react-resizable-panels` ^3.0.6 in package.json (line 51).
- Current consumers: `src/plugins/metrics/0b_layout.tsx` (line 2),
  `src/sessionSidebar.tsx` (line 15).
- `src/memeSplit.tsx` / `src/memeSplitLayout.ts` (AGENTS.md reference) are
  REMOVED: `761f3ee refactor: remove meme panel plugin` (after
  `cc15015 refactor(meme): splitters onto react-resizable-panels`).

### CASS (superseded external-agent status panel)
- `31a0d18 feat: add CASS swarm panel` (2026-07-24): added
  `src/plugins/cass/` (0_rows.ts 95, 0_types.ts 43, 0a_CassSwarm.css 25,
  1_SwarmPanel.tsx 92, index.ts 15, 0_rows.test.ts 66), `e2e/cass-swarm.spec.ts`
  (66), `e2e-cass.html` (19), `src-tauri/src/ledger.rs` (+22),
  `src/generated/native.ts` (+2), TreeTable cell-expansion toggles.
  CASS transport: `ledger.rs` `cass_path()` (PATH + /opt/homebrew/bin,
  /usr/local/bin, ~/.cargo/bin, ~/.local/bin), `CassStatus`,
  `cass_swarm_status(cwd)` runs `cass swarm status` (bounded redacted JSON).
- `b45f180 feat: agent relations strip — subagent tree in dock + in-tab,
  per-tab router, cass panel deregistered` — the cass panel was
  deregistered; the plugin dir remains in the tree (src/plugins/cass/).
- Other cass/bus history: `a8b2590 feat(bus): ruled envelope, cass-verified
  acks, tmux hail, mail preview`, `8a419c5 bus: resolve grows a claude leg`,
  `30aaca1 e2e-live: paid legs green`, `2bc76f0 e2e-live: real-tmux,
  real-bus proof suite`, `306dd16 refactor(harness): unify session stores`,
  `2e405d7 fix(harness): strip sibling-leak, empty token/link cols, bus env
  self-report`.

### Bus (retired) artifacts
- `scripts/bus.ts` — the retired bus CLI (dispatch/resolve/adopt/prune/sweep/hail/mail).
- `scripts/0_busDispatch.test.ts`, `src/plugins/harnessTrace/0_bus.ts` (+test) — bus consumers.
- `e2e-live/0_live.ts:12` — `BUS = join(HERE, "..", "scripts", "bus.ts")`; `bus()`
  helper at line 48; `bus.ndjson` mail at line 62.
- `e2e-live/bus-lifecycle.live.ts`, `battery.live.ts`, `strip-live.live.ts` — live bus tests.
- `playwright.busmail.config.ts`, `e2e-cass.html`, `2026-08-03-bus-ack-ruling.md`,
  `proof-artifacts/bus-slice.ndjson`, `docs/lane-reports/2026-08-04-bus-resolve-codex.md`.
- `AGENTS.md` "Flash 4 bus lanes" section still references the bus CLI authorization.
- `src/reactive/statusPolling.ts` uses a local `createEventBus` (unrelated to bus CLI).

## 2. Relevant git history and superseded code

Recent log (git log --oneline -25):
- `9cbe1c8` Integrate accumulated Instant workspace changes (HEAD)
- `f9b2beb` Keep tmux sessions alive when tabs close
- `84c27db` Use published grid package and stabilize Vite startup
- `54ebb2d` Integrate signals runtime and local signed installs
- `8d869a6` Merge pull request #12 from hafley66/lane/boop-shell-v2
- `8745a27` instant: agents panel (TreeTable) wired to boop
- `5423fdd` instant: boop data source + captured-fixture parsing tests
- `253bee3` instant: boop lane spawn + hail e2e
- `e131ccc` fix(harness): preserve bus and diagram relationships
- `b111c5a` fix(harness): keep relation tabs session-scoped

Boop v1 (agents panel) already landed via PR #12 (lane/boop-shell-v2). This recon
is for the v2 shells panel (shells tab + files tab + shortcuts).

## 3. Boop commands and structured output contracts

From `boop --help` (DOCTRINE section is the usage contract):
- Top level: `beep` (drive agents: harnesses, lanes, mail, processes), `db`
  (raw SQL read-only + subcommands), `agent` (sync + summarize), `concatmap`,
  `whoami`, `config`, `help`.
- `boop beep` subcommands: `harness`, `lane`, `agent`, `hail`, `message`, `ps`,
  `pstree`, `help`.
- `boop beep lane` subcommands: `list`, `create`, `run`, `get`, `patch`,
  `delete`, `prune`, `route`, `pane`, `message`, `wait`, `help`.
  - `lane list [--state <S>] [--harness <H>] [--mail-dir <D>]`
  - `lane create --branch feature/<name> --brief <abs> [--goal] [--model]
    [--wait] [--mail-dir] [--dry-run]` (one derivation from branch name: lane
    id + tmux session `feature-schema-emit`, worktree
    `.boop-worktrees/feature/schema-emit`; --parent, --harness, --base-sha,
    --preset flash4, --lane, --tmux overrides; WARMUP runs repo `boop-start`
    just recipe)
  - `lane run --lane <id> --harness <h> --brief <abs> --model <m>` (the
    supervisor command a lane pane runs; drains inbox every 700 ms)
  - `lane get <LANE> [--mail-dir]`
  - `lane route <LANE> [--mail-dir]` (which tmux pane + harness session id)
  - `lane wait <lane>` / `--wait` / `--wait-timeout <s>` (default 3600; 0 =
    forever; exit 124 timeout; exit 3 route dead with no row)
  - `lane delete` (one lane or bulk by state), `lane prune` (drops routes
    whose tmux session is gone AND pid not alive; refuses when tmux
    unreachable), `lane pane` (show the lane's screen), `lane message`
    (mailbox), `lane patch` (point lane at existing pane)
- `boop beep hail <LANE> --body <BODY> [--from <FROM>] [--kind <KIND>]
  [--socket <S>] [--mail-dir <D>]` — reaches a running lane MID-TURN on all
  four harnesses (claude stream-json stdin line; codex app-server turn/steer;
  opencode typed into TUI + Enter; kimi typed + C-s). No in-flight port ->
  `nextturn`, supervisor holds for resume turn.
- `boop beep ps [LANE] [--all] [--mail-dir]` — pid, rss, cpu, uptime, child
  count per live lane.
- `boop beep pstree [--all] [--format text|ndjson (default text)] [--mail-dir]`
  — filesystem-style tree of lanes by parent edge.
- `boop beep message ack` — age-based bulk-mark (NOT proof-of-read).
- `boop beep agent register` / `boop beep agent done` — pane-less
  coordinators + native subagents.
- `boop db [SQL] [--format ndjson|text]` — read-only SQL against
  `~/.agent/boop.db` (sqlite3 dot-commands unsupported; plain SQL only).
- `boop db` subcommands: `session` (list/get), `turn`, `chat`, `touch`,
  `command`, `fetch`, `skill`, `pr`, `span` (list), `edge` (list), `usage`
  (totals report; `blocks`, `burn-rate`; `--format ndjson|text` default
  ndjson; `--show-sql`), `price`, `favorite`, `sync`, `sync-cursor`,
  `status [--window <min, default 10>] [--format ndjson|text]`.
- Store schema: version 10 (older builds refused; `boop db sync create
  --rebuild` re-projects from byte 0). Tables named in DOCTRINE:
  `agent_trace` (trace_id, root_session_id, started_ts), `agent_trace_span`
  (session_id -> trace_id, attach_id), `agent_lane` (one row per spawn: goal,
  brief path id, brief body id), `markdown_cache` (digest UNIQUE, body, bytes,
  first_ts), `agent_edge` (edge kind deliver-midturn/deliver-nextturn),
  `dict_trace`, `dict_session`.
- Mailbox: `~/.agent/mail/` (bus.ndjson + registry.json), override
  `--mail-dir`.
- Liveness = TWO checks: `boop beep ps <lane>` + `git -C <worktree> status
  --short`.
- Pre-split verbs (harnesses, sessions, events, chat, tail, list, measure,
  dispatch, lane, resolve, adopt, sweep, prune, hail, sync, follow) still run
  as hidden aliases for one release. Use `beep` and `db`.
- Output formats used by Instant today (boopAgents.ts): `beep lane list`
  whitespace text; `beep ps` TSV (lane pid rssKb cpuPct uptimeSec children);
  `beep pstree --all --format ndjson`; `beep lane get` single JSON;
  `beep lane route` text `resolved <lane> -> <session>`; `db session list
  --limit 8 --format ndjson`; `db usage --limit 1 --format ndjson`.

## 4. Proposed type signatures

Design: a new `shells` rail panel (boop-driven, same data source as the agents
panel) + rebind of the two shortcuts. No Rust changes: shellout goes through the
existing `run_click` tauri command (src-tauri/src/lib.rs:640, already used by
boop v1).

### src/boopAgents.ts (existing, 507 lines — already past the 500 cap)
No additions here. Any new boop surface (e.g. `beep lane pane`) goes in a new
sibling module so this file does not grow.

### src/boopPane.ts (NEW, only if the shell tab needs `beep lane pane`)
```ts
// parse the output of `boop beep pane <lane>` (format unverified — see §10.2)
export interface LanePane {
  lane: string;
  paneId: string | null; // tmux pane id, if present in the output
  screen: string;        // captured screen text
}
export function parseLanePane(lane: string, text: string): LanePane
```

### src/shellsPanelV2.tsx (NEW, one panel per file, < 500 lines)
```ts
import { createGrid } from "@hafley66/grid";
import { GridTable } from "@hafley66/grid/react";
import { boopAgents, subRowsFor, type AgentsRow } from "./boopAgents";

export interface ShellsBridge {
  onShow?: () => void;
  open: (row: AgentsRow) => void; // lane -> openTab(row.tmux, { viewer: true })
  canExpand: (row: AgentsRow) => boolean;
  getSubRows: (row: AgentsRow) => AgentsRow[] | undefined;
  onToggle: (lane: string, willExpand: boolean) => void;
  hail: (lane: string, body: string) => Promise<void>;
  // optional, only if spawn is in scope (§10.5):
  // spawn: (branch: string, brief: string) => Promise<void>;
}
export function setShellsPanel(b: ShellsBridge): void
export function ShellsPanelV2(): JSX.Element
```
Grid: `createGrid<AgentsRow>({ schema: z.custom<AgentsRow>(), rows:
shellsRows, mode: "client", getRowId: (row) => row.id, getSubRows: (row) =>
shellsBridge?.getSubRows(row), columnDefs })` with columns
`__expand, dot, lane, state, harness, model, tmux, cwd, pid, rss, cpu, uptime,
hail`. `shellsRows = Signal<AgentsRow[]>(() => boopAgents.$().tree)` (shells
panel shows lanes only; the agents panel keeps the session groups).

### src/shellsBridge.ts (NEW, keeps main.ts from growing; mirrors
registerAgentsPanel shape)
```ts
import { BoopClient, boopAgents, findLane, startBoopPolling, subRowsFor,
  withLaneRoute } from "./boopAgents";
import { setShellsPanel } from "./shellsPanelV2";
export function registerShellsPanel(): void
// body: new BoopClient((line) => invoke<string>("run_click", { command: line,
// cwd: "" })); startBoopPolling(client, (snap) => boopAgents.$(snap), 1500);
// beforeunload stop; setShellsPanel({ onShow, open, canExpand, getSubRows,
// onToggle, hail }) — same shapes as registerAgentsPanel (src/main.ts:130-173).
```
NOTE: if a second BoopClient polls the same `boopAgents` signal, two pollers
race. Preferred: share ONE client. Either (a) move the existing client +
polling into boopAgents.ts-free shared module `src/boopBridge.ts` used by both
panels, or (b) the shells panel reuses the agents bridge and only adds the
shortcut + panel registration (zero new polling). Option (b) is the minimal
change; option (a) is the clean one. Decision in §10.1.

### src/panels.ts (existing, 109 lines)
Add to the first `builtin` registration's `panels` array:
```ts
{
  id: "shells",
  title: "Shells",
  icon: "⌘",            // glyph fallback; iconUrl optional
  iconLabel: "Shells",
  html: "",
  component: ShellsPanelV2,
},
```
This auto-creates the `panel.shells` palette command ("Toggle Shells") via
main.ts:500-506.

### src/main.ts (existing, 588 lines — already past the cap; 2-line change)
Shortcut rebinds in TAB_COMMANDS (lines 218-219):
```ts
{ id: "panel.shells", keys: ["$mod+Shift+Period"], title: "Toggle Shells", group: "View", run: () => togglePanel("shells") },
{ id: "panel.files",  keys: ["$mod+Shift+Backslash"], title: "Toggle Files", group: "View", run: () => togglePanel("files") },
```
Conflicts to resolve (see §10.3, §10.4):
- `$mod+Shift+Period` currently also bound to `term.strip` (with
  `$mod+Shift+x`): drop Period from term.strip, keep x.
- `$mod+Shift+Backslash` currently bound to `term.sidebar` (per-terminal
  session sidebar): rebind term.sidebar to a new key or drop it.
Call `registerShellsPanel()` next to `registerAgentsPanel()` (line 353) if
option (a); nothing new if option (b).

## 5. Pseudocode bodies

### registerShellsPanel (src/shellsBridge.ts, option (a))
```
function registerShellsPanel():
  client = new BoopClient(line => invoke("run_click", { command: line, cwd: "" }))
  stop = startBoopPolling(client, snap => boopAgents.$(snap), 1500)
  window.on("beforeunload", stop, { once: true })

  expand(lane):
    detail = await client.route(lane)
    snap = boopAgents.$()
    boopAgents.$({ ...snap,
      lanes: snap.lanes.map(l => l.lane === lane ? { ...l, route: detail } : l),
      tree:  withLaneRoute(snap.tree, lane, detail) })

  setShellsPanel({
    onShow: () => {},                      // first poll fired at registration
    open(row):
      if row.kind == "lane" and row.state == "live" and row.tmux:
        openTab(row.tmux, { viewer: true })   # v2 shell tab: attach-only viewer
      elif row.kind == "session":
        harness = harnessIds.find(id => id == row.harness) or return
        openTab("chat-" + harness + "-" + row.sessionId,
                { cwd: row.cwd, command: harnessAdapter(harness).resume(row.sessionId) })
    canExpand(row): row.kind == "lane" and (row.addressable or (row.childLanes?.length or 0) > 0)
    getSubRows(row): subRowsFor(row)
    onToggle(lane, willExpand):
      row = findLane(boopAgents.$().tree, lane)
      if willExpand and row?.addressable: expand(lane)
    hail(lane, body): await client.hail(lane, body, "instant")
  })
```

### ShellsPanelV2 (src/shellsPanelV2.tsx)
```
const shellsRows = Signal<AgentsRow[]>(() => boopAgents.$().tree)
const shellsGrid = createGrid<AgentsRow>({
  schema: z.custom<AgentsRow>(), rows: shellsRows, mode: "client",
  getRowId: row => row.id,
  getSubRows: row => shellsBridge?.getSubRows(row),
  columnDefs: [
    { id: "__expand", header: "" },
    { id: "dot",    header: "", cell: ({row}) => <DotCell row={row.original}/> },
    { id: "lane",   header: "lane",    accessorFn: row => row.lane,
      cell: ({row}) => <OpenCell row={row.original}><LaneNameCell row={row.original}/></OpenCell> },
    { id: "state",  header: "state",   accessorFn: row => "state" in row ? row.state : "",
      cell: ({row}) => <OpenCell row={row.original}><StateCell row={row.original}/></OpenCell> },
    { id: "harness",header: "harness", accessorFn: row => "harness" in row ? row.harness : "" },
    { id: "model",  header: "model",   accessorFn: row => "model" in row ? row.model : "" },
    { id: "tmux",   header: "tmux",    accessorFn: row => "tmux" in row ? row.tmux : "" },
    { id: "cwd",    header: "cwd",     accessorFn: row => "cwd" in row ? row.cwd : "" },
    { id: "pid",    header: "pid",     accessorFn: row => "pid" in row ? (row.pid ?? -1) : -1 },
    { id: "rss",    header: "rss",     accessorFn: row => "rssKb" in row ? (row.rssKb ?? -1) : -1 },
    { id: "cpu",    header: "cpu",     accessorFn: row => "cpuPct" in row ? (row.cpuPct ?? -1) : -1 },
    { id: "hail",   header: "",        cell: ({row}) => <HailCell row={row.original}/> },
  ],
})

function ShellsPanelV2():
  [filter, setFilter] = useState("")
  useEffect(() => shellsBridge?.onShow?.(), [])
  snap = boopAgents.$()
  rows = shellsRows.$()
  live = snap.lanes.filter(r => r.state == "live").length
  render:
    <div class="v2-panel">
      <div class="act-bar">
        <span class="spy-title">shells · boop</span>
        <span class="wt-count">{live} live / {snap.lanes.length} lanes · ${snap.costUsd?.toFixed(2)}</span>
      </div>
      <div class="panel-scroll">
        <input value={filter} placeholder="filter shells…"
               onChange={e => { setFilter(e.target.value); shellsGrid.onGlobalFilterChange(e.target.value) }} />
        if rows.length == 0: <div class="session-empty">no boop lanes — is the registry reachable?</div>
        else: <GridTable grid={shellsGrid} density="compact" maxHeight={720} />
      </div>
    </div>
```
DotCell / StateCell / HailCell / OpenCell: copy the shapes from
agentsPanelV2.tsx:42-125 (same classes `dot on`, `agents-state`,
`wt-actions`, `agents-hail-input`).

### Shortcut rebinds (src/main.ts TAB_COMMANDS)
```
// replace line 218:
- { id: "term.sidebar", keys: ["$mod+Shift+Backslash"], ... run: toggleTermSidebar }
+ { id: "term.sidebar", keys: ["$mod+Shift+A"], ... run: toggleTermSidebar }   # or drop, §10.3
// replace line 219:
- { id: "term.strip", keys: ["$mod+Shift+x", "$mod+Shift+Period"], ... }
+ { id: "term.strip", keys: ["$mod+Shift+x"], ... }
// add:
+ { id: "shells.toggle", keys: ["$mod+Shift+Period"], title: "Toggle Shells", group: "View",
+   run: () => togglePanel("shells") }
+ { id: "files.toggle",  keys: ["$mod+Shift+Backslash"], title: "Toggle Files", group: "View",
+   run: () => togglePanel("files") }
```
Note: `panel.shells` / `panel.files` palette commands already exist via
allPanels() (main.ts:500-506); the keyed entries here are the shortcut layer.
Keep ids distinct from the auto `panel.*` ids to avoid tinykeys double-binding
the same command (same run fn, but two map entries would both fire).

### Shell tab open path (existing, unchanged)
```
openTab(name, { viewer: true })            # src/terminal.ts:432
  id = sessionId(name)
  recordTab(name, command, cwd, graphics, viewer)   # persists into store.openTabs
  tmux new-session -A -t <name> ...        # attach-only; session outlives webview
  Tab { attachOnly: true }                 # terminal.ts:854
close tab:
  ViewerTabPolicy.closeAction({ viewer: true, agent }) == "detach"  # terminal.ts:1024
  # viewer tabs detach on close; the lane keeps running (f9b2beb)
```

## 6. Instance timelines and lifetimes

| instance | created | destroyed | lifetime notes |
|---|---|---|---|
| `BoopClient` (agents) | `registerAgentsPanel()` at boot (main.ts:353 -> :131) | never (webview session) | holds `sessions`, `costUsd`, `calls` across polls; failures keep last values |
| boop poll interval | `startBoopPolling` (main.ts:132), first tick fires immediately | `beforeunload` (main.ts:133) | 1500 ms; `running` guard prevents overlap; transient shellout failures keep last snap (boopAgents.ts:490-500) |
| `boopAgents` Signal | module import (boopAgents.ts:388) | webview reload | module singleton; both panels read the same snap; the signals JSX plugin tracks `.$()` reads for re-render |
| `shellsRows` / `agentsRows` Signals | module import of each panel file | webview reload | derived from `boopAgents`; recomputed on every snap write |
| `shellsGrid` / `agentsGrid` | module import (`createGrid`) | webview reload | module singletons; `getSubRows` closes over the bridge (set at boot before any render) |
| `shellsBridge` / `agentsBridge` | `setShellsPanel` / `setAgentsPanel` at boot | never | module-level nullable; cells guard with `?.` |
| ShellsPanelV2 component | dockview lazily mounts on first `togglePanel("shells")` | dockview unmounts on panel close (unless `keepAlive`) | `useEffect` fires `onShow` once per mount; no local data (all from the signal) |
| Shell tab (viewer) | row click -> `openTab(row.tmux, { viewer: true })` (terminal.ts:432) | tab close -> detach only (ViewerTabPolicy, terminal.ts:1024) | tmux session outlives the webview (commit f9b2beb); tab row persisted in `store.openTabs` (terminal.ts:849) and reattached on reload (main.ts:428-435) |
| lane (boop side) | `boop beep lane create` (outside Instant, or a future spawn action) | lane process exit; route pruned by `beep lane prune` when tmux gone AND pid dead | Instant is a viewer: it never kills lanes; `beep ps` + `git status --short` are the liveness pair per boop DOCTRINE |
| `termSidebar` state | `store` load (state.ts:489) | store persist on change | per-terminal `{ open, width, source?, placement?, sizes?, touched? }` (state.ts:127-133); survives reload; unaffected by the shortcut rebind unless the feature is dropped |
| `pluginState.files.root` | `readPluginState` on FilesPanel mount | `savePluginState` on root change | localStorage-backed via store (state.ts:301, 376, 425); the files shortcut just toggles the existing panel |

Polling cadence detail (boopAgents.ts:420-447): every tick runs 3 shellouts
(`beep lane list`, `beep ps`, `beep pstree --all --format ndjson`); every 5th
tick adds 2 (`db session list --limit 8 --format ndjson`, `db usage --limit 1
--format ndjson`). One `run_click` tauri invoke per shellout (spawn_blocking in
Rust, lib.rs:640-646).

Double-poller hazard: if option (a) creates a second BoopClient, two intervals
write the same signal. Mitigations: share one client (move creation into a
`src/boopBridge.ts` with a `getBoopClient()` memo), or make `startBoopPolling`
idempotent per client (it is not today). Option (b) avoids it entirely.

## 7. Storage and read/write/event sequence

### Storage layout
| store | location | owner | Instant access |
|---|---|---|---|
| boop SQLite store (schema v10) | `~/.agent/boop.db` | boop | read-only via `boop db "<sql>"` / `db` subcommands; older builds refused; `db sync create --rebuild` is the only destructive path (not used by Instant) |
| boop mailbox | `~/.agent/mail/` (`bus.ndjson` + `registry.json`) | boop | read via `beep lane get/route/list`, `beep pstree`; written by `beep hail` (Instant) and lane supervisors |
| tmux sessions | tmux server (default socket) | tmux | attach via `openTab` -> `tmux new-session -A`; never created/killed by the shells panel (viewer tabs detach on close) |
| lane worktrees | `.boop-worktrees/<kind>/<name>` per repo | boop `lane create` | read-only display (`cwd` column); liveness check 2 is `git -C <worktree> status --short` |
| Instant app store | localStorage via `loadKey` (state.ts:340-376) | Instant | `openTabs` (tab rows incl. `viewer` flag), `termSidebar`, `pluginState` (per-plugin slices: `files.root`, future `shells.*`), `scanRoot` |
| boop binary | `/Users/chrishafley/projects/claude-research/bin/boop` | user install | exec'd via `run_click` (lib.rs:640); path hardcoded in `BOOP_BIN` (boopAgents.ts:7) |

No new Rust commands, no new storage. `just cargo-check` / `just ext-build`
only run if that changes.

### Read sequence (poll tick, every 1500 ms)
```
1. startBoopPolling timer fires (skips if a tick is in flight)
2. run_click "boop beep lane list"                      -> parseLaneList  -> LaneInfo[]
3. run_click "boop beep ps"                             -> parsePs        -> Record<lane, PsInfo>
4. run_click "boop beep pstree --all --format ndjson"   -> parsePstree    -> PstreeInfo[]
   (lanes non-empty but pstree empty -> throw, snap kept)
5. every 5th tick:
   5a. run_click "boop db session list --limit 8 --format ndjson" -> parseSessions (keep last on error)
   5b. run_click "boop db usage --limit 1 --format ndjson"       -> parseUsage    (keep last on error)
6. mergeLanes(lanesInfo, psInfo, sessions) -> LaneRow[]
7. buildLaneTree(lanes, pstree) -> LaneRow[] (roots + childLanes)
8. boopAgents.$({ lanes, tree, sessions, costUsd, calls })
9. signals runtime re-runs shellsRows/agentsRows computeds
10. GridTable re-renders visible rows (virtualized)
```

### Read sequence (row expand, on demand)
```
1. user clicks expand on an addressable lane row
2. onToggle(lane, true) -> findLane(tree, lane)
3. client.route(lane):
   3a. run_click "boop beep lane get <lane>"   -> parseLaneGet  (JSON)
   3b. run_click "boop beep lane route <lane>" -> parseLaneRoute (text `resolved <lane> -> <id>`)
4. stamp route into lanes + withLaneRoute(tree) -> boopAgents.$(...)
5. subRowsFor(row) now yields childLanes + synthetic RouteRow
```

### Write sequences
```
hail:
1. HailCell input Enter -> shellsBridge.hail(lane, body)
2. run_click "boop beep hail <lane> --body <body> --from instant"
3. boop writes the mailbox row; supervisor drains inbox every 700 ms (mid-turn
   delivery per harness; `nextturn` if no in-flight port)
4. next poll tick reflects the lane state; no per-hail UI yet (main.ts:170)

open shell tab:
1. row click -> openTab(row.tmux, { viewer: true })
2. terminal.ts: recordTab -> store.openTabs (persisted)
3. Rust open_session: tmux new-session -A -t <name> (attach existing or create)
4. pty-data-batch Tauri event -> tabs.get(id).term.write(chunk) (main.ts:399-404)

open chat tab (session row):
1. openTab("chat-<harness>-<sessionId>", { cwd, command: harnessAdapter(harness).resume(sessionId) })
2. tmux session runs the harness resume command (not a viewer; close kills per policy)
```

### Event sequence (app-level, unchanged by this work)
```
boot: registerAgentsPanel -> first poll tick (immediate) -> snap -> render
summoned (main.ts:467): refreshSessions + refit active terminal
pty-data-batch (main.ts:399): terminal write for every open tab
beforeunload: stop poll interval (main.ts:133)
reload: store.openTabs replay (main.ts:428-435) reattaches viewer tabs
```

## 8. File-by-file implementation sequence

Numeric order = dependency order. Line budgets respect the ~500 cap; files
already over (boopAgents.ts 507, main.ts 588, reactdock.tsx 886,
tablepanels.tsx 1129) must not grow.

1. `src/shellsPanelV2.tsx` (NEW, ~200 lines)
   ShellsPanelV2 + ShellsBridge + setShellsPanel + shellsRows/shellsGrid +
   cells. Copy column/cell shapes from agentsPanelV2.tsx; shells columns add
   model/tmux/cwd/uptime, drop the session-group rows (tree only).
   No imports of main.ts, no tauri invoke (bridge keeps the boundary out).

2. `src/shellsBridge.ts` (NEW, ~90 lines, only for option (a))
   registerShellsPanel(): client + polling + setShellsPanel wiring.
   If option (b) is chosen, this file does not exist and the agents bridge
   serves both panels (the shells panel reads the same signal + bridge).

3. `src/panels.ts` (EDIT, 109 -> ~120 lines)
   Import ShellsPanelV2; add the `shells` PanelDef to the first builtin
   registration (after `agents`, keeping rail order: sessions, worktrees,
   activity, agents, shells, favorites, config, status).

4. `src/main.ts` (EDIT, 588 lines; net +2/-2)
   - TAB_COMMANDS: rebind per §5 (drop Period from term.strip; Backslash from
     term.sidebar; add shells.toggle + files.toggle entries).
   - If option (a): `registerShellsPanel()` next to line 353 + import.
   - If option (b): no main.ts change beyond the shortcut lines.

5. `src/shellsPanelV2.test.ts` (NEW, ~120 lines)
   - Inline-fixture grid render: build shellsGrid rows from a captured
     BoopSnap fixture (reuse the fixtures in boopAgents.test.ts), snapshot the
     column accessor outputs with toMatchInlineSnapshot.
   - Bridge contract: fake ShellsBridge records open/hail calls; assert
     open(live lane row) calls open with the tmux name (pure: pass a stub).
   - No toBeDefined anywhere; inline snapshots only.

6. `src/boopAgents.test.ts` (EDIT only if §10.2 pane support lands)
   New parser tests with inline fixtures, same style as the existing ones.

7. `e2e/shells-panel.spec.ts` (NEW, optional; ~60 lines)
   Playwright against the built app with a stubbed boop (PATH shim or
   mail-dir fixture): rail button toggles the panel, filter narrows rows,
   row click opens a viewer tab. Follow e2e/cass-swarm.spec.ts shape
   (fixture-backed, data-testid assertions).

8. `SHELL_V2_PLAN.md` (this file) — mark status: implemented.

Not touched: src-tauri/* (no Rust change), vscode-ext/* (no extension
change), scripts/bus.ts (retired; left in place, superseded by boop),
src/plugins/cass/* (deregistered; left in place).

Gate order after each step: `just check` (tsc strict) after 1-4; `just build`
after 4; `just cargo-check` + `just ext-build` only if steps 1-4 pull in Rust
or extension code (expected: no).

## 9. Deterministic tests and verification gates

### Unit (vitest, inline snapshots, no toBeDefined)
- `src/shellsPanelV2.test.ts`
  - `parse-free` grid test: construct a `BoopSnap` from the captured fixtures
    already in boopAgents.test.ts (lane list text + ps TSV + pstree ndjson),
    run `mergeLanes` + `buildLaneTree`, feed the result through the column
    `accessorFn`s; `toMatchInlineSnapshot` on the row-object array.
  - Bridge stub test: `setShellsPanel({ open: spy, ... })`, call
    `shellsBridge.open(<live lane row>)` with a stubbed `openTab` (or assert
    the bridge received the right row kind/lane/tmux); assert `hail` forwards
    `(lane, body)` and resolves.
  - Filter test: `shellsGrid.onGlobalFilterChange("boop")` then read the
    filtered row count (deterministic: fixture has exactly N matching rows).
- `src/boopAgents.test.ts` (existing) — keep green; it is the parser contract
  for every boop output shape the panel depends on.
- Shortcut table test (NEW, small): export the two new command entries (or
  the whole TAB_COMMANDS via a test-only export) and assert
  `$mod+Shift+Period` maps to the shells toggle and `$mod+Shift+Backslash`
  maps to the files toggle, and that no other command claims those keys
  (guards the conflict resolution in §5).

### Live/e2e (optional, not a gate)
- `e2e/shells-panel.spec.ts` (Playwright, fixture-backed like
  e2e/cass-swarm.spec.ts): rail toggle shows `shells · boop` title; filter
  input narrows; row click opens a tab. Requires a stub boop on PATH or a
  `--mail-dir` fixture; never touches the real `~/.agent` store.
- The live suite (e2e-live/*) stays bus-based for now; it exercises the
  retired CLI and is out of scope (see §10.8).

### Gates (AGENTS.md)
| gate | command | when |
|---|---|---|
| typecheck | `just check` (tsc strict) | after every step 1-4 |
| build | `just build` | after step 4 |
| rust | `just cargo-check` | only if src-tauri changes (expected: never) |
| extension | `just ext-build` | only if vscode-ext changes (expected: never) |

### Manual verification (owner only, agent-safe)
- `just dev-safe` (INSTANT_NO_GLOBALS=1) — never `just dev` from an agent
  session (AGENTS.md: fights the owner's tray icon + summon gesture).
- Check: Cmd+Shift+Period toggles the Shells rail panel; Cmd+Shift+Backslash
  toggles Files; lanes appear from the real boop registry; clicking a live
  lane opens a viewer tab that detaches (lane survives) on close.

## 10. Unknowns requiring user input

1. Shells vs agents panel: replace, rename, or coexist? The existing `agents`
   panel (agentsPanelV2.tsx, rail id `agents`) already shows the same boop
   lanes plus session groups. Options: (a) new `shells` panel coexists
   (two rail buttons, one data source, shared client), (b) rename/repurpose
   `agents` -> `shells` and drop the second button, (c) shells panel is the
   agents panel with different columns. This decides whether §8 step 2
   (shellsBridge.ts) exists at all.
2. `boop beep lane pane <lane>` output format is unverified (help says
   "Show the lane's screen"). Needed only if the v2 shell tab should render
   a captured screen instead of a live tmux attach. Current plan: shell tab =
   existing viewer tab (`openTab(tmux, { viewer: true })`), no pane capture.
3. Cmd+Shift+Backslash currently toggles the per-terminal session sidebar
   (src/sessionSidebar.tsx, 629 lines, react-resizable-panels split,
   persisted per terminal). Rebinding it to the Files panel orphans that
   feature. Keep it on a new key (proposed `$mod+Shift+A`), or retire the
   sidebar?
4. Cmd+Shift+Period currently toggles the relations strip (second binding
   `$mod+Shift+x` remains). Confirm dropping Period from term.strip is fine.
5. Spawn scope: should the shells panel offer `boop beep lane create
   --branch ... --brief ...` (worktree + spawn + route, with WARMUP
   `boop-start` recipe semantics), or is v2 read-only + hail + open-tab only?
   Spawn is a write with side effects (worktree, tmux, route) and needs a
   confirm UI.
6. Files target: confirm "files" = the existing `files` rail panel
   (src/plugins/files/, root persisted in pluginState). No new files panel
   planned; the shortcut just toggles it.
7. Persistence: should the shells panel persist filter / expanded rows /
   column widths in a `pluginState.shells` slice (like files does with
   `files.root`), or is session-only state acceptable?
8. Retired-bus cleanup scope: scripts/bus.ts, e2e-live/* (bus-based),
   playwright.busmail.config.ts, the AGENTS.md "Flash 4 bus lanes" section,
   and the deregistered src/plugins/cass/ all remain in the tree. Is cleanup
   in scope for this lane, or a separate chore?
9. BOOP_BIN is hardcoded to the user's claude-research bin path
   (boopAgents.ts:7). Keep, or resolve via PATH / a config key?
10. Two BoopClients (agents + shells) would double-poll the same boop
    commands every 1500 ms. If coexisting panels are confirmed (§10.1),
    confirm the shared-client refactor (src/boopBridge.ts) is wanted, or
    accept the shells panel reading the agents bridge as-is (option (b)).
