# CONTRACT: harness-trace panel (cross-harness session trace)

Seeded by the coordinator. The lab implements exactly this; deviations are
reported in REPORT.md, never improvised.

## What the panel is

One new instant panel, id `harness-trace`, showing every interactive agent
session dispatched across the four harnesses (claude, opencode, codex, kimi):
which session, from which harness, ran for whom, when, and why, with liveness.
It is a normal dockview panel (the user docks it at the bottom themselves);
NO new global chrome, footer, or statusbar elements — index.html shows the app
has none and this lab does not introduce one.

## Row model (frozen)

```ts
export interface HarnessTraceRow {
  id: string;                 // session id (or dispatch envelope id when known)
  harness: "claude" | "opencode" | "codex" | "kimi";
  sessionId: string;
  from: string;               // who dispatched it ("user" when unknown)
  why: string;                // dispatch reason / brief first line ("" when unknown)
  ts: string;                 // start time, ISO
  lastActivity: string;       // ISO, from session store mtime/db
  status: "live" | "idle" | "done" | "dead";
  cwd: string;                // tildified, display-ready (TmuxRow.pwd precedent)
}
```

## Filter rule (frozen)

Claude Code subagent sessions spawned BY Claude Code do not render (they have
their own TUI). Determine the marker empirically from ~/.claude/projects
session files (candidates: sidechain flags, subagents/ paths). If no reliable
marker is found, STOP that sub-goal and record what was tried in REPORT.md;
do not guess a heuristic silently.

## Data sources, in precedence order

1. Dispatch ledger (who/when/why): `~/.agent/mail/*.ndjson` envelopes
   `{id, from, to, ts, kind, reply_to, body, ref}` — may be EMPTY or absent
   today (the bus is designed, not built). The panel renders rows without it;
   ledger rows enrich `from`/`why` by joining on session where possible.
2. Session enumeration + liveness: the existing rust readers in
   src-tauri/src/harness.rs (claude_sessions :24, opencode_sessions :59,
   codex_sessions :93, kimi_sessions :117, commands harness_sessions /
   harness_session :149-166). If Vec<String> payloads are too thin for the row
   model, add ONE new tauri command (e.g. harness_trace_rows) in harness.rs
   following its existing style, register it in ipc/commands.json, and run
   `corepack pnpm@10.12.4 run api:generate` (generated/native.ts is
   generated-only, header says do not hand-edit).
3. cass: per-row "trace" action uses the existing cass commands
   (cass_status ledger.rs:103, cass_swarm_status :114) and/or opens a cass
   search for the session id; reuse the cass plugin surface
   (src/plugins/cass/index.ts) — do not shell to cass from the frontend.

## Refresh

Refresh-on-show like TmuxPanelV2 (tablepanels.tsx:215) PLUS a live leg:
claimFsWatch (src/fsWatch.ts:10-29, rust fs_watch.rs) on ~/.agent/mail when it
exists. No polling loops.

## Repo laws that bind this lab (from AGENTS.md, verified)

- Rows render with TreeTable (src/treetable.tsx) copying the
  tablepanels.tsx column-def + bridge shape (TmuxRow/TMUX_COLUMNS/setTmuxPanel
  precedent at :15/:56/:51). No hand-rolled lists. No third table impl.
- One panel per file, files under ~500 lines.
- Registration: new plugin dir src/plugins/harnessTrace/ mirroring
  src/plugins/cass/index.ts (registerPlugin({id, panels:[...]})), plus ONE
  line in src/main.ts main() beside registerCassPlugin() (main.ts:238-242).
  Rail/dock/palette pick it up from the registry; touch nothing else there.
- Persisted panel state via readPluginState/savePluginState
  (src/pluginState.ts:6-16) under id "harness-trace".
- NEVER run `just dev`. Verification uses `just check`, `just build`,
  `just cargo-check`; `just dev-safe` only if a live look is required.

## Gates (all must pass, receipts in REPORT.md)

- `just check` (api:check + tsc strict)
- `just build`
- `just cargo-check` (only compiles rust; cold worktree may be slow — record
  the time, do not abort for slowness)
- `just test` if any code you touched has vitest coverage
