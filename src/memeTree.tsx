import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type ExpandedState } from "@tanstack/react-table";
import { TreeTable, type TreeColumn } from "./treetable";
import type { FsEntry } from "./state";

interface MemeTreeRow {
  id: string;
  kind: "dir" | "file";
  label: string;
  path: string;
  ext: string;
  children?: MemeTreeRow[];
}

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
]);

function fileGlyph(r: MemeTreeRow): string {
  if (r.kind === "dir") return "📁";
  switch (r.ext.toLowerCase()) {
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "avif":
      return "🖼";
    case "gif":
      return "🎞";
    case "svg":
      return "🎨";
    default:
      return "📄";
  }
}

function fsEntryToRow(e: FsEntry): MemeTreeRow {
  return {
    id: e.path,
    kind: e.is_dir ? "dir" : "file",
    label: e.name,
    path: e.path,
    ext: e.ext,
    children: e.is_dir ? [] : undefined,
  };
}

function isExpanded(expanded: ExpandedState, path: string): boolean {
  return typeof expanded === "object" && Boolean((expanded as Record<string, boolean>)[path]);
}

function buildRows(
  entries: FsEntry[],
  expanded: ExpandedState,
  fsChildren: Record<string, FsEntry[]>,
): MemeTreeRow[] {
  return entries.map((e) => {
    const children =
      e.is_dir && isExpanded(expanded, e.path)
        ? buildRows(fsChildren[e.path] ?? [], expanded, fsChildren)
        : undefined;
    return { ...fsEntryToRow(e), children };
  });
}

export function MemeTree({
  rootPath,
  rootEntries,
  activePath,
  onSelect,
}: {
  rootPath: string;
  rootEntries: FsEntry[];
  activePath?: string;
  onSelect: (path: string) => void;
}) {
  const [fsChildren, setFsChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<ExpandedState>({});

  // Reset loaded children/expansion when the root folder changes.
  useEffect(() => {
    setFsChildren({});
    setExpanded({});
  }, [rootPath]);

  const rows = useMemo(
    () => buildRows(rootEntries, expanded, fsChildren),
    [rootEntries, expanded, fsChildren],
  );

  async function loadChildren(path: string) {
    if (fsChildren[path]) return;
    try {
      const listing = await invoke<{ entries: FsEntry[] }>("list_dir_meme", { path });
      const filtered = listing.entries.filter(
        (e) => e.is_dir || IMAGE_EXTS.has(e.ext.toLowerCase()),
      );
      setFsChildren((prev) => ({ ...prev, [path]: filtered }));
    } catch {
      // ignore permission / missing folder errors
    }
  }

  const columns: TreeColumn<MemeTreeRow>[] = [
    {
      id: "name",
      header: "name",
      tree: true,
      cell: (r) => (
        <span className="meme-tree-cell">
          <span className="meme-tree-glyph">{fileGlyph(r)}</span>
          {r.label}
        </span>
      ),
      sortValue: (r) => r.label,
    },
  ];

  return (
    <TreeTable<MemeTreeRow>
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
      // (flex:1; min-height:0; overflow:auto) is the same scroll pattern the
      // worktrees/activity panels use. With .meme-panel now height:100% the
      // percentage chain is definite, so the column scrolls. (No `virtual`:
      // it threw a ResizeObserver loop while the chain was unbounded.)
      controls
      filter={(r, q) => {
        const s = q.toLowerCase();
        return r.label.toLowerCase().includes(s) || r.path.toLowerCase().includes(s);
      }}
      searchPlaceholder="filter files…"
      onRowClick={(r) => {
        if (r.kind === "file") onSelect(r.path);
      }}
      toggleOnDoubleClick={(r) => r.kind === "dir"}
      rowTitle={(r) => r.path}
      rowClass={(r) => (r.path === activePath ? "meme-tree-active" : undefined)}
    />
  );
}
