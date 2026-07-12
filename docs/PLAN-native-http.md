# Plan: migrate application IPC to generated localhost APIs

## Outcome

Move application data and streaming operations from Tauri `invoke` calls to a
generated, loopback-only HTTP API while retaining Tauri as the desktop shell.
The migration is incremental: every converted operation keeps its current
behavior and is verified before the next domain moves.

This is not a generic RPC endpoint. Each operation has an explicit OpenAPI path,
method, request schema, response schema, and transport class.

## Source of truth and generation

Rust commands carry structured declarations beside their implementation:

```rust
// api(http GET /api/v1/config): config_get
// api(sse GET /api/v1/activity/events): activity_events
// api(websocket GET /api/v1/pty/sessions/{id}): open_session
// api(shell): config_open
```

`dl` reads these declarations through `comment_node`, validates them, and uses
`gen()` to maintain the linked inventory in `NATIVE_HTTP.md`. The executable
contract remains OpenAPI 3. Generated artifacts must never be edited by hand.

The completed generation chain will be:

```text
Rust api(...) declaration
  -> dl validation and migration inventory
  -> OpenAPI operation and named schemas
  -> generated Rust route bindings
  -> generated TypeScript client
  -> application call site
```

Do not infer public request or response schemas from arbitrary Rust signatures.
Before an operation becomes executable HTTP, its declaration must reference
explicit request and response schema names represented in OpenAPI.

## Security and lifecycle boundary

The server must:

- bind only to a loopback address on an operating-system-selected port;
- generate a fresh bearer token for each application process;
- pass the port and token to the webview without persisting either one;
- reject missing or incorrect tokens;
- use explicit request body and message-size limits;
- stop with the owning application runtime;
- expose no generic command, shell, or `/rpc/{command}` route;
- apply the same input validation and error behavior as the command it replaces.

Cross-origin access is denied unless a narrowly defined development origin is
required. Mutating routes require the same authentication as read routes; HTTP
method choice is not treated as a security boundary.

Tauri remains responsible for actual desktop-shell capabilities such as tray and
window control, global shortcuts, native dialogs, clipboard integration,
screenshots, and opening a path in another application. These stay behind the
small generated native adapter and are marked `api(shell)`.

## Phase 1: prove the pipeline with `config_get`

Implement `GET /api/v1/config` end to end:

1. Add named OpenAPI schemas for `ConfigView` and its nested values.
2. Extend generation to emit the Rust route binding and TypeScript client.
3. Start the authenticated loopback server under the application runtime.
4. Route the handler through the existing config service logic; do not duplicate
   configuration loading or state.
5. Switch only the `config_get` frontend caller to the generated HTTP client.
6. Keep the existing Tauri command temporarily as a rollback path and parity
   oracle, not as an automatic fallback that could hide HTTP failures.
7. Compare HTTP and IPC success/error results in tests, then remove the frontend
   IPC use after parity is established.

Acceptance criteria:

- startup and shutdown leave no orphan listener;
- an unauthenticated request is rejected;
- the generated client returns the same value as `config_get`;
- malformed requests and server errors are typed and observable;
- OpenAPI or generated-file drift fails `just check`;
- the daily-driver and isolated instances receive distinct ports and tokens.

## Phase 2: read-only request/response operations

Move low-frequency, read-only operations next, beginning with worktree snapshots
and diffs. Preserve the shared ghcache snapshot behavior and local Rust fallback;
transport migration must not reintroduce polling scans or duplicate sources.

For each operation:

1. Add explicit schemas and an OpenAPI operation.
2. Generate and test Rust and TypeScript bindings.
3. Prove result and error parity with IPC.
4. Move one caller.
5. Remove the obsolete frontend IPC command only after usage search is empty.

## Phase 3: mutations

Move config writes, worktree creation/removal, favorites, and other mutations.
Define conflict, validation, and idempotency behavior in OpenAPI instead of
mapping every failure to an unstructured `500` response. Destructive operations
must retain their existing confirmation and force semantics.

## Phase 4: streams

Use transport according to behavior:

- SSE for one-way activity, status, and worktree event streams;
- WebSockets for bidirectional PTY and CDP sessions;
- ordinary HTTP for bounded request/response work.

Streaming runtimes own reconnect, cancellation, backpressure, and teardown.
Closing a panel or stopping the application must release every subscription,
socket, task, and child resource exactly once.

## Phase 5: reduce Tauri to the shell

After all eligible callers migrate:

- remove unused commands from the Tauri registration list and native schema;
- keep only `api(shell)` commands in the generated native client;
- make direct Tauri imports outside the shell adapter a repository error;
- make undeclared network clients and direct `fetch` usage repository errors;
- document the remaining shell boundary and its ownership.

## Automation rails

Extend the current `dl` program incrementally to diagnose:

- malformed `api(...)` declarations;
- duplicate method/path pairs or command names;
- registered Tauri commands with no network or shell classification;
- network declarations missing named request/response schemas;
- OpenAPI operations without a corresponding Rust declaration;
- migrated frontend commands that still call `invoke`;
- generated inventory drift.

`just native-http` regenerates the linked inventory. `just check` must remain the
non-writing drift gate for the inventory, OpenAPI, Rust bindings, and TypeScript
client.

## Required verification for every slice

- focused Rust handler and authentication tests;
- generated TypeScript client tests;
- parity tests against the command being replaced;
- lifecycle tests for server startup and teardown;
- `just check`;
- `just build`;
- `just cargo-check`;
- `just ext-build` when extension code changes;
- manual verification only through `just dev-safe` or `just dev-isolated`.

## Explicit non-goals

- exposing Instant beyond loopback;
- replacing Tauri windowing or desktop integration;
- a generic RPC compatibility layer;
- automatically translating arbitrary Rust types without reviewed schemas;
- migrating PTY or CDP before ordinary HTTP lifecycle and authentication are
  proven;
- changing terminal, worktree, Dockview, plugin, or durable-state behavior as a
  side effect of transport migration.
