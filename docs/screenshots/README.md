# Screenshots

The PNGs in this directory are the README figures. They are produced by
`e2e-real/readme-screenshots.spec.ts` through `playwright.readme.config.ts`:
Chromium loads the built bundle from `dist/`, `instant-serve` serves it against
the real Rust backend over JSON-RPC, and the app's own UI paths are driven to
open sessions, render a boop-backed turn, open its context menu, favorite it,
tick recipients, read the Boop panel, and draw the turn strip.

Everything the frames show is a scratch fixture: tmux sessions on a private
`TMUX_TMPDIR` socket, a scratch `BOOP_DB`/`BOOP_MAIL_DIR` sqlite store, and
synthetic turns, lanes, and mail. No owner tmux server, store, desktop, model
call, or real send is touched.

The favorite is checked twice: once against the scratch store
(`agent_favorite` row for `turn:<session>:<turn>`), and once after a reload
through the Favorites panel, which reads `boop_favorites`. The inline diagrams
assert the `boop:<session>:<turn>` locator, so they are turn-sourced, not
terminal-buffer guesses.

## Generate

Build the front end, then point the tier at a warm `instant-serve` binary:

```sh
corepack pnpm@10.12.4 build
INSTANT_README_SERVE=/path/to/instant-serve \
  corepack pnpm@10.12.4 exec playwright test --config playwright.readme.config.ts
```

`INSTANT_README_SERVE` defaults to `src-tauri/target/debug/instant-serve`. Other
overrides: `INSTANT_README_PORT` (default 47813), `INSTANT_README_TMP` (default
`/private/tmp/instant-readme-<port>`), and `BOOP_BIN` (default
`$HOME/.cargo/bin/boop`).

## Files

| File | Scene |
| --- | --- |
| `01-turn-diagrams.png` | Three durable tmux sessions as dock tabs; the active terminal turn renders inline D2 and Mermaid |
| `02-turn-favorite.png` | Right-click context menu over a turn: the Boop turn label, the star favorite action, and the expand-diagram entry |
| `03-favorites-panel.png` | Favorites panel after a reload, listing the Boop-backed turn from `boop_favorites` |
| `04-boop-recipient-selector.png` | Boop recipient dropdown with two open coordinator TUIs checked and the send count reading 2 |
| `05-boop-roster-mail.png` | Boop lane roster, nested, with mail counts and a per-lane waterfall |
| `07-turn-strip.png` | The turn strip in the terminal's right margin: one square per attributed turn, sized by the server's placement, with the reader's window as a block |
| `08-turn-strip-popover.png` | The same strip with a square hovered, showing the CSS popover: the turn's role, number, time and its own words |
| `06-rustdoc-browser.png` | Rustdoc served from the loopback doc origin in the embedded browser, with crate search results |

The strip figures are the server's own numbers. The pane capture, tmux's
`#{pane_height}`/`#{scroll_position}`, and `boop-turnstrip`'s layout cross the
push as one frame; the scene reads that frame out of the WebSocket and asserts
the squares against it, so a wrong placement fails here rather than in a
screenshot nobody looks at.

`06-rustdoc-browser.png` comes from the rustdoc tier instead:
`e2e-real/rustdoc.spec.ts` through `playwright.rustdoc.config.ts`, which mounts a
real `cargo doc --no-deps` tree (built under a path with a space), serves it over
the backend's loopback doc service, drives the app's own entry points, and writes
the same `docs/screenshots/` directory.
