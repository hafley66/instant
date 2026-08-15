import { useEffect } from "react";
import { Signal, type Signal as SignalValue } from "@hafley66/signals";
import { createGrid, type Grid } from "@hafley66/grid";
import { GridTree } from "@hafley66/grid/react";
import { z } from "zod";
import { invoke, type CommandName } from "../../generated/native";
import type { FsEntry } from "../../state";
import { isMarkdownPath, markdownHeadingRows, type MarkdownHeadingRow } from "../../0_markdownTree";
import { openMarkdownPanel } from "@hafley66/md";
import { buildFileRows, type FileTreeModelRow } from "./0_FileTreeModel";
import "./1_FileTree.css";

export type FileTreeRow = FileTreeModelRow;

type GridHeadingRow = MarkdownHeadingRow & { name: string; ext: ""; children?: GridRow[] };
type GridFileRow = Omit<FileTreeRow, "children"> & { children?: GridRow[] };
type GridRow = GridFileRow | GridHeadingRow;

const gridRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  name: z.string(),
  path: z.string(),
  ext: z.string(),
});

export { buildFileRows } from "./0_FileTreeModel";

type FileTreeModel = {
  roots: SignalValue<FsEntry[]>;
  children: SignalValue<Record<string, FsEntry[]>>;
  markdown: SignalValue<Record<string, MarkdownHeadingRow[]>>;
  expanded: SignalValue<Record<string, boolean>>;
  rows: SignalValue<GridRow[]>;
  grid: Grid<GridRow>;
};

const models = new Map<string, FileTreeModel>();

function projectRows(
  entries: FsEntry[],
  expanded: Record<string, boolean>,
  children: Record<string, FsEntry[]>,
  markdown: Record<string, MarkdownHeadingRow[]>,
): GridRow[] {
  const addMarkdown = (rows: FileTreeRow[]): GridRow[] => rows.map((row) => ({
    ...row,
    children: row.kind === "dir"
      ? addMarkdown(row.children ?? [])
      : markdown[row.path]?.map((heading) => ({ ...heading, name: heading.label, ext: "" as const })),
  }));
  return addMarkdown(buildFileRows(entries, expanded, children));
}

function modelFor(rootPath: string, rootEntries: FsEntry[]): FileTreeModel {
  const existing = models.get(rootPath);
  if (existing) return existing;

  const roots = Signal(rootEntries);
  const children = Signal<Record<string, FsEntry[]>>({});
  const markdown = Signal<Record<string, MarkdownHeadingRow[]>>({});
  const expanded = Signal<Record<string, boolean>>({});
  const rows = Signal<GridRow[]>(() => projectRows(roots.$(), expanded.$(), children.$(), markdown.$()));
  const grid = createGrid<GridRow>({
    schema: gridRowSchema as z.ZodType<GridRow>,
    rows,
    mode: "client",
    getRowId: (row) => row.id,
    getSubRows: (row) => row.children,
    getRowCanExpand: (row) => row.kind === "dir" || (row.kind === "file" && isMarkdownPath(row.path)),
  });
  const model = { roots, children, markdown, expanded, rows, grid };
  models.set(rootPath, model);
  return model;
}

const defaultGlyph = (row: FileTreeRow): string => row.kind === "dir" ? "📁" : "📄";

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

export function FileTree({
  rootPath,
  rootEntries,
  filterExts,
  listCommand,
  onSelect,
  glyphFor = defaultGlyph,
}: FileTreeProps) {
  const model = modelFor(rootPath, rootEntries);

  useEffect(() => {
    if (model.roots.$() !== rootEntries) model.roots.$(rootEntries);
  }, [model, rootEntries]);

  useEffect(() => {
    const subscription = model.grid.events.$.subscribe((event) => {
      const expansion = event?.type === "expanded" ? event.expanded : undefined;
      if (!expansion || typeof expansion !== "object") return;
      model.expanded.$(expansion as Record<string, boolean>);
      const rows = model.rows.$();
      for (const [path, open] of Object.entries(expansion)) {
        if (!open) continue;
        const row = rows.find((candidate) => candidate.id === path);
        if (row?.kind === "dir" && !model.children.$()[path]) {
          void invoke<{ entries: FsEntry[] }>(listCommand, { path }).then((listing) => {
            const filtered = listing.entries.filter(
              (entry) => entry.is_dir || !filterExts || filterExts.has(entry.ext.toLowerCase()),
            );
            model.children.$({ ...model.children.$(), [path]: filtered });
          }).catch(() => undefined);
        }
        if (row?.kind === "file" && isMarkdownPath(row.path) && !model.markdown.$()[row.path]) {
          void invoke<string>("read_text", { path: row.path }).then((text) => {
            model.markdown.$({ ...model.markdown.$(), [row.path]: markdownHeadingRows(row.path, text) });
          }).catch(() => undefined);
        }
      }
    });
    return () => subscription.unsubscribe();
  }, [filterExts, listCommand, model]);

  return (
    <div className="file-tree-grid">
      <GridTree
        grid={model.grid}
        width="100%"
        onRowClick={(row) => {
          if (row.kind === "heading") openMarkdownPanel(row.path, row.headingId);
          else if (row.kind === "file") onSelect(row.path);
        }}
        renderIcon={(row) => row.kind === "heading" ? "#" : glyphFor({
          id: row.id,
          kind: row.kind,
          label: row.label,
          name: row.name,
          path: row.path,
          ext: row.ext,
        })}
        renderLabel={(row) => row.label}
      />
    </div>
  );
}
