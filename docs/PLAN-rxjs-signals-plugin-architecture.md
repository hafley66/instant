# Plan: RxJS + `@hafley/signals` plugin architecture

Date: 2026-07-10

## Goal

Make Instant a strongly typed, pluggable FRP application without rewriting the
working Tauri/Dockview/xterm product or putting durable Favorites and process
lifecycle behavior at risk.

The intended model is:

```text
imperative producers (Tauri, DOM, timers, xterm, Dockview)
                              ↓
                  global Observables / Signals
                              ↓
                  plugin-contributed epics
                              ↓
               writable and computed Signals
                              ↓
              React/Dockview as pinned output
```

Signals provide automatic current-value composition. RxJS operators are used
when time policy—cancellation, ordering, concurrency, throttling, retries,
sharing, or teardown—is material.

## Executable specification in `hafley-rxjs`

The Signals tests are the contract, not this prose.

Current test references:

- `~/projects/hafley-rxjs/packages/signals/src/0_types.test.ts`
  demonstrates initialized state, nested reads/writes, root and nested
  subscriptions, synchronous current-value replay, and nullish access.
- `~/projects/hafley-rxjs/packages/signals/src/4_assumptions.test.ts`
  characterizes important current behavior: no equality dedupe, sibling writes
  re-emitting scoped selectors, stable cached child proxies, per-method scoped
  Observable duplication, and array-method interception semantics.

The overload contract now exists and is covered by the `2_Signal.overloads` and
`2_Signal.memo` suites: bare event Signals, initialized state, Observable
sources, dynamically tracked `Signal(fn)` memos, nested memos, and branch
rewiring. Endpoint query/mutation behavior is specified by `4_Query.test.ts`.
Flat routes and recursive persisted state are specified by `5_Route.test.ts`
and `6_Storage.test.ts`. React usage is documented in
`packages/signals/GUIDE.md`; `SignalReact(Component)` is the default rendering
boundary and direct `.$()` reads replace per-value hooks.

## First Instant vertical slice: Status

Status is the best proving ground because `src/status.tsx` currently owns a
timer, Promise orchestration, error normalization, localStorage access, direct
DOM mutation, and component-local React state. Refactor it without changing its
registered `StatusProbe` plugin contract:

1. Define `sprefaRoot = StorageSignal("sprefa.root", "~/projects/sprefa/v5")`.
2. Wrap each probe check as an uncached Endpoint query driven by a shared poll
   tick Signal. Request switching prevents a slow prior tick from overwriting a
   newer one.
3. Define `statusRows = Signal(() => ...)` and `statusHealth = Signal(() =>
   worst(statusRows.$().map(...)))`.
4. Render `StatusPanelV2` through `SignalReact`, reading those Signals inline.
5. Drive rail health from the same `statusHealth` Signal at the rail composition
   boundary; remove `paintRail` and its `document.getElementById` mutation.
6. Render rows through `TreeTable`, as required by this repository's grid rule.

The ghcache worktree snapshot Endpoint then becomes shared infrastructure:
`status.tsx` reads its status while `worktrees.ts` reads its data. This removes
the duplicate fetches at `status.tsx:122` and `worktrees.ts:1437`. The SSE delta
stream remains a temporal RxJS producer and folds into the cached snapshot.

After Status, migrate persisted `pluginState` as one recursive Storage Signal.
Keep the existing one-time migrations and safe-boot behavior as parsing/migration
at the storage boundary; do not replace each persisted key independently.

## Immediate execution plan

This is the next implementation sequence:

1. Add local workspace consumption of `@hafley/signals` and
   `@hafley/rxjs-ext` without changing the Tauri/Rust boundary.
2. Refactor `StatusPanelV2` from `useEffect`/`useState` polling to a timer
   Observable, Endpoint queries, and Signals.
3. Move `sprefa.root` behind `StorageSignal`; preserve its existing fallback,
   migration, and locked-down-storage behavior.
4. Derive status rows and aggregate health with `Signal(() => ...)` and render
   the panel through `SignalReact`.
5. Replace imperative `paintRail()` DOM mutation with one consumer of the
   aggregate health Signal at the rail composition boundary.
