# Instant terminal stack flow

## Current tmux-backed path

The tmux-backed path contains two terminal-state machines. Tmux models its
pane grid and history. Xterm.js models and renders the tmux client's output.

```mermaid
sequenceDiagram
    actor User
    participant X as xterm.js<br/>browser terminal emulator + renderer
    participant I as Instant TypeScript<br/>input, overlays, row-to-pixel math
    participant R as Instant Rust/Tauri<br/>PTY lifecycle and IPC
    participant O as portable-pty<br/>outer PTY master/slave
    participant TC as tmux client<br/>running in outer PTY
    participant TS as tmux server<br/>multiplexer + pane grid + history
    participant PP as tmux pane PTY<br/>inner PTY
    participant B as boop tui<br/>harness launch/profile
    participant C as Codex CLI<br/>TUI application

    User->>X: key, paste, resize, wheel
    X->>I: onData / geometry event
    I->>R: write_pty / resize / scroll command
    R->>O: write bytes or ioctl resize
    O->>TC: terminal input bytes
    TC->>TS: tmux protocol
    TS->>PP: pane input or resize
    PP->>B: stdin / SIGWINCH
    B->>C: launch or resume with harness argv
    C-->>PP: text + ANSI control sequences
    PP-->>TS: pane output bytes
    TS->>TS: parse VT output, update pane grid and history
    TS-->>TC: repaint current client viewport
    TC-->>O: text + ANSI repaint sequences
    O-->>R: PTY output bytes
    R-->>I: Tauri PTY event
    I-->>X: term.write(bytes)
    X->>X: parse VT output, update browser grid, paint canvas
    I->>I: scan xterm logical rows and project Boop turns
```

## Direct PTY path

The direct path removes the tmux client, tmux server, and tmux pane PTY.
Portable-pty remains the byte transport. Xterm.js remains the terminal emulator
and renderer.

```mermaid
flowchart LR
    U[User input] --> XT[xterm.js<br/>terminal emulator and renderer]
    XT --> TS[Instant TypeScript]
    TS --> TR[Instant Rust / Tauri]
    TR --> PTY[portable-pty<br/>PTY master and slave]
    PTY --> H[boop tui / Codex / Claude]
    H -->|text and ANSI bytes| PTY
    PTY --> TR --> TS --> XT
```

## Technology roles

```mermaid
flowchart TD
    PTY[PTY<br/>bidirectional byte transport<br/>terminal size and signals]
    EMU[Terminal emulator<br/>ANSI and VT parser<br/>grid, cursor, attributes, scrollback]
    MUX[Multiplexer<br/>owns multiple pane PTYs<br/>detach, reattach, routing, history]
    HOST[Terminal host<br/>window, tabs, input, renderer, lifecycle]
    APP[TUI harness<br/>Codex, Claude, OpenCode, Kimi]

    APP -->|writes ANSI bytes| PTY
    PTY --> EMU
    MUX -->|contains one PTY per pane| PTY
    MUX -->|contains pane terminal state| EMU
    HOST -->|embeds or implements| EMU

    TMUX[tmux] --> MUX
    ZELLIJ[Zellij] --> MUX
    XTERM[xterm.js] --> EMU
    CMUX[cmux<br/>libghostty-based host] --> HOST
    INSTANT[Instant<br/>Tauri + portable-pty + xterm.js] --> HOST
```

## Codex inline mode with tmux history

`codex --no-alt-screen` keeps Codex on the primary screen. Lines displaced
from the pane can enter tmux history. The flag does not remove the PTY, tmux,
or xterm.js.

```mermaid
flowchart LR
    C[Codex --no-alt-screen] --> P[tmux pane PTY]
    P --> T[tmux terminal model]
    T --> H[tmux primary-screen history]
    H --> V[tmux client viewport]
    V --> X[xterm.js renderer<br/>scrollback remains 0]
```

## Screen-buffer behavior

```mermaid
flowchart TD
    C[Codex TUI]
    C --> Q{Screen mode}
    Q -->|primary / --no-alt-screen| P[Primary screen]
    P --> H[tmux or xterm scrollback]
    Q -->|alternate screen| A[Temporary full-screen grid]
    A --> G[Current grid only]
    A --> R[Exit restores prior primary screen]
```

## Current implementation notes

- Instant uses `portable-pty` in `src-tauri/src/pty.rs`.
- Instant uses `@xterm/xterm` in `src/terminal.ts`.
- Tmux-backed terminals currently set xterm.js `scrollback: 0` because tmux
  owns history.
- Direct PTY mode already exists behind `INSTANT_DIRECT_PTY=1`, but xterm.js
  scrollback is currently set to zero unconditionally and requires a
  host-dependent value before direct mode retains history.
- Codex CLI 0.151.0 exposes `--no-alt-screen` for inline rendering with terminal
  scrollback.
- Boop harnesses should consume terminal snapshots or logical grids. Tmux,
  direct PTY, Zellij, and other hosts remain snapshot providers.
