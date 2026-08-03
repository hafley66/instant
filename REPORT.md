# REPORT: harness-trace panel lab (fable lane)

## 1. Base + install receipts

- Worktree: /Users/chrishafley/projects/instant-lab-trace-fable, branch lab/harness-trace-fable
- FIRST action `git merge --ff-only 0e4e0173`: "Already up to date."; `git rev-parse HEAD` = 0e4e01734fd983f157dfbc49b2454e803aa4557b
- SECOND action `corepack pnpm@10.12.4 install --prefer-offline`: "Done in 8.3s using pnpm v10.12.4", exit 0
- Nothing committed, nothing written outside the worktree, `just dev` never run.

## 2. What was built

| file | lines | role |
|---|---|---|
| src-tauri/src/harness.rs | 477 (+311) | trace section: `HarnessTraceRow` serde struct (camelCase; row model minus from/why), per-store readers `trace_claude/trace_opencode/trace_codex/trace_kimi`, `ms_to_iso`, `trace_status`, `tildify`, `trace_rows`, command `harness_trace_rows`, `#[cfg(test)]` module (4 tests) |
| src-tauri/src/lib.rs | +1 | `harness::harness_trace_rows` in invoke_handler |
| ipc/commands.json | +1 entry | `"harness_trace_rows"` in the harness group |
| src/generated/native.ts | +2 (generated) | via `corepack pnpm@10.12.4 run api:generate`, never hand-edited |
| src/plugins/harnessTrace/0_types.ts | 32 | frozen `HarnessTraceRow`, `HarnessTraceSeed = Omit<Row,"from"|"why">`, `MailEnvelope`, `MailRegistry` |
| src/plugins/harnessTrace/0_mail.ts | 72 | pure `parseMailNdjson` / `parseMailRegistry` / `enrichRows` (no fs, no invoke) |
| src/plugins/harnessTrace/0_mail.test.ts | 98 | 8 vitest tests incl. the S2 sabotage receipt |
| src/plugins/harnessTrace/HarnessTracePanel.tsx | 239 | TreeTable panel, columns copy the TMUX_COLUMNS shape (tablepanels.tsx:56); bridge-free invoke like the cass plugin; persisted sorting via readPluginState/savePluginState under "harness-trace"; fs-watch leg; per-row cass trace action |
| src/plugins/harnessTrace/index.ts | 15 | `registerHarnessTracePlugin` mirroring src/plugins/cass/index.ts |
| src/main.ts | +2 | registration call at :243 beside `registerCassPlugin()` (:241) plus the required import at :25 (the brief said one line; the call is one line, the import is unavoidable TS plumbing) |

Data flow: `harness_trace_rows` (rust) enumerates all four stores globally (no cwd filter), sorts newest-activity-first, returns seeds with `ts`/`lastActivity` as ISO UTC and `cwd` tildified. The frontend maps seeds -> rows with `from:"user"`, `why:""`, then enriches from the mail ledger.

Mail-ledger join placement: frontend, because the brief fixes the rust payload to the row minus from/why and the mail files are reachable through the existing `list_dir`/`read_text` commands, leaving the join as pure sync array code with direct vitest coverage. Join rule: envelope `to` resolves through `registry.json` (flat name -> sessionId map) else matches a sessionId directly; the oldest matching envelope per session supplies `from`, `why` (body first line), and the row `id`. `~/.agent/mail` is absent on this machine today (`test -d` = absent), so the live path exercises the zero-enrichment/zero-error branch; the join itself is proven by unit tests.

fs-watch leg: the panel probes `list_dir("~/.agent/mail")`; only on success does it `claimFsWatch` (src/fsWatch.ts) on the dir, reloading rows on events; the claim is released in the effect cleanup (panel dispose). No polling loops.

cass action: per-row "trace" button invokes `cass_swarm_status` (ledger.rs:114) with the row's untildified cwd and renders the status line in the panel; `CassSwarmStatus` type reused from src/plugins/cass/0_types.ts. No shelling from the frontend.

## 3. Subagent-marker evidence

Marker found empirically; the filter is implemented.

- Current layout: subagent transcripts live OUTSIDE the top-level session glob, at `<projectDir>/<parentSessionId>/subagents/agent-<id>.jsonl`. Example on disk: `/Users/chrishafley/.claude/projects/-Users-chrishafley-projects-sprefa/c72a1e89-1e73-4afa-9f61-f5588f4e388d/subagents/agent-a1abf4da0fd7df26d.jsonl`.
- Line-level marker: every record in that file carries `"isSidechain":true` (grep count: 26 of 26 lines; extracted fragment: `"parentUuid":<uuid>,"isSidechain":true,"promptId"`).
- Main sessions: top-level `<projectDir>/<uuid>.jsonl` records carry `"isSidechain":false` (sample `7d976dd8-....jsonl`: 1244 false, 0 true). Zero of 74 top-level files in the sprefa project dir and zero of 4 in the instant project dir contain any `"isSidechain":true`.
- Filter as implemented (trace_claude): the walk is non-recursive over `<projectDir>/*.jsonl` (structurally excludes `subagents/`), and the first records of each file are additionally checked for `"isSidechain":true` (skip if found) in case an older store kept sidechains top-level.

