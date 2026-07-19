// Generic lazy filesystem tree on the canonical TreeTable (AGENTS: no bespoke
// tree UIs). Extracted from memeTree.tsx so panels (meme thumbs, mdview
// explorer) share one implementation. Dirs lazy-load on first expand via the
// given native list command; double-click toggles a dir, file-explorer style.
import { useEffect, useMemo, useState } from "react";
import { invoke, type CommandName } from "./generated/native";
import { type ExpandedState } from "@tanstack/react-table";
import { TreeTable, type TreeColumn } from "./treetable";
import type { FsEntry } from "./state";
import "./fileTree.css";

export interface FileTreeRow {
  id: string;
  kind: "dir" | "file";
  label: string;
  path: string;
  ext: string;
  children?: FileTreeRow[];
}

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
  filterExts: Set<string>;
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
        (e) => e.is_dir || filterExts.has(e.ext.toLowerCase()),
      );
      setFsChildren((prev) => ({ ...prev, [path]: filtered }));
    } catch {
      // ignore permission / missing folder errors
    }
  }

  const columns: TreeColumn<FileTreeRow>[] = [
    {
      id: "name",
      header: "name",
      tree: true,
      cell: (r) => (
        <span className="file-tree-cell">
          <span className="file-tree-glyph">{glyphFor(r)}</span>
          {r.label}
        </span>
      ),
      sortValue: (r) => r.label,
    },
  ];

  return (
    <TreeTable<FileTreeRow>
      columns={columns}
      data={rows}
      getRowId={(r) => r.path}
      getSubRows={(r) => r.children}
      getRowCanExpand={(r) => r.kind === "dir"}
      onToggleExpand={(r, willExpand) => {
        if (willExpand && r.kind === "dir") loadChildren(r.path);
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
        if (r.kind === "file") onSelect(r.path);
      }}
      toggleOnDoubleClick={(r) => r.kind === "dir"}
      rowTitle={(r) => r.path}
      rowClass={(r) => (r.path === activePath ? "file-tree-active" : undefined)}
    />
  );
}
