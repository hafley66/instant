# Markdown, filesystem, graph language, viewport, and panel decomposition

Status: discussion plan. No package moves in this document.

## 0. Current rendering path

```text
markdown source
  ├─ unified + remark-parse
  │    └─ MdDoc heading tree, source offsets, list-fold offsets
  └─ Streamdown mode="static"
       ├─ normal markdown elements -> React/HTML
       ├─ @streamdown/code -> syntax-highlighted code using Shiki themes
       └─ fenced graph languages
            ├─ d2 -> @terrastruct/d2 -> SVG string
            └─ mermaid -> mermaid.render -> SVG string
                 └─ DiagramLightbox -> injected PanZoomViewport
```

`remark-parse` currently builds the structural model in `packages/md/src/model.ts`. It does not render the document. Streamdown renders markdown slices and internally owns the markdown-to-React path used by this package.

## 1. Intended package ownership

| Package | Owns | Does not own |
| --- | --- | --- |
| `@hafley66/md` | markdown AST projection, heading/list folds, markdown renderer composition, markdown link semantics, markdown-specific state | filesystem transport, file tree, D2, Mermaid, generic SVG viewing, docks |
| `@hafley66/fs` | filesystem types, paths, directory models, reads, watches, watch pooling, reactive constructors/operators, file tree UI | markdown rules, dock registration, Tauri command names |
| `@hafley66/grapht` | graph-language adapters, D2/Mermaid rendering, graph artifact types, SVG metadata, graph themes | markdown parsing, lightbox chrome, filesystem transport |
| `@hafley66/viewport` working name | pan/zoom state machine, pointer/wheel/keyboard input, transform application, viewport controls | diagrams, markdown, panel registration |
| `@hafley66/dock-and-graph` working name | dock/panel/window/node-editor/canvas engine composition, panel routing and persistence | markdown parser, filesystem implementation, graph-language parser implementations |
| Instant | Tauri adapters, application composition, diagnostics wiring, concrete routes | reusable rendering and filesystem models |

The lightbox has two layers:

- Generic layer: modal shell, history selection, copy action, debug facts, and a viewport slot.
- Graph layer: `DiagramArtifact` fields and graph-source labels.

Its current implementation is graph-shaped rather than markdown-shaped. It can initially move to `@hafley66/grapht`, consuming `@hafley66/viewport`. If modal/history chrome becomes shared by images and other artifacts, split that shell into the dock/window package later.

## 2. Type signatures

### `@hafley66/fs`

```ts
export type FsPath = string;

export interface FsEntry {
  name: string;
  path: FsPath;
  kind: "file" | "directory" | "symlink" | "other";
  size?: number;
  modifiedMs?: number;
  extension?: string;
}

export interface FsChange {
  root: FsPath;
  path: FsPath;
  kind: "create" | "modify" | "remove" | "rename" | "other";
}

export interface FsReader {
  readText(path: FsPath): Promise<string>;
  readBinary(path: FsPath): Promise<Uint8Array>;
  list(path: FsPath): Promise<readonly FsEntry[]>;
}

export interface FsWatcher {
  watch(path: FsPath, options?: { recursive?: boolean }): Observable<FsChange>;
}

export interface FileTreeState {
  root: FsPath;
  active?: FsPath;
  expanded: ReadonlySet<FsPath>;
  children: ReadonlyMap<FsPath, readonly FsEntry[]>;
  pending: ReadonlySet<FsPath>;
  errors: ReadonlyMap<FsPath, unknown>;
}

export function createFileTreeSignal(
  reader: FsReader,
  initial: Pick<FileTreeState, "root" | "active">,
): Signal<FileTreeState>;

export function watchPath$(
  watcher: FsWatcher,
  path$: Observable<FsPath>,
  options?: { recursive?: boolean; debounceMs?: number },
): Observable<FsChange>;
```

The Tauri implementation remains an adapter in Instant until a separately publishable Tauri adapter package exists:

```ts
export function createInstantFsReader(invoke: InstantInvoke): FsReader;
export function createInstantFsWatcher(tauri: TauriFsWatchPort): FsWatcher;
```

### `@hafley66/grapht`

