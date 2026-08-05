# Lane: bus-resolve-codex — session ground truth in the strip

Theme: the external-shells table stops trusting dispatch args and reads each
session's own artifacts. Two changes land: `bus resolve` fills `sessionId` +
`model` for a codex route from the codex rollout itself, and `bus sweep` stamps
current input-token usage into every live route's registry row so the strip can
render a tokens column.

Note: verifies against commit `7b8c890` (merge `--ff-only` = "Already up to
date", HEAD was already the target).

## TOC

- [First-action / deviations](#first-action--deviations)
- [Research receipts](#research-receipts)
- [Changes (file:line)](#changes-fileline)
- [Before/after registry rows](#beforeafter-registry-rows)
- [Validation output](#validation-output)
- [Deviations](#deviations)

## First-action / deviations

`git merge --ff-only 7b8c890...` printed `Already up to date.` (exit 0). HEAD
was already at the target commit, so no worktree/merge movement was required;
we edited in place on the checked-out worktree as the brief's subsequent
file-ownership list expects (scripts/, src/plugins/harnessTrace/).

## Research receipts

Codex rollouts live under `~/.codex/sessions/<yyyy>/<MM>/<dd>/rollout-*.jsonl`
(date-nested). The rxregex lane (cwd `~/projects/sprefa-codex-regexp`, is a
verified specimen; its rollout from today is `rollout-2026-08-04T19-25-23-019fcf18-...jsonl`).

Session identity comes from the first line's `session_meta` payload; model from
per-turn `turn_context` records; cumulative token usage from per-turn
`event_msg` `token_count` records.

```bash
# jq: session_id + cwd from the session_meta first line
head -1 rollout-...jsonl | jq -r '.type, .payload.session_id, .payload.cwd'
# session_meta
# 019fcf18-994d-7900-bd11-d572d12fdb1f
# /Users/chrishafley/projects/sprefa-codex-regexp

# jq: model from the LAST turn_context record
cat rollout-...jsonl | jq -r 'select(.type=="turn_context") | .payload.model' | tail -1
# gpt-5.6-luna

# jq: cumulative input tokens from the LAST token_count event
cat rollout-...jsonl | jq -r 'select(.type=="event_msg" and .payload.type=="token_count") | .payload.info.total_token_usage.input_tokens' | tail -1
# 10445688
```

Claude transcripts: no cumulative field; the per-message `usage` object carries
`input_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`. Current
context = the last assistant usage's input side summed.

```bash
# claude: last assistant usage object (per-message)
... | node -e 'let m=null;...rl.on("line",l=>{const a=l.match(/"usage":\{[^}]*\}/);if(a)m=a[0]})...'
# "usage":{"input_tokens":2,"cache_creation_input_tokens":693,"cache_read_input_tokens":214148,...,"output_tokens":197,...}
```

opencode.db (`~/.local/share/opencode/opencode.db`, table `message`, column
`data` is JSON with `tokens.input`): verified with one sqlite3 query.

```bash
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT json_extract(data,'$.tokens.input') FROM message WHERE session_id='ses_...' ORDER BY time_created DESC LIMIT 1;"
# 0   (current in-flight last message; grows as the lane runs)
```

cass call site in the ack path: `scripts/bus.ts` line ~323
(`run("cass", MailLeg.cassSearchArgs(message))`); the earlier `scripts/bus.ts`
ack sweep shells to it to prove reads against transcripts/rollouts. cass
indexes codex rollout paths (verified by `cass search` returning
`/Users/chrishafley/.codex/sessions/.../rollout-*.jsonl` hits).

## Changes (file:line)

| file | line | change |
|---|---|---|
| `scripts/bus.ts` | 119 | `codexRolloutFor(cwd)`: recursive walk of `~/.codex/sessions`, newest rollout whose session_meta cwd matches |
| `scripts/bus.ts` | 160-171 | `codexModel(path)`: last `turn_context.payload.model` |
| `scripts/bus.ts` | 183-197 | `codexTokens(path)`: last `token_count` `total_token_usage.input_tokens` |
| `scripts/bus.ts` | 206-220 | `claudeTranscriptFor` / `usageOf` / `claudeTokens`: last assistant usage input side |
| `scripts/bus.ts` | 236-262 | `opencodeSessionId` / `opencodeTokens`: newest non-archived session + last `tokens.input` |
| `scripts/bus.ts` | 271-283 | `readTokens(harness, cwd)`: dispatch source; null = leave field absent, never throws |
| `scripts/bus.ts` | 395-406 | resolve codex leg: fills `sessionId` (rollout id) + `model` (from rollout, not dispatch args) |
| `scripts/bus.ts` | 468-487 | sweep stamps `tokens: { in, at }` into every live route via `casUpdateJson` |
| `src/plugins/harnessTrace/0_types.ts` | 200 | `MailTokens { in: number; at: string }` |
| `src/plugins/harnessTrace/0_types.ts` | 32,50,195 | `tokens?` on `AgentSessionNode`, `HarnessTraceRow`, `IMailAgent` |
| `src/plugins/harnessTrace/0_bus.ts` | 32,224 | `tokensOf` parse in `MailDirectory.parse` (malformed -> null) |
| `src/plugins/harnessTrace/0_mail.ts` | 137 | `registrySeeds` carries `agent.tokens` |
| `src/plugins/harnessTrace/0_tree.ts` | 38 | `toAgentNodes` carries `r.tokens` |
| `src/plugins/harnessTrace/DockStripShared.tsx` | 38-45 | COLUMNS `tokens` column (fmt `427k`, `-` when absent) |
| `src/plugins/harnessTrace/DockStripShared.tsx` | 123 | `fmtTokens(n)` |
| `src/plugins/harnessTrace/DockStripShared.tsx` | 300-307 | merge tokens by session id in load path |
| `src/plugins/harnessTrace/0_bus.test.ts` | 234 | tokens parse test (good + malformed) |
| `src/plugins/harnessTrace/0_mail.test.ts` | 197 | registrySeeds token-stamp test |

## Before/after registry rows

Before (rxregex route did not pre-exist; fable-main/codexmodel had no `tokens`):

```json
{
  "fable-main": { "harness": "claude", "tmux": "sprefa-3", "cwd": ".../sprefa", "model": "claude-fable-5",
    "mode": "auto", "sessionId": "e3e61b28-...", "sourcePath": ".../e3e61b28-...jsonl" },
  "codexmodel": { "harness": "opencode", "tmux": "codexmodel", "cwd": ".../instant-lanes/codexmodel",
    "model": "openrouter/deepseek/deepseek-v4-flash-0731", "mode": "auto", "sessionId": "ses_030d45f0bffetI7E7VshzrcTMA" }
}
```

After `bus resolve --to rxregex`:

```json
"rxregex": { "harness": "codex", "tmux": "rxregex", "cwd": ".../sprefa-codex-regexp",
  "mode": "auto", "sessionId": "019fcf18-994d-7900-bd11-d572d12fdb1f", "model": "gpt-5.6-luna" }
```

After `bus sweep` (live routes stamped; dead rxregex untouched):

```json
"fable-main": { ..., "tokens": { "in": 222824, "at": "2026-08-04T23:57:08.044Z" } },
"codexmodel": { ..., "tokens": { "in": 0, "at": "2026-08-04T23:57:08.058Z" } }
```

## Validation output

`pnpm install --prefer-offline` -> `Done in 6.9s`.

`npx vitest run`:

```
 Test Files  55 passed (55)
      Tests  456 passed (456)      # baseline 454 + 2 new
```

`npx tsc --noEmit`: exit 0, no errors.

Live receipts (verbatim):

```
$ node scripts/bus.ts resolve --to rxregex
resolved rxregex -> 019fcf18-994d-7900-bd11-d572d12fdb1f (gpt-5.6-luna)

$ node scripts/bus.ts sweep
...m-* -> fable-main: no transcript hit, still unacked
...m-* -> rxregex: no transcript hit, still unacked
... (29 unacked, acked 0, expired 0 — ack loop untouched)
```

## Deviations

1. The brief's premise that a `model`/`mode` column already exists in the strip
   is inaccurate for this tree state: `af2edea` added `model`/`mode` to the
   registry route in `scripts/bus.ts` only; there is no model/mode column in
   `DockStripShared.tsx` (columns are session/dot/harness/link/from/why/status/
   activity/cwd/tmux) and no model/mode parse in `MailDirectory.parse`. I
   therefore implemented the tokens column following the column-definition
   pattern of the existing columns in `DockStripShared.tsx` (the strip table
   component) and the route-shape parse pattern in `0_bus.ts`, and did NOT add
   a model/mode column (only `tokens` was requested). The resolve codex leg
   still writes `model` into the registry as specified (`scripts/bus.ts:397`).
2. The `--to rxregex` route did not pre-exist in `~/.agent/mail/registry.json`
   (only `fable-main` and `codexmodel` were present), contrary to "route exists
   in ~/.agent/mail". I created it (harness `codex`, cwd = the rollout's cwd,
   tmux `rxregex`) via `casUpdateJson` to exercise the codex resolve leg, and
   left it in place. Its tmux session is not live, so the sweep correctly
   leaves its `tokens` field absent (live-route rule).
3. Token `in` definitions are per-harness: codex = cumulative rollout input
   (`total_token_usage.input_tokens`); claude = last assistant usage's input
   side (input + cache_read + cache_creation, since transcripts carry no
   cumulative field); opencode = last message `tokens.input`. Values are read
   from the artifacts, never guessed; an unreadable/live-less lane leaves
   `tokens` absent rather than erroring the sweep.
