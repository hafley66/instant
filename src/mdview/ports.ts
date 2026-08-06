// The seam between src/mdview and the rest of the app. Every non-local,
// non-third-party value the package's files touch is declared here as a
// member of MdviewHost and reached through getMdviewHost() instead of a
// `../` import. The host app installs one implementation at boot
// (installMdviewHost, called from src/main.ts); a fresh page that forgets to
// install one gets a clear throw instead of a silent undefined.
import type { ComponentType } from "react";
import type { IDockviewPanelProps } from "dockview";

// Mirrors src/state.ts's FsEntry (a Rust fs::Entry) structurally, so a real
// FsEntry value satisfies this without a cast at the call site.
export interface MdviewFsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number; // unix ms
  ext: string;
}

// Props the file explorer component must accept. Mirrors the subset of
// src/plugins/files/1_FileTree.tsx's FileTreeProps that MdExplorer passes;
// listCommand is narrowed to the one command mdview ever requests so a real
// FileTree (typed against the app's broader CommandName union) still
// satisfies this interface.
export interface MdviewFileTreeProps {
  rootPath: string;
  rootEntries: MdviewFsEntry[];
  activePath?: string;
  filterExts?: ReadonlySet<string>;
  listCommand: "list_dir";
  onSelect: (path: string) => void;
  searchPlaceholder?: string;
}

// Mirrors the slice of src/plugin.tsx's ConfigOption used by the fold-default
// toggle registered in index.ts.
export interface MdviewConfigOption {
  id: string;
  label: string;
  hint?: string;
  get: () => boolean;
  set: (on: boolean) => void;
}

// Mirrors the slice of src/plugin.tsx's PanelInstanceDef/PluginRoute used by
// registerMdview(). `panels` is always empty for this plugin (no rail
// button), typed as `never[]` so it satisfies the app's real PanelDef[].
export interface MdviewPluginRegistration {
  id: string;
  panels: never[];
  options?: MdviewConfigOption[];
  instances?: {
    id: string;
    prefix: string;
    componentName: string;
    component: ComponentType<IDockviewPanelProps>;
    // The host keeps a tab of this kind across a reload when set: the panel
    // rebuilds itself from its params, which for mdview is the document path.
    restorable?: boolean;
  }[];
  routes?: { id: string; open: (path: string) => boolean }[];
}

// Mirrors src/panelZoom.ts's ZoomKind, minus the onZoom hook (mdview's zoom
// is declarative: MdPanel reads the stored factor and applies a CSS zoom).
export interface MdviewZoomKind {
  prefix: string;
  min: number;
  max: number;
  step: number;
}

// The slice of the app's observable store MdPanel reads: dark mode (for
// syntax theming) and the per-panel zoom factor map (src/panelZoom.ts).
export interface MdviewAppState {
  dark: boolean;
  panelZoom: Record<string, number>;
}

export interface MdviewHost {
  // ---- native IO (src/generated/native.ts's invoke) ----
  readText(path: string): Promise<string>;
  readImage(path: string): Promise<string>;
  listDir(path: string): Promise<{ entries: MdviewFsEntry[] }>;
  openHref(href: string, sourcePath: string): Promise<void>;

  // ---- file watching (src/fsWatch.ts's claimFsWatch) ----
  watchFile(path: string, onChange: () => void, recursive?: boolean): Promise<() => void>;

  // ---- shared file explorer (src/plugins/files/1_FileTree.tsx) ----
  FileTree: ComponentType<MdviewFileTreeProps>;

  // ---- per-tab zoom (src/panelZoom.ts) ----
  registerZoomKind(kind: MdviewZoomKind): void;
  resetPanelZoom(pid: string): void;

  // ---- persisted UI state (src/pluginState.ts) ----
  readPluginState<T>(pluginId: string, fallback: T): T;
  savePluginState<T extends object>(pluginId: string, patch: Partial<T>): void;

  // ---- store subscription (src/useStore.ts / src/state.ts) ----
  useAppState(): MdviewAppState;

  // ---- dock panel open/retitle (src/reactdock.tsx) ----
  openMdPanel(path: string, title: string): void;
  mdPanelId(path: string): string;

  // ---- plugin registration (src/plugin.tsx) ----
  registerPlugin(plugin: MdviewPluginRegistration): void;
}

// The toolbar's "↗ external" button opens the current document through the
// peer opener. Rendered links use openHref so the host can route URLs, local
// files, and file:line references through its existing document router.

let host: MdviewHost | null = null;

export function installMdviewHost(impl: MdviewHost): void {
  host = impl;
}

export function getMdviewHost(): MdviewHost {
  if (!host) {
    throw new Error(
      "mdview: no host installed, call installMdviewHost() before mounting any mdview component or plugin",
    );
  }
  return host;
}
