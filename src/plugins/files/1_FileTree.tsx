// Lazy filesystem tree backed by @hafley66/grid. The grid owns row expansion;
// this module owns the native child caches and markdown heading materialization.
import { useEffect } from "react";
import { Signal } from "@hafley66/signals";
import { SignalReact, useSignal } from "@hafley66/signals/react";
import { createGrid, type Grid } from "@hafley66/grid";
import { GridTree } from "@hafley66/grid/react";
import { z } from "zod";
import { invoke, type CommandName } from "../../generated/native";
import type { FsEntry } from "../../state";
import { isMarkdownPath, markdownHeadingRows, type MarkdownHeadingRow } from "../../0_markdownTree";
import { openMarkdownPanel } from "../../mdview/open";
import "./1_FileTree.css";
import { buildFileRows, type FileTreeModelRow } from "./0_FileTreeModel";

export type FileTreeRow = FileTreeModelRow;

type GridRow = (FileTreeRow | MarkdownHeadingRow) & { name: string; kind: string };

const gridRowSchema = z.object({
  id: z.string(), kind: z.string(), label: z.string(), name: z.string(), path: z.string(), ext: z.string(),
});

export { buildFileRows } from "./0_FileTreeModel";

type FileTreeModel = { roots: any; children: any; markdown: any; expanded: any; rows: any };
const grids = new Map<string, Grid<GridRow>>();
const models = new Map<string, FileTreeModel>();

function modelFor(rootPath: string, rootEntries: FsEntry[]) {
  let model = models.get(rootPath);
  if (!model) {
    const roots = Signal(rootEntries);
    const children = Signal<Record<string, FsEntry[]>>({});
    const markdown = Signal<Record<string, MarkdownHeadingRow[]>>({});
    const expanded = Signal<Record<string, boolean>>({});
    const rows = Signal<GridRow[]>(() => buildFileRows(roots.$(), expanded.$(), children.$()).map((row) => row as GridRow));
    model = { roots, children, markdown, expanded, rows };
    models.set(rootPath, model);
  }
  const current = model;
  current.roots.$(rootEntries);
  const grid = grids.get(rootPath) ?? createGrid<GridRow>({
    schema: gridRowSchema as z.ZodType<GridRow>,
    rows: current.rows,
    mode: "client",
    getRowId: (row) => row.id,
    getSubRows: (row) => "children" in row ? row.children : undefined,
  });
  grids.set(rootPath, grid);
  return { ...current, grid };
}

export interface FileTreeProps {
  rootPath: string;
  rootEntries: FsEntry[];
  activePath?: string;
  filterExts?: ReadonlySet<string>;
  listCommand: CommandName;
  onSelect: (path: string) => void;
  glyphFor?: (row: FileTreeRow) => string;
  searchPlaceholder?: string;
}

function FileTreeView({ rootPath, rootEntries, activePath, filterExts, listCommand, onSelect }: FileTreeProps) {
  const model = modelFor(rootPath, rootEntries);
  const event = useSignal(model.grid.events.$);
  const rows = useSignal<GridRow[]>(model.rows.$) ?? [];

  useEffect(() => {
    const expansion = event?.type === "expanded" ? event.expanded : undefined;
    if (!expansion || typeof expansion !== "object") return;
    model.expanded.$(expansion as Record<string, boolean>);
    for (const [path, open] of Object.entries(expansion)) {
      if (!open) continue;
      const row = rows.find((candidate) => candidate.id === path);
      if (row?.kind === "dir" && !model.children.$()[path]) {
        void invoke<{ entries: FsEntry[] }>(listCommand, { path }).then((listing) => {
          const filtered = listing.entries.filter((entry) => entry.is_dir || !filterExts || filterExts.has(entry.ext.toLowerCase()));
          model.children.$({ ...model.children.$(), [path]: filtered });
        }).catch(() => undefined);
      }
      if (row?.kind === "file" && isMarkdownPath(row.path) && !model.markdown.$()[row.path]) {
        void invoke<string>("read_text", { path: row.path }).then((text) => model.markdown.$({ ...model.markdown.$(), [row.path]: markdownHeadingRows(row.path, text) })).catch(() => undefined);
      }
    }
  }, [event, filterExts, listCommand, model, rows]);

  return <div className="file-tree-grid" data-active-path={activePath ?? ""} onClick={(event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-testid^='toggle-']");
    if (row) return;
    const label = target.textContent?.replace(/\/$/, "");
    const match = rows.find((candidate) => candidate.name === label || candidate.label === label);
    if (!match) return;
    if (match.kind === "heading") openMarkdownPanel(match.path, match.headingId);
    else onSelect(match.path);
  }}><GridTree grid={model.grid} width="100%" label="files" /></div>;
}

export const FileTree = SignalReact(FileTreeView);
