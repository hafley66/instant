# Agent-Controlled Spatial Canvas Research

## Research metadata

- Date: 2026-08-06
- Scope: paged infinite canvas, filesystem-backed artifacts, cursor-aware agent placement, live coding sessions, diagrams, terminals, notebooks, and graph projections
- Method: official documentation and repositories first, current GitHub release metadata, then community reports for newly released projects

## Executive index

The closest complete products are:

1. [Cate](https://github.com/0-AI-UG/cate), an MIT desktop coding canvas containing editors, terminals, browsers, worktrees, agents, a CLI, and extension/MCP seams. GitHub reports release [v1.5.3](https://github.com/0-AI-UG/cate/releases/tag/v1.5.3), published 2026-07-21. Its current manifest uses Electron, React, xterm, Monaco, PDF.js, node-pty, Zustand, and Playwright.
2. [TermCanvas](https://github.com/blueberrycongee/termcanvas), an MIT infinite canvas for tmux terminals and coding agents. GitHub reports release [v0.39.10](https://github.com/blueberrycongee/termcanvas/releases/tag/v0.39.10), published 2026-05-31. Its current manifest uses React Flow, xterm/wterm, Monaco, node-pty, Playwright, and Electron.
3. [PenEcho](https://github.com/penecho/penecho), an AGPL canvas where a spatial selection becomes model context and Codex CLI, Claude Code, or an API places draggable responses back on the board. GitHub reports release [v0.8.1](https://github.com/penecho/penecho/releases/tag/v0.8.1), published 2026-08-01.
4. [Dim0](https://github.com/vcmf/dim0), an MIT collaborative AI canvas with notes, diagrams, code, generated React mini-apps, and board-aware agents. GitHub reports release [v0.3.72](https://github.com/vcmf/dim0/releases/tag/v0.3.72), published 2026-08-06. Its site documents typed operations, real-time collaboration, self-hosting, and thousands of nodes.

These products establish that the combined interaction exists. None supplies Instant's exact combination of tmux persistence, four harness ledgers, filesystem identity, D2/Mermaid rendering, and an agent-neutral command bus.

## Capability matrix

| System | Spatial canvas | Agent writes to canvas | Terminal/session aware | File-backed identity | Embeddable engine | License boundary |
|---|---:|---:|---:|---:|---:|---|
| Cate | yes | yes, CLI and agent skills | yes | editors/worktrees | source can be studied or forked | MIT |
| TermCanvas | yes | orchestration and MCP | tmux-native | worktrees/projects | React Flow internals | MIT |
| PenEcho | yes | Codex, Claude, APIs | harness invocation | board persistence | source can be studied or forked | AGPL-3.0-only |
| Dim0 | yes | board-aware agent | no coding-session model documented | Markdown notes/export | custom canvas engine | MIT |
| tldraw | yes, pages | first-party agent kit | custom shape required | custom metadata/backend | first-class React SDK | production SDK license |
| React Flow | graph canvas | imperative CRUD maps directly | custom node required | application-owned JSON | first-class React library | MIT |
| Excalidraw | yes | official MCP App exists | no | scene JSON | React package | MIT |
| JSON Canvas | storage only | external writer edits JSON | extension field required | native file nodes | renderer-independent | MIT |
| Cytoscape.js | graph canvas | mutable graph API | projection only | application-owned JSON | first-class JS library | MIT |
| MCP Apps | embedded UI protocol | tool and app calls | host-defined | resource URI | sandboxed iframe | open specification/SDK |

## Direct matches

### Cate

Cate describes an infinite zoomable canvas containing editor, terminal, browser, documentation, agent, and worktree panels. Maintainer material documents a `cate` CLI through which agents manage panels, inspect browser accessibility, take screenshots, and open files. It supports Claude Code, Codex, OpenCode, and other terminal agents. [Repository](https://github.com/0-AI-UG/cate), [project site](https://cate.cero-ai.com/).

Reusable evidence:

- A terminal is a movable spatial panel rather than a rasterized artifact.
- Agent commands target the same panel model used by human manipulation.
- Worktree and agent identities are part of panel metadata.
- Project canvas, dock, detached-window layout, terminal scrollback, and resume commands persist across restart.
- Extension panels run in isolated webviews; the documented extension cases include MCP and diagrams.
- The current dependency graph contains no general canvas SDK, indicating that its canvas behavior is application code rather than a separately published component.

### TermCanvas

TermCanvas puts tmux-backed terminal sessions on an infinite canvas and draws orchestration relationships. The current dependency manifest includes `@xyflow/react`, xterm, node-pty, Monaco, and Playwright. This is the closest implementation reference for composing tmux and React Flow. [Repository](https://github.com/blueberrycongee/termcanvas), [release v0.39.10](https://github.com/blueberrycongee/termcanvas/releases/tag/v0.39.10).

Reusable evidence:

- React Flow can host interactive terminal DOM nodes.
- tmux remains the process/session persistence layer.
- Session relationships can share the same stable IDs as canvas edges.
- Canvas position is application state independent of tmux pane geometry.
- Its `.termcanvas` model persists canvas state, and its headless runtime exposes lifecycle hooks.
- Its CLI groups include `project`, `worktree`, `terminal`, `workflow`, `telemetry`, `pin`, `diff`, and `state`. Terminal commands include create, list, status, output, destroy, and title mutation.
- The source models project to worktree to terminal hierarchy, live worktree discovery, resumable sessions, session replay, inline diffs, Git views, and Claude/Codex/Kimi/Gemini/OpenCode state.

### PenEcho

PenEcho sends selected spatial regions to Codex CLI, Claude Code, or model APIs and inserts responses as draggable board objects. Its current license is AGPL-3.0-only. [Repository](https://github.com/penecho/penecho), [release v0.8.1](https://github.com/penecho/penecho/releases/tag/v0.8.1).

The interaction applicable to Instant is a cursor or selection envelope attached to the agent request. The response protocol returns typed placement operations rather than terminal prose that a screen scraper later guesses about.

### Dim0

Dim0 combines notes, diagrams, code, charts, generated React mini-apps, collaboration, and a board-aware agent. Its documentation states that the agent reads selected board context and writes nodes beside existing material. The canvas engine exposes typed operations with previous-value slices, while collaboration transforms operations on the server. It reports 10,000 visible nodes at approximately 80 fps on an M1; this is a project claim requiring an independent benchmark. [Product documentation](https://www.dim0.net/), [repository](https://github.com/vcmf/dim0).

## Canvas engine options

### tldraw

Current GitHub release metadata identifies [v5.0.2](https://github.com/tldraw/tldraw/releases). Version 5 adds `@tldraw/driver`, `@tldraw/mermaid`, overlay extensibility, custom records, and custom assets. The SDK production license requires its prescribed key/watermark terms; starter-kit code has separate MIT statements. [Repository and license summary](https://github.com/tldraw/tldraw).

The `Editor` API supplies `createShape(s)`, `updateShape(s)`, pages, bindings, assets, camera operations, coordinate conversion, selection, history, export, and transactional `editor.run`. [Editor documentation](https://tldraw.dev/docs/editor). `screenToPage` provides cursor-to-canvas placement. Persistence splits the durable document from per-user camera, page, and selection state through `getSnapshot` and `loadSnapshot`; `persistenceKey` supplies IndexedDB and cross-tab synchronization. [Persistence documentation](https://tldraw.dev/sdk-features/persistence).

The [Agent Starter Kit](https://tldraw.dev/starter-kits/agent) already sends the model:

- selected shapes;
- visible screen bounds;
- explicit positions and areas;
- a screenshot;
- simplified visible shape data;
- clusters outside the viewport;
- recent user actions and agent action history.

Its streamed actions create, update, delete, align, distribute, and move shapes. `agent.prompt({ message, bounds })` is an exact precedent for “send the update to my cursor.” Persistent iframe shapes can keep live embeds mounted across canvas/editor lifecycle changes. [Persistent iframe example](https://tldraw.dev/examples/persistent-iframe-shape).

### React Flow

[React Flow](https://reactflow.dev/) exposes a smaller graph-oriented surface. `ReactFlowInstance` supplies `addNodes`, `updateNode`, `addEdges`, `deleteElements`, `screenToFlowPosition`, `setCenter`, `fitBounds`, and `toObject`. [API reference](https://reactflow.dev/api-reference/types/react-flow-instance). Custom React nodes can contain terminals, file previews, cached SVGs, trace summaries, or MCP App iframes.

Storage, pages, history, assets, and collaboration remain application-owned. Official performance guidance calls for memoized nodes/callbacks, narrow state subscriptions, collapsed subtrees, simplified styling, and visible-element rendering. [Performance guide](https://reactflow.dev/learn/advanced-use/performance).

### Excalidraw

[Excalidraw](https://github.com/excalidraw/excalidraw) and its React package are MIT. The organization now publishes [Excalidraw MCP](https://github.com/excalidraw/excalidraw-mcp), described as a fast, streamable MCP App, and `mermaid-to-excalidraw`. The current package release is [v0.18.1](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1), a security update for Mermaid input handling.

Its scene model and annotation behavior fit hand drawing. Live terminals, filesystem-backed documents, rich application nodes, and pages require application integration around the scene.

## Durable file format

[JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) defines readable `.canvas` JSON with text, file, link, and group nodes plus edges. Every node has a stable ID and rectangle. File nodes reference paths. The format and resources are MIT licensed. [Project overview](https://jsoncanvas.org/). Obsidian stores Canvas documents locally in this format and embeds notes, images, audio, PDFs, unknown files, and web pages. [Obsidian Canvas documentation](https://obsidian.md/help/Plugins/Canvas).

An Instant document can preserve standard nodes and edges while adding namespaced metadata:

```ts
type InstantCanvas = JsonCanvas & {
  instant?: {
    version: 1
    pages: Record<string, { name: string }>
    artifacts: Record<string, ArtifactSource>
  }
}

type ArtifactSource = {
  source: {
    kind: "file" | "session" | "turn" | "inline" | "mcp-app" | "trace"
    path?: string
    range?: { line: number; column?: number }
    harness?: "claude" | "codex" | "opencode" | "kimi"
    sessionId?: string
    turnId?: string
  }
  renderer: {
    kind: "d2" | "mermaid" | "svg" | "image" | "document" | "terminal" | "mcp-app"
    sourceHash: string
    renderHash?: string
  }
}
```

The `.canvas` file stores placement and references. Rendered SVGs/images belong in a sibling asset directory or the existing blob store, keyed by renderer version and source hash.

## Agent and CLI protocol

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) is the current standard boundary for interactive artifacts returned by tools. A tool declares `_meta.ui.resourceUri`, the host fetches a `ui://` HTML resource, and a sandboxed iframe exchanges tool inputs, results, notifications, and app-initiated tool calls over JSON-RPC. The [stable extension specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) separates model-visible tools from app-only tools through `visibility`.

MCP Apps defines the embedded application boundary. Spatial placement, durable identity, and cross-artifact edges remain host data.

A common Instant command schema can serve Tauri invocation, bus messages, a CLI JSON interface, and MCP tools:

```ts
type CanvasCommand =
  | { type: "canvas.cursor.get"; canvasId: string }
  | { type: "artifact.upsert"; canvasId: string; identity: ArtifactIdentity; revision?: number; content: ArtifactContent; place?: Placement }
  | { type: "artifact.move"; canvasId: string; artifactId: string; revision: number; frame: Rect }
  | { type: "artifact.remove"; canvasId: string; artifactId: string; revision: number }
  | { type: "edge.upsert"; canvasId: string; edge: ArtifactEdge }
  | { type: "viewport.focus"; canvasId: string; artifactId: string }
  | { type: "session.attach"; canvasId: string; harness: HarnessId; sessionId: string; place?: Placement }

type Placement =
  | { kind: "cursor" }
  | { kind: "near"; artifactId: string; side?: "top" | "right" | "bottom" | "left" }
  | { kind: "explicit"; frame: Rect }
  | { kind: "grid" }
```

Lifecycle:

1. A canvas instance loads one document and owns one editor/store lifetime.
2. Human cursor, selection, and viewport are ephemeral session state.
3. CLI or agent reads `canvas.cursor.get` immediately before placement.
4. `artifact.upsert` resolves stable source identity and applies one revisioned transaction.
5. Filesystem watches invalidate artifact content by path; user moves update only the frame.
6. D2/Mermaid rendering caches by source hash, theme, and renderer version. Camera and node movement never rerender the diagram.
7. Active harness sessions attach through stable ledger IDs. No terminal-text inference participates in identity.

## Existing Instant seams

Instant already contains the data needed for this protocol:

| Seam | Current location | Reuse |
|---|---|---|
| Four harness stores | `src-tauri/src/0_harness_store.rs` | `HarnessSession` includes harness, cwd, source path, parent, model, and activity |
| Harness CLI | `src-tauri/src/bin/instant-harness.rs` | sessions, resolve, and incremental messages already emit JSON |
| tmux lifecycle | `src-tauri/src/pty.rs` | durable interactive terminal artifact |
| File routing | `src/preview.ts` | `openPathInInstant` and `openDocumentHrefInInstant` |
| Live file invalidation | `src/preview.ts` | shared filesystem watcher claims and debounced repaint |
| Namespaced persistence | `src/pluginState.ts` | prototype canvas layout state before a file-backed document lands |
| Cached diagrams | terminal diagram and D2/Mermaid modules | source-hash renderer boundary |
| Session relations | harness parent IDs and bus ledger | session graph projection |

The first protocol adapter can wrap `instant-harness` rather than add another harness reader. A canvas session node references `{harness, sessionId, cwd}` and hosts the existing xterm panel implementation.

## Graph and layout projections

[Cytoscape.js](https://js.cytoscape.org/) supplies mutable graph IDs/data, selectors, events, layouts, headless operation, image export, and graph analysis. It fits a derived “show every visible session/artifact relation” view. The notebook remains authoritative for manually placed frames.

[ELK/elkjs](https://eclipse.dev/elk/) accepts hierarchical graph JSON and returns calculated node, port, label, and edge positions without rendering. The current Eclipse project page lists release 0.12.0 dated 2026-07-17. Run it in a worker for initial placement and preserve pinned human coordinates.

Agent observability systems such as [Phoenix](https://arize.com/docs/phoenix) and [Langfuse](https://langfuse.com/docs/api-and-data-platform/features/public-api) provide OTLP/OpenInference or public APIs for traces, spans, sessions, and tool calls. Their trace data can project into the same graph. They do not supply the editable artifact notebook.

## Storage, reads, writes, and uniqueness

- Canvas file: one document per `.instant.canvas` path.
- Node identity: one visual occurrence per JSON Canvas node ID.
- Source identity: canonical path plus optional range, or harness plus session/turn ID.
- Artifact identity: stable hash of canvas ID, source identity, and logical artifact key.
- Multiple views of one file: distinct artifact IDs share one source identity.
- Render identity: hash of renderer kind/version, source content, and theme.
- Human frame changes write node rectangles only.
- Source changes write content metadata and a new render hash only.
- Agent writes require `expectedRevision` when updating an existing artifact.
- Every accepted command emits a revisioned event suitable for undo, audit, and bus subscribers.

## Performance tests

The canvas lab needs measured receipts for:

- 1,000 and 10,000 lightweight artifact nodes;
- mounted DOM and iframe counts inside, near, and outside the viewport;
- pan and zoom frame timing;
- xterm nodes at 1, 4, 16, and 64 visible sessions;
- SVG cache hit rate while moving and zooming;
- `.canvas` parse, incremental write, and reload time;
- file-watch bursts against one and 100 artifacts;
- ELK worker latency for session trees and dense trace graphs;
- cursor placement followed by human movement during a concurrent agent update;
- stale revision rejection and deterministic replay.

## Implementation-shaped lab boundary

The smallest lab uses React Flow, JSON Canvas, and existing Instant terminals/renderers:

```ts
type CanvasRuntime = {
  dispatch(command: CanvasCommand): Promise<CanvasResult>
  events: Observable<CanvasEvent>
  snapshot(): InstantCanvas
}

// Body:
// 1. Load one JSON Canvas file.
// 2. Adapt nodes to React Flow nodes with custom artifact components.
// 3. Convert screen cursor coordinates through screenToFlowPosition.
// 4. Apply revisioned commands through one reducer/transaction stream.
// 5. Persist document changes; keep viewport/selection in plugin state.
// 6. Attach existing xterm, file preview, cached SVG, and MCP App renderers.
// 7. Project session relations into edges without copying session data.
```

This lab proves cursor placement, file identity, agent updates, terminal interactivity, renderer caching, and persistence without first introducing collaborative sync or a new agent runtime.

## Research gaps

- Cate and TermCanvas require source-level flow tracing before copying any implementation seam.
- Dim0's performance figures need an independent local benchmark.
- Excalidraw's hosted public API beta was mentioned in community material; current primary API documentation was not located during this run.
- AFFiNE's Edgeless editor and licensing boundaries need a separate repository audit before treating it as an embeddable package.
- Cross-host MCP Apps support remains optional and must be capability-negotiated.
