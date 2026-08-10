# Boop lane creation and completion observability follow-up

## Incident

Coordinator command:

```sh
boop beep lane create \
  --lane instant-grid-file-tree \
  --cwd /Users/chrishafley/projects/instant \
  --brief /private/tmp/instant-grid-file-tree-brief.md \
  --harness codex \
  --model gpt-5.6-luna \
  --branch lane/instant-grid-file-tree \
  --base-sha 8d869a6d3391109f08a6811ad50bba031649b4e2
```

Date: 2026-08-10.

## What worked

| Stage | Evidence |
| --- | --- |
| Help contract | `boop --help` and `boop beep lane create --help` described the required dry run and worktree mode. |
| Dry run | Printed the Codex command, lane, branch, worktree, tmux target, harness, and model. |
| Worktree | `.boop-worktrees/lane/instant-grid-file-tree` was created from the requested SHA. |
| Branch | `lane/instant-grid-file-tree` was created. |
| Dispatch | Boop printed `dispatched m-ca4f2a90 -> instant-grid-file-tree (tmux instant-grid-file-tree)`. |
| Harness execution | Codex completed the requested migration. |
| Session discovery | `boop beep lane route instant-grid-file-tree` eventually resolved `019fec31-17a6-7511-af1b-2b83b718f581`. |
| Implementation | Commit `be7352f177fa48b55fcd685549745ba9a5cf07e1`, `Migrate file explorer to grid tree`. |
| Final report commit | Commit `a2c692f70249309003cd2f87e91224babe1e627a`, `Record file-tree migration commit`. |
| Receipts | `receipts/file-tree-collapsed.png` and `receipts/file-tree-expanded.png`. |
| Agent checks | `just check`, `just cargo-check`, focused Vitest, and Vite build reported as passing in `REPORT.md`. |

## What failed or produced misleading state

### 1. Lane creation is not transactional

The first creation attempt ran inside a filesystem sandbox. Git worktree and
branch creation succeeded, then tmux `send-keys` failed with `Operation not
permitted`. Boop left both artifacts behind and registered no lane route.
Rerunning the same command failed because the worktree path already existed.

Expected postcondition for a failed `lane create`:

```text
no route + no spawned process + no new worktree + no new branch
```

Alternative accepted postcondition:

```text
recoverable partial lane record containing completed stages and a resume command
```

### 2. A successful dispatch has no readiness acknowledgement

`lane create` returned after tmux dispatch. At that point `lane get` contained
`session_id: null`. The command did not distinguish these states:

```text
tmux command accepted
harness process started
harness session discovered
brief read
first model event recorded
task completed
```

Add a bounded readiness phase or an explicit `--wait-for` option:

```text
--wait-for pane|process|session|first-event
```

The returned record should include the highest confirmed stage.

### 3. One-shot completion removes the only stdout/stderr surface

Codex uses `codex exec`. Its tmux session exits when the command finishes.
Afterward, `boop beep lane pane` returned `can't find session`, so the
coordinator could not inspect the final output or exit reason.

Persist per-lane process output and exit metadata outside tmux:

```ts
interface LaneRunResult {
  lane: string
  dispatchId: string
  sessionId: string | null
  startedAt: number
  exitedAt: number | null
  exitCode: number | null
  stdoutPath: string
  stderrPath: string
  worktreeHeadBefore: string
  worktreeHeadAfter: string | null
}
```

`lane pane` may remain the live view. Add `lane output` or make `lane get`
return the durable output paths after the pane exits.

### 4. Lane state conflates inaccessible tmux with process death

Without permission to reach `/private/tmp/tmux-501/default`, `lane get` showed
`state: ?`. With tmux permission, the same lane later showed `dead`. Neither
state indicated that the one-shot Codex run had completed successfully.

Use separate fields:

```ts
interface LaneState {
  tmuxProbe: "live" | "dead" | "inaccessible"
  process: "starting" | "running" | "exited" | "unknown"
  outcome: "pending" | "success" | "failure" | "unknown"
  exitCode: number | null
}
```

An authorization failure must remain `inaccessible`; it must not lower to
`dead` or `unknown`.

### 5. Route surfaces disagree during and after execution

`lane get` continued to report `session_id: null`, while `lane route` resolved
the Codex session ID. The route command then attempted a registry temp-file
write and failed under the filesystem sandbox after printing the resolution.

Required properties:

- Session resolution updates one canonical lane record atomically.
- Read commands remain read-only unless explicitly named `resolve` or `sync`.
- Output is emitted only after any required write succeeds.
- `lane get` and `lane route` read the same canonical session ID.

### 6. Completion reporting depends on a resolvable coordinator identity

`boop whoami` returned every identity field as `-`, with rung `none
(unresolved)`. The coordinator therefore could not supply a valid `--parent`,
and no completion hail was available.

Add an explicit coordinator identity mechanism for API shells:

```text
boop beep lane create --parent <stable-id>
BOOP_IDENTITY=<stable-id>
boop whoami --set <stable-id>
```

The lane result should still be queryable without parent mail.

## Proposed sequence

1. Add a stage journal around worktree creation, tmux creation, process start,
   route registration, session discovery, and exit.
2. Add rollback tests for failures after each stage.
3. Capture stdout, stderr, and exit code for every one-shot harness adapter.
4. Split tmux reachability, process liveness, and task outcome in the lane wire
   type and CLI rendering.
5. Make route resolution update one canonical lane record and keep read commands
   free of writes.
6. Add coordinator identity injection for non-tmux API sessions.
7. Add an integration fixture that runs a deterministic shell lane which edits
   and commits one file, exits zero, and is inspectable after tmux disappears.
8. Repeat the fixture with tmux access denied and assert `inaccessible`, retained
   output, retained outcome, and no false `dead` classification.

## Acceptance snapshots

Successful one-shot lane:

```json
{
  "lane": "fixture",
  "tmuxProbe": "dead",
  "process": "exited",
  "outcome": "success",
  "exitCode": 0,
  "sessionId": "session-1",
  "headBefore": "abc",
  "headAfter": "def"
}
```

Denied tmux probe:

```json
{
  "lane": "fixture",
  "tmuxProbe": "inaccessible",
  "process": "exited",
  "outcome": "success",
  "exitCode": 0
}
```

Failed creation after worktree creation:

```json
{
  "lane": "fixture",
  "stage": "tmux-create",
  "outcome": "failure",
  "rolledBack": ["worktree", "branch"]
}
```