Note: full-line reads of session files were blocked by the permission classifier; the evidence above was gathered with count/fragment greps (receipts in section 6).

## 4. Gate receipts

- `just cargo-check`: exit 0. "Finished `dev` profile ... in 18.68s", real 18.81s (worktree deps were warmed by the preceding cargo test build, cold 40.93s).
- `cargo test --manifest-path src-tauri/Cargo.toml harness::`: exit 0, "4 passed; 0 failed" (includes S1).
- `vitest run src/plugins/harnessTrace/0_mail.test.ts`: "Tests 8 passed (8)" (includes S2).
- `corepack pnpm@10.12.4 run api:generate` then `api:check` (inside just check): generated file regenerated, check passes.
- `just check`: FAILS with exit 2 on `src/plugin.test.ts(69,64): error TS2339: Property 'label' does not exist on type 'CtxItem'`. Pre-existing at base: with all my tracked changes stashed, `tsc --noEmit` reports the identical error. With my changes applied it is the ONLY tsc error; my code adds zero. (dl todos-check leg: "green-by-skip", cold worktree db refused by design, class 14.)
- `just build`: FAILS, same pre-existing tsc error (build = api:check && tsc && vite build). Supplementary: `vite build` alone transforms all 4480 modules including this lab's, then fails resolving `"vega"` imported by `vega-embed` (imported at src/plugins/metrics/1_dashboard.tsx:2; `vega` is not in package.json dependencies) — base metrics-plugin condition, untouched by this lab.
- `just test`: "Test Files 1 failed | 37 passed (38); Tests 4 failed | 233 passed (237)". The 4 failures are all src/panelZoom.test.ts; probe with my tracked changes stashed reproduces the same 4 failures at base. All 8 of this lab's tests pass inside the run.

Per the brief's STOP doctrine I did not patch the unrelated base files (src/plugin.test.ts, panelZoom, vega dependency) to force the gates green; the stash probes above attribute every red to base 0e4e0173.

## 5. Sabotage receipts

- S1 (missing harness stores yield empty, not a crash): every trace reader takes `home: &Path` as a parameter; `harness::tests::trace_rows_from_nonexistent_home_is_empty` points all four readers plus the aggregate at `/nonexistent-home-for-harness-trace-test` and asserts empty vecs. `cargo test harness::` output: `test harness::tests::trace_rows_from_nonexistent_home_is_empty ... ok`. (The brief's "via env" example was replaced by parameter injection: mutating HOME in a multithreaded test binary races; the real HOME was never touched.)
- S2 (malformed NDJSON line skipped, rest kept): `0_mail.test.ts` "skips a malformed line and keeps the rest" feeds `[valid, "{this is not json", valid]` through `parseMailNdjson` and asserts exactly the two valid envelope ids survive. vitest: passed. Real `~/.agent/mail` was never written (it does not exist).

## 6. Deviations from CONTRACT.md

- Gates: `just check`, `just build`, `just test` are red at base 0e4e0173 for reasons outside this lab (receipts and base-attribution probes in section 4). The contract's "all must pass" is unsatisfiable on this base without editing unowned files; per the brief I stopped and recorded instead of improvising fixes.
- `status` semantics: the contract froze the enum but not the mapping. Implemented: `dead` = the session's recorded cwd no longer exists on disk; else by last store write: `live` <= 2 min, `idle` <= 60 min, `done` older. Constants TRACE_LIVE_MS/TRACE_IDLE_MS in harness.rs.
- `registry.json` schema: unbuilt bus, no fixture on disk; assumed a flat JSON object `{ "<to-name>": "<sessionId>" }`, non-string values ignored, malformed file = empty registry.
- Kimi `ts` (start time) uses state.json `created()` (birthtime, present on macOS/APFS), falling back to "" when unavailable; the store has no explicit start-time field in the layout documented by harness.rs:114.
- cass "search for the session id": no such command exists in ipc/commands.json; the contract's "and/or" was satisfied with the `cass_swarm_status` branch only.
- ISO formatting is a ~20-line hand-rolled civil-from-days converter (unit-tested). Build-vs-buy note: chrono/time would each add a new dependency tree to a crate graph that currently has zero date crates and passes unix ms everywhere else (fs.rs, ledger.rs); the lab needed exactly one formatter, UTC-only.
- Permission classifier denials during research (recorded, not worked around): full-line `head`/`cut` of `~/.claude` session jsonl content, `ls ~/.agent`, `ls ~/.kimi-code/sessions`, `find ~/.codex/sessions` counts, and `SELECT` sampling of opencode.db rows were all blocked. Marker evidence was gathered with grep counts/fragments (allowed); codex/kimi field names (`session_meta.payload.{id,cwd}`, `state.json.workDir`) were taken from the existing readers in harness.rs and ledger.rs, which the contract designates as the authority; opencode `time_created`/`time_updated` come from the sqlite schema (`.schema session` was permitted; row sampling was not).
- src/main.ts gained 2 lines, not 1: the registration call beside registerCassPlugin() plus its import.
