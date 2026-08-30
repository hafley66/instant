# Instant rectangle adapter lab

Implement one opt-in Instant tab that consumes `@hafley66/react-dock-and-flow@0.0.3` through Instant's existing plugin and Dockview instance registry.

## Repository and constraints

- Work only in `/Users/chrishafley/projects/instant/.worktrees/instant-rectangle-adapter`.
- Do not edit the main checkout.
- Do not commit, push, publish, open a PR, or run `just dev`.
- Read and obey this repository's `AGENTS.md` before editing.
- The repository is public and the user explicitly authorizes OpenRouter DeepSeek V4 Flash 0731 to read and edit this worktree for this lab.
- Keep source files below 500 lines.
- New source files use author-driven numeric prefixes based on dependency order.
- Do not add a tab system, docking implementation, list, table, tree, split-pane implementation, or manual pointer resize implementation.
- Do not replace or alter the current terminal, file, browser, markdown, paint, or other default panel behavior.
- Do not add a startup panel, rail button, toolbar button, or default layout mutation.
- Do not duplicate rectangle state into React state. The package model is the canonical rectangle state.
- Avoid direct `.subscribe()` in new application code when `useSyncExternalStore`, an existing Signal hook, or an existing repository adapter provides the lifecycle boundary.

## Required seam

Use the existing `Plugin.instances` / `PanelInstanceDef` registration path in `src/plugin.tsx` and Dockview component registry. Register one restorable instance prefix for a rectangle workspace, for example `rect:`. The exact name may follow nearby conventions.

Export one callable function with this semantic contract:

```ts
export interface RectangleWorkspaceInput {
  id: string;
  title: string;
  sessions: readonly {
    id: string;
    title: string;
    lines: readonly string[];
  }[];
  graph?: {
    id: string;
    title: string;
    nodes: readonly string[];
    edges: readonly (readonly [string, string])[];
  };
}

export function openRectangleWorkspace(input: RectangleWorkspaceInput): void;
```

The function must open or focus an existing Dockview instance through current Instant APIs. Reopening the same `input.id` must focus/update that workspace rather than create a duplicate tab. Persist only data needed by the existing restorable instance mechanism. If the published package's current public API prevents exact readonly inputs, adapt at this boundary and document it.

## Visible content

The tab must render:

1. One package `session` rectangle per `input.sessions` row.
2. Zero or one package `graph` rectangle from `input.graph`.
3. Existing package movement, raise, undo, and redo behavior.
4. Existing package React DOM session renderer and Cytoscape graph renderer.

Use deterministic initial rectangle placement derived from array order. The tab must fill its Dockview host and survive hide/show and close/reopen without a second canvas layered over the first.

## Lifecycle

- One rectangle model instance per open workspace id.
- Dockview mount creates or acquires that model.
- Input update for the same id replaces the projected rectangle content deterministically.
- Dockview unmount releases React and Cytoscape resources owned by the view.
- Restoring a persisted `rect:<id>` panel reconstructs its last input from the existing persisted plugin state or the established instance parameter mechanism.
- Do not invent a second global store.

## Tests and receipts

Add deterministic tests using existing repository conventions:

1. Vitest snapshot for projection from `RectangleWorkspaceInput` to package rectangles, including ids, positions, sizes, session content, and graph content.
2. Vitest snapshot for same-id update/dedup behavior at the pure state boundary if it can be tested without Dockview.
3. Playwright isolation receipt that mounts the real package component with one session rectangle and one Cytoscape graph rectangle, moves a rectangle, performs undo, and captures a PNG.
4. Playwright app-level receipt that invokes the exported opening seam in the existing test harness, proves the rectangle workspace is a Dockview tab beside an ordinary existing tab, then captures a PNG.

No `toBeDefined()` assertions. Prefer inline or file snapshots for structured state. Screenshots must contain visible identifying text for the session and graph and must not be blank.

## Gates

Run only safe verification processes:

```text
corepack pnpm@10.12.4 install
just check
just build
```

Run the exact new Vitest and Playwright specs. Do not run `just dev`. If Tauri/native state is required for app-level Playwright, use the repository's existing test fixture or `just dev-safe` only.

## Report

Write `FLASH_INSTANT_RECTANGLE_REPORT.md` containing:

- exact files changed
- exact exported signatures
- lifecycle timeline
- commands and exit codes
- test names and results
- PNG receipt paths
- source LOC added/removed
- any deviation from this brief
- the precise public API limitation encountered in `@hafley66/react-dock-and-flow@0.0.3`, if any

When complete or blocked, notify the coordinator only through bus:

```sh
bus hail --to 019fccda-48cc-74e0-b673-ba9eb28e065b --from instant-rectangle-flash4 --kind result --body "instant rectangle adapter complete; see FLASH_INSTANT_RECTANGLE_REPORT.md"
```

If blocked, replace the body with the blocking command, error, and required decision. Do not use tmux capture for communication.