```ts
export type GraphLanguage = "d2" | "mermaid";

export interface GraphSource {
  language: GraphLanguage;
  source: string;
  locator?: string;
}

export interface GraphRenderOptions {
  theme: "light" | "dark";
  signal?: AbortSignal;
}

export interface GraphArtifact {
  language: GraphLanguage;
  source: string;
  svg: string;
  sourceBytes: number;
  svgBytes: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface GraphLanguageRenderer<L extends GraphLanguage = GraphLanguage> {
  language: L;
  render(source: string, options: GraphRenderOptions): Promise<GraphArtifact>;
}

export function createD2Renderer(): GraphLanguageRenderer<"d2">;
export function createMermaidRenderer(): GraphLanguageRenderer<"mermaid">;
```

Markdown consumes a registry instead of importing either language:

```ts
export interface MarkdownCodeRenderer {
  language: string;
  component: ComponentType<{ code: string }>;
}

export interface MarkdownRendererOptions {
  codeRenderers?: readonly MarkdownCodeRenderer[];
}
```

### `@hafley66/viewport`

```ts
export interface ViewportTransform {
  x: number;
  y: number;
  scale: number;
}

export type ViewportEvent =
  | { type: "pointer/down"; id: number; x: number; y: number }
  | { type: "pointer/move"; id: number; x: number; y: number }
  | { type: "pointer/up"; id: number }
  | { type: "wheel/pan"; dx: number; dy: number }
  | { type: "wheel/zoom"; anchorX: number; anchorY: number; delta: number }
  | { type: "zoom/set"; scale: number }
  | { type: "fit"; viewport: Rect; content: Rect }
  | { type: "reset" };

export function reduceViewport(
  state: ViewportTransform,
  event: ViewportEvent,
): ViewportTransform;

export function createViewportSignal(
  initial?: Partial<ViewportTransform>,
): Signal<ViewportTransform>;
```

React is an adapter over the state machine. Canvas, SVG, DOM, and a future worker-backed renderer consume the same transform signal.

### Dock/panel boundary

```ts
export interface PanelLocation {
  windowId: string;
  groupId: string;
  panelId: string;
}

export interface PanelRoute<State> {
  kind: string;
  encode(state: State): string;
  decode(url: string): State | null;
}

export interface PanelDefinition<State> {
  kind: string;
  route: PanelRoute<State>;
  render(state: Signal<State>): PanelContent;
}
```

`@hafley66/md` eventually exports a markdown panel definition or markdown content component. It does not register itself into a global dock singleton.

## 3. Instance timelines

### File watch

1. A consumer subscribes to `watchPath$(path$)`.
2. The adapter acquires one underlying watch claim per normalized `(path, recursive)` key.
3. Multiple subscribers share the claim and receive the same event stream.
4. Debounce occurs after raw event sharing so consumers can choose latency independently.
5. The final unsubscribe releases the native claim.

### Markdown document

1. A panel route yields a file path.
2. `FsReader.readText` loads the source.
3. `parseMarkdownStructure` creates headings, offsets, and folds.
4. Streamdown renders source slices with injected fenced-code renderers.
5. A filesystem change invalidates the path and repeats steps 2 through 4.
6. Panel close releases its subscription; cache retention is a policy supplied by the app.

### Graph artifact

1. Streamdown detects a registered fenced language.
2. The language renderer receives source plus theme and cancellation signal.
3. The renderer returns one immutable `GraphArtifact`.
4. Inline output renders the artifact SVG.
5. Lightbox history stores artifact identities, not copied component state.
6. Theme or source changes abort or supersede the prior render.

### Viewport

1. Mount creates one transform signal.
2. Pointer and wheel events reduce into transform state.
3. The renderer applies transform updates outside markdown reconciliation.
4. Unmount releases listeners and pointer capture.

## 4. Storage, reads, writes, uniqueness

