# Reactive IR exploration

Status: exploratory, not done.

## Correction to the discussion

This plan does not propose rewriting DL6 in TypeScript.

DL6 and the Prolog compiler remain the intent language, semantic checker, and lowering source. The TypeScript unions below are descriptive views of a shared serialized IR for editor integration, generated bindings, RxJS execution, tests, and UI rendering. They are not the source language and do not replace the Prolog implementation.

The motivating task was also narrower than the full compiler queue below: make Instant's window, tab, panel, canvas, file, terminal, agent, and graph content composable as serializable algebra, with Signal state and RxJS temporal behavior. The larger queue is preserved because it shows how that UI algebra could eventually participate in the wider Sprefa compiler system.

## Existing pieces

- `~/projects/sprefa/v6/prolog`: DL6 semantics, kernel forms, sugar grounding, checks, and target emission.
- `~/projects/sprefa/v6/sprefa-extract`: structural and historical code queries over source, Git blobs, SCIP, and language-specific syntax.
- `~/projects/hafley-rxjs/packages/json-rx`: serialized pipeline descriptions, cross-language code generation, reactive-state experiments, and Signal integration.
- `~/projects/anim`: entity, edge, view, transition, layout, annotation, and tour models for graph UI work.
- `~/projects/instant`: the first UI consumer, including Dockview panels, terminals, files, media viewers, bus relations, and plugin state.

## Immediate scope

Define a serializable UI algebra whose current value is exposed through Signals and whose changes flow through RxJS. Preserve the current Instant UI while adapters are introduced.

```ts
type View =
  | { type: "dock"; id: Id; axis: "x" | "y"; children: ViewRef[] }
  | { type: "tabs"; id: Id; active: Id; children: ViewRef[] }
  | { type: "canvas"; id: Id; camera: Camera; children: ViewRef[] }
  | { type: "terminal"; id: Id; session: Id }
  | { type: "file"; id: Id; source: FileRef; renderer: Id }
  | { type: "graph"; id: Id; query: QueryRef }
  | { type: "component"; id: Id; component: Id; props: JsonValue }

type ViewRef = {
  view: View
  placement: Placement
  z: number
}
```

The TypeScript declaration is a generated or descriptive binding. The authoritative declaration may later live in DL6 and lower into TypeScript, SQLite, Rust, Go, Bash, HTML, and test fixtures.

## Implementation queue

### 0. Inventory current UI ownership

Record the existing owners for:

- panel identity
- tab order and active tab
- Dockview placement and ratios
- terminal process identity
- file viewer identity
- canvas camera and object placement
- plugin state persistence
- close, reopen, move, split, focus, and resize events

Output: one table of state field, current owner, mutation sites, persistence location, and renderer consumers.

### 1. UI identity and value vocabulary

Define stable ids, serializable values, references, placement, bounds, camera, and z-order. Avoid embedding DOM nodes, React elements, subscriptions, xterm instances, Cytoscape instances, or process handles.

```ts
type ViewId = string
type ResourceRef = { kind: string; id: string }
type Placement = { x: number; y: number; width: number; height: number }
```

Proof: JSON round trip and deterministic snapshot.

### 2. View tree algebra

Represent containment, ordering, focus, activation, splitting, tabs, canvas children, and component resource references. Define normalization rules for duplicate ids, missing active tabs, invalid parentage, and cycles.

Proof: construct, serialize, restore, normalize, and compare one nested terminal, file, and graph workspace.

### 3. Mutation algebra and history

```ts
type ViewEvent =
  | { type: "view.insert"; parent: ViewId; index: number; view: View }
  | { type: "view.remove"; id: ViewId }
  | { type: "view.move"; id: ViewId; parent: ViewId; index: number }
  | { type: "view.resize"; id: ViewId; placement: Placement }
  | { type: "tabs.activate"; id: ViewId; tab: ViewId }
  | { type: "canvas.camera"; id: ViewId; camera: Camera }
```

Fold events into a Signal snapshot. Preserve the event sequence for undo, redo, replay, debugging, and migration tests. RxJS owns temporal composition, cancellation, batching, and effect switching.

Proof: replay produces the same serialized workspace; inverse or checkpoint behavior restores prior snapshots.

### 4. Renderer and resource ports

