// Per-terminal right sidebar. One reusable <TreeTable> (the same "fs grid" the
// file explorer and every other panel use) drives every view; a toggle picks
// the top pane's source. The bottom pane is always the session's Touched files
// — the files referenced by the session transcript (Edit/Write/Read file_path,
// extracted from the tool_use calls serialized into the turn text and unioned
// across turns), NOT files you manually opened. Top + Touched split via
// react-resizable-panels with persisted sizes.
//
// Sources: Files (the live-cwd filesystem tree) | Turns (the session's AI
// transcript: session -> turn -> that turn's referenced files, default-sorted
// newest-first, with a per-turn favorite star). All harness data flows through
// the generic HarnessAdapter. Source + sizes persist per session.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { TreeTable, type TreeColumn } from "./treetable";
import { invoke } from "./generated/native";
import { store, type FsEntry, type DirListing, type AiMessage } from "./state";
import { fileGlyph, baseName } from "./core";
import { openPreviewPanel } from "./preview";
import {
  warmTurns,
  tabTurns,
  turnCwd,
  isTurnFav,
  favoriteTurn,
  unfavoriteTurn,
  openTurn,
} from "./favorites";
import type { HarnessId } from "./harness";

type Entry = FsEntry;
type Sizes = [number, number];
type Source = "files" | "turns";

// A patch the host (TerminalPanel) merges into store.termSidebar[sid].
type SidebarPatch = Partial<{
  open: boolean;
  width: number;
  source: Source;
  sizes: Sizes;
}>;

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

// --- Session file references (Touched + per-turn children share this). ---

