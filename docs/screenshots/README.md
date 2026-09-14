# Screenshots

The PNGs in this directory are the README figures. They are produced by
`e2e-real/readme-screenshots.spec.ts` through `playwright.readme.config.ts`:
Chromium loads the built bundle from `dist/`, `instant-serve` serves it against
the real Rust backend over JSON-RPC, and the app's own UI paths are driven to
open sessions, tick recipients, and read the Boop panel.

Everything the frames show is a scratch fixture: tmux sessions on a private
`TMUX_TMPDIR` socket, a scratch `BOOP_DB`/`BOOP_MAIL_DIR` sqlite store, and
synthetic lanes and mail. No owner tmux server, store, desktop, model call, or
real send is touched.

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
| `01-workspace-diagrams.png` | Three durable tmux sessions as dock tabs; the active terminal renders Mermaid and D2 fences inline |
| `02-boop-recipient-selector.png` | Boop recipient dropdown with two open coordinator TUIs checked and the send count reading 2 |
| `03-boop-roster-mail.png` | Boop lane roster, nested, with mail counts and a per-lane waterfall |
