# Native-adjacent live substrate suite

Everything here runs against uniquely named sessions on the default tmux server,
the real `boop beep` CLI, and a per-test temp mail dir. Browser legs render
the real application components. Tauri IPC is absent: `0_live.ts` exposes the
real `tmux`/fs calls to the renderer through a Playwright binding. This is
native-adjacent/live-substrate coverage rather than compiled-app E2E.
Test lane ids carry the `proof-` prefix; every test kills its sessions.

```bash
corepack pnpm@10.12.4 run test:live            # free legs (~15s)
```

## Coverage map (brief.md deliverable 1)

| Brief bullet | Test | Layer |
|---|---|---|
| patching a real tmux lane writes its route | strip-live: `dispatchLane` | node |
| strip shows the lane row | strip-live: "a dispatched lane rows the strip…" | browser+node |
| row X kills the tmux session | strip-live: "the row X kills…" | browser+node |
| lane death settles done + leaves the bar | strip-live: "…leaves the going-on bar with zero clicks" | browser+node |
| done-lane double-click never mints | strip-live: "…double-click never mints a session" | browser+node |
| waterfall bars + brush | strip-live: "history waterfall bars real lanes…" | browser+node |
| synchronized Codex/Claude/OpenCode asciicast + Boop turns through tmux + `@microsoft/tui-test` PTY into Instant xterm | 1_terminal-cast | native-adjacent/live-substrate |
| real Codex/Claude/OpenCode/Kimi CLIs against pinned `llmock`, recorded by `@microsoft/tui-test`, then rendered through Instant | 2_agent-tui | live-provider/live-TUI |

`1_terminal-cast.live.ts` uses the pinned `@microsoft/tui-test` Node binding for a real PTY and
terminal emulator. Each harness fixture supplies synchronized asciicast input/output events and
Boop role/turn records. The captured tmux byte stream is then written through Instant's existing
terminal hook, where the production turn matcher and Markdown diagram projection run unchanged.

Install the pinned provider emulator into the ignored repository tool directory, then run the
corpus, stored-cast, and live-agent replay tiers:

```bash
pnpm replay:setup
pnpm test:replay
```

The live-agent tier starts one loopback-only `llmock` process. Each CLI receives a temporary home,
a harness-native config file, and an in-memory allowlist of terminal and loopback provider
variables. It does not read or write an environment file and does not pass inherited credential
variables to child processes. `CODEX_BIN`, `CLAUDE_BIN`, `OPENCODE_BIN`, `KIMI_BIN`, and `LLMOCK_BIN`
may select executables for a single invocation.

Two legs need the running Tauri app and live only in the recorded proof run
(PROOF.md): the viewer tab showing live pty output after a row click, and the
zero-click lane arrival through the mail fs-watch (e2e pages disable
`claimFsWatch`, so the browser legs cover the poll transitions instead).