// tool_use input is serialized into the turn text (ledger.rs), so a tool's
// file_path is recoverable as JSON — structured, not a free-text guess.
const FILE_PATH_RE = /"file_path"\s*:\s*"([^"]+)"/g;
function turnFiles(t: AiMessage): string[] {
  const out: string[] = [];
  for (const m of t.text.matchAll(FILE_PATH_RE)) {
    const p = m[1];
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
// Resolve a referenced path against the session cwd: claude tool paths are
// usually absolute, but tolerate relative ones by joining the ledger cwd.
function resolveFile(raw: string, cwd: string): string {
  if (raw.startsWith("~")) return raw;
  if (raw.startsWith("/")) return raw;
  return (cwd.replace(/\/$/, "") + "/" + raw).replace(/\/+/g, "/");
}
function fileEntry(raw: string, cwd: string): Entry {
  const path = resolveFile(raw, cwd);
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

// --- Transcript tree (session -> turn -> referenced files). ---

type TurnNode =
  | { kind: "session"; path: string; editor: HarnessId; sessionId: string; label: string; turns: AiMessage[] }
  | { kind: "turn"; path: string; turn: AiMessage; files: Entry[] }
  | { kind: "file"; path: string; entry: Entry };

// Newest turn first within a session (default desc). Sessions keep arrival order
// (the resolver returns newest-first already).
function turnNodes(turns: AiMessage[]): TurnNode[] {
  const groups = new Map<string, AiMessage[]>();
  for (const t of turns) {
    const k = `${t.editor}:${t.session_id}`;
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  const nodes: TurnNode[] = [];
  for (const [k, list] of groups) {
    list.sort((a, b) => b.seq - a.seq);
    const head = list[list.length - 1]; // oldest carries the session id/cwd key
    const cwd = turnCwd.get(k) ?? "";
    nodes.push({
      kind: "session",
      path: `sess:${k}`,
      editor: head.editor,
      sessionId: head.session_id,
      // label by the folder the ledger actually lives in (turnCwd), not the
      // live pane cwd, which may be a subdir the session wasn't keyed under.
      label: cwd ? baseName(cwd) : head.session_id.slice(0, 8),
      turns: list,
    });
  }
  return nodes;
}

// A turn's file children, resolved against its session cwd.
function turnFileChildren(turn: AiMessage): Entry[] {
  const cwd = turnCwd.get(`${turn.editor}:${turn.session_id}`) ?? "";
  return turnFiles(turn).map((raw) => fileEntry(raw, cwd));
}

// Favorite toggle for a turn row. cwd comes from turnCwd (where the session's
// ledger lives) so a favorite resumes in the right folder.
async function toggleTurnFav(t: AiMessage) {
  const cwd = turnCwd.get(`${t.editor}:${t.session_id}`) ?? "";
  if (isTurnFav(t)) await unfavoriteTurn(t);
  else await favoriteTurn(t, cwd);
}

const TURN_COLS: TreeColumn<TurnNode>[] = [
  {
    id: "turn",
    header: "Turns",
    tree: true,
    // sortValue = recency: a session by its newest turn, a turn by its seq, a
    // file by 0 (stable under its parent). defaultSorting below sets desc.
    sortValue: (n) =>
      n.kind === "turn" ? n.turn.seq : n.kind === "session" ? Math.max(...n.turns.map((t) => t.seq)) : 0,
    cell: (n) => {
      if (n.kind === "session") return <span className="turn-sess">{n.label}</span>;
      if (n.kind === "file") return <>{fileGlyph(n.entry)} {n.entry.name}</>;
      // turn: compact star (left) + role + preview, all inline spans — matches
      // the favorites row layout, not a padded <button>.
      const on = isTurnFav(n.turn);
      return (
        <>
          <span
            className="turn-star"
            data-on={on}
            data-no-row-click=""
            title="favorite turn"
            onClick={(e) => {
              e.stopPropagation();
              void toggleTurnFav(n.turn);
            }}
          >
            {on ? "★" : "☆"}
          </span>
          <span className="turn-role" data-role={n.turn.role}>{n.turn.role}</span>
          <span className="turn-preview">{n.turn.preview}</span>
        </>
      );
    },
  },
];

export function SessionSidebar(props: {
  sid: string;
  getCwd: () => string | null;
  width: number;
  sizes: Sizes;
  source: Source;
  onWidth: (px: number) => void;
  onResizeEnd: () => void;
  onPatch: (p: SidebarPatch) => void;
}) {
  const { sid, getCwd, width, sizes, source, onWidth, onResizeEnd, onPatch } = props;
  const [, bump] = useState(0);
  const [root, setRoot] = useState<string | null>(() => getCwd());
  const [turns, setTurns] = useState<AiMessage[]>([]);

  // Re-render when shared listings or favorites change. Star state lives in
  // store.aiFavs; the turn rows re-read isTurnFav on each render.
  useEffect(() => store.subscribe(() => bump((n) => n + 1), ["fsChildren", "aiFavs"]), []);
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

  // Load (or refresh) this tab's turns through the shared ledger plumbing. Warms
  // on mount/refresh (not gated on the source) because the Touched pane — always
  // visible — is derived from the same turns.
  const loadTurns = useCallback(() => {
    let alive = true;
    warmTurns(sid)
      .then(() => {
        if (alive) setTurns(tabTurns.get(sid) ?? []);
      })
      .catch((e: unknown) => console.error("warmTurns:", e));
    return () => {
      alive = false;
    };
  }, [sid]);
  useEffect(() => loadTurns(), [loadTurns]);

  // Touched = the files the session's transcript references, unioned across
  // turns (deduped by resolved path). Not what the user manually opened.
  const touchedFiles = useMemo(() => {
    const seen = new Set<string>();
    const out: Entry[] = [];
    for (const t of turns) {
      const cwd = turnCwd.get(`${t.editor}:${t.session_id}`) ?? "";
      for (const raw of turnFiles(t)) {
        const e = fileEntry(raw, cwd);
        if (!seen.has(e.path)) {
          seen.add(e.path);
          out.push(e);
        }
      }
    }
    return out;
  }, [turns]);

  // PanelGroup reports sizes continuously during a drag; persist only on drag
  // end so the store isn't hammered and the live drag never fights a re-render.
  const liveSizes = useRef<Sizes>(sizes);

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
  const turnData = turnNodes(turns);
  return (
    <aside className="term-sidebar" style={{ width }} data-sid={sid}>
      <div className="term-sidebar-resize" onPointerDown={startResize} title="drag to resize" />
      <div className="term-sidebar-tabs">
        <button
          className="term-sidebar-tab"
          data-active={source === "files"}
          onClick={() => onPatch({ source: "files" })}
        >
          Files
        </button>
        <button
          className="term-sidebar-tab"
          data-active={source === "turns"}
          onClick={() => onPatch({ source: "turns" })}
        >
          Turns
        </button>
      </div>
      <div className="term-sidebar-body">
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
            data-testid={source === "turns" ? "sidebar-turns" : "sidebar-files"}
          >
            {source === "turns" ? (
              turnData.length ? (
                <TreeTable<TurnNode>
                  key="turns"
                  columns={TURN_COLS}
                  data={turnData}
                  virtual
                  defaultExpandedAll
                  getRowId={(n) => n.path}
                  getSubRows={(n) => {
                    if (n.kind === "session") {
                      return n.turns.map((t) => ({
                        kind: "turn" as const,
                        path: `turn:${t.editor}:${t.session_id}:${t.id}`,
                        turn: t,
                        files: turnFileChildren(t),
                      }));
                    }
                    if (n.kind === "turn") {
                      return n.files.map((f, i) => ({
                        kind: "file" as const,
                        path: `file:${n.path}:${i}:${f.path}`,
                        entry: f,
                      }));
                    }
                    return undefined;
                  }}
                  getRowCanExpand={(n) =>
                    n.kind === "session" ? true : n.kind === "turn" ? n.files.length > 0 : false
                  }
                  toggleOnDoubleClick={(n) => n.kind === "session"}
                  onRowDoubleClick={(n) => {
                    if (n.kind === "turn") openTurn(n.turn);
                    else if (n.kind === "file") openPreviewPanel(n.entry.path);
                  }}
                  controls
                  filter={(n, q) => {
                    const hay =
                      n.kind === "turn"
                        ? `${n.turn.role} ${n.turn.preview}`
                        : n.kind === "file"
                          ? n.entry.name
                          : n.label;
                    return hay.toLowerCase().includes(q.toLowerCase());
                  }}
                  searchPlaceholder="filter turns…"
                />
              ) : (
                <div className="term-sidebar-empty">no AI session for this folder</div>
              )
            ) : root ? (
              <TreeTable<Entry>
                key="files"
                columns={FILES_COLS}
                data={fileData}
                getRowId={(e) => e.path}
                getSubRows={(e) => (e.is_dir ? childrenOf(e.path) : undefined)}
                getRowCanExpand={(e) => e.is_dir}
                onToggleExpand={(e, will) => {
                  if (will && e.is_dir) void loadDir(e.path);
                }}
                onRowDoubleClick={(e) => {
                  if (!e.is_dir) openPreviewPanel(e.path);
                }}
                toggleOnDoubleClick={(e) => e.is_dir}
                controls
                filter={(e, q) => e.name.toLowerCase().includes(q.toLowerCase())}
                searchPlaceholder="filter files…"
              />
            ) : (
              <div className="term-sidebar-empty">waiting for session cwd…</div>
            )}
          </Panel>
          <PanelResizeHandle className="term-sidebar-sash" onDragging={(d) => { if (!d) onPatch({ sizes: liveSizes.current }); }} />
          <Panel
            defaultSize={sizes[1]}
            minSize={12}
            className="term-sidebar-panel"
            data-testid="sidebar-touched"
          >
            {touchedFiles.length ? (
              <TreeTable<Entry>
                columns={TOUCHED_COLS}
                data={touchedFiles}
                getRowId={(e) => e.path}
                onRowDoubleClick={(e) => openPreviewPanel(e.path)}
              />
            ) : (
              <div className="term-sidebar-empty term-sidebar-empty-touched">
                no files referenced yet
              </div>
            )}
          </Panel>
        </PanelGroup>
      </div>
    </aside>
  );
}
