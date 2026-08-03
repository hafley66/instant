# REPORT: three bus.ts fixes (audit-found, fail-demo then fix)

## diff summary
- `scripts/bus.ts` only. Three audit-found bugs:
  1. `dispatch` never stamps the envelope id into the lane transcript, so
     cass cannot ack a dispatch row.
  2. `resolve` refuses any cwd containing a single quote instead of escaping
     it into the SQL literal.
  3. `sweep` has no age cutoff: a dead dispatch (null `to_timestamp`, lane
     long gone) is queried forever and never skipped.
- Fixes:
  1. After `tmux new-session` succeeds, dispatch stamps
     `[bus <id>] dispatched: <body first line>` into the fresh session using
     the same `injectedLine()` primitive hail uses, via `MailLeg.tmuxSendArgs`.
  2. `resolve` now double-escapes a single quote (`'` -> `''`) into the
     sqlite3 literal (the CLI has no bind params) and refuses only on a NUL
     byte, which cannot survive argv.
  3. `sweep` gains `--max-age-days` (default 7). An unacked row whose
     `from_timestamp` is older than the cutoff is skipped and printed once as
     `expired <id>`; the summary gains an `expired N` count.
- Exit codes unchanged.

## Gate

### 1. node --check
```
node --check scripts/bus.ts  ->  clean (exit 0)
```

### 2. fail-demonstration on base code (before the fix, scratch `-L busfix-gateb`)
Dispatch a lane from the base commit:
```
$ node scripts/bus.ts dispatch --to gate-delay --cwd <...>/.gateb/scratchcwd \
    --cmd "sleep 30" --tmux gate-delay --socket busfix-gateb \
    --mail-dir .gateb/mail --resolve-wait 0; echo $?
dispatched m-0f580bde -> gate-delay (tmux gate-delay)
unresolved gate-delay: no opencode session for <...>/.gateb/scratchcwd yet
0
```
capture-pane: empty, no `[bus ...]` stamp -> bug 1.
```
tmux -L busfix-gateb capture-pane -p -t gate-delay
(blank; no stamped line)
```
resolve with a single-quoted cwd in the registry route:
```
$ node scripts/bus.ts resolve --to gate-quote --mail-dir .gateb/mail; echo $?
unresolved gate-quote: cwd contains a single quote, refusing
1
```
-> bug 2 refused instead of escaping.

sweep with an aggressive cutoff on base code (still no expiry):
```
$ node scripts/bus.ts sweep --mail-dir .gateb/mail --max-age-days 0; echo $?
m-0f580bde -> gate-delay: no registry route, cannot scope the cass query
swept 1 unacked, acked 0
0
```
-> bug 3: old row not skipped, no `expired` line.

### 3. fixed behavior (scratch `-L busfix-gate`)
Dispatch a lane from the fixed code:
```
$ node scripts/bus.ts dispatch --to gate-sleep-miss --cwd <...>/.gate/scratchcwd \
    --cmd "sleep 30" --tmux gate-sleep-miss --socket busfix-gate \
    --mail-dir .gate/mail --resolve-wait 0; echo $?
dispatched m-1f938e1e -> gate-sleep-miss (tmux gate-sleep-miss)
unresolved gate-sleep-miss: no opencode session for <...>/.gate/scratchcwd yet
0
```
capture-pane now carries the stamped id (bug 1 fixed):
```
$ sleep 1; tmux -L busfix-gate capture-pane -p -t gate-sleep-miss
[bus m-1f938e1e] dispatched: sleep 30
```
Envelope id matches the stamp (so cass can ack):
```
$ cat .gate/mail/bus.ndjson
{"id":"m-1f938e1e","from":"coordinator","to":"gate-sleep-miss","from_timestamp":"2026-08-03T22:45:51.602Z","to_timestamp":null,"kind":"dispatch","reply_to":null,"body":"sleep 30","ref":null}
```
resolve with a single-quoted cwd no longer refuses; it escapes and takes the
normal miss path (bug 2 fixed):
```
$ node scripts/bus.ts resolve --to gate-quote --mail-dir .gate/mail; echo $?
unresolved gate-quote: no opencode session for <...>/.gate/O'Brien/cwd yet
2
```
sweep with `--max-age-days 0` skips the old unacked row (bug 3 fixed):
```
$ node scripts/bus.ts sweep --mail-dir .gate/mail --max-age-days 0; echo $?
expired m-1f938e1e
swept 1 unacked, acked 0, expired 1
0
```
Default (7 days) keeps a fresh row inside the cutoff:
```
$ node scripts/bus.ts sweep --mail-dir .gate/mail; echo $?
m-1f938e1e -> gate-sleep-miss: no registry route, cannot scope the cass query
swept 1 unacked, acked 0, expired 0
0
```

### 4. scratch teardown
```
tmux -L busfix-gate kill-server  ->  no server running (exit 1, already gone)
tmux -L busfix-gateb kill-server ->  exit 0
rm -rf .gate .gateb
tmux -L busfix-gate ls   ->  no server running (exit 1)
tmux -L busfix-gateb ls  ->  no server running (exit 1)
```
Neither scratch server leaked; scratch dirs removed from the worktree.
