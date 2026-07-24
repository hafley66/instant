// Generic lazy filesystem tree on the canonical TreeTable (AGENTS: no bespoke
// tree UIs). Extracted from memeTree.tsx so panels (meme thumbs, mdview
// explorer) share one implementation. Dirs lazy-load on first expand via the
// given native list command. Markdown files expand idempotently so repeated
// activation retains their already-materialized heading children.
import { useEffect, useMemo, useState } from "react";
import { invoke, type CommandName } from "../../generated/native";
import { type ExpandedState } from "@tanstack/react-table";
import { TreeTable, type TreeColumn } from "../../treetable";
import type { FsEntry } from "../../state";
import { isMarkdownPath, markdownHeadingRows, type MarkdownHeadingRow } from "../../0_markdownTree";
import { openMarkdownPanel } from "../../mdview/open";
import "./1_FileTree.css";

export interface FileTreeRow {
  id: string;
  kind: "dir" | "file";
  label: string;
  path: string;
  ext: string;
  children?: FileTreeRow[];
}

type TreeRow = FileTreeRow | MarkdownHeadingRow;

function isExpanded(expanded: ExpandedState, path: string): boolean {
  return typeof expanded === "object" && Boolean((expanded as Record<string, boolean>)[path]);
}

function entryToRow(e: FsEntry): FileTreeRow {
  return {
    id: e.path,
    kind: e.is_dir ? "dir" : "file",
    label: e.name,
    path: e.path,
    ext: e.ext,
    children: e.is_dir ? [] : undefined,
  };
}

// Children materialize only for expanded dirs (lazy); a collapsed dir keeps
// `children: undefined` so the twisty shows via getRowCanExpand.
export function buildFileRows(
  entries: FsEntry[],
  expanded: ExpandedState,
  fsChildren: Record<string, FsEntry[]>,
): FileTreeRow[] {
  return entries.map((e) => {
    const children =
      e.is_dir && isExpanded(expanded, e.path)
        ? buildFileRows(fsChildren[e.path] ?? [], expanded, fsChildren)
        : undefined;
    return { ...entryToRow(e), children };
  });
}

const defaultGlyph = (r: FileTreeRow): string => (r.kind === "dir" ? "📁" : "📄");

export interface FileTreeProps {
  rootPath: string;
  rootEntries: FsEntry[];
  activePath?: string;
  // Files with these extensions (lowercase, no dot) are shown; dirs always are.
  filterExts?: ReadonlySet<string>;
  listCommand: CommandName; // native listing command ("list_dir" | "list_dir_meme")
  onSelect: (path: string) => void;
  glyphFor?: (row: FileTreeRow) => string;
  searchPlaceholder?: string;
}

export function FileTree({
  rootPath,
  rootEntries,
  activePath,
  filterExts,
  listCommand,
  onSelect,
  glyphFor = defaultGlyph,
  searchPlaceholder = "filter files…",
}: FileTreeProps) {
  const [fsChildren, setFsChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [markdownChildren, setMarkdownChildren] = useState<Record<string, MarkdownHeadingRow[]>>({});

  // Reset loaded children/expansion when the root folder changes.
  useEffect(() => {
    setFsChildren({});
    setExpanded({});
  }, [rootPath]);

  const rows = useMemo(
    () => buildFileRows(rootEntries, expanded, fsChildren),
    [rootEntries, expanded, fsChildren],
  );

  async function loadChildren(path: string) {
    if (fsChildren[path]) return;
    try {
      const listing = await invoke<{ entries: FsEntry[] }>(listCommand, { path });
      const filtered = listing.entries.filter(
        (e) => e.is_dir || !filterExts || filterExts.has(e.ext.toLowerCase()),
      );
      setFsChildren((prev) => ({ ...prev, [path]: filtered }));
    } catch {
      // ignore permission / missing folder errors
    }
  }

  async function loadMarkdown(path: string) {
    if (markdownChildren[path]) return;
    try {
      const text = await invoke<string>("read_text", { path });
      setMarkdownChildren((prev) => ({ ...prev, [path]: markdownHeadingRows(path, text) }));
    } catch { setMarkdownChildren((prev) => ({ ...prev, [path]: [] })); }
  }

  const columns: TreeColumn<TreeRow>[] = [
    {
      id: "name",
      header: "name",
      tree: true,
      cell: (r) => r.kind === "heading" ? <span className="sidebar-heading"># {r.label}</span> : (
        <span className="file-tree-cell">
          <span className="file-tree-glyph">{glyphFor(r)}</span>
          {r.label}
        </span>
      ),
      sortValue: (r) => r.label,
    },
  ];

  return (
    <TreeTable<TreeRow>
      columns={columns}
      data={rows}
      getRowId={(r) => r.kind === "heading" ? r.id : r.path}
      getSubRows={(r) => r.kind === "file" && isMarkdownPath(r.path) ? markdownChildren[r.path] : r.kind === "dir" ? r.children : undefined}
      getRowCanExpand={(r) => r.kind === "dir" || (r.kind === "file" && isMarkdownPath(r.path))}
      onToggleExpand={(r, willExpand) => {
        if (willExpand && r.kind === "dir") loadChildren(r.path);
        if (willExpand && r.kind === "file" && isMarkdownPath(r.path)) void loadMarkdown(r.path);
      }}
      expanded={expanded}
      onExpandedChange={setExpanded}
      // controls wraps the table in .tt-host > .tt-wrap, whose base CSS
      // (flex:1; min-height:0; overflow:auto) is the scroll pattern the other
      // panels use. (No `virtual`: it threw a ResizeObserver loop while the
      // chain was unbounded.)
      controls
      filter={(r, q) => {
        const s = q.toLowerCase();
        return r.label.toLowerCase().includes(s) || r.path.toLowerCase().includes(s);
      }}
      searchPlaceholder={searchPlaceholder}
      onRowClick={(r) => {
        if (r.kind === "heading") openMarkdownPanel(r.path, r.headingId);
        else if (r.kind === "file") onSelect(r.path);
      }}
      toggleOnDoubleClick={(r) => r.kind === "dir"}
      ensureExpanded={(r) => r.kind === "file" && isMarkdownPath(r.path)}
      rowTitle={(r) => r.path}
      rowClass={(r) => (r.path === activePath ? "file-tree-active" : undefined)}
    />
  );
}
