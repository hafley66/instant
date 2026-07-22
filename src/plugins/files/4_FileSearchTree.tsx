import { useEffect, useMemo, useState } from "react";
import { invoke } from "../../generated/native";
import { fuzzyFilter } from "../../fuzzy";
import type { FsEntry } from "../../state";
import { TreeTable, type TreeColumn } from "../../treetable";
import { FileTree } from "./1_FileTree";

export interface FileSearchSource {
  id: string;
  label: string;
  search: (root: string) => Promise<FsEntry[]>;
}

export const filesystemSearchSource: FileSearchSource = {
  id: "filesystem",
  label: "files",
  search: (root) => invoke<FsEntry[]>("search_files", { path: root }),
};
const DEFAULT_SOURCES = [filesystemSearchSource];

export interface FileSearchTreeProps {
  root: string;
  onSelect: (path: string) => void;
  sources?: FileSearchSource[];
}

// Filesystem-first source composition. With an empty query it is the lazy,
// expandable FileTree; typing switches to ranked candidates from each source.
export function FileSearchTree({
  root,
  onSelect,
  sources = DEFAULT_SOURCES,
}: FileSearchTreeProps) {
  const [rootEntries, setRootEntries] = useState<FsEntry[]>([]);
  const [candidates, setCandidates] = useState<Record<string, FsEntry[]>>({});
  const [query, setQuery] = useState("");

  useEffect(() => {
    let dead = false;
    void invoke<{ entries: FsEntry[] }>("list_dir", { path: root })
      .then((listing) => { if (!dead) setRootEntries(listing.entries); })
      .catch(() => { if (!dead) setRootEntries([]); });
    void Promise.all(sources.map(async (source) => [source.id, await source.search(root)] as const))
      .then((loaded) => { if (!dead) setCandidates(Object.fromEntries(loaded)); })
      .catch(() => { if (!dead) setCandidates({}); });
    return () => { dead = true; };
  }, [root, sources]);

  const results = useMemo(() => sources.flatMap((source) =>
    fuzzyFilter(query, candidates[source.id] ?? [], (entry) => `${entry.name} ${entry.path}`),
  ), [candidates, query, sources]);
  const columns: TreeColumn<FsEntry>[] = [
    { id: "name", header: "file", cell: (entry) => entry.name, sortValue: (entry) => entry.name },
    { id: "path", header: "path", cell: (entry) => entry.path, sortValue: (entry) => entry.path },
  ];
  const searching = query.trim().length > 0;
  return <div className="file-search-tree">
    <input value={query} placeholder="fzf files…" onChange={(event) => setQuery(event.currentTarget.value)} />
    {searching ? <TreeTable columns={columns} data={results} getRowId={(entry) => entry.path} onRowClick={(entry) => onSelect(entry.path)} virtual /> : <FileTree rootPath={root} rootEntries={rootEntries} listCommand="list_dir" onSelect={onSelect} />}
  </div>;
}
