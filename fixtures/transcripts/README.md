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

Keys named for credentials (`*token*`, `*secret*`, `*api_key*`, `*password*`, `*authorization*`,
`*cookie*`) and opaque `encrypted_*` values become `"[dropped]"`, since redacting inside ciphertext
leaves a half-scrubbed blob and buys no coverage. Codex stores its reasoning as Fernet ciphertext
under `encrypted_content`, which is where that rule earns its keep.

Verify with:

```
node scripts/scan-secrets.mjs fixtures/transcripts
```

It fails on key formats (Anthropic, OpenAI, GitHub, AWS, Google, Slack, Stripe, npm, JWT, PEM, SSH),
`Bearer` headers, credential-shaped assignments, emails, URL credentials, any `/Users/<name>` that
is not `/Users/dev`, and any 40-plus-character mixed-case run that is not a path.

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
| `injections` | lines the CLI writes as `type: "user"` without the user typing them: task notifications, compaction summaries, slash-command bodies |

`claude/subagent.jsonl` is a separate sidechain transcript (`isSidechain: true` lines).

Known gap: the kimi fixture has no `subagents` group. No kimi session on the capture machine
dispatched a Task; rerun the capture on a machine that has one to fill it in.

## Terminal replay artifacts

`terminal/*.cast` uses the asciicast v2 NDJSON format. These fixtures are runner-neutral: a
renderer test, native-adjacent test, or compiled-app driver can select a Codex, Claude Code, or
OpenCode artifact with `terminalCastReplay` from `scripts/0_terminalCast.ts`, then run its returned
`asciinema play` command inside the terminal substrate under test. Each replay also carries the
matching Boop user and assistant records. Input events remain explicit in the cast, so the adapter
can validate what the harness received separately from the terminal bytes Instant rendered.

The adapter reports an explicit prerequisite result through `asciinemaAvailability()`. Missing
`asciinema` is a skipped substrate prerequisite or a setup error at the caller's tier. It does not
fall back to direct xterm writes because that would remove the PTY/tmux portion of the test path.
The native-adjacent suite uses `@microsoft/tui-test` for PTY ownership, terminal emulation,
readiness, and asciicast capture.
