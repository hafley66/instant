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
import { createPortal } from "react-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { ExpandedState } from "@tanstack/react-table";
import { TreeTable, type TreeColumn } from "./treetable";
import { invoke } from "./generated/native";
import { store, type FsEntry, type DirListing, type AiMessage, type TermSidebarView } from "./state";
import { fileGlyph } from "./core";
import { openPreviewPanel } from "./preview";
import { openMarkdownPanel } from "./mdview/open";
import { parseMdSections, type MdSection } from "./mdview/model";
import { fileEntry, isCompaction, isMarkdown, isToolOnlyTurn, touchedFiles, turnOrder, turnPrimaryPreview, turnReferences, turnRoleLabel, visibleTurnWindows, type TouchedFile } from "./0_sessionSidebarModel";
import {
  warmTurns,
  refreshTurns,
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
type Placement = "right" | "bottom";

// A patch the host (TerminalPanel) merges into store.termSidebar[sid].
type SidebarPatch = Partial<{
  open: boolean;
  width: number;
  source: Source;
  sizes: Sizes;
  placement: Placement;
  views?: Partial<Record<"files" | "turns" | "touched", TermSidebarView>>;
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

const FILES_COLS: TreeColumn<Entry>[] = [
  { id: "name", header: "Files", tree: true, cell: (e) => <>{fileGlyph(e)} {e.name}</> },
];
const TOUCHED_COLS: TreeColumn<TouchedNode>[] = [
  {
    id: "file", header: "Touched", tree: true, size: 140, minSize: 108, sortValue: (n) => n.kind === "file" ? n.file.entry.name : n.kind === "turn" ? n.reference.turn.preview : n.heading.title,
    cell: (n) => n.kind === "file" ? <span className="sidebar-file"><span>{fileGlyph(n.file.entry)} {n.file.entry.name}</span><small>{n.file.displayPath}</small></span>
      : n.kind === "heading" ? <span className="sidebar-heading"># {n.heading.title}</span>
        : <span className="sidebar-turn-ref"><span>{n.reference.turn.role}</span> {n.reference.turn.preview}</span>,
  },
  { id: "touches", header: "Uses", size: 36, minSize: 32, sortValue: (n) => n.kind === "file" ? n.file.touchCount : n.kind === "turn" ? n.reference.turn.seq : 0, cell: (n) => n.kind === "file" ? String(n.file.touchCount) : n.kind === "turn" ? n.reference.action : "" },
  { id: "first", header: "First", size: 58, minSize: 50, sortValue: (n) => n.kind === "file" ? n.file.firstTouchedAt : n.kind === "turn" ? n.reference.turn.ts : 0, cell: (n) => n.kind === "file" ? formatWhen(n.file.firstTouchedAt) : n.kind === "turn" ? formatTurnTime(n.reference.turn.ts || n.reference.turn.seq) : "" },
  { id: "last", header: "Last", size: 58, minSize: 50, sortValue: (n) => n.kind === "file" ? n.file.lastTouchedAt : 0, cell: (n) => n.kind === "file" ? formatWhen(n.file.lastTouchedAt) : n.kind === "turn" ? n.reference.turn.role : "" },
  { id: "read", header: "Read", size: 58, minSize: 50, sortValue: (n) => n.kind === "file" ? n.file.lastReadAt : 0, cell: (n) => n.kind === "file" ? formatWhen(n.file.lastReadAt) : n.kind === "turn" ? String(turnReferences(n.reference.turn, turnCwd.get(`${n.reference.turn.editor}:${n.reference.turn.session_id}`) ?? "").length) : "" },
  { id: "by", header: "By", size: 50, minSize: 44, sortValue: (n) => n.kind === "file" ? latestReference(n.file)?.turn.seq ?? 0 : 0, cell: (n) => n.kind === "file" ? `${latestReference(n.file)?.turn.role ?? ""} #${latestReference(n.file)?.turn.seq ?? ""}` : n.kind === "turn" ? `#${n.reference.turn.seq}` : "" },
];

// --- Transcript tree (session -> turn -> referenced files). ---

type TurnNode =
  | { kind: "session"; path: string; editor: HarnessId; sessionId: string; cwd: string; current: boolean; label: string; turns: AiMessage[] }
  | { kind: "turn"; path: string; turn: AiMessage; files: Entry[]; tools: AiMessage[]; compactionStart?: number }
  | { kind: "files"; path: string; entries: Entry[] }
  | { kind: "tools"; path: string; tools: AiMessage[] }
  | { kind: "tool"; path: string; turn: AiMessage; files: Entry[] }
  | { kind: "file"; path: string; entry: Entry }
  | { kind: "heading"; path: string; entry: Entry; heading: MdSection };

type TouchedNode =
  | { kind: "file"; path: string; file: TouchedFile; headings: MdSection[] }
  | { kind: "heading"; path: string; file: TouchedFile; heading: MdSection }
  | { kind: "turn"; path: string; reference: TouchedFile["references"][number] };

function formatWhen(value: number): string {
  return formatRelativeTime(value);
}

function formatTurnTime(value: number): string {
  return formatRelativeTime(value);
}

function formatRelativeTime(value: number): string {
  if (!value) return "—";
  if (value < 10_000_000_000) return `#${value}`;
  const elapsed = Math.floor((Date.now() - value) / 1000);
  if (elapsed >= 0 && elapsed < 60) return `${elapsed}s`;
  if (elapsed >= 60 && elapsed < 3_600) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed >= 3_600 && elapsed < 86_400) return `${Math.floor(elapsed / 3_600)}h`;
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function latestReference(file: TouchedFile) {
  return file.references[file.references.length - 1];
}

function flatHeadings(headings: MdSection[]): MdSection[] {
  return headings.flatMap((heading) => [heading, ...flatHeadings(heading.children)]);
}

// Newest turn first within a session (default desc). Sessions keep arrival order
// (the resolver returns newest-first already).
function turnNodes(turns: AiMessage[], currentCwd: string | null): TurnNode[] {
  const groups = new Map<string, AiMessage[]>();
  for (const t of turns) {
    const k = `${t.editor}:${t.session_id}`;
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  const nodes: Extract<TurnNode, { kind: "session" }>[] = [];
  for (const [k, list] of groups) {
    list.sort((a, b) => turnOrder(b) - turnOrder(a));
    const head = list[list.length - 1]; // oldest carries the session id/cwd key
    const cwd = turnCwd.get(k) ?? "";
    nodes.push({
      kind: "session",
      path: `sess:${k}`,
      editor: head.editor,
      sessionId: head.session_id,
      // label by the folder the ledger actually lives in (turnCwd), not the
      // live pane cwd, which may be a subdir the session wasn't keyed under.
      cwd,
      current: cwd === currentCwd,
      label: cwd === currentCwd ? `current · ${head.editor} · ${head.session_id.slice(0, 8)}` : `${head.editor} · ${head.session_id.slice(0, 8)}`,
      turns: list,
    });
  }
  nodes.sort((a, b) => Math.max(...b.turns.map(turnOrder)) - Math.max(...a.turns.map(turnOrder)));
  // A terminal's live cwd is the default scope. Fallback ledgers remain only
  // when no session resolved for that cwd, avoiding identical basename groups.
  const current = nodes.filter((node) => node.current);
  return current.length ? current.slice(0, 1) : nodes.slice(0, 1);
}

// A turn's file children, resolved against its session cwd.
function turnFileChildren(turn: AiMessage): Entry[] {
  const cwd = turnCwd.get(`${turn.editor}:${turn.session_id}`) ?? "";
  return turnReferences(turn, cwd).map((ref) => fileEntry(ref.path));
}

function windowFileChildren(turn: AiMessage, tools: AiMessage[]): Entry[] {
  const cwd = turnCwd.get(`${turn.editor}:${turn.session_id}`) ?? "";
  const paths = new Set<string>();
  for (const message of [turn, ...tools]) {
    for (const reference of turnReferences(message, cwd)) paths.add(reference.path);
  }
  return [...paths].map(fileEntry);
}

function compactionStart(turns: AiMessage[], turn: AiMessage): number | undefined {
  if (!isCompaction(turn)) return undefined;
  const older = turns.filter((candidate) => candidate.seq < turn.seq && !isCompaction(candidate));
  return older.length ? older.reduce((latest, candidate) => candidate.seq > latest.seq ? candidate : latest).ts : turn.ts;
}

// Favorite toggle for a turn row. cwd comes from turnCwd (where the session's
// ledger lives) so a favorite resumes in the right folder.
async function toggleTurnFav(t: AiMessage) {
  const cwd = turnCwd.get(`${t.editor}:${t.session_id}`) ?? "";
  if (isTurnFav(t)) await unfavoriteTurn(t);
  else await favoriteTurn(t, cwd);
}

function turnCols(showPreview: (text: string, rect: DOMRect) => void, hidePreview: () => void): TreeColumn<TurnNode>[] {
  return [
  {
    id: "text",
    header: "Turn",
    tree: true,
    // sortValue = recency: a session by its newest turn, a turn by its seq, a
    // file by 0 (stable under its parent). defaultSorting below sets desc.
    size: 240, minSize: 150,
    sortValue: (n) => n.kind === "turn" || n.kind === "tool" ? turnOrder(n.turn) : n.kind === "session" ? Math.max(...n.turns.map(turnOrder)) : 0,
    cell: (n) => {
      if (n.kind === "session") return <span className="turn-sess"><span>{n.label}</span><small>{n.cwd}</small></span>;
      if (n.kind === "files") return <span className="sidebar-turn-aggregate">Files <small>{n.entries.length}</small></span>;
      if (n.kind === "tools") return <span className="sidebar-turn-aggregate">Tools <small>{n.tools.length}</small></span>;
      if (n.kind === "file") return <>{fileGlyph(n.entry)} {n.entry.name}</>;
      if (n.kind === "heading") return <span className="sidebar-heading"># {n.heading.title}</span>;
      if (n.kind === "tool") return <span className="turn-copy"><span className="turn-preview">{turnPrimaryPreview(n.turn)}</span><small>{turnRoleLabel(n.turn)}</small></span>;
      const on = isTurnFav(n.turn);
      return (
        <span className="turn-row">
          <span className="turn-copy" onPointerEnter={(e) => showPreview(n.turn.text, e.currentTarget.getBoundingClientRect())} onPointerLeave={hidePreview}><span className="turn-preview">{isCompaction(n.turn) ? "↯ compaction  " : ""}{turnPrimaryPreview(n.turn)}</span><small>{turnRoleLabel(n.turn)}</small></span>
          <button
            className="turn-action"
            data-no-row-click=""
            title="open turn in new tab"
            onClick={(e) => { e.stopPropagation(); openTurn(n.turn); }}
          >↗</button>
          <button
            className="turn-action turn-star"
            data-on={on}
            data-no-row-click=""
            title="favorite turn"
            onClick={(e) => {
              e.stopPropagation();
              void toggleTurnFav(n.turn);
            }}
          >{on ? "★" : "☆"}</button>
        </span>
      );
    },
  },
  { id: "time", header: "Time", size: 126, minSize: 90, sortValue: (n) => n.kind === "turn" || n.kind === "tool" ? turnOrder(n.turn) : n.kind === "session" ? Math.max(...n.turns.map(turnOrder)) : 0, cell: (n) => n.kind === "turn" ? isCompaction(n.turn) ? <span className="turn-boundary-time"><small>start {formatTurnTime(n.compactionStart ?? turnOrder(n.turn))}</small><small>last {formatTurnTime(turnOrder(n.turn))}</small></span> : formatTurnTime(turnOrder(n.turn)) : n.kind === "tool" ? formatTurnTime(turnOrder(n.turn)) : n.kind === "session" ? formatTurnTime(Math.max(...n.turns.map(turnOrder))) : "" },
  { id: "files", header: "Files", size: 42, minSize: 36, sortValue: (n) => n.kind === "turn" || n.kind === "tool" ? n.files.length : 0, cell: (n) => n.kind === "turn" || n.kind === "tool" ? String(n.files.length) : "" },
  ];
}

export function SessionSidebar(props: {
  sid: string;
  getCwd: () => string | null;
  width: number;
  sizes: Sizes;
  source: Source;
  placement: Placement;
  views?: Partial<Record<"files" | "turns" | "touched", TermSidebarView>>;
  onWidth: (px: number) => void;
  onResizeEnd: () => void;
  onPatch: (p: SidebarPatch) => void;
}) {
  const { sid, getCwd, width, sizes, source, placement, views, onWidth, onResizeEnd, onPatch } = props;
  const [, bump] = useState(0);
  const [root, setRoot] = useState<string | null>(() => getCwd());
  const [turns, setTurns] = useState<AiMessage[]>([]);
  const [cass, setCass] = useState<{ available: boolean; path: string | null } | null>(null);
  const [cassCopied, setCassCopied] = useState(false);
  const [headings, setHeadings] = useState<Record<string, MdSection[]>>({});
  const [turnFilter, setTurnFilter] = useState<"all" | "visible" | "user" | "tools">("visible");
  const [turnPreview, setTurnPreview] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [turnExpanded, setTurnExpanded] = useState<ExpandedState>({});
  const turnColumns = useMemo(
    () => turnCols((text, rect) => setTurnPreview({ text, rect }), () => setTurnPreview(null)),
    [],
  );
  const previewStyle = turnPreview ? {
    left: Math.max(8, Math.min(turnPreview.rect.left, window.innerWidth - Math.min(520, window.innerWidth - 16))),
    top: turnPreview.rect.bottom + 4 > window.innerHeight - 188 ? Math.max(8, turnPreview.rect.top - 188) : turnPreview.rect.bottom + 4,
  } : undefined;

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
  useEffect(() => {
    let alive = true;
    void invoke<{ available: boolean; path: string | null }>("cass_status")
      .then((status) => { if (alive) setCass(status); })
      .catch(() => { if (alive) setCass({ available: false, path: null }); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshTurns(sid).then(() => setTurns(tabTurns.get(sid) ?? [])).catch((e: unknown) => console.error("refreshTurns:", e));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [sid]);

  const touched = useMemo(
    () => touchedFiles(turns, (turn) => turnCwd.get(`${turn.editor}:${turn.session_id}`) ?? ""),
    [turns],
  );
  const touchedData = useMemo<TouchedNode[]>(
    () => touched.map((file) => ({ kind: "file", path: `touched:${file.entry.path}`, file, headings: headings[file.entry.path] ?? [] })),
    [touched, headings],
  );
  const loadHeadings = (entry: Entry) => {
    if (!isMarkdown(entry) || headings[entry.path]) return;
    void invoke<string>("read_text", { path: entry.path })
      .then((text) => setHeadings((prev) => ({ ...prev, [entry.path]: parseMdSections(text).tree })))
      .catch(() => setHeadings((prev) => ({ ...prev, [entry.path]: [] })));
  };
  const patchView = (view: "files" | "turns" | "touched", patch: Partial<TermSidebarView>) =>
    onPatch({ views: { ...views, [view]: { ...views?.[view], ...patch } } });
  const resetView = (view: "files" | "turns" | "touched") =>
    patchView(view, { sorting: view === "turns" ? [{ id: "text", desc: true }] : view === "touched" ? [{ id: "last", desc: true }] : [], columnSizing: {}, query: "" });

  // PanelGroup reports sizes continuously during a drag; persist only on drag
  // end so the store isn't hammered and the live drag never fights a re-render.
  const liveSizes = useRef<Sizes>(sizes);

  // Left-edge drag handle: resize the whole sidebar, clamped, persisted by the
  // caller. (The internal PanelGroup sash is separate — it only persists sizes,
  // no xterm refit, since the slot width is unchanged.)
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = placement === "right" ? e.clientX : e.clientY;
    const startW = width;
    const move = (ev: PointerEvent) =>
      onWidth(Math.max(160, Math.min(560, startW + (start - (placement === "right" ? ev.clientX : ev.clientY)))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onResizeEnd(); // xterm slot width changed; refit on drag end
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const fileData = root ? childrenOf(root) : [];
  const turnData = turnNodes(turns, getCwd());
  const sessionData = turnData.filter((node): node is Extract<TurnNode, { kind: "session" }> => node.kind === "session");
  const activeTurn = (sessionData[0]?.turns ?? []).filter((turn) => !isCompaction(turn) && !isToolOnlyTurn(turn)).reduce<AiMessage | null>((latest, turn) => !latest || turnOrder(turn) > turnOrder(latest) ? turn : latest, null);
  const sessionPath = sessionData[0]?.path;
  useEffect(() => {
    if (sessionPath) setTurnExpanded((current) => current === true || current[sessionPath] ? current : { ...current, [sessionPath]: true });
  }, [sessionPath]);
  const isTurnExpanded = (path: string) => turnExpanded === true || Boolean(turnExpanded[path]);
  return (<>
    <aside className="term-sidebar" data-placement={placement} style={placement === "right" ? { width } : { height: width }} data-sid={sid}>
      <div className="term-sidebar-resize" onPointerDown={startResize} title="drag to resize" />
      <div className="term-sidebar-tabs">
        <button
          className="term-sidebar-tab"
          data-active={source === "turns"}
          onClick={() => onPatch({ source: "turns" })}
        >
          Turns
        </button>
        <button className="term-sidebar-tab term-sidebar-place" title={placement === "right" ? "move to bottom" : "move to right"} onClick={() => onPatch({ placement: placement === "right" ? "bottom" : "right" })}>{placement === "right" ? "↓" : "→"}</button>
        <button
          className="term-sidebar-tab"
          data-active={source === "files"}
          onClick={() => onPatch({ source: "files" })}
        >
          Files
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
              cass?.available === false ? (
                <div className="term-sidebar-cass-install" data-testid="cass-install">
                  <strong>CASS is not installed</strong>
                  <span>Install it to browse cross-harness session turns.</span>
                  <code>brew install dicklesworthstone/tap/cass</code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText("brew install dicklesworthstone/tap/cass").then(() => setCassCopied(true)).catch(() => {});
                    }}
                  >
                    {cassCopied ? "copied" : "copy install command"}
                  </button>
                </div>
              ) : turnData.length ? (
                <TreeTable<TurnNode>
                  key="turns"
                  columns={turnColumns}
                  data={turnData}
                  virtual
                  expanded={turnExpanded}
                  onExpandedChange={setTurnExpanded}
                  sorting={views?.turns?.sorting}
                  onSortingChange={(sorting) => patchView("turns", { sorting })}
                  columnSizing={views?.turns?.columnSizing}
                  onColumnSizingChange={(columnSizing) => patchView("turns", { columnSizing })}
                  query={views?.turns?.query}
                  onQueryChange={(query) => patchView("turns", { query })}
                  onResetView={() => resetView("turns")}
                  getRowId={(n) => n.path}
                  getSubRows={(n) => {
                    if (n.kind === "session") {
                      if (!isTurnExpanded(n.path)) return [];
                      return visibleTurnWindows(n.turns).map(({ turn, tools }) => ({
                        kind: "turn" as const,
                        path: `turn:${turn.editor}:${turn.session_id}:${turn.id}`,
                        turn,
                        files: windowFileChildren(turn, tools),
                        tools,
                        compactionStart: compactionStart(n.turns, turn),
                      }));
                    }
                    if (n.kind === "turn") {
                      if (!isTurnExpanded(n.path)) return [];
                      return [
                        ...(n.files.length ? [{ kind: "files" as const, path: `files:${n.path}`, entries: n.files }] : []),
                        ...(n.tools.length ? [{ kind: "tools" as const, path: `tools:${n.path}`, tools: n.tools }] : []),
                      ];
                    }
                    if (n.kind === "files") {
                      return isTurnExpanded(n.path) ? n.entries.map((entry, i) => ({
                        kind: "file" as const,
                        path: `file:${n.path}:${i}:${entry.path}`,
                        entry,
                      })) : [];
                    }
                    if (n.kind === "tools") {
                      return isTurnExpanded(n.path) ? n.tools.map((turn) => ({
                        kind: "tool" as const,
                        path: `tool:${n.path}:${turn.id}`,
                        turn,
                        files: turnFileChildren(turn),
                      })) : [];
                    }
                    if (n.kind === "tool") return isTurnExpanded(n.path) ? n.files.map((f, i) => ({
                        kind: "file" as const,
                        path: `file:${n.path}:${i}:${f.path}`,
                        entry: f,
                      })) : [];
                    if (n.kind === "file") return isTurnExpanded(n.path) ? flatHeadings(headings[n.entry.path] ?? []).map((heading) => ({ kind: "heading" as const, path: `${n.path}:heading:${heading.id}`, entry: n.entry, heading })) : [];
                    return undefined;
                  }}
                  getRowCanExpand={(n) =>
                    n.kind === "session" ? true : n.kind === "turn" ? n.tools.length > 0 || n.files.length > 0 : n.kind === "files" ? n.entries.length > 0 : n.kind === "tools" ? n.tools.length > 0 : n.kind === "tool" ? n.files.length > 0 : n.kind === "file" ? isMarkdown(n.entry) : false
                  }
                  onToggleExpand={(n, willExpand) => { if (willExpand && n.kind === "file") loadHeadings(n.entry); }}
                  toggleOnDoubleClick={(n) => n.kind === "session" || n.kind === "turn" || n.kind === "tool"}
                  onRowDoubleClick={(n) => {
                    if (n.kind === "file") openPreviewPanel(n.entry.path);
                    else if (n.kind === "heading") openMarkdownPanel(n.entry.path, n.heading.id);
                  }}
                  controls
                  filter={(n, q) => {
                    if (n.kind === "turn" || n.kind === "tool") {
                      if (turnFilter === "visible" && n.kind === "tool") return true;
                      if (turnFilter === "user" && n.turn.role !== "user") return false;
                      if (turnFilter === "tools" && n.kind !== "tool") return false;
                    }
                    const hay =
                      n.kind === "turn" || n.kind === "tool"
                        ? `${n.turn.role} ${n.turn.preview}`
                        : n.kind === "files"
                          ? "files"
                          : n.kind === "tools"
                            ? "tools"
                            : n.kind === "file"
                          ? n.entry.name
                          : n.kind === "heading"
                            ? n.heading.title
                            : n.label;
                    return hay.toLowerCase().includes(q.toLowerCase());
                  }}
                  rowClass={(n) => n.kind === "turn" && n.turn.id === activeTurn?.id ? "turn-live" : undefined}
                  toolbar={<label className="tt-turn-filter">show <select aria-label="turn content filter" value={turnFilter} onChange={(event) => setTurnFilter(event.target.value as typeof turnFilter)}><option value="all">all</option><option value="visible">visible text</option><option value="user">user</option><option value="tools">tool-only</option></select></label>}
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
                sorting={views?.files?.sorting}
                onSortingChange={(sorting) => patchView("files", { sorting })}
                columnSizing={views?.files?.columnSizing}
                onColumnSizingChange={(columnSizing) => patchView("files", { columnSizing })}
                query={views?.files?.query}
                onQueryChange={(query) => patchView("files", { query })}
                onResetView={() => resetView("files")}
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
            {touchedData.length ? (
              <TreeTable<TouchedNode>
                columns={TOUCHED_COLS}
                data={touchedData}
                sorting={views?.touched?.sorting}
                onSortingChange={(sorting) => patchView("touched", { sorting })}
                columnSizing={views?.touched?.columnSizing}
                onColumnSizingChange={(columnSizing) => patchView("touched", { columnSizing })}
                query={views?.touched?.query}
                onQueryChange={(query) => patchView("touched", { query })}
                onResetView={() => resetView("touched")}
                getRowId={(n) => n.path}
                getSubRows={(n) => n.kind === "file"
                  ? [
                      ...flatHeadings(n.headings).map((heading) => ({ kind: "heading" as const, path: `${n.path}:heading:${heading.id}`, file: n.file, heading })),
                      ...n.file.references.slice().sort((a, b) => b.turn.seq - a.turn.seq).map((reference) => ({ kind: "turn" as const, path: `${n.path}:turn:${reference.turn.id}`, reference })),
                    ]
                  : undefined}
                getRowCanExpand={(n) => n.kind === "file" && (n.file.references.length > 0 || isMarkdown(n.file.entry))}
                onToggleExpand={(n, willExpand) => { if (willExpand && n.kind === "file") loadHeadings(n.file.entry); }}
                onRowDoubleClick={(n) => {
                  if (n.kind === "file") openPreviewPanel(n.file.entry.path);
                  else if (n.kind === "heading") openMarkdownPanel(n.file.entry.path, n.heading.id);
                  else openTurn(n.reference.turn);
                }}
                controls
                defaultSorting={[{ id: "last", desc: true }]}
                filter={(n, query) => {
                  const hay = n.kind === "file" ? `${n.file.entry.name} ${n.file.entry.path}` : n.kind === "heading" ? n.heading.title : n.reference.turn.preview;
                  return hay.toLowerCase().includes(query.toLowerCase());
                }}
                searchPlaceholder="filter touched…"
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
    {turnPreview ? createPortal(<div className="turn-preview-popover" data-testid="turn-preview-popover" style={previewStyle}>{turnPreview.text}</div>, document.body) : null}
  </>);
}
