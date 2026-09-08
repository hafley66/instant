# Lane: real-cmdclick-previews (instant, Playwright real tier)

You work in `$PWD`, your own worktree of the instant repo, branched from `integration/tauri-condom` at the tip shown by `git log -1`. Never `cd` elsewhere. Commit on your branch only.

## Goal
Port these fixture-page specs to the real tier under `e2e-real/`, same file names, and delete the originals:
- e2e/cmdclick-ladder.spec.ts (11)
- e2e/cmdclick-surfaces.spec.ts (cases inside a describe)
- e2e/mdzoom.spec.ts (6)
- e2e/svg-link.spec.ts (2)
- e2e/monaco-preview.spec.ts (2)
- e2e/pdf-preview.spec.ts (1)

Your port: `47804`. Your tmux socket: `instant-real-d`. Nobody else uses them.

## Hints for these files
- ⌘-click on a path in the pane opens the preview beside the terminal in dockview. Create real files (md, svg, ts, pdf) under a `mkdtempSync` dir, `cd` the pane there, `settleCwd`, then `typeLine(session, 'clear; ls')` or echo the paths. A small valid PDF can be written from a base64 constant in the spec.
- `__runClickArgs` and `__cmdClickEvents` were the fixture's resolver log; the receipt is the panel that opens (`.mdview-content`, the monaco editor root, the pdf iframe) or the shell command that ran (`paneScreen`).
- mdzoom: the fixture's `__mdzoom` hooks read zoom factors; the real receipt is `getComputedStyle(.mdview-content).zoom` and dockview's active panel class, both DOM.
- svg-link: `__openedSvgHref` recorded the href the app would open externally. In the real app an external open goes to the backend `open_external` command; the receipt is the toast or, when nothing is visible, `test.fixme` with the reason.

## Commit subject (exact)
`real tier: cmd-click ladder and surfaces, mdzoom, svg link, monaco and pdf previews ported`

## The real tier (read `e2e-real/0_real.ts` and `e2e-real/fork.spec.ts` first)
`playwright.real.config.ts` starts `instant-serve` (the app's Rust backend, no Tauri) on `127.0.0.1:$INSTANT_REAL_PORT`, serving the built bundle from `dist/` and the command table over a JSON-RPC WebSocket. Chromium loads `/?ws=ws://127.0.0.1:<port>/ws`. Terminals are real tmux panes on the private socket `$INSTANT_REAL_SOCKET`. Every helper you need is exported from `e2e-real/0_real.ts`: `boot`, `openTab`, `typeLine`, `typeRaw`, `paneScreen`, `screenRows`, `cell`, `settleCwd`, `menuRow`, `toast`, `shot`, `sessions`, `killAllSessions`, `tmux`, `tmuxDefault`, `sql`. Add helpers to `0_real.ts` only if two of your specs need them; another lane may add to the same file, so keep additions appended at the end under a comment naming your lane.

## Laws of a real-tier spec
1. Drive the app like a user: `page.keyboard`, `page.mouse`, rail buttons, context menus, and text typed into the pane through `typeLine` / `typeRaw` (tmux `send-keys`). Never call `window.__term`, `window.__cmdClickEvents`, `window.__visibleTurnEvents`, `window.__instantE2eNativeResults`, or any other `window.__*` hook; the bundle does not expose them.
2. Read receipts from the DOM (`screenRows`, locators), from tmux (`paneScreen`, `capture-pane`), from the file system, or from boop's sqlite (`sql`). Assert on what a user could see.
3. The fixture wrote raw bytes with `__term.write(...)`. In a pane the same bytes come from the shell: `typeLine(session, "clear; printf '%b' '<escaped bytes>'")`, or write the bytes to a file under a `mkdtempSync` dir and `typeLine(session, \`clear; cat ${file}\`)`. Row 0 of the fixture is the first row after `clear`. Find a row by scanning `paneScreen(session)` for a marker string, then `cell(page, row, col)` for the pixel.
4. A pane that should look like an agent harness: the app decides a tab's harness from the pane's foreground process name and its screen text (`src/harness.ts` `detectHarness(command, proc, screen)`; `src/0_harnessDefinitions.ts` lists the ids and glyphs). A stub executable named `codex` (or `claude`, `opencode`) in a temp dir put first on PATH, which `cat`s the fixture bytes and then `sleep 300`, gives a pane whose foreground process is the harness. Launch it with `typeLine(session, \`PATH=${stubDir}:$PATH codex\`)`.
5. Screenshots go to `artifacts/real/<spec>-<nn>-<what>.png` through `shot`. One PNG per test at its final state is the minimum; commit the PNGs.
6. One real-tier spec per fixture spec, same file name under `e2e-real/`. Each `test(` of the original keeps its title (reworded only where the fixture's wording names fixture machinery). When a behavior has no observable receipt in the real app, keep the test as `test.fixme("<title>", ...)` with a one-line comment stating what is unobservable, and list it in the commit body under `fixme:`. Never delete a case silently.
7. After a port passes, `git rm` the original under `e2e/` or `e2e-live/`. Leave `e2e/*.tsx`, `e2e-*.html`, and other lanes' specs alone.
8. `test.afterAll(killAllSessions)` in every spec; `test.afterEach` kills any default-socket session or boop lane the test created.
9. Never edit `src/`, `src-tauri/`, `package.json`, `vite.config.ts`, or `playwright.real.config.ts`. A product defect you find goes in the commit body under `defect:` with file:line, and the case becomes `test.fixme`.

## Setup (once, in `$PWD`)
```
corepack pnpm@10.12.4 install --frozen-lockfile
node node_modules/vite/bin/vite.js build
```
`dist/` is gitignored. The backend binary is shared and read only: `INSTANT_SERVE_BIN=/Users/chrishafley/.cache/cargo-target/feature-serve-bin/debug/instant-serve`. Do not run cargo.

## Run
```
INSTANT_SERVE_BIN=/Users/chrishafley/.cache/cargo-target/feature-serve-bin/debug/instant-serve \
INSTANT_REAL_PORT=<your port> INSTANT_REAL_SOCKET=<your socket> \
npx playwright test -c playwright.real.config.ts e2e-real/<spec>.spec.ts
```
Debug a single case with `--grep "<title>"`; `--trace on` plus `npx playwright show-trace` for a failing step. `tmux -L <your socket> list-sessions` and `capture-pane -p -t <session>:` show what the pane holds. Kill a stuck server with `pkill -f "instant-serve --port <your port>"` and `tmux -L <your socket> kill-server`.

## Style laws (comments, commit message)
No em dashes. No sycophancy. No negative parallelism (`not X, Y`). No one-word sentences. Banned words: provenance, substrate, load-bearing, regime, grounded, ruling, honest, distill. No deictic filler (`here is`, `below`, `the following`). Comments state what a user does and what receipt proves it.

## Receipt (paste the real output into the commit body)
```
INSTANT_SERVE_BIN=... INSTANT_REAL_PORT=<port> INSTANT_REAL_SOCKET=<socket> npx playwright test -c playwright.real.config.ts <your spec files> 2>&1 | grep -E "✓|✘|passed|failed|fixme|skipped"
ls artifacts/real/ | grep -E "<your spec prefixes>"
git status --short e2e e2e-live e2e-real
```
Commit everything in one commit with the exact subject given below. The commit body carries the receipt, the `fixme:` list, and the `defect:` list.
