# instant activity (VS Code extension)

Reports active-editor context to the `instant` app's unified activity store,
mirroring `extension/` (the Chrome extension) for the browser side. Sends
only paths, line numbers, language ids, and workspace (folder) names — never
file contents, selection text, or buffers.

## Events

POSTed as fire-and-forget JSON to `http://127.0.0.1:8787/ingest` (configurable
via `instantActivity.endpoint`). Errors (app not running, endpoint down) are
swallowed — this never surfaces a user-facing error.

- **focus** — `window.onDidChangeActiveTextEditor`:
  `{type:"editor", event:"focus", path, languageId, workspace, ts}`
- **cursor** — `window.onDidChangeTextEditorSelection`, throttled to at most
  once per second: `{type:"editor", event:"cursor", path, line, ts}`
- **save** — `workspace.onDidSaveTextDocument`:
  `{type:"editor", event:"save", path, ts}`

`workspace` is the containing workspace folder's name. `path` is the file's
absolute filesystem path. `line` is 1-based.

## Build

```sh
just vscode-build
```

Runs `npm install` + `tsc` in this directory, emitting `out/extension.js`.
No bundler — plain `tsc` compiles `src/extension.ts` straight to `out/`.

## Install (dev)

```sh
just vscode-install
```

Packages the extension with `npx @vscode/vsce package` (works for local
packaging without a publisher account — the marketplace publisher id in
`package.json` is a placeholder) and installs the resulting `.vsix` with
`code --install-extension`. Reload VS Code / the extension host afterward.

### Alternative: symlink into VS Code's extensions dir

If `vsce`/`code` aren't available, symlink this folder directly so VS Code
picks it up as an unpacked extension:

```sh
ln -s "$(pwd)/vscode-ext" ~/.vscode/extensions/instant-activity-dev
```

Requires `out/` to already exist (`just vscode-build` first); restart VS Code
or run "Developer: Reload Window" to pick up changes.

## Requirements

`engines.vscode` is `>=1.82.0`, which ships a Node runtime with a global
`fetch` — no runtime dependencies needed. `@types/vscode` + `typescript` are
the only devDependencies.

## Test the endpoint without VS Code

```sh
curl -s -XPOST http://127.0.0.1:8787/ingest \
  -H 'content-type: application/json' \
  -d '{"type":"editor","event":"save","path":"/tmp/example.ts","ts":0}'
```
