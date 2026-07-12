# TODO

Generated from structured source comments by `.dl/todos.dl`. Do not edit inside
the generated regions; update the `todo(category): …` comment at its source.

## Ready

<!-- BEGIN: todo-ready -->
- [todo(boundary): isolate CDP commands and events behind a browser-engine port](src/cdp.ts#L834)
- [todo(boundary): isolate Chrome discovery HTTP and WebSocket traffic behind a CDP transport](src-tauri/src/cdp.rs#L617)
- [todo(boundary): move remaining recurring application work into runtime-owned subscriptions](src/reactive/runtime.ts#L26)
- [todo(boundary): replace curl-based ntfy publishing with a typed outbound notification port](src-tauri/src/activity.rs#L773)
- [todo(codegen): verify ipc/commands.json against generate_handler registrations during build](src-tauri/src/lib.rs#L881)
- [todo(http): support media-type-aware decoding instead of assuming JSON for every response](src/reactive/httpTransport.ts#L31)
- [todo(lifecycle): add isolated plugin activation and epic teardown after Status proves the runtime](src/plugin.tsx#L275)
- [todo(lifecycle): add per-stream error isolation and runtime diagnostics](src/reactive/runtime.ts#L25)
- [todo(lifecycle): give every global event listener and interval runtime-owned teardown](src/main.ts#L5)
- [todo(lifecycle): make child-process termination and reader-thread shutdown explicit](src-tauri/src/pty.rs#L697)
- [todo(lifecycle): move PTY listener ownership and teardown into the reactive runtime](src/terminal.ts#L775)
- [todo(migration): delete the legacy vanilla table after remaining consumers move to TreeTable](src/table.ts#L271)
- [todo(migration): version persisted state migrations explicitly before adding more fields](src/state.ts#L451)
- [todo(security): cap ingest request bodies and define localhost authentication policy](src-tauri/src/activity.rs#L772)
- [todo(split): extract filesystem tree loading and actions into a sibling module](src/worktrees.ts#L6)
- [todo(split): extract tmux session discovery and worktree association into a sibling module](src/worktrees.ts#L5)
- [todo(split): move each panel into its own file and leave shared row models here](src/tablepanels.tsx#L1127)
- [todo(split): reduce the Tauri composition root to adapter registration and boot wiring](src-tauri/src/lib.rs#L880)
- [todo(split): separate Claude and OpenCode parsing from ledger query orchestration](src-tauri/src/ledger.rs#L517)
- [todo(split): separate meme DOM orchestration, persistence, and asset loading](src/meme.tsx#L1104)
- [todo(split): separate screencast rendering, input translation, and navigation state](src/cdp.ts#L835)
- [todo(split): separate tmux commands, PTY ownership, and rogue-process discovery](src-tauri/src/pty.rs#L696)
- [todo(state): make dock layout recovery a typed state transition instead of boot-order mutation](src/reactdock.tsx#L549)
- [todo(state): split durable settings from runtime mirrors and ephemeral UI state](src/state.ts#L450)
- [todo(test): add a boot smoke test that asserts registration and teardown order](src/main.ts#L6)
- [todo(test): add fixture coverage for malformed and partially-written session logs](src-tauri/src/ledger.rs#L518)
- [todo(test): add keyboard-navigation integration coverage for every TreeTable panel](src/tablepanels.tsx#L1128)
- [todo(test): cover Worktrees panel refresh plus SSE reconnect as an integration flow](src/worktrees.ts#L8)
- [todo(test): cover corrupt layout recovery and panel remount behavior](src/reactdock.tsx#L550)
- [todo(test): cover engine crash, reconnect, and orphan cleanup](src-tauri/src/cdp.rs#L618)
- [todo(test): exercise open, resize, close, reload, and tmux reattach as one lifecycle test](src/terminal.ts#L776)
- [todo(test): verify abort, invalid JSON, empty body, and non-2xx transport behavior](src/reactive/httpTransport.ts#L32)
- [todo(test): verify one crashing plugin cannot interrupt sibling registration or rendering](src/plugin.tsx#L276)
<!-- END: todo-ready -->

## Dependency-blocked

<!-- BEGIN: todo-blocked -->
- [todo(lifecycle): make StorageSignal external-listener teardown runtime-owned (depends: Signals storage disposal API)](src/reactive/statusModel.ts#L23)
- [todo(migration): remove legacy v1 worktree renderers (depends: TreeTable parity for every worktree action)](src/worktrees.ts#L7)
- [todo(migration): replace remaining imperative meme row rendering with TreeTable (depends: meme row model extraction)](src/meme.tsx#L1105)
<!-- END: todo-blocked -->
