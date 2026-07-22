# instant

A macOS summon-overlay terminal. Double-tap right-⌘ and a frameless window drops
in at your cursor, hosting tmux sessions that run AI CLI agents (claude,
opencode, a plain shell). It lives in the menu bar, not the Dock, so it's one
gesture away and gone again.

Built with Tauri 2 + TypeScript. The chrome is a retro skin (Windows XP Luna,
Persona 5, Armored Core 3 garage), the layout is a VS Code-style dockview, and a
built-in "activity spy" records what you touch (screen captures on gestures,
browser events, file opens, session visits) into a searchable timeline.

> Built almost entirely with AI (Claude Code). MIT licensed.

## Screenshots

<!-- Drop PNGs into docs/screenshots/ with these names and they render here. -->
![Summon overlay](docs/screenshots/overlay.png)
![Worktrees panel](docs/screenshots/worktrees.png)
![Activity spy](docs/screenshots/activity.png)
![Skins](docs/screenshots/skins.png)

## Features

- **Summon gesture** — double right-⌘ shows/hides the window at the cursor;
  menu-bar accessory app (no Dock tile, no Cmd-Tab entry).
- **tmux-backed terminals** — each tab is a `tmux new-session -A` pty, so the
  agent inside survives detach/reload. xterm.js front end with Nerd Font glyphs.
- **dockview layout** — every terminal and tool panel is a draggable, splittable
  dockview tab. Toggling a panel opens it into the focused group, not a new
  column; you build columns by dragging.
- **Worktree hub** — repo → checkout → git worktrees as a tree. Add a worktree
  inline, open a session in it via an agent menu (claude / opencode / shell), or
  resume an existing session that already sits in that path.
- **Activity spy** — a unified, fzf-searchable timeline of screen captures
  (taken on click/drag/copy gestures), browser DOM/tab events (via the bundled
  extension), file opens, and session visits. Virtualized table, config-driven
  exclusion filters, recording toggle with a menu-bar indicator.
- **Send to terminal** — `⛶ Shot` screenshots a region into the active terminal;
  the `▾` picker sends a shot or the active selection to any open terminal;
  right-⌘ + right-⇧ + V grabs the focused app's selection and sends it to the
  active session.
- **Retro skins** — `xp` (Windows XP Luna, with dark mode), `p5` (Persona 5),
  `ac3` (Armored Core 3 garage). One token block per skin.
- **iTerm2-style keybindings** in the terminal (Opt+←/→ word motion, Cmd+←/→
  line motion, etc.).

## Requirements

- macOS (uses CGEventTap, screencapture, the menu bar — macOS only).
- Rust toolchain + [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).
- `tmux` on `PATH` (the homebrew location is added automatically).
- An agent CLI if you want one: `claude` and/or `opencode`.
- Permissions on first run: **Accessibility / Input Monitoring** (summon gesture,
  send-selection tap) and **Screen Recording** (the Shot button + capture).

## Install

Install the current GitHub Release with:

```sh
curl -fsSL https://github.com/hafley66/instant/releases/latest/download/instant-installer.sh | sh
```

It downloads the matching architecture DMG, installs `instant.app` in
`~/Applications`, clears its quarantine attributes before its first launch, and
does not require Rust, Node, pnpm, or a dependency install. The prior installed
bundle, if any, is moved to a timestamped `.backup` sibling. macOS asks for
Accessibility / Input Monitoring and Screen Recording permissions when those
features are first used.

## Develop

```sh
corepack pnpm@10.12.4 install
corepack pnpm@10.12.4 run tauri dev      # builds the Rust backend + serves the front end
```

Type-check and build the front end alone:

```sh
corepack pnpm@10.12.4 exec tsc --noEmit
corepack pnpm@10.12.4 build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Release

```sh
just cut 0.1.1
git push origin main && git push origin v0.1.1
```

The tag workflow builds and publishes both `aarch64` and `x86_64` macOS DMGs.

## Layout

```
src/                 front end (TypeScript; dockview's React shell is the only framework)
  main.ts            app wiring: terminals, panels, activity, send-to, keybindings
  reactdock.tsx      dockview layout (panels, tabs, split, persistence)
  table.ts           sortable + virtualized data tables
  state.ts           the single app store (+ localStorage persistence)
  styles.css         design tokens per skin + component styles
src-tauri/src/       Rust backend
  pty.rs             tmux ptys, session listing
  worktrees.rs       git worktree discovery + add
  workspace.rs       "Spaces" (worktree + agent) registry
  activity.rs        unified activity store (SQLite) + ingest server
  capture.rs         event-driven screen capture
  config.rs          observation config (exclusion filters)
  lib.rs             CGEventTap (summon + capture + send-selection), tray
extension/           Chrome extension feeding the activity spy (browser events)
```

## Privacy

The activity spy is **off by default** and toggled explicitly (Activity panel or
the menu-bar item). It records only Cmd+C/Cmd+V keycodes (not keystrokes), never
captures while an excluded app is frontmost or while the instant window is
focused, and drops events matching the config exclusion filters before they're
stored. Everything stays local
(`~/Library/Application Support/com.instant.summon/`).

## License

MIT — see [LICENSE](LICENSE).