6. Reuse the ghcache worktree query from `worktrees.ts` so Status and Worktrees
   do not issue duplicate snapshot requests. Keep SSE as the temporal delta
   producer and preserve its reconnect behavior.
7. Run `just check`, `just build`, and `just cargo-check` before committing.
8. Only after this slice is stable, migrate `pluginState` and Favorites
   persistence. Preserve safe boot, one-time migrations, and current durable
   values before simplifying their storage shape.
9. Migrate session/worktree lifecycle flows last; their RxJS concurrency policy
   must be explicit (`switchMap` scans, `exhaustMap` duplicate opens,
   `concatMap` ordered teardown) and must not alter tmux ownership semantics.

The first slice is intentionally Status because it exercises HTTP, timers,
localStorage, derived state, DOM integration, and React rendering while leaving
Favorites and terminal lifecycle data untouched. It is the smallest useful
proof that the Signal graph can replace component-owned orchestration safely.

## Core plugin contract

Plugins contribute declarations and temporal behavior. They do not receive the
entire application store or import unrelated feature internals.

```ts
type PluginId = string & { readonly __brand: "PluginId" };

interface InstantPlugin<E extends AppEvent = AppEvent> {
  id: PluginId;
  panels?: readonly PanelDef[];
  commands?: readonly Command[];
  config?: readonly ConfigOption[];
  status?: readonly StatusProbe[];
  epics?: readonly InstantEpic<E>[];
  activate?: (ctx: PluginContext) => Teardown | void;
}

type InstantEpic<E extends AppEvent = AppEvent> = (
  events$: Observable<E>,
  ctx: PluginContext,
) => Observable<AppEvent>;

type Teardown = () => void;
```

`PluginContext` contains stable edge adapters, not mutable feature state:

```ts
interface PluginContext {
  tauri: TauriPort;
  dock: DockPort;
  terminals: TerminalPort;
  log: LogPort;
  now: () => number;
}
```

Current truth is exposed through feature-owned Signals:

```ts
interface TmuxFeatureState {
  sessions: Signal<readonly Session[]>;
  error: Signal<unknown | null>;
  refreshing: Signal<boolean>;
}
```

No plugin may subscribe directly during module evaluation. The composition root
combines epics and owns the small number of terminal subscriptions.

## Events: intent versus fact

Use a discriminated union and distinguish requests from completed facts:

```ts
type AppEvent =
  | { type: "tmux.refreshRequested"; source: "boot" | "timer" | "manual" }
  | { type: "tmux.refreshed"; sessions: readonly Session[] }
  | { type: "tmux.refreshFailed"; error: unknown }
  | { type: "terminal.openRequested"; request: OpenTerminalRequest }
  | { type: "terminal.opened"; terminal: TerminalSnapshot }
  | { type: "terminal.openFailed"; request: OpenTerminalRequest; error: unknown }
  | { type: "dock.restoreFailed"; error: unknown }
  | { type: "dock.recovered" }
  | { type: "favorite.addRequested"; candidate: MessageCandidate }
  | { type: "favorite.added"; favorite: Favorite }
  | { type: "favorite.addFailed"; candidate: MessageCandidate; error: unknown };
```

An epic turns intents into effects and emits facts. Reducers/signals consume
facts. This avoids feedback loops in which the same event repeatedly retriggers
its producer.

Operator choice records concurrency policy:

- `switchMap`: worktree scan or ledger lookup superseded by newer input;
- `exhaustMap`: prevent duplicate refresh/open while one is active;
- `concatMap`: terminal close/kill/resume teardown must retain order;
- `mergeMap`: independent PTY/CDP streams may proceed concurrently;
- `groupBy`: apply one of those policies independently per session or tab.

## Signal ownership

Use the intended constructor forms according to semantics:

```ts
// Event/intent; requires the Phase 0 bare-Signal contract.
const refreshRequested = Signal<TmuxRefreshRequest>();

// Writable current state; behavior demonstrated by 0_types.test.ts.
const sessions = Signal<readonly Session[]>([]);

// Automatic derived truth; requires the Phase 0 memo contract.
const visibleSessions = Signal(() =>
  sortAndFilter(sessions.$(), query.$(), sort.$()),
);

// Lazy shared external stream, undefined until first emission.
const frontmostApp = Signal(frontmostApp$);

// Lazy shared external stream with exact T from initialization.
const worktrees = Signal(worktreeScan$, [] as readonly WorktreeRow[]);
```

