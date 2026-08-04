# REPORT: add `lane` verb to scripts/bus.ts

## What changed (scripts/bus.ts only)

| Lines | Change |
|-------|--------|
| 11 | header comment documents the new `lane` verb |
| 166 | `dispatch` now returns `resolve(args)` instead of hardcoded `0`, so a caller (the `lane` verb) gets the 2 = still-unresolved contract from a function call |
| 317-350 | new `function lane(args)` |
| 352-357 | `lane` registered in the `commands` map and top usage string |

## lane implementation

Composes and executes the existing dispatch path by function call (never shelling
out to itself):

- `cmd = opencode run -m <model> --auto "$(cat <brief>)"`, model defaults to
  `openrouter/deepseek/deepseek-v4-flash-0731`
- `harness = opencode`, `tmux` defaults to the `--name` value
- envelope `body` = first non-empty trimmed line of the brief file
- brief defaults to `<cwd>/brief.md`; missing file => exit 1
- missing `--cwd`/`--name` => usage error, exit 1
- `--dry-run` prints the composed cmd plus every dispatch argument on separate
  `key: value` lines (defaults resolved in the print) and exits 0
- otherwise calls `dispatch()`, which resolves the lane; exit propagates
  (0 resolved, 1 usage/route, 2 dispatched but no opencode session yet)

## Validation (verbatim)

```
$ node scripts/bus.ts lane 2>&1; echo "exit=$?"
usage: bus.ts lane --cwd <dir> --name <lane-id> [--brief <path>] [--model <id>] [--tmux <name>] [--mail-dir <dir>] [--resolve-wait <seconds>] [--dry-run]
exit=1
```

```
$ node scripts/bus.ts lane --cwd /tmp/buslane-test --name t1 --dry-run --mail-dir /tmp/buslane-mail; echo "exit=$?"
cmd: opencode run -m openrouter/deepseek/deepseek-v4-flash-0731 --auto "$(cat /tmp/buslane-test/brief.md)"
to: t1
cwd: /tmp/buslane-test
harness: opencode
tmux: t1
body: test brief line
mail-dir: /tmp/buslane-mail
resolve-wait: 3
exit=0
```

```
$ node scripts/bus.ts lane --cwd /tmp/nope-$$ --name t2 --dry-run 2>&1; echo "exit=$?"
brief file not found: /tmp/nope-66547/brief.md
exit=1
```

```
$ node scripts/bus.ts list --agent t1 --mail-dir /tmp/buslane-mail; echo "exit=$?"
t1: 0 in, 0 out, 0 unacked
exit=0
```

## Gates

`just check` (tsc strict) reports only pre-existing errors in `src/` (treetableRow,
vitest/react/@tanstack module-resolution, rxjs); none reference `scripts/bus.ts`.
The repo pre-existing tsc baseline is broken on those unrelated files; out of scope
per the brief (no src/ changes).

## Deviations

- `dispatch`'s tail changed from `resolve(args); return 0;` to `return resolve(args);`
  so the lane verb can propagate the documented exit-code contract (2 = dispatched but
  not yet resolved) from a function call. This is the only behavioral change to an
  existing path; the existing `dispatch` verb itself now also returns 2 when resolve
  has no session yet, matching the header's documented contract.
- Lane's `--dry-run` prints default-resolved values for `mail-dir`/`resolve-wait`
  (the same defaults dispatch applies) so the printed invocation matches what a real
  run would do.
