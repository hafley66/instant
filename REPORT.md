# REPORT: fix scope:related always-zero in the harnessTrace strip

## What this is

Fixes the in-tab dock strip's "related" scope coming back empty whenever a repo
directory hosts several tmux sessions. A node was joined to exactly one tmux
session (the display guess), and the related scope compared that single string
to the viewer's sid with exact equality, so a viewer on "sprefa-3" never matched
a node whose guess resolved to "sprefa".

## Root cause (as briefed, not re-diagnosed)

A terminal tab's sid is its tmux session name (e.g. "sprefa-3"). Nodes get ONE
tmuxSession via attachTmux (DockStripShared.tsx:128-137): a registry route wins,
else joinTmuxSession(cwd, rows) (2_join.ts:24-31) which returns
`matches.find(namesHarness) ?? matches[0]` (the first match, e.g. "sprefa") when
several tmux sessions share the node's cwd. Related then did exact equality
against the sid (0_tree.ts treeContainsTmux, 0_strip.ts nativeClaudeIds), so
"sprefa" !== "sprefa-3" and related was empty whenever a repo dir hosted more
than one tmux session.

## Fix

Added `tmuxMatches` (every tmux session whose join row matched the node's cwd) so
the related scope matches by set membership while display keeps the single
tmuxSession guess.

| File | Change |
|------|--------|
| src/plugins/harnessTrace/0_types.ts:22-29 | additive `tmuxMatches` on AgentSessionNode. **Deviation:** made it optional (`tmuxMatches?: string[]`) so join-free fixtures in unowned test files (0_mail.test.ts, 0_waterfall.test.ts) keep compiling without editing them. |
| src/plugins/harnessTrace/2_join.ts:27-42 | new `joinTmuxSessions(cwd, rows): string[]` returning every matching row name in row order; `joinTmuxSession` keeps the harness-named tiebreak as display. |
| src/plugins/harnessTrace/DockStripShared.tsx:15,133,135 | attachTmux: routed -> `tmuxMatches: [routed]`; guessed -> full `joinTmuxSessions` list; no match -> `[]`. |
| src/plugins/harnessTrace/0_tree.ts:40-41,144 | node default `tmuxMatches: []`; treeContainsTmux tests `(root.tmuxMatches ?? []).includes(sid)`. buildAgentTree/materializeAgentTree spread nodes, so they carry it. |
| src/plugins/harnessTrace/0_strip.ts:21 | nativeClaudeIds seeds on `(n.tmuxMatches ?? []).includes(sid)`. |
| src/plugins/harnessTrace/2_join.test.ts | added `joinTmuxSessions` block (line 52): shared pwd returns both names in row order; joinTmuxSession keeps old winner. |
| src/plugins/harnessTrace/0_strip.test.ts:168-180 | regression test "StripPolicy.external with a cwd shared by several tmux sessions": node tmuxSession "demo", tmuxMatches ["demo","demo-3"], viewer sid "demo-3"; nativeIds claims the node, related contains the non-native tree. |
| src/plugins/harnessTrace/0_tree.test.ts, 0_strip.test.ts | fixture node helpers derive tmuxMatches from tmuxSession (`tmuxSession ? [tmuxSession] : []`), overridable via partial. |

## Validation (run from worktree root)

### npx vitest run src/plugins/harnessTrace

```
 Test Files  12 passed (12)
      Tests  141 passed (141)
   Start at  09:51:44
   Duration  244ms (transform 520ms, setup 0ms, import 641ms, tests 63ms, environment 1ms)
```

### npx tsc --noEmit

```
src/plugin.test.ts(69,64): error TS2339: Property 'label' does not exist on type 'CtxItem'.
  Property 'label' does not exist on type '{ sep: true; }'.
```

The only error is the pre-existing src/plugin.test.ts(69) CtxItem 'label'
allowed by the brief. No other errors.

### npx playwright test e2e/dock-strip-in-tab.spec.ts

```
Running 2 tests using 1 worker

[WebServer] 9:52:21 AM [vite] (client) Pre-transform error: Failed to resolve import "vega" from "node_modules/.vite/deps/vega-embed.js?v=19cb11ba". Does the file exist?
  ✓  1 e2e/dock-strip-in-tab.spec.ts:61:1 › in-tab strip: external-only lazy tree under the term, mail preview, back (1.3s)
  ✓  2 e2e/dock-strip-in-tab.spec.ts:150:1 › hotkey summons the strip on a fresh terminal with no related sessions (540ms)

  2 passed (3.5s)
```

The WebServer vega line is a vite module-pre-transform warning from an unrelated
dashboard bundle; neither test failed.

## Deviations

1. `tmuxMatches` is optional (`tmuxMatches?: string[]`) instead of the briefed
   required `tmuxMatches: string[]`. The brief's hard ownership list excludes
   0_mail.test.ts and 0_waterfall.test.ts, both of which construct
   AgentSessionNode literals; a required field would force edits to unowned
   files. Optional keeps the gate (only the allowed plugin.test.ts error) and
   all producers set the value. The two reads (treeContainsTmux, nativeClaudeIds)
   default to `[]`.
2. No installs were expected by the brief, but the worktree had no node_modules;
   `pnpm install --frozen-lockfile` was run once to make the validation commands
   executable. pnpm only, as the repo mandates.