Do not use `combineLatest` for ordinary synchronous derivation. `Signal(fn)` is
the dynamic dependency-tracked combination. Use explicit Observable composition
when temporal behavior itself is part of the requirement.

## Phase 0: finish and freeze the Signals contract

Work in `~/projects/hafley-rxjs/packages/signals` before adding the dependency to
Instant.

Add contract tests alongside the current two suites:

1. Bare `Signal<T>()` does not emit an initial `undefined` and does not replay a
   previous event to a later subscriber.
2. Bare Signal shares a producer/subscriber surface and cleans up correctly.
3. `Signal(data)` synchronously reads/replays the initialized value, preserving
   the behavior in `0_types.test.ts`.
4. `Signal(observable$)` subscribes lazily, shares one source subscription, and
   replays the latest value while active.
5. `Signal(observable$, defaultValue)` is synchronously initialized and typed
   exactly as `T`.
6. `Signal(fn)` tracks all signal reads and caches/replays its result.
7. A conditional memo unsubscribes from dependencies no longer read after its
   branch changes.
8. Nested memo composition does not duplicate recomputation or subscriptions.
9. Memo errors have deliberate semantics and do not permanently kill unrelated
   signals.
10. Disposal releases every source/dependency subscription.

Resolve or consciously preserve the characterized behaviors in
`4_assumptions.test.ts`, especially per-method scoped Observable duplication,
before using many nested signals in large Worktree collections.

Gate:

```sh
cd ~/projects/hafley-rxjs
pnpm --filter @hafley/signals typecheck
pnpm --filter @hafley/signals test --run
pnpm --filter @hafley/signals build
```

## Phase 1: dependency and compatibility bridge

Consume a pinned package version or commit. Do not use a machine-local
`file:../hafley-rxjs` dependency for a work application; that would make builds
depend on sibling-directory state.

Add:

- `rxjs`;
- a pinned `@hafley/signals` artifact;
- optionally selected `@hafley/rxjs-ext` operators.

Create `src/reactive/`:

```text
src/reactive/
  events.ts             discriminated AppEvent union
  eventBus.ts           input/output boundary and loop protection
  runtime.ts            epic composition, subscriptions, teardown
  ports.ts              typed imperative edge adapters
  legacyStoreBridge.ts  temporary one-way writes to the existing store
```

The initial runtime may consume facts and write them into the old store:

```ts
tmuxFacts$.subscribe(event => {
  if (event.type === "tmux.refreshed") {
    store.set({ sessions: [...event.sessions] });
  }
});
```

This keeps all existing panels and commands working while the new graph is
verified.

Gate: application behavior and persisted state are byte-for-byte unchanged.

## Phase 2: first vertical slice—Tmux session observation

Migrate the read side only:

- initial session load;
- periodic refresh;
- refresh after open/close/kill;
- rogue-agent polling;
- current derived sorting/filtering.

Keep terminal creation and close behavior imperative for now.

Required tests:

- timer and manual refresh coalesce according to the chosen flattening policy;
- refresh errors become facts and do not terminate future refreshes;
- plugin/runtime teardown stops polling;
- only one backend request is active when `exhaustMap` is selected;
- old store bridge receives the same session snapshots as today.

After parity, convert `TmuxPanel` to tracked reads using
`SignalReactMemo`, retaining `TreeTable` as the canonical grid.

## Phase 3: Worktree scan and derived tree

Migrate:

- local scan requests;
- ghcacher SSE deltas;
- auto-discovered worktrees from session cwd;
- filesystem child loads;
- query/focus/expanded state;
- row derivation through `Signal(fn)`.

Keep add/remove worktree and agent launch as existing imperative commands until
the observation side is stable.

This phase should coincide with removing the retired vanilla Worktrees renderer
and `src/table.ts`. Do not preserve dead UI paths in the reactive graph.

## Phase 4: plugin runtime becomes authoritative