| State | Storage | Reads | Writes | Unique key |
| --- | --- | --- | --- | --- |
| filesystem entries | `@hafley66/fs` tree signal/cache | tree/grid and file consumers | directory results and change invalidation | normalized absolute path |
| native watch claim | adapter-level ref-count map | watcher subscriptions | first subscribe/final unsubscribe | normalized path plus recursive flag |
| markdown source/doc | markdown document signal/cache | markdown panel | read completion and watch invalidation | filesystem provider id plus normalized path |
| fold state | markdown UI state | section/list renderers | fold events | document key plus source offset or section id |
| graph artifact | grapht render cache | inline diagram/lightbox | render completion | language plus source hash plus render options hash |
| viewport transform | per mounted viewport signal | DOM/SVG/canvas transform adapter | reduced input events | viewport instance id |
| panel state | dock/window state graph | router and layouts | route, focus, move, close | window/group/panel tuple |

Filesystem path normalization belongs in `@hafley66/fs`; packages must not each maintain a `normPath`, `baseName`, or extension implementation.

## 5. Migration sequence

### Phase 0: stop expanding `MdviewHost`

- Treat the current flat host as temporary composition glue.
- Add new reusable behavior behind package-owned contracts first.
- Keep current behavior and tests stable.

### Phase 1: local `packages/fs`

- Move structural `FsEntry` and path helpers.
- Move `0_FileTreeModel.ts`, then `FileTree` and its CSS/tests.
- Add `FsReader` and `FsWatcher` contracts.
- Wrap current Tauri `invoke` and `claimFsWatch` in Instant adapters.
- Add observable and signal constructors without React dependencies.
- Replace `MdviewHost.readText/readImage/listDir/watchFile/FileTree` with one injected filesystem capability plus the imported `FileTree` UI.

### Phase 2: grapht language adapters

- Add D2 and Mermaid render adapters to `hafley-rxjs/packages/grapht`.
- Move shared graph theme and artifact types.
- Move diagram render tests, including cancellation and cache identity.
- Make `@hafley66/md` accept fenced-code renderer registrations.
- Update terminal diagrams and preview to consume grapht directly.

### Phase 3: viewport package

- Extract pure transform math and event reducer first.
- Extract DOM/React adapter and CSS second.
- Keep diagnostics as injected callbacks or external signal taps.
- Make image viewer, SVG viewer, and graph lightbox consume it.
- Ensure pointer-move transform application does not require markdown or SVG subtree reconciliation.

### Phase 4: lightbox relocation

- Move the current graph artifact lightbox to grapht with viewport as a dependency.
- Keep a generic modal/artifact-viewer seam visible in its props.
- Move modal ownership later if image/SVG viewers share the same shell.

### Phase 5: panel composition

- Remove plugin registration, dock IDs, zoom registry, and persisted panel layout from `@hafley66/md`.
- Export markdown content plus route/state declarations.
- Let the dock/window package construct panels and persist locations.
- Instant supplies only concrete Tauri and application route adapters.

### Phase 6: move local packages to `hafley-rxjs`

- Move one package directory at a time after Instant uses only its public exports.
- Replace `file:packages/*` with workspace references in `hafley-rxjs` and then published versions or a repository workspace link in Instant.
- Run package tests, Instant `just check`, `just build`, and `just cargo-check` after each move.

## 6. First executable slice

The first slice is `packages/fs` inside Instant:

```text
packages/fs/
  package.json
  README.md
  src/
    0_types.ts
    1_paths.ts
    2_reader.ts
    3_watcher.ts
    4_watchOperators.ts
    5_fileTreeModel.ts
    6_FileTree.tsx
    6_FileTree.css
    index.ts
```

Completion conditions:

- `@hafley66/md` has no filesystem types or watch hook implementation.
- Instant's Files panel and markdown explorer use the same `@hafley66/fs` FileTree export.
- One native watch claim is shared for identical normalized watch keys.
- Non-React observable/signal APIs have deterministic lifecycle tests.
- Existing file-tree interaction tests run against the package export.

## 7. Decisions for discussion

1. Package name for pan/zoom: `@hafley66/viewport`, `@hafley66/camera`, or part of the future dock/canvas engine package.
2. Whether `DiagramLightbox` stays in grapht or becomes a generic artifact viewer in the dock/window package after graph extraction.
3. Whether `@hafley66/fs` includes only platform-neutral contracts and UI, with Tauri adapters remaining in Instant, or publishes `@hafley66/fs-tauri` later.
4. Whether markdown panel route and fold persistence ship as an optional `@hafley66/md/panel` entrypoint or remain entirely in the dock package.
