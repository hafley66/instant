import type { FsEntry } from "../../state";

export interface FileTreeModelRow {
  id: string;
  kind: "dir" | "file";
  label: string;
  name: string;
  path: string;
  ext: string;
  children?: FileTreeModelRow[];
}

export function buildFileRows(entries: FsEntry[], expanded: Record<string, boolean>, fsChildren: Record<string, FsEntry[]>): FileTreeModelRow[] {
  return entries.map((entry) => ({
    id: entry.path,
    kind: entry.is_dir ? "dir" : "file",
    label: entry.name,
    name: entry.name,
    path: entry.path,
    ext: entry.ext,
    children: entry.is_dir && expanded[entry.path]
      ? buildFileRows(fsChildren[entry.path] ?? [], expanded, fsChildren)
      : entry.is_dir ? undefined : undefined,
  }));
}