Expand the existing plugin registry so one declaration supplies panels,
commands, config, status, and epics. Registration remains synchronous and typed;
activation starts temporal behavior and returns teardown.

Composition:

```ts
const epicOutput$ = merge(
  ...plugins.flatMap(plugin =>
    plugin.epics?.map(epic => epic(events$, context)) ?? [],
  ),
);
```

The runtime must isolate epic errors so one plugin cannot terminate the shared
application graph. Every plugin activation is paired with deterministic
teardown, including HMR replacement.

Plugin state remains namespaced and versioned. Plugins own their Signals and
expose read-only capabilities to other plugins rather than importing one
another's files.

## Phase 5: Dockview lifecycle

Represent Dockview explicitly as a resource state machine:

```ts
type DockState =
  | { status: "booting" }
  | { status: "ready"; generation: number }
  | { status: "recovering"; error: unknown }
  | { status: "failed"; error: unknown };
```

Dockview remains an imperative sink behind `DockPort`; events report facts back
into the graph. A non-null API reference must not imply readiness. Restore,
fallback construction, and generation replacement receive characterization
tests reproducing the disposed-resource failure.

## Phase 6: terminal lifecycle

Only after the observation and plugin runtime phases are stable, migrate:

- open request sequencing;
- PTY output routing;
- xterm focus and dimensions;
- Tmux scroll/copy-mode policy;
- close → detach/kill/resume ordering;
- reopen behavior.

One terminal/CDP tab is a legitimate constructor-owned resource. The collection
of terminal facts and UI projections is global FRP state.

Use per-terminal `groupBy` and explicit flattening policy. Teardown tests are
mandatory because a terminal owns external resources.

## Phase 7: Favorites and reverse ledger lookup

Migrate last because it touches durable user data and currently relies on
heuristic identity resolution.

First define a canonical identity:

```ts
interface MessageIdentity {
  editor: "claude" | "opencode";
  conversationId: string;
  messageId: string;
  cwd: string;
}
```

Model pointer/session/cwd/ledger changes as streams, but require an explicit
resolved identity before writing `favorites.db`. `switchMap` cancels stale hover
or lookup work; ambiguity is a value shown to the user, never silently resolved
to "latest" unless that behavior is explicitly selected.

The database remains the durable source of truth. Safe boot and frontend state
recovery must never clear Favorites.

## File-level destination

```text
src/
  reactive/
    events.ts
    eventBus.ts
    runtime.ts
    ports.ts
  features/
    tmux/
      plugin.ts
      state.ts
      epics.ts
      model.ts
      TmuxPanel.tsx
    worktrees/
      plugin.ts
      state.ts
      epics.ts
      model.ts
      WorktreesPanel.tsx
    terminals/
      plugin.ts
      resources.ts
      epics.ts
      model.ts
    favorites/
      plugin.ts
      identity.ts
      epics.ts
      model.ts
      FavoritesPanel.tsx
```

One panel per file and all row-shaped UI continues to use `TreeTable`.

## Global safety rules

1. No big-bang rewrite.
2. One-way compatibility bridges; never mirror two writable sources into each
   other.
3. A hot producer has explicit ownership and teardown.
4. An epic error becomes an event and cannot terminate the runtime.
5. `Signal(fn)` is for current derivation; RxJS is for meaningful time policy.
6. Durable schemas are independent from transient stream state.
7. Every migrated subsystem has parity tests before its legacy path is removed.
8. Favorites and terminal process lifecycle migrate last.
9. `just check`, `just build`, `just cargo-check`, and relevant tests pass at
   every phase.
10. Use `just dev-safe`, never `just dev`, for verification.

## Definition of success

- Plugins are strongly typed contributions rather than modules connected by
  circular imports.
- React/Dockview render current Signals and do not coordinate application time.
- Tauri/xterm/Dockview remain explicit imperative boundaries.
- Temporal policies are visible as RxJS operators.
- Current derived state is expressed as ordinary synchronous `Signal(fn)` code.
- Plugin activation and HMR have deterministic teardown.
- A failed plugin or disposed Dockview resource cannot brick unrelated panels.
- Existing Tmux sessions, persisted preferences, and Favorites survive migration.
