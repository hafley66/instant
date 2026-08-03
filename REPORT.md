# REPORT: bus.ts dispatch + resolve

## diff summary
- `scripts/bus.ts` gains `dispatch` and `resolve` subcommands plus three
  plain helpers (`readRegistryRaw`, `mergeRoute`, `sleepSync`).
- `dispatch`: tmux `new-session` launch + registry route merge
  (`{ harness, tmux, cwd }`) + bus envelope (`kind "dispatch"`), then a
  single `resolve` pass after `--resolve-wait`.
- `resolve`: for an `opencode` route with cwd and no sessionId, queries
  the real opencode.db (read-only sqlite3) for the newest non-archived
  session with that directory; writes the sessionId back on a hit.
- usage lines added to the header comment and the usage print; both
  commands registered in the `commands` map.
- imports: `node:fs` gains `writeFileSync` (the only import change).
- Everything else byte-identical.

## gate outputs

### 1. node --check
```
node --check scripts/bus.ts  ->  clean (exit 0)
```

### 2. scratch receipt (socket `-L busdisp-gate`, mail dir `.gate/mail`)
Default tmux socket read-only `tmux ls`, before:
```
busdispatch-flash: 1 windows
sprefa: 1 windows
sprefa-2: 1 windows (attached)
sprefa-3: 1 windows (attached)
sprefa-4: 1 windows
sprefa-6: 1 windows
```

Dispatch a lane running `sleep 30` into a directory with no opencode
session (proves the miss path), `--resolve-wait 0`:
```
$ node scripts/bus.ts dispatch --to gate-sleep-miss --cwd $PWD/.gate/scratchcwd \
    --cmd "sleep 30" --tmux gate-sleep-miss --socket busdisp-gate \
    --mail-dir .gate/mail --resolve-wait 0; echo $?
dispatched m-853164a0 -> gate-sleep-miss (tmux gate-sleep-miss)
unresolved gate-sleep-miss: no opencode session for .../.gate/scratchcwd yet
0
```

`tmux -L busdisp-gate ls`:
```
gate-sleep: 1 windows (created Mon Aug  3 13:49:39 2026)
gate-sleep-miss: 1 windows (created Mon Aug  3 13:49:49 2026)
```

registry.json:
```json
{
  "gate-sleep": {
    "harness": "opencode",
    "tmux": "gate-sleep",
    "cwd": "/Users/chrishafley/projects/instant-lab-busdispatch",
    "sessionId": "ses_03742b7dcffetPQT00r9WzQKeS"
  },
  "gate-sleep-miss": {
    "harness": "opencode",
    "tmux": "gate-sleep-miss",
    "cwd": "/Users/chrishafley/projects/instant-lab-busdispatch/.gate/scratchcwd"
  }
}
```

envelope line:
```
{"id":"m-853164a0","from":"coordinator","to":"gate-sleep-miss","from_timestamp":"2026-08-03T17:49:49.560Z","to_timestamp":null,"kind":"dispatch","reply_to":null,"body":"sleep 30","ref":null}
```

Explicit `resolve` against the scratch lane (sleep is not opencode):
```
$ node scripts/bus.ts resolve --to gate-sleep-miss --mail-dir .gate/mail; echo $?
unresolved gate-sleep-miss: no opencode session for .../.gate/scratchcwd yet
2
```
Returns exit 2 as specified. (`--resolve-wait 0` was used only to keep
the gate quick; default is 3.)

Note: the first scratch lane (`gate-sleep`, cwd = this worktree) hit a
real session (`ses_03742b7dcffetPQT00r9WzQKeS`) because that directory
has an opencode session, which exercises the resolve-hit path too.

### 3. real opencode.db read-only receipt
Exact SELECT against
`~/.local/share/opencode/opencode.db` (read-only, no writes issued):
```
sqlite3 $HOME/.local/share/opencode/opencode.db \
  "SELECT id FROM session WHERE directory = '/Users/chrishafley/projects/sprefa-recon-query' AND time_archived IS NULL ORDER BY time_created DESC LIMIT 1"
ses_03764e4c9ffegKz7ZjSMlCJHGI   (exit 0)
```
Returns one row; the SQL shape is correct.

### 4. scripts/ test status
scripts/ is outside tsconfig and not covered by vitest, matching hail's
precedent (the harnessTrace suites in src/ are separate).

## scratch teardown proof
```
tmux -L busdisp-gate kill-server  ->  exit 0
tmux -L busdisp-gate ls           ->  "no server running ..." exit 1
```
Scratch `.gate/` dir removed from the worktree; nothing under it is
staged to git.

Default tmux socket read-only `tmux ls`, after (unchanged, no scratch
server leaked):
```
busdispatch-flash: 1 windows
sprefa: 1 windows
sprefa-2: 1 windows (attached)
sprefa-3: 1 windows (attached)
sprefa-4: 1 windows
sprefa-6: 1 windows
```

## usage line
```
node scripts/bus.ts dispatch --to <lane-id> --cwd <dir> --cmd <shell command> [--from <agent>] [--harness <default opencode>] [--tmux <session name>] [--socket <tmux -L socket>] [--body <text>] [--ref <path>] [--mail-dir <dir>] [--resolve-wait <seconds>]
node scripts/bus.ts resolve --to <lane-id> [--mail-dir <dir>]
```