Map serialized view kinds to runtime renderers without putting runtime instances in the IR.

```ts
type ViewRenderer = (view: View, context: ViewContext) => ReactNode
type ResourcePort = (ref: ResourceRef) => Observable<ResourceState>
```

Initial adapters:

- Dockview container
- xterm session
- file and media viewer
- graph view
- rectangle canvas

Proof: a nested canvas or panel renders an existing terminal/file component without adding another state owner.

### 5. Instant compatibility adapter

Project current Instant state into the view algebra and route view events back through existing commands. Keep existing visual behavior and persistence during this phase.

Timeline:

```text
existing Instant state
→ projection into serialized View
→ existing renderer adapter
→ user event
→ existing Instant command
→ updated projection
```

Proof: current terminal, file, and plugin tabs open, move, close, reopen, persist, and restore with matching screenshots.

### 6. Anim inspection adapter

Lower view containment, resource references, event causes, and history into `anim` entities, edges, refs, views, and tours.

Initial graph views:

- current view tree
- event timeline
- resource ownership
- signal dependencies
- effect lifetimes
- panel movement history

Proof: one Instant workspace history renders as an anim graph and can scrub between checkpoints.

### 7. DL6 declaration experiment

After the UI algebra works in Instant and anim, describe a small subset in DL6. Keep Prolog as the semantic and lowering implementation.

Candidate surface forms:

```prolog
view(Name, Kind, Props).
view_child(Parent, Child, Ordinal).
route(Event, Target).
materialize(Name, Query, Retention).
effect(Name, Capability, Input, Output).
```

Lower those declarations into the same serialized UI IR fixture used by the TypeScript adapter.

Proof: Prolog emission and handwritten fixture match byte-for-byte or by canonical structural comparison.

### 8. Shared temporal and relational IR experiment

Only after queue items 1 through 7 establish concrete requirements, evaluate a broader IR for facts, transactions, relational queries, temporal validity, and effects.

Potential consumers:

- DL6 target lowering
- json-rx generated RxJS and Signal runtimes
- SQLite materialized projections
- Rust effect hosts
- sprefa-extract historical queries
- anim execution visualizations
- Instant UI state and history

This stage must reuse the proven UI algebra rather than replacing it with an abstract compiler model.

### 9. Partial file-reference resolver

Use the shared temporal machinery as an end-to-end proving program:

```text
message file hint
→ process, harness, agent, and tmux relations at message time
→ working-tree candidates
→ Git blob and rename history candidates
→ progressive ranked results
→ user selection written as another event
```

Proof: resolve references across different process CWDs, child agents, rebases, force pushes, and historical renames while streaming partial candidates.

## Instance timelines

### Workspace

```text
deserialize seed or project current Instant state
→ construct workspace Signal
→ attach event flow when a renderer reads it
→ fold view events
→ persist checkpoints and event tail
→ release runtime renderers when no view references them
```

### Runtime resource

```text
serialized ResourceRef becomes visible
→ renderer asks the resource port for state
→ switch to the current process, file, graph, or media resource
→ stream updates into the view
→ visibility or removal cancels the active resource flow
```

### History replay

```text
load checkpoint
→ read ordered events after checkpoint
→ fold deterministically
→ expose synchronous Signal snapshot
→ optionally continue with live events
```

## Storage sequence

1. Append a typed event with stable event id, logical clock, cause ids, and payload.
2. Commit an event batch atomically.
3. Fold the batch into the current workspace projection.
4. Publish projection deltas to active renderers.
5. Periodically write a checkpoint tied to the final included event id.
6. Rebuild from checkpoint plus subsequent events.

Uniqueness conditions:

- View identity is unique within one workspace history.
- Event identity is globally stable for deduplication.
- Child ordering is unique by `(parent, ordinal)` after normalization.
- Runtime resource identity remains outside serialized component ownership.
- A checkpoint is uniquely identified by workspace and final event id.

## First executable slice

One opt-in Instant workspace containing:

- an ordinary terminal tab
- a file viewer tab
- a canvas containing a graph rectangle
- serialized placement and active-tab state
- move, activate, close, reopen, undo, and replay events
- a deterministic JSON snapshot
- an anim graph of the same event history

The current Dockview UI remains the renderer during this slice.
