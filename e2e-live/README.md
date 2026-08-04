# Live suite: real tmux, real bus, no mocks

Everything here runs against a private tmux server (`-L instant-proof`), the
real `scripts/bus.ts` CLI, and a per-test temp mail dir. Browser legs render
the real strip components; the only seam is the IPC transport, which
`0_live.ts` serves from this process with real `tmux`/fs implementations.
Test lane ids carry the `proof-` prefix; every test kills its sessions.

```bash
corepack pnpm@10.12.4 run test:live            # free legs (~15s)
RUN_LIVE=1 corepack pnpm@10.12.4 run test:live # + paid harness legs
```

## Coverage map (brief.md deliverable 1)

| Brief bullet | Test | Layer |
|---|---|---|
| dispatch spawns real tmux + registry + envelope | bus-lifecycle: "dispatch mints…" | node |
| strip shows the lane row | strip-live: "a dispatched lane rows the strip…" | browser+node |
| resolve fills opencode sessionId | battery: "resolve fills the sessionId…" (`RUN_LIVE=1`) | node |
| resolve before any session = exit 2 | bus-lifecycle: "resolve exits 2…" | node |
| sweep acks; bus list transitions | bus-lifecycle: "sweep leaves… unacked"; battery: hail-ack (`RUN_LIVE=1`) | node |
| viewer close detaches, lane survives | bus-lifecycle: "a watcher client detaching…" | node |
| row X kills the tmux session | strip-live: "the row X kills…" | browser+node |
| lane death settles done + leaves the bar | strip-live: "…leaves the going-on bar with zero clicks" | browser+node |
| done-lane double-click never mints | strip-live: "…double-click never mints a session" | browser+node |
| waterfall bars + brush | strip-live: "history waterfall bars real lanes…" | browser+node |
| hail reaches a claude transcript, cass ack | battery: "a hail reaches a real claude scratch transcript…" (`RUN_LIVE=1`) | node |

Two legs need the running Tauri app and live only in the recorded proof run
(PROOF.md): the viewer tab showing live pty output after a row click, and the
zero-click lane arrival through the mail fs-watch (e2e pages disable
`claimFsWatch`, so the browser legs cover the poll transitions instead).
