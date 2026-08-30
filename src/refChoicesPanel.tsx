// The picker a ⌘-click opens when a token names more than one file: candidates
// group under their directory, which also carries the rest of its listing.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "./generated/native";
import type { DirListing, FsEntry } from "./state";
import { tildify } from "./core";
import { TreeTable, type TreeColumn } from "./treetable";

export interface ChoiceRow {
  id: string;
  kind: "dir" | "file";
  path: string;
  label: string;
  // 1-based position in the resolver's ranking; absent on browsed rows.
  rank?: number;
  size?: number;
  children?: ChoiceRow[];
}

const dirPart = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";
const namePart = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

// The deepest directory every candidate sits under. Candidate rows label
// themselves relative to it, which keeps the tree two rungs deep.
export function commonDir(paths: string[]): string {
  if (paths.length === 0) return "";
  const parts = paths.map((p) => dirPart(p).split("/"));
  const first = parts[0];
  let n = 0;
  while (n < first.length && parts.every((p) => p[n] === first[n])) n += 1;
  return first.slice(0, n).join("/");
}

// A single-child chain (`a/b/c` holding one hit) reads as one row, the way a
// file explorer folds an empty passage.
function dirLabel(dir: string, root: string): string {
  if (root && dir.startsWith(`${root}/`)) return dir.slice(root.length + 1);
  return namePart(dir) || dir;
}

export function buildChoiceRows(paths: string[]): { root: string; rows: ChoiceRow[] } {
  const root = commonDir(paths);
  const byDir = new Map<string, ChoiceRow>();
  paths.forEach((path, index) => {
    const dir = dirPart(path);
    let group = byDir.get(dir);
    if (!group) {
      group = { id: `dir:${dir}`, kind: "dir", path: dir, label: dirLabel(dir, root), children: [] };
      byDir.set(dir, group);
    }
    group.children!.push({
      id: `file:${path}`,
      kind: "file",
      path,
      label: namePart(path),
      rank: index + 1,
    });
  });
  return { root, rows: [...byDir.values()] };
}

const entryRow = (entry: FsEntry): ChoiceRow =>
  entry.is_dir
    ? { id: `dir:${entry.path}`, kind: "dir", path: entry.path, label: entry.name, children: [] }
    : { id: `file:${entry.path}`, kind: "file", path: entry.path, label: entry.name, size: entry.size };

const UNITS = ["b", "k", "m", "g"];
function fmtSize(bytes: number): string {
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n < 10 && unit > 0 ? n.toFixed(1) : Math.round(n)}${UNITS[unit]}`;
}

// The hits a directory holds, then the rest of its listing. `seen` stops a
// symlink loop from recursing forever.
function dirChildren(
  row: ChoiceRow,
  listings: Record<string, FsEntry[]>,
  seen: Set<string>,
): ChoiceRow[] | undefined {
  if (row.kind !== "dir" || seen.has(row.path)) return row.children;
  const candidates = row.children ?? [];
  const listed = listings[row.path];
  if (!listed?.length) return candidates.length ? candidates : undefined;
  const sizeByPath = new Map(listed.map((e) => [e.path, e.size]));
  const claimed = new Set(candidates.map((c) => c.path));
  seen.add(row.path);
  const merged = [
    ...candidates.map((c) => ({ ...c, size: sizeByPath.get(c.path) ?? c.size })),
    ...listed.filter((e) => !claimed.has(e.path)).map(entryRow),
  ].map((c) => (c.kind === "dir" ? { ...c, children: dirChildren(c, listings, seen) } : c));
  seen.delete(row.path);
  return merged;
}

export interface RefChoicesPanelProps {
  token: string;
  paths: string[];
  line?: number;
  via: "exact" | "fuzzy";
  onOpen: (path: string, line?: number) => void;
  onGrep: () => void;
  onConfig: () => void;
}

export function RefChoicesPanel(props: RefChoicesPanelProps) {
  const { token, paths, via } = props;
  const { root, rows } = useMemo(() => buildChoiceRows(paths), [paths]);
  const [listings, setListings] = useState<Record<string, FsEntry[]>>({});

  const loadDir = (path: string) => {
    setListings((prev) => (path in prev ? prev : { ...prev, [path]: [] }));
    void invoke<DirListing>("list_dir", { path })
      .then((listing) => setListings((prev) => ({ ...prev, [path]: listing.entries })))
      .catch(() => {});
  };

  // Candidate directories list themselves up front: their rows open expanded, so
  // the siblings of a hit are one glance away rather than one click away.
  useEffect(() => {
    for (const row of rows) if (!(row.path in listings)) loadDir(row.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // A fresh `data` array per listing: react-table memoizes its row model on data
  // identity, so a stale identity would hold the tree at the candidates.
  const data = useMemo(
    () => rows.map((row) => ({ ...row, children: dirChildren(row, listings, new Set()) })),
    [rows, listings],
  );

  const columns: TreeColumn<ChoiceRow>[] = [
    {
      id: "name",
      header: "candidate",
      tree: true,
      toggleExpand: true,
      cell: (r) => <span className={`rc-${r.kind}`}>{r.label}</span>,
      sortValue: (r) => r.label,
    },
    {
      id: "rank",
      header: "rank",
      cell: (r) => (r.rank ? <span className="rc-rank">#{r.rank}</span> : null),
      sortValue: (r) => r.rank,
      size: 56,
    },
    {
      id: "size",
      header: "size",
      cell: (r) => (r.kind === "file" && r.size !== undefined ? fmtSize(r.size) : null),
      sortValue: (r) => r.size,
      size: 64,
    },
  ];

  const count = `${paths.length} candidate${paths.length === 1 ? "" : "s"}`;
  const command = `${via === "fuzzy" ? "fzf" : "resolve"} ${token} (${count})`;
  return (
    <>
      <div className="rg-head">
        {token} <span className="rg-count">{count} in {tildify(root)}</span>
      </div>
      <div className="rg-sub">
        ran <code>{command}</code> ·{" "}
        <a
          className="rg-grep"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            props.onGrep();
          }}
        >
          grep it
        </a>{" "}
        ·{" "}
        <a
          className="rg-cfg"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            props.onConfig();
          }}
        >
          config
        </a>
      </div>
      <div className="rg-body">
        <TreeTable<ChoiceRow>
          columns={columns}
          data={data}
          getRowId={(r) => r.id}
          getSubRows={(r) => r.children}
          getRowCanExpand={(r) => r.kind === "dir"}
          onToggleExpand={(r, willExpand) => {
            if (willExpand && r.kind === "dir" && !(r.path in listings)) loadDir(r.path);
          }}
          defaultExpanded={Object.fromEntries(rows.map((r) => [r.id, true]))}
          defaultSorting={[{ id: "rank", desc: false }]}
          controls
          filter={(r, q) => r.path.toLowerCase().includes(q.toLowerCase())}
          searchPlaceholder="filter candidates…"
          rowClass={(r) => (r.rank ? "rc-hit" : undefined)}
          rowTitle={(r) => r.path}
          rowEntity={(r) => (r.kind === "file" ? { kind: "file", value: r.path } : undefined)}
          onRowClick={(r) => {
            if (r.kind === "file") props.onOpen(r.path, r.rank ? props.line : undefined);
          }}
        />
      </div>
    </>
  );
}
