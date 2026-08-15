# @hafley66/md

A sectioned markdown viewer panel: parses a document into a heading tree
(`model.ts`), renders each section as its own Streamdown slice, supports
VSCode-style list/item folding, mermaid diagrams, in-doc navigation (`#frag`
links, relative `.md` links), and a lazy file-tree explorer rooted at the
document's folder.

Still lives inside the instant app tree (`src/mdview/`) but has no `../`
imports: every dependency on the host app goes through `ports.ts`. This is
staging for a future move to its own package directory; `package.json` here
declares the real shape that split would take.

## Host surface (`MdviewHost`, declared in `ports.ts`)

One interface, installed once via `installMdviewHost(host)` before any mdview
component or plugin runs. `getMdviewHost()` is the internal accessor every
mdview file uses instead of a `../` import; it throws a clear error if read
before install.

| Member | What it does |
| --- | --- |
| `readText(path)` | Read a UTF-8 file (native `read_text`). |
| `readImage(path)` | Read a local image as a data URL (native `read_image`). |
| `listDir(path)` | List a directory's entries (native `list_dir`). |
| `watchFile(path, onChange, recursive?)` | Claim a filesystem watch, debounced by the caller; returns a release function. |
| `FileTree` | The shared lazy TreeTable file explorer component the app owns (`src/plugins/files/1_FileTree.tsx`). |
| `registerZoomKind(kind)` | Register the `md:` panel prefix with the app's per-tab zoom registry. |
| `resetPanelZoom(pid)` | Reset a panel's zoom factor to 1. |
| `readPluginState(pluginId, fallback)` | Read this plugin's slice of persisted UI state. |
| `savePluginState(pluginId, patch)` | Patch and persist this plugin's UI state slice. |
| `useAppState()` | React hook returning `{ dark, panelZoom }`, the slice of the app's store MdPanel needs. |
| `openMdPanel(path, title)` | Open (or focus) the dock panel for a markdown path. |
| `mdPanelId(path)` | The dock panel id for a markdown path (used to steer an already-open panel). |
| `registerPlugin(plugin)` | Register the `md` plugin (routes, the `md:` panel instance, the fold-default config option) with the app's plugin registry. |

Small pure string/path helpers (`baseName`, `MD_EXTS`) are not part of the
host: they're vendored, byte-for-byte, into `local/core.ts` so the package
doesn't need a host for plain string formatting.

## Installing the host

`src/main.ts` calls `installMdviewHost(...)` with the real app
implementations (Tauri `invoke` wrappers, `claimFsWatch`, the `FileTree`
component, `panelZoom`/`pluginState`/`useStore` accessors, `reactdock`
functions) once, at startup, immediately before `registerMdview()`.
`registerMdview()` itself seeds the persisted UI signal (`loadPersistedMdUi`)
right after fetching the host, since that seeding used to run at module load
time and now has to wait for a host to exist.

## Still to do before publishing as a real package

- `model.ts`'s `mdast` type import is resolved today via the app's
  `@types/mdast` transitive install; a standalone package needs it as an
  explicit devDependency (already listed in `package.json` here, but nothing
  installs it standalone yet).
- `mdview.css` is imported with a bare relative path (`./mdview.css`) from
  `MdPanel.tsx`; that's package-internal and fine, but the app's global
  stylesheet still assumes it can also reach in and override `.mdview-*`
  classes; an actual split needs to decide whether that styling contract is
  part of the package's public surface or purely internal.
- No build step: `main`/`exports` point straight at `.ts`/`.tsx` sources, so
  the app's own Vite/tsc pipeline compiles this package in place. A real
  publish needs an actual build (tsup/vite library mode) producing `.js` +
  `.d.ts`.
- `MdviewHost` is one flat interface; if the package is ever consumed outside
  this app, the native-IO members (`readText`/`readImage`/`listDir`/
  `watchFile`) and the app-chrome members (`FileTree`/`registerPlugin`/
  `registerZoomKind`/...) are different enough in kind that splitting them
  into two smaller interfaces might be worth it. Not done here to keep this
  pass mechanical.
