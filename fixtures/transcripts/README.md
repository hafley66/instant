# Transcript fixtures

Sanitized slices of real harness sessions, used by `src-tauri/src/ledger.rs` tests to check
role classification against the wire formats the parser actually meets.

## Regenerate

```
node scripts/capture-transcripts.mjs            # rewrite every fixture
node scripts/capture-transcripts.mjs --check    # verify coverage, write nothing
node scripts/capture-transcripts.mjs --harness kimi --per-kind 3
```

Flags: `--per-kind` (records kept per record kind, default 2), `--max-chars` (string trim,
default 600), `--max-items` (array trim, default 8), `--harness`, `--check`.

Sessions are found with `cass search --agent <slug> --json --fields source_path,line_number,agent`,
falling back to the on-disk layouts `ledger.rs` reads when cass returns nothing.

## Sanitizing

Every string and every object key passes through `deIdentify`: `$HOME` becomes `/Users/dev`,
the local username becomes `dev`, and emails, `sk-`/`ghp_`/`github_pat_`/`xox`/`AKIA` tokens,
`Bearer` values, and PEM private-key blocks are replaced. Strings over `--max-chars` and arrays
over `--max-items` are cut with a `…[trimmed N]` marker, so a fixture never carries a full file
body or a full tool-schema dump.

## Coverage

`manifest.json` records, per fixture, the source line count, the record kinds kept, and which
feature groups they cover:

| group | what it proves the parser sees |
| --- | --- |
| `files` | Read / Edit / Write tool calls |
| `tasks` | task create / update records |
| `subagents` | Agent (Task) dispatch, plus a sidechain transcript for Claude |
| `skills` | injected skill bodies, which arrive as meta rows |
| `thinking` | reasoning blocks |
| `roles` | a typed user message, an assistant reply, and a tool result |

`claude/subagent.jsonl` is a separate sidechain transcript (`isSidechain: true` lines).

Known gap: the kimi fixture has no `subagents` group. No kimi session on the capture machine
dispatched a Task; rerun the capture on a machine that has one to fill it in.
