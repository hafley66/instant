# Tauri request boundary audit

## 0. Scope and inventory

This audit covers `src/**/*.ts` and `src/**/*.tsx` on 2026-08-30. It excludes
the desktop shell's window, webview, drag/drop, and opener ownership. Command
request/response calls are already collected by `src/generated/native.ts` from
`ipc/commands.json`; the generated contract contains 86 names across 15
domains.

| boundary | TypeScript locations | transport shape | classification |
| --- | --- | --- | --- |
| command request/response | `generated/native.ts`, 32 importing application modules | `invoke(command, args) -> Promise<T>` | migrate through signal endpoint |
| PTY output | `main.ts` `pty-data-batch` | many chunks per native event | bidirectional stream candidate, WebSocket |
| PTY graphics | `main.ts` `pty-graphics` | binary-like graphics frame events | one-way stream candidate, WebSocket |
| CDP screencast, cursor, URL, copy, error | `main.ts`, `cdp.ts` | high-rate frame stream plus control state | bidirectional stream candidate, WebSocket |
| activity, capture, favorites, frontmost app | `main.ts`, `rules.tsx` | one-way state/event stream | SSE candidate |
| filesystem watch | `fsWatch.ts` | claim/release request plus filtered change stream | SSE candidate |
| summon, toggle-record, toggle-ai, send-highlight-text | `main.ts` | desktop-shell input notifications | shell-owned event |
| dropcatcher | `dnd.ts`, `dropcatcher.ts` | native drag/drop coordination | shell-owned event |
| window, webview, DPI, opener | `overlay.ts`, `chrome.ts`, `capture.ts`, `dnd.ts`, `dropcatcher.ts`, `0_openExternal.ts`, `1_FileImageViewer.tsx`, `1_SvgDocumentViewer.tsx`, `reactive/ports.ts` | desktop APIs | shell-owned operation |

The generated request contract is imported by:

`00a_terminalIntersection.ts`, `0_MonacoCodeViewer.tsx`, `0_stfuButton.ts`,
`activity.tsx`, `browser.ts`, `capture.ts`, `cdp.ts`, `chrome.ts`, `core.ts`,
`favorites.ts`, `fsWatch.ts`, `harness.ts`, `main.ts`, `memeExport.ts`,
`paintSessions.ts`, `plugins/files/1_FileTree.tsx`,
`plugins/files/2_FileExplorer.tsx`, `plugins/files/4_FileSearchTree.tsx`,
`plugins/metrics/1_dashboard.tsx`, `preview.ts`, `reactive/ports.ts`,
`refChoicesPanel.tsx`, `rules.tsx`, `sprefa.ts`, `tabs.ts`, `terminal.ts`, and
`worktrees.ts`, and `ipc/contract.ts`. These are 28 application modules;
`0_tabTitleFromTmux.test.ts` is the remaining generated-client unit-test
consumer. Every filesystem, PTY, tmux, Boop, process, database,
worktree, watcher claim, and generated native command operation in these files
therefore crosses the same generated request edge.

## 1. Transport signatures

The request types are provided by `@hafley66/signals`:

```ts
type RequestTransport = EndpointTransport
// (request: EndpointRequest) => ObservableInput<EndpointResponse>

type NativeCommandInput = Record<string, unknown> | undefined

function nativeCommandUrl(command: string): string
// (command: string) => `tauri://instant/commands/${command}`

function createRequestEndpoint<Input, Output>(
  config: EndpointConfig<Input, Output>,
  transport: RequestTransport,
): Endpoint<Input, Output>

function nativeCommandEndpoint<Output>(
  command: CommandName,
): Endpoint<NativeCommandInput, Output>

function invoke<Output>(
  command: CommandName,
  args?: NativeCommandInput,
): Promise<Output>
// firstValueFrom(nativeCommandEndpoint<Output>(command).execute(args))

function listenNativeEvent<Payload>(
  event: string,
  handler: (event: { payload: Payload }) => void,
): Promise<() => void>

