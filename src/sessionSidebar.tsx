// Per-terminal right sidebar. A vertical stack of panes (react-resizable-panels)
// living in the same column: a file explorer reusing <TreeTable> (rooted at the
// session's live cwd) on top, and a "touched files" MRU list below it. Later
// panes — referenced files, agent turns with a scroll-spy that tracks live
// xterm/tmux output against the session ledger — stack into the same
// PanelGroup. All harness data flows through the generic HarnessAdapter, so no
// agent is hard-wired here. Pane sizes + the touched list persist per session.
import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { TreeTable, type TreeColumn } from "./treetable";
import { invoke } from "./generated/native";
import { store, type FsEntry, type DirListing } from "./state";
import { fileGlyph } from "./core";
import { openPreviewPanel } from "./preview";

type Entry = FsEntry;
type Sizes = [number, number];

// A patch the host (TerminalPanel) merges into store.termSidebar[sid].
type SidebarPatch = Partial<{ open: boolean; width: number; sizes: Sizes; touched: string[] }>;

// Explorer convention: folders before files, then alphabetical.
const dirsFirst = (a: Entry, b: Entry) =>
  a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1;

function childrenOf(path: string): Entry[] {
  return (store.get().fsChildren[path] ?? []).slice().sort(dirsFirst);
}

// Lazy readdir into the shared fsChildren cache (the worktrees tree uses the
// same cache, so listings are shared, not re-fetched).
async function loadDir(path: string): Promise<void> {
  if (store.get().fsChildren[path]) return;
  try {
    const listing = await invoke<DirListing>("list_dir", { path });
    store.set({ fsChildren: { ...store.get().fsChildren, [path]: listing.entries } });
  } catch (e) {
    console.error("list_dir:", e);
  }
}

// Build a minimal entry for a touched path (no listing round-trip): the glyph
// only needs name/ext/is_dir, and the touched list is flat, so size/modified
// are unused.
function touchedEntry(path: string): Entry {
  const name = path.split("/").pop() || path;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return { name, path, is_dir: false, size: 0, modified: 0, ext };
}

const FILES_COLS: TreeColumn<Entry>[] = [
  { id: "name", header: "Files", tree: true, cell: (e) => <>{fileGlyph(e)} {e.name}</> },
];
const TOUCHED_COLS: TreeColumn<Entry>[] = [
  { id: "name", header: "Touched", tree: true, cell: (e) => <>{fileGlyph(e)} {e.name}</> },
];

const MAX_TOUCHED = 50;

export function SessionSidebar(props: {
  sid: string;
  getCwd: () => string | null;
  width: number;
  sizes: Sizes;
  touched: string[];
  onWidth: (px: number) => void;
  onResizeEnd: () => void;
  onPatch: (p: SidebarPatch) => void;
}) {
  const { sid, getCwd, width, sizes, touched, onWidth, onResizeEnd, onPatch } = props;
  const [, bump] = useState(0);
  const [root, setRoot] = useState<string | null>(() => getCwd());

  // Re-render when the shared listing cache changes (our own loads + the
  // worktrees tree's loads both write here).
  useEffect(() => store.subscribe(() => bump((n) => n + 1), ["fsChildren"]), []);
  // Resolve the root cwd once the session reports one (tmux pane cwd may land
  // after the panel mounts), and load its listing.
  useEffect(() => {
    const cwd = getCwd();
    if (cwd && cwd !== root) setRoot(cwd);
    if (cwd) void loadDir(cwd);
  }, [root, getCwd]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => store.subscribe(() => {
      const c = getCwd();
      if (c && c !== root) setRoot(c);
    }, ["sessions"]),
    [root, getCwd], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // PanelGroup reports sizes continuously during a drag; persist only on drag
  // end so the store isn't hammered and the live drag never fights a re-render.
  const liveSizes = useRef<Sizes>(sizes);

  // Record a file as touched (MRU, deduped, capped). Opening from either pane
  // routes through here so the list reflects what this session actually opened.
  const touch = (path: string) => {
    const cur = store.get().termSidebar[sid]?.touched ?? [];
    onPatch({ touched: [path, ...cur.filter((p) => p !== path)].slice(0, MAX_TOUCHED) });
  };

  // Left-edge drag handle: resize the whole sidebar, clamped, persisted by the
  // caller. (The internal PanelGroup sash is separate — it only persists sizes,
  // no xterm refit, since the slot width is unchanged.)
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) =>
      onWidth(Math.max(160, Math.min(560, startW + (startX - ev.clientX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onResizeEnd(); // xterm slot width changed; refit on drag end
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const fileData = root ? childrenOf(root) : [];
  const touchedData = touched.map(touchedEntry);
  return (
    <aside className="term-sidebar" style={{ width }} data-sid={sid}>
      <div className="term-sidebar-resize" onPointerDown={startResize} title="drag to resize" />
      <div className="term-sidebar-body">
        {root ? (
          <PanelGroup
            key={sid}
            direction="vertical"
            className="term-sidebar-split"
            onLayout={(l) => {
              if (l.length === 2) liveSizes.current = [l[0], l[1]];
            }}
          >
            <Panel
              defaultSize={sizes[0]}
              minSize={20}
              className="term-sidebar-panel"
              data-testid="sidebar-files"
            >
              <TreeTable<Entry>
                columns={FILES_COLS}
                data={fileData}
                getRowId={(e) => e.path}
                getSubRows={(e) => (e.is_dir ? childrenOf(e.path) : undefined)}
                getRowCanExpand={(e) => e.is_dir}
                onToggleExpand={(e, will) => {
                  if (will && e.is_dir) void loadDir(e.path);
                }}
                onRowDoubleClick={(e) => {
                  if (!e.is_dir) {
                    openPreviewPanel(e.path);
                    touch(e.path);
                  }
                }}
                toggleOnDoubleClick={(e) => e.is_dir}
                controls
                filter={(e, q) => e.name.toLowerCase().includes(q.toLowerCase())}
                searchPlaceholder="filter files…"
              />
            </Panel>
            <PanelResizeHandle className="term-sidebar-sash" />
            <Panel
              defaultSize={sizes[1]}
              minSize={12}
              className="term-sidebar-panel"
              data-testid="sidebar-touched"
            >
              {touchedData.length ? (
                <TreeTable<Entry>
                  columns={TOUCHED_COLS}
                  data={touchedData}
                  getRowId={(e) => e.path}
                  onRowDoubleClick={(e) => openPreviewPanel(e.path)}
                />
              ) : (
                <div className="term-sidebar-empty term-sidebar-empty-touched">
                  open a file to track it here
                </div>
              )}
            </Panel>
          </PanelGroup>
        ) : (
          <div className="term-sidebar-empty">waiting for session cwd…</div>
        )}
      </div>
    </aside>
  );
}