function nativeEvent$<Payload>(event: string): Observable<Payload>
```

`Endpoint.execute` is the observable request primitive. `Endpoint.createQuery`
and `Endpoint.createMutation` are the signal resource primitives available to
new call sites. The generated `invoke` compatibility function consumes exactly
one endpoint emission with `firstValueFrom`, so existing `await` and error paths
keep their lifetime while every call has the serializable
`EndpointRequest -> EndpointResponse` shape.

The current Tauri adapter accepts `POST tauri://instant/commands/<name>` with
JSON-shaped body arguments and returns an HTTP-shaped `{ status, body }` result.
The HTTP adapter accepts ordinary URL, method, headers, body, and `AbortSignal`.
Replacing the native adapter does not change generated or domain call sites.

## 2. Instance lifetime, storage, and uniqueness

| instance | owner | storage | creation and teardown | uniqueness |
| --- | --- | --- | --- | --- |
| generated command endpoint | one `invoke` call or explicit consumer | no cache | endpoint executes on subscription; `firstValueFrom` unsubscribes after first result or error | no retained instance |
| signal query | endpoint plus serialized input key | `WeakMap<Endpoint, Map<key, QueryEntry>>` in signals | first observer begins request; no observers cancels request; cache timer removes inactive entry | one active request per endpoint/input key due to `switchMap` |
| signal mutation | caller instance | mutation signal state | input write begins request; next input cancels previous request | one active request per mutation instance |
| native event subscription | module, component effect, or app boot | RxJS `Subscription` and late Tauri unlisten function retained by the adapter | `nativeEvent$` subscribes lazily; `unsubscribe()` releases a completed or late registration | one native listener per explicit subscription |
| filesystem watch claim | `claimFsWatch` caller | generated claim id and returned cleanup | listen first, claim second; cleanup unlistens then releases claim | one claim id per function call |

The native adapter has no response cache. HTTP query caching is owned by
`@hafley66/signals`, keyed by `Endpoint.key(input)`, with `switchMap` cancelling
the preceding request for the same resource. Caller-side in-flight guards remain
the owner of operation-level uniqueness where present, such as `wtScanning`.

## 3. Temporal topology

Time flows top to bottom. `~>` crosses an asynchronous boundary. `=>` is a
buffered or batched path.

```text
UI action / boot / timer
  -> generated command endpoint
  ~> current Tauri adapter: POST tauri://instant/commands/<command>
  ~> Rust command
  -> EndpointResponse decode
  -> Promise continuation or Signal QueryState [UI]

Query input write / refetch command
  -> merge(initial, refetch)
  -> switchMap(requestEvents) [previous request cancelled]
  -> scan(QueryState)
  -> replay(1) to active observers [UI]

PTY process output
  ~> pty-data-batch
  => chunk array retained by native emission
  -> terminal output application [UI]

CDP process output
  ~> cdp-frame / cursor / url / copy / error
  -> id gate
  -> newest-frame gate (`drawSeq`)
  -> requestAnimationFrame draw [UI]

Filesystem source
  -> fs_watch_claim request
  ~> fs-watch event
  -> claimId gate
  -> caller onChange [UI]
  -> cleanup: unlisten + fs_watch_release request

Activity extension / capture process
  ~> activity-added / rule-match / capture-status / favorites-changed
  -> panel or store derivation [UI]
```

Merge points: query initial/refetch commands; main's event registrations feeding
the application store; rules' `rule-match` plus `activity-added` panel state.
Gates: endpoint status decoding; query input `undefined`; query `switchMap`;
filesystem claim id; CDP tab id and newest-frame draw sequence; worktree's
`wtScanning` flag. Existing buffers are native PTY batches, CDP's one pending
frame plus animation frame, rules' `FEED_CAP`, and the signals query replay-one
state. Teardown paths exist for native event consumers that retain the returned
unlisten function; boot listeners currently live for application lifetime.

## 4. Migration boundary

`reactive/0_requestTransport.ts` contains the reusable `Endpoint` constructor
surface. `reactive/nativeTransport.ts` owns the only Tauri command and event
imports for application data/control. `reactive/httpTransport.ts` provides the
loopback HTTP implementation with the same `EndpointTransport` signature.
`generated/native.ts` is the compatibility and typed command-name boundary.

Direct Tauri imports remaining outside this adapter are listed in section 0 as
shell-owned window/webview/DPI/opener/drag-drop operations. All data/control
event subscriptions in `main.ts`, `cdp.ts`, `fsWatch.ts`, and `rules.tsx` use
the native adapter; CDP and rules consume `nativeEvent$` directly. Filesystem
watches and boot listeners retain `listenNativeEvent` registration ordering,
because their command claim must begin only after its listener is active.
